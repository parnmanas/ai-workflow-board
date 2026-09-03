// Lease fencing · heartbeat · needs_recovery 단위 테스트 (티켓 4d065f82).
//
// 실제 OrchestrationRunnerService / OrchestrationReaperService 구현을 in-memory
// fake repo 위에서 그대로 구동한다 — orchestration-fail-mission-externally.test.mjs 와
// orchestration-reaper-behavior.test.mjs 가 확립한 생성자 시임을 그대로 쓴다.
//
// 커버하는 결함 세 가지(전부 이 티켓 이전 코드에서 실패함을 확인):
//
//   1. 재시도가 fencing 되지 않았다
//      기존 `visit` 가드는 graph 미션의 loop 재진입 축만 막는다. 재시도는 `attempt`만
//      올리고 `visit`은 그대로 두므로, 재디스패치로 밀려난 attempt 1 의 subagent 가
//      뒤늦게 보고하면 status 가 terminal 이 아니라 가드를 통과해 attempt 2 의
//      in-flight 상태를 덮어썼다. wave 미션이든 graph 미션이든 마찬가지였다.
//
//   2. heartbeat 가 inactivity timeout 을 리셋하지 못했다
//      리퍼 기준선이 `started_at ?? dispatched_at` 인데 `started_at` 은 최초 progress
//      호출에서 한 번만 찍히고 이후 갱신되지 않는다. MCP 툴 설명("resets the step's
//      inactivity timeout")과 리퍼 주석이 약속한 계약이 두 번째 heartbeat 부터
//      거짓이었고, 계속 살아있다고 보고하는 step 도 결국 시간 초과로 죽었다.
//
//   3. 비멱등 작업이 자동 재실행 경로로 들어갔다
//      lease 만료는 무조건 `failed` 였고, `failed` 는 orchestrator 가 정상 실패 처리로
//      다시 띄울 수 있는 상태다. 배포·결제·게시처럼 "한 번 더"가 그 자체로 피해인
//      작업에는 그게 바로 막아야 할 동작이다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrchestrationRunnerService } from '../dist/modules/orchestration/orchestration-runner.service.js';
import { OrchestrationReaperService } from '../dist/modules/orchestration/orchestration-reaper.service.js';

const MIN = 60_000;

function matches(row, where) {
  return Object.entries(where || {}).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && ('_value' in cond || '_type' in cond)) {
      const values = cond._value ?? cond._object ?? [];
      return values.includes(row[key]);
    }
    return row[key] === cond;
  });
}

function makeRepo(rows) {
  return {
    rows,
    async find(opts = {}) {
      const { where, order, take } = opts;
      let out = rows.filter((r) => matches(r, where));
      if (order) {
        const [[key, dir]] = Object.entries(order);
        out = [...out].sort((a, b) => {
          const av = a[key] ? new Date(a[key]).getTime() : 0;
          const bv = b[key] ? new Date(b[key]).getTime() : 0;
          return dir === 'ASC' ? av - bv : bv - av;
        });
      }
      return typeof take === 'number' ? out.slice(0, take) : out;
    },
    async findOne({ where }) {
      return rows.find((r) => matches(r, where)) ?? null;
    },
    // find()/findOne()이 돌려주는 행은 rows 에 저장된 것과 같은 객체 참조라
    // 서비스의 in-place mutation 이 이미 반영돼 있다 — save()는 호출 기록만 한다.
    async save(rowOrRows) {
      return rowOrRows;
    },
  };
}

const noopLog = { info() {}, warn() {}, error() {} };
const inert = new Proxy({}, { get: () => async () => undefined });

