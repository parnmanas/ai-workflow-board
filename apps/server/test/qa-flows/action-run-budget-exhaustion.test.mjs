// QA flow — Action bounded-retry가 workspace run-budget 상한에 막힐 때의 실제 왕복
// (티켓 a51ec6d9 플랜 작업분해 5번 "Done when": "ActionRun 왕복 1건 — 상한 걸린 상태에서
// completeRun(failed) → 재-디스패치 거부 → 소스 티켓 resume").
//
// run-budget-guard.test.mjs / run-budget-dispatch-gate.test.mjs 는 각각 순수 로직과
// 정적 호출부 순서만 고정한다. 이 파일은 그 사이를 실 MCP 프로토콜로 잇는다 — run_action
// 으로 워크스페이스의 유일한 run-budget 슬롯을 소진시킨 뒤, complete_action_run(failed)
// 이 유발하는 bounded-retry 재-dispatch 가 실제로 거부되고, 그 거부가 (정정 2에 따라)
// dispatch() 안에서 던져져 completeRun 의 기존 catch 가 자연히 "소진"으로 처리해 소스
// 티켓을 실제로 재개하는지를 관측 가능한 신호로 고정한다:
//   1. complete_action_run 응답: exhausted=true, retried=false, retry_run_id=''
//      (자연 3회 소진이 아니라 예산 상한에 의한 즉시 소진), resumed=true, resume_emitted>=1
//   2. list_action_runs 는 여전히 1건만 반환 — 거부된 재시도는 phantom run 을 만들지 않는다
//   3. 소스 티켓에 실패 감사 댓글이 실제로 남는다(내부 플래그만이 아니라)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createBoard,
  createColumn,
  createTicket,
  createApiKey,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_ACTION_BUDGET_EXHAUSTION_PORT || '7912';

test('Action retry blocked by an exhausted workspace run-budget surfaces as exhaustion and resumes the source ticket', async (t) => {
  step('Boot app + MCP');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => {
    void app.close().catch(() => {});
  });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const ws = await createWorkspace(app, getDataSourceToken, 'actbudget');
  // Tight run-creation-rate ceiling — the FIRST dispatch consumes the only
  // slot in the window, so the bounded retry's re-dispatch trips it.
  await ds.getRepository('Workspace').update(ws.id, {
    hard_budget_config: JSON.stringify({ max_runs_per_window: 1, window_minutes: 60, notify: false }),
  });

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'deployer' });
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'b' });
  // Source ticket lives in an ACTIVE column routed to the assignee role so the
  // resume (dispatchCurrentColumn) has a holder to wake (mirrors
  // action-run-resume-mcp.test.mjs's CASE 1 setup).
  const col = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress',
    position: 1,
    workspaceId: ws.id,
    roleRouting: ['assignee'],
  });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: col.id,
    workspaceId: ws.id,
    title: 'blocked on flaky deploy step',
    assigneeId: agent.id,
  });

  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, scope: 'full' });
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await mcp.initialize();

  step('Register a low-impact Action (not deploy/publish/release — no approval gate)');
  const action = await mcp.callTool('save_action', {
    workspace_id: ws.id,
    name: 'Reindex search',
    prompt: 'reindex {{workspace.name}}',
    target_agent_id: agent.id,
  });
  assert.ok(!action.isError, 'save_action succeeds');

  step('First dispatch consumes the only run-budget slot in the window');
  const run1 = await mcp.callTool('run_action', { action_id: action.id, source_ticket_id: ticket.id });
  assert.ok(!run1.isError, 'first run_action succeeds (count 0 < limit 1)');
  assert.ok(run1.run_id, 'run_action returns a run id');

  step('Failure triggers a bounded-retry re-dispatch, which the run-budget guard now rejects');
  const done = await mcp.callTool('complete_action_run', {
    run_id: run1.run_id,
    workspace_id: ws.id,
    status: 'failed',
    summary: 'flaky step timed out',
  });
  assert.ok(!done.isError, 'complete_action_run itself succeeds — the rejection is internal, not a tool-call error');
  assert.equal(done.status, 'failed');
  assert.equal(done.retried, false, 'the retry re-dispatch was rejected by the run-budget guard, not launched');
  assert.equal(done.retry_run_id, '', 'no retry run id — nothing was created');
  assert.equal(done.exhausted, true, 'a rejected retry is treated as exhaustion, not silently dropped (ticket a51ec6d9 plan "정정 2")');
  assert.equal(done.resumed, true, 'exhaustion still surfaces + resumes the source ticket');
  assert.ok(done.resume_emitted >= 1, 'resume actually re-dispatched the assignee');

  step('Exactly one run still exists — the budget-rejected retry left no phantom row');
  const runs = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: action.id });
  assert.equal(runs.length, 1, 'only the original run — the retry never persisted a row');
  assert.equal(runs[0].status, 'failed');

  step('The source ticket actually carries the failure audit comment, not just an internal flag');
  const ticketAfter = await mcp.callTool('get_ticket', { ticket_id: ticket.id });
  const comments = ticketAfter.comments || [];
  assert.ok(
    comments.some((c) => c.content?.includes('Reindex search') && c.content?.includes('failed')),
    'a real audit comment recording the failure landed on the source ticket',
  );

  exitAfterTests(0);
});
