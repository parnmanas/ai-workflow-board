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
    // dispatchStep 은 participant/room 을 create() 로 만든다. 이게 없으면 자동
    // 재디스패치 경로가 "dispatch 실패"로 빠져 검증하려던 분기를 지나가지 못한다.
    create(row) {
      return { ...row };
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
    workspace_folder: '',
    repo_ref: null,
    checkout_mode: 'reuse',
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
  // dispatchStep 이 실제로 완주하려면 room 생성과 메시지 전송이 동작해야 한다.
  // 자동 재디스패치 경로를 검증하려면 이 둘이 inert 여서는 안 된다(그러면 dispatch
  // 실패로 빠져 'terminal' 이 나오고, 검증하려던 분기를 못 지나간다).
  let roomSeq = 0;
  const roomRepo = {
    rows: [],
    create(row) {
      return { ...row, id: `room-${++roomSeq}` };
    },
    async save(row) {
      roomRepo.rows.push(row);
      return row;
    },
    async find() {
      return roomRepo.rows;
    },
    async findOne() {
      return null;
    },
  };
  const posted = [];
  const messaging = {
    async sendMessage(roomId, _ws, _type, _id, _name, content) {
      posted.push({ roomId, content });
      return {};
    },
  };

  const runner = new OrchestrationRunnerService(
    missionRepo,
    stepRepo,
    makeRepo([]),
    makeRepo([]),
    roomRepo,
    makeRepo([]),
    agentRepo,
    makeRepo([]),
    makeRepo([]),
    inert,
    messaging,
    missionsStub,
    inert,
    inert,
    noopLog,
    // 티켓 a78cb566 — 게이트 대기 알림. 이 테스트가 confirm 게이트를 열지는 않지만,
    // undefined 로 두면 나중에 그 경로를 타는 순간 조용히 터진다.
    { scheduleGateNotice: () => {}, sendReminder: async () => ({ recipients: 0, sent: 0, failed: 0 }), settled: async () => {} },
  );
  return { runner, recorded, stepRepo, missionRepo, posted };
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

/**
 * 리퍼는 이제 만료를 보자마자 죽이지 않고 `reconcileStaleLease` 한 곳으로 넘긴다
 * (리뷰 라운드1 P0-1). 그 안에서 관측 → 재연결 요청 → 유예 → 자동 재디스패치가
 * 일어나므로, 리퍼 단위 테스트는 "언제 reconcile 을 부르는가"만 검증하고 그 안의
 * 판정은 아래 실제 runner 를 태우는 테스트가 검증한다.
 */
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
    { scheduleGateNotice: () => {}, sendReminder: async () => ({ recipients: 0, sent: 0, failed: 0 }), settled: async () => {} },
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
  const reconciled = [];
  const { reaper } = makeReaper({
    missions: [mission],
    steps: [step],
    runner: {
      async reconcileStaleLease(id) {
        reconciled.push(id);
        return 'skipped';
      },
      async nudgeOrchestrator() {},
      async failMissionExternally() {
        return false;
      },
    },
  });

  await reaper.runOnce(now);

  assert.deepEqual(reconciled, [], '1분 전에 heartbeat 를 보낸 step 은 reconcile 대상조차 되면 안 된다');
  assert.equal(step.status, 'running');
});

test('heartbeat 가 끊긴 step 은 reconcile 대상으로 넘어간다', async () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 90 });
  const step = makeStep({
    status: 'running',
    dispatched_at: new Date(now.getTime() - 400 * MIN),
    started_at: new Date(now.getTime() - 390 * MIN),
    last_heartbeat_at: new Date(now.getTime() - 91 * MIN),
  });
  const reconciled = [];
  const { reaper } = makeReaper({
    missions: [mission],
    steps: [step],
    runner: {
      async reconcileStaleLease(id, _now, graceMs, timeoutMinutes) {
        reconciled.push({ id, graceMs, timeoutMinutes });
        return 'noticed';
      },
      async nudgeOrchestrator() {},
      async failMissionExternally() {
        return false;
      },
    },
  });

  await reaper.runOnce(now);
  assert.equal(reconciled.length, 1, 'heartbeat 가 타임아웃보다 오래 끊기면 reconcile 로 넘어가야 한다');
  assert.equal(reconciled[0].id, step.id);
  assert.equal(reconciled[0].timeoutMinutes, 90, '미션의 타임아웃 설정이 그대로 전달돼야 한다');
  assert.ok(reconciled[0].graceMs > 0, '유예 창이 전달돼야 재연결 기회가 생긴다');
});

