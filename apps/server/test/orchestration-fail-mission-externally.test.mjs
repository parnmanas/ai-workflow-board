// OrchestrationRunnerService.failMissionExternally()에 대한 직접 단위 테스트
// (티켓 bf350dc8) — 스텁이 아닌 실제 구현을 구동한다. 이 메서드를 완전히
// 스텁으로 대체하고 리퍼가 그 반환값에 맞춰 올바르게 반응하는지만 확인하는
// orchestration-reaper-behavior.test.mjs와 달리, 이 파일은 실제 메서드를
// in-memory fake repo에 대해 그대로 구동한다 — 그래서 리퍼의 스냅샷-vs-락
// 레이스를 고치는 락+fresh-read 분기 로직 자체가 커버리지에 포함된다:
//
//   • 실제로 stalled된 미션은 `failed`로 승격되고, 남아있는 non-terminal
//     스텝은 취소된다 — 수정 전 인라인 코드와 동일한 최종 상태
//   • 이미 terminal인 미션                                -> skip(false)
//   • fresh 재조회 결과 expectedStatus와 더 이상 안 맞음(동시에 들어온
//     submit_orchestration_plan이 이미 상태를 옮겨놓음)    -> skip(false)
//   • `running` 케이스에서 fresh 재조회에 in-flight 스텝이 잡힘(nudge가
//     막 replan/dispatch를 유발함)                          -> skip(false)
//   • 같은 미션을 두고 경쟁하는 두 호출은 withMissionLock으로 직렬화된다 —
//     두 번째 호출의 fresh read는 첫 번째 호출이 커밋한 결과를 그대로 보고
//     이중 승격/이중 취소 없이 skip한다
//
// Nest DI를 거치지 않고 OrchestrationRunnerService를 fake repo들과 함께 직접
// 생성한다 — orchestration-reaper-behavior.test.mjs가 OrchestrationReaperService
// 의존성을 흉내내는 방식과 동일하다. failMissionExternally가 실제로 건드리는
// 생성자 시임(missionRepo, stepRepo, missions.requireMission/listSteps/
// recordEvent, logService)만 진짜처럼 동작하면 되고, 나머지(teamRepo,
// memberRepo, roomRepo, participantRepo, agentRepo, messaging, teams)는 아무
// 동작도 하지 않는 자리채움이다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrchestrationRunnerService } from '../dist/modules/orchestration/orchestration-runner.service.js';

const MIN = 60_000;

function matches(row, where) {
  return Object.entries(where || {}).every(([key, cond]) => row[key] === cond);
}

function makeRepo(rows) {
  return {
    rows,
    async find(opts = {}) {
      return rows.filter((r) => matches(r, opts.where));
    },
    async findOne({ where }) {
      return rows.find((r) => matches(r, where)) ?? null;
    },
    // find()/findOne()이 반환하는 행은 rows에 저장된 것과 같은 객체 참조이므로
    // 서비스의 in-place mutation이 이미 반영돼 있다 — save()는 호출 여부만
    // 기록하면 된다(orchestration-reaper-behavior.test.mjs의 fake와 동일 패턴).
    async save(rowOrRows) {
      return rowOrRows;
    },
  };
}

