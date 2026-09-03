// QA flow: durable recovery end-to-end (티켓 4d065f82).
//
// `orchestration-graph-execution.test.mjs` 가 그래프 실행에 대해 하는 일을 복구
// 경로에 대해 한다 — 실제 엔진을 태우고, 작업자·오케스트레이터가 하는 동작은 전부
// MCP HTTP 로 나간다. 그래서 tool 스키마·세션 신원 해석·authz 게이트까지 함께
// 검증된다. 서비스 단위 테스트(orchestration-lease-recovery.test.mjs)가 로직을
// 덮는다면, 이 파일은 **배선**을 덮는다: lease_token 파라미터가 실제 MCP 표면에
// 존재하고, 프롬프트가 그 값을 싣고 나가고, 리퍼가 같은 경로로 복구하는지.
//
// 수용 기준 대응:
//   1) 재시작 뒤 미션이 자동 복구·재개된다 — 저장된 상태에서 리퍼 스윕(부팅 시
//      스윕과 같은 메서드)을 돌려 lease 만료 step 이 정리되고 실행이 이어진다.
//   2) 중복 dispatch 와 stale result 가 fencing 으로 차단된다 — 재시도로 밀려난
//      attempt 의 지각 보고가 실제 MCP 툴 호출에서 거부되고 현재 attempt 가 보존된다.
//   4) 대화 기록이 재시작 뒤에도 보존된다 — 미션 room 메시지가 그대로 다시 읽힌다.
//   5) 복구 불가 작업이 needs_recovery + 사유로 노출되고 자동 재실행되지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, createWorkspace } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_RECOVERY_PORT || '7952';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

const HUMAN = { type: 'user', id: 'qa-operator', name: 'QA Operator' };
const MIN = 60_000;

async function loadServices() {
  const load = async (file) =>
    import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', file)).href);
  const team = await load('orchestration-team.service.js');
  const mission = await load('orchestration-mission.service.js');
  const runner = await load('orchestration-runner.service.js');
  const reaper = await load('orchestration-reaper.service.js');
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    OrchestrationReaperService: reaper.OrchestrationReaperService,
  };
}

let shared = null;
async function sharedApp() {
  if (!shared) {
    shared = await bootApp({ port: parseInt(process.env.PORT, 10) });
    shared.services = await loadServices();
    const { app } = shared;
    process.on('exit', () => {
      void app.close().catch(() => {});
    });
  }
  return shared;
}

/** 이 step 앞으로 열린 디스패치 room 수 = 실제로 subagent 를 띄운 횟수. */
async function roomCountFor(ds, stepId) {
  return ds.getRepository('ChatRoom').count({ where: { orchestration_step_id: stepId } });
}

async function readSteps(missions, missionId, workspaceId) {
  const detail = await missions.getMissionDetail(missionId, workspaceId);
  return { detail, byKey: Object.fromEntries(detail.steps.map((s) => [s.step_key, s])) };
}

/** work order 프롬프트를 그 step 의 방에서 그대로 읽는다. */
async function workOrderFor(ds, stepId) {
  const room = await ds.getRepository('ChatRoom').findOne({ where: { orchestration_step_id: stepId } });
  if (!room) return '';
  const rows = await ds.getRepository('ChatRoomMessage').find({ where: { room_id: room.id } });
  return rows.map((r) => r.content || '').join('\n');
}

async function stage(t, { label }) {
  const { app, port, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const reaper = app.get(services.OrchestrationReaperService);

  const ws = await createWorkspace(app, getDataSourceToken, `rec-${label}`);
  const lead = await createAgent(app, getDataSourceToken, ws.id, { name: `lead-${label}` });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: `worker-${label}` });

  const mcpFor = async (agent, name) => {
    const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: name });
    const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
    t.after(() => {
      void client.close().catch(() => {});
    });
    return client;
  };

  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: `Recovery squad ${label}`,
    orchestrator_agent_id: lead.id,
    max_parallel_steps: 4,
    created_by: HUMAN.id,
  });
  await teams.addMember(team.id, ws.id, {
    agent_id: worker.id,
    role_label: 'builder',
    capabilities: 'builds things',
    max_concurrent: 4,
  });

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: `Recovery mission ${label}`,
    objective: 'ship the thing',
    created_by: HUMAN.id,
    step_timeout_minutes: 30,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);

  return {
    ds, ws, missions, runner, reaper, mission, lead, worker,
    leadMcp: await mcpFor(lead, `lead-${label}`),
    workerMcp: await mcpFor(worker, `worker-${label}`),
  };
}

const planFor = (worker, extra = {}) => ({
  steps: [
    { step_key: 'build', title: 'Build it', instructions: 'build', assignee_agent_id: worker.id, ...extra },
  ],
});

