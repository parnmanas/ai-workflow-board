// QA flow: 다중담당자·합의 T4 — record_agreement 툴 end-to-end.
//
// 순수 판정 로직은 consensus-state.test.mjs 가 단위로 커버한다. 이 통합 테스트는
// 배선(툴 → Comment.metadata 마커 → getConsensusState 재판정 → T2 재디스패치
// 억제)이 실제 Nest 앱 + DB 위에서 맞물리는지 검증한다:
//   - record_agreement 가 라우팅 역할 전 홀더 판정을 반환(부분→전원→stale).
//   - vote 코멘트에 consensus_vote 마커 + author_role 이 실제로 심긴다.
//   - reporter override 가 이의를 넘어 satisfied 를 강제하고 감사 로그를 남긴다.
//   - 합의 vote 코멘트는 다른 홀더를 재디스패치하지 않는다(마커→T2 hook), 반면
//     일반 노트는 팬아웃된다(억제가 마커에만 특정임을 대조로 증명).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgentTrio,
  createAgent,
  createApiKey,
  createTicket,
  addRoleHolder,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

const BASE_PORT = parseInt(process.env.QA_CONSENSUS_PORT || '7861', 10);
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
    title: 'consensus-t4',
    assigneeId: trio.assignee.agent.id,
    reporterId: trio.reporter.agent.id,
  });
  await addRoleHolder(app, getDataSourceToken, {
    ticketId: ticket.id, workspaceId: ws.id, agentId: holderB.agent.id,
  });
  return { ws, columns, trio, holderB, ticket };
}

test('record_agreement: 부분→전원 agree, 마커/역할 스탬프, 새 제안 stale', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws, trio, holderB, ticket } = await twoHolderScene(app, getDataSourceToken, 'consensus-a');
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  const b = await mcpFor(port, holderB.key.raw_key);
  t.after(() => { void a.close(); void b.close(); });

  step('holder A agrees on p1 → 필수 2 · 동의 1 · satisfied=false');
  const r1 = await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree', proposal_id: 'p1' });
  assert.ok(!r1.isError, `record_agreement A failed: ${JSON.stringify(r1)}`);
  assert.equal(r1.consensus.required.length, 2, 'assignee 홀더 2명이 필수 투표자');
  assert.equal(r1.consensus.agreed.length, 1);
  assert.equal(r1.consensus.satisfied, false);

  step('A vote 코멘트에 consensus_vote 마커 + consensus payload + author_role=assignee');
  const ds = app.get(getDataSourceToken());
  const aComments = await ds.getRepository('Comment').find({
    where: { ticket_id: ticket.id, author_id: trio.assignee.agent.id },
  });
  const voteC = aComments.find((c) => {
    try { return JSON.parse(c.metadata).consensus_vote === true; } catch { return false; }
  });
  assert.ok(voteC, 'A 의 consensus_vote 마커 코멘트가 존재해야 함(→ T2 hook 이 억제)');
  const meta = JSON.parse(voteC.metadata);
  assert.equal(meta.consensus_vote, true);
  assert.equal(meta.consensus.status, 'agree');
  assert.equal(meta.consensus.proposal_id, 'p1');
  assert.equal(meta.author_role, 'assignee');

  step('holder B agrees on p1 → 전원 동의 · satisfied=true');
  const r2 = await b.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree', proposal_id: 'p1' });
  assert.equal(r2.consensus.satisfied, true);
  assert.equal(r2.consensus.agreed.length, 2);
  assert.equal(r2.consensus.pending.length, 0);

  step('새 제안 p2 → 이전 p1 승인 stale · satisfied=false · 앵커=p2');
  const r3 = await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree', proposal_id: 'p2' });
  assert.equal(r3.consensus.proposalId, 'p2');
  assert.equal(r3.consensus.agreed.length, 1, 'p2 에는 A 만 동의');
  assert.equal(r3.consensus.pending.length, 1, 'B 의 p1 승인은 stale → pending');
  assert.equal(r3.consensus.satisfied, false);
});

