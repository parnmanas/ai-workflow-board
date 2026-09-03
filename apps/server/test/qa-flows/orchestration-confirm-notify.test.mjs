// QA flow: confirm 게이트 대기 알림 end-to-end (티켓 a78cb566).
//
// `orchestration-confirm-node.test.mjs` 와 같은 방식이다 — 실제 엔진을 태우고, 에이전트가
// 하는 동작은 MCP HTTP 로, 사람이 하는 동작은 서비스 계층으로 나간다. 다른 점은 하나뿐:
// 바깥으로 나가는 마지막 홉(`UserChannelDispatcherService.dispatchForUser`)만 가짜로
// 바꾼다. 그 앞의 경로 — 게이트 오픈, 중복 방지 컬럼, loop 재진입, 리퍼 스윕 — 는 전부
// 프로덕션 코드가 그대로 돈다.
//
// 이 기능의 위험은 "안 나간다" 와 "너무 많이 나간다" 양쪽에 있다:
//
//   - 안 나가면: 티켓이 고치려던 침묵이 그대로다(사람이 화면을 열 때까지 미션 정지).
//   - 매 pump 마다 나가면: 5분 주기 스윕이 도는 동안 같은 질문이 수십 번 울린다.
//   - 판정 뒤에도 나가면: 이미 답한 사람에게 계속 재촉이 간다.
//   - 발송이 게이트 오픈을 막으면: 알림 인프라 장애가 미션 실행을 통째로 세운다.
//
// 아래 시나리오는 그 각각을 **실제로 나간 발송 기록**으로 직접 확인한다.
//
// 그래프(위 파일과 동일):
//
//     build ──→ gate(confirm) ─(pass)────→ ship
//                   │
//                   └─(fail, loop_back)──→ build

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, createWorkspace } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_CONFIRM_NOTIFY_PORT || '7956';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

// 리퍼 스윕은 **DB 전체**를 훑으므로, 이 파일의 다른 테스트가 열어 둔 게이트에도
// 리마인더가 나간다. 즉 가짜 dispatcher 에 쌓이는 기록은 내 미션 것만이 아니다.
// 스테이지마다 소유자를 다르게 줘서 내 미션의 발송만 골라낸다(`s.mine()`).
const ownerFor = (label) => ({ type: 'user', id: `qa-owner-${label}`, name: `QA Owner ${label}` });
const MIN = 60_000;
const HOUR = 60 * MIN;

async function loadServices() {
  const orch = async (file) => import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', file)).href);
  const team = await orch('orchestration-team.service.js');
  const mission = await orch('orchestration-mission.service.js');
  const runner = await orch('orchestration-runner.service.js');
  const reaper = await orch('orchestration-reaper.service.js');
  const notify = await orch('orchestration-confirm-notify.service.js');
  const dispatcher = await import(
    pathToFileURL(path.join(DIST, 'services', 'notification-providers', 'dispatcher.service.js')).href
  );
  const rebac = await import(pathToFileURL(path.join(DIST, 'services', 'rebac.service.js')).href);
  const log = await import(pathToFileURL(path.join(DIST, 'services', 'log.service.js')).href);
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    OrchestrationReaperService: reaper.OrchestrationReaperService,
    OrchestrationConfirmNotifyService: notify.OrchestrationConfirmNotifyService,
    UserChannelDispatcherService: dispatcher.UserChannelDispatcherService,
    ReBACService: rebac.ReBACService,
    LogService: log.LogService,
  };
}

/**
 * n 명이 전부 도착해야 다 같이 통과하는 배리어. **고정 지연으로 경쟁을 흉내내지 않는다** —
 * `setTimeout` 기반 경쟁 테스트는 느린 CI 에서 순서가 뒤집히면 조용히 통과해 버려서, 정작
 * 막으려던 결함을 못 잡는다. 여기서 필요한 것은 시간이 아니라 **happens-before 관계**다:
 * "두 경쟁자가 모두 낡은 상태를 읽었다"는 사실이 "누구도 아직 쓰지 않았다"보다 먼저 성립해야
 * 한다. 그 지점을 배리어로 못박으면 결과는 스케줄러와 무관하게 결정적이다.
 */