test('heartbeat 를 한 번도 안 보낸 step 도 dispatched_at 기준으로 reconcile 된다', async () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 90 });
  const step = makeStep({
    status: 'dispatched',
    dispatched_at: new Date(now.getTime() - 120 * MIN),
    started_at: null,
    last_heartbeat_at: null,
  });
  const reconciled = [];
  const { reaper } = makeReaper({
    missions: [mission],
    steps: [step],
    runner: {
      async reconcileStaleLease(id) {
        reconciled.push(id);
        return 'noticed';
      },
      async nudgeOrchestrator() {},
      async failMissionExternally() {
        return false;
      },
    },
  });

  await reaper.runOnce(now);
  assert.deepEqual(reconciled, [step.id], '디스패치 직후 죽은 step 을 놓치면 기존 안전망이 후퇴한다');
});

test('유예 중인 step 은 타임아웃 창 안이어도 재평가된다', async () => {
  // 유예 만료 판정은 runner 안에 있으므로, 리퍼가 "아직 타임아웃 창 안"이라며
  // 건너뛰어 버리면 유예가 영영 만료되지 않아 복구가 멈춘다.
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 90 });
  const step = makeStep({
    status: 'running',
    dispatched_at: new Date(now.getTime() - 10 * MIN),
    started_at: new Date(now.getTime() - 10 * MIN),
    last_heartbeat_at: new Date(now.getTime() - 1 * MIN),
    lease_stale_since: new Date(now.getTime() - 9 * MIN),
  });
  const reconciled = [];
  const { reaper } = makeReaper({
    missions: [mission],
    steps: [step],
    runner: {
      async reconcileStaleLease(id) {
        reconciled.push(id);
        return 'skipped';
      },
      async nudgeOrchestrator() {},
      async failMissionExternally() {
        return false;
      },
    },
  });

  await reaper.runOnce(now);
  assert.deepEqual(reconciled, [step.id], '유예 중 step 을 건너뛰면 유예가 만료되지 않아 복구가 멈춘다');
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

// ── 5. lease 유예 · 재연결 · 자동 재디스패치 (리뷰 라운드1 P0-1) ─────────────
//
// 이전 라운드는 만료를 보자마자 step 을 죽였다 — 요구된 "재연결 · 상태조회 · 유예 후
// 새 attempt 재디스패치"가 통째로 없었고, 복구는 orchestrator 가 손으로 retry 를
// 부를 때까지 일어나지 않았다. 아래는 실제 `reconcileStaleLease` 를 그대로 구동한다.

const GRACE = 5 * MIN;

test('lease 만료를 처음 보면 죽이지 않고 유예에 넣은 뒤 재연결을 요청한다', async () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 30 });
  const step = makeStep({
    status: 'running',
    dispatched_at: new Date(now.getTime() - 60 * MIN),
    started_at: new Date(now.getTime() - 60 * MIN),
    last_heartbeat_at: new Date(now.getTime() - 40 * MIN),
  });
  const { runner, recorded, stepRepo } = makeRunner({ mission, steps: [step] });

  const outcome = await runner.reconcileStaleLease(step.id, now, GRACE, 30);

  assert.equal(outcome, 'noticed');
  assert.equal(stepRepo.rows[0].status, 'running', '최초 관측에서 step 을 죽이면 재연결 기회가 사라진다');
  assert.ok(stepRepo.rows[0].lease_stale_since, '유예 창의 시작점이 기록돼야 한다');
  const stale = recorded.filter((e) => e.type === 'step_lease_stale');
  assert.equal(stale.length, 1, '관측이 trace 에 남아야 사후에 복구 과정을 재구성할 수 있다');
  assert.equal(typeof stale[0].data.assignee_online, 'boolean', '작업자 상태조회 결과가 함께 남아야 한다');
});

