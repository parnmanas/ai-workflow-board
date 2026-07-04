// QA flow: 다중담당자·합의 T5 — 이동 게이트 + propose_move + 합의성립 auto-execute.
//
// 순수 판정/브릿지 로직은 consensus-state.test.mjs 가 단위로 커버한다. 이 통합
// 테스트는 T5 의 **핵심 동작**이 실제 Nest 앱 + DB + MCP 위에서 맞물리는지 검증한다:
//   - 홀더 ≥2 컬럼에서 직접 move_ticket 은 합의 미성립 시 차단된다(누가 pending).
//   - propose_move 가 제안을 열고(제안 comment id === proposal_id), 전 홀더가
//     record_agreement(agree) 하면 마지막 승인 순간 서버가 자동으로 이동시킨다.
//   - 소진(실행)된 제안의 표는 다음 멀티홀더 컬럼의 게이트를 만족시키지 못한다
//     (T7 리뷰 회귀 — 게이트 앵커는 열린 제안, phase 마다 새 합의).
//   - force / reporter override 는 게이트를 우회한다.
//   - 보드 간 이동(move_ticket_to_board)도 컬럼 이탈이므로 같은 게이트를 탄다
//     (ticket bd6d58db 이슈#1 — 우회 경로 봉쇄, force 로만 우회).
//   - 제안 없이 던진 null-agree 표는 ≥2홀더 게이트를 열지 못한다(ticket bd6d58db
//     이슈#2 — 소진되지 않는 null 앵커의 컬럼 간 지속성 우회 봉쇄).
//   - 홀더 ≤1 은 무회귀: 직접 move_ticket 이 그대로 작동하고 propose_move 는 안내.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgentTrio,
  createAgent,
  createApiKey,
  createTicket,
  createBoard,
  createColumn,
  addRoleHolder,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

const BASE_PORT = parseInt(process.env.QA_CONSENSUS_GATE_PORT || '7871', 10);
process.env.PORT = String(BASE_PORT);

async function mcpFor(port, apiKey) {
  const c = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey });
  await c.initialize();
  return c;
}

/** 두 assignee 홀더(A+B) + reporter 를 가진 In Progress 티켓 씬. */
async function twoHolderScene(app, getDataSourceToken, name) {
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: name });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const holderB = { agent: await createAgent(app, getDataSourceToken, ws.id, { name: 'assignee-b' }) };
  holderB.key = await createApiKey(app, getDataSourceToken, holderB.agent.id, {
    workspaceId: ws.id, label: 'assignee-b',
  });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, // In Progress → ['assignee']
    workspaceId: ws.id,
    title: 'consensus-gate-t5',
    assigneeId: trio.assignee.agent.id,
    reporterId: trio.reporter.agent.id,
  });
  await addRoleHolder(app, getDataSourceToken, {
    ticketId: ticket.id, workspaceId: ws.id, agentId: holderB.agent.id,
  });
  return { ws, columns, trio, holderB, ticket };
}

async function columnIdOf(app, getDataSourceToken, ticketId) {
  const ds = app.get(getDataSourceToken());
  const t = await ds.getRepository('Ticket').findOne({ where: { id: ticketId } });
  return t?.column_id;
}

