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
  const otherBoard = await createBoard(app, getDataSourceToken, ws.id, { name: 'other' });
  await actions.create({
    workspace_id: ws.id,
    board_id: otherBoard.id,
    name: 'Other board deploy',
    prompt: 'x',
    target_agent_id: agent.id,
  });

  const candidates = await loadPendActionCandidates(ds, ticket);
  const names = candidates.map((c) => c.name);
  assert.ok(names.includes('Deploy prod'), 'enabled workspace-level Action is a candidate');
  assert.ok(!names.includes('Disabled deploy'), 'disabled Action is excluded');
  assert.ok(
    !names.includes('Other board deploy'),
    "another board's board-scoped Action is excluded",
  );

  step('Pend gate: blocks a bare pend, allows once a reason is supplied');
  const blocked = evaluatePendActionGate(candidates, undefined);
  assert.equal(blocked.allowed, false, 'pend is blocked while a runnable Action exists');
  assert.match(blocked.message, /Deploy prod/, 'the block names the runnable Action');
  const allowed = evaluatePendActionGate(
    candidates,
    'needs a human approver — no Action grants prod sign-off',
  );
  assert.equal(allowed.allowed, true, 'pend proceeds once no_action_reason is supplied');

  exitAfterTests(0);
});
