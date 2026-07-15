// QA flow: auto-advance cascade must NOT cross review/merging GATE columns
// (ticket cc48f06f — live repro a3d25202).
//
// Symptom (a3d25202): a reporter-only follow-up ticket (assignee + reviewer not
// yet assigned) was nudged Backlog → To Do by a human, and `_autoAdvanceUnassigned`
// cascaded it To Do → Plan → In Progress → Review → Merging in ~600ms — with zero
// work, no branch, no LGTM, no reviewer trigger. Done is terminal so it stopped at
// Merging in a "ready to merge" state. The cascade treated the review/merging gates
// like any empty active column ("nobody routed here, skip ahead").
//
// Fix (cc48f06f): gate columns (kind review/merging) are excluded from the cascade.
// The ticket advances through ACTIVE stages only and HALTS at the last active column
// before the first gate, leaving an `auto_advance_halted_gate` flag for an operator.
// A human must staff the reviewer/merger seat before the ticket crosses the gate.
//
// Board topology mirrors the production GameClient board where this reproduced:
//   To Do (active) → Plan (active) → In Progress (active) → Review (review gate)
//   → Merging (merging gate) → Done (terminal)

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

process.env.PORT = process.env.QA_AUTO_ADVANCE_GATE_PORT || '7813';

// Give the async activityEvents cascade a beat to run, then prove the ticket
// settled at the expected active column and did NOT cross into a gate.
async function settle(ms = 800) {
  await new Promise((r) => setTimeout(r, ms));
}

test('auto-advance cascades through active columns but HALTS before review/merging gates', async (t) => {
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;
  const ds = app.get(getDataSourceToken());
  const activity = app.get(ActivityService);

  const ws = await createWorkspace(app, getDataSourceToken, 'auto-advance-gate');
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);

  step('build a board with review + merging gates downstream of the active stages');
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'gate-halt-board' });
  const todo = await createColumn(app, getDataSourceToken, board.id, {
    name: 'To Do', position: 0, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'], unassignedPolicy: 'skip',
  });
  const plan = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Plan', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['planner'], unassignedPolicy: 'skip',
  });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress', position: 2, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'], unassignedPolicy: 'skip',
  });
  const review = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Review', position: 3, workspaceId: ws.id, kind: 'review', roleRouting: ['reviewer'],
  });
  const merging = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Merging', position: 4, workspaceId: ws.id, kind: 'merging', roleRouting: ['assignee'],
  });
  const done = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Done', position: 5, workspaceId: ws.id, isTerminal: true, kind: 'terminal',
    roleRouting: ['reporter'],
  });

  // Reporter-only staffing: the follow-up exists with a reporter but no assignee
  // / reviewer yet (the common window right after a self-improvement follow-up is
  // filed, before a human staffs it). Reporter makes `_ticketHasAnyHolder` true,
  // so without the gate guard the ticket would cascade — the exact repro.
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: todo.id,
    workspaceId: ws.id,
    title: 'Reporter-only follow-up nudged into To Do',
    reporterId: trio.reporter.agent.id, // assignee + reviewer deliberately unset
  });

  step('emit "moved" onto To Do (no assignee holder) — kicks off the cascade');
  await activity.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, action: 'moved',
    field_changed: 'column', old_value: 'Backlog', new_value: 'To Do',
    ticket_id: ticket.id, actor_id: 'test-user', actor_name: 'tester',
  });

  await settle();

  step('ticket cascaded through skippable stages and HALTED in the configured halt column');
  const row = await ds.getRepository('Ticket').findOne({ where: { id: ticket.id } });
  assert.equal(
    row.column_id, review.id,
    `ticket must halt in Review (${review.id}); got ${row.column_id}`,
  );
  assert.notEqual(row.column_id, merging.id, 'ticket must NOT reach the Merging gate');
  assert.notEqual(row.column_id, done.id, 'ticket must NOT reach Done');

  step('a gate-halt flag was written and no move crossed into a gate column');
  const logs = await ds.getRepository('ActivityLog').find({ where: { ticket_id: ticket.id } });
  const gateHalt = logs.find((l) => l.action === 'auto_advance_halted_policy');
  assert.ok(
    gateHalt,
    `expected an auto_advance_halted_policy row; got actions ${JSON.stringify(logs.map((l) => l.action))}`,
  );
  assert.equal(gateHalt.trigger_source, 'auto_advance');

  // The cascade enters the configured halt column, then stops there.
  const autoMoves = logs.filter((l) => l.action === 'moved' && l.actor_id === 'auto-advance');
  const movedNewValues = autoMoves.map((l) => l.new_value);
  assert.ok(
    movedNewValues.includes('In Progress'),
    `expected an auto-advance into In Progress; got ${JSON.stringify(movedNewValues)}`,
  );
  assert.ok(
    movedNewValues.includes('Review') && !movedNewValues.includes('Merging'),
    `auto-advance must enter the halt column but never cross it; got ${JSON.stringify(movedNewValues)}`,
  );

  exitAfterTests(0);
});
