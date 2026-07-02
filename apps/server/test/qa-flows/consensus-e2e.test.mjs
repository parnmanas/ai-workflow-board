// QA flow: 다중담당자·합의 T7 — 풀 라이프사이클 E2E (DoD 마감).
//
// 기존 커버리지와의 분담:
//   - consensus-gate.test.mjs: 차단→제안→전원 agree→auto-move 해피패스,
//     force 우회, 1홀더 하위호환(무회귀).
//   - consensus-record-agreement.test.mjs: 판정/메타 배선, reporter override,
//     vote 팬아웃 억제. (proposal_id 가 합성 문자열)
//   - 이 파일: DoD 의 **전체 여정** — 2홀더 논의(멘션) → 한쪽 object →
//     재논의 → **실제 재제안(P2)이 이전 표를 stale 리셋** → 전원 agree →
//     서버 auto-move → **다음 phase(Review) 라우팅 홀더(reviewer)에게 트리거
//     팬아웃**까지 실제 Nest 앱 + MCP + SSE 로 관통 검증.
//
// 검증하는 계약 문구(프롬프트 템플릿 ↔ 구현 동기화, T7):
//   - 직접 move_ticket 거부 에러에 'consensus_required' 리터럴 포함.
//   - 재제안 시 이전 제안에 대한 object/agree 는 pending 으로 리셋.
//   - auto-move 의 moved 활동이 다음 컬럼 라우팅 role 트리거를 정상 발화.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgentTrio,
  createAgent,
  createApiKey,
  createTicket,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

const BASE_PORT = parseInt(process.env.QA_CONSENSUS_E2E_PORT || '7881', 10);
process.env.PORT = String(BASE_PORT);

/** consensus-gate/record-agreement 와 동일한 두 번째 assignee 홀더 픽스처.
 *  createTicket 이 첫 홀더를 holder_key='' 로 심으므로 두 번째는
 *  holder_key='agent:<id>' 로 유니크 인덱스를 회피한다. */
async function addAssigneeHolder(app, getDataSourceToken, { ticketId, workspaceId, agentId }) {
  const ds = app.get(getDataSourceToken());
  const role = await ds.getRepository('WorkspaceRole').findOne({
    where: { workspace_id: workspaceId, slug: 'assignee' },
  });
  assert.ok(role, 'assignee WorkspaceRole must exist');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  await assignRepo.save(assignRepo.create({
    ticket_id: ticketId,
    role_id: role.id,
    agent_id: agentId,
    user_id: null,
    holder_key: `agent:${agentId}`,
  }));
}

async function mcpFor(port, apiKey) {
  const c = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey });
  await c.initialize();
  return c;
}

async function columnIdOf(app, getDataSourceToken, ticketId) {
  const ds = app.get(getDataSourceToken());
  const t = await ds.getRepository('Ticket').findOne({ where: { id: ticketId } });
  return t?.column_id;
}

