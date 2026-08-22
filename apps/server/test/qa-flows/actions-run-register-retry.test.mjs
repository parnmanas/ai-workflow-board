// QA flow — Action 실행/등록/재시도 + pend 게이트 스코프 (티켓 524bb434).
//
// 완료 기준 커버리지("자동화 테스트에 … 포함"):
//   • 신규 Action 등록      — ActionsService.create → 영속 + enabled 기본값.
//   • 기존 Action 실행      — ActionsService.dispatch → run + ChatRoom 생성, 프롬프트 렌더.
//   • 실행 실패 / 재시도    — 없는 action id dispatch 는 loud 실패, 재실행은 독립 run.
//   • pend 게이트 스코프    — 실 DataSource 로 enabled+board 스코프 후보를 뽑아
//                             evaluatePendActionGate 가 강제/허용하는지 end-to-end.
//
// 사람 개입 필요(no_action_reason) 판정 자체는 actions-pend-gate.test.mjs 가 순수
// 함수로 고정한다 — 여기서는 실 DB 후보 조회와 붙여 재확인한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createBoard,
  createColumn,
  createTicket,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_ACTIONS_RRR_PORT || '7902';

const { loadPendActionCandidates } = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'mcp', 'shared', 'pend-action-scope.js')
);
const { evaluatePendActionGate } = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'mcp', 'shared', 'pend-action-gate.js')
);
const { ActionRunReaperService } = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'actions', 'action-run-reaper.service.js')
);