test('T5 핵심: 2홀더 직접이동 차단 → propose_move → 전원 승인 순간 자동 이동', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { columns, trio, holderB, ticket } = await twoHolderScene(app, getDataSourceToken, 'consensus-gate-a');
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  const b = await mcpFor(port, holderB.key.raw_key);
  t.after(() => { void a.close(); void b.close(); });

  step('홀더 A 가 직접 move_ticket → 차단(홀더 2 · 합의 미성립, 누가 pending 명시)');
  const blocked = await a.callTool('move_ticket', { ticket_id: ticket.id, target_column_id: columns.review.id });
  assert.equal(blocked.isError, true, '2홀더 컬럼의 직접 이동은 차단되어야 함');
  assert.match(blocked.error?.error || '', /합의 필요/, '차단 메시지는 합의 필요를 알려야 함');
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.inProgress.id, '차단 → 티켓은 그대로');

  step('propose_move(→ Review) → 제안 오픈(proposal_id=제안 comment id, 미성립·pending 2)');
  const prop = await a.callTool('propose_move', { ticket_id: ticket.id, target_column_id: columns.review.id });
  assert.ok(!prop.isError, `propose_move 실패: ${JSON.stringify(prop)}`);
  assert.ok(prop.proposal_id, '제안 id 반환');
  assert.equal(prop.target_column.id, columns.review.id);
  assert.equal(prop.consensus.satisfied, false);
  assert.equal(prop.consensus.required.length, 2);
  assert.equal(prop.consensus.pending.length, 2, '아직 아무도 투표 안 함 → A·B 둘 다 pending');

  step('A record_agreement(agree) [proposal_id 생략 → 열린 제안 자동 앵커] → 미성립·미이동');
  const rA = await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(!rA.isError, `A agree 실패: ${JSON.stringify(rA)}`);
  assert.equal(rA.consensus.proposalId, prop.proposal_id, '생략 시 열린 제안이 앵커');
  assert.equal(rA.consensus.agreed.length, 1);
  assert.equal(rA.consensus.satisfied, false);
  assert.equal(rA.moved, null, '전원 미승인 → 이동 없음');
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.inProgress.id, '아직 In Progress');

  step('B record_agreement(agree) → 전원 승인 → 서버 auto-execute → Review 로 자동 이동');
  const rB = await b.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(!rB.isError, `B agree 실패: ${JSON.stringify(rB)}`);
  assert.equal(rB.consensus.satisfied, true);
  assert.equal(rB.consensus.agreed.length, 2);
  assert.ok(rB.moved, '합의 성립 순간 moved 가 채워져야 함');
  assert.equal(rB.moved.to_column_id, columns.review.id, 'Review 로 자동 이동');
  assert.equal(rB.moved.proposal_id, prop.proposal_id);
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.review.id, '실제 티켓 컬럼이 Review');

  step('감사: consensus_move 활동 로그가 남는다(system 액터)');
  const ds = app.get(getDataSourceToken());
  const acts = await ds.getRepository('ActivityLog').find({ where: { entity_id: ticket.id } });
  assert.ok(acts.some((x) => x.field_changed === 'consensus_move'), 'consensus_move 감사 활동 존재');
  assert.ok(acts.some((x) => x.action === 'moved' && x.new_value === 'Review'), 'moved 활동(→Review) 존재');

  step('멱등: 소진된 제안에는 다시 auto-execute 하지 않는다(중복 이동 방지)');
  const rAgain = await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.equal(rAgain.moved, null, '이미 실행된 제안 → 재이동 없음');
});

test('회귀(T7 리뷰): 소진된 제안의 표는 다음 멀티홀더 컬럼 게이트를 만족시키지 못한다', async (t) => {
  // 시나리오: In Progress(assignee A+B) 합의 성립 → auto-move → Review 도 같은
  // 역할(assignee) 라우팅(2연속 멀티홀더 phase). 게이트 앵커를 "최신 vote 가 참조한
  // 제안"으로 잡으면 실행(소진)된 P1 의 표가 Review 이탈 게이트까지 만족시켜 —
  // 새 제안 전까지 무게이트 통과, 합의가 티켓당 사실상 1회로 붕괴한다. 게이트는
  // 열린 제안(없으면 null) 앵커로만 판정해야 한다.
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 3 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { columns, trio, holderB, ticket } = await twoHolderScene(app, getDataSourceToken, 'consensus-gate-d');
  // 다음 phase(Review)도 assignee 라우팅으로 바꿔 같은 두 홀더가 다시 게이트 대상이 되게 한다.
  {
    const ds = app.get(getDataSourceToken());
    await ds.getRepository('BoardColumn').update(columns.review.id, { role_routing: JSON.stringify(['assignee']) });
  }
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  const b = await mcpFor(port, holderB.key.raw_key);
  t.after(() => { void a.close(); void b.close(); });

  step('phase 1: 제안 P1 → 전원 agree → auto-move → Review');
  const p1 = await a.callTool('propose_move', { ticket_id: ticket.id, target_column_id: columns.review.id });
  assert.ok(!p1.isError, `P1 제안 실패: ${JSON.stringify(p1)}`);
  const rA1 = await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(!rA1.isError, `A agree 실패: ${JSON.stringify(rA1)}`);
  const rB1 = await b.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(rB1.moved, 'P1 합의 성립 → auto-move');
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.review.id, '티켓이 Review 진입');

  step('phase 2(회귀 핵심): 소진된 P1 의 표로는 Review 이탈 직접 이동이 열리지 않는다');
  const blocked = await a.callTool('move_ticket', { ticket_id: ticket.id, target_column_id: columns.done.id });
  assert.equal(blocked.isError, true, '소진된 제안의 표가 다음 컬럼 게이트를 만족시키면 안 됨');
  assert.match(blocked.error?.error || '', /consensus_required/, '재차 consensus_required 로 차단');
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.review.id, '차단 → 티켓은 Review 그대로');

  step('phase 2 ceremony: 새 제안 P2 → 전원 agree → 재차 auto-move(phase 당 합의)');
  const p2 = await a.callTool('propose_move', { ticket_id: ticket.id, target_column_id: columns.done.id });
  assert.ok(!p2.isError, `P2 제안 실패: ${JSON.stringify(p2)}`);
  assert.notEqual(p2.proposal_id, p1.proposal_id, '새 phase 는 새 proposal');
  assert.equal(p2.consensus.pending.length, 2, 'P1 의 표는 P2 기준 stale — 표 리셋');
  const rA2 = await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(!rA2.isError);
  const rB2 = await b.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(rB2.moved, 'P2 합의 성립 → 재차 auto-move');
  assert.equal(rB2.moved.to_column_id, columns.done.id);
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.done.id, '두 번째 phase 도 합의로만 통과');
});

