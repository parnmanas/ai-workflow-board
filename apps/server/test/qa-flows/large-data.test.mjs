// QA scale: large dataset + bulk activity under the single-focus model.
//
// Provisions N tickets for ONE assignee on one board, then fires N column_move
// activities back-to-back. Confirms the dispatch pipeline does not fall over at
// scale:
//
//   1. The SSE stream survives the burst — the agent stays connected and still
//      receives its focus trigger (the stream didn't disconnect / fall behind
//      the keepalive under load).
//   2. SINGLE-FOCUS dispatch holds at scale: N parked tickets for one agent in
//      one column deliver exactly ONE trigger (the focus), NOT N. Non-focus
//      triggers are silently dropped (ticket 4a6cdfd7) so the agent isn't
//      thrashed. The earlier "every trigger arrives" (N) expectation predated
//      the focus model AND seeded no role-assignment rows, so it delivered 0
//      (quarantined → ticket 5e5959ef).
//   3. Bulk insert + N activity emissions stay under a reasonable time budget.
//
// Thresholds are loose on purpose — the goal is to catch a "completely falls
// over at scale" regression, not to pin a perf number.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createUser,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_LARGE_PORT || '7805';

const N_TICKETS = 200;
const BULK_BUDGET_MS = 60_000; // 200 activities on SQLite should comfortably fit.

test(`Large-data: ${N_TICKETS} tickets, ${N_TICKETS} moves — one focus trigger, stream survives`, async (t) => {
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
  const ds = app.get(getDataSourceToken());
  const ticketRepo = ds.getRepository('Ticket');
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

  // The dispatch path resolves a column's role holder from TicketRoleAssignment
  // rows, NOT the legacy assignee_id column — so a raw bulk insert fires zero
  // triggers without these rows (the createTicket fixture writes them per-ticket;
  // here we bulk-insert them to keep the scale character). Seed one assignee
  // assignment per ticket so In Progress (routes to assignee) is servable.
  const roleRepo = ds.getRepository('WorkspaceRole');
  const assigneeRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'assignee' } });
  assert.ok(assigneeRole, 'assignee WorkspaceRole must exist for the scene');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const assignments = rows.map((r) =>
    assignRepo.create({
      ticket_id: r.id,
      role_id: assigneeRole.id,
      agent_id: workerAgent.id,
      user_id: null,
    }),
  );
  await assignRepo.save(assignments, { chunk: 50 });

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

  step(`Emit ${N_TICKETS} "moved" activities back-to-back and let the bus drain`);
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

  // Wait for the focus trigger to land, then settle so any (buggy) extra /
  // non-focus trigger would also have arrived and be caught below.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && va.triggers.length < 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 500));

  // Single-focus dispatch: exactly one trigger delivered despite N moves.
  assert.equal(
    va.triggers.length,
    1,
    `Expected exactly 1 focus trigger under the single-focus model, got ${va.triggers.length}`,
  );
  // The stream survived the burst and delivered a well-formed trigger for one of
  // the bulk tickets owned by this agent.
  const bulkTicketIds = new Set(rows.map((r) => r.id));
  const tr = va.triggers[0];
  assert.ok(bulkTicketIds.has(tr.ticket_id), `focus trigger must target a bulk ticket, got ${tr.ticket_id}`);
  assert.equal(tr.agent_id, workerAgent.id, 'focus trigger addressed to the owning agent');
  assert.equal(tr.role, 'assignee');

  assert.ok(
    emissionDurationMs < BULK_BUDGET_MS,
    `Bulk emission took ${emissionDurationMs}ms — expected under ${BULK_BUDGET_MS}ms`,
  );

  exitAfterTests(0);
});