function barrier(n) {
  let arrived = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await gate;
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

async function readSteps(missions, missionId, workspaceId) {
  const detail = await missions.getMissionDetail(missionId, workspaceId);
  return { detail, byKey: Object.fromEntries(detail.steps.map((s) => [s.step_key, s])) };
}

const eventsOfType = (detail, type) => detail.events.filter((e) => e.type === type);

async function stage(t, { label } = {}) {
  const HUMAN = ownerFor(label);
  const { app, port, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const reaper = app.get(services.OrchestrationReaperService);
  const notify = app.get(services.OrchestrationConfirmNotifyService);
  const dispatcher = app.get(services.UserChannelDispatcherService);

  // ── 바깥으로 나가는 마지막 홉만 가짜로 바꾼다 ────────────────────────────
  // 이 싱글턴은 알림 서비스가 주입받은 바로 그 인스턴스라, 메서드를 갈아끼우면
  // 프로덕션 경로가 그대로 이 기록기로 들어온다. 테스트마다 원복한다.
  const outbox = [];
  let mode = 'ok';
  const original = dispatcher.dispatchForUser.bind(dispatcher);
  dispatcher.dispatchForUser = async (userId, notifyKey, payload) => {
    outbox.push({ userId, notifyKey, payload, at: Date.now() });
    if (mode === 'throw') throw new Error('notification backend is down');
    if (mode === 'fail') return { sent: 0, failed: 1 };
    return { sent: 1, failed: 0 };
  };
  t.after(() => {
    dispatcher.dispatchForUser = original;
  });

  const ws = await createWorkspace(app, getDataSourceToken, `orch-cn-${label}`);
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
    name: `Notify squad ${label}`,
    orchestrator_agent_id: lead.id,
    max_parallel_steps: 2,
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
    title: `Notify mission ${label}`,
    objective: 'Exercise the confirm gate notification path.',
    max_parallel_steps: 2,
    graph_enabled: true,
    confirm_policy: 'auto',
    created_by_type: 'user',
    created_by: HUMAN.id,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);

  return {
    app, ds, ws, lead, worker, team, mission, missions, runner, reaper, notify,
    HUMAN,
    outbox,
    /**
     * 같은 DB 를 보는 **두 번째 서버**의 알림 서비스를 만든다. 협력자는 전부 이 앱의 것을
     * 그대로 쓰되 인스턴스만 새로 만든다 — 중복 방지가 프로세스 메모리가 아니라 DB 에서
     * 판정된다는 것을 이 방식으로만 증명할 수 있다(같은 인스턴스를 두 번 부르면 프로세스
     * 안의 어떤 캐시가 막아 준 것인지 구별되지 않는다).
     */
    secondServerNotify: () =>
      new services.OrchestrationConfirmNotifyService(
        ds.getRepository('OrchestrationStep'),
        dispatcher,
        app.get(services.ReBACService),
        missions,
        app.get(services.LogService),
      ),
    /**
     * 같은 DB 를 보는 **두 번째 서버의 러너**. 협력자는 이 앱의 것을 그대로 물려주되
     * 인스턴스만 새로 만든다 — 그래야 `missionLocks`(프로세스 메모리)가 분리되어, 두
     * 서버가 같은 게이트를 동시에 여는 상황이 실제로 재현된다. 주입 필드는 TS `private`
     * 이지만 컴파일 후에는 평범한 프로퍼티라 그대로 읽어 넘길 수 있다.
     */
    secondServerRunner: (notifyOverride) =>
      new services.OrchestrationRunnerService(
        runner.missionRepo, runner.stepRepo, runner.teamRepo, runner.memberRepo,
        runner.roomRepo, runner.participantRepo, runner.agentRepo, runner.actionRepo,
        runner.actionRunRepo, runner.dataSource, runner.messaging, runner.missions,
        runner.teams, runner.actionsService, runner.logService,
        notifyOverride ?? runner.confirmNotify,
      ),
    /** 이 스테이지의 소유자에게 간 발송만. 다른 테스트 미션의 리마인더를 걸러낸다. */
    mine: () => outbox.filter((o) => o.userId === HUMAN.id),
    /** step 엔티티를 직접 읽는다 — 선점 마커는 내부 상태라 API 뷰에 없다. */
    gateRow: async (stepId) => ds.getRepository('OrchestrationStep').findOne({ where: { id: stepId } }),
    setMode: (m) => { mode = m; },
    leadMcp: await mcpFor(lead, 'lead'),
    workerMcp: await mcpFor(worker, 'worker'),
  };
}

const planFor = (worker, { loopCap = 3 } = {}) => ({
  summary: 'build, ask a person, then either ship or rework.',
  steps: [
    { step_key: 'build', title: 'Build the page', instructions: 'Build it and attach a screenshot.', assignee_agent_id: worker.id },
    {
      step_key: 'gate',
      title: 'Does the page look right?',
      instructions: 'Look at the screenshot and pass only if the layout matches the mockup.',
    },
    { step_key: 'ship', title: 'Ship it', instructions: 'Release it.', assignee_agent_id: worker.id },
  ],
  graph: {
    nodes: [
      { key: 'build', max_visits: loopCap },
      { key: 'gate', kind: 'confirm', max_visits: loopCap },
    ],
    edges: [
      { from: 'build', to: 'gate' },
      { from: 'gate', to: 'ship', kind: 'conditional', when: { verdict: ['pass'] }, label: 'looks right' },
      { from: 'gate', to: 'build', kind: 'loop_back', when: { verdict: ['fail'] }, label: 'needs rework' },
    ],
    max_total_visits: 40,
  },
});

async function report(mcp, stepId, body) {
  const lease = (await mcp.callTool('get_orchestration_step', { step_id: stepId }))?.lease_token;
  const result = await mcp.callTool('report_orchestration_step', {
    step_id: stepId,
    ...(lease ? { lease_token: lease } : {}),
    ...body,
  });
  assert.ok(!result?.isError, `report failed: ${JSON.stringify(result)}`);
  return result;
}

/** build 를 done 으로 보고해 게이트를 연 뒤, 배경 발송이 끝날 때까지 기다린다. */
async function advanceToGate(s, { visit = 1 } = {}) {
  const { ws, missions, mission, workerMcp, notify } = s;
  const { byKey } = await readSteps(missions, mission.id, ws.id);
  await report(workerMcp, byKey.build.id, {
    status: 'done',
    summary: 'built the page',
    artifacts: [{ kind: 'screenshot', ref: 'https://cdn.example.com/p.png', label: 'page' }],
    visit,
  });
  // 발송은 미션 락 밖에서 배경으로 돈다(그래야 락이 매달리지 않는다). 단언 전에 정착시킨다.
  await notify.settled();
}

// ─────────────────────────────────────────────────────────────────────────────

test('게이트가 열리면 알림이 정확히 1회, 미션명·질문·판정 링크와 함께 나간다', async (t) => {
  const prevUrl = process.env.AWB_PUBLIC_URL;
  process.env.AWB_PUBLIC_URL = 'https://awb.test';
  t.after(() => {
    if (prevUrl === undefined) delete process.env.AWB_PUBLIC_URL;
    else process.env.AWB_PUBLIC_URL = prevUrl;
  });

  const s = await stage(t, { label: 'open' });
  const { ws, missions, mission, worker, leadMcp, mine, HUMAN } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  assert.equal(mine().length, 0, '게이트가 열리기 전에는 아무것도 나가지 않는다');

  step('build 가 끝나 게이트가 열리면 소유자에게 알림이 간다');
  await advanceToGate(s);

  assert.equal(mine().length, 1, '게이트 오픈 1회 = 알림 1회');
  const { userId, notifyKey, payload } = mine()[0];
  assert.equal(userId, HUMAN.id, '미션 소유자에게 간다');
  assert.equal(notifyKey, 'notify_mention');
  assert.match(payload.title, /Notify mission open/, '미션명');
  assert.match(payload.body, /pass only if the layout matches/, '질문(instructions)');
  assert.equal(
    payload.url,
    `https://awb.test/ws/${ws.id}/orchestration/missions/${mission.id}`,
    '판정 화면으로 가는 링크',
  );

  step('발송 사실이 step 컬럼과 타임라인 양쪽에 남는다');
  const { detail, byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(byKey.gate.status, 'awaiting_user');
  const gateRow = await s.gateRow(byKey.gate.id);
  assert.equal(gateRow.confirm_notified_visit, 1, '중복 방지 키는 pass 번호다');
  assert.ok(gateRow.confirm_notified_at, '선점 시각이 리마인더 대기 시간의 기준점이 된다');
  assert.equal(gateRow.confirm_reminded_visit, null, '아직 리마인더는 나가지 않았다');
  const notified = eventsOfType(detail, 'confirm_notified');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].data.sent, 1, '실제 전달 채널 수는 타임라인에 남는다');
});