test('이슈#1: 보드 간 이동(move_ticket_to_board)도 컬럼 이탈이라 같은 게이트를 탄다 (ticket bd6d58db)', async (t) => {
  // move_ticket / REST /move 는 게이트를 타지만 보드 간 이동은 예외였다 — 멀티홀더
  // 티켓을 다른 보드로 옮기는 방식의 우회 경로. 소스 컬럼(In Progress → assignee 2홀더)
  // 라우팅으로 판정하므로 목적지 보드/컬럼 라우팅과 무관하게 차단되어야 한다.
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 4 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws, columns, trio, ticket } = await twoHolderScene(app, getDataSourceToken, 'consensus-gate-e');
  // 같은 워크스페이스의 두 번째 보드 + 목적지 컬럼.
  const board2 = await createBoard(app, getDataSourceToken, ws.id, { name: 'consensus-gate-e-dest' });
  const destCol = await createColumn(app, getDataSourceToken, board2.id, {
    name: 'Inbox', position: 0, workspaceId: ws.id,
  });
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  t.after(() => { void a.close(); });

  step('2홀더 티켓을 다른 보드로 이동 시도 → 소스 컬럼 게이트로 차단(우회 봉쇄)');
  const blocked = await a.callTool('move_ticket_to_board', {
    ticket_id: ticket.id, target_board_id: board2.id, target_column_id: destCol.id,
  });
  assert.equal(blocked.isError, true, '보드 간 이동도 합의 미성립 시 차단되어야 함');
  assert.match(blocked.error?.error || '', /consensus_required/, '차단 메시지는 consensus_required 를 포함');
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.inProgress.id, '차단 → 티켓은 원 보드/컬럼 그대로');

  step('force=true → 게이트 우회하여 보드 간 이동');
  const forced = await a.callTool('move_ticket_to_board', {
    ticket_id: ticket.id, target_board_id: board2.id, target_column_id: destCol.id, force: true,
  });
  assert.ok(!forced.isError, `force 보드이동 실패: ${JSON.stringify(forced)}`);
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), destCol.id, 'force → 다른 보드 컬럼으로 이동됨');
});

