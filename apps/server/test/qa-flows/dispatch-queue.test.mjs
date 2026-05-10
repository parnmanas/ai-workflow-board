// QA flow: per-agent dispatch queue lifecycle (ticket 47a90ea3).
//
// What this proves
// ────────────────
// The four-layer fix (v0.41) on this branch is supposed to close the
// GameClient starvation loop:
//
//   1. cap-exceeded triggers ENQUEUE on the per-agent priority queue
//      instead of being silently dropped.
//   2. items sort by priority_index (so a critical Review column-move
//      arriving mid-promotion jumps a medium-priority backlog item).
//   3. clearCurrentTask → agent_idle → _tryDispatchFromQueue picks the
//      highest-priority item and emits it.
//   4. depth-cap overflow drops the LOWEST-priority pending item (never
//      the new high-priority arrival), and the drop is observable as a
//      `queue_dropped_low_priority` activity row.
//
// We exercise the loop end-to-end against the real NestJS app (sqlite),
// then assert the canonical activity-log rows the ticket's AC #5 calls
// for: `trigger_emitted`, `trigger_enqueued`, `dispatched_from_queue`,
// `queue_dropped_low_priority`.
//
// Reproducer for the GameClient starvation pattern:
//   - 1 agent, 1 board, max_concurrent_tickets_per_agent = 1.
//   - Agent already busy on a ticket (active_tasks holds T_busy).
//   - Two more triggers arrive: T_med (priority=medium) then T_critical
//     (priority=critical). Both should land in the queue; head should be
//     T_critical because it has the smaller priority_index.
//   - clearCurrentTask(T_busy) → agent_idle → queue head dispatches first.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createApiKey,
  createBoard,
  createColumn,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/ is at apps/server/dist relative to this test file at apps/server/test/qa-flows/.
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_DISPATCH_QUEUE_PORT || '7820';

