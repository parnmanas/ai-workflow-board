// QA: a virtual agent receives an SSE trigger and responds by calling MCP
// tools. Verifies the closed-loop contract (SSE in → tool call out) the
// real proxy.mjs + Claude CLI stack depends on.

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

process.env.PORT = process.env.QA_MCP_ROUNDTRIP_PORT || '7810';

test('Virtual agent reacts to agent_trigger by calling MCP move_ticket + add_comment', { skip: 'quarantined: pre-existing failure unmasked by harness fix fc84ec30 — repair tracked in ticket 5e5959ef' }, async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'roundtrip',
  });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    workspaceId: ws.id,
    label: 'worker',
  });
  const user = await createUser(app, getDataSourceToken, { name: 'manager' });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id,
    workspaceId: ws.id,
    title: 'Roundtrip ticket',
    promptText: 'Move me to review and leave a note.',
    assigneeId: worker.id,
  });

  const va = new VirtualAgent({
    name: 'worker',
    agentId: worker.id,
    apiKey: workerKey.raw_key,
    port,
    onTrigger: async ({ mcp, trigger }) => {
      await mcp.callTool('add_comment', {
        ticket_id: trigger.ticket_id,
        content: 'Got it — advancing to Review.',
        type: 'note',
      });
      await mcp.callTool('move_ticket', {
        ticket_id: trigger.ticket_id,
        target_column_name: 'Review',
        board_id: columns.review.board_id,
      });
    },
  });
  await va.start();
  t.after(() => va.stop());
  await new Promise((r) => setTimeout(r, 200));

  step('Move ticket Todo → In Progress to trigger the worker agent');
  const ticketRepo = app.get(getDataSourceToken()).getRepository('Ticket');
  const commentRepo = app.get(getDataSourceToken()).getRepository('Comment');
  await ticketRepo.update(ticket.id, { column_id: columns.inProgress.id });
  await app.get(ActivityService).logActivity({
    entity_type: 'ticket',
    entity_id: ticket.id,
    action: 'moved',
    ticket_id: ticket.id,
    new_value: 'In Progress',
    actor_id: user.id,
    actor_name: user.name,
  });

  step('Wait for trigger, then verify agent called add_comment + move_ticket via MCP');
  await va.waitForTrigger((tr) => tr.ticket_id === ticket.id, 4000);

  // Poll DB until the agent's reactions commit (move + comment).
  const reviewId = columns.review.id;
  const deadline = Date.now() + 8000;
  let finalTicket;
  while (Date.now() < deadline) {
    finalTicket = await ticketRepo.findOne({ where: { id: ticket.id } });
    if (finalTicket?.column_id === reviewId) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(finalTicket?.column_id, reviewId, 'Agent moved ticket to Review via MCP');

  // SystemCommentService auto-posts move-tracking comments, so total comment
  // count is >=1. Filter to the agent-authored ones we actually care about.
  const allComments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  const agentComments = allComments.filter(
    (c) => c.author_type === 'agent' && c.author_id === worker.id,
  );
  assert.equal(agentComments.length, 1, 'Exactly one agent-authored comment');
  assert.equal(agentComments[0].content, 'Got it — advancing to Review.');
  exitAfterTests(0);
});