// ─── 2) fencing: 재시도로 밀려난 attempt 의 지각 보고 ─────────────────────────

test('재시도로 밀려난 attempt 의 지각 보고가 MCP 표면에서 거부되고 현재 attempt 가 보존된다', async (t) => {
  const s = await stage(t, { label: 'fence' });
  const { ds, ws, missions, mission, worker, leadMcp, workerMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(byKey.build.status, 'dispatched', '계획 제출 즉시 디스패치된다');

  step('attempt 1 의 work order 에서 lease token 을 읽는다 (프롬프트 배선 검증)');
  const order1 = await workOrderFor(ds, byKey.build.id);
  const lease1 = /lease_token`?:?\s*`?([0-9a-f-]{36})`?/i.exec(order1)?.[1];
  assert.ok(
    lease1,
    'work order 에 lease token 이 실려 나가지 않으면 서버가 토큰을 요구하는 순간 보고 자체가 불가능한 wedge 가 된다',
  );

  step('attempt 1 을 실패시키고 orchestrator 가 재시도해 attempt 2 를 띄운다');
  await workerMcp.callTool('report_orchestration_step', {
    step_id: byKey.build.id,
    status: 'failed',
    summary: 'attempt 1 실패',
    lease_token: lease1,
  });
  await leadMcp.callTool('update_orchestration_step', { step_id: byKey.build.id, action: 'retry' });

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.build.attempt, 2, '재시도로 attempt 가 올라간다');
  assert.equal(byKey.build.status, 'dispatched', 'attempt 2 가 in-flight');
  const roomsAfterRetry = await roomCountFor(ds, byKey.build.id);

  step('attempt 1 의 살아있는 subagent 가 뒤늦게 성공을 보고한다');
  const stale = await workerMcp.callTool('report_orchestration_step', {
    step_id: byKey.build.id,
    status: 'done',
    summary: '지각 보고 — 이미 밀려난 attempt 1 의 결과',
    lease_token: lease1,
  });
  assert.match(
    JSON.stringify(stale),
    /no longer valid|superseded/i,
    'lease 가 갈린 뒤의 보고는 거부돼야 한다',
  );

  const after = await readSteps(missions, mission.id, ws.id);
  assert.equal(after.byKey.build.status, 'dispatched', 'attempt 2 는 in-flight 그대로 — 지각 보고가 덮어쓰지 못한다');
  assert.notEqual(after.byKey.build.result_summary, '지각 보고 — 이미 밀려난 attempt 1 의 결과');
  assert.equal(await roomCountFor(ds, after.byKey.build.id), roomsAfterRetry, '거부가 새 디스패치를 유발하지 않는다');

  step('거부 사실이 실행 trace 에 남는다');
  assert.ok(
    after.detail.events.some((e) => e.type === 'step_lease_rejected'),
    '거부가 타임라인에 없으면 "왜 내 결과가 반영 안 됐나"를 사후에 설명할 수 없다',
  );

  step('토큰을 생략한 보고도 거부된다 — 누락으로 우회 불가');
  const omitted = await workerMcp.callTool('report_orchestration_step', {
    step_id: after.byKey.build.id,
    status: 'done',
    summary: '토큰 없는 보고',
  });
  assert.match(JSON.stringify(omitted), /requires the lease token/i);
  assert.equal(
    (await readSteps(missions, mission.id, ws.id)).byKey.build.status,
    'dispatched',
    '토큰 누락 보고도 상태를 바꾸지 못한다',
  );
});

// ─── 1) 재시작 복구: 저장된 상태 + 리퍼 스윕 ─────────────────────────────────

test('재시작 뒤 lease 가 만료된 step 은 부팅 스윕과 같은 경로로 복구되고 실행이 이어진다', async (t) => {
  const s = await stage(t, { label: 'restart' });
  const { ds, ws, missions, reaper, mission, worker, leadMcp, workerMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  let { byKey } = await readSteps(missions, mission.id, ws.id);

  step('작업자가 한 번 살아있다고 알린 뒤 세션이 죽는다');
  const order = await workOrderFor(ds, byKey.build.id);
  const lease = /lease_token`?:?\s*`?([0-9a-f-]{36})`?/i.exec(order)?.[1];
  await workerMcp.callTool('report_orchestration_progress', {
    step_id: byKey.build.id,
    message: '작업 착수',
    lease_token: lease,
  });

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.build.status, 'running', 'heartbeat 로 running 으로 승격된다');
  assert.ok(byKey.build.last_heartbeat_at, 'heartbeat 시각이 영속화돼야 재시작 후에도 기준선이 남는다');

  step('heartbeat 가 timeout 을 넘겨 끊긴 상태를 만든다(세션 사망 재현)');
  // DB 를 직접 되돌린다 — 프로세스가 죽어 heartbeat 가 멈춘 상태와 저장 결과가 같다.
  const stepRepo = ds.getRepository('OrchestrationStep');
  const stale = new Date(Date.now() - 31 * MIN);
  await stepRepo.update({ id: byKey.build.id }, { last_heartbeat_at: stale, started_at: stale, dispatched_at: stale });

  step('재시작 시 부팅 스윕이 도는 것과 같은 메서드를 호출한다');
  // runOnce 는 OnModuleInit 의 부팅 스윕과 주기 스윕이 둘 다 부르는 바로 그 경로다 —
  // "정상 운용 장애 감지와 재시작 복구가 같은 reconciliation 경로를 쓴다"는 요구가
  // 별도 복구 코드 없이 성립한다는 근거가 여기다.
  await reaper.runOnce(new Date());

  const after = await readSteps(missions, mission.id, ws.id);
  assert.equal(after.byKey.build.status, 'failed', 'lease 가 만료된 step 은 리퍼가 정리한다');
  assert.match(after.byKey.build.result_summary, /timed out/i, '복구 사유가 기록된다');

  step('복구된 미션은 orchestrator 가 재시도해 그대로 이어진다');
  await leadMcp.callTool('update_orchestration_step', { step_id: after.byKey.build.id, action: 'retry' });
  const resumed = await readSteps(missions, mission.id, ws.id);
  assert.equal(resumed.byKey.build.status, 'dispatched', '재시도로 실행이 재개된다');
  assert.equal(resumed.byKey.build.attempt, 2);
  assert.ok(
    resumed.byKey.build.last_heartbeat_at == null,
    '새 attempt 는 이전 attempt 의 heartbeat 를 물려받으면 안 된다 — 죽은 세션의 생존 신호로 시계가 재진다',
  );
});

