// QA flow: auto-advance vs HALT split (ticket c5951280).
//
// The pre-fix trigger loop treated "this column's routed roles have no holder"
// as a single signal meaning "push the ticket forward". That conflated two
// situations with opposite correct outcomes:
//
//   (a) COMPLETELY UNASSIGNED ticket (no holder on ANY role) — must HALT in
//       place and leave an `auto_advance_halted_unassigned` flag. It must NOT
//       cascade silently to Done with nobody ever owning it.
//   (b) STAFFED ticket whose CURRENT stage is empty (e.g. Review routes to
//       reviewer but only the assignee is set) — the empty stage is an
//       intended skip; advance past it to the next servable column.
//   (c) CONFIG-DRIFT column whose routed slug doesn't resolve to any
//       WorkspaceRole (`resolved.length === 0`) — used to fall out of the
//       advance condition entirely and dead-end forever. For a staffed ticket
//       it must now advance past the unservable column rather than stall.
//
// All three are exercised against one booted app, each on its own board so the
// column topologies stay independent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createBoard,
  createColumn,
  createAgentTrio,
  createTicket,
} from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_AUTO_ADVANCE_HALT_PORT || '7812';

// Poll a ticket row until `predicate(row)` holds or the deadline passes.
// The cascade runs off the async activityEvents listener, so there is no
// synchronous point to assert at — mirror the existing waitForTrigger poll.
async function waitForTicket(ds, ticketId, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  const repo = ds.getRepository('Ticket');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const row = await repo.findOne({ where: { id: ticketId } });
    if (row && predicate(row)) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `Timeout (${timeoutMs}ms) waiting on ticket ${ticketId}; last column_id=${row?.column_id}`,
      );
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

// Settle helper for the HALT case: there is no positive state change to wait
// for (the ticket must stay put), so give the listener a beat to run and prove
// it did NOT advance.
async function settle(ms = 600) {
  await new Promise((r) => setTimeout(r, ms));
}

