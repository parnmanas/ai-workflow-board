import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket } from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PORT = process.env.QA_DUPLICATE_CORRECTION_PORT || '0';
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

async function waitForNoWire() {
  await new Promise(resolve => setTimeout(resolve, 700));
}

test('MCP duplicate correction emits exactly one selected-role wire trigger and preserves canonical', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const { ws, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'duplicate-correction-wire', envRepo: true, maxConcurrent: 5,
  });
  const assignee = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'worker' });
  const assigneeKey = await createApiKey(app, modules.getDataSourceToken, assignee.id, { workspaceId: ws.id });
  const operator = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'operator' });
  const operatorKey = await createApiKey(app, modules.getDataSourceToken, operator.id, { workspaceId: ws.id });
  const reviewer = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'reviewer' });
  const reviewerKey = await createApiKey(app, modules.getDataSourceToken, reviewer.id, { workspaceId: ws.id });
  const va = new VirtualAgent({ name: 'worker', agentId: assignee.id, apiKey: assigneeKey.raw_key, port });
  const reviewerVa = new VirtualAgent({ name: 'reviewer', agentId: reviewer.id, apiKey: reviewerKey.raw_key, port });
  await va.start();
  await reviewerVa.start();
  t.after(async () => va.stop());
  t.after(async () => reviewerVa.stop());
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: operatorKey.raw_key });
  t.after(async () => mcp.close());

  const canonical = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.done.id, workspaceId: ws.id, title: 'unrelated done ticket',
  });
  const report = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'independent operation', assigneeId: assignee.id,
  });
  await ds.getRepository('Ticket').update(report.id, { canonical_ticket_id: canonical.id });
  await ds.getRepository('DispatchIntent').save({
    workspace_id: ws.id, board_id: columns.inProgress.board_id, ticket_id: report.id,
    role: 'assignee', agent_id: assignee.id, trigger_source: 'old', status: 'in_flight',
    attempts: 209, dispatch_generation: 209, next_attempt_at: new Date(),
  });

  const result = await mcp.callTool('correct_confirmed_ticket_duplicate', {
    ticket_id: report.id, role: 'assignee',
  });
  assert.equal(result.dispatch_attempted, 1);
  assert.equal(result.dispatch_landed, 1);
  assert.equal(result.dispatch_trigger_ids.length, 1);
  const trigger = await va.waitForTrigger(tr => tr.ticket_id === report.id, 4000);
  assert.equal(trigger.role, 'assignee');
  assert.equal(va.triggers.filter(tr => tr.ticket_id === report.id).length, 1);
  const intent = await ds.getRepository('DispatchIntent').findOneByOrFail({
    ticket_id: report.id, role: 'assignee', status: 'in_flight',
  });
  assert.equal(intent.last_trigger_id, trigger.trigger_id);
  assert.equal(intent.dispatch_generation, 1);
  assert.equal(result.dispatch_generation, 1);
  const { DispatchIntentService } = await import(
    'file://' + path.join(DIST, 'modules', 'agents', 'dispatch-intent.service.js')
  );
  const ack = await app.get(DispatchIntentService).applyManagerAck({
    ticketId: report.id, role: 'assignee', triggerId: trigger.trigger_id, outcome: 'processed',
  });
  assert.equal(ack.matched, true);
  assert.equal(ack.applied, true);
  assert.equal((await ds.getRepository('DispatchIntent').findOneByOrFail({ id: intent.id })).last_ack_kind, 'processed');
  assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: canonical.id })).title, 'unrelated done ticket');
  assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: canonical.id })).column_id, columns.done.id);

  const seedCorrection = async ({ title, columnId = columns.inProgress.id, assigneeId = assignee.id, reviewerId = '' }) => {
    const ticket = await createTicket(app, modules.getDataSourceToken, {
      columnId, workspaceId: ws.id, title, assigneeId, reviewerId,
    });
    await ds.getRepository('Ticket').update(ticket.id, { canonical_ticket_id: canonical.id });
    await ds.getRepository('DispatchIntent').save({
      workspace_id: ws.id, board_id: columns.inProgress.board_id, ticket_id: ticket.id,
      role: 'assignee', agent_id: assigneeId, trigger_source: 'old', status: 'in_flight',
      attempts: 209, dispatch_generation: 209, next_attempt_at: new Date(),
    });
    return ticket;
  };

  const { TriggerLoopService } = await import(
    'file://' + path.join(DIST, 'modules', 'agents', 'trigger-loop.service.js')
  );
  const triggerLoop = app.get(TriggerLoopService);
  const live = await seedCorrection({ title: 'live strand correction' });
  await triggerLoop.agentStatus.setCurrentTask(assignee.id, live.id, 'assignee', 'live-correction');
  const beforeLiveTriggers = va.triggers.length;
  const liveResult = await mcp.callTool('correct_confirmed_ticket_duplicate', { ticket_id: live.id, role: 'assignee' });
  await waitForNoWire();
  assert.equal(liveResult.dispatch_attempted, 1);
  assert.equal(liveResult.dispatch_landed, 0);
  assert.equal(va.triggers.length, beforeLiveTriggers, 'live strand must suppress the wire payload');
  const liveIntents = await ds.getRepository('DispatchIntent').find({
    where: { ticket_id: live.id, role: 'assignee' },
  });
  const liveOpenIntents = liveIntents.filter(row => ['pending', 'in_flight'].includes(row.status));
  assert.equal(liveOpenIntents.length, 1, 'live strand keeps exactly one fresh open intent');
  assert.equal(liveOpenIntents[0].dispatch_generation, 1);
  triggerLoop.agentStatus.clearCurrentTask(assignee.id, live.id, 'live-correction');

  // The suppressed correction dispatch above is now queued for replay too
  // (ticket d35b8ac8: every in-flight-strand drop is queued, not just
  // one-shot transition sources) — wait for that auto-replay to land as its
  // own accounted step. Otherwise it can arrive asynchronously during one of
  // the unrelated-ticket assertions below and pollute the GLOBAL va.triggers
  // count they diff against.
  const liveReplay = await va.waitForTrigger(tr => tr.ticket_id === live.id, 4000);
  assert.equal(
    liveReplay.trigger_source,
    'inflight_strand_replay',
    'the suppressed correction dispatch auto-replays once the strand frees (ticket d35b8ac8)',
  );

  // 재dispatch 불가 상태 — 예전에는 전부 throw 였다(ticket 83c5e25c). 이제
  // 링크 해제는 컬럼과 무관하게 항상 수행되고 dispatch 만 건너뛴다. 해제를
  // 거부하면 intake 컬럼에 놓인 오링크를 영원히 못 고친다는 것이 그 결함의
  // 핵심이었으므로, 여기서는 "해제됐다 + 아무도 깨우지 않았다" 를 함께 본다.
  const assertUnlinkedWithoutDispatch = async (ticket, label, expectedReason) => {
    const before = va.triggers.length;
    const result = await mcp.callTool('correct_confirmed_ticket_duplicate', { ticket_id: ticket.id, role: 'assignee' });
    assert.notEqual(result.isError, true, `${label} 은 해제까지는 성공해야 한다`);
    assert.equal(result.dispatch_skipped_reason, expectedReason, `${label} 의 건너뜀 사유`);
    assert.equal(result.dispatch_attempted, 0, `${label} 은 dispatch 를 시도하지 않는다`);
    assert.equal(result.dispatch_landed, 0);
    assert.deepEqual(result.dispatch_trigger_ids, []);
    assert.equal(result.dispatch_intent_id, null);
    await waitForNoWire();
    assert.equal(va.triggers.length, before, `${label} 은 wire payload 를 내지 않는다`);
    assert.equal(
      (await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id })).canonical_ticket_id,
      null,
      `${label} 도 오링크는 해제된다`,
    );
    const intents = await ds.getRepository('DispatchIntent').find({ where: { ticket_id: ticket.id } });
    assert.equal(intents.length, 1, `${label} 은 새 intent 를 만들지 않는다`);
    assert.equal(intents[0].status, 'resolved', `${label} 은 stale intent 를 종료한다`);
    assert.equal(intents[0].last_reason, 'superseded_by_duplicate_correction');
    assert.equal(intents[0].dispatch_generation, 209, `${label} 은 stale 행의 generation 을 건드리지 않는다`);
  };
  await assertUnlinkedWithoutDispatch(
    await seedCorrection({ title: 'unassigned correction', assigneeId: '' }),
    'unassigned ticket',
    'role_has_no_holder',
  );
  await assertUnlinkedWithoutDispatch(
    await seedCorrection({ title: 'terminal correction', columnId: columns.done.id }),
    'terminal column',
    'terminal_column',
  );
  // Blocked 컬럼은 active 이지만 reporter 만 라우팅한다 — intake 가 아닌
  // 비라우팅 컬럼. intake 케이스(승격으로 자동 재개되는 쪽)는 별도 flow
  // `duplicate-correction-intake-promotion.test.mjs` 가 본다.
  await assertUnlinkedWithoutDispatch(
    await seedCorrection({ title: 'non-routed correction', columnId: columns.blocked.id }),
    'non-routed column',
    'role_not_routed_in_current_column',
  );
  // pending 4종은 `_emitTrigger` 가 전부 드롭한다. 예전 게이트는 그 중 2종만
  // 봐서 pending_ci_wait 인 티켓에 intent 만 열고 트리거는 드롭되는 유령 행이
  // 생길 수 있었다.
  const pendingCorrection = await seedCorrection({ title: 'pending correction' });
  await ds.getRepository('Ticket').update(pendingCorrection.id, { pending_ci_wait: true });
  await assertUnlinkedWithoutDispatch(pendingCorrection, 'pending ticket', 'ticket_pending');

  await ds.getRepository('BoardColumn').update(columns.inProgress.id, {
    role_routing: JSON.stringify(['assignee', 'reviewer']),
  });
  const multiRouted = await seedCorrection({
    title: 'selected role correction', reviewerId: reviewer.id,
  });
  const beforeReviewerTriggers = reviewerVa.triggers.length;
  const selectedResult = await mcp.callTool('correct_confirmed_ticket_duplicate', {
    ticket_id: multiRouted.id, role: 'assignee',
  });
  assert.equal(selectedResult.dispatch_landed, 1);
  await va.waitForTrigger(tr => tr.ticket_id === multiRouted.id, 4000);
  await waitForNoWire();
  assert.equal(reviewerVa.triggers.length, beforeReviewerTriggers, 'non-selected routed role must not emit');
  assert.equal(await ds.getRepository('DispatchIntent').count({
    where: { ticket_id: multiRouted.id, role: 'reviewer' },
  }), 0, 'non-selected routed role must not open an intent');

  // MCP와 reconciler의 경쟁을 결정적으로 재현한다. 정정 트랜잭션이 선점한 intent를
  // 커밋한 뒤 wire emit 직전에 직접 경로를 멈추고, 첫 소유자의 lease가 유효한
  // 상태에서 재시도 시각을 넘겨 reconciler sweep을 실행한다.
  const racing = await seedCorrection({ title: 'atomic first-dispatch ownership' });
  const originalEmit = triggerLoop.emitAgentTrigger.bind(triggerLoop);
  let releaseEmit;
  const emitBarrier = new Promise(resolve => { releaseEmit = resolve; });
  let reachedBarrier;
  const barrierReached = new Promise(resolve => { reachedBarrier = resolve; });
  triggerLoop.emitAgentTrigger = async (...args) => {
    if (args[0]?.id === racing.id) {
      reachedBarrier();
      await emitBarrier;
    }
    return originalEmit(...args);
  };
  const racingCall = mcp.callTool('correct_confirmed_ticket_duplicate', {
    ticket_id: racing.id, role: 'assignee',
  });
  await barrierReached;
  const claimed = await ds.getRepository('DispatchIntent').findOneByOrFail({
    ticket_id: racing.id, role: 'assignee', status: 'in_flight',
  });
  assert.equal(claimed.dispatch_generation, 1);
  assert.match(claimed.lease_owner, /^duplicate-correction:/);
  const { DispatchReconcilerService } = await import(
    'file://' + path.join(DIST, 'modules', 'agents', 'dispatch-reconciler.service.js')
  );
  const reconciler = app.get(DispatchReconcilerService);
  await reconciler.reconcile(new Date(new Date(claimed.next_attempt_at).getTime() + 1));
  releaseEmit();
  const racingResult = await racingCall;
  triggerLoop.emitAgentTrigger = originalEmit;
  const racingTrigger = await va.waitForTrigger(tr => tr.ticket_id === racing.id, 4000);
  assert.equal(va.triggers.filter(tr => tr.ticket_id === racing.id).length, 1);
  assert.equal(racingResult.dispatch_generation, 1);
  assert.deepEqual(racingResult.dispatch_trigger_ids, [racingTrigger.trigger_id]);
  const racedIntent = await ds.getRepository('DispatchIntent').findOneByOrFail({ id: claimed.id });
  assert.equal(racedIntent.dispatch_generation, 1);
  assert.equal(racedIntent.last_trigger_id, racingTrigger.trigger_id);
  const racedAck = await app.get(DispatchIntentService).applyManagerAck({
    ticketId: racing.id, role: 'assignee', triggerId: racingTrigger.trigger_id, outcome: 'processed',
  });
  assert.equal(racedAck.matched, true);
  assert.equal(racedAck.applied, true);
});

exitAfterTests();