test('Actions: register new, run existing, fail + retry, and pend-gate scope end-to-end', async (t) => {
  step('Boot NestJS app');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => {
    void app.close().catch(() => {});
  });
  const { getDataSourceToken, ActionsService } = modules;
  const ds = app.get(getDataSourceToken());
  const actions = app.get(ActionsService);

  const ws = await createWorkspace(app, getDataSourceToken, 'actions');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'deployer' });

  // ── 신규 Action 등록 ──────────────────────────────────────────────
  step('Register a new Action');
  const created = await actions.create({
    workspace_id: ws.id,
    name: 'Deploy prod',
    prompt: 'Deploy {{workspace.name}} to production.',
    target_agent_id: agent.id,
  });
  assert.ok(created.id, 'new Action must persist with an id');
  assert.equal(created.name, 'Deploy prod');
  assert.equal(created.enabled, true, 'new Action is enabled by default');
  const roundtrip = await actions.get(created.id);
  assert.equal(roundtrip.id, created.id, 'the Action is readable back by id');

  // ── 기존 Action 실행 ──────────────────────────────────────────────
  step('Run the existing Action (dispatch a Run)');
  const res1 = await actions.dispatch({
    actionId: created.id,
    triggeredByType: 'agent',
    triggeredById: agent.id,
  });
  assert.ok(res1.run?.id, 'dispatch returns a run with an id');
  assert.ok(res1.room_id, 'dispatch creates a chat room');
  assert.match(res1.prompt, /production/, 'prompt was rendered from the template body');
  const runsAfter1 = await actions.listRuns(created.id, ws.id, 20);
  assert.equal(runsAfter1.length, 1, 'exactly one run recorded after the first dispatch');
  const room = await ds.getRepository('ChatRoom').findOne({ where: { id: res1.room_id } });
  assert.ok(room, 'the dispatched run has a real ChatRoom row');
  assert.equal(room.action_id, created.id, 'room is stamped with the action id');

  // ── 실행 실패 → 재시도 ────────────────────────────────────────────
  step('Execution failure: dispatching a non-existent Action rejects loudly');
  await assert.rejects(
    () =>
      actions.dispatch({
        actionId: randomUUID(),
        triggeredByType: 'agent',
        triggeredById: agent.id,
      }),
    /Action not found/,
    'dispatching an unknown action id must fail, not silently no-op',
  );

  step('Retry: re-running the real Action yields a fresh, independent run');
  const res2 = await actions.dispatch({
    actionId: created.id,
    triggeredByType: 'agent',
    triggeredById: agent.id,
  });
  assert.ok(res2.run?.id, 'retry produces a run');
  assert.notEqual(res2.run.id, res1.run.id, 'retry is a distinct run, not a duplicate of the first');
  const runsAfter2 = await actions.listRuns(created.id, ws.id, 20);
  assert.equal(runsAfter2.length, 2, 'two runs recorded after the retry');

  // ── source_ticket_id 없는 run도 complete_action_run으로 status가 정확히
  // 전이돼야 한다 (티켓 b273d603 — 이전에는 이런 run의 프롬프트에 완료 계약이
  // 아예 주입되지 않아 status가 running에 영구 고정됐다) ──────────────────
  step('Standalone run (no source_ticket_id): prompt still carries a completion contract');
  assert.match(
    res1.prompt,
    /complete_action_run/,
    'a run with no source ticket still gets a completion contract in its prompt',
  );
  assert.match(
    res1.prompt,
    new RegExp(`run_id="${res1.run.id}"`),
    'the standalone completion contract carries the correct run_id',
  );
  assert.match(
    res1.prompt,
    new RegExp(`workspace_id="${ws.id}"`),
    'the standalone completion contract carries the correct workspace_id',
  );
  assert.doesNotMatch(
    res1.prompt,
    /is paused until you report back/,
    'the standalone contract omits the ticket-resume language — there is no ticket',
  );
  // ActionRunReaperService의 스윕 범위(티켓 2fa5312b, b273d603 후속)는 이
  // 플래그로 완료 가능한 source_ticket_id 없는 run(b273d603 이후
  // 디스패치)과 계약을 못 받은 pre-fix orphan을 구분한다 — 그래서 위에서
  // 검증한 렌더링된 프롬프트 텍스트뿐 아니라 실제로 true로 영속화돼야
  // 한다.
  const persistedRun1 = (await actions.listRuns(created.id, ws.id, 20)).find((r) => r.id === res1.run.id);
  assert.equal(
    persistedRun1.completion_contract_injected, true,
    'a source_ticket_id-less run still persists completion_contract_injected=true — the reaper depends on this to admit it into its sweep scope',
  );

  step('Standalone run: completeRun(succeeded) transitions status, nothing to resume');
  const complete1 = await actions.completeRun(res1.run.id, ws.id, {
    status: 'succeeded',
    summary: 'deployed manually via UI',
  });
  assert.equal(complete1.status, 'succeeded', 'status transitions running -> succeeded');
  assert.equal(complete1.sourceTicketId, '', 'no source ticket to echo back');
  assert.equal(complete1.previouslyCompleted, false, 'first completion is not a no-op');
  assert.equal(complete1.shouldResume, false, 'nothing to resume without a source ticket');
  assert.equal(complete1.retried, false, 'a standalone run never auto-retries');
  const runsAfterComplete1 = await actions.listRuns(created.id, ws.id, 20);
  const row1 = runsAfterComplete1.find((r) => r.id === res1.run.id);
  assert.equal(row1.status, 'succeeded', 'the persisted run row reflects the new status');
  assert.ok(row1.completed_at, 'completed_at is stamped');

  step('Standalone run: completeRun(failed) also settles — no retry, nothing dispatched it');
  const complete2 = await actions.completeRun(res2.run.id, ws.id, {
    status: 'failed',
    summary: 'deploy target unreachable',
  });
  assert.equal(complete2.status, 'failed', 'status transitions running -> failed');
  assert.equal(complete2.previouslyCompleted, false, 'first completion is not a no-op');
  assert.equal(complete2.shouldResume, false, 'nothing to resume without a source ticket');
  assert.equal(complete2.retried, false, 'a standalone run never auto-retries, even on failure');
  assert.equal(complete2.exhausted, false, '"exhausted" only applies to the ticket-driven retry chain');
  const runsAfterComplete2 = await actions.listRuns(created.id, ws.id, 20);
  const row2 = runsAfterComplete2.find((r) => r.id === res2.run.id);
  assert.equal(row2.status, 'failed', 'the persisted run row reflects the failed status');
  assert.ok(row2.completed_at, 'completed_at is stamped on failure too');

  step('Standalone run: re-completing an already-terminal run is a no-op (idempotency)');
  const dupComplete = await actions.completeRun(res1.run.id, ws.id, {
    status: 'failed',
    summary: 'duplicate call, should be ignored',
  });
  assert.equal(dupComplete.previouslyCompleted, true, 'a second call on a terminal run is recognized as a duplicate');
  assert.equal(dupComplete.status, 'succeeded', 'the recorded status is unchanged by the ignored duplicate');

  // ── pend 게이트 스코프 + 판정 (실 DataSource end-to-end) ───────────
  step('Pend gate: scope query surfaces only enabled, in-scope Actions');
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'b' });
  const col = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress',
    position: 1,
    workspaceId: ws.id,
  });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: col.id,
    workspaceId: ws.id,
    title: 'blocked on deploy',
  });

  // A disabled Action must NOT count (scheduler-off = gate-off)…
  await actions.create({
    workspace_id: ws.id,
    name: 'Disabled deploy',
    prompt: 'x',
    target_agent_id: agent.id,
    enabled: false,
  });
  // …and a *different* board's board-scoped Action must NOT count either.
  await assert.rejects(
    actions.create({
      workspace_id: ws.id,
      board_id: board.id,
      name: 'Legacy board deploy',
      prompt: 'x',
      target_agent_id: agent.id,
    }),
    /Board-scoped Actions are no longer supported/,
  );

  const candidates = await loadPendActionCandidates(ds, ticket);
  const names = candidates.map((c) => c.name);
  assert.ok(names.includes('Deploy prod'), 'enabled workspace-level Action is a candidate');
  assert.ok(!names.includes('Disabled deploy'), 'disabled Action is excluded');
  assert.ok(!names.includes('Legacy board deploy'), 'rejected legacy Action is absent');

  step('Pend gate: blocks a bare pend, allows once a reason is supplied');
  const blocked = evaluatePendActionGate(candidates, undefined);
  assert.equal(blocked.allowed, false, 'pend is blocked while a runnable Action exists');
  assert.match(blocked.message, /Deploy prod/, 'the block names the runnable Action');
  const allowed = evaluatePendActionGate(
    candidates,
    'needs a human approver — no Action grants prod sign-off',
  );
  assert.equal(allowed.allowed, true, 'pend proceeds once no_action_reason is supplied');

  // ── 리퍼 스윕 범위 확장 (티켓 2fa5312b, b273d603 후속) — 실 DataSource +
  // 실 TypeORM QueryBuilder end-to-end. 페이크 기반 검증은
  // action-run-reaper-behavior.test.mjs가 wiring 관점에서 이미 담당하므로,
  // 여기서는 실제 SQL이 정확히 의도한 행만 고르는지(연산자 우선순위 실수가
  // 있었다면 여기서 드러난다)를 직접 확인한다 ──────────────────────────
  step('Reaper scope: a post-fix standalone run past TTL is reaped, a pre-fix orphan is preserved');
  const runRepo = ds.getRepository('ActionRun');
  const staleAt = new Date(Date.now() - 3 * 60 * 60_000); // 3시간 전 > 기본 2시간 TTL
  const postFixStandalone = await runRepo.save(runRepo.create({
    action_id: created.id,
    workspace_id: ws.id,
    room_id: randomUUID(),
    triggered_by_type: 'user',
    source_ticket_id: '',
    completion_contract_injected: true, // b273d603 이후 디스패치 — 완료 가능
    status: 'running',
    created_at: staleAt,
  }));
  const preFixOrphan = await runRepo.save(runRepo.create({
    action_id: created.id,
    workspace_id: ws.id,
    room_id: randomUUID(),
    triggered_by_type: 'user',
    source_ticket_id: '',
    completion_contract_injected: false, // b273d603 이전 — 완료 계약을 받은 적 없음
    status: 'running',
    created_at: staleAt,
  }));

  const reaper = app.get(ActionRunReaperService);
  const swept = await reaper.runOnce();
  const sweptIds = swept.reaped;
  assert.ok(
    sweptIds.includes(postFixStandalone.id),
    'a source_ticket_id-less run that received a completion contract must be reaped once past the TTL',
  );
  assert.ok(
    !sweptIds.includes(preFixOrphan.id),
    'a source_ticket_id-less run that never received a completion contract must be preserved, not falsely marked failed',
  );

  const postFixRow = await runRepo.findOne({ where: { id: postFixStandalone.id } });
  assert.equal(postFixRow.status, 'failed', 'the reaped standalone run settles to failed');
  const preFixRow = await runRepo.findOne({ where: { id: preFixOrphan.id } });
  assert.equal(preFixRow.status, 'running', 'the pre-fix orphan is left untouched, not contaminated with a false failed');

  exitAfterTests(0);
});
