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
import { McpClient } from '../helpers/mcp-client.mjs';

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

  // Drive pause/resume through the MCP `update_board {paused}` tool — the
  // exact path the awb-mcp QA driver (qa-seed-scenarios board-pause-resume)
  // uses. Earlier this tool had no `paused` param, so the scenario's pause
  // calls were silent no-ops and the gate could never be engaged from an
  // agent driver (ticket 3fbbd069). This proves the agent-facing path now
  // sets/clears paused_at, not just a direct DB write.
  const mcp = new McpClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: trio.assignee.key.raw_key,
    clientInfo: { name: 'pause-driver', version: '1.0.0' },
  });
  t.after(() => { void mcp.close().catch(() => {}); });

  step('Pause the board via MCP update_board {paused:true}');
  const ds = app.get(getDataSourceToken());
  const boardRepo = ds.getRepository('Board');
  const pauseResult = await mcp.callTool('update_board', { board_id: board.id, paused: true });
  assert.ok(!pauseResult?.isError, `update_board paused:true should succeed, got ${JSON.stringify(pauseResult)}`);
  const pausedBoard = await boardRepo.findOne({ where: { id: board.id } });
  assert.ok(pausedBoard?.paused_at != null, 'update_board {paused:true} must stamp paused_at');

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

  step('Resume the board via MCP update_board {paused:false}');
  const resumeResult = await mcp.callTool('update_board', { board_id: board.id, paused: false });
  assert.ok(!resumeResult?.isError, `update_board paused:false should succeed, got ${JSON.stringify(resumeResult)}`);
  const resumedBoard = await boardRepo.findOne({ where: { id: board.id } });
  assert.equal(resumedBoard?.paused_at, null, 'update_board {paused:false} must clear paused_at');

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
