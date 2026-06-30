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
  t.after(() => { void app.close().catch(() => {}); });
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
  // (b) Staffed ticket, empty GATE stage → HALT on the gate, never auto-advance
  //     OUT past it (ticket cc48f06f). A review/merging gate with an empty seat
  //     means "a human still has to staff this review", NOT "nobody routed here,
  //     move along". Pre-cc48f06f this advanced past Review to Merge — that was
  //     itself a silent review-gate bypass (the reviewer never reviewed). The
  //     gate now halts in place and leaves an `auto_advance_halted_gate` flag.
  // ---------------------------------------------------------------------------
  step('(b) build board where Review routes to reviewer but only assignee is set');
  const boardB = await createBoard(app, getDataSourceToken, ws.id, { name: 'review-gate-halt-board' });
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
    title: 'Staffed ticket, empty Review gate',
    assigneeId: trio.assignee.agent.id, // reviewer deliberately unset
  });

  step('(b) emit "moved" onto the unheld Review gate column');
  await activity.logActivity({
    entity_type: 'ticket', entity_id: reviewTicket.id, action: 'moved',
    field_changed: 'column', old_value: 'Todo', new_value: 'Review',
    ticket_id: reviewTicket.id, actor_id: 'test-user', actor_name: 'tester',
  });

  await settle();

  step('(b) ticket HALTED on Review — never auto-advanced OUT past the gate');
  const reviewRow = await ds.getRepository('Ticket').findOne({ where: { id: reviewTicket.id } });
  assert.equal(
    reviewRow.column_id, bReview.id,
    `staffed-but-unreviewed ticket must halt on the Review gate (${bReview.id}); got ${reviewRow.column_id}`,
  );
  assert.notEqual(reviewRow.column_id, bMerge.id, 'ticket must not skip the Review gate to Merge');
  const reviewLogs = await ds
    .getRepository('ActivityLog')
    .find({ where: { ticket_id: reviewTicket.id } });
  assert.ok(
    !reviewLogs.some((l) => l.action === 'moved' && l.actor_id === 'auto-advance'),
    'gate must NOT produce an auto-advance moved row',
  );
  const gateHalt = reviewLogs.find((l) => l.action === 'auto_advance_halted_gate');
  assert.ok(
    gateHalt,
    `expected an auto_advance_halted_gate row; got actions ${JSON.stringify(reviewLogs.map((l) => l.action))}`,
  );
  assert.equal(gateHalt.trigger_source, 'auto_advance');

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

  // ---------------------------------------------------------------------------
  // (d) REPORTER-ONLY ticket on an unservable active column → CASCADE, not halt
  //     (ticket 519fad18). A ticket whose only holder is the reporter is NOT an
  //     orphan: `_ticketHasAnyHolder` counts the reporter, so it takes the
  //     staffed-elsewhere skip path and auto-advances past the unservable stage
  //     instead of writing an `auto_advance_halted_unassigned` flag. This is the
  //     exact shape the live "Column role routing & auto-advance" QA scenario
  //     produces: create_ticket auto-defaults the reporter to the caller
  //     (commit 29f7df8), so the scenario's "completely-unassigned" ticket
  //     actually carries a reporter and must cascade — NOT halt — here. The
  //     regression this guards: dropping the reporter from `_ticketHasAnyHolder`
  //     would silently re-break that scenario (orphan-halt firing on a staffed
  //     ticket). The truly-zero-holder orphan is covered by case (a) above.
  // ---------------------------------------------------------------------------
  step('(d) build board where Plan routes to planner (unheld) and Work routes to reporter');
  const boardD = await createBoard(app, getDataSourceToken, ws.id, { name: 'reporter-only-cascade-board' });
  await createColumn(app, getDataSourceToken, boardD.id, {
    name: 'Todo', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: ['assignee'],
  });
  const dPlan = await createColumn(app, getDataSourceToken, boardD.id, {
    name: 'Plan', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['planner'],
  });
  const dWork = await createColumn(app, getDataSourceToken, boardD.id, {
    name: 'Work', position: 2, workspaceId: ws.id, kind: 'active', roleRouting: ['reporter'],
  });
  await createColumn(app, getDataSourceToken, boardD.id, {
    name: 'Done', position: 3, workspaceId: ws.id, isTerminal: true, kind: 'terminal',
    roleRouting: ['reporter'],
  });

  // Only a reporter — no assignee, no reviewer. Mirrors an MCP-created ticket
  // whose reporter was auto-filled to the creator and nothing else was set.
  const reporterOnly = await createTicket(app, getDataSourceToken, {
    columnId: dPlan.id,
    workspaceId: ws.id,
    title: 'Reporter-only ticket on an unservable Plan',
    reporterId: trio.reporter.agent.id,
  });

  step('(d) emit "moved" onto the unservable (planner-routed) Plan column');
  await activity.logActivity({
    entity_type: 'ticket', entity_id: reporterOnly.id, action: 'moved',
    field_changed: 'column', old_value: 'Todo', new_value: 'Plan',
    ticket_id: reporterOnly.id, actor_id: 'test-user', actor_name: 'tester',
  });

  step('(d) ticket cascaded past Plan to the reporter-servable Work column');
  const reporterRow = await waitForTicket(ds, reporterOnly.id, (r) => r.column_id === dWork.id);
  assert.equal(
    reporterRow.column_id, dWork.id,
    `reporter-only ticket must cascade past the unservable Plan to Work (${dWork.id}); got ${reporterRow.column_id}`,
  );

  step('(d) NO orphan-halt flag was written — a reporter is a holder, not an orphan');
  const reporterLogs = await ds
    .getRepository('ActivityLog')
    .find({ where: { ticket_id: reporterOnly.id } });
  assert.ok(
    !reporterLogs.some((l) => l.action === 'auto_advance_halted_unassigned'),
    `reporter-only ticket must NOT produce an auto_advance_halted_unassigned row; got ${JSON.stringify(reporterLogs.map((l) => l.action))}`,
  );
  assert.ok(
    reporterLogs.some((l) => l.action === 'moved' && l.actor_id === 'auto-advance'),
    'reporter-only ticket must cascade via an auto-advance moved row',
  );

  exitAfterTests(0);
});
