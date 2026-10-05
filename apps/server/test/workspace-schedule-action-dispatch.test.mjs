// Account Schedule 이 등록된 Action 을 실행한다.
//
// 이관의 핵심은 "크론 필드를 옮겼다" 가 아니라 **발화 경로가 하나로 합쳐졌다** 는
// 것이다. Action 형태 스케줄은 자기가 방을 만들지 않고 `ActionsService.dispatch` 를
// 그대로 부른다 — 수동 Run 버튼과 완전히 같은 경로다. 그래서 예약 실행에도
// ActionRun 기록 · batch · high_impact 승인 게이트 · fan-out 이 전부 그대로 붙는다.
// 여기서 스케줄러가 방을 직접 만들면 그 모든 것이 예약 실행에서만 조용히 빠진다.
//
// 이 파일이 고정하는 것:
//   1. Action 형태는 ActionsService.dispatch 로 간다 (방을 직접 만들지 않는다).
//   2. `task_prompt` 와 `action_id` 는 정확히 택일 — 저장 시점에 거부한다.
//   3. Action 이 삭제됐으면 스케줄이 스스로 꺼진다 (매 틱 실패 로그를 쌓지 않는다).

import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspaceScheduleService } from '../dist/modules/automation-schedule/automation-schedule.service.js';

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const notQuiesced = { isQuiesced: async () => false };

/** 서비스 한 대를 세운다. repo 스텁은 이 테스트가 건드리는 경로만 채운다. */
function makeService({ schedule, action, dispatchImpl, saved = [] }) {
  const scheduleRepo = {
    save: async (s) => { saved.push({ ...s }); return s; },
    findOne: async () => schedule,
    find: async () => [],
  };
  const actionRepo = { findOne: async ({ where }) => (action && action.id === where.id ? action : null) };
  const roomRepo = {
    create() { throw new Error('Action 형태는 방을 직접 만들면 안 된다 — dispatch 가 만든다'); },
    save() { throw new Error('Action 형태는 방을 직접 만들면 안 된다 — dispatch 가 만든다'); },
  };
  const participantRepo = {
    create() { throw new Error('Action 형태는 참가자를 직접 앉히면 안 된다'); },
    save() { throw new Error('Action 형태는 참가자를 직접 앉히면 안 된다'); },
  };
  // 인라인 경로는 dataSource 로 대상 identity 를 해소한다 — Action 형태는 거기에
  // 닿으면 안 된다.
  const dataSource = { getRepository() { throw new Error('Action 형태는 대상 에이전트를 직접 찾지 않는다'); } };
  const messaging = { sendMessage() { throw new Error('Action 형태는 메시지를 직접 보내지 않는다'); } };
  const actions = { dispatch: dispatchImpl ?? (async () => { throw new Error('dispatch not stubbed'); }) };

  // (schedule, room, participant, host, dataSource, messaging, log, quiesce,
  // action, actions).
  const svc = new WorkspaceScheduleService(
    scheduleRepo, roomRepo, participantRepo, /* hostRepo */ {}, dataSource, messaging, logStub,
    notQuiesced, actionRepo, actions,
  );
  return { svc, saved };
}

const ACTION = { id: 'act-1', account_id: 'ws-1', name: '보안 점검' };

test('Action 형태는 ActionsService.dispatch 로 가고 방을 직접 만들지 않는다', async () => {
  const calls = [];
  const schedule = {
    id: 'sch-1', account_id: 'ws-1', name: '매일 보안 점검',
    target_agent_id: '', task_prompt: '', action_id: 'act-1',
    cron: '0 19 * * *', interval_ms: null, enabled: true, next_run_at: null,
  };
  const { svc } = makeService({
    schedule, action: ACTION,
    dispatchImpl: async (args) => {
      calls.push(args);
      return { run: { agent_id: 'agent-9' }, room_id: 'room-7', prompt: '', batch_id: 'batch-3', runs: [{}, {}] };
    },
  });

  // roomRepo/dataSource/messaging 스텁은 전부 throw 하므로, 통과한다는 사실 자체가
  // "인라인 경로를 타지 않았다" 는 증거다.
  const result = await svc.runNow('sch-1', 'ws-1');

  assert.deepEqual(calls, [{ actionId: 'act-1', triggeredByType: 'system', triggeredById: '' }]);
  assert.equal(result.dispatch.room_id, 'room-7', 'Action 이 만든 방을 그대로 돌려준다');
  assert.equal(result.dispatch.agent_id, 'agent-9');
  assert.equal(result.dispatch.batch_id, 'batch-3', 'batch 키가 보존돼야 fan-out 을 추적할 수 있다');
});

