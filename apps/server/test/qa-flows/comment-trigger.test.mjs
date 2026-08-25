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

// ticket 3c8b8026: 시스템/매니저 자동 알림(예: "⚠️ 중복 dispatch 억제")도
// add_comment로 저장되며 실제 Manager UUID로 인증된다. 별도 표시가 없으면
// 일반 코멘트 트리거 경로를 통과해 담당자를 다시 깨우고, 그 재트리거도 다시
// 억제되어 알림을 남기는 자기증폭 루프가 된다. 실제로 16분 동안 hard-budget
// 30회를 소진했고 그중 27%가 이 알림의 자기메아리였다.
// comment-tools.ts는 `metadata.auto_notice===true`인 적법한 매니저 알림의
// activity actor_id를 system으로 기록해 기존 system-actor 제외 경로를 탄다.
// 아래 테스트는 이 부정 경로를 TriggerLoopService까지 종단간 확인한 다음,
// 일반 코멘트는 여전히 트리거된다는 양성 대조로 테스트의 비공허성을 증명한다.
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
