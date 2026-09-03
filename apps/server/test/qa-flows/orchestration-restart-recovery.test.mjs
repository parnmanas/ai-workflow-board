// QA flow: **실제 서버 재시작**을 사이에 둔 durable recovery (티켓 4d065f82, 리뷰 라운드2 P0).
//
// `orchestration-recovery.test.mjs` 의 축1 은 같은 프로세스·같은 서비스 인스턴스에서 DB 시각만
// 되돌리고 `reaper.runOnce()` 를 직접 불렀다 — 복구 **판정 로직**은 덮지만 "서버를 재시작하는
// 통합 테스트"라는 완료 기준 1 의 강도에는 못 미친다는 지적을 받았다. 이 파일이 그 갭을 메운다.
//
// 여기서 재시작은 시뮬레이션이 아니다:
//   1. `SQLJS_DB_PATH` 를 이 테스트 전용 파일로 고정한다(bootApp 은 이미 설정된 값을 존중한다).
//   2. 앱 A 를 부팅해 미션을 만들고 step 을 디스패치한 뒤 생존 신호를 끊어둔다.
//   3. `app.close()` — NestFactory 종료. sqljs-flush.service 의 onModuleDestroy 가 강제 flush 를
//      돌려 상태가 실제로 디스크에 내려간다.
//   4. 앱 B 를 **새로 부팅**한다. 새 NestFactory · 새 DataSource · 새 서비스 인스턴스이고,
//      아는 것이라고는 디스크에 남은 DB 뿐이다.
//   5. 앱 B 의 `OnModuleInit` 부팅 스윕이 **저절로** 돌아 만료된 lease 를 관측하는지 본다 —
//      테스트가 리퍼를 부르지 않는다. 그게 "재시작하면 알아서 복구가 시작된다"의 증거다.
//
// 검증 대상(완료 기준 1·4):
//   • 재시작을 건너뛴 실행 상태(step/attempt/checkpoint)가 그대로 살아 있다
//   • 새 프로세스의 부팅 스윕이 스스로 복구를 시작한다(테스트가 트리거하지 않음)
//   • 유예 경과 후 새 attempt 로 자동 재개되고, 체크포인트가 새 work order 로 전달된다
//   • orchestrator 세션이 죽었다 살아나도 mission-scoped 대화 맥락(thread context)과
//     진행 상태를 그대로 되찾는다
//
// 포트는 `port: 0`(OS 할당)을 쓴다 — 한 파일에서 두 번 부팅하므로 고정 포트를 재사용하면
// 앞 서버가 소켓을 놓기 전에 두 번째 바인딩이 EADDRINUSE 로 깨진다(boot.mjs 주석 참고).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createWorkspace } from '../helpers/fixtures.mjs';

const MIN = 60_000;
const HUMAN = { type: 'user', id: 'qa-operator', name: 'QA Operator' };

// 이 프로세스의 모든 부팅이 같은 DB 파일을 보게 고정한다. bootApp 은 값이 이미 있으면
// 건드리지 않으므로, 여기서 먼저 잡아두는 것이 "같은 DB 로 재시작"의 유일한 조건이다.
const DB_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'awb-orch-restart-')),
  'restart.db',
);
process.env.SQLJS_DB_PATH = DB_FILE;
// 부팅 스윕이 유예 판정까지 곧바로 가지 않도록 유예를 넉넉히 둔다 — 이 테스트는
// "관측 단계가 재시작 후 스스로 일어나는가"를 먼저 보고, 재개는 그 다음에 확인한다.
process.env.ORCHESTRATION_LEASE_GRACE_MS = String(30 * MIN);

let servicesCache = null;
async function services(app) {
  if (!servicesCache) {
    const load = async (file) => {
      const DIST = path.join(process.cwd(), 'dist', 'modules', 'orchestration');
      return import(pathToFileURL(path.join(DIST, file)).href);
    };
    const team = await load('orchestration-team.service.js');
    const mission = await load('orchestration-mission.service.js');
    const runner = await load('orchestration-runner.service.js');
    const reaper = await load('orchestration-reaper.service.js');
    servicesCache = {
      OrchestrationTeamService: team.OrchestrationTeamService,
      OrchestrationMissionService: mission.OrchestrationMissionService,
      OrchestrationRunnerService: runner.OrchestrationRunnerService,
      OrchestrationReaperService: reaper.OrchestrationReaperService,
    };
  }
  return {
    teams: app.get(servicesCache.OrchestrationTeamService),
    missions: app.get(servicesCache.OrchestrationMissionService),
    runner: app.get(servicesCache.OrchestrationRunnerService),
    reaper: app.get(servicesCache.OrchestrationReaperService),
  };
}