test('같은 pass 에서 pump 가 여러 번 돌아도 알림은 늘어나지 않는다', async (t) => {
  const s = await stage(t, { label: 'dedupe' });
  const { ws, missions, mission, runner, worker, leadMcp, notify, mine, HUMAN } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  assert.equal(mine().length, 1);

  step('저장된 상태에서 엔진을 다시 진입시킨다 — 재시작과 같은 경로다');
  for (let i = 0; i < 3; i += 1) {
    await runner.pauseMission(mission.id, ws.id, HUMAN);
    await runner.resumeMission(mission.id, ws.id, HUMAN);
  }
  await notify.settled();

  const { detail, byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(mine().length, 1, 'pump 를 세 번 더 돌려도 알림은 그대로 1회다');
  assert.equal(eventsOfType(detail, 'confirm_notified').length, 1, '타임라인도 1건');
  assert.equal(byKey.gate.visit, 1, 'pass 번호가 재진입으로 올라가지 않는다');
});

test('loop 재진입으로 다음 pass 에 게이트가 다시 열리면 새 알림이 나간다', async (t) => {
  const s = await stage(t, { label: 'loop' });
  const { ws, missions, mission, runner, worker, leadMcp, notify, mine, HUMAN } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(mine().length, 1, 'pass 1 알림');

  step('사람이 fail 을 내면 build 로 되돌아간다');
  await runner.submitConfirmDecision(byKey.gate.id, ws.id, HUMAN, {
    verdict: 'fail',
    feedback: 'the header is misaligned',
    visit: 1,
  });
  await notify.settled();
  assert.equal(mine().length, 1, '판정 자체는 알림을 만들지 않는다');

  step('재작업이 끝나 게이트가 pass 2 로 다시 열리면 새 알림이 나간다');
  await advanceToGate(s, { visit: 2 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));

  assert.equal(byKey.gate.visit, 2, 'loop 재진입으로 pass 가 올라갔다');
  assert.equal(mine().length, 2, '각 pass 는 각각 알릴 가치가 있다');
  assert.equal(
    (await s.gateRow(byKey.gate.id)).confirm_notified_visit,
    2,
    '중복 방지 키가 새 pass 로 갱신된다',
  );
  assert.match(mine()[1].payload.body, /pass 2/, '몇 번째 확인인지 사람이 알 수 있어야 한다');

  step('pass 2 에서도 pump 재실행이 알림을 늘리지 않는다');
  await runner.pauseMission(mission.id, ws.id, HUMAN);
  await runner.resumeMission(mission.id, ws.id, HUMAN);
  await notify.settled();
  assert.equal(mine().length, 2);
});

test('판정을 제출한 뒤에는 리퍼를 아무리 돌려도 알림이 나가지 않는다', async (t) => {
  const s = await stage(t, { label: 'decided' });
  const { ws, missions, mission, runner, reaper, worker, leadMcp, notify, mine, HUMAN } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  const { byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(mine().length, 1);

  step('pass 판정으로 게이트를 닫는다');
  const decided = await runner.submitConfirmDecision(byKey.gate.id, ws.id, HUMAN, { verdict: 'pass', visit: 1 });
  assert.deepEqual(decided.dispatched, ['ship']);
  await notify.settled();

  step('리마인더 창을 한참 넘겨 스윕을 여러 번 돌린다');
  for (const days of [2, 5, 9]) {
    await reaper.runOnce(new Date(Date.now() + days * 24 * HOUR));
  }
  await notify.settled();

  const after = await readSteps(missions, mission.id, ws.id);
  assert.equal(mine().length, 1, '판정된 게이트에는 리마인더가 나가지 않는다');
  assert.equal(after.byKey.gate.status, 'done');
  assert.equal(eventsOfType(after.detail, 'confirm_notified').length, 1);
});

test('알림이 실패해도 게이트는 열리고 미션은 정상 진행한다 (요구사항 6)', async (t) => {
  const s = await stage(t, { label: 'failure' });
  const { ws, missions, mission, runner, worker, leadMcp, notify, mine, HUMAN, setMode } = s;

  step('알림 백엔드가 예외를 던지도록 만든다');
  setMode('throw');

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);

  const { detail, byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(mine().length, 1, '시도는 했다');
  assert.equal(byKey.gate.status, 'awaiting_user', '발송 실패가 게이트 오픈을 죽이면 안 된다');
  assert.deepEqual(
    byKey.gate.artifacts.map((a) => a.ref),
    ['https://cdn.example.com/p.png'],
    '판정 근거 스냅샷도 정상이다',
  );
  assert.equal(eventsOfType(detail, 'confirm_requested').length, 1);
  const notified = eventsOfType(detail, 'confirm_notified');
  assert.equal(notified.length, 1, '실패도 감사 로그로 남는다');
  assert.equal(notified[0].data.sent, 0);
  assert.equal(notified[0].data.failed, 1);

  step('사람이 답하면 미션은 그대로 이어진다 — 알림 장애가 실행을 막지 않는다');
  const decided = await runner.submitConfirmDecision(byKey.gate.id, ws.id, HUMAN, { verdict: 'pass', visit: 1 });
  await notify.settled();
  assert.deepEqual(decided.dispatched, ['ship'], '알림이 실패했어도 판정과 재개는 정상이다');
});

test('장기 미응답이면 리마인더가 1회만 나가고, 미션 상태는 한 글자도 바뀌지 않는다 (요구사항 5)', async (t) => {
  const s = await stage(t, { label: 'reminder' });
  const { ds, ws, missions, mission, reaper, worker, leadMcp, notify, mine } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  assert.equal(mine().length, 1);

  const before = await readSteps(missions, mission.id, ws.id);
  const eventsBefore = before.detail.events.length;
  const postsBefore = await ds
    .getRepository('ChatRoomMessage')
    .count({ where: { room_id: before.detail.room_id } });

  step('리마인더 창(기본 24시간) 안에서는 아무것도 나가지 않는다');
  await reaper.runOnce(new Date(Date.now() + 6 * HOUR));
  await notify.settled();
  assert.equal(mine().length, 1, '창 안에서는 재촉하지 않는다');

  step('창을 넘기면 리마인더가 나간다');
  await reaper.runOnce(new Date(Date.now() + 26 * HOUR));
  await notify.settled();
  assert.equal(mine().length, 2, '리마인더 1회');
  assert.match(mine()[1].payload.title, /Still waiting on your decision/);
  assert.match(mine()[1].payload.body, /26h/, '얼마나 기다렸는지 알려준다');
  assert.equal(mine()[1].payload.url, mine()[0].payload.url, '같은 판정 화면으로 보낸다');

  step('스윕이 더 돌아도 같은 pass 에 두 번째 리마인더는 없다');
  for (const hours of [30, 50, 80]) {
    await reaper.runOnce(new Date(Date.now() + hours * HOUR));
  }
  await notify.settled();
  assert.equal(mine().length, 2, '재알림은 pass 당 1회다');

  step('리마인더는 알림일 뿐 상태 전이가 아니다 — 리퍼가 미션을 죽이지 않는다는 계약은 그대로');
  const after = await readSteps(missions, mission.id, ws.id);
  assert.equal(after.detail.status, 'running', '미션은 여전히 살아 있다');
  assert.equal(after.byKey.gate.status, 'awaiting_user', '게이트도 그대로 열려 있다');
  assert.equal(after.byKey.gate.confirm_decision, null, '리퍼가 판정을 대신 채우지 않는다');
  assert.equal(after.byKey.gate.visit, 1, 'pass 번호가 리마인더로 올라가지 않는다');
  assert.equal(
    await ds.getRepository('ChatRoomMessage').count({ where: { room_id: after.detail.room_id } }),
    postsBefore,
    '오케스트레이터를 깨우지 않는다 — 리마인더는 사람에게 가는 것이지 subagent 를 띄우는 게 아니다',
  );
  for (const forbidden of ['orchestrator_woken', 'mission_failed', 'step_failed', 'step_needs_recovery']) {
    assert.equal(eventsOfType(after.detail, forbidden).length, 0, `${forbidden} 이 생기면 안 된다`);
  }
  // 리퍼가 이 미션에 남기는 것은 confirm_notified 하나뿐이어야 한다.
  assert.equal(
    after.detail.events.length - eventsBefore,
    1,
    '리마인더 기록 외에 리퍼가 이벤트를 남기면 안 된다: ' +
      JSON.stringify(after.detail.events.slice(0, after.detail.events.length - eventsBefore).map((e) => e.type)),
  );
});

test('서버가 둘이어도 같은 (step, visit) 은 정확히 1회만 나간다 — 승패는 DB 가 정한다', async (t) => {
  // 리뷰 지적 2. `missionLocks` 는 **프로세스 메모리**라 운영(PostgreSQL)에서 서버가 둘이면
  // 두 pump 가 같은 pass 를 동시에 열 수 있다. 예전 코드는 손에 든 엔티티에서
  // `confirm_notice` 를 읽어 판단한 뒤 일반 save 를 하고 보냈으므로, 둘 다 "아직 안 보냈다"를
  // 읽으면 둘 다 보냈다 — 사람에게 같은 질문이 두 번 울린다.
  //
  // 그래서 여기서는 **두 경쟁자가 모두 낡은 스냅샷을 읽었다는 사실을 배리어로 못박은 뒤**
  // 동시에 출발시킨다. 프로세스 안의 무언가가 막아 주는 것이 아님을 보이기 위해 경쟁자는
  // 서로 다른 서비스 인스턴스다(= 서로 다른 서버).
  const s = await stage(t, { label: 'contend' });
  const { ds, ws, missions, mission, worker, leadMcp, notify, mine, HUMAN } = s;
  const stepRepo = ds.getRepository('OrchestrationStep');

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  const { byKey } = await readSteps(missions, mission.id, ws.id);
  const gateId = byKey.gate.id;
  assert.equal(mine().length, 1, '게이트 오픈 자체는 평소대로 1회');

  step('두 서버가 같은 pass 를 동시에 pump 하기 직전 상태를 만든다 — 아직 아무도 선점하지 않았다');
  await stepRepo.update({ id: gateId }, { confirm_notified_visit: null, confirm_notified_at: null });
  s.outbox.length = 0;

  const serverA = notify;                      // 이 앱의 인스턴스
  const serverB = s.secondServerNotify();      // 같은 DB 를 보는 두 번째 서버
  const bothRead = barrier(2);
  const wins = [];

  const contendForGateNotice = async (svc, tag) => {
    // 1) 낡은 스냅샷을 읽는다 — 예전 코드가 판단 근거로 삼던 바로 그 값이다.
    const snapshot = await stepRepo.findOne({ where: { id: gateId } });
    assert.equal(
      snapshot.confirm_notified_visit,
      null,
      `${tag}: 두 경쟁자가 모두 "아직 안 보냈다"를 읽어야 이 테스트가 의미가 있다`,
    );
    // 2) 둘 다 읽을 때까지 아무도 쓰지 않는다(happens-before).
    await bothRead();
    // 3) 이제 동시에 선점을 시도한다. 이긴 쪽만 보낸다.
    if (await svc.claimGateNotice(snapshot, snapshot.visit)) {
      wins.push(tag);
      svc.scheduleGateNotice(mission, snapshot);
    }
  };

  await Promise.all([contendForGateNotice(serverA, 'A'), contendForGateNotice(serverB, 'B')]);
  await Promise.all([serverA.settled(), serverB.settled()]);

  assert.deepEqual(wins.length, 1, `승자는 하나뿐이어야 한다 (실제: ${JSON.stringify(wins)})`);
  assert.equal(mine().length, 1, '실제 최종 발송은 1회다');
  assert.equal((await stepRepo.findOne({ where: { id: gateId } })).confirm_notified_visit, 1);

  step('리마인더도 마찬가지 — 여러 서버의 리퍼가 같은 주기에 돌아도 1회다');
  const bothReadReminder = barrier(2);
  const reminderWins = [];
  const contendForReminder = async (svc, tag) => {
    const snapshot = await stepRepo.findOne({ where: { id: gateId } });
    assert.equal(snapshot.confirm_reminded_visit, null, `${tag}: 아직 리마인더는 나가지 않았다`);
    await bothReadReminder();
    if (await svc.claimReminder(snapshot, snapshot.visit)) {
      reminderWins.push(tag);
      await svc.sendReminder(mission, snapshot, 30 * HOUR);
    }
  };
  await Promise.all([contendForReminder(serverA, 'A'), contendForReminder(serverB, 'B')]);
  await Promise.all([serverA.settled(), serverB.settled()]);

  assert.equal(reminderWins.length, 1, `리마인더 승자도 하나뿐 (실제: ${JSON.stringify(reminderWins)})`);
  assert.equal(mine().length, 2, '최초 1회 + 리마인더 1회');
  assert.match(mine()[1].payload.title, /Still waiting on your decision/);

  step('판정이 들어온 뒤에는 선점 자체가 실패한다 — 요구사항 4를 같은 한 방이 보장한다');
  await s.runner.submitConfirmDecision(gateId, ws.id, HUMAN, { verdict: 'pass', visit: 1 });
  const afterDecision = await stepRepo.findOne({ where: { id: gateId } });
  assert.equal(
    await serverB.claimReminder({ ...afterDecision, confirm_reminded_visit: null }, 1),
    false,
    'status 가 awaiting_user 가 아니면 선점 조건에서 걸린다',
  );
  assert.equal(mine().length, 2, '판정 뒤에는 아무것도 나가지 않는다');
});

test('두 서버가 **실제 openConfirmGate 로** 같은 게이트를 열어도 발송은 1회다 (리뷰 라운드2)', async (t) => {
  // 리뷰 라운드2 P1. 선점 UPDATE 자체는 원자적이지만, **그 앞에 있는 게이트 상태 저장이
  // 선점을 무효화**할 수 있었다:
  //
  //   1. A 가 게이트를 열고 선점에 성공해 `confirm_notified_visit = 1` 을 기록한다.
  //   2. B 는 아직 `confirm_notified_visit = null` 인 **낡은 엔티티**로 게이트를 연다.
  //      full entity save 는 엔티티 전체를 쓰므로 A 의 마커를 null 로 되돌린다.
  //   3. B 의 조건부 UPDATE 도 다시 성공한다 → 둘 다 보낸다.
  //
  // 앞선 경쟁 테스트는 `claimGateNotice()` 를 직접 불러서 이 save 를 지나지 않았다.
  // 그래서 여기서는 **실제 `openConfirmGate()` 경로**를 두 서버가 각각 통과시킨다.
  //
  // 순서는 배리어로 전제를 못박은 뒤 **결정적으로 재생**한다. 위험한 인터리빙은 정확히
  // "A 의 선점이 끝난 뒤 B 의 저장이 도착하는" 하나뿐이라, 스케줄러가 그 순서를 내주기를
  // 바라는 대신 그 순서를 직접 만든다 — 고정 지연도, 운에 맡기는 경쟁도 아니다.
  const s = await stage(t, { label: 'gate-race' });
  const { ds, ws, missions, mission, runner, worker, leadMcp, notify, mine } = s;
  const stepRepo = ds.getRepository('OrchestrationStep');
  const missionRepo = ds.getRepository('OrchestrationMission');

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  const { byKey } = await readSteps(missions, mission.id, ws.id);
  const gateId = byKey.gate.id;
  assert.equal(mine().length, 1, '평소 경로로는 1회');

  step('두 서버가 게이트를 열기 직전 상태로 되돌린다 — 아직 아무도 선점하지 않았다');
  // 타임라인은 비울 수 없으므로(감사 기록이다) 기준선을 재 두고 뒤에서 델타로 센다.
  const initialEventsBefore = eventsOfType(
    (await readSteps(missions, mission.id, ws.id)).detail,
    'confirm_notified',
  ).filter((e) => e.data?.kind === 'initial').length;
  await stepRepo.update({ id: gateId }, { confirm_notified_visit: null, confirm_notified_at: null });
  s.outbox.length = 0;

  const serverB = s.secondServerRunner(s.secondServerNotify());
  const freshMission = await missionRepo.findOne({ where: { id: mission.id } });
  const allSteps = await stepRepo.find({ where: { mission_id: mission.id } });

  const bothRead = barrier(2);
  const snapshots = {};
  const readStale = async (tag) => {
    const snap = await stepRepo.findOne({ where: { id: gateId } });
    assert.equal(
      snap.confirm_notified_visit,
      null,
      `${tag}: 두 서버가 모두 "아직 안 보냈다"를 읽어야 이 테스트가 의미가 있다`,
    );
    snapshots[tag] = snap;
    // 누구도 아직 쓰지 않았다는 사실을 못박는다(happens-before).
    await bothRead();
  };
  await Promise.all([readStale('A'), readStale('B')]);

  step('A 가 실제 openConfirmGate 로 게이트를 열고 선점한다');
  await runner.openConfirmGate(freshMission, snapshots.A, allSteps);
  await notify.settled();
  assert.equal(
    (await stepRepo.findOne({ where: { id: gateId } })).confirm_notified_visit,
    1,
    'A 의 선점이 DB 에 남아야 한다',
  );

  step('B 가 **낡은 스냅샷**으로 같은 경로를 통과한다 — 여기서 A 의 마커가 지워지면 안 된다');
  await serverB.openConfirmGate(freshMission, snapshots.B, allSteps);
  await notify.settled();
  await s.secondServerNotify().settled();

  const after = await stepRepo.findOne({ where: { id: gateId } });
  assert.equal(after.confirm_notified_visit, 1, 'B 의 게이트 상태 저장이 A 의 선점을 되돌리면 안 된다');
  assert.equal(after.status, 'awaiting_user', '게이트는 정상적으로 열려 있다');
  assert.equal(mine().length, 1, '두 서버가 실제 경로를 통과해도 사람에게는 1회만 간다');

  step('타임라인에도 이번 경쟁에서 늘어난 발송 기록은 하나뿐이다');
  const { detail } = await readSteps(missions, mission.id, ws.id);
  const initialEventsAfter = eventsOfType(detail, 'confirm_notified')
    .filter((e) => e.data?.kind === 'initial').length;
  assert.equal(
    initialEventsAfter - initialEventsBefore,
    1,
    `두 서버가 열었지만 confirm_notified(initial) 은 1건만 늘어야 한다 ` +
      `(before=${initialEventsBefore}, after=${initialEventsAfter})`,
  );
});

test('실행 중 미션이 100개를 넘어도 뒤쪽 게이트가 후속 스윕에서 반드시 리마인드된다', async (t) => {
  // 리뷰 지적 1. 예전 스윕은 `status='running'` 미션을 **무순서** `take:100` 으로 자른 뒤
  // 그 안에서 게이트를 찾았다. 실행 중 미션이 100개를 넘고 DB 가 매번 같은 100개를 돌려주면,
  // 101번째 이후의 게이트는 아무리 오래 기다려도 **한 번도 검사되지 않는다**(영구 기아).
  // 앞쪽 100개가 전부 리마인드를 끝내 자격을 잃어도, 잘라오는 100개는 그대로라 뒤쪽은
  // 영원히 차례가 오지 않는다.
  //
  // 그래서 만료된 게이트를 창(`CONFIRM_REMINDERS_PER_SWEEP`=25)보다도, 옛 미션 창(100)보다도
  // 많이 만들어 두고 **전부가 결국 1회씩** 리마인드되는지 본다. 특히 마지막에 삽입된
  // 꼬리 후보들이 핵심이다 — 옛 코드에서 0회였던 바로 그 행들이다.
  const s = await stage(t, { label: 'starve' });
  const { ds, ws, team, reaper, notify, outbox } = s;
  const missionRepo = ds.getRepository('OrchestrationMission');
  const stepRepo = ds.getRepository('OrchestrationStep');

  const TOTAL = 120;              // 옛 미션 창(100) 초과
  const TAIL_START = 100;         // 이 인덱스부터가 옛 코드에서 영원히 굶던 구간
  const OWNER = `qa-owner-starve-fanout`;
  const openedAt = new Date(Date.now() - 40 * HOUR);   // 리마인더 창(24h)을 이미 넘긴 상태

  step(`만료된 confirm 게이트 ${TOTAL}개를 삽입 순서대로 만든다`);
  for (let i = 0; i < TOTAL; i += 1) {
    const m = await missionRepo.save(
      missionRepo.create({
        workspace_id: ws.id,
        team_id: team.id,
        title: `Starve mission ${i}`,
        objective: 'starvation regression',
        status: 'running',
        created_by_type: 'user',
        created_by: OWNER,
      }),
    );
    await stepRepo.save(
      stepRepo.create({
        mission_id: m.id,
        workspace_id: ws.id,
        team_id: team.id,
        step_key: 'gate',
        title: `Gate ${i}`,
        instructions: 'decide please',
        status: 'awaiting_user',
        visit: 1,
        dispatched_at: openedAt,
        confirm_notified_visit: 1,
        confirm_notified_at: openedAt,
      }),
    );
  }

  const remindedTitles = () =>
    new Set(
      outbox
        .filter((o) => o.userId === OWNER)
        .map((o) => o.payload.title.replace(/^Still waiting on your decision: /, '')),
    );

  step('스윕을 반복한다 — 한 스윕의 상한은 25 라 여러 번 돌아야 다 빠진다');
  let sweeps = 0;
  // 상한은 넉넉히. 이 파일의 다른 테스트가 열어 둔 게이트도 같은 25칸을 나눠 쓴다.
  while (remindedTitles().size < TOTAL && sweeps < 40) {
    await reaper.runOnce(new Date());
    await notify.settled();
    sweeps += 1;
  }

  const reminded = remindedTitles();
  const missing = [];
  for (let i = 0; i < TOTAL; i += 1) {
    if (!reminded.has(`Starve mission ${i}`)) missing.push(i);
  }
  assert.deepEqual(missing, [], `모든 후보가 결국 검사돼야 한다. 굶은 인덱스: ${missing.join(',')}`);

  step(`옛 미션 창(100) 밖의 꼬리 후보 ${TOTAL - TAIL_START}개가 핵심이다`);
  for (let i = TAIL_START; i < TOTAL; i += 1) {
    assert.ok(reminded.has(`Starve mission ${i}`), `꼬리 후보 ${i} 가 굶었다`);
  }

  step('그리고 아무도 두 번 받지 않는다 — 선점 마커가 후보 집합에서 영구히 빼 준다');
  const perTitle = new Map();
  for (const o of outbox.filter((x) => x.userId === OWNER)) {
    const key = o.payload.title;
    perTitle.set(key, (perTitle.get(key) ?? 0) + 1);
  }
  const duplicated = Array.from(perTitle.entries()).filter(([, n]) => n > 1);
  assert.deepEqual(duplicated, [], `pass 당 1회여야 한다: ${JSON.stringify(duplicated)}`);

  step('스윕을 더 돌려도 늘어나지 않는다');
  const settledCount = outbox.filter((o) => o.userId === OWNER).length;
  for (let i = 0; i < 3; i += 1) await reaper.runOnce(new Date());
  await notify.settled();
  assert.equal(outbox.filter((o) => o.userId === OWNER).length, settledCount);
});

exitAfterTests();
