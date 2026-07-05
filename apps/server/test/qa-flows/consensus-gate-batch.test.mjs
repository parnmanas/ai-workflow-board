// QA flow: 다중담당자·합의 T5 — batch_operations move-ticket 우회 봉쇄(잔여 경화 #3).
//
// consensus-gate.test.mjs 가 move_ticket(직접)·propose_move·auto-execute 를 커버하고,
// consensus-e2e.test.mjs 가 REST/보드-이동 표면을 커버한다. 이 파일은 세 번째 이탈
// 표면인 `batch_operations`(misc-tools.ts)의 move-ticket 케이스를 검증한다:
//   - 홀더 ≥2 컬럼에서 batch move-ticket 으로 이탈하면 consensus_required 로 차단되고
//     티켓은 그대로다(이전엔 게이트 미배선 → 우회 성립).
//   - op.force=true 는 게이트를 우회한다(의도적 operator escape hatch, move_ticket 동일).
//   - 홀더 ≤1 티켓은 무회귀 — batch move-ticket 이 그대로 이동한다.
//   - 같은 컬럼 재정렬(toColumn===현재)은 게이트 면제 — 이탈이 아니므로.

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

const BASE_PORT = parseInt(process.env.QA_CONSENSUS_GATE_BATCH_PORT || '7881', 10);
process.env.PORT = String(BASE_PORT);

/**
 * assignee 역할에 두 번째 홀더를 추가(consensus-gate.test.mjs 와 동일 패턴).
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

/** 두 assignee 홀더(A+B) + reporter 를 가진 In Progress 티켓 씬(board 포함). */
async function twoHolderScene(app, getDataSourceToken, name) {
  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: name });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const holderB = { agent: await createAgent(app, getDataSourceToken, ws.id, { name: 'assignee-b' }) };
  holderB.key = await createApiKey(app, getDataSourceToken, holderB.agent.id, {
    workspaceId: ws.id, label: 'assignee-b',
  });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, // In Progress → ['assignee']
    workspaceId: ws.id,
    title: 'consensus-gate-batch',
    assigneeId: trio.assignee.agent.id,
    reporterId: trio.reporter.agent.id,
  });
  await addAssigneeHolder(app, getDataSourceToken, {
    ticketId: ticket.id, workspaceId: ws.id, agentId: holderB.agent.id,
  });
  return { ws, board, columns, trio, holderB, ticket };
}

async function columnIdOf(app, getDataSourceToken, ticketId) {
  const ds = app.get(getDataSourceToken());
  const t = await ds.getRepository('Ticket').findOne({ where: { id: ticketId } });
  return t?.column_id;
}

test('batch_operations move-ticket: 2홀더 이탈은 consensus_required 로 차단(우회 봉쇄)', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { board, columns, trio, ticket } = await twoHolderScene(app, getDataSourceToken, 'cgate-batch-a');
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  t.after(() => { void a.close(); });

  step('홀더 A 가 batch_operations move-ticket 으로 In Progress→Review 이탈 시도 → op 차단');
  const res = await a.callTool('batch_operations', {
    operations: [
      { action: 'move-ticket', boardId: board.id, ticketId: ticket.id, toColumn: 'Review' },
    ],
  });
  assert.ok(!res.isError, `batch_operations 자체는 성공 응답이어야 함: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.results) && res.results.length === 1, 'op 결과 1건');
  assert.ok(res.results[0].error, `move-ticket op 는 error 로 차단되어야 함: ${JSON.stringify(res.results[0])}`);
  assert.match(res.results[0].error, /consensus_required/, '차단 사유는 consensus_required');
  assert.equal(
    await columnIdOf(app, getDataSourceToken, ticket.id),
    columns.inProgress.id,
    '차단 → 티켓은 In Progress 그대로(우회 불가)',
  );
});

test('batch_operations move-ticket: op.force=true 는 게이트를 우회한다', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 1 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { board, columns, trio, ticket } = await twoHolderScene(app, getDataSourceToken, 'cgate-batch-b');
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  t.after(() => { void a.close(); });

  step('op.force=true 로 batch move-ticket → 게이트 우회하여 이동');
  const res = await a.callTool('batch_operations', {
    operations: [
      { action: 'move-ticket', boardId: board.id, ticketId: ticket.id, toColumn: 'Review', force: true },
    ],
  });
  assert.ok(!res.isError, `batch_operations 응답 실패: ${JSON.stringify(res)}`);
  assert.ok(res.results[0].success, `force op 는 성공해야 함: ${JSON.stringify(res.results[0])}`);
  assert.equal(
    await columnIdOf(app, getDataSourceToken, ticket.id),
    columns.review.id,
    'force → Review 로 이동됨',
  );
});

test('batch_operations move-ticket: 홀더 ≤1 무회귀 + 같은 컬럼 재정렬은 게이트 면제', async (t) => {
  const { app, port, modules } = await bootApp({ port: BASE_PORT + 2 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'cgate-batch-c' });
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id, title: 'single-holder-batch',
    assigneeId: trio.assignee.agent.id, reporterId: trio.reporter.agent.id,
  });
  const a = await mcpFor(port, trio.assignee.key.raw_key);
  t.after(() => { void a.close(); });

  step('단일 홀더 → batch move-ticket 이 게이트 없이 In Progress→Review 이동');
  const moved = await a.callTool('batch_operations', {
    operations: [
      { action: 'move-ticket', boardId: board.id, ticketId: ticket.id, toColumn: 'Review' },
    ],
  });
  assert.ok(moved.results[0].success, `단일홀더 이동 실패: ${JSON.stringify(moved.results[0])}`);
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.review.id, '게이트 미발동 → 이동됨');

  step('같은 컬럼 재정렬(toColumn===현재)은 이탈이 아니므로 게이트 면제(무회귀)');
  // 이 단계는 단일홀더라 어차피 게이트가 안 걸리지만, toColumn===현재 분기를 함께 밟는다.
  const reorder = await a.callTool('batch_operations', {
    operations: [
      { action: 'move-ticket', boardId: board.id, ticketId: ticket.id, toColumn: 'Review', position: 0 },
    ],
  });
  assert.ok(reorder.results[0].success, `같은 컬럼 재정렬 실패: ${JSON.stringify(reorder.results[0])}`);
  assert.equal(await columnIdOf(app, getDataSourceToken, ticket.id), columns.review.id, '재정렬 후에도 Review');

  exitAfterTests(0);
});