test('E2E: 2홀더 논의→object→재제안(표 리셋)→전원 agree→auto-move→다음 phase 트리거', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  step('씬: In Progress(→assignee) 에 A+B 공동 assignee, reviewer 지정');
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'consensus-e2e' });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const holderB = { agent: await createAgent(app, getDataSourceToken, ws.id, { name: 'assignee-b' }) };
  holderB.key = await createApiKey(app, getDataSourceToken, holderB.agent.id, {
    workspaceId: ws.id, label: 'assignee-b',
  });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'consensus-e2e-journey',
    assigneeId: trio.assignee.agent.id,
    reporterId: trio.reporter.agent.id,
    reviewerId: trio.reviewer.agent.id,
  });
  await addAssigneeHolder(app, getDataSourceToken, {
    ticketId: ticket.id, workspaceId: ws.id, agentId: holderB.agent.id,
  });

  const a = await mcpFor(port, trio.assignee.key.raw_key);
  const b = await mcpFor(port, holderB.key.raw_key);
  t.after(() => { void a.close(); void b.close(); });

  // SSE 관찰자: B(논의 멘션 수신), reviewer(다음 phase 트리거 수신).
  const agentB = new VirtualAgent({
    name: 'assignee-b', agentId: holderB.agent.id, apiKey: holderB.key.raw_key, port,
  });
  const reviewer = new VirtualAgent({
    name: 'reviewer', agentId: trio.reviewer.agent.id, apiKey: trio.reviewer.key.raw_key, port,
  });
  await Promise.all([agentB.start(), reviewer.start()]);
  t.after(() => { agentB.stop(); reviewer.stop(); });
  await new Promise((r) => setTimeout(r, 200));

  step('논의: A 가 공동 홀더 B 를 멘션 → B 에게 comment_mention 도착');
  const discuss = await a.callTool('add_comment', {
    ticket_id: ticket.id,
    content: `Review 로 넘길 준비가 된 것 같습니다 — 의견 주세요 @[agent:${holderB.agent.id}|assignee-b]`,
  });
  assert.ok(!discuss.isError, `논의 코멘트 실패: ${JSON.stringify(discuss)}`);
  await agentB.waitForMention((m) => m.ticket_id === ticket.id, 5000);

  step('A propose_move(P1 → Review) → B record_agreement(object) → 미성립');
  const p1 = await a.callTool('propose_move', { ticket_id: ticket.id, target_column_id: columns.review.id });
  assert.ok(!p1.isError, `P1 제안 실패: ${JSON.stringify(p1)}`);
  const rObj = await b.callTool('record_agreement', {
    ticket_id: ticket.id, status: 'object', content: '테스트 커버리지가 아직 부족합니다',
  });
  assert.ok(!rObj.isError, `B object 실패: ${JSON.stringify(rObj)}`);
  assert.equal(rObj.consensus.satisfied, false);
  assert.equal(rObj.consensus.objected.length, 1, 'B 의 이의가 집계되어야 함');

  step('이의 상태에서 직접 move_ticket → consensus_required 리터럴로 거부');
  const blocked = await a.callTool('move_ticket', { ticket_id: ticket.id, target_column_id: columns.review.id });
  assert.equal(blocked.isError, true, '이의 존재 → 직접 이동 차단');
  assert.match(blocked.error?.error || '', /consensus_required/,
    '차단 에러는 프롬프트 템플릿이 약속한 consensus_required 리터럴을 포함해야 함');
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.inProgress.id, '티켓은 그대로');

  step('재논의 후 A 재제안(P2) → 새 앵커, B 의 이전 object 는 stale → pending 리셋');
  const rediscuss = await a.callTool('add_comment', {
    ticket_id: ticket.id,
    content: '커버리지 보강 커밋을 올렸습니다 — 재제안합니다.',
  });
  assert.ok(!rediscuss.isError);
  const p2 = await a.callTool('propose_move', { ticket_id: ticket.id, target_column_id: columns.review.id });
  assert.ok(!p2.isError, `P2 재제안 실패: ${JSON.stringify(p2)}`);
  assert.notEqual(p2.proposal_id, p1.proposal_id, '재제안은 새 proposal id');
  assert.equal(p2.consensus.proposalId, p2.proposal_id, '판정 앵커가 P2 로 이동');
  assert.equal(p2.consensus.objected.length, 0, 'P1 에 대한 object 는 P2 기준 stale');
  assert.equal(p2.consensus.pending.length, 2, '표 리셋 — A·B 모두 다시 pending');

  step('A agree → B agree(P2) → 전원 승인 순간 서버 auto-move → Review');
  const rA = await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(!rA.isError);
  assert.equal(rA.consensus.proposalId, p2.proposal_id, 'proposal_id 생략 → 최신 열린 제안(P2) 앵커');
  assert.equal(rA.moved, null, '아직 B 미승인 → 이동 없음');
  const rB = await b.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree' });
  assert.ok(!rB.isError);
  assert.equal(rB.consensus.satisfied, true, 'B 의 최신 agree 가 이전 object 를 대체(최신 시그널 우선)');
  assert.ok(rB.moved, '합의 성립 순간 auto-move');
  assert.equal(rB.moved.proposal_id, p2.proposal_id, 'P2 가 실행됨(소진)');
  assert.equal(rB.moved.to_column_id, columns.review.id);
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.review.id, '실제 컬럼 = Review');

  step('다음 phase 진입: Review 라우팅 홀더(reviewer)에게 agent_trigger 팬아웃');
  await reviewer.waitForTrigger((tr) => tr.ticket_id === ticket.id, 8000);
  assert.ok(reviewer.triggersFor(ticket.id).length >= 1, 'auto-move 가 다음 컬럼 role 트리거를 발화해야 함');

  step('감사: consensus_move(마지막 승인자 표기) + moved(→Review, trigger_source=consensus_auto)');
  const ds = app.get(getDataSourceToken());
  const acts = await ds.getRepository('ActivityLog').find({ where: { entity_id: ticket.id } });
  const cm = acts.find((x) => x.field_changed === 'consensus_move');
  assert.ok(cm, 'consensus_move 감사 활동 존재');
  assert.equal(cm.actor_name, 'Consensus', 'auto-move 액터는 Consensus');
  const moved = acts.find((x) => x.action === 'moved' && x.new_value === 'Review');
  assert.ok(moved, 'moved(→Review) 활동 존재');
  assert.equal(moved.trigger_source, 'consensus_auto', 'moved 는 합의 자동실행으로 표기');

  exitAfterTests(0);
});