function makeMission(overrides = {}) {
  return {
    id: 'm-1',
    workspace_id: 'ws-1',
    team_id: 'team-1',
    title: 'Mission',
    status: 'running',
    room_id: 'room-mission',
    orchestrator_agent_id: 'agent-orch',
    step_timeout_minutes: 90,
    graph_spec: null,
    max_parallel_steps: 4,
    result_summary: '',
    failure_reason: '',
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

function makeStep(overrides = {}) {
  return {
    id: 's-1',
    mission_id: 'm-1',
    workspace_id: 'ws-1',
    team_id: 'team-1',
    step_key: 'deploy',
    title: 'Deploy the thing',
    instructions: '',
    acceptance_criteria: '',
    depends_on: null,
    assignee_agent_id: 'agent-member',
    status: 'dispatched',
    position: 0,
    plan_version: 1,
    room_id: 'room-step',
    result_summary: '',
    artifacts: null,
    attempt: 1,
    max_attempts: 3,
    visit: 1,
    verdict: '',
    lease_token: 'lease-attempt-1',
    last_heartbeat_at: null,
    retry_policy: 'auto',
    recovery_reason: '',
    dispatched_at: new Date('2026-06-01T00:00:00Z'),
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

/** 실제 runner 를 fake repo 위에 세운다. 보고 경로가 실제로 건드리는 시임만 진짜다. */
function makeRunner({ mission, steps }) {
  const missionRepo = makeRepo([mission]);
  const stepRepo = makeRepo(steps);
  const recorded = [];
  const missionsStub = {
    async requireMission(id) {
      const m = missionRepo.rows.find((r) => r.id === id);
      if (!m) throw Object.assign(new Error('mission not found'), { status: 404 });
      return m;
    },
    async requireStep(id) {
      const s = stepRepo.rows.find((r) => r.id === id);
      if (!s) throw Object.assign(new Error('step not found'), { status: 404 });
      return s;
    },
    async listSteps(missionId) {
      return stepRepo.rows.filter((s) => s.mission_id === missionId);
    },
    async recordEvent(m, input) {
      recorded.push({ mission_id: m.id, type: input.type, message: input.message, data: input.data ?? null });
    },
  };
  const agentRepo = makeRepo([
    { id: 'agent-member', name: 'Member', workspace_id: 'ws-1', is_online: true },
    { id: 'agent-orch', name: 'Orchestrator', workspace_id: 'ws-1', is_online: true },
  ]);
  const runner = new OrchestrationRunnerService(
    missionRepo,
    stepRepo,
    makeRepo([]),
    makeRepo([]),
    makeRepo([]),
    makeRepo([]),
    agentRepo,
    makeRepo([]),
    makeRepo([]),
    inert,
    inert,
    missionsStub,
    inert,
    inert,
    noopLog,
  );
  return { runner, recorded, stepRepo, missionRepo };
}

// ── 1. 재시도 fencing ────────────────────────────────────────────────────────

test('재디스패치로 밀려난 attempt 의 지각 보고는 lease 토큰으로 거부된다', async () => {
  // wave 미션(graph_spec=null) — 기존 visit 가드가 아예 적용되지 않는 기본 경로다.
  const mission = makeMission();
  const step = makeStep({ attempt: 2, lease_token: 'lease-attempt-2' });
  const { runner, recorded, stepRepo } = makeRunner({ mission, steps: [step] });

  await assert.rejects(
    () =>
      runner.reportStep(step.id, 'agent-member', {
        status: 'done',
        summary: '지각 보고: 이미 재시도로 밀려난 attempt 1 의 결과',
        lease_token: 'lease-attempt-1',
      }),
    (e) => {
      assert.match(String(e.message), /stale result report|no longer valid/i);
      assert.equal(e.status, 409);
      return true;
    },
    'superseded lease 를 들고 온 보고는 409 로 거부돼야 한다',
  );

  // 거부가 상태를 건드리지 않았는지 — 이게 무너지면 fencing 이 무의미하다.
  const after = stepRepo.rows.find((s) => s.id === step.id);
  assert.equal(after.status, 'dispatched', 'attempt 2 는 in-flight 그대로여야 한다');
  assert.equal(after.result_summary, '', '지각 보고의 summary 가 새겨지면 안 된다');
  assert.equal(after.finished_at, null);

  // 거부 사실이 타임라인에 남아야 "왜 내 결과가 반영 안 됐나"를 설명할 수 있다.
  const rejected = recorded.filter((e) => e.type === 'step_lease_rejected');
  assert.equal(rejected.length, 1, 'step_lease_rejected 이벤트가 정확히 하나 남아야 한다');
  assert.equal(rejected[0].data.reason, 'superseded');
  assert.equal(rejected[0].data.attempt, 2);
});

test('lease 토큰을 생략한 보고도 거부된다 — 누락으로 가드를 우회할 수 없다', async () => {
  // a3958947 에서 visit 가드가 배운 교훈과 같은 실패 모드: optional 로 두면 stale
  // 작업자가 필드를 그냥 빼는 것만으로 가드를 통과한다.
  const mission = makeMission();
  const step = makeStep({ attempt: 2, lease_token: 'lease-attempt-2' });
  const { runner, recorded, stepRepo } = makeRunner({ mission, steps: [step] });

  await assert.rejects(
    () => runner.reportStep(step.id, 'agent-member', { status: 'done', summary: '토큰 없는 보고' }),
    (e) => {
      assert.match(String(e.message), /requires the lease token/i);
      assert.equal(e.status, 409);
      return true;
    },
  );
  assert.equal(stepRepo.rows[0].status, 'dispatched');
  assert.equal(recorded.filter((e) => e.type === 'step_lease_rejected')[0].data.reason, 'missing');
});

test('현재 lease 를 들고 온 보고는 정상 처리된다', async () => {
  const mission = makeMission();
  const step = makeStep({ attempt: 2, lease_token: 'lease-attempt-2' });
  const { runner, stepRepo } = makeRunner({ mission, steps: [step] });

  const result = await runner.reportStep(step.id, 'agent-member', {
    status: 'done',
    summary: '정상 완료',
    lease_token: 'lease-attempt-2',
  });

  assert.equal(result.reported_status, 'done');
  assert.equal(stepRepo.rows[0].status, 'done');
  assert.equal(stepRepo.rows[0].result_summary, '정상 완료');
});

test('progress heartbeat 도 같은 lease 로 fencing 된다', async () => {
  const mission = makeMission();
  const step = makeStep({ attempt: 2, lease_token: 'lease-attempt-2' });
  const { runner, stepRepo } = makeRunner({ mission, steps: [step] });

  await assert.rejects(
    () => runner.reportProgress(step.id, 'agent-member', '아직 작업 중', 'lease-attempt-1'),
    (e) => e.status === 409,
    '밀려난 attempt 의 heartbeat 는 거부돼야 한다 — 안 그러면 죽은 attempt 가 새 attempt 의 시계를 되돌린다',
  );
  assert.equal(stepRepo.rows[0].status, 'dispatched', '거부된 heartbeat 는 running 으로 승격시키지 않는다');
  assert.equal(stepRepo.rows[0].last_heartbeat_at, null);
});

test('토큰이 없는 legacy step 은 토큰 없는 보고를 그대로 받아준다', async () => {
  // 이 기능 배포 시점에 이미 나가 있던 work order 에는 토큰이 없다. 그런 step 까지
  // 토큰을 요구하면 진행 중인 작업이 보고 자체를 못 하는 wedge 가 된다.
  const mission = makeMission();
  const step = makeStep({ lease_token: '' });
  const { runner, stepRepo } = makeRunner({ mission, steps: [step] });

  await runner.reportProgress(step.id, 'agent-member', '살아있음');
  assert.equal(stepRepo.rows[0].status, 'running');

  const result = await runner.reportStep(step.id, 'agent-member', { status: 'done', summary: 'legacy 완료' });
  assert.equal(result.reported_status, 'done');
});

// ── 2. heartbeat 가 시계를 되돌린다 ──────────────────────────────────────────

test('progress 보고는 매 호출마다 last_heartbeat_at 을 갱신한다', async () => {
  const mission = makeMission();
  const step = makeStep();
  const { runner, stepRepo } = makeRunner({ mission, steps: [step] });

  await runner.reportProgress(step.id, 'agent-member', '1차', 'lease-attempt-1');
  const first = stepRepo.rows[0].last_heartbeat_at;
  const startedAt = stepRepo.rows[0].started_at;
  assert.ok(first instanceof Date, '최초 heartbeat 가 기록돼야 한다');

  await new Promise((r) => setTimeout(r, 5));
  await runner.reportProgress(step.id, 'agent-member', '2차', 'lease-attempt-1');
  const second = stepRepo.rows[0].last_heartbeat_at;

  assert.ok(
    second.getTime() > first.getTime(),
    '두 번째 heartbeat 도 시각을 갱신해야 한다 — 이게 안 되면 "heartbeat 가 timeout 을 리셋한다"는 계약이 거짓이 된다',
  );
  assert.equal(
    stepRepo.rows[0].started_at.getTime(),
    startedAt.getTime(),
    'started_at 은 최초 착수 시각이므로 갱신되면 안 된다',
  );
});

// ── 3. 리퍼: heartbeat 기준선 + needs_recovery ───────────────────────────────

function makeReaper({ missions, steps, runner }) {
  const missionRepo = makeRepo(missions);
  const stepRepo = makeRepo(steps);
  const recorded = [];
  const missionsStub = {
    async recordEvent(m, input) {
      recorded.push({ mission_id: m.id, type: input.type });
    },
  };
  // 생성자 순서: missionRepo, stepRepo, eventRepo, teamRepo, missions, runner,
  // logService, instanceQuiesce (orchestration-reaper.service.ts 참고).
  const reaper = new OrchestrationReaperService(
    missionRepo,
    stepRepo,
    makeRepo([]),
    makeRepo([]),
    missionsStub,
    runner,
    noopLog,
    { isQuiesced: async () => false },
  );
  return { reaper, recorded };
}

test('최근 heartbeat 가 있는 step 은 started_at 이 아무리 오래돼도 살아남는다', async () => {
  // 이 티켓 이전 기준선(started_at)으로는 반드시 죽는 픽스처다: started_at 은
  // 타임아웃(90분)보다 훨씬 오래됐지만 1분 전에 살아있다고 보고했다.
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 90 });
  const step = makeStep({
    status: 'running',
    dispatched_at: new Date(now.getTime() - 240 * MIN),
    started_at: new Date(now.getTime() - 230 * MIN),
    last_heartbeat_at: new Date(now.getTime() - 1 * MIN),
  });
  const failed = [];
  const { reaper } = makeReaper({
    missions: [mission],
    steps: [step],
    runner: {
      async failStepExternally(id, reason) {
        failed.push({ id, reason });
      },
      async nudgeOrchestrator() {},
      async failMissionExternally() {
        return false;
      },
    },
  });

  await reaper.runOnce(now);

  assert.deepEqual(failed, [], '1분 전에 heartbeat 를 보낸 step 은 절대 리핑되면 안 된다');
  assert.equal(step.status, 'running');
});

test('heartbeat 가 끊긴 step 은 마지막 heartbeat 기준으로 리핑된다', async () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 90 });
  const step = makeStep({
    status: 'running',
    dispatched_at: new Date(now.getTime() - 400 * MIN),
    started_at: new Date(now.getTime() - 390 * MIN),
    last_heartbeat_at: new Date(now.getTime() - 91 * MIN),
  });
  const failed = [];
  const { reaper } = makeReaper({
    missions: [mission],
    steps: [step],
    runner: {
      async failStepExternally(id, reason) {
        failed.push({ id, reason });
      },
      async nudgeOrchestrator() {},
      async failMissionExternally() {
        return false;
      },
    },
  });

  await reaper.runOnce(now);
  assert.equal(failed.length, 1, 'heartbeat 가 타임아웃보다 오래 끊기면 리핑돼야 한다');
  assert.equal(failed[0].id, step.id);
});