test('auto-advance halts fully-unassigned tickets and advances staffed ones', async (t) => {
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken, ActivityService } = modules;
  const ds = app.get(getDataSourceToken());
  const activity = app.get(ActivityService);

  const ws = await createWorkspace(app, getDataSourceToken, 'auto-advance-halt');
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);

  // ---------------------------------------------------------------------------
  // (a) Completely unassigned ticket → HALT in place + flag, never reach Done.
  // ---------------------------------------------------------------------------
  step('(a) build board with an unassigned ticket on a routed-but-unheld column');
  const boardA = await createBoard(app, getDataSourceToken, ws.id, { name: 'halt-board' });
  await createColumn(app, getDataSourceToken, boardA.id, {
    name: 'Todo', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: ['assignee'],
  });
  const aWork = await createColumn(app, getDataSourceToken, boardA.id, {
    name: 'Work', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  const aDone = await createColumn(app, getDataSourceToken, boardA.id, {
    name: 'Done', position: 2, workspaceId: ws.id, isTerminal: true, kind: 'terminal',
    roleRouting: ['reporter'],
  });

  // No assignee / reporter / reviewer → zero TicketRoleAssignment rows = orphan.
  const orphan = await createTicket(app, getDataSourceToken, {
    columnId: aWork.id,
    workspaceId: ws.id,
    title: 'Orphan ticket — nobody assigned',
  });

  step('(a) emit "moved" onto the unheld Work column');
  await activity.logActivity({
    entity_type: 'ticket', entity_id: orphan.id, action: 'moved',
    field_changed: 'column', old_value: 'Todo', new_value: 'Work',
    ticket_id: orphan.id, actor_id: 'test-user', actor_name: 'tester',
  });

  await settle();

  step('(a) ticket stayed on Work — did NOT advance toward Done');
  const orphanRow = await ds.getRepository('Ticket').findOne({ where: { id: orphan.id } });
  assert.equal(
    orphanRow.column_id, aWork.id,
    `orphan must halt on Work (${aWork.id}); got ${orphanRow.column_id}`,
  );
  assert.notEqual(orphanRow.column_id, aDone.id, 'orphan must never reach Done');

  step('(a) a halt flag row was written and no auto-advance move happened');
  const orphanLogs = await ds
    .getRepository('ActivityLog')
    .find({ where: { ticket_id: orphan.id } });
  const haltFlag = orphanLogs.find((l) => l.action === 'auto_advance_halted_unassigned');
  assert.ok(
    haltFlag,
    `expected an auto_advance_halted_unassigned row; got actions ${JSON.stringify(orphanLogs.map((l) => l.action))}`,
  );
  assert.equal(haltFlag.trigger_source, 'auto_advance');
  const orphanAutoMove = orphanLogs.find(
    (l) => l.action === 'moved' && l.actor_id === 'auto-advance',
  );
  assert.ok(!orphanAutoMove, 'orphan must not produce an auto-advance moved row');

  // ---------------------------------------------------------------------------
  // (b) Staffed ticket, empty Review stage → advance past Review to a servable
  //     column (assignee-routed Merge), then stop there.
  // ---------------------------------------------------------------------------
  step('(b) build board where Review routes to reviewer but only assignee is set');
  const boardB = await createBoard(app, getDataSourceToken, ws.id, { name: 'review-skip-board' });
  await createColumn(app, getDataSourceToken, boardB.id, {
    name: 'Todo', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: ['assignee'],
  });
  const bReview = await createColumn(app, getDataSourceToken, boardB.id, {
    name: 'Review', position: 1, workspaceId: ws.id, kind: 'review', roleRouting: ['reviewer'],
  });
  const bMerge = await createColumn(app, getDataSourceToken, boardB.id, {
    name: 'Merge', position: 2, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  await createColumn(app, getDataSourceToken, boardB.id, {
    name: 'Done', position: 3, workspaceId: ws.id, isTerminal: true, kind: 'terminal',
    roleRouting: ['reporter'],
  });

  const reviewTicket = await createTicket(app, getDataSourceToken, {
    columnId: bReview.id,
    workspaceId: ws.id,
    title: 'Staffed ticket, empty Review stage',
    assigneeId: trio.assignee.agent.id, // reviewer deliberately unset
  });

  step('(b) emit "moved" onto the unheld Review column');
  await activity.logActivity({
    entity_type: 'ticket', entity_id: reviewTicket.id, action: 'moved',
    field_changed: 'column', old_value: 'Todo', new_value: 'Review',
    ticket_id: reviewTicket.id, actor_id: 'test-user', actor_name: 'tester',
  });

  step('(b) ticket advanced past Review to the assignee-served Merge column');
  const reviewRow = await waitForTicket(ds, reviewTicket.id, (r) => r.column_id === bMerge.id);
  assert.equal(reviewRow.column_id, bMerge.id);
  const reviewLogs = await ds
    .getRepository('ActivityLog')
    .find({ where: { ticket_id: reviewTicket.id, action: 'moved' } });
  assert.ok(
    reviewLogs.some((l) => l.actor_id === 'auto-advance'),
    'expected an auto-advance moved row past the empty Review stage',
  );

  // ---------------------------------------------------------------------------
  // (c) Staffed ticket on a config-drift column (slug resolves to no role) →
  //     advance past it instead of dead-ending.
  // ---------------------------------------------------------------------------
  step('(c) build board with an unresolvable role slug on the middle column');
  const boardC = await createBoard(app, getDataSourceToken, ws.id, { name: 'config-drift-board' });
  await createColumn(app, getDataSourceToken, boardC.id, {
    name: 'Todo', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: ['assignee'],
  });
  const cGhost = await createColumn(app, getDataSourceToken, boardC.id, {
    name: 'Ghost', position: 1, workspaceId: ws.id, kind: 'active',
    roleRouting: ['role-that-does-not-exist'],
  });
  const cWork = await createColumn(app, getDataSourceToken, boardC.id, {
    name: 'Work', position: 2, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  await createColumn(app, getDataSourceToken, boardC.id, {
    name: 'Done', position: 3, workspaceId: ws.id, isTerminal: true, kind: 'terminal',
    roleRouting: ['reporter'],
  });

  const driftTicket = await createTicket(app, getDataSourceToken, {
    columnId: cGhost.id,
    workspaceId: ws.id,
    title: 'Staffed ticket on a config-drift column',
    assigneeId: trio.assignee.agent.id,
  });

  step('(c) emit "moved" onto the unresolvable-slug Ghost column');
  await activity.logActivity({
    entity_type: 'ticket', entity_id: driftTicket.id, action: 'moved',
    field_changed: 'column', old_value: 'Todo', new_value: 'Ghost',
    ticket_id: driftTicket.id, actor_id: 'test-user', actor_name: 'tester',
  });

  step('(c) ticket advanced past the config-drift column to a servable one');
  const driftRow = await waitForTicket(ds, driftTicket.id, (r) => r.column_id === cWork.id);
  assert.equal(
    driftRow.column_id, cWork.id,
    `config-drift column must not be a dead-end; expected ${cWork.id}, got ${driftRow.column_id}`,
  );

  exitAfterTests(0);
});