test('유예 안에 heartbeat 가 돌아오면 lease 가 되살아난다', async () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 30 });
  const step = makeStep({
    status: 'running',
    started_at: new Date(now.getTime() - 60 * MIN),
    last_heartbeat_at: new Date(now.getTime() - 40 * MIN),
    lease_stale_since: new Date(now.getTime() - 1 * MIN),
  });
  const { runner, recorded, stepRepo } = makeRunner({ mission, steps: [step] });

  // 작업자가 재연결 요청을 읽고 응답했다.
  await runner.reportProgress(step.id, 'agent-member', '아직 살아있음', 'lease-attempt-1');

  assert.equal(stepRepo.rows[0].lease_stale_since, null, 'heartbeat 는 유예를 해제해야 한다');
  assert.ok(
    recorded.some((e) => e.type === 'step_lease_recovered'),
    '재연결 성공이 trace 에 남아야 "왜 안 죽었는지"를 설명할 수 있다',
  );

  // 되살아났으므로 이어지는 스윕은 아무것도 하지 않는다.
  const outcome = await runner.reconcileStaleLease(step.id, now, GRACE, 30);
  assert.equal(outcome, 'skipped');
  assert.equal(stepRepo.rows[0].status, 'running');
});

test('유예가 지나면 새 attempt 로 자동 재디스패치된다', async () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 30 });
  const step = makeStep({
    status: 'running',
    attempt: 1,
    max_attempts: 3,
    started_at: new Date(now.getTime() - 60 * MIN),
    last_heartbeat_at: new Date(now.getTime() - 40 * MIN),
    lease_stale_since: new Date(now.getTime() - 10 * MIN),
    lease_token: 'lease-attempt-1',
  });
  const { runner, recorded, stepRepo } = makeRunner({ mission, steps: [step] });

  const outcome = await runner.reconcileStaleLease(step.id, now, GRACE, 30);

  assert.equal(
    outcome,
    'redispatched',
    // 실패 시 원인을 바로 읽을 수 있게 사유를 함께 싣는다 — dispatch 실패는 조용히
    // 'terminal' 로만 나타나서 그냥 보면 판정 로직 문제와 구분되지 않는다.
    `유예까지 지났으면 orchestrator 를 기다리지 말고 스스로 다시 띄워야 한다 (사유: ${stepRepo.rows[0].result_summary})`,
  );
  const after = stepRepo.rows[0];
  assert.equal(after.attempt, 2, '새 attempt 로 올라가야 한다');
  assert.notEqual(after.lease_token, 'lease-attempt-1', '새 lease 를 발급해 이전 attempt 의 지각 결과를 차단해야 한다');
  assert.equal(after.lease_stale_since, null, '재디스패치 후 유예 상태는 초기화돼야 한다');
  assert.equal(after.last_heartbeat_at, null, '죽은 attempt 의 heartbeat 를 물려받으면 새 attempt 의 시계가 어긋난다');
  assert.ok(recorded.some((e) => e.type === 'step_auto_redispatched'));
});

test("유예가 지나도 retry_policy='manual' 이면 자동 재실행 대신 needs_recovery 로 간다", async () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 30 });
  const step = makeStep({
    status: 'running',
    retry_policy: 'manual',
    attempt: 1,
    max_attempts: 3,
    started_at: new Date(now.getTime() - 60 * MIN),
    last_heartbeat_at: new Date(now.getTime() - 40 * MIN),
    lease_stale_since: new Date(now.getTime() - 10 * MIN),
  });
  const { runner, stepRepo } = makeRunner({ mission, steps: [step] });

  const outcome = await runner.reconcileStaleLease(step.id, now, GRACE, 30);

  assert.equal(outcome, 'terminal');
  assert.equal(stepRepo.rows[0].status, 'needs_recovery', '비멱등 작업을 자동 재실행하면 이 기능의 목적이 무너진다');
  assert.equal(stepRepo.rows[0].attempt, 1, '재디스패치가 없었으므로 attempt 도 오르면 안 된다');
  assert.match(stepRepo.rows[0].recovery_reason, /manual/i);
});

