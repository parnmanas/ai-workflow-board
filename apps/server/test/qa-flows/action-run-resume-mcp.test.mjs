// QA flow — Action run → 원 티켓 자동 재개 end-to-end (티켓 524bb434).
//
// 리뷰어 BLOCKER("자동 재개가 구현·테스트되지 않음")를 실 MCP 프로토콜로 고정한다.
// 완료 기준 매핑:
//   • 기존 Action 실행 → 완료 → 동일 티켓 재개   (run_action(source_ticket_id) → complete_action_run succeeded)
//   • 신규 Action 등록 → 실행 → 완료 → 재개        (save_action → 위와 동일 경로)
//   • 실행 실패 → 자동 재시도(bounded) → 소진 시 surfacing+재개
//   • 멱등성(고영향 안전장치) — 이미 완료된 run 재-complete 는 no-op, 이중 재개 없음
//
// "재개"의 관측 가능한 신호:
//   1. complete_action_run 응답의 resumed=true + resume_emitted>=1
//      (dispatchCurrentColumn 이 원 티켓의 현재 컬럼 role holder 를 재-dispatch)
//   2. 원 티켓에 결과 감사 댓글(note) + action_run_completed ActivityLog 행
//   3. run.status 가 succeeded/failed 로 전이(list_action_runs)

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

process.env.PORT = process.env.QA_ACTION_RESUME_PORT || '7908';

// Find the single run whose id is `runId` from a list_action_runs payload.
function findRun(runs, runId) {
  return (runs || []).find((r) => r.id === runId);
}