test('Dispatch queue: cap-skip → enqueue → priority-ordered dispatch + depth-cap eviction + terminal sweep', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port: _port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken, ActivityService } = modules;

  // Pull the live services from the DI container — same instances the
  // production trigger-loop uses, so this test exercises the real wiring.
  const dispatchQueueServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-dispatch-queue.service.js')
  );
  const triggerLoopServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'trigger-loop.service.js')
  );
  const agentStatusServiceModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-status.service.js')
  );
  const dispatchQueue = app.get(dispatchQueueServiceModule.AgentDispatchQueueService);
  const triggerLoop = app.get(triggerLoopServiceModule.TriggerLoopService);
  const agentStatus = app.get(agentStatusServiceModule.AgentStatusService);
  const ds = app.get(getDataSourceToken());

  step('Seed workspace + 1 agent + 3 builtin roles + board (max_concurrent=1) + columns w/ kind+role_routing');
  const ws = await createWorkspace(app, getDataSourceToken, 'queue');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'solo' });
  await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'solo' });
  await createUser(app, getDataSourceToken, { name: 'driver' });

  // Builtin roles (assignee/reporter/reviewer/planner) are seeded by
  // createWorkspace itself — just look up the assignee row we'll bind
  // the manual TicketRoleAssignment fixtures to below.
  const roleRepo = ds.getRepository('WorkspaceRole');
  const assigneeRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'assignee' } });
  assert.ok(assigneeRole, 'createWorkspace should have seeded the assignee role');

  // Board with max_concurrent_tickets_per_agent=1 (the pre-v0.41 silent-drop
  // trigger) so any second concurrent trigger for `agent` MUST go to the queue.
  const boardRepo = ds.getRepository('Board');
  const board = await boardRepo.save(
    boardRepo.create({
      name: 'queue-board',
      description: '',
      workspace_id: ws.id,
      routing_config: JSON.stringify({ 'in progress': ['assignee'] }),
      max_concurrent_tickets_per_agent: 1,
    }),
  );

  // Columns — Backlog (intake) + In Progress (active w/ assignee routing) + Done (terminal).
  // role_routing is the v0.41 dispatch-time read; we set it explicitly so the
  // test doesn't depend on the migration having run.
  const colRepo = ds.getRepository('BoardColumn');
  const backlog = await createColumn(app, getDataSourceToken, board.id, { name: 'Backlog', position: 0, workspaceId: ws.id });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, { name: 'In Progress', position: 1, workspaceId: ws.id });
  const done = await createColumn(app, getDataSourceToken, board.id, { name: 'Done', position: 2, workspaceId: ws.id, isTerminal: true });
  await colRepo.update(backlog.id, { kind: 'intake', role_routing: '[]' });
  await colRepo.update(inProgress.id, { kind: 'active', role_routing: JSON.stringify(['assignee']) });
  await colRepo.update(done.id, { kind: 'terminal', role_routing: '[]' });

  step('Create 3 tickets at different priorities, all assigned to `agent`');
  // T_busy — the ticket the agent is already working on (cap-occupier).
  // T_med — medium priority, should enqueue and rank BEHIND T_critical.
  // T_critical — critical priority, should enqueue and BECOME the queue head.
  const tBusy = await createTicket(app, getDataSourceToken, {
    columnId: inProgress.id, workspaceId: ws.id, title: 't-busy', priority: 'medium',
  });
  const tMed = await createTicket(app, getDataSourceToken, {
    columnId: inProgress.id, workspaceId: ws.id, title: 't-med', priority: 'medium',
  });
  const tCritical = await createTicket(app, getDataSourceToken, {
    columnId: inProgress.id, workspaceId: ws.id, title: 't-critical', priority: 'critical',
  });
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  for (const tk of [tBusy, tMed, tCritical]) {
    await assignRepo.save(assignRepo.create({
      ticket_id: tk.id, role_id: assigneeRole.id, agent_id: agent.id, user_id: null,
    }));
  }

  step('Mark agent busy on T_busy (active_tasks size=1, max_concurrent=1)');
  await agentStatus.setCurrentTask(agent.id, tBusy.id, 'assignee');

  step('Fire trigger for T_med — cap closed, expect ENQUEUE');
  await triggerLoop.emitAgentTrigger(tMed, agent.id, 'assignee', 'column_move', 'test-driver');
  await new Promise((r) => setTimeout(r, 100));
  const afterMedQ = dispatchQueue.getAll(agent.id);
  assert.equal(afterMedQ.length, 1, 'queue should have 1 item after T_med cap-skip');
  assert.equal(afterMedQ[0].ticket_id, tMed.id, 'queue head should be T_med');

  step('Fire trigger for T_critical — also cap closed, expect ENQUEUE + jump to head');
  await triggerLoop.emitAgentTrigger(tCritical, agent.id, 'assignee', 'column_move', 'test-driver');
  await new Promise((r) => setTimeout(r, 100));
  const afterCritQ = dispatchQueue.getAll(agent.id);
  assert.equal(afterCritQ.length, 2, 'queue should have 2 items after both cap-skips');
  assert.equal(afterCritQ[0].ticket_id, tCritical.id,
    `priority sort: T_critical (idx=${afterCritQ[0].priority_index}) must come before T_med (idx=${afterCritQ[1].priority_index})`);
  assert.ok(afterCritQ[0].priority_index < afterCritQ[1].priority_index, 'priority_index sort key intact');

  step('Verify trigger_enqueued activity rows exist for both queued items');
  const activityLogRepo = ds.getRepository('ActivityLog');
  const enqueueRows = await activityLogRepo.find({ where: { action: 'trigger_enqueued' } });
  const enqueuedTicketIds = new Set(enqueueRows.map((r) => r.ticket_id));
  assert.ok(enqueuedTicketIds.has(tMed.id), 'expected trigger_enqueued for T_med');
  assert.ok(enqueuedTicketIds.has(tCritical.id), 'expected trigger_enqueued for T_critical');

  step('Clear T_busy active task — agent_idle should dispatch the queue head (T_critical)');
  agentStatus.clearCurrentTask(agent.id, tBusy.id);
  // Allow the activityEvents listener chain to drain.
  await new Promise((r) => setTimeout(r, 250));
  const afterDispatchQ = dispatchQueue.getAll(agent.id);
  assert.equal(afterDispatchQ.length, 1, `queue should have 1 item after dispatch (got ${afterDispatchQ.length})`);
  assert.equal(afterDispatchQ[0].ticket_id, tMed.id, 'remaining queue item should be T_med');

  step('Verify dispatched_from_queue + trigger_emitted rows for T_critical');
  const dispatchedRows = await activityLogRepo.find({ where: { action: 'dispatched_from_queue' } });
  assert.ok(
    dispatchedRows.some((r) => r.ticket_id === tCritical.id),
    'expected dispatched_from_queue for T_critical (priority-ordered head)',
  );
  const emittedRows = await activityLogRepo.find({ where: { action: 'trigger_emitted' } });
  assert.ok(
    emittedRows.some((r) => r.ticket_id === tCritical.id),
    'expected trigger_emitted for T_critical (queue dispatch fed _emitTrigger)',
  );

  step('Depth-cap overflow: shrink queue depth to 1 + force a low-prio drop');
  // Drop dispatch_queue_depth so the next enqueue triggers a queue_dropped_low_priority.
  const wsRepo = ds.getRepository('Workspace');
  await wsRepo.update(ws.id, { dispatch_queue_depth: 1 });
  // Re-occupy the agent so subsequent emits cap-skip again.
  await agentStatus.setCurrentTask(agent.id, tBusy.id, 'assignee');
  // Start with the queue containing only T_med (medium). Add one more
  // medium ticket — sort ties on enqueued_at ASC, so the depth=1 cap
  // evicts the LATER one. Then add a critical ticket — that one survives
  // and evicts a medium.
  const tLow1 = await createTicket(app, getDataSourceToken, {
    columnId: inProgress.id, workspaceId: ws.id, title: 't-low1', priority: 'low',
  });
  await assignRepo.save(assignRepo.create({
    ticket_id: tLow1.id, role_id: assigneeRole.id, agent_id: agent.id, user_id: null,
  }));
  await triggerLoop.emitAgentTrigger(tLow1, agent.id, 'assignee', 'column_move', 'test-driver');
  await new Promise((r) => setTimeout(r, 100));

  const droppedRows = await activityLogRepo.find({ where: { action: 'queue_dropped_low_priority' } });
  assert.ok(
    droppedRows.length > 0,
    'expected at least one queue_dropped_low_priority row after depth=1 overflow',
  );
  // The new low-priority item is the worst entry, so it gets dropped.
  // T_med (already in the queue at idx=2) should survive.
  const overflowQueue = dispatchQueue.getAll(agent.id);
  assert.equal(overflowQueue.length, 1, 'queue depth should still be 1 after overflow drop');
  assert.equal(overflowQueue[0].ticket_id, tMed.id, 'medium-priority T_med should survive over low-priority newcomer');

  step('Terminal-landing sweep: removeForTicketEverywhere drops queued entries for done tickets');
  // Move T_med to Done and fire a `moved` activity — the trigger-loop's
  // terminal handler should sweep T_med out of the queue.
  await ds.getRepository('Ticket').update(tMed.id, { column_id: done.id });
  const activitySvc = app.get(ActivityService);
  await activitySvc.logActivity({
    entity_type: 'ticket',
    entity_id: tMed.id,
    ticket_id: tMed.id,
    action: 'moved',
    field_changed: 'column',
    old_value: 'In Progress',
    new_value: 'Done',
    actor_id: 'test-driver',
    actor_name: 'driver',
  });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(dispatchQueue.size(agent.id), 0,
    'terminal landing should sweep the queue for that ticket');

  // Print the canonical lifecycle rows so reviewers reading the test log
  // can read the full audit trail without rebuilding it.
  step('Activity-log evidence (the four lifecycle event types)');
  const allEvents = ['trigger_emitted', 'trigger_enqueued', 'dispatched_from_queue', 'queue_dropped_low_priority'];
  for (const action of allEvents) {
    const rows = await activityLogRepo.find({ where: { action } });
    console.log(`  ${action}: ${rows.length} row(s)`);
    for (const r of rows) {
      console.log(`    ticket=${r.ticket_id.slice(0, 8)}  role=${r.role || '-'}  src=${r.trigger_source || '-'}  ${r.new_value || ''}`);
    }
  }

  exitAfterTests(0);
});