test('재시도 예산을 다 쓴 step 은 자동 재디스패치 대신 failed 로 확정된다', async () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 30 });
  const step = makeStep({
    status: 'running',
    attempt: 3,
    max_attempts: 3,
    started_at: new Date(now.getTime() - 60 * MIN),
    last_heartbeat_at: new Date(now.getTime() - 40 * MIN),
    lease_stale_since: new Date(now.getTime() - 10 * MIN),
  });
  const { runner, stepRepo } = makeRunner({ mission, steps: [step] });

  const outcome = await runner.reconcileStaleLease(step.id, now, GRACE, 30);

  assert.equal(outcome, 'terminal');
  assert.equal(stepRepo.rows[0].status, 'failed');
  assert.equal(stepRepo.rows[0].attempt, 3, '예산을 넘겨 다시 띄우면 안 된다');
  assert.match(stepRepo.rows[0].result_summary, /3/, '예산 소진 사실이 사유에 드러나야 한다');
});

// ── 6. checkpoint (리뷰 라운드1 P0-2) ────────────────────────────────────────

test('progress 의 checkpoint 는 영속화되고 이후 호출이 없다고 지워지지 않는다', async () => {
  const mission = makeMission();
  const step = makeStep();
  const { runner, recorded, stepRepo } = makeRunner({ mission, steps: [step] });

  await runner.reportProgress(step.id, 'agent-member', '1단계 끝', 'lease-attempt-1', {
    stage: 'migrated',
    processed: 120,
  });
  assert.deepEqual(stepRepo.rows[0].checkpoint, { stage: 'migrated', processed: 120 });
  assert.ok(stepRepo.rows[0].checkpoint_at, '저장 시각이 있어야 오래된 체크포인트를 판별할 수 있다');
  assert.ok(recorded.some((e) => e.type === 'step_checkpoint'), '각 저장 시점이 append-only 로 남아야 한다');

  // checkpoint 없는 heartbeat 가 기존 값을 날리면 재개 근거가 사라진다.
  await runner.reportProgress(step.id, 'agent-member', '계속 진행 중', 'lease-attempt-1');
  assert.deepEqual(
    stepRepo.rows[0].checkpoint,
    { stage: 'migrated', processed: 120 },
    'checkpoint 를 안 보낸 heartbeat 는 "변경 없음"이어야 한다',
  );

  // 새 값은 덮어쓴다(last-writer-wins).
  await runner.reportProgress(step.id, 'agent-member', '2단계 끝', 'lease-attempt-1', { stage: 'verified' });
  assert.deepEqual(stepRepo.rows[0].checkpoint, { stage: 'verified' });
});

test('자동 재디스패치는 checkpoint 를 보존해 새 attempt 가 이어서 하게 한다', async () => {
  const now = new Date('2026-06-01T05:00:00Z');
  const mission = makeMission({ step_timeout_minutes: 30 });
  const step = makeStep({
    status: 'running',
    attempt: 1,
    max_attempts: 3,
    checkpoint: { stage: 'half-done', next: 'write the report' },
    checkpoint_at: new Date(now.getTime() - 35 * MIN),
    started_at: new Date(now.getTime() - 60 * MIN),
    last_heartbeat_at: new Date(now.getTime() - 40 * MIN),
    lease_stale_since: new Date(now.getTime() - 10 * MIN),
  });
  const { runner, stepRepo } = makeRunner({ mission, steps: [step] });

  await runner.reconcileStaleLease(step.id, now, GRACE, 30);

  assert.deepEqual(
    stepRepo.rows[0].checkpoint,
    { stage: 'half-done', next: 'write the report' },
    'checkpoint 를 지우면 자동 재디스패치가 "처음부터 다시"와 같아져 재개가 성립하지 않는다',
  );
});

// ── 7. 상류 복구 시 하류 자동차단 해제 (리뷰 라운드1 P1-4) ───────────────────

test('상류를 retry 하면 자동 차단됐던 하류가 다시 실행 가능해진다', async () => {
  const mission = makeMission();
  const upstream = makeStep({
    id: 's-up',
    step_key: 'deploy',
    status: 'needs_recovery',
    retry_policy: 'manual',
    recovery_reason: '비멱등이라 자동 재실행 안 함',
    attempt: 1,
    max_attempts: 3,
  });
  const downstream = makeStep({
    id: 's-down',
    step_key: 'verify',
    status: 'blocked',
    auto_blocked: true,
    depends_on: ['deploy'],
    result_summary: '[auto-blocked] an upstream step this work depends on did not succeed',
  });
  const { runner, recorded, stepRepo } = makeRunner({ mission, steps: [upstream, downstream] });

  await runner.updateStep(upstream.id, 'agent-orch', { action: 'retry' });

  const after = stepRepo.rows.find((s) => s.id === 's-down');
  assert.notEqual(
    after.status,
    'blocked',
    '상류를 되살려도 하류가 blocked 로 남으면 미션이 영영 완료되지 않는다 — MCP 안내문이 약속한 복구가 거짓이 된다',
  );
  assert.equal(after.auto_blocked, false, '자동 차단 표시도 함께 풀려야 다음 실패에서 올바르게 다시 걸린다');
  assert.equal(after.result_summary, '', '자동 차단이 남긴 안내문은 지워져야 한다');
  assert.ok(recorded.some((e) => e.type === 'step_unblocked'));
});