test('heartbeat 를 한 번도 안 보낸 step 은 예전과 똑같이 dispatched_at 으로 잡힌다', async () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 90 });
  const step = makeStep({
    status: 'dispatched',
    dispatched_at: new Date(now.getTime() - 120 * MIN),
    started_at: null,
    last_heartbeat_at: null,
  });
  const failed = [];
  const { reaper } = makeReaper({
    missions: [mission],
    steps: [step],
    runner: {
      async failStepExternally(id) {
        failed.push(id);
      },
      async nudgeOrchestrator() {},
      async failMissionExternally() {
        return false;
      },
    },
  });

  await reaper.runOnce(now);
  assert.deepEqual(failed, [step.id], '디스패치 직후 죽은 step 을 놓치면 기존 안전망이 후퇴한다');
});

test("retry_policy='manual' step 은 lease 만료 시 needs_recovery 로 간다", async () => {
  const mission = makeMission();
  const step = makeStep({ status: 'running', retry_policy: 'manual' });
  const { runner, recorded, stepRepo } = makeRunner({ mission, steps: [step] });

  await runner.failStepExternally(step.id, '[timed out] 생존 신호가 끊겼다.');

  const after = stepRepo.rows[0];
  assert.equal(after.status, 'needs_recovery', '비멱등 작업은 failed(자동 재시도 가능)로 가면 안 된다');
  assert.match(after.recovery_reason, /retry_policy='manual'/, '사유가 노출돼야 한다');
  assert.match(after.recovery_reason, /timed out/, '원래 실패 원인도 사유에 남아야 한다');
  assert.equal(after.lease_token, '', 'lease 는 만료돼야 한다 — 늦게 살아난 subagent 가 다시 쓰지 못하게');
  assert.ok(
    recorded.some((e) => e.type === 'step_needs_recovery'),
    'needs_recovery 전환이 타임라인에 남아야 한다',
  );
});

