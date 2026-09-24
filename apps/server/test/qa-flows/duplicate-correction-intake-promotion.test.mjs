// 확정 오탐 링크가 **intake 컬럼에 놓인 채로** 걸렸을 때, 정정이 실제로
// 통하고 그 티켓이 수동 개입 없이 다시 굴러가는지 본다 (ticket 83c5e25c).
//
// 이 결함의 핵심은 "해제 API 가 200 을 주느냐" 가 아니었다. duplicate intake 는
// report 티켓을 intake 컬럼에 둔 채로 링크하는데, 예전 교정 도구는 재dispatch
// 할 role 이 **현재 컬럼에 라우팅돼 있을 것**을 요구했고 intake 는 assignee 를
// 라우팅하지 않는다 — 오링크가 가장 흔히 생기는 바로 그 상태에서 교정이 항상
// 거부됐다. 그래서 여기서는 두 가지를 같이 단언한다:
//
//   1. 링크가 걸린 동안에는 승격이 실제로 막혀 있다 (교착의 재현).
//   2. 정정 후에는 **수동 `tryPromote()` 없이** production 신호만으로 티켓이
//      목적지 컬럼으로 승격되고 assignee 에게 wire 트리거가 간다.
//
// 2번을 DB 직접 갱신이나 수동 승격 호출로 확인하면, 커밋 후 재평가 신호가
// 빠져 있어도(= 최대 5분 멈춤) 테스트는 그대로 통과한다. 그 구멍을 막는 것이
// 이 파일의 존재 이유다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket } from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PORT = process.env.QA_DUPLICATE_INTAKE_PROMOTION_PORT || '0';
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

test('intake 컬럼에 잠긴 확정 오링크를 정정하면 수동 승격 없이 다시 dispatch 된다', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const { ws, board, columns } = await setupKanbanScene(app, modules.getDataSourceToken, {
    workspaceName: 'duplicate-correction-intake', envRepo: true, maxConcurrent: 5,
  });

  const assignee = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'worker' });
  const assigneeKey = await createApiKey(app, modules.getDataSourceToken, assignee.id, { workspaceId: ws.id });
  const operator = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'operator' });
  const operatorKey = await createApiKey(app, modules.getDataSourceToken, operator.id, { workspaceId: ws.id });
  const va = new VirtualAgent({ name: 'worker', agentId: assignee.id, apiKey: assigneeKey.raw_key, port });
  await va.start();
  t.after(async () => va.stop());
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: operatorKey.raw_key });
  t.after(async () => mcp.close());

  // canonical 은 전혀 다른 티켓이고 정정이 건드리면 안 된다. 승격 후보로
  // 끼어들지 않도록 terminal 컬럼에 둔다.
  const canonical = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.done.id, workspaceId: ws.id, title: '무관한 canonical 티켓',
  });
  // report 는 intake 컬럼에 있고 assignee 가 배정돼 있다 — 목적지(In Progress)
  // 의 라우팅 role 이 채워져 있으므로 링크만 없으면 승격 자격이 완전하다.
  const report = await createTicket(app, modules.getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: '실제로는 독립된 결함',
    assigneeId: assignee.id, priority: 'high',
  });
  await ds.getRepository('Ticket').update(report.id, { canonical_ticket_id: canonical.id });

  const { BacklogPromotionService } = await import(
    'file://' + path.join(DIST, 'modules', 'agents', 'backlog-promotion.service.js')
  );
  const promotion = app.get(BacklogPromotionService);

  // (1) 교착 재현 — 링크가 걸려 있는 동안에는 승격 후보 쿼리가
  // `t.canonical_ticket_id IS NULL` 로 이 티켓을 빼므로 승격이 일어나지 않는다.
  // 여기서만 수동 호출을 쓴다: "막혀 있음" 을 증명하려면 승격을 적극적으로
  // 시도해 봐야 하기 때문이다. (2) 의 자동 재개 쪽은 수동 호출을 쓰지 않는다.
  assert.equal(
    await promotion.tryPromote(board.id),
    null,
    '오링크가 걸린 동안에는 승격할 후보가 없다',
  );
  assert.equal(
    (await ds.getRepository('Ticket').findOneByOrFail({ id: report.id })).column_id,
    columns.todo.id,
    '오링크가 걸린 티켓은 intake 에 잠겨 있다',
  );
  assert.equal(va.triggersFor(report.id).length, 0, '잠긴 동안에는 트리거가 가지 않는다');

  // (2) 정정 — intake 는 assignee 를 라우팅하지 않으므로 dispatch 는 건너뛰되
  // 링크 해제 자체는 성공해야 한다. 예전 구현은 여기서 통째로 거부했다.
  const result = await mcp.callTool('correct_confirmed_ticket_duplicate', {
    ticket_id: report.id, role: 'assignee',
  });
  assert.notEqual(result.isError, true, 'intake 컬럼의 오링크도 정정할 수 있어야 한다');
  assert.equal(result.dispatch_skipped_reason, 'role_not_routed_in_current_column');
  assert.equal(result.dispatch_attempted, 0);
  assert.equal(result.dispatch_landed, 0);
  assert.deepEqual(result.dispatch_trigger_ids, []);
  assert.equal(result.previous_canonical_ticket_id, canonical.id);
  assert.equal(
    (await ds.getRepository('Ticket').findOneByOrFail({ id: report.id })).canonical_ticket_id,
    null,
    '링크는 컬럼과 무관하게 해제된다',
  );

  // (3) 자동 재개 — 여기부터 끝까지 수동 `tryPromote()` 호출이 없다. 정정이
  // 커밋 직후 쏜 승격 재평가 신호만으로 BacklogPromotionService 가 티켓을
  // 목적지 컬럼으로 옮기고 assignee 에게 트리거를 발행해야 한다.
  const trigger = await va.waitForTrigger(tr => tr.ticket_id === report.id, 8000);
  assert.equal(trigger.role, 'assignee');
  assert.equal(
    trigger.trigger_source,
    'backlog_promotion',
    '재개 경로는 role 재dispatch 가 아니라 정상 승격이다',
  );
  assert.equal(
    (await ds.getRepository('Ticket').findOneByOrFail({ id: report.id })).column_id,
    columns.inProgress.id,
    '정정된 티켓은 목적지 active 컬럼으로 승격된다',
  );
  assert.equal(
    (await ds.getRepository('Ticket').findOneByOrFail({ id: canonical.id })).column_id,
    columns.done.id,
    'canonical 티켓은 정정에 영향받지 않는다',
  );

  // 감사 흔적 — 왜 dispatch 가 안 갔는지가 티켓에 남아야 한다. 안 남기면
  // "해제됐는데 아무 일도 안 일어났다" 로 보이고 같은 조사를 반복하게 된다.
  const comments = await ds.getRepository('Comment').find({ where: { ticket_id: report.id } });
  const correction = comments.find(c => c.author === 'Duplicate correction');
  assert.ok(correction, '정정 시스템 코멘트가 남는다');
  assert.match(correction.content, /was not re-issued \(role_not_routed_in_current_column\)/);
  const decision = await ds.getRepository('TicketDuplicateDecision').findOneByOrFail({
    report_ticket_id: report.id, outcome: 'corrected_independent',
  });
  assert.equal(decision.candidate_ticket_id, canonical.id);
});

exitAfterTests();