test('살아서 heartbeat 를 계속 보내는 step 은 리퍼가 건드리지 않는다', async (t) => {
  const s = await stage(t, { label: 'alive' });
  const { ds, ws, missions, reaper, mission, worker, leadMcp, workerMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  const { byKey } = await readSteps(missions, mission.id, ws.id);
  const order = await workOrderFor(ds, byKey.build.id);
  const lease = /lease_token`?:?\s*`?([0-9a-f-]{36})`?/i.exec(order)?.[1];

  // 오래 전에 시작했지만 방금 살아있다고 알렸다 — 이 티켓 이전 기준선(started_at)
  // 이었다면 반드시 죽었을 조합이다.
  const stepRepo = ds.getRepository('OrchestrationStep');
  const old = new Date(Date.now() - 120 * MIN);
  await stepRepo.update({ id: byKey.build.id }, { started_at: old, dispatched_at: old });
  await workerMcp.callTool('report_orchestration_progress', {
    step_id: byKey.build.id,
    message: '두 시간째 살아서 작업 중',
    lease_token: lease,
  });

  await reaper.runOnce(new Date());

  const after = await readSteps(missions, mission.id, ws.id);
  assert.equal(
    after.byKey.build.status,
    'running',
    'heartbeat 가 timeout 을 리셋한다는 계약이 실제로 성립해야 한다 — 안 그러면 살아있는 장기 작업이 계속 죽는다',
  );
});

// ─── 5) needs_recovery ───────────────────────────────────────────────────────

test("retry_policy='manual' step 은 needs_recovery 로 노출되고 자동 재디스패치되지 않는다", async (t) => {
  const s = await stage(t, { label: 'manual' });
  const { ds, ws, missions, reaper, mission, worker, leadMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker, { retry_policy: 'manual' }),
  });
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(byKey.build.retry_policy, 'manual', 'MCP 로 보낸 정책이 실제로 저장돼야 한다');
  const roomsBefore = await roomCountFor(ds, byKey.build.id);

  step('lease 가 만료되도록 시계를 되돌린 뒤 스윕한다');
  const staleAt = new Date(Date.now() - 31 * MIN);
  await ds
    .getRepository('OrchestrationStep')
    .update({ id: byKey.build.id }, { dispatched_at: staleAt, started_at: staleAt });
  await reaper.runOnce(new Date());

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.build.status, 'needs_recovery', '비멱등 작업은 자동 재시도 가능한 failed 로 가면 안 된다');
  assert.ok(byKey.build.recovery_reason, '사유 없이 상태만 바뀌면 운영자가 멈춘 step 과 구분할 수 없다');
  assert.match(byKey.build.recovery_reason, /manual/i);

  step('엔진이 이 step 을 다시 띄우지 않는다 — 이게 이 상태의 존재 이유다');
  await reaper.runOnce(new Date());
  assert.equal(
    await roomCountFor(ds, byKey.build.id),
    roomsBefore,
    'needs_recovery step 이 재디스패치되면 막으려던 비멱등 작업의 중복 실행을 그 기능이 일으킨다',
  );

  step('orchestrator 는 미션을 읽어 복구 필요 사유를 볼 수 있다');
  const read = await leadMcp.callTool('get_orchestration_mission', { mission_id: mission.id });
  assert.match(JSON.stringify(read), /needs_recovery/, 'orchestrator 브리핑에 상태가 드러나야 개입할 수 있다');

  step('명시적 retry 만이 복구의 탈출구다');
  await leadMcp.callTool('update_orchestration_step', { step_id: byKey.build.id, action: 'retry' });
  const after = await readSteps(missions, mission.id, ws.id);
  assert.notEqual(after.byKey.build.status, 'needs_recovery');
  assert.equal(after.byKey.build.recovery_reason, '', '처리된 복구 사유는 지워져야 한다');
});

// ─── 4) 대화 기록 보존 ───────────────────────────────────────────────────────

test('미션 room 의 대화는 저장돼 다시 읽어도 그대로 남는다', async (t) => {
  const s = await stage(t, { label: 'chat' });
  const { ds, ws, missions, mission } = s;

  const detail = await missions.getMissionDetail(mission.id, ws.id);
  assert.ok(detail.room_id, '시작된 미션에는 orchestrator 대화방이 있어야 대화 패널이 붙을 곳이 생긴다');

  const messageRepo = ds.getRepository('ChatRoomMessage');
  const before = await messageRepo.count({ where: { room_id: detail.room_id } });
  assert.ok(before > 0, '미션 브리핑 자체가 이 방에 기록되므로 thread context 가 이미 존재한다');

  step('운영자가 방향 수정 지시를 남긴다');
  await messageRepo.save(
    messageRepo.create({
      room_id: detail.room_id,
      workspace_id: ws.id,
      sender_type: 'user',
      sender_id: HUMAN.id,
      sender_name: HUMAN.name,
      content: 'api 말고 ui 를 먼저 끝내줘',
      type: 'text',
    }),
  );

  step('새로 읽어도(재시작과 같은 경로) 기록이 그대로다');
  const rows = await messageRepo.find({ where: { room_id: detail.room_id } });
  assert.equal(rows.length, before + 1);
  assert.ok(
    rows.some((r) => (r.content || '').includes('api 말고 ui 를 먼저 끝내줘')),
    '대화가 서버에 영속되지 않으면 재시작 후 thread context 가 사라진다',
  );
});

// ─── 세션을 잃은 agent 의 복구 경로 ──────────────────────────────────────────

test('세션을 잃은 agent 는 복구 조회로 lease token 을 되찾아 보고할 수 있다', async (t) => {
  // 이 티켓이 만든 wedge 를 막는 테스트다. 보고에 lease token 을 요구하기로 한 이상,
  // work order 를 잃은 agent 가 토큰을 되찾을 경로가 반드시 있어야 한다 — 없으면
  // 세션이 죽은 agent 는 **영원히 보고할 수 없고**, 하필 그게 이 기능이 지키려던
  // 시나리오다. 복구 도구 두 개가 모두 토큰을 돌려주는지 확인한다.
  const s = await stage(t, { label: 'lost' });
  const { ws, missions, mission, worker, leadMcp, workerMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  const { byKey } = await readSteps(missions, mission.id, ws.id);

  step('세션이 죽어 work order 를 잃었다고 가정하고 열린 배정을 다시 찾는다');
  const open = await workerMcp.callTool('list_my_orchestration_steps', {});
  const mine = (open.open_steps || []).find((r) => r.step_id === byKey.build.id);
  assert.ok(mine, '복구 조회가 열린 배정을 돌려줘야 한다');
  assert.ok(
    mine.lease_token,
    'list_my_orchestration_steps 가 토큰을 빼면 복구한 agent 가 보고할 방법이 없다',
  );

  step('work order 재조회 경로도 같은 토큰을 돌려준다');
  const read = await workerMcp.callTool('get_orchestration_step', { step_id: byKey.build.id });
  assert.equal(read.lease_token, mine.lease_token, '두 복구 경로가 같은 토큰을 줘야 한다');

  step('되찾은 토큰으로 실제 보고가 통과한다');
  const done = await workerMcp.callTool('report_orchestration_step', {
    step_id: byKey.build.id,
    status: 'done',
    summary: '세션을 잃었다가 복구해서 보고',
    lease_token: mine.lease_token,
  });
  assert.ok(!done?.isError, `복구 후 보고가 거부되면 wedge 다: ${JSON.stringify(done)}`);
  assert.equal((await readSteps(missions, mission.id, ws.id)).byKey.build.status, 'done');
});

exitAfterTests();