test("retry_policy='auto'(기본) step 은 기존대로 failed 로 간다", async () => {
  const mission = makeMission();
  const step = makeStep({ status: 'running' });
  const { runner, recorded, stepRepo } = makeRunner({ mission, steps: [step] });

  await runner.failStepExternally(step.id, '[timed out] 생존 신호가 끊겼다.');

  assert.equal(stepRepo.rows[0].status, 'failed', '기본 정책의 동작은 이 티켓 이전과 동일해야 한다');
  assert.equal(stepRepo.rows[0].recovery_reason, '');
  assert.ok(recorded.some((e) => e.type === 'step_failed'));
});

test('needs_recovery step 은 명시적 retry 로만 벗어나고 사유가 지워진다', async () => {
  const mission = makeMission();
  const step = makeStep({
    status: 'needs_recovery',
    retry_policy: 'manual',
    recovery_reason: '비멱등 작업이라 자동 재실행하지 않음',
    attempt: 1,
    max_attempts: 3,
    assignee_agent_id: 'agent-member',
  });
  const { runner, stepRepo } = makeRunner({ mission, steps: [step] });

  await runner.updateStep(step.id, 'agent-orch', { action: 'retry' });

  const after = stepRepo.rows[0];
  assert.notEqual(after.status, 'needs_recovery', '명시적 retry 는 복구 상태를 벗어나야 한다');
  assert.equal(after.recovery_reason, '', '처리된 복구 사유는 지워져야 UI 가 계속 띄우지 않는다');
});