/**
 * 조건이 참이 될 때까지 기다린다. 고정 `sleep` 으로 추정하지 않는다 — 부팅 스윕은
 * `void this.runOnce()` 라 부팅 완료와 비동기이므로 관측 가능한 신호(타임라인 이벤트)를
 * 조건으로 삼고, timeout 은 정상 동기화 수단이 아니라 hang 진단용 상한으로만 둔다
 * (보드 교훈: 동시성은 고정 지연이 아니라 happens-before 로).
 */
async function waitFor(label, predicate, { timeoutMs = 15_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function readSteps(missions, missionId, workspaceId) {
  const detail = await missions.getMissionDetail(missionId, workspaceId);
  return { detail, byKey: Object.fromEntries(detail.steps.map((s) => [s.step_key, s])) };
}

test('실제 서버 재시작: 새 프로세스의 부팅 스윕이 스스로 복구를 시작하고 실행이 재개된다', async (t) => {
  // ── 앱 A: 미션을 만들고 진행하다 생존 신호가 끊긴다 ────────────────────────
  step('앱 A 부팅 — 미션 생성 → 계획 제출 → step 디스패치 → 체크포인트 저장');
  const a = await bootApp({ port: 0 });
  const { getDataSourceToken } = a.modules;
  const svcA = await services(a.app);

  const ws = await createWorkspace(a.app, getDataSourceToken, 'orch-restart');
  const lead = await createAgent(a.app, getDataSourceToken, ws.id, { name: 'lead-restart' });
  const worker = await createAgent(a.app, getDataSourceToken, ws.id, { name: 'worker-restart' });

  const team = await svcA.teams.createTeam({
    workspace_id: ws.id,
    name: 'Restart squad',
    orchestrator_agent_id: lead.id,
    max_parallel_steps: 4,
    created_by: HUMAN.id,
  });
  await svcA.teams.addMember(team.id, ws.id, {
    agent_id: worker.id,
    role_label: 'builder',
    capabilities: 'builds',
    max_concurrent: 4,
  });

  const mission = await svcA.missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Restart mission',
    objective: 'survive a server restart',
    created_by: HUMAN.id,
    step_timeout_minutes: 30,
  });
  await svcA.runner.startMission(mission.id, ws.id, HUMAN);
  await svcA.runner.submitPlan(mission.id, lead.id, {
    steps: [{ step_key: 'build', title: 'Build it', instructions: 'build', assignee_agent_id: worker.id }],
  });

  let { byKey } = await readSteps(svcA.missions, mission.id, ws.id);
  assert.equal(byKey.build.status, 'dispatched', '계획 제출로 step 이 나갔다');
  const stepId = byKey.build.id;

  // 작업자가 진행 상태를 남긴 뒤 세션이 죽는다.
  const freshStep = await svcA.missions.requireStep(stepId);
  await svcA.runner.reportProgress(stepId, worker.id, '절반 진행', freshStep.lease_token, {
    stage: 'half-done',
    next: 'write the report',
  });

  step('생존 신호가 timeout 을 넘겨 끊긴 상태로 만든다(프로세스가 죽은 것과 같은 저장 결과)');
  const stale = new Date(Date.now() - 31 * MIN);
  await a.app
    .get(getDataSourceToken())
    .getRepository('OrchestrationStep')
    .update({ id: stepId }, { last_heartbeat_at: stale, started_at: stale, dispatched_at: stale });

  const beforeRestart = await readSteps(svcA.missions, mission.id, ws.id);
  assert.equal(beforeRestart.byKey.build.attempt, 1);
  // checkpoint 는 운영자용 mission detail 이 아니라 **복구 조회 경로**(작업자가 되찾는 곳)와
  // step 행에 있다. 여기서는 영속화 자체가 목적이므로 행을 직접 읽는다.
  assert.deepEqual((await svcA.missions.requireStep(stepId)).checkpoint, {
    stage: 'half-done',
    next: 'write the report',
  });
  const eventsBefore = beforeRestart.detail.events.length;

  // ── 진짜 재시작 ────────────────────────────────────────────────────────────
  step('앱 A 종료 — onModuleDestroy 의 강제 flush 로 상태가 디스크에 내려간다');
  await a.app.close();
  assert.ok(fs.existsSync(DB_FILE), 'DB 파일이 실제로 디스크에 있어야 재시작이 의미가 있다');
  assert.ok(fs.statSync(DB_FILE).size > 0, 'flush 가 안 됐다면 재시작 후 아무것도 없다');

  step('앱 B 부팅 — 새 NestFactory · 새 DataSource · 새 서비스 인스턴스, 아는 것은 디스크뿐');
  const b = await bootApp({ port: 0 });
  t.after(() => {
    void b.app.close().catch(() => {});
  });
  const svcB = await services(b.app);
  assert.notEqual(svcB.runner, svcA.runner, '같은 인스턴스를 재사용하면 재시작을 검증한 것이 아니다');

  step('재시작을 건너뛴 실행 상태가 그대로 살아 있다');
  const afterBoot = await readSteps(svcB.missions, mission.id, ws.id);
  assert.equal(afterBoot.byKey.build.attempt, 1, 'attempt 가 영속화돼야 한다');
  assert.equal(afterBoot.byKey.build.step_key, 'build');
  assert.deepEqual(
    (await svcB.missions.requireStep(stepId)).checkpoint,
    { stage: 'half-done', next: 'write the report' },
    '체크포인트가 재시작을 넘겨 살아남아야 재개가 "처음부터 다시"와 달라진다',
  );

  step('부팅 스윕이 **저절로** 만료된 lease 를 관측한다 (테스트는 리퍼를 부르지 않는다)');
  const noticed = await waitFor('boot sweep observing the stale lease', async () => {
    const detail = await svcB.missions.getMissionDetail(mission.id, ws.id);
    return detail.events.some((e) => e.type === 'step_lease_stale');
  });
  assert.ok(noticed, '재시작 후 아무도 부르지 않았는데 복구가 시작돼야 "자동 복구"다');

  const afterSweep = await readSteps(svcB.missions, mission.id, ws.id);
  assert.ok(
    afterSweep.detail.events.length > eventsBefore,
    '새 프로세스가 타임라인에 기록을 남겼어야 한다(같은 DB 를 이어서 쓴다는 증거)',
  );
  // `lease_stale_since` 도 운영자용 detail DTO 가 아니라 step 행에 있는 내부 상태다.
  assert.ok(
    (await svcB.missions.requireStep(stepId)).lease_stale_since,
    '유예 창이 새 프로세스에서 열렸다 — 이게 없으면 부팅 스윕이 관측만 하고 상태를 안 남긴 것이다',
  );

  step('유예까지 지나면 새 attempt 로 자동 재개되고 체크포인트가 새 work order 로 전달된다');
  await b.app
    .get(getDataSourceToken())
    .getRepository('OrchestrationStep')
    .update({ id: stepId }, { lease_stale_since: new Date(Date.now() - 60 * MIN) });
  await svcB.reaper.runOnce(new Date());

  const resumed = await readSteps(svcB.missions, mission.id, ws.id);
  assert.equal(resumed.byKey.build.attempt, 2, '재시작한 서버가 스스로 새 attempt 를 띄워야 자동 재개다');
  assert.equal(resumed.byKey.build.status, 'dispatched');

  const rows = await b.app
    .get(getDataSourceToken())
    .getRepository('ChatRoomMessage')
    .find({ where: { room_id: resumed.byKey.build.room_id } });
  const newOrder = rows.map((r) => r.content || '').join('\n');
  assert.match(newOrder, /half-done/, '재시작 뒤 재개된 attempt 도 체크포인트에서 이어가야 한다');
  assert.match(newOrder, /write the report/);
});

