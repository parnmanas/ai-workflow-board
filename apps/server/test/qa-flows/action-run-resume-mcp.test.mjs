// QA flow — Action run → 원 티켓 자동 재개 end-to-end (티켓 524bb434).
//
// 리뷰어 BLOCKER("자동 재개가 구현·테스트되지 않음")를 실 MCP 프로토콜로 고정한다.
// 완료 기준 매핑:
//   • 기존 Action 실행 → 완료 → 동일 티켓 재개   (run_action(source_ticket_id) → complete_action_run succeeded)
//   • 신규 Action 등록 → 실행 → 완료 → 재개        (save_action → 위와 동일 경로)
//   • 실행 실패 → 자동 재시도(bounded) → 소진 시 surfacing+재개
//   • 멱등성(고영향 안전장치) — 이미 완료된 run 재-complete 는 no-op, 이중 재개 없음
//
// 스코프 5 실행 전 승인 게이트 (reviewer 4차 blocker — approved_by_user_id 위조 차단):
//   • 고영향 run 은 사람 인증(admin 세션) REST 엔드포인트로 만든 승인 grant 없이는 거부+park
//   • agent run_action 에는 승인자 파라미터가 없음 — 서버가 (action,ticket)-결합 grant 를 원자 소비
//   • grant 는 1회용(재사용 거부) + (action,ticket) 결합(다른 티켓/액션 미인가)
//   • 승인 생성은 admin 세션만 — 비-admin 세션 403, 미인증 401, agent(MCP)는 아예 경로 없음
//   • 감사 actor/time 은 caller 가 아니라 grant record(실 사람) 에서 복사
//   • 만료 grant 는 뒤의 유효 grant 를 가리지 않는다 — expired A + valid B 는 단일 run 이
//     A 를 retire 하고 B 를 소비해 실행(재-park 없음). (reviewer 5차 blocker)
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
  createUser,
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
  const { getDataSourceToken, ActionsService, AuthService } = modules;
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

  // Admin user who can approve high-impact runs; a non-admin used to prove the
  // approval authority check (scope-5 approval gate, CASEs 6/8/9/10/11/12/13).
  const admin = await createUser(app, getDataSourceToken, { name: 'approver', role: 'admin' });
  // Admin session token so tests hit the HUMAN-authenticated approval endpoint
  // exactly as an admin's browser would (session Bearer, NOT an agent API key).
  // The approver identity is derived from this session server-side — the request
  // body carries no approver field. THAT is the trust boundary: an agent (MCP API
  // key, no session) can never mint an approval grant.
  const authService = app.get(AuthService);
  const adminToken = authService.createSession(admin.id);

  // POST /api/actions/:id/approvals as a human. `token=null` omits the
  // Authorization header (unauthenticated). Returns { status, body }.
  async function approveViaRest({ actionId, workspaceId, sourceTicketId, token, ttlMinutes }) {
    const res = await fetch(`http://localhost:${port}/api/actions/${actionId}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        workspace_id: workspaceId,
        source_ticket_id: sourceTicketId,
        ...(ttlMinutes ? { ttl_minutes: ttlMinutes } : {}),
      }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    return { status: res.status, body };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 1 — 기존 Action 실행 → 완료(succeeded) → 동일 티켓 자동 재개
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 1 — existing Action: run(source_ticket_id) → complete succeeded → resume');
  // Benign (low-impact) Action — the everyday "an Action clears the blocker,
  // ticket auto-resumes" path. Deliberately NOT named deploy/publish/release so
  // it is not escalated by the high-impact name heuristic (that path is CASE 6+).
  const existing = await mcp.callTool('save_action', {
    workspace_id: ws.id,
    name: 'Reindex search',
    prompt: 'reindex {{workspace.name}}',
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
    summary: 'reindexed 1.2M docs',
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
  const successComment = (t1full.comments || []).find((c) => /succeeded/i.test(c.content) && /reindexed 1\.2M docs/.test(c.content));
  assert.ok(successComment, 'success outcome posted as a ticket comment');
  const acts1 = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: ticket1.id, action: 'action_run_completed' },
  });
  assert.ok(acts1.length >= 1, 'action_run_completed audit row written on the source ticket');
  assert.match(acts1[0].new_value, /succeeded/, 'audit row records the succeeded outcome');
  // Reviewer req 3 — the audit row is stamped with the source workspace so the
  // workspace-scoped activity feed surfaces it (previously defaulted to '').
  assert.equal(acts1[0].workspace_id, ws.id, 'audit row records the source workspace_id');

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
    name: 'Regenerate sitemap',
    prompt: 'regenerate',
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
    summary: 'regenerated sitemap',
  });
  assert.equal(done2.resumed, true, 'newly-registered Action run also auto-resumes the source ticket');
  assert.ok(done2.resume_emitted >= 1, 'new-Action resume re-dispatched the assignee');
  const t2full = await mcp.callTool('get_ticket', { ticket_id: ticket2.id });
  assert.ok((t2full.comments || []).some((c) => /regenerated sitemap/.test(c.content)), 'new-Action outcome on ticket');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 3 — 실행 실패 → 자동 재시도(bounded) → 소진 시 surfacing + 재개
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 3 — failure: bounded auto-retry, then surface + resume at the cap');
  const flaky = await mcp.callTool('save_action', {
    workspace_id: ws.id,
    name: 'Flaky sync',
    prompt: 'sync-maybe',
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

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 4 — source_ticket_id workspace boundary (reviewer req 1)
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 4 — run_action rejects nonexistent + cross-workspace source_ticket_id');
  // Nonexistent ticket id → 404-shaped rejection, no run created.
  const badRun = await mcp.callTool('run_action', {
    action_id: existing.id,
    source_ticket_id: '00000000-0000-0000-0000-000000000000',
  });
  assert.equal(badRun.isError, true, 'run_action rejects a nonexistent source ticket');

  // A ticket in a DIFFERENT workspace must be rejected — otherwise one
  // workspace's Action run could be linked to another workspace's ticket and,
  // via complete_action_run, drive cross-workspace comments / re-dispatch.
  const otherWs = await createWorkspace(app, getDataSourceToken, 'foreignws');
  const otherBoard = await createBoard(app, getDataSourceToken, otherWs.id, { name: 'ob' });
  const otherCol = await createColumn(app, getDataSourceToken, otherBoard.id, {
    name: 'In Progress', position: 1, workspaceId: otherWs.id, roleRouting: ['assignee'],
  });
  const foreignTicket = await createTicket(app, getDataSourceToken, {
    columnId: otherCol.id, workspaceId: otherWs.id, title: 'foreign ticket',
  });
  const crossRun = await mcp.callTool('run_action', {
    action_id: existing.id,            // action lives in `ws`
    source_ticket_id: foreignTicket.id, // ticket lives in `otherWs`
  });
  assert.equal(crossRun.isError, true, 'run_action rejects a cross-workspace source ticket');
  assert.match(JSON.stringify(crossRun.error), /different workspace/i, 'rejection names the workspace boundary');
  // No run row leaked for `existing` beyond the legitimate CASE-1 run.
  const existingRuns = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: existing.id });
  assert.equal(existingRuns.length, 1, 'rejected dispatches created no ActionRun row');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 5 — concurrent complete_action_run: single atomic winner (reviewer req 2)
  // Two genuinely-concurrent completions must not both audit / resume / retry.
  // Driven at the service layer so the race is real (not serialized by the MCP
  // session), directly exercising the `WHERE status='running'` guard.
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 5 — concurrent completion is atomic (exactly-once audit + resume)');
  const svc = app.get(ActionsService);
  const conc = await mcp.callTool('save_action', {
    workspace_id: ws.id, name: 'Concurrent sync', prompt: 'x', target_agent_id: agent.id,
  });
  const ticket5 = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked concurrent', assigneeId: agent.id,
  });
  const run5 = await mcp.callTool('run_action', { action_id: conc.id, source_ticket_id: ticket5.id });
  const [c1, c2] = await Promise.all([
    svc.completeRun(run5.run_id, ws.id, { status: 'succeeded', summary: 'winner A' }),
    svc.completeRun(run5.run_id, ws.id, { status: 'succeeded', summary: 'winner B' }),
  ]);
  const winners = [c1, c2].filter((r) => r.previouslyCompleted === false);
  const noops = [c1, c2].filter((r) => r.previouslyCompleted === true);
  assert.equal(winners.length, 1, 'exactly one concurrent completion wins the transition');
  assert.equal(noops.length, 1, 'the other concurrent completion is a no-op');
  assert.equal(winners[0].shouldResume, true, 'the winner drives the resume');
  assert.equal(noops[0].shouldResume, false, 'the no-op does not resume again');
  const acts5 = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: ticket5.id, action: 'action_run_completed' },
  });
  assert.equal(acts5.length, 1, 'exactly one audit row from two concurrent completions');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 6 — high-impact Action: no auto-retry on failure (reviewer req 4 / scope 5)
  // A deploy/publish whose failure may mean partial external effect must NOT be
  // blindly re-run by the server; it surfaces to the ticket for a human.
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 6 — high-impact failure surfaces (no auto-retry) + stable idempotency key');
  const hi = await mcp.callTool('save_action', {
    workspace_id: ws.id, name: 'Prod release', prompt: 'release', target_agent_id: agent.id, high_impact: true,
  });
  assert.ok(!hi.isError && hi.id, 'high-impact Action registered');
  assert.equal(hi.high_impact, true, 'high_impact flag round-trips through save_action');
  const ticket6 = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked on release', assigneeId: agent.id,
  });
  // High-impact ⇒ the run needs a human approval grant (gate covered in CASE
  // 8-13); here an admin approves via the HUMAN REST path, then the agent runs
  // (no approver param) and the server consumes the grant — so we can exercise
  // the no-auto-retry-on-failure path on an actually-executed run.
  const appr6 = await approveViaRest({ actionId: hi.id, workspaceId: ws.id, sourceTicketId: ticket6.id, token: adminToken });
  assert.equal(appr6.status, 201, 'admin approval grant created via the human endpoint');
  const run6 = await mcp.callTool('run_action', {
    action_id: hi.id, source_ticket_id: ticket6.id,
  });
  assert.ok(!run6.isError, 'approved high-impact run is dispatched (server consumed the grant)');
  // The run carries a minted idempotency key surfaced in the prompt contract.
  const runs6 = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: hi.id });
  const row6 = findRun(runs6, run6.run_id);
  assert.ok(row6.idempotency_key, 'ticket-driven run mints a run-level idempotency key');
  assert.match(row6.prompt_rendered, /Idempotency key/, 'prompt surfaces the idempotency key');
  assert.match(row6.prompt_rendered, /HIGH-IMPACT/, 'prompt tells the agent the server will not auto-retry');
  // First failure is NOT retried — surfaced + resumed immediately.
  const f6 = await mcp.callTool('complete_action_run', {
    run_id: run6.run_id, workspace_id: ws.id, status: 'failed', summary: 'deploy 500',
  });
  assert.equal(f6.retried, false, 'high-impact failure is NOT auto-retried');
  assert.equal(f6.exhausted, true, 'high-impact failure is surfaced immediately');
  assert.equal(f6.resumed, true, 'high-impact failure resumes the ticket for a human decision');
  const runs6b = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: hi.id });
  assert.equal(runs6b.length, 1, 'no retry run was spawned for the high-impact Action');
  const t6full = await mcp.callTool('get_ticket', { ticket_id: ticket6.id });
  assert.ok(
    (t6full.comments || []).some((c) => /HIGH-IMPACT/.test(c.content) && /NOT auto-retried/i.test(c.content)),
    'high-impact failure surfaced with a no-auto-retry explanation',
  );

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 7 — idempotency key is STABLE across bounded retries (reviewer req 4)
  // A non-high-impact retry chain must reuse ONE key so the target can dedupe.
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 7 — idempotency key stable across the retry chain');
  const keyed = await mcp.callTool('save_action', {
    workspace_id: ws.id, name: 'Keyed retry', prompt: 'x', target_agent_id: agent.id,
  });
  const ticket7 = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked keyed', assigneeId: agent.id,
  });
  const r7a = await mcp.callTool('run_action', { action_id: keyed.id, source_ticket_id: ticket7.id });
  const runs7a = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: keyed.id });
  const key7 = findRun(runs7a, r7a.run_id).idempotency_key;
  assert.ok(key7, 'attempt 1 has an idempotency key');
  const f7 = await mcp.callTool('complete_action_run', {
    run_id: r7a.run_id, workspace_id: ws.id, status: 'failed', summary: 'retry me',
  });
  assert.equal(f7.retried, true, 'non-high-impact failure retries');
  const runs7b = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: keyed.id });
  const retryKey = findRun(runs7b, f7.retry_run_id).idempotency_key;
  assert.equal(retryKey, key7, 'the retry run reuses the same idempotency key');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 8 — high-impact run WITHOUT approval is rejected + parks the ticket
  // (scope 5 pre-execution approval gate — reviewer req: unapproved rejection).
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 8 — unapproved high-impact ticket-driven run is rejected + parks the ticket');
  const gated = await mcp.callTool('save_action', {
    workspace_id: ws.id, name: 'Ship release to production', prompt: 'ship', target_agent_id: agent.id, high_impact: true,
  });
  assert.ok(!gated.isError && gated.id, 'high-impact Action registered');
  const ticket8 = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked on ship', assigneeId: agent.id,
  });
  const gatedRun = await mcp.callTool('run_action', { action_id: gated.id, source_ticket_id: ticket8.id });
  assert.equal(gatedRun.isError, true, 'high-impact run without approval is rejected BEFORE execution');
  assert.match(JSON.stringify(gatedRun.error), /approval/i, 'rejection explains approval is required');
  // No run row — the reject happens before any dispatch/side effect.
  const gatedRuns = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: gated.id });
  assert.equal(gatedRuns.length, 0, 'no ActionRun row created for the rejected high-impact run');
  // The source ticket is parked for a human (완료 기준: 승인 필요 → Pending).
  const t8 = await mcp.callTool('get_ticket', { ticket_id: ticket8.id });
  assert.equal(t8.pending_user_action, true, 'the source ticket is parked pending_user_action');
  assert.match(t8.pending_reason, /approval/i, 'the pending reason names the approval requirement');
  const parkActs = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: ticket8.id, action: 'action_run_pending_approval' },
  });
  assert.ok(parkActs.length >= 1, 'park-for-approval writes an audit row');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 9 — human approval GRANT (session endpoint) → agent run consumes it →
  // executes + records the approver FROM the grant (reviewer 4차 req: the caller
  // cannot assert the approver; approval evidence is a server-side record).
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 9 — admin session grants approval → agent run consumes it → executes + records approver');
  const ticket9 = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked on approved ship', assigneeId: agent.id,
  });
  // (a) Unapproved agent run is rejected + parks the ticket (no grant yet).
  const preRun9 = await mcp.callTool('run_action', { action_id: gated.id, source_ticket_id: ticket9.id });
  assert.equal(preRun9.isError, true, 'an unapproved high-impact run is rejected');
  const t9parked = await mcp.callTool('get_ticket', { ticket_id: ticket9.id });
  assert.equal(t9parked.pending_user_action, true, 'the unapproved run parks the ticket');

  // (b) An admin approves via the SESSION-authenticated endpoint. The approver is
  // taken from the session — the request body has no approver field — so this is
  // evidence an agent cannot forge.
  const appr9 = await approveViaRest({ actionId: gated.id, workspaceId: ws.id, sourceTicketId: ticket9.id, token: adminToken });
  assert.equal(appr9.status, 201, 'admin session creates the approval grant');
  assert.equal(appr9.body.approved_by, admin.id, 'the grant records the SESSION admin as approver (not a body value)');
  assert.equal(appr9.body.status, 'pending', 'a fresh grant is pending (unconsumed)');
  assert.equal(appr9.body.source_ticket_id, ticket9.id, 'the grant is bound to the ticket');
  // Grant creation is itself audited to the real human.
  const grantActs = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: ticket9.id, action: 'action_run_approval_granted' },
  });
  assert.ok(grantActs.length >= 1, 'grant creation writes an audit row');
  assert.equal(grantActs[0].actor_id, admin.id, 'the grant audit records the approving admin');
  // Creating the grant released the approval park so the loop can resume.
  const t9released = await mcp.callTool('get_ticket', { ticket_id: ticket9.id });
  assert.equal(t9released.pending_user_action, false, 'approval releases the ticket park');

  // (c) The agent re-runs (no approver param exists) → the server consumes the grant.
  const approvedRun = await mcp.callTool('run_action', { action_id: gated.id, source_ticket_id: ticket9.id });
  assert.ok(!approvedRun.isError, 'the run executes once a matching grant exists');
  assert.ok(approvedRun.run_id, 'the approved run has an id');
  const runs9 = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: gated.id });
  const row9 = findRun(runs9, approvedRun.run_id);
  assert.equal(row9.approved_by, admin.id, 'the run copies the approver id FROM the grant');
  assert.ok(row9.approved_at, 'the run records the approval time');
  const apprActs = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: ticket9.id, action: 'action_run_approved' },
  });
  assert.ok(apprActs.length >= 1, 'consuming the grant writes an approved audit row');
  assert.equal(apprActs[0].actor_id, admin.id, 'the approved-audit actor is the real approver from the grant');
  // The grant is now consumed and stamped with the run that used it.
  const grant9 = await ds.getRepository('ActionApproval').findOne({ where: { id: appr9.body.id } });
  assert.equal(grant9.status, 'consumed', 'the grant is marked consumed after the run');
  assert.equal(grant9.consumed_by_run_id, approvedRun.run_id, 'the grant records the consuming run');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 10 — only an admin SESSION can create a grant (reviewer req: 권한 없는
  // 승인 시도 거부). A non-admin session → 403, no session → 401, and the agent
  // (MCP, no session, no approver param) can never mint one.
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 10 — non-admin session / unauthenticated / agent cannot create an approval');
  const member = await createUser(app, getDataSourceToken, { name: 'member', role: 'user' });
  const memberToken = authService.createSession(member.id);
  const ticket10 = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked unauth approve', assigneeId: agent.id,
  });
  // A non-admin authenticated user cannot approve.
  const memberAppr = await approveViaRest({ actionId: gated.id, workspaceId: ws.id, sourceTicketId: ticket10.id, token: memberToken });
  assert.equal(memberAppr.status, 403, 'a non-admin session cannot create an approval');
  // No Authorization header at all → unauthenticated.
  const anonAppr = await approveViaRest({ actionId: gated.id, workspaceId: ws.id, sourceTicketId: ticket10.id, token: null });
  assert.equal(anonAppr.status, 401, 'an unauthenticated request cannot create an approval');
  // The agent (MCP) still cannot self-run: there is no approver parameter and no
  // grant exists, so a high-impact run is rejected + parks the ticket.
  const agentTry = await mcp.callTool('run_action', { action_id: gated.id, source_ticket_id: ticket10.id });
  assert.equal(agentTry.isError, true, 'an agent cannot self-run a high-impact action (no forgeable approver)');
  // None of the rejected attempts created a grant …
  const grants10 = await ds.getRepository('ActionApproval').find({ where: { source_ticket_id: ticket10.id } });
  assert.equal(grants10.length, 0, 'no approval grant exists after the rejected attempts');
  // … and no run row beyond CASE 9's single approved run on `gated`.
  const gatedRuns2 = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: gated.id });
  assert.equal(gatedRuns2.length, 1, 'unauthorized approval attempts created no ActionRun row');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 11 — misclassification cannot bypass the gate (reviewer req 3). An
  // Action saved high_impact=false but NAMED like a deploy is still escalated
  // by the name heuristic → gated + parked (safe default / fail-closed).
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 11 — a deploy-named Action with high_impact=false is still gated');
  const misclassified = await mcp.callTool('save_action', {
    workspace_id: ws.id, name: 'Deploy to production', prompt: 'deploy', target_agent_id: agent.id,
  });
  assert.ok(!misclassified.isError, 'misclassified action saves (high_impact omitted → false)');
  assert.equal(misclassified.high_impact, false, 'it is stored NOT explicitly flagged high_impact');
  const ticket11 = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked on misclassified deploy', assigneeId: agent.id,
  });
  const miscRun = await mcp.callTool('run_action', { action_id: misclassified.id, source_ticket_id: ticket11.id });
  assert.equal(miscRun.isError, true, 'a deploy-named action is gated even when high_impact=false');
  assert.match(JSON.stringify(miscRun.error), /approval/i, 'the name heuristic escalates it to the approval gate');
  const t11 = await mcp.callTool('get_ticket', { ticket_id: ticket11.id });
  assert.equal(t11.pending_user_action, true, 'a misclassified high-impact run parks the ticket too');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 12 — a grant is ONE-TIME (reviewer req: 재사용 거부). Consuming it once
  // executes; a second run for the same (action, ticket) finds no pending grant.
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 12 — an approval grant is one-time: a reused grant is rejected');
  const ticket12 = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked one-time', assigneeId: agent.id,
  });
  const appr12 = await approveViaRest({ actionId: gated.id, workspaceId: ws.id, sourceTicketId: ticket12.id, token: adminToken });
  assert.equal(appr12.status, 201, 'grant created for (gated, ticket12)');
  // First run consumes the grant and executes.
  const run12a = await mcp.callTool('run_action', { action_id: gated.id, source_ticket_id: ticket12.id });
  assert.ok(!run12a.isError, 'first run consumes the grant and executes');
  const grant12 = await ds.getRepository('ActionApproval').findOne({ where: { id: appr12.body.id } });
  assert.equal(grant12.status, 'consumed', 'the grant is consumed by the first run');
  assert.equal(grant12.consumed_by_run_id, run12a.run_id, 'the grant records the consuming run');
  // A second run for the same pair has no pending grant → rejected + re-parked.
  const run12b = await mcp.callTool('run_action', { action_id: gated.id, source_ticket_id: ticket12.id });
  assert.equal(run12b.isError, true, 'a second run cannot reuse the consumed grant');
  assert.match(JSON.stringify(run12b.error), /approval/i, 'the reuse rejection names the approval requirement');
  const t12 = await mcp.callTool('get_ticket', { ticket_id: ticket12.id });
  assert.equal(t12.pending_user_action, true, 'the reused-grant rejection re-parks the ticket');
  const runs12 = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: gated.id });
  assert.equal(runs12.filter((r) => r.source_ticket_id === ticket12.id).length, 1, 'exactly one run executed under the one-time grant');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 13 — a grant is BOUND to one (action, ticket) (reviewer req: 다른
  // ticket·action 전용 거부). It does not authorize a different ticket or action.
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 13 — a grant is bound: another ticket or another action is not authorized');
  const ticket13a = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked bound approved', assigneeId: agent.id,
  });
  const ticket13b = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked bound unapproved', assigneeId: agent.id,
  });
  // A second high-impact action to prove action-binding.
  const otherHi = await mcp.callTool('save_action', {
    workspace_id: ws.id, name: 'Publish to production', prompt: 'publish', target_agent_id: agent.id, high_impact: true,
  });
  const appr13 = await approveViaRest({ actionId: gated.id, workspaceId: ws.id, sourceTicketId: ticket13a.id, token: adminToken });
  assert.equal(appr13.status, 201, 'grant created for (gated, ticket13a)');
  // Same action, DIFFERENT ticket → not authorized.
  const wrongTicket = await mcp.callTool('run_action', { action_id: gated.id, source_ticket_id: ticket13b.id });
  assert.equal(wrongTicket.isError, true, 'the grant does not authorize a different ticket');
  // DIFFERENT action, the approved ticket → not authorized.
  const wrongAction = await mcp.callTool('run_action', { action_id: otherHi.id, source_ticket_id: ticket13a.id });
  assert.equal(wrongAction.isError, true, 'the grant does not authorize a different action');
  // Neither mismatched attempt consumed the bound grant — it is still pending.
  const grant13 = await ds.getRepository('ActionApproval').findOne({ where: { id: appr13.body.id } });
  assert.equal(grant13.status, 'pending', 'a mismatched attempt does not consume the bound grant');
  // The exact (action, ticket) pair consumes it and runs.
  const rightRun = await mcp.callTool('run_action', { action_id: gated.id, source_ticket_id: ticket13a.id });
  assert.ok(!rightRun.isError, 'the exact (action, ticket) pair consumes the grant and runs');
  const grant13b = await ds.getRepository('ActionApproval').findOne({ where: { id: appr13.body.id } });
  assert.equal(grant13b.status, 'consumed', 'the bound grant is consumed only by its exact pair');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 14 — an EXPIRED grant does not authorize a run (reviewer req: 미사용·
  // 미만료 record only). A grant past expires_at is treated as absent + retired.
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 14 — an expired approval grant is rejected + retired');
  const ticket14 = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked expired grant', assigneeId: agent.id,
  });
  const appr14 = await approveViaRest({ actionId: gated.id, workspaceId: ws.id, sourceTicketId: ticket14.id, token: adminToken });
  assert.equal(appr14.status, 201, 'grant created for (gated, ticket14)');
  // Age it into the past (a real standing approval that timed out before use).
  await ds.getRepository('ActionApproval').update({ id: appr14.body.id }, { expires_at: new Date(Date.now() - 60_000) });
  const run14 = await mcp.callTool('run_action', { action_id: gated.id, source_ticket_id: ticket14.id });
  assert.equal(run14.isError, true, 'an expired grant does not authorize a run');
  assert.match(JSON.stringify(run14.error), /approval/i, 'the expired-grant rejection names the approval requirement');
  const grant14 = await ds.getRepository('ActionApproval').findOne({ where: { id: appr14.body.id } });
  assert.equal(grant14.status, 'expired', 'the gate retires the expired grant');
  const t14 = await mcp.callTool('get_ticket', { ticket_id: ticket14.id });
  assert.equal(t14.pending_user_action, true, 'an expired-grant run parks the ticket');

  // ─────────────────────────────────────────────────────────────────────────
  // CASE 15 — an expired grant must NOT shadow a newer VALID grant (reviewer 5차
  // blocker). With `expired A + valid B` on the same (action, ticket), the old
  // consume query hit the oldest grant A, retired it, and gave up — rejecting a
  // legitimately-approved run and re-parking the ticket. A SINGLE agent run must
  // now retire A, consume B, execute, and leave the ticket un-parked.
  // ─────────────────────────────────────────────────────────────────────────
  step('CASE 15 — expired grant does not shadow a newer valid grant (single run consumes B)');
  const ticket15 = await createTicket(app, getDataSourceToken, {
    columnId: col.id, workspaceId: ws.id, title: 'blocked expired-then-valid', assigneeId: agent.id,
  });
  // Grant A — created first, then forced into the past (expired) AND back-dated so
  // it is unambiguously the OLDEST pending grant the ASC-ordered consume sees first.
  // (created_at is second-precision on sqlite, so without back-dating A and B could
  // tie and the buggy path would flake instead of failing deterministically.)
  const apprA = await approveViaRest({ actionId: gated.id, workspaceId: ws.id, sourceTicketId: ticket15.id, token: adminToken });
  assert.equal(apprA.status, 201, 'grant A created for (gated, ticket15)');
  await ds.getRepository('ActionApproval').update(
    { id: apprA.body.id },
    { expires_at: new Date(Date.now() - 60_000), created_at: new Date(Date.now() - 120_000) },
  );
  // Grant B — a fresh, still-valid approval for the SAME (action, ticket) pair (the
  // admin re-approved after A timed out). Newer than A, so the old query never
  // reached it.
  const apprB = await approveViaRest({ actionId: gated.id, workspaceId: ws.id, sourceTicketId: ticket15.id, token: adminToken });
  assert.equal(apprB.status, 201, 'valid grant B created for the same (action, ticket)');
  // Guard the test's own premise: A must be strictly older than B (so the buggy
  // path really did hit the expired A first and bail).
  const gA = await ds.getRepository('ActionApproval').findOne({ where: { id: apprA.body.id } });
  const gB = await ds.getRepository('ActionApproval').findOne({ where: { id: apprB.body.id } });
  assert.ok(
    new Date(gA.created_at).getTime() < new Date(gB.created_at).getTime(),
    'grant A is unambiguously older than B',
  );
  // Issuing B released the approval park — the ticket is not pending going in.
  const t15pre = await mcp.callTool('get_ticket', { ticket_id: ticket15.id });
  assert.equal(t15pre.pending_user_action, false, 'a fresh valid grant leaves the ticket un-parked');
  // A SINGLE run must succeed: retire A, consume B, execute — no re-park.
  const run15 = await mcp.callTool('run_action', { action_id: gated.id, source_ticket_id: ticket15.id });
  assert.ok(!run15.isError, 'a single run consumes the valid grant B despite the older expired A');
  assert.ok(run15.run_id, 'the approved run has an id');
  // A is retired, B is the one consumed by this exact run.
  const grantA15 = await ds.getRepository('ActionApproval').findOne({ where: { id: apprA.body.id } });
  assert.equal(grantA15.status, 'expired', 'the older expired grant A is retired');
  const grantB15 = await ds.getRepository('ActionApproval').findOne({ where: { id: apprB.body.id } });
  assert.equal(grantB15.status, 'consumed', 'the newer valid grant B is the one consumed');
  assert.equal(grantB15.consumed_by_run_id, run15.run_id, 'grant B records the consuming run');
  const runs15 = await mcp.callTool('list_action_runs', { workspace_id: ws.id, action_id: gated.id });
  assert.equal(findRun(runs15, run15.run_id).approved_by, admin.id, 'the run copies the approver id from the consumed grant');
  // The (retired) expired grant did NOT re-park the ticket — the whole point.
  const t15 = await mcp.callTool('get_ticket', { ticket_id: ticket15.id });
  assert.equal(t15.pending_user_action, false, 'the valid run does NOT re-park the ticket');

  await mcp.close();
  exitAfterTests(0);
});