test('Action run → source ticket auto-resume (existing + new Action, failure/retry, idempotency)', async (t) => {
  step('Boot app + MCP');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => {
    void app.close().catch(() => {});
  });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const ws = await createWorkspace(app, getDataSourceToken, 'actresume');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'deployer' });
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'b' });
  // The source ticket lives in an ACTIVE column routed to the assignee role so
  // the resume (dispatchCurrentColumn) has a holder to wake.
  const col = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress',
    position: 1,
    workspaceId: ws.id,
    roleRouting: ['assignee'],
  });

  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, scope: 'full' });
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await mcp.initialize();

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 1 — 기존 Action 실행 → 완료(succeeded) → 동일 티켓 자동 재개
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 1 — existing Action: run(source_ticket_id) → complete succeeded → resume');
  const existing = await mcp.callTool('save_action', {
    workspace_id: ws.id,
    name: 'Deploy prod',
    prompt: 'deploy {{workspace.name}}',
    target_agent_id: agent.id,
  });
  assert.ok(!existing.isError, 'save_action (existing) succeeds');

  const ticket1 = await createTicket(app, getDataSourceToken, {
    columnId: col.id,
    workspaceId: ws.id,
    title: 'blocked on deploy',
    assigneeId: agent.id,
  });

  const run1 = await mcp.callTool('run_action', {
    action_id: existing.id,
    source_ticket_id: ticket1.id,
  });
  assert.ok(!run1.isError, 'run_action succeeds');
  assert.ok(run1.run_id, 'run_action returns a run id');
  assert.equal(run1.source_ticket_id, ticket1.id, 'the run preserves source_ticket_id (reviewer req 1)');

  // The dispatched prompt must carry the server-injected completion contract.
  const runsList1 = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: existing.id });
  const runRow1 = findRun(runsList1, run1.run_id);
  assert.ok(runRow1, 'run is listed');
  assert.equal(runRow1.source_ticket_id, ticket1.id, 'list_action_runs surfaces source_ticket_id');
  assert.equal(runRow1.status, 'running', 'a fresh run is running');
  assert.match(runRow1.prompt_rendered, /complete_action_run/, 'run prompt injects the completion contract');

  const done1 = await mcp.callTool('complete_action_run', {
    run_id: run1.run_id,
    workspace_id: ws.id,
    status: 'succeeded',
    summary: 'deployed build 42 to prod',
  });
  assert.ok(!done1.isError, 'complete_action_run succeeds');
  assert.equal(done1.status, 'succeeded', 'run recorded as succeeded');
  assert.equal(done1.previously_completed, false, 'first completion is not a no-op');
  assert.equal(done1.resumed, true, 'source ticket is resumed on success (reviewer req 2)');
  assert.ok(done1.resume_emitted >= 1, 'resume actually re-dispatched the assignee (emitted >= 1)');

  // Run is now terminal.
  const runsList1b = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: existing.id });
  assert.equal(findRun(runsList1b, run1.run_id).status, 'succeeded', 'run status transitioned to succeeded');

  // Result reflected on the ticket audit trail — comment + activity row.
  const t1full = await mcp.callTool('get_ticket', { ticket_id: ticket1.id });
  const successComment = (t1full.comments || []).find((c) => /succeeded/i.test(c.content) && /deployed build 42/.test(c.content));
  assert.ok(successComment, 'success outcome posted as a ticket comment');
  const acts1 = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: ticket1.id, action: 'action_run_completed' },
  });
  assert.ok(acts1.length >= 1, 'action_run_completed audit row written on the source ticket');
  assert.match(acts1[0].new_value, /succeeded/, 'audit row records the succeeded outcome');

  // Idempotency (scope-5 safety) — re-completing is a no-op, no second resume.
  step('CASE 1b — idempotency: re-completing a terminal run is a no-op');
  const dup1 = await mcp.callTool('complete_action_run', {
    run_id: run1.run_id,
    workspace_id: ws.id,
    status: 'succeeded',
    summary: 'duplicate call',
  });
  assert.ok(!dup1.isError, 'duplicate completion does not error');
  assert.equal(dup1.previously_completed, true, 'duplicate is recognized as already-completed');
  assert.equal(dup1.resumed, false, 'duplicate does NOT resume the ticket again');
  const acts1b = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: ticket1.id, action: 'action_run_completed' },
  });
  assert.equal(acts1b.length, 1, 'no second audit row from the idempotent duplicate');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 2 — 신규 Action 등록 → 실행 → 완료 → 재개
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 2 — newly registered Action: register → run → complete → resume');
  const fresh = await mcp.callTool('save_action', {
    workspace_id: ws.id,
    name: 'Publish package',
    prompt: 'publish',
    target_agent_id: agent.id,
  });
  assert.ok(!fresh.isError && fresh.id, 'new Action registered');
  const ticket2 = await createTicket(app, getDataSourceToken, {
    columnId: col.id,
    workspaceId: ws.id,
    title: 'blocked on publish',
    assigneeId: agent.id,
  });
  const run2 = await mcp.callTool('run_action', { action_id: fresh.id, source_ticket_id: ticket2.id });
  const done2 = await mcp.callTool('complete_action_run', {
    run_id: run2.run_id,
    workspace_id: ws.id,
    status: 'succeeded',
    summary: 'published v1.2.3',
  });
  assert.equal(done2.resumed, true, 'newly-registered Action run also auto-resumes the source ticket');
  assert.ok(done2.resume_emitted >= 1, 'new-Action resume re-dispatched the assignee');
  const t2full = await mcp.callTool('get_ticket', { ticket_id: ticket2.id });
  assert.ok((t2full.comments || []).some((c) => /published v1\.2\.3/.test(c.content)), 'new-Action outcome on ticket');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 3 — 실행 실패 → 자동 재시도(bounded) → 소진 시 surfacing + 재개
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 3 — failure: bounded auto-retry, then surface + resume at the cap');
  const flaky = await mcp.callTool('save_action', {
    workspace_id: ws.id,
    name: 'Flaky deploy',
    prompt: 'deploy-maybe',
    target_agent_id: agent.id,
  });
  const ticket3 = await createTicket(app, getDataSourceToken, {
    columnId: col.id,
    workspaceId: ws.id,
    title: 'blocked on flaky deploy',
    assigneeId: agent.id,
  });
  // Attempt 1 fails → server re-dispatches attempt 2 (no resume yet).
  const r3a = await mcp.callTool('run_action', { action_id: flaky.id, source_ticket_id: ticket3.id });
  const f3a = await mcp.callTool('complete_action_run', {
    run_id: r3a.run_id, workspace_id: ws.id, status: 'failed', summary: 'network blip',
  });
  assert.equal(f3a.status, 'failed', 'attempt 1 recorded failed');
  assert.equal(f3a.retried, true, 'a failure under the cap auto-retries (reviewer req 3)');
  assert.ok(f3a.retry_run_id, 'retry produced a fresh run id');
  assert.equal(f3a.resumed, false, 'the ticket is NOT resumed while a retry is pending');

  const runsList3 = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: flaky.id });
  const retryRow = findRun(runsList3, f3a.retry_run_id);
  assert.ok(retryRow, 'the retry run is listed');
  assert.equal(retryRow.attempt, 2, 'retry run carries attempt=2');
  assert.equal(retryRow.source_ticket_id, ticket3.id, 'retry preserves the source ticket linkage');

  // Attempt 2 fails → attempt 3.
  const f3b = await mcp.callTool('complete_action_run', {
    run_id: f3a.retry_run_id, workspace_id: ws.id, status: 'failed', summary: 'still failing',
  });
  assert.equal(f3b.retried, true, 'attempt 2 failure retries again (still under cap of 3)');
  assert.equal(f3b.resumed, false, 'still not resumed at attempt 2');

  // Attempt 3 fails → cap reached → exhausted → surface + resume.
  const f3c = await mcp.callTool('complete_action_run', {
    run_id: f3b.retry_run_id, workspace_id: ws.id, status: 'failed', summary: 'gave up',
  });
  assert.equal(f3c.retried, false, 'at the cap there is no further retry');
  assert.equal(f3c.exhausted, true, 'retry cap reached is reported as exhausted');
  assert.equal(f3c.resumed, true, 'exhausted failure surfaces + resumes the ticket so the assignee decides');
  assert.ok(f3c.resume_emitted >= 1, 'exhaustion resume re-dispatched the assignee');

  const t3full = await mcp.callTool('get_ticket', { ticket_id: ticket3.id });
  assert.ok(
    (t3full.comments || []).some((c) => /failed after 3 attempt/i.test(c.content)),
    'exhaustion is surfaced as a ticket comment naming the attempt count',
  );

  await mcp.close();
  exitAfterTests(0);
});