test('orchestrator 세션 재시작: 대화 맥락과 진행 상태를 그대로 되찾는다', async (t) => {
  // 완료 기준 4 의 "재시작 후에도 기록과 thread context 를 복원". orchestrator 는 상주
  // 프로세스가 아니라 미션 room 으로 디스패치되는 일회성 세션이므로, "세션 재시작"은
  // **그 세션이 사라진 뒤 새 세션이 같은 room 을 이어받는 것**이다. 확인할 것은 두 가지다:
  // 새 세션이 (a) 지금까지의 대화 맥락을 그대로 읽을 수 있고 (b) 실행 상태를 정확히
  // 되찾는가. 앞 테스트가 이미 프로세스를 갈아치웠으므로 여기서는 그 뒤의 앱을 쓴다.
  const app = (await bootApp({ port: 0 })).app;
  t.after(() => {
    void app.close().catch(() => {});
  });
  const { getDataSourceToken } = (await import('@nestjs/typeorm'));
  const svc = await services(app);
  const ds = app.get(getDataSourceToken());

  const ws = await createWorkspace(app, getDataSourceToken, 'orch-orch-restart');
  const lead = await createAgent(app, getDataSourceToken, ws.id, { name: 'lead-sess' });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker-sess' });

  const team = await svc.teams.createTeam({
    workspace_id: ws.id,
    name: 'Session squad',
    orchestrator_agent_id: lead.id,
    max_parallel_steps: 4,
    created_by: HUMAN.id,
  });
  await svc.teams.addMember(team.id, ws.id, {
    agent_id: worker.id,
    role_label: 'builder',
    capabilities: 'builds',
    max_concurrent: 4,
  });
  const mission = await svc.missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Session mission',
    objective: 'keep the thread',
    created_by: HUMAN.id,
    step_timeout_minutes: 30,
  });
  await svc.runner.startMission(mission.id, ws.id, HUMAN);
  await svc.runner.submitPlan(mission.id, lead.id, {
    steps: [{ step_key: 'build', title: 'Build it', instructions: 'build', assignee_agent_id: worker.id }],
  });

  step('운영자가 미션 room 에 방향 지시를 남긴다 — 이게 복원돼야 할 thread context 다');
  const detail = await svc.missions.getMissionDetail(mission.id, ws.id);
  const messageRepo = ds.getRepository('ChatRoomMessage');
  await messageRepo.save(
    messageRepo.create({
      room_id: detail.room_id,
      workspace_id: ws.id,
      sender_type: 'user',
      sender_id: HUMAN.id,
      sender_name: HUMAN.name,
      content: 'ui 를 먼저 끝내고 api 는 나중에 해줘',
      type: 'text',
    }),
  );
  const beforeCount = await messageRepo.count({ where: { room_id: detail.room_id } });

  step('orchestrator 세션이 죽는다 — 서버가 그 세션을 다시 깨운다(새 세션)');
  // nudge 는 미션 room 에 새 브리핑을 posting 해 새 orchestrator 세션을 여는 경로다.
  await svc.runner.nudgeOrchestrator(mission.id, ws.id, HUMAN, '세션이 끊겨 다시 깨웁니다', 'manual');

  step('새 세션이 이어받는 room 에 이전 대화가 그대로 남아 있다');
  const after = await messageRepo.find({ where: { room_id: detail.room_id } });
  assert.ok(after.length > beforeCount, '깨우기 메시지가 같은 room 에 이어 붙어야 한다(새 room 을 만들면 맥락이 끊긴다)');
  assert.ok(
    after.some((m) => (m.content || '').includes('ui 를 먼저 끝내고 api 는 나중에 해줘')),
    '이전 세션에서 받은 지시가 사라지면 새 세션은 방향을 알 수 없다',
  );
  assert.ok(
    after.some((m) => (m.content || '').includes('세션이 끊겨 다시 깨웁니다')),
    '재개 사유도 같은 스레드에 남아야 한다',
  );

  step('새 세션이 실행 상태를 정확히 되찾는다');
  const live = await svc.missions.getMissionForOrchestrator(mission.id);
  assert.equal(live.mission_id ?? live.id, mission.id);
  assert.ok(
    (live.steps || []).some((s) => s.step_key === 'build'),
    'orchestrator 가 재개 후 읽는 뷰에 계획이 그대로 있어야 한다',
  );
  assert.equal(
    (await readSteps(svc.missions, mission.id, ws.id)).byKey.build.status,
    'dispatched',
    '깨우기가 진행 중이던 step 을 흔들면 안 된다',
  );
});

exitAfterTests();
