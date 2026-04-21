// QA flow: comment-driven agent triggering.
//
// A new comment on a ticket sitting in a routed column must fire an
// agent_trigger at that column's roleholders (trigger_source='comment').
// This is how handoff between roles works in practice: reviewer asks
// assignee to fix something by posting a comment on the In Progress ticket.

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

process.env.PORT = process.env.QA_COMMENT_PORT || '7802';

test('Comment on In Progress ticket triggers assignee (trigger_source=comment)', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'comment-trig',
  });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const user = await createUser(app, getDataSourceToken, { name: 'commenter' });

  // Ticket already sits in the assignee-routed column.
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'Comment trigger test',
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
  const reviewerAgent = new VirtualAgent({
    name: 'reviewer',
    agentId: trio.reviewer.agent.id,
    apiKey: trio.reviewer.key.raw_key,
    port,
  });
  await Promise.all([assigneeAgent.start(), reviewerAgent.start()]);
  t.after(async () => {
    await Promise.all([assigneeAgent.stop(), reviewerAgent.stop()]);
  });
  await new Promise((r) => setTimeout(r, 200));

  step('Emit "comment.created" activity on In Progress ticket');
  await app.get(ActivityService).logActivity({
    entity_type: 'comment',
    entity_id: 'cmt-1',
    action: 'created',
    ticket_id: ticket.id,
    actor_id: user.id,
    actor_name: user.name,
  });

  step('Wait for trigger_source=comment on assignee SSE stream');
  const trig = await assigneeAgent.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.trigger_source === 'comment',
    4000,
  );
  assert.equal(trig.role, 'assignee');

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(
    reviewerAgent.triggersFor(ticket.id).length,
    0,
    'reviewer not routed to "in progress" — must receive no trigger',
  );

  exitAfterTests(0);
});