test('작업자가 스스로 보고한 blocked 는 상류가 복구돼도 건드리지 않는다', async () => {
  // 자동 차단과 사람/에이전트의 "나는 할 수 없다" 판정은 다른 것이다. 후자를 엔진이
  // 임의로 되살리면 막힌 이유가 사라지지 않은 채 다시 디스패치된다.
  const mission = makeMission();
  const upstream = makeStep({ id: 's-up', step_key: 'deploy', status: 'failed', attempt: 1, max_attempts: 3 });
  const selfBlocked = makeStep({
    id: 's-down',
    step_key: 'verify',
    status: 'blocked',
    auto_blocked: false,
    depends_on: ['deploy'],
    result_summary: '접근 권한이 없어 진행할 수 없습니다',
  });
  const { runner, stepRepo } = makeRunner({ mission, steps: [upstream, selfBlocked] });

  await runner.updateStep(upstream.id, 'agent-orch', { action: 'retry' });

  const after = stepRepo.rows.find((s) => s.id === 's-down');
  assert.equal(after.status, 'blocked', '작업자가 선언한 차단을 엔진이 임의로 풀면 안 된다');
  assert.equal(after.result_summary, '접근 권한이 없어 진행할 수 없습니다', '작업자가 쓴 사유는 보존돼야 한다');
});

// ── 8. graph 쌍둥이 판정기도 같은 계약을 지켜야 한다 ────────────────────────
//
// 라운드1 에서 `computePlanProgress`(wave) 를 고쳤는데, 그래프 모드에는 **별도 판정기**
// (`computeGraphProgress`)가 있고 거기에도 상태 목록이 리터럴로 복제돼 있었다. 그래서
// 그래프 미션에서는 needs_recovery 가 여전히 dispatchable 로 흘러 복구 대기 step 이
// 즉시 재디스패치됐다 — 리뷰의 P1-4 요청(wave/graph 양쪽 production 경로 테스트)이
// 그 두 번째 사본을 드러냈다. 두 판정기를 나란히 고정한다.

test('graph 판정기도 needs_recovery 를 terminal 로 보고 dispatchable 로 흘리지 않는다', async () => {
  const { computeGraphProgress } = await import('../dist/modules/orchestration/orchestration-graph.js');

  const spec = {
    version: 1,
    nodes: [
      { key: 'deploy', kind: 'task', join: 'all', max_visits: 1 },
      { key: 'verify', kind: 'task', join: 'all', max_visits: 1 },
    ],
    edges: [{ from: 'deploy', to: 'verify', kind: 'sequence' }],
    max_total_visits: 10,
  };
  const progress = computeGraphProgress(spec, [
    { key: 'deploy', status: 'needs_recovery', visit: 1, verdict: '' },
    { key: 'verify', status: 'pending', visit: 0, verdict: '' },
  ]);

  assert.ok(
    !progress.dispatchable.includes('deploy'),
    'graph 판정기가 needs_recovery 를 dispatchable 로 보면 그래프 미션에서 비멱등 작업이 자동 재실행된다',
  );
  assert.ok(progress.failed.includes('deploy'), 'terminal 로 집계돼야 미션이 완료로 오인되지 않는다');
  assert.ok(
    progress.newlyBlocked.includes('verify'),
    '복구 대기 상류의 하류는 blocked 여야 한다 — waiting 으로 남으면 미션이 멈춘 것이 드러나지 않는다',
  );
  assert.ok(!progress.dispatchable.includes('verify'));
  assert.equal(progress.allTerminal, false, '하류가 남아 있으므로 미션은 아직 끝나지 않았다');
});
