// QA scale: large dataset + bulk activity under the per-agent capacity model.
//
// Provisions N `todo` tickets for ONE assignee, then fires N ticket activities
// back-to-back. Confirms the dispatch pipeline does not fall over at scale:
//
//   1. The SSE stream survives the burst — the agent stays connected and still
//      receives its trigger (the stream didn't disconnect / fall behind the
//      keepalive under load).
//   2. Capacity holds at scale: every activity re-pumps the workspace queue,
//      yet with `max_concurrent_tickets_per_agent` = 1 the N queued tickets
//      start exactly ONE (todo → in_progress) and deliver exactly ONE trigger,
//      NOT N. The started one is the queue head (priority → position →
//      created_at, docs/tickets.md); the rest stay queued in `todo`.
//   3. Bulk insert + N activity emissions stay under a reasonable time budget.
//
// Thresholds are loose on purpose — the goal is to catch a "completely falls
// over at scale" regression, not to pin a perf number.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { runtimeIdentityKey } from '../../dist/common/runtime-spec.js';
import {
  createAccount,
  createAgent,
  createUser,
  runtimeHostKeyForAgent,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_LARGE_PORT || '0';

const N_TICKETS = 200;
const BULK_BUDGET_MS = 60_000; // 200 activities on SQLite should comfortably fit.

test(`Large-data: ${N_TICKETS} queued tickets, ${N_TICKETS} activities — one start, stream survives`, async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  const ws = await createAccount(app, getDataSourceToken, 'large');
  const user = await createUser(app, getDataSourceToken, { name: 'bulk' });
  const workerAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'bulk-worker', runtime: true });
  const spec = workerAgent.runtime_spec;
  const assigneeKey = runtimeIdentityKey(spec);

  step(`Bulk insert ${N_TICKETS} todo tickets for one assignee`);
  const ds = app.get(getDataSourceToken());
  const ticketRepo = ds.getRepository('Ticket');
  const rows = [];
  for (let i = 0; i < N_TICKETS; i++) {
    rows.push(
      ticketRepo.create({
        account_id: ws.id,
        title: `bulk-${i}`,
        status: 'todo',
        tags: '[]',
        assignee: spec,
        assignee_key: assigneeKey,
        position: i,
      }),
    );
  }
  // A raw bulk insert writes no activity, so nothing is dispatched yet — the
  // assignee's host is not even connected at this point.
  await ticketRepo.save(rows, { chunk: 50 });

  // Virtual agent subscribes AFTER ticket insert to avoid pre-event drift.
  const va = new VirtualAgent({
    name: 'bulk-worker',
    agentId: workerAgent.id,
    apiKey: runtimeHostKeyForAgent(workerAgent.id),
    port,
  });
  await va.start();
  t.after(() => va.stop());
  await new Promise((r) => setTimeout(r, 300));

  step(`Emit ${N_TICKETS} ticket activities back-to-back and let the bus drain`);
  // Emit moves as fast as logActivity will accept them (saves to DB first).
  const started = Date.now();
  const activityService = app.get(ActivityService);
  for (const row of rows) {
    // Every ticket activity re-pumps the workspace queue (TicketDispatchService).
    await activityService.logActivity({
      entity_type: 'ticket',
      entity_id: row.id,
      action: 'updated',
      field_changed: 'priority',
      old_value: 'medium',
      new_value: 'medium',
      ticket_id: row.id,
      account_id: ws.id,
      actor_id: user.id,
      actor_name: user.name,
    });
  }
  const emissionDurationMs = Date.now() - started;

  // Wait for the trigger to land, then settle so any (buggy) extra trigger —
  // an over-capacity start — would also have arrived and be caught below.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && va.triggers.length < 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 500));

  // Capacity 1: exactly one trigger delivered despite N queue pumps.
  assert.equal(
    va.triggers.length,
    1,
    `Expected exactly 1 trigger with max_concurrent_tickets_per_agent=1, got ${va.triggers.length}`,
  );
  // The stream survived the burst and delivered a well-formed trigger for the
  // queue head (lowest position), addressed to the assignee identity.
  const tr = va.triggers[0];
  assert.equal(tr.ticket_id, rows[0].id, `the queue head (bulk-0) starts first, got ${tr.ticket_id}`);
  assert.equal(tr.agent_id, assigneeKey, 'trigger addressed to the assignee runtime identity');
  assert.equal(tr.role, 'assignee');
  assert.equal(tr.trigger_source, 'start');

  const counts = {};
  for (const row of await ticketRepo.find({ where: { account_id: ws.id }, select: ['id', 'status'] })) {
    counts[row.status] = (counts[row.status] || 0) + 1;
  }
  assert.deepEqual(counts, { in_progress: 1, todo: N_TICKETS - 1 }, 'one started, the rest stay queued');

  assert.ok(
    emissionDurationMs < BULK_BUDGET_MS,
    `Bulk emission took ${emissionDurationMs}ms — expected under ${BULK_BUDGET_MS}ms`,
  );

  exitAfterTests(0);
});
