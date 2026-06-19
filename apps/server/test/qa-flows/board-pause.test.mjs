// QA flow: Board pause gate.
//
// `Board.paused_at` (set non-null) must make `_emitTrigger` drop every
// dispatch path silently. We exercise the comment path here because:
//   - `_emitTrigger` is the chokepoint every path funnels through, so a
//     comment trigger gated == manual / supervisor / backlog also gated;
//   - the comment-trigger test fixture already proves the un-paused
//     side wakes the assignee, so this test only adds the negative case.
//
// Acceptance:
//   1. With paused_at = NOW, posting a comment on a routed In Progress
//      ticket emits NO agent_trigger to the assignee within 1 second.
//   2. After clearing paused_at and re-emitting the comment activity,
//      the assignee receives the trigger normally.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgentTrio,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_BOARD_PAUSE_PORT || '7820';

test('Paused board drops agent triggers; resume restores them', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'pause',
  });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const user = await createUser(app, getDataSourceToken, { name: 'pauser' });

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'Pause gate test',
    assigneeId: trio.assignee.agent.id,
    reporterId: trio.reporter.agent.id,
    reviewerId: trio.reviewer.agent.id,
  });

  const assigneeAgent = new VirtualAgent({
    name: 'assignee',
    agentId: trio.assignee.agent.id,
    apiKey: trio.assignee.key.raw_key,
    port,
  });
  await assigneeAgent.start();
  t.after(async () => { await assigneeAgent.stop(); });
  await new Promise((r) => setTimeout(r, 200));

  step('Pause the board (set paused_at)');
  const ds = app.get(getDataSourceToken());
  const boardRepo = ds.getRepository('Board');
  await boardRepo.update({ id: board.id }, { paused_at: new Date() });

  step('Emit comment.created — should be silently dropped');
  await app.get(ActivityService).logActivity({
    entity_type: 'comment',
    entity_id: 'cmt-paused-1',
    action: 'created',
    ticket_id: ticket.id,
    actor_id: user.id,
    actor_name: user.name,
  });

  // No trigger within a generous window. waitForTrigger with a short
  // timeout returning is the negative-evidence shape used elsewhere.
  let droppedTrigger = null;
  try {
    droppedTrigger = await assigneeAgent.waitForTrigger(
      (tr) => tr.ticket_id === ticket.id,
      1500,
    );
  } catch {
    // Timeout = pass for the paused case
  }
  assert.equal(droppedTrigger, null, 'paused board must NOT emit agent_trigger');

  // Audit row was written by the drop path.
  const activityRepo = ds.getRepository('ActivityLog');
  const auditRows = await activityRepo.find({
    where: { ticket_id: ticket.id, action: 'agent_trigger_dropped_board_paused' },
  });
  assert.ok(auditRows.length >= 1, 'expected at least one agent_trigger_dropped_board_paused audit row');

  step('Resume the board (clear paused_at)');
  await boardRepo.update({ id: board.id }, { paused_at: null });

  step('Re-emit comment.created — should now wake the assignee');
  await app.get(ActivityService).logActivity({
    entity_type: 'comment',
    entity_id: 'cmt-resumed-1',
    action: 'created',
    ticket_id: ticket.id,
    actor_id: user.id,
    actor_name: user.name,
  });

  const trig = await assigneeAgent.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.trigger_source === 'comment',
    4000,
  );
  assert.equal(trig.role, 'assignee', 'resumed board: assignee receives the comment trigger');

  exitAfterTests(0);
});