test('이슈#2: 제안 없이 던진 null-agree 표는 ≥2홀더 게이트를 열지 못한다 (ticket bd6d58db)', async (t) => {
  // 열린 제안 없이 record_agreement 하면 proposal_id=null 표가 저장된다. 전 홀더가
  // null-agree 하면 순수 판정으로는 satisfied 이지만, 이 null 표는 (제안과 달리)
  // 소진 메커니즘이 없어 게이트가 인정하면 다음 컬럼에서도 계속 열린다. 게이트는
  // 열린 제안 앵커의 합의로만 통과해야 한다(null 앵커 satisfied 는 blocked 유지).
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 5 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { columns, trio, holderB, ticket } = await twoHolderScene(app, getDataSourceToken, 'consensus-gate-f');
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  const b = await mcpFor(port, holderB.key.raw_key);
  t.after(() => { void a.close(); void b.close(); });

  step('열린 제안 없이 전 홀더가 record_agreement(agree) → null-앵커 표만 저장(이동 없음)');
  const rA = await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(!rA.isError, `A null-agree 실패: ${JSON.stringify(rA)}`);
  assert.equal(rA.consensus.proposalId, null, '열린 제안 없음 → 앵커는 null');
  assert.equal(rA.moved, null, '제안이 없으니 auto-move 없음');
  const rB = await b.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(!rB.isError, `B null-agree 실패: ${JSON.stringify(rB)}`);
  // 순수 판정상 null 앵커 전원 agree → satisfied=true. 게이트가 이를 인정하면 우회.
  assert.equal(rB.consensus.satisfied, true, 'null 앵커 전원 agree → 판정상 satisfied');
  assert.equal(rB.moved, null, '열린 제안이 없으니 여전히 이동 없음');

  step('회귀 핵심: null-앵커 satisfied 로는 직접 move_ticket 게이트가 열리지 않는다');
  const blocked = await a.callTool('move_ticket', { ticket_id: ticket.id, target_column_id: columns.review.id });
  assert.equal(blocked.isError, true, 'null-표 satisfied 는 게이트를 통과시키면 안 됨(지속성 우회 봉쇄)');
  assert.match(blocked.error?.error || '', /합의 필요|consensus_required/, 'consensus_required 로 차단');
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.inProgress.id, '차단 → 티켓은 In Progress 그대로');

  step('무회귀: 정상 ceremony(propose_move + 전원 agree)로는 그대로 통과');
  const prop = await a.callTool('propose_move', { ticket_id: ticket.id, target_column_id: columns.review.id });
  assert.ok(!prop.isError, `propose_move 실패: ${JSON.stringify(prop)}`);
  const cA = await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(!cA.isError, `ceremony A agree 실패: ${JSON.stringify(cA)}`);
  const cB = await b.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(cB.moved, '열린 제안 앵커로는 전원 agree 시 auto-move');
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.review.id, 'ceremony 로는 정상 이동');
});

test('force / reporter override 는 게이트를 우회한다', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 1 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { columns, trio, ticket } = await twoHolderScene(app, getDataSourceToken, 'consensus-gate-b');
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  t.after(() => { void a.close(); });

  step('force=true 직접 이동 → 게이트 우회하여 이동');
  const forced = await a.callTool('move_ticket', {
    ticket_id: ticket.id, target_column_id: columns.review.id, force: true,
  });
  assert.ok(!forced.isError, `force 이동 실패: ${JSON.stringify(forced)}`);
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.review.id, 'force → 이동됨');
});

test('홀더 ≤1 무회귀: 직접 move_ticket 작동 + propose_move 는 안내', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 2 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'consensus-gate-c' });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'single-holder',
    assigneeId: trio.assignee.agent.id, reporterId: trio.reporter.agent.id,
  });
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  t.after(() => { void a.close(); });

  step('단일 홀더 → 직접 move_ticket 이 게이트 없이 그대로 작동');
  const moved = await a.callTool('move_ticket', { ticket_id: ticket.id, target_column_id: columns.review.id });
  assert.ok(!moved.isError, `단일홀더 이동 실패: ${JSON.stringify(moved)}`);
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.review.id, '게이트 미발동 → 이동됨');

  step('단일 홀더 컬럼에서 propose_move → ceremony 불필요 안내(err)');
  // Review → ['reviewer'] 1홀더. reviewer 키로 Done 이동 제안 시도.
  const rev = await mcpFor(port, trio.reviewer.key.raw_key);
  t.after(() => { void rev.close(); });
  const propErr = await rev.callTool('propose_move', { ticket_id: ticket.id, target_column_id: columns.done.id });
  assert.equal(propErr.isError, true, '홀더 ≤1 이면 propose_move 는 거절');
  assert.match(propErr.error?.error || '', /move_ticket/, 'move_ticket 직접 사용을 안내');

  exitAfterTests(0);
});
