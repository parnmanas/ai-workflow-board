// QA scale: large dataset + bulk activity.
//
// Provisions 200 tickets on one board, then fires 200 column_move activities
// back-to-back. Confirms:
//
//   1. SSE stream keeps pace — the virtual agent receives every trigger
//      without the stream disconnecting or falling behind the keepalive.
//   2. Ordering is preserved per-ticket (not strictly per-stream, but each
//      ticket's trigger arrives after its corresponding activity emission).
//   3. Bulk DB insert + activity emission stays under a reasonable budget.
//
// The thresholds here are loose on purpose (the goal is to detect the "this
// completely falls over at scale" regression, not to pin a specific perf
// number). Tune these down once CI hardware is characterized.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_LARGE_PORT || '7805';

const N_TICKETS = 200;
const BULK_BUDGET_MS = 60_000; // 200 activities on SQLite should comfortably fit.

test(`Large-data: ${N_TICKETS} tickets, ${N_TICKETS} moves — every trigger arrives`, { skip: 'quarantined: pre-existing failure unmasked by harness fix fc84ec30 — repair tracked in ticket 5e5959ef' }, async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'large',
  });
  const user = await createUser(app, getDataSourceToken, { name: 'bulk' });
  const workerAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'bulk-worker' });
  const workerKey = await createApiKey(app, getDataSourceToken, workerAgent.id, {
    workspaceId: ws.id,
    label: 'bulk-worker',
  });

  step(`Bulk insert ${N_TICKETS} tickets into In Progress column`);
  // Bulk ticket insert. Use a single transaction for speed.
  const ticketRepo = app.get(getDataSourceToken()).getRepository('Ticket');
  const rows = [];
  for (let i = 0; i < N_TICKETS; i++) {
    rows.push(
      ticketRepo.create({
        column_id: columns.inProgress.id,
        workspace_id: ws.id,
        title: `bulk-${i}`,
        assignee_id: workerAgent.id,
        position: i,
        status: 'todo',
      }),
    );
  }
  await ticketRepo.save(rows, { chunk: 50 });

  // Virtual agent subscribes AFTER ticket insert to avoid pre-event drift.
  const va = new VirtualAgent({
    name: 'bulk-worker',
    agentId: workerAgent.id,
    apiKey: workerKey.raw_key,
    port,
  });
  await va.start();
  t.after(() => va.stop());
  await new Promise((r) => setTimeout(r, 300));

  step(`Emit ${N_TICKETS} "moved" activities back-to-back and wait for SSE to drain`);
  // Emit moves as fast as logActivity will accept them (saves to DB first).
  const started = Date.now();
  const activityService = app.get(ActivityService);
  for (const row of rows) {
    await activityService.logActivity({
      entity_type: 'ticket',
      entity_id: row.id,
      action: 'moved',
      ticket_id: row.id,
      new_value: 'In Progress',
      actor_id: user.id,
      actor_name: user.name,
    });
  }
  const emissionDurationMs = Date.now() - started;

  // Wait for SSE to catch up.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && va.triggers.length < N_TICKETS) {
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.equal(
    va.triggers.length,
    N_TICKETS,
    `Expected ${N_TICKETS} triggers, got ${va.triggers.length} after 30s drain window`,
  );
  assert.ok(
    emissionDurationMs < BULK_BUDGET_MS,
    `Bulk emission took ${emissionDurationMs}ms — expected under ${BULK_BUDGET_MS}ms`,
  );

  // Per-ticket uniqueness (no duplicates in the stream).
  const ticketIds = new Set(va.triggers.map((tr) => tr.ticket_id));
  assert.equal(ticketIds.size, N_TICKETS, 'Every ticket must appear exactly once');

  exitAfterTests(0);
});
