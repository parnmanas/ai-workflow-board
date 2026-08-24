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
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'comment-trig',
    envRepo: true,
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

// ticket 3c8b8026: a system/manager auto-notice comment (e.g. "⚠️ 중복
// dispatch 억제") is itself posted via add_comment, authenticated as the real
// Manager agent — without this guard its `actor_id` is a real UUID, passes
// the comment-trigger path above unchanged, and wakes the assignee again.
// That re-trigger gets suppressed too, posts another notice, and so on — a
// self-amplifying loop that burned a 30-dispatch hard-budget ceiling in 16
// minutes on pure echo (27% of the emitted triggers were this notice alone).
// comment-tools.ts now stamps `actor_id='system'` on the activity-log row for
// any add_comment carrying `metadata.auto_notice===true`, which routes
// straight into the SAME pre-existing system-actor skip this file's first
// test does NOT exercise (it uses a real user actor_id). This asserts the
// negative side of that same comment-entity/created path end-to-end through
// TriggerLoopService, then proves the harness isn't vacuously silent by
// checking an ordinary comment right after it DOES still trigger.
test('a system-actor comment (auto-notice shape) does not trigger the routed role; an ordinary comment right after still does', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.QA_COMMENT_SYSTEM_PORT || '7815', 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'comment-trig-system-actor',
    envRepo: true,
  });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const user = await createUser(app, getDataSourceToken, { name: 'commenter2' });

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'Comment trigger — system-actor auto-notice',
    assigneeId: trio.assignee.agent.id,
    reporterId: trio.reporter.agent.id,
    reviewerId: trio.reviewer.agent.id,
  });

  const assigneeAgent = new VirtualAgent({
    name: 'assignee', agentId: trio.assignee.agent.id, apiKey: trio.assignee.key.raw_key, port,
  });
  await assigneeAgent.start();
  t.after(() => assigneeAgent.stop());
  await new Promise((r) => setTimeout(r, 200));

  step('Emit 3x "comment.created" activity with actor_id=system (auto_notice shape) — must never trigger');
  for (let i = 0; i < 3; i++) {
    await app.get(ActivityService).logActivity({
      entity_type: 'comment',
      entity_id: `auto-notice-${i}`,
      action: 'created',
      ticket_id: ticket.id,
      actor_id: 'system',
      actor_name: 'Manager',
    });
  }
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(
    assigneeAgent.triggersFor(ticket.id).length,
    0,
    'three system-actor comment.created activities (the auto_notice shape) must produce zero triggers — this is the self-amplification loop this ticket fixes',
  );

  step('Sanity control: an ORDINARY (real actor) comment right after must still trigger — proves the harness is not vacuously silent');
  await app.get(ActivityService).logActivity({
    entity_type: 'comment',
    entity_id: 'ordinary-1',
    action: 'created',
    ticket_id: ticket.id,
    actor_id: user.id,
    actor_name: user.name,
  });
  const trig = await assigneeAgent.waitForTrigger(
    (tr) => tr.ticket_id === ticket.id && tr.trigger_source === 'comment',
    4000,
  );
  assert.equal(trig.role, 'assignee');

  exitAfterTests(0);
});