// ── 4. needs_recovery 는 절대 dispatchable 로 분류되면 안 된다 ───────────────
//
// 이 단언이 이 파일에서 가장 중요하다. `computePlanProgress`는
// TERMINAL_STEP_STATUSES 를 참조하지 않고 상태를 **직접 나열해** 분류하므로,
// 목록에 빠진 상태는 "pending / ready" 분기로 흘러 dispatchable 이 된다. 즉
// needs_recovery 를 상태 목록에만 추가하고 이 함수를 안 고치면, 자동 재실행을
// 금지하려고 만든 상태가 오히려 즉시 재디스패치를 유발한다 — 막으려던 비멱등
// 작업의 중복 실행을 정확히 그 기능이 일으킨다. 구현 중 실제로 겪은 회귀다.

test('needs_recovery step 은 dispatchable 도 waiting 도 아니고 terminal 로 분류된다', async () => {
  const { computePlanProgress } = await import('../dist/modules/orchestration/orchestration.constants.js');

  const progress = computePlanProgress([
    { step_key: 'deploy', status: 'needs_recovery', depends_on: [] },
    { step_key: 'verify', status: 'pending', depends_on: ['deploy'] },
  ]);

  assert.ok(
    !progress.dispatchable.includes('deploy'),
    'needs_recovery 가 dispatchable 이면 리퍼가 세운 복구 대기 step 을 엔진이 곧바로 다시 띄운다',
  );
  assert.ok(progress.failed.includes('deploy'), 'terminal 로 집계돼야 미션이 완료로 오인되지 않는다');
  assert.ok(
    progress.newlyBlocked.includes('verify'),
    'needs_recovery 는 하류를 오염시켜야 한다 — 아니면 하류가 영원히 pending 으로 남는다',
  );
  assert.ok(!progress.dispatchable.includes('verify'), '오염된 하류도 디스패치되면 안 된다');
});