test('record_agreement: object + reporter override + 감사 로그', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 1 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { trio, holderB, ticket } = await twoHolderScene(app, getDataSourceToken, 'consensus-b');
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  const b = await mcpFor(port, holderB.key.raw_key);
  const rep = await mcpFor(port, trio.reporter.key.raw_key);
  t.after(() => { void a.close(); void b.close(); void rep.close(); });

  await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree', proposal_id: 'p1' });

  step('holder B objects → satisfied=false · objected=1');
  const rB = await b.callTool('record_agreement', { ticket_id: ticket.id, status: 'object', proposal_id: 'p1' });
  assert.equal(rB.consensus.satisfied, false);
  assert.equal(rB.consensus.objected.length, 1);

  step('reporter override → satisfied=true(overriddenBy) · 이의 기록은 유지');
  const rR = await rep.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree', proposal_id: 'p1', override: true });
  assert.equal(rR.consensus.satisfied, true);
  assert.ok(rR.consensus.overriddenBy, 'overriddenBy 가 설정돼야 함');
  assert.equal(rR.consensus.overriddenBy.id, trio.reporter.agent.id);
  assert.equal(rR.consensus.objected.length, 1, '이의는 여전히 기록');

  step('override 감사 로그(field_changed=consensus_override)');
  const ds = app.get(getDataSourceToken());
  const acts = await ds.getRepository('ActivityLog').find({ where: { entity_id: ticket.id } });
  assert.ok(
    acts.some((x) => x.field_changed === 'consensus_override'),
    'reporter override 는 consensus_override 감사 활동을 남겨야 함',
  );

  step('비-reporter 의 override 플래그는 무시(effectiveOverride 게이트)');
  // holder A(비-reporter)가 override 를 켜도 판정에는 반영되지 않는다.
  const rA2 = await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree', proposal_id: 'p1', override: true });
  // A agree + B object(여전히) → reporter override 로만 satisfied. A 의 override 는
  // reporter override 가 이미 있어 satisfied 이지만, overriddenBy 는 reporter 여야 함.
  assert.equal(rA2.consensus.overriddenBy?.id, trio.reporter.agent.id, 'override 는 reporter 홀더만 인정');
});

test('합의 시그널은 재디스패치되지 않고(T2 마커), 일반 노트는 팬아웃된다', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 2 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { trio, holderB, ticket } = await twoHolderScene(app, getDataSourceToken, 'consensus-c');

  // holder B 를 SSE 로 관찰. A 가 시그널/노트를 캐스트할 때 B 로 재디스패치가
  // 오는지(agent_trigger) 센다.
  const agentB = new VirtualAgent({
    name: 'assignee-b', agentId: holderB.agent.id, apiKey: holderB.key.raw_key, port,
  });
  await agentB.start();
  t.after(() => agentB.stop());
  await new Promise((r) => setTimeout(r, 200));

  const a = await mcpFor(port, trio.assignee.key.raw_key);
  t.after(() => { void a.close(); });

  step('A 가 합의 시그널(vote) → B 재디스패치 0 (consensus_vote 마커 → T2 hook 억제)');
  await a.callTool('record_agreement', { ticket_id: ticket.id, status: 'agree', proposal_id: 'p1' });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(agentB.triggersFor(ticket.id).length, 0, '합의 vote 는 다른 홀더를 재디스패치하면 안 됨');

  step('대조: A 의 일반 노트 → B 팬아웃 트리거 ≥1 (억제는 마커에만 특정)');
  await a.callTool('add_comment', { ticket_id: ticket.id, content: '일반 논의 노트(마커 없음)' });
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(
    agentB.triggersFor(ticket.id).length >= 1,
    '마커 없는 일반 노트는 다른 홀더로 팬아웃되어야 함(억제가 vote 에만 특정임을 증명)',
  );

  exitAfterTests(0);
});