function makeMission(id, overrides = {}) {
  return {
    id,
    workspace_id: 'ws-1',
    team_id: 'team-1',
    title: `Mission ${id}`,
    status: 'running',
    room_id: 'room-1',
    result_summary: '',
    failure_reason: '',
    step_timeout_minutes: 90,
    started_at: null,
    finished_at: null,
    created_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makeStep(id, missionId, status, overrides = {}) {
  return {
    id,
    mission_id: missionId,
    status,
    assignee_agent_id: 'agent-member',
    finished_at: null,
    started_at: null,
    dispatched_at: null,
    ...overrides,
  };
}

const noopLog = { info() {}, warn() {}, error() {} };

function makeService({ missions = [], steps = [] } = {}) {
  const missionRepo = makeRepo(missions);
  const stepRepo = makeRepo(steps);
  const recordedEvents = [];
  const missionsStub = {
    async requireMission(missionId) {
      const m = missions.find((row) => row.id === missionId);
      if (!m) throw new Error(`fixture has no mission ${missionId}`);
      return m;
    },
    async listSteps(missionId) {
      return steps.filter((s) => s.mission_id === missionId);
    },
    async recordEvent(mission, input) {
      recordedEvents.push({ mission_id: mission.id, type: input.type, message: input.message });
    },
  };
  const inert = {};
  // 생성자 인자 순서는 orchestration-runner.service.ts의 선언과 동일하다:
  // missionRepo, stepRepo, teamRepo, memberRepo, roomRepo, participantRepo,
  // agentRepo, actionRepo, dataSource, messaging, missions, teams,
  // actionsService, logService (티켓 2dc3c62f로 actionRepo/dataSource/
  // actionsService 3개가 추가됨). failMissionExternally는 이 중 missionRepo/
  // stepRepo/missions/logService만 건드리므로 나머지는 빈 자리채움으로 충분하다.
  const runner = new OrchestrationRunnerService(
    missionRepo,
    stepRepo,
    makeRepo([]),
    makeRepo([]),
    makeRepo([]),
    makeRepo([]),
    makeRepo([]),
    makeRepo([]),
    inert,
    inert,
    missionsStub,
    inert,
    inert,
    noopLog,
  );
  return { runner, missionRepo, stepRepo, recordedEvents };
}

test('failMissionExternally: promotes a genuinely stalled mission — fails it, cancels dangling non-terminal steps, records a mission_failed event', async () => {
  const NOW = new Date('2026-06-22T21:00:00Z');
  const mission = makeMission('m1', { status: 'running' });
  const steps = [
    makeStep('s-done', 'm1', 'done', { finished_at: new Date(NOW.getTime() - 100 * MIN) }),
    makeStep('s-dangling', 'm1', 'pending', { assignee_agent_id: null }),
  ];
  const { runner, recordedEvents } = makeService({ missions: [mission], steps });

  const result = await runner.failMissionExternally('m1', 'running', 'no in-flight work for 100 minutes', NOW);

  assert.equal(result, true);
  assert.equal(mission.status, 'failed');
  assert.equal(mission.failure_reason, 'no in-flight work for 100 minutes');
  assert.equal(mission.finished_at, NOW);
  const dangling = steps.find((s) => s.id === 's-dangling');
  assert.equal(dangling.status, 'cancelled');
  assert.equal(dangling.finished_at, NOW);
  const done = steps.find((s) => s.id === 's-done');
  assert.equal(done.status, 'done', '이미 terminal인 스텝은 건드리지 않는다');
  assert.ok(recordedEvents.some((e) => e.mission_id === 'm1' && e.type === 'mission_failed'));
});

test('failMissionExternally: an already-terminal mission is skipped — no double-fail, no event', async () => {
  const NOW = new Date('2026-06-22T21:00:00Z');
  const mission = makeMission('m1', { status: 'completed', failure_reason: '', finished_at: new Date('2026-06-20T00:00:00Z') });
  const { runner, recordedEvents } = makeService({ missions: [mission], steps: [] });

  const result = await runner.failMissionExternally('m1', 'running', 'stale snapshot', NOW);

  assert.equal(result, false);
  assert.equal(mission.status, 'completed', 'terminal 미션은 그대로 유지된다');
  assert.equal(mission.failure_reason, '', 'failure_reason이 덮어써지지 않는다');
  assert.equal(recordedEvents.length, 0);
});

test('failMissionExternally: a fresh status mismatch (concurrent submit_orchestration_plan moved planning -> running) is skipped', async () => {
  const NOW = new Date('2026-06-22T21:00:00Z');
  // 리퍼는 스냅샷에서 'planning'을 봤지만, 락을 잡기 전 다른 호출이 이미
  // submit_orchestration_plan으로 'running'까지 옮겨놓은 상황을 흉내낸다.
  const mission = makeMission('m1', { status: 'running' });
  const { runner, recordedEvents } = makeService({ missions: [mission], steps: [] });

  const result = await runner.failMissionExternally('m1', 'planning', 'orchestrator never submitted a plan', NOW);

  assert.equal(result, false);
  assert.equal(mission.status, 'running', '리퍼의 stale snapshot이 실제 상태를 덮어쓰지 않는다');
  assert.equal(recordedEvents.length, 0);
});

test('failMissionExternally: running case with a fresh in-flight step (a nudge just landed a dispatch) is skipped', async () => {
  const NOW = new Date('2026-06-22T21:00:00Z');
  const mission = makeMission('m1', { status: 'running' });
  const steps = [
    makeStep('s-done', 'm1', 'done', { finished_at: new Date(NOW.getTime() - 100 * MIN) }),
    // 리퍼의 스냅샷 시점엔 in-flight 스텝이 없었지만, 락을 잡기 직전 replan이
    // 막 dispatch한 스텝이 fresh 재조회에는 잡히는 상황.
    makeStep('s-just-dispatched', 'm1', 'dispatched', { dispatched_at: NOW }),
  ];
  const { runner, recordedEvents } = makeService({ missions: [mission], steps });

  const result = await runner.failMissionExternally('m1', 'running', 'no in-flight work for 100 minutes', NOW);

  assert.equal(result, false);
  assert.equal(mission.status, 'running', '방금 dispatch된 작업이 있으므로 더 이상 stalled가 아니다');
  const justDispatched = steps.find((s) => s.id === 's-just-dispatched');
  assert.equal(justDispatched.status, 'dispatched', '진행 중인 스텝은 건드리지 않는다');
  const done = steps.find((s) => s.id === 's-done');
  assert.equal(done.status, 'done');
  assert.equal(recordedEvents.length, 0);
});

test('failMissionExternally: two calls racing for the same mission serialize through withMissionLock — the second sees the first\'s fresh committed result and skips', async () => {
  const NOW = new Date('2026-06-22T21:00:00Z');
  const mission = makeMission('m1', { status: 'running' });
  const steps = [makeStep('s-dangling', 'm1', 'pending', { assignee_agent_id: null })];
  const { runner, recordedEvents } = makeService({ missions: [mission], steps });

  // withMissionLock은 미션별 promise 체인이라, 같은 tick에 발행된 두 호출은
  // 항상 호출 순서대로 직렬화된다 — 첫 호출의 fn(포함된 모든 await)이 완전히
  // 끝난 뒤에야 두 번째 호출의 fn이 시작된다. 이게 바로 이 티켓이 고치는
  // 레이스의 핵심 메커니즘: 두 번째 호출은 절대 stale snapshot을 못 보고,
  // 항상 첫 호출이 커밋한 fresh 상태를 재조회한다.
  const [r1, r2] = await Promise.all([
    runner.failMissionExternally('m1', 'running', 'reason A', NOW),
    runner.failMissionExternally('m1', 'running', 'reason B', NOW),
  ]);

  assert.equal(r1, true, '먼저 락을 획득한 호출이 실제로 승격한다');
  assert.equal(r2, false, '두 번째 호출은 fresh 재조회에서 이미 terminal임을 보고 건너뛴다');
  assert.equal(mission.status, 'failed');
  assert.equal(mission.failure_reason, 'reason A', '승격은 정확히 한 번만 일어난다');
  assert.equal(
    recordedEvents.filter((e) => e.type === 'mission_failed').length,
    1,
    'mission_failed 이벤트도 정확히 한 번만 기록된다',
  );
  const dangling = steps.find((s) => s.id === 's-dangling');
  assert.equal(dangling.status, 'cancelled', '취소도 정확히 한 번만 일어난다(이중 취소 없음)');
});