test('Action 이 삭제됐으면 스케줄이 스스로 꺼진다', async () => {
  const schedule = {
    id: 'sch-2', account_id: 'ws-1', name: '고아 스케줄',
    target_agent_id: '', task_prompt: '', action_id: 'act-gone',
    cron: '0 19 * * *', interval_ms: null, enabled: true, next_run_at: new Date(),
  };
  const { svc, saved } = makeService({ schedule, action: ACTION });

  // 영영 성공할 수 없는 것이 확정이라 재시도에 의미가 없다 — 매일 실패 로그를
  // 쌓는 대신 꺼서 운영자 눈에 띄게 한다.
  await assert.rejects(() => svc.runNow('sch-2', 'ws-1'), /action not found/);
  const off = saved.find((s) => s.enabled === false);
  assert.ok(off, '비활성으로 저장돼야 한다');
  assert.equal(off.next_run_at, null, '커서도 비워야 틱이 다시 집지 않는다');
});

// ─── 택일 검증 ────────────────────────────────────────────────────────────

/** create() 만 쓰는 최소 서비스. */
function makeCreator(action) {
  const savedRows = [];
  const svc = new WorkspaceScheduleService(
    { save: async (s) => { savedRows.push(s); return s; }, create: (d) => ({ ...d }), findOne: async () => null, find: async () => [] },
    {}, {}, /* hostRepo */ {}, /* dataSource */ {}, {}, logStub,
    notQuiesced,
    { findOne: async ({ where }) => (action && action.id === where.id ? action : null) },
    {},
  );
  return { svc, savedRows };
}

test('task_prompt 와 action_id 를 둘 다 주면 거부한다', async () => {
  const { svc } = makeCreator(ACTION);
  // 둘 다 허용하면 "어느 쪽이 이기는가" 가 dispatch 구현 세부에 숨는다 — 편집한
  // 사람이 자기가 무엇을 예약했는지 화면만 보고 알 수 없게 된다.
  await assert.rejects(
    () => svc.create({ accountId: 'ws-1', name: 'x', taskPrompt: '할 일', actionId: 'act-1', cron: '0 1 * * *' }),
    /exactly one of task_prompt or action_id/,
  );
});

test('둘 다 없으면 거부한다', async () => {
  const { svc } = makeCreator(ACTION);
  await assert.rejects(
    () => svc.create({ accountId: 'ws-1', name: 'x', cron: '0 1 * * *' }),
    /one of task_prompt or action_id is required/,
  );
});

test('없는 Action / 다른 워크스페이스의 Action 은 거부한다', async () => {
  const { svc } = makeCreator(ACTION);
  await assert.rejects(
    () => svc.create({ accountId: 'ws-1', name: 'x', actionId: 'nope', cron: '0 1 * * *' }),
    /action not found/,
  );
  // 스케줄은 자기 워크스페이스 안에서만 무언가를 일으킬 수 있다.
  await assert.rejects(
    () => svc.create({ accountId: 'ws-other', name: 'x', actionId: 'act-1', cron: '0 1 * * *' }),
    /different workspace/,
  );
});

test('Action 형태로 저장하면 대상·프롬프트는 비워 둔다', async () => {
  const { svc, savedRows } = makeCreator(ACTION);
  await svc.create({
    accountId: 'ws-1', name: '매일 보안 점검', actionId: 'act-1',
    targetAgentId: 'stale-agent', cron: '0 19 * * *',
  });
  const row = savedRows[0];
  assert.equal(row.action_id, 'act-1');
  // 남겨 두면 화면에 실행되지 않을 값이 계속 보인다.
  assert.equal(row.target_agent_id, '');
  assert.equal(row.task_prompt, '');
});
