// QA flow: 다중담당자·합의 T5 — 이동 게이트 + propose_move + 합의성립 auto-execute.
//
// 순수 판정/브릿지 로직은 consensus-state.test.mjs 가 단위로 커버한다. 이 통합
// 테스트는 T5 의 **핵심 동작**이 실제 Nest 앱 + DB + MCP 위에서 맞물리는지 검증한다:
//   - 홀더 ≥2 컬럼에서 직접 move_ticket 은 합의 미성립 시 차단된다(누가 pending).
//   - propose_move 가 제안을 열고(제안 comment id === proposal_id), 전 홀더가
//     record_agreement(agree) 하면 마지막 승인 순간 서버가 자동으로 이동시킨다.
//   - force / reporter override 는 게이트를 우회한다.
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
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

const BASE_PORT = parseInt(process.env.QA_CONSENSUS_GATE_PORT || '7871', 10);
process.env.PORT = String(BASE_PORT);

/**
 * assignee 역할에 두 번째 홀더를 추가(multi-holder-fanout/consensus-t4 픽스처와 동일).
 * createTicket 이 첫 홀더를 holder_key='' 로 심으므로, 두 번째는 holder_key=
 * 'agent:<id>' 로 유니크 인덱스를 회피한다.
 */
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
  await addAssigneeHolder(app, getDataSourceToken, {
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
