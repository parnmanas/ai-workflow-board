// QA flow: 그래프 실행 end-to-end (티켓 1ca9e49b).
//
// `orchestration-lifecycle.test.mjs`가 wave/DAG 미션에 대해 하는 일을 그래프
// 미션에 대해 한다 — 실제 엔진을 태우고, 에이전트가 하는 모든 동작은 MCP HTTP로
// 나가서 tool 스키마·세션 신원 해석·authz 게이트까지 함께 검증된다.
//
// 하나의 미션 그래프가 네 가지 실행 형태를 전부 담는다:
//
//     spec ──┬─→ api ──┐
//            └─→ ui  ──┴─→ integrate ─→ review ─┬─(approve)→ ship
//                          ▲                     ├─(reject) → abort
//                          └────(revise, loop)───┘
//
//   선형      spec → (fan-out)
//   병렬      api ‖ ui            — 서로 의존이 없어 같이 디스패치된다
//   fan-in    integrate (join=all) — 둘 다 끝나야 시작한다
//   조건 분기  review의 verdict가 ship / abort 중 하나만 살린다
//   bounded loop  verdict=revise면 integrate+review만 리셋되고 재진입한다
//
// 수용 기준 대응:
//   1. 위 네 형태를 실제로 end-to-end 실행한다.
//   2. loop는 반복 상한에 걸리면 조용히 도는 대신 멈추고 오케스트레이터를 깨운다.
//   3. 재진입으로 무효가 된 이전 pass의 보고는 거부된다(중복 실행 통제), 그리고
//      엔진을 저장된 상태에서 다시 진입시켜도 이미 in-flight인 step을 다시
//      디스패치하지 않는다(crash/restart 복구).
//   4. 실행 trace에 각 edge의 선택/기각 이유와 반복 이력이 남는다.
//   5. graph 모드가 꺼진 미션은 graph 입력을 조용히 무시하지 않고 거부한다.
//   6. (리뷰 반영) fan-out 경계에서 global budget이 초과되지 않는다 — 남은 예산보다
//      ready node가 많아도 예산만큼만 나간다.
//   7. (리뷰 반영) graph 미션에서 `visit`을 뺀 지각 보고도 409로 거부되고, 현재
//      iteration 상태가 그대로 보존된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, createWorkspace } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_GRAPH_PORT || '7950';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

async function loadOrchestrationServices() {
  const team = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-team.service.js')).href
  );
  const mission = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')).href
  );
  const runner = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-runner.service.js')).href
  );
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
  };
}

const HUMAN = { type: 'user', id: 'qa-operator', name: 'QA Operator' };

let shared = null;
async function sharedApp() {
  if (!shared) {
    shared = await bootApp({ port: parseInt(process.env.PORT, 10) });
    shared.services = await loadOrchestrationServices();
    const { app } = shared;
    process.on('exit', () => { void app.close().catch(() => {}); });
  }
  return shared;
}

/** 이 step 앞으로 열린 디스패치 room 수 = 실제로 subagent를 띄운 횟수. */
async function roomCountFor(ds, stepId) {
  return ds.getRepository('ChatRoom').count({ where: { orchestration_step_id: stepId } });
}

/**
 * 실행 trace. 일부러 이벤트 테이블을 직접 읽지 않고 `getMissionDetail`의 투영을
 * 쓴다 — `step_key`는 행에 저장되는 값이 아니라 이 투영이 step_id로부터 파생하는
 * 값이라, UI가 실제로 렌더링하는 것과 같은 경로로 확인해야 의미가 있다.
 */
async function eventsOf(missions, missionId, workspaceId) {
  const detail = await missions.getMissionDetail(missionId, workspaceId);
  return detail.events;
}

/** 미션 상세를 step_key로 색인해서 돌려준다. */
async function readSteps(missions, missionId, workspaceId) {
  const detail = await missions.getMissionDetail(missionId, workspaceId);
  return { detail, byKey: Object.fromEntries(detail.steps.map((s) => [s.step_key, s])) };
}

/**
 * 이 파일의 모든 테스트가 쓰는 공통 무대: 팀 + 그래프 모드 미션 + 브리핑 완료.
 * 각 테스트는 자기 workspace를 새로 만들어 서로 간섭하지 않는다.
 */
async function stage(t, { graphEnabled = true, label = 'graph' } = {}) {
  const { app, port, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);

  const ws = await createWorkspace(app, getDataSourceToken, `orch-${label}`);
  const lead = await createAgent(app, getDataSourceToken, ws.id, { name: `lead-${label}` });
  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: `worker-${label}` });
  const critic = await createAgent(app, getDataSourceToken, ws.id, { name: `critic-${label}` });

  const mcpFor = async (agent, name) => {
    const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: name });
    const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
    t.after(() => { void client.close().catch(() => {}); });
    return client;
  };

  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: `Graph squad ${label}`,
    orchestrator_agent_id: lead.id,
    max_parallel_steps: 4,
    created_by: HUMAN.id,
  });
  // max_concurrent 기본값은 1이다 — 이 그래프는 같은 builder에게 병렬 node
  // (api ‖ ui)를 맡기므로 올려두지 않으면 member 상한에서 직렬화돼 fan-out
  // 자체를 검증할 수 없다.
  await teams.addMember(team.id, ws.id, {
    agent_id: worker.id,
    role_label: 'builder',
    capabilities: 'builds things',
    max_concurrent: 4,
  });
  await teams.addMember(team.id, ws.id, {
    agent_id: critic.id,
    role_label: 'reviewer',
    capabilities: 'judges work',
    max_concurrent: 2,
  });

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: `Graph mission ${label}`,
    objective: 'Exercise the execution graph end to end.',
    max_parallel_steps: 4,
    graph_enabled: graphEnabled,
    created_by_type: 'user',
    created_by: HUMAN.id,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);

  return {
    app,
    // createWorkspace/createAgent 등 fixture 헬퍼가 요구하는 DataSource 토큰 게터.
    getDataSourceToken,
    ds,
    ws,
    lead,
    worker,
    critic,
    team,
    mission,
    missions,
    runner,
    leadMcp: await mcpFor(lead, 'lead'),
    workerMcp: await mcpFor(worker, 'worker'),
    criticMcp: await mcpFor(critic, 'critic'),
  };
}

/** 위 다이어그램의 plan + graph. `loopCap`으로 반복 상한을 바꿔 끼운다. */
const planFor = (worker, critic, loopCap = 3) => ({
  summary: 'fan-out, fan-in, an evaluator branch and a bounded revision loop.',
  steps: [
    { step_key: 'spec', title: 'Write the spec', instructions: 'Draft it.', assignee_agent_id: worker.id },
    { step_key: 'api', title: 'Build the API', instructions: 'Build it.', assignee_agent_id: worker.id },
    { step_key: 'ui', title: 'Build the UI', instructions: 'Build it.', assignee_agent_id: worker.id },
    { step_key: 'integrate', title: 'Integrate', instructions: 'Wire them together.', assignee_agent_id: worker.id },
    { step_key: 'review', title: 'Review the integration', instructions: 'Judge it.', assignee_agent_id: critic.id },
    { step_key: 'ship', title: 'Ship', instructions: 'Release it.', assignee_agent_id: worker.id },
    { step_key: 'abort', title: 'Roll back', instructions: 'Undo it.', assignee_agent_id: worker.id },
  ],
  graph: {
    nodes: [
      { key: 'integrate', join: 'all', max_visits: loopCap },
      { key: 'review', kind: 'evaluator', max_visits: loopCap },
    ],
    edges: [
      { from: 'spec', to: 'api' },
      { from: 'spec', to: 'ui' },
      { from: 'api', to: 'integrate' },
      { from: 'ui', to: 'integrate' },
      { from: 'integrate', to: 'review' },
      { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] }, label: 'looks good' },
      { from: 'review', to: 'abort', kind: 'conditional', when: { verdict: ['reject'] }, label: 'unsalvageable' },
      { from: 'review', to: 'integrate', kind: 'loop_back', when: { verdict: ['revise'] }, label: 'needs another pass' },
    ],
    max_total_visits: 40,
  },
});

/** MCP로 step을 보고한다. 실패하면 서버 메시지를 그대로 드러낸다. */
async function report(mcp, stepId, body, { expectError = false } = {}) {
  // lease token 은 실제 작업자가 work order 에서 복사해 오는 값이다(티켓 4d065f82).
  // 호출자가 명시하지 않으면 지금 유효한 값을 대신 채워 넣는다 — 일부러 stale 한
  // 토큰을 보내는 테스트는 body 에 직접 넣어 이 기본값을 덮어쓴다.
  const lease =
    'lease_token' in body ? body.lease_token : (await mcp.callTool('get_orchestration_step', { step_id: stepId }))?.lease_token;
  const result = await mcp.callTool('report_orchestration_step', {
    step_id: stepId,
    ...(lease ? { lease_token: lease } : {}),
    ...body,
  });
  if (expectError) {
    assert.ok(result?.isError, `expected the report to be rejected, got ${JSON.stringify(result)}`);
    return result;
  }
  assert.ok(!result?.isError, `report failed: ${JSON.stringify(result)}`);
  return result;
}

test('그래프 실행: 선형 → 병렬 → fan-in → 조건 분기 → bounded loop', async (t) => {
  const s = await stage(t, { label: 'main' });
  const { ds, ws, missions, mission, worker, critic, leadMcp, workerMcp, criticMcp } = s;

  // ── 1. 그래프가 붙은 plan 제출 ────────────────────────────────────────────
  step('오케스트레이터가 조건 분기 + loop를 담은 그래프를 제출한다');
  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker, critic),
  });
  assert.ok(!submitted?.isError, `submit failed: ${JSON.stringify(submitted)}`);
  assert.equal(submitted.graph.nodes, 7, '모든 step이 node가 된다');
  assert.equal(submitted.graph.loops, 1, 'loop_back edge가 하나 확정됐다');
  assert.deepEqual(submitted.graph.entry, ['spec'], 'entry는 spec 하나');
  assert.deepEqual(submitted.graph.terminal.sort(), ['abort', 'ship'], 'terminal은 두 분기의 끝');

  // ── 2. 선형: entry만 디스패치된다 ────────────────────────────────────────
  step('entry node만 즉시 디스패치된다');
  assert.deepEqual(submitted.dispatched_now, ['spec'], '조건/의존이 남은 node는 아직 나가지 않는다');
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(byKey.spec.status, 'dispatched');
  assert.equal(byKey.spec.visit, 1, '최초 실행은 visit=1');
  assert.equal(byKey.api.status, 'pending');

  // ── 3. 병렬: fan-out ────────────────────────────────────────────────────
  step('spec이 끝나면 api와 ui가 동시에 나간다');
  const afterSpec = await report(workerMcp, byKey.spec.id, { status: 'done', summary: 'spec written', visit: 1 });
  assert.deepEqual(afterSpec.next_steps_dispatched.sort(), ['api', 'ui'], 'fan-out이 병렬로 나간다');

  // ── 4. fan-in: join=all ─────────────────────────────────────────────────
  step('integrate는 api와 ui가 둘 다 끝나야 시작한다');
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const afterApi = await report(workerMcp, byKey.api.id, { status: 'done', summary: 'api done', visit: 1 });
  assert.deepEqual(afterApi.next_steps_dispatched, [], 'join=all — 한쪽만 끝나면 아직 대기');
  const afterUi = await report(workerMcp, byKey.ui.id, { status: 'done', summary: 'ui done', visit: 1 });
  assert.deepEqual(afterUi.next_steps_dispatched, ['integrate'], '둘 다 끝나자 fan-in이 시작된다');

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const afterIntegrate = await report(workerMcp, byKey.integrate.id, { status: 'done', summary: 'wired', visit: 1 });
  assert.deepEqual(afterIntegrate.next_steps_dispatched, ['review'], 'evaluator로 넘어간다');

  // ── 5. bounded loop 재진입 ──────────────────────────────────────────────
  step('evaluator가 revise를 내면 loop 본문만 리셋되고 재진입한다');
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const reviewId = byKey.review.id;
  const integrateRoomsBefore = await roomCountFor(ds, byKey.integrate.id);

  const revised = await report(criticMcp, reviewId, {
    status: 'done',
    summary: 'the integration drops an error case',
    verdict: 'revise',
    visit: 1,
  });
  assert.equal(revised.status, 'done', '보고한 상태는 그대로 돌려준다(리셋된 pending이 아니라)');
  assert.deepEqual(revised.loop_reentered.sort(), ['integrate', 'review'], 'loop 본문만 재진입한다');
  assert.deepEqual(revised.next_steps_dispatched, ['integrate'], '재진입한 본문의 시작점이 다시 나간다');

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.integrate.visit, 2, 'integrate는 2번째 pass');
  assert.equal(byKey.integrate.status, 'dispatched');
  assert.equal(byKey.integrate.verdict, '', '재진입 시 이전 pass의 산출물은 지워진다');
  assert.equal(byKey.review.status, 'pending', 'evaluator도 본문이라 함께 리셋된다');
  assert.equal(byKey.review.visit, 2);
  assert.equal(
    await roomCountFor(ds, byKey.integrate.id),
    integrateRoomsBefore + 1,
    '재진입은 새 room 하나만 연다 — 같은 pass를 두 번 띄우지 않는다',
  );

  step('loop 밖의 node는 재진입 때 리셋되지도, 차단되지도 않는다');
  assert.equal(byKey.api.status, 'done', 'loop 본문이 아닌 상류는 확정된 채로 남는다');
  assert.equal(byKey.api.visit, 1, 'loop 밖 node의 pass 수는 늘지 않는다');
  assert.equal(byKey.ship.status, 'pending', 'evaluator가 pending으로 돌아갔으므로 하류는 대기 상태');
  assert.equal(byKey.abort.status, 'pending');

  // ── 6. 중복 실행 통제: 무효가 된 pass의 보고는 거부된다 ──────────────────
  step('재진입으로 무효가 된 이전 pass의 보고는 거부된다');
  const stale = await report(
    criticMcp,
    reviewId,
    { status: 'done', summary: 'late report from the superseded pass', verdict: 'approve', visit: 1 },
    { expectError: true },
  );
  assert.match(
    JSON.stringify(stale),
    /stale report|iteration/i,
    '이전 pass 번호를 단 보고는 새 pass의 결과를 덮어쓰지 못한다',
  );
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.review.status, 'pending', '거부된 보고는 상태를 바꾸지 않았다');
  assert.equal(byKey.review.verdict, '', '거부된 보고의 verdict도 반영되지 않았다');

  // ── 7. 조건 분기 ────────────────────────────────────────────────────────
  step('두 번째 pass가 승인되면 선택된 분기만 살고 나머지는 차단된다');
  await report(workerMcp, byKey.integrate.id, { status: 'done', summary: 'error case handled', visit: 2 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.review.status, 'dispatched', 'evaluator가 2번째 pass로 다시 나갔다');

  const approved = await report(criticMcp, byKey.review.id, {
    status: 'done',
    summary: 'looks right now',
    verdict: 'approve',
    visit: 2,
  });
  assert.deepEqual(approved.next_steps_dispatched, ['ship'], '승인 분기만 디스패치된다');
  assert.deepEqual(approved.loop_reentered, [], 'approve는 loop를 발화시키지 않는다');

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.abort.status, 'blocked', '선택되지 않은 분기는 영구 차단된다');
  assert.equal(byKey.ship.status, 'dispatched');

  // ── 8. 실행 trace ───────────────────────────────────────────────────────
  step('trace로 각 edge의 선택/기각 이유와 반복 이력을 재구성할 수 있다');
  const events = await eventsOf(missions, mission.id, ws.id);

  const edgePicks = events.filter((e) => e.type === 'edge_selected' && e.step_key === 'review');
  assert.equal(edgePicks.length, 2, 'evaluator의 두 pass가 각각 선택 기록을 남겼다');

  // 배열 순서가 아니라 pass 번호로 집는다: 같은 밀리초에 기록된 이벤트들은
  // created_at 정렬이 동률이라 상대 순서가 보장되지 않는다(이 저장소의
  // *-same-second-* 테스트들이 다루는 것과 같은 함정). 반복 이력을 재구성할 때
  // 실제로 기대야 하는 것도 타임스탬프가 아니라 data.visit이다.
  const pickByVisit = new Map(edgePicks.map((e) => [e.data.visit, e]));
  assert.deepEqual([...pickByVisit.keys()].sort(), [1, 2], '각 pass가 정확히 한 번씩 기록됐다');

  const firstPick = pickByVisit.get(1);
  assert.equal(firstPick.data.verdict, 'revise');
  assert.deepEqual(firstPick.data.taken.map((t) => t.to), ['integrate'], 'revise는 loop_back만 골랐다');
  const rejected = firstPick.data.not_taken.map((t) => t.to).sort();
  assert.deepEqual(rejected, ['abort', 'ship'], '기각된 분기가 전부 기록된다');
  for (const entry of firstPick.data.not_taken) {
    assert.match(entry.reason, /verdict "revise"/, `기각 이유가 사람이 읽을 수 있다: ${entry.reason}`);
  }

  const secondPick = pickByVisit.get(2);
  assert.equal(secondPick.data.verdict, 'approve');
  assert.deepEqual(secondPick.data.taken.map((t) => t.to), ['ship']);
  assert.equal(secondPick.data.taken[0].label, 'looks good', 'edge 라벨이 trace에 실린다');

  const revisits = events.filter((e) => e.type === 'node_revisited');
  assert.equal(revisits.length, 1, '재진입이 한 번 일어났다');
  assert.equal(revisits[0].data.iteration, 2, '몇 번째 반복인지 기록된다');
  assert.equal(revisits[0].data.max_visits, 3, '상한도 함께 남아 여유를 읽을 수 있다');
  assert.deepEqual(revisits[0].data.body.sort(), ['integrate', 'review'], '무엇이 리셋됐는지 남는다');

  const dispatches = events.filter((e) => e.type === 'step_dispatched' && e.step_key === 'integrate');
  assert.deepEqual(
    dispatches.map((e) => e.data.visit).sort(),
    [1, 2],
    '디스패치마다 pass 번호가 남아 반복 이력이 이어진다',
  );

  // ── 9. 예산 회계 ────────────────────────────────────────────────────────
  step('global budget이 실제 디스패치 횟수를 따라간다');
  const { detail } = await readSteps(missions, mission.id, ws.id);
  const totalRooms = await ds.getRepository('ChatRoom').count({ where: { orchestration_mission_id: mission.id } });
  // room 하나는 오케스트레이터 브리핑용이고 나머지가 step 디스패치다.
  assert.equal(detail.total_visits, totalRooms - 1, '예산 소진량 == 실제로 띄운 subagent 수');
  assert.equal(detail.graph_spec.max_total_visits, 40);
});

test('crash/restart: 저장된 상태에서 엔진을 다시 진입시켜도 in-flight step을 다시 띄우지 않는다', async (t) => {
  const s = await stage(t, { label: 'restart' });
  const { ds, ws, missions, runner, mission, worker, critic, leadMcp, workerMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker, critic) });
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  await report(workerMcp, byKey.spec.id, { status: 'done', summary: 'spec written', visit: 1 });

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.api.status, 'dispatched', 'api가 in-flight');
  assert.equal(byKey.ui.status, 'dispatched', 'ui가 in-flight');
  const before = {
    api: await roomCountFor(ds, byKey.api.id),
    ui: await roomCountFor(ds, byKey.ui.id),
    budget: (await readSteps(missions, mission.id, ws.id)).detail.total_visits,
  };

  step('pause/resume로 엔진을 저장된 상태에서 다시 진입시킨다(재시작과 같은 경로)');
  await runner.pauseMission(mission.id, ws.id, HUMAN);
  await runner.resumeMission(mission.id, ws.id, HUMAN);

  const after = await readSteps(missions, mission.id, ws.id);
  assert.equal(await roomCountFor(ds, byKey.api.id), before.api, 'in-flight step에 새 work order를 또 보내지 않는다');
  assert.equal(await roomCountFor(ds, byKey.ui.id), before.ui);
  assert.equal(after.detail.total_visits, before.budget, '재진입이 예산을 이중으로 소진하지 않는다');
  assert.equal(after.byKey.api.status, 'dispatched', '실행 상태는 그대로 복구된다');
  assert.equal(after.byKey.api.visit, 1, 'pass 번호도 보존된다');

  step('재진입 뒤에도 정상적으로 이어서 진행된다');
  const resumed = await report(workerMcp, after.byKey.api.id, { status: 'done', summary: 'api done', visit: 1 });
  assert.deepEqual(resumed.next_steps_dispatched, [], 'ui가 아직 남았으므로 fan-in은 대기');
});

test('loop 반복 상한에 걸리면 조용히 도는 대신 멈추고 하류를 차단한다', async (t) => {
  const s = await stage(t, { label: 'cap' });
  const { ds, ws, missions, mission, worker, critic, leadMcp, workerMcp, criticMcp } = s;

  // 상한 2 = 최초 1회 + 재진입 1회.
  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker, critic, 2) });

  const drive = async (expectedVisit) => {
    let { byKey } = await readSteps(missions, mission.id, ws.id);
    if (byKey.spec.status === 'dispatched') {
      await report(workerMcp, byKey.spec.id, { status: 'done', summary: 'spec', visit: 1 });
      ({ byKey } = await readSteps(missions, mission.id, ws.id));
      await report(workerMcp, byKey.api.id, { status: 'done', summary: 'api', visit: 1 });
      ({ byKey } = await readSteps(missions, mission.id, ws.id));
      await report(workerMcp, byKey.ui.id, { status: 'done', summary: 'ui', visit: 1 });
      ({ byKey } = await readSteps(missions, mission.id, ws.id));
    }
    await report(workerMcp, byKey.integrate.id, { status: 'done', summary: 'wired', visit: expectedVisit });
    ({ byKey } = await readSteps(missions, mission.id, ws.id));
    return report(criticMcp, byKey.review.id, {
      status: 'done',
      summary: 'still not right',
      verdict: 'revise',
      visit: expectedVisit,
    });
  };

  step('첫 revise는 재진입한다');
  const first = await drive(1);
  assert.deepEqual(first.loop_reentered.sort(), ['integrate', 'review']);

  step('상한에 도달한 두 번째 revise는 재진입하지 않는다');
  const second = await drive(2);
  assert.deepEqual(second.loop_reentered, [], '반복 상한을 넘어 다시 돌지 않는다');

  const { byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(byKey.review.status, 'done', 'evaluator는 마지막 판정 상태로 남는다');
  assert.equal(byKey.review.visit, 2, '상한만큼만 돌았다');
  assert.equal(
    byKey.ship.status,
    'blocked',
    'revise로 끝났으므로 승인 분기는 영영 열리지 않는다 — 무한 대기 대신 명시적 차단',
  );
  assert.equal(byKey.abort.status, 'blocked');

  const events = await eventsOf(missions, mission.id, ws.id);
  const exhausted = events.filter((e) => e.type === 'loop_exhausted');
  assert.equal(exhausted.length, 1, '상한 도달이 trace에 남는다');
  assert.equal(exhausted[0].data.max_visits, 2);
  assert.match(exhausted[0].message, /iteration cap/, '운영자가 이유를 바로 읽을 수 있다');

  assert.ok(
    events.some((e) => e.type === 'orchestrator_woken'),
    '엔진이 스스로 진행할 수 없게 됐으므로 오케스트레이터를 깨운다',
  );
});

test('graph 모드가 꺼진 미션은 graph 입력을 조용히 무시하지 않고 거부한다', async (t) => {
  const s = await stage(t, { graphEnabled: false, label: 'off' });
  const { ws, missions, mission, worker, critic, leadMcp, workerMcp } = s;

  step('graph를 보내면 거부된다');
  const rejected = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker, critic),
  });
  assert.ok(rejected?.isError, 'graph 모드가 아닌 미션은 graph를 받지 않는다');
  assert.match(JSON.stringify(rejected), /graph mode/, '왜 거부됐는지 알려준다');

  step('graph 없이 보내면 기존 wave 계약 그대로 동작한다');
  const plan = planFor(worker, critic);
  delete plan.graph;
  // depends_on만으로 같은 fan-in을 표현한다.
  plan.steps = [
    { step_key: 'api', title: 'API', instructions: 'x', assignee_agent_id: worker.id },
    { step_key: 'ui', title: 'UI', instructions: 'x', assignee_agent_id: worker.id },
    { step_key: 'ship', title: 'Ship', instructions: 'x', depends_on: ['api', 'ui'], assignee_agent_id: worker.id },
  ];
  const accepted = await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...plan });
  assert.ok(!accepted?.isError, `plan failed: ${JSON.stringify(accepted)}`);
  assert.equal(accepted.graph, null, 'graph 모드가 꺼져 있으면 그래프를 만들지도 않는다');
  assert.deepEqual(accepted.dispatched_now.sort(), ['api', 'ui'], '기존 wave 디스패치가 그대로다');

  const { detail, byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(detail.graph_spec, null);
  assert.equal(detail.graph_enabled, false);

  step('graph 모드가 아니면 visit 없이 보고해도 그대로 받아들인다(하위호환)');
  const reported = await report(workerMcp, byKey.api.id, { status: 'done', summary: 'api done' });
  assert.equal(reported.status, 'done');
  assert.deepEqual(reported.loop_reentered, [], 'loop 개념 자체가 없다');
});

/**
 * 예산 경계 전용 그래프 — loop가 **fan-out 지점으로** 되돌아간다.
 *
 *     spec → gate ─┬→ a ─┐
 *                  ├→ b ─┼→ review ─┬─(approve)→ ship
 *                  └→ c ─┘          └─(revise, loop)→ gate
 *
 * 이 모양이어야 "남은 예산 1 + ready node 3개"를 실제로 만들 수 있다. loop 없이는
 * 불가능하다 — `validateGraphSpec`이 `max_total_visits >= node 수`를 강제하므로,
 * 재진입으로 예산을 더 태우지 않는 한 모든 node는 항상 한 번씩 돌 여유가 있다.
 */
const fanoutLoopPlan = (worker, critic) => ({
  summary: 'fan-out inside a bounded loop, to exercise the global budget boundary.',
  steps: [
    { step_key: 'spec', title: 'Spec', instructions: 'x', assignee_agent_id: worker.id },
    { step_key: 'gate', title: 'Gate', instructions: 'x', assignee_agent_id: worker.id },
    { step_key: 'a', title: 'A', instructions: 'x', assignee_agent_id: worker.id },
    { step_key: 'b', title: 'B', instructions: 'x', assignee_agent_id: worker.id },
    { step_key: 'c', title: 'C', instructions: 'x', assignee_agent_id: worker.id },
    { step_key: 'review', title: 'Review', instructions: 'x', assignee_agent_id: critic.id },
    { step_key: 'ship', title: 'Ship', instructions: 'x', assignee_agent_id: worker.id },
  ],
  graph: {
    nodes: [
      { key: 'gate', max_visits: 3 },
      { key: 'review', kind: 'evaluator', max_visits: 3 },
    ],
    edges: [
      { from: 'spec', to: 'gate' },
      { from: 'gate', to: 'a' },
      { from: 'gate', to: 'b' },
      { from: 'gate', to: 'c' },
      { from: 'a', to: 'review' },
      { from: 'b', to: 'review' },
      { from: 'c', to: 'review' },
      { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] } },
      { from: 'review', to: 'gate', kind: 'loop_back', when: { verdict: ['revise'] } },
    ],
    // node 7개 + 재진입 1회분(gate 1) = 8. 재진입 뒤 a/b/c 3개가 ready가 될 때
    // 남는 예산이 정확히 1이 되도록 맞춘 값이다.
    max_total_visits: 8,
  },
});

test('fan-out 경계: 남은 예산보다 ready node가 많아도 global budget을 넘겨 디스패치하지 않는다', async (t) => {
  const s = await stage(t, { label: 'budget' });
  const { ds, ws, missions, mission, worker, critic, leadMcp, workerMcp, criticMcp } = s;

  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...fanoutLoopPlan(worker, critic),
  });
  assert.ok(!submitted?.isError, `submit failed: ${JSON.stringify(submitted)}`);
  assert.equal(submitted.graph.max_total_visits, 8);

  const budgetNow = async () => (await missions.getMissionDetail(mission.id, ws.id)).total_visits;

  step('첫 pass를 끝까지 돌려 예산을 6까지 태운다');
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  await report(workerMcp, byKey.spec.id, { status: 'done', summary: 'spec', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  await report(workerMcp, byKey.gate.id, { status: 'done', summary: 'gate', visit: 1 });

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.deepEqual(
    ['a', 'b', 'c'].map((k) => byKey[k].status),
    ['dispatched', 'dispatched', 'dispatched'],
    '예산이 넉넉한 첫 pass에서는 fan-out 3개가 모두 나간다',
  );
  assert.equal(await budgetNow(), 5, 'spec + gate + a,b,c = 5');

  for (const key of ['a', 'b', 'c']) {
    ({ byKey } = await readSteps(missions, mission.id, ws.id));
    await report(workerMcp, byKey[key].id, { status: 'done', summary: key, visit: 1 });
  }
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.review.status, 'dispatched');
  assert.equal(await budgetNow(), 6);

  step('revise로 재진입시켜 남은 예산을 정확히 1로 만든다');
  const revised = await report(criticMcp, byKey.review.id, {
    status: 'done',
    summary: 'redo the fan-out',
    verdict: 'revise',
    visit: 1,
  });
  assert.deepEqual(revised.next_steps_dispatched, ['gate'], '재진입 시작점만 나간다');
  assert.equal(await budgetNow(), 7, '남은 예산 = 8 - 7 = 1');

  step('ready node 3개 중 예산이 허용하는 1개만 디스패치된다');
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const afterGate = await report(workerMcp, byKey.gate.id, { status: 'done', summary: 'gate again', visit: 2 });
  assert.equal(
    afterGate.next_steps_dispatched.length,
    1,
    `남은 예산 1인데 ${afterGate.next_steps_dispatched.length}개가 나갔다 — ` +
      'pump가 slots만 보고 예산을 무시하면 3개가 전부 나간다(회귀 지점)',
  );

  const detail = await missions.getMissionDetail(mission.id, ws.id);
  assert.equal(detail.total_visits, 8, '예산을 정확히 소진했다');
  assert.ok(
    detail.total_visits <= detail.graph_spec.max_total_visits,
    `hard budget 초과: ${detail.total_visits} > ${detail.graph_spec.max_total_visits}`,
  );

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const fanoutStatuses = ['a', 'b', 'c'].map((k) => byKey[k].status).sort();
  assert.deepEqual(
    fanoutStatuses,
    ['dispatched', 'pending', 'pending'],
    '보류된 2개는 failed가 아니라 pending으로 남는다 — 상한을 올리면 그대로 재개돼야 한다',
  );

  step('예산 소진이 trace에 남고 보류 목록이 정확하다');
  const events = await eventsOf(missions, mission.id, ws.id);
  const exhausted = events.filter((e) => e.type === 'graph_budget_exhausted');
  assert.equal(exhausted.length, 1, '예산 소진이 정확히 한 번 기록됐다');
  assert.equal(exhausted[0].data.total_visits, 8);
  assert.equal(exhausted[0].data.max_total_visits, 8);
  assert.equal(exhausted[0].data.withheld.length, 2, '보류된 node 2개가 기록된다');
  assert.equal(exhausted[0].data.dispatched_before_exhaustion.length, 1, '같은 pump에서 나간 1개도 기록된다');

  step('실제로 띄운 subagent 수(room)와 예산 소진량이 일치한다');
  const rooms = await ds.getRepository('ChatRoom').count({ where: { orchestration_mission_id: mission.id } });
  assert.equal(detail.total_visits, rooms - 1, '미션 브리핑 room 1개를 뺀 나머지가 디스패치 수');
});

test('디스패치 실패 시 예산: work order 전송 전에 실패하면 예산을 쓰지 않는다', async (t) => {
  const s = await stage(t, { label: 'dispatchfail' });
  const { app, getDataSourceToken, ds, ws, missions, mission, worker, critic, leadMcp } = s;

  // critic을 다른 workspace로 옮겨 dispatchStep의 workspace 재검증에서 던지게 만든다.
  // 이 검사는 room 생성과 예산 커밋보다 **앞**이므로, 이 실패는 subagent를 띄운 적이
  // 없고 따라서 예산도 쓰지 않아야 한다(정책: 예산은 "떴을 수 있는가" 기준).
  const other = await createWorkspace(app, getDataSourceToken, 'orch-elsewhere');
  await ds.getRepository('Agent').update({ id: critic.id }, { workspace_id: other.id });

  step('entry 2개 중 하나는 정상 디스패치, 하나는 전송 전 실패');
  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    summary: 'two independent entry nodes',
    steps: [
      { step_key: 'alpha', title: 'Alpha', instructions: 'x', assignee_agent_id: worker.id },
      { step_key: 'beta', title: 'Beta', instructions: 'x', assignee_agent_id: critic.id },
    ],
    // graph를 안 보내면 wave adapter가 승격한다 — 예산 회계는 그대로 활성화된다.
  });
  assert.ok(!submitted?.isError, `submit failed: ${JSON.stringify(submitted)}`);
  assert.deepEqual(submitted.dispatched_now, ['alpha'], '정상 assignee만 나간다');
  assert.equal(submitted.graph.max_total_visits, 2, 'adapter 기본 예산 = node 수');

  const { detail, byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(byKey.beta.status, 'failed', '전송 불가는 step 실패로 기록된다');
  assert.match(byKey.beta.result_summary, /dispatch failed/);
  assert.equal(
    detail.total_visits,
    1,
    '전송 직전 커밋 지점 **앞에서** 던진 실패는 예산을 소진하지 않는다 — ' +
      '성공한 alpha 1건만 계상된다',
  );
  assert.equal(
    await ds.getRepository('ChatRoom').count({ where: { orchestration_step_id: byKey.beta.id } }),
    0,
    '실패한 step에는 room 자체가 만들어지지 않았다 — 예산을 쓰지 않은 근거',
  );
});

test('graph 미션에서 visit을 뺀 지각 보고도 409로 거부되고 현재 iteration이 보존된다', async (t) => {
  const s = await stage(t, { label: 'novisit' });
  const { ws, missions, mission, worker, critic, leadMcp, workerMcp, criticMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker, critic) });

  step('첫 pass를 evaluator까지 진행한다');
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  await report(workerMcp, byKey.spec.id, { status: 'done', summary: 'spec', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  await report(workerMcp, byKey.api.id, { status: 'done', summary: 'api', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  await report(workerMcp, byKey.ui.id, { status: 'done', summary: 'ui', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  await report(workerMcp, byKey.integrate.id, { status: 'done', summary: 'wired', visit: 1 });

  step('revise로 재진입시켜 integrate를 pass 2로 만든다');
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  await report(criticMcp, byKey.review.id, { status: 'done', summary: 'redo', verdict: 'revise', visit: 1 });

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const integrateId = byKey.integrate.id;
  assert.equal(byKey.integrate.visit, 2, 'integrate는 pass 2로 재디스패치됐다');
  assert.equal(byKey.integrate.status, 'dispatched');

  step('pass 1 작업자가 visit을 빼고 늦게 보고하면 거부된다');
  const stale = await report(
    workerMcp,
    integrateId,
    { status: 'done', summary: 'late result from the superseded pass 1' },
    { expectError: true },
  );
  assert.equal(stale.error?.status, 409, 'visit 누락은 409로 거부된다');
  assert.match(
    String(stale.error?.error ?? ''),
    /must carry the "visit" number/,
    'visit을 생략하는 것만으로 가드를 우회할 수 없어야 한다',
  );

  step('거부된 보고가 pass 2의 상태를 전혀 건드리지 않았다');
  const after = await readSteps(missions, mission.id, ws.id);
  assert.equal(after.byKey.integrate.status, 'dispatched', '여전히 pass 2 진행 중');
  assert.equal(after.byKey.integrate.visit, 2);
  assert.equal(after.byKey.integrate.result_summary, '', 'stale 요약이 들어오지 않았다');
  assert.equal(after.byKey.integrate.finished_at, null, '완료 처리되지 않았다');

  step('올바른 visit을 실으면 정상 처리된다 — 가드가 정상 경로를 막지는 않는다');
  const ok = await report(workerMcp, integrateId, { status: 'done', summary: 'pass 2 result', visit: 2 });
  assert.equal(ok.status, 'done');
  assert.deepEqual(ok.next_steps_dispatched, ['review'], 'pass 2의 evaluator로 정상 진행');
});

// ── Runtime graph patching + graph template (티켓 2fc8f99a) ──────────────────
//
// 위 테스트들이 "확정된 그래프가 어떻게 실행되는가"를 본다면, 아래는 "실행 중인
// 그래프를 어떻게 안전하게 바꾸는가"를 본다. 순수 로직 단언은
// `orchestration-graph-patch.test.mjs`에 있고, 여기서는 실제 엔진 + MCP HTTP 경로만
// 검증한다 — 인가(오케스트레이터만), 재펌프(patch가 연 길로 실제 디스패치가 나가는가),
// revision/trace 기록, 그리고 이미 일어난 실행 이력의 보존.

/** MCP로 그래프를 patch 한다. */
async function patchGraph(mcp, missionId, body, { expectError = false } = {}) {
  const result = await mcp.callTool('patch_orchestration_graph', { mission_id: missionId, ...body });
  if (expectError) {
    assert.ok(result?.isError, `expected the patch to be rejected, got ${JSON.stringify(result)}`);
    return result;
  }
  assert.ok(!result?.isError, `patch failed: ${JSON.stringify(result)}`);
  return result;
}

test('그래프 템플릿: 카탈로그를 읽고 review_loop 템플릿으로 계획을 제출한다', async (t) => {
  const s = await stage(t, { label: 'template' });
  const { ws, missions, mission, worker, critic, leadMcp } = s;

  step('오케스트레이터가 사용 가능한 템플릿 목록을 읽는다');
  const catalog = await leadMcp.callTool('list_orchestration_graph_templates', {});
  assert.ok(!catalog?.isError, `catalog failed: ${JSON.stringify(catalog)}`);
  const names = catalog.templates.map((tpl) => tpl.name).sort();
  assert.deepEqual(names, ['fan_out_aggregate', 'linear', 'review_loop']);
  for (const tpl of catalog.templates) {
    assert.ok(tpl.when_to_use, `${tpl.name}: 언제 쓰는지가 있어야 오케스트레이터가 고를 수 있다`);
    assert.ok(tpl.params.length > 0 && tpl.example, `${tpl.name}: 파라미터와 예시가 있어야 한다`);
  }

  step('nodes/edges 를 한 줄도 쓰지 않고 검토 루프를 제출한다');
  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    summary: 'templated review loop',
    steps: [
      { step_key: 'draft', title: 'Draft', instructions: 'Write it.', assignee_agent_id: worker.id },
      { step_key: 'critique', title: 'Critique', instructions: 'Judge it.', assignee_agent_id: critic.id },
      { step_key: 'publish', title: 'Publish', instructions: 'Ship it.', assignee_agent_id: worker.id },
    ],
    graph_template: {
      name: 'review_loop',
      params: { work: 'draft', review: 'critique', max_passes: 3, on_pass: 'publish' },
    },
  });
  assert.ok(!submitted?.isError, `submit failed: ${JSON.stringify(submitted)}`);
  assert.equal(submitted.graph.loops, 1, '템플릿이 loop_back edge 를 만들어야 한다');
  assert.deepEqual(submitted.graph.entry, ['draft']);
  assert.deepEqual(submitted.dispatched_now, ['draft'], 'entry 만 디스패치된다');

  step('펼쳐진 그래프가 손으로 쓴 것과 동일한 계약을 갖는다');
  const { detail } = await readSteps(missions, mission.id, ws.id);
  const spec = detail.graph_spec;
  assert.equal(spec.nodes.find((n) => n.key === 'critique').kind, 'evaluator');
  assert.equal(spec.nodes.find((n) => n.key === 'draft').max_visits, 3);
  const loop = spec.edges.find((e) => e.kind === 'loop_back');
  assert.deepEqual(loop.when, { verdict: ['revise'] }, '종료 조건 없는 loop 는 애초에 저장될 수 없다');

  step('graph 와 graph_template 을 함께 보내면 조용히 하나를 고르지 않고 거부한다');
  const both = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [{ step_key: 'draft', title: 'Draft', instructions: 'Write it.', assignee_agent_id: worker.id }],
    graph: { edges: [] },
    graph_template: { name: 'linear', params: { steps: ['draft', 'critique'] } },
  });
  assert.ok(both?.isError, '둘 다 주면 거부돼야 한다');
  assert.match(String(both.error?.error ?? ''), /not both/);
});

test('graph patch: 대기 중이던 node 의 길을 열면 그 자리에서 디스패치된다', async (t) => {
  const s = await stage(t, { label: 'patchopen' });
  const { ws, missions, mission, worker, critic, leadMcp, workerMcp } = s;

  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker, critic),
  });
  assert.ok(!submitted?.isError, `submit failed: ${JSON.stringify(submitted)}`);

  step('spec → api·ui 까지 진행시키고 api 만 끝낸다 — integrate 는 ui 를 기다린다');
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  await report(workerMcp, byKey.spec.id, { status: 'done', summary: 'spec', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const afterApi = await report(workerMcp, byKey.api.id, { status: 'done', summary: 'api', visit: 1 });
  assert.deepEqual(afterApi.next_steps_dispatched, [], 'join=all 이라 아직 대기');

  step('ui → integrate 의존을 제거하면 integrate 가 즉시 디스패치된다');
  const patched = await patchGraph(leadMcp, mission.id, {
    remove_edges: [{ from: 'ui', to: 'integrate' }],
  });
  assert.equal(patched.graph_revision, 1, '첫 patch 는 revision 1');
  assert.deepEqual(patched.dispatched_now, ['integrate'], 'patch 가 연 길로 실제 디스패치가 나가야 한다');
  assert.ok(
    patched.changes.some((c) => c.kind === 'edge_removed' && /ui → integrate/.test(c.detail)),
    '무엇이 바뀌었는지 changes 에 남아야 한다',
  );

  step('patch 는 plan 을 건드리지 않는다 — plan_version 을 태우지 않는다');
  const { detail } = await readSteps(missions, mission.id, ws.id);
  assert.equal(detail.plan_version, 1, 'patch 후에도 plan_version 은 그대로');
  assert.equal(detail.graph_revision, 1);
  assert.equal(detail.steps.length, 7, 'step 은 하나도 늘거나 줄지 않았다');

  step('무엇이 왜 바뀌었는지 실행 trace 에 남는다');
  const events = await eventsOf(missions, mission.id, ws.id);
  const patchEvent = events.find((e) => e.type === 'graph_patched');
  assert.ok(patchEvent, 'graph_patched 이벤트가 기록돼야 한다');
  assert.match(patchEvent.message, /ui → integrate/);
  assert.equal(patchEvent.data.graph_revision, 1);

  step('patch 결과도 전체 재검증을 거친다 — patch 전용 우회 경로가 없다');
  const refused = await patchGraph(leadMcp, mission.id, { max_total_visits: 1 }, { expectError: true });
  assert.match(
    String(refused.error?.error ?? ''),
    /is below the 7 node\(s\)/,
    'submit 경로에서 거부되는 그래프는 patch 경로에서도 거부돼야 한다',
  );
});

test('graph patch: loop_back 제거가 폭주 루프를 멈추고 이미 끝난 반복은 남긴다', async (t) => {
  const s = await stage(t, { label: 'patchloop' });
  const { ws, missions, mission, worker, critic, leadMcp, workerMcp, criticMcp } = s;

  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker, critic),
  });
  assert.ok(!submitted?.isError, `submit failed: ${JSON.stringify(submitted)}`);

  step('한 바퀴 돌려 loop 를 pass 2 로 재진입시킨다');
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  await report(workerMcp, byKey.spec.id, { status: 'done', summary: 'spec', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  await report(workerMcp, byKey.api.id, { status: 'done', summary: 'api', visit: 1 });
  await report(workerMcp, byKey.ui.id, { status: 'done', summary: 'ui', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  await report(workerMcp, byKey.integrate.id, { status: 'done', summary: 'wired', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const revised = await report(criticMcp, byKey.review.id, {
    status: 'done', summary: 'needs work', verdict: 'revise', visit: 1,
  });
  assert.deepEqual(revised.loop_reentered.sort(), ['integrate', 'review'], '전제: loop 가 실제로 재진입했다');
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.integrate.visit, 2);

  step('운영 판단으로 loop_back 을 제거한다 — 진행 중이어도 허용된다');
  const patched = await patchGraph(leadMcp, mission.id, {
    remove_edges: [{ from: 'review', to: 'integrate', kind: 'loop_back' }],
  });
  assert.equal(patched.graph.loops, 0, 'loop 가 사라져야 한다');

  step('이미 끝난 pass 1 의 이력은 그대로 남는다');
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.integrate.visit, 2, 'patch 가 visit 을 되돌리면 안 된다');

  step('이미 2번 돈 node 의 상한을 1로 낮추는 것은 거부된다 — 실행 이력 소급 무효화 금지');
  const tooLow = await patchGraph(
    leadMcp,
    mission.id,
    { set_nodes: [{ key: 'integrate', max_visits: 1 }] },
    { expectError: true },
  );
  assert.match(String(tooLow.error?.error ?? ''), /already run 2 time\(s\)/);
  assert.match(String(tooLow.error?.error ?? ''), /Lower it to 2/, '허용 가능한 최소값을 알려줘야 한다');

  step('정확히 2 로 낮추는 것은 허용된다 — "이번이 마지막" 을 표현하는 정상 수단');
  const locked = await patchGraph(leadMcp, mission.id, { set_nodes: [{ key: 'integrate', max_visits: 2 }] });
  assert.equal(locked.graph_revision, 2, '두 번째 patch 는 revision 2');

  step('pass 2 에서 다시 revise 를 내도 이제는 재진입하지 않는다');
  await report(workerMcp, byKey.integrate.id, { status: 'done', summary: 'pass 2', visit: 2 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const again = await report(criticMcp, byKey.review.id, {
    status: 'done', summary: 'still not great', verdict: 'revise', visit: 2,
  });
  assert.deepEqual(again.loop_reentered, [], 'loop_back 이 없으므로 재진입은 일어나지 않는다');
  assert.deepEqual(again.next_steps_dispatched, [], '되돌아갈 곳이 없다');
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.integrate.visit, 2, '재진입이 없으므로 visit 도 그대로');
});

test('graph patch 인가: 오케스트레이터만, 그리고 graph 모드 미션에서만', async (t) => {
  const s = await stage(t, { label: 'patchauthz' });
  const { mission, worker, critic, leadMcp, workerMcp } = s;

  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker, critic),
  });
  assert.ok(!submitted?.isError, `submit failed: ${JSON.stringify(submitted)}`);

  step('팀 멤버는 자기 미션이어도 그래프를 바꿀 수 없다');
  const byMember = await patchGraph(
    workerMcp,
    mission.id,
    { remove_edges: [{ from: 'ui', to: 'integrate' }] },
    { expectError: true },
  );
  assert.match(
    String(byMember.error?.error ?? ''),
    /orchestrat/i,
    '오케스트레이터가 아닌 caller 는 거부돼야 한다',
  );

  step('graph 모드가 꺼진 미션에는 patch 할 그래프 자체가 없다');
  const plain = await stage(t, { graphEnabled: false, label: 'patchplain' });
  const plainSubmit = await plain.leadMcp.callTool('submit_orchestration_plan', {
    mission_id: plain.mission.id,
    summary: 'plain dependency plan',
    steps: [
      { step_key: 'one', title: 'One', instructions: 'Do it.', assignee_agent_id: plain.worker.id },
      { step_key: 'two', title: 'Two', instructions: 'Then this.', depends_on: ['one'], assignee_agent_id: plain.worker.id },
    ],
  });
  assert.ok(!plainSubmit?.isError, `submit failed: ${JSON.stringify(plainSubmit)}`);
  const noGraph = await patchGraph(
    plain.leadMcp,
    plain.mission.id,
    { remove_edges: [{ from: 'one', to: 'two' }] },
    { expectError: true },
  );
  assert.match(String(noGraph.error?.error ?? ''), /no execution graph to patch/);
});

// ── replan 너머로 그래프 잇기 (티켓 301018c5) ───────────────────────────────
//
// 결함: graph/graph_template 없이 계획을 재제출하면 확정된 그래프가 depends_on
// 기반 평면 DAG 로 조용히 교체돼 conditional/loop_back 과 그동안 적용한 patch 가
// 전부 사라졌다(graph_revision 도 0 으로 리셋). 오류도 경고도 없었다.

test('replan: graph 를 생략한 재제출이 확정 그래프와 적용된 patch 를 보존한다', async (t) => {
  const s = await stage(t, { label: 'replancarry' });
  const { ws, missions, mission, worker, critic, leadMcp, workerMcp } = s;

  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker, critic),
  });
  assert.ok(!submitted?.isError, `submit failed: ${JSON.stringify(submitted)}`);

  const before = (await missions.getMissionDetail(mission.id, ws.id)).graph_spec;
  assert.equal(before.edges.filter((e) => e.kind === 'loop_back').length, 1, '픽스처 전제: loop_back 1');
  assert.equal(before.edges.filter((e) => e.kind === 'conditional').length, 2, '픽스처 전제: conditional 2');

  step('실행 이력을 만든다 — spec 을 끝내 api·ui 를 띄운다');
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  await report(workerMcp, byKey.spec.id, { status: 'done', summary: 'spec', visit: 1 });

  step('진행 중에 loop 상한을 올리는 patch 를 적용한다');
  const patched = await patchGraph(leadMcp, mission.id, {
    set_nodes: [
      { key: 'integrate', max_visits: 5 },
      { key: 'review', max_visits: 5 },
    ],
  });
  assert.equal(patched.graph_revision, 1, '첫 patch 는 revision 1');

  step('전형적인 replan: step 하나를 추가하고 graph 는 보내지 않는다');
  const replanned = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    summary: 'add a docs step',
    steps: [
      { step_key: 'docs', title: 'Write the docs', instructions: 'Document it.', assignee_agent_id: worker.id },
    ],
  });
  assert.ok(!replanned?.isError, `replan failed: ${JSON.stringify(replanned)}`);
  assert.deepEqual(replanned.created_steps, ['docs']);

  step('조건 분기와 bounded loop 가 그대로 남아 있다 — 이게 결함의 본체다');
  const detail = await missions.getMissionDetail(mission.id, ws.id);
  const after = detail.graph_spec;
  assert.equal(after.edges.filter((e) => e.kind === 'loop_back').length, 1, 'loop_back 이 유실됐다');
  assert.equal(after.edges.filter((e) => e.kind === 'conditional').length, 2, 'conditional 이 유실됐다');
  assert.equal(
    after.nodes.find((n) => n.key === 'review').kind,
    'evaluator',
    'evaluator node 가 task 로 되돌아갔다',
  );

  step('patch 로 올린 loop 상한과 patch 카운터도 replan 을 넘어간다');
  assert.equal(after.nodes.find((n) => n.key === 'integrate').max_visits, 5, 'patch 가 되돌려졌다');
  assert.equal(detail.graph_revision, 1, '그래프를 보존했으면 patch 카운터도 이어져야 한다');

  step('새 step 은 고립 node 로 편입된다 — entry 이자 terminal');
  assert.ok(after.nodes.some((n) => n.key === 'docs'), 'docs node 가 편입되지 않았다');
  assert.ok(after.entry.includes('docs'));
  assert.ok(after.terminal.includes('docs'));
  assert.equal(after.edges.filter((e) => e.from === 'docs' || e.to === 'docs').length, 0);

  step('plan_version 은 올랐고, 무엇이 이어졌는지 trace 에 남는다');
  assert.equal(detail.plan_version, 2);
  // 이벤트 배열은 created_at DESC 라 위치로 고르면 최초 제출을 집는다. 같은 초에
  // 여러 건이 쌓일 수도 있으므로 순서가 아니라 plan_version 으로 특정한다.
  const events = await eventsOf(missions, mission.id, ws.id);
  const planEvent = events.find((e) => e.type === 'plan_submitted' && e.data?.plan_version === 2);
  assert.ok(planEvent, 'v2 제출 이벤트가 기록돼야 한다');
  assert.equal(planEvent.data.graph.carried, true, '보존한 replan 임이 trace 에 남아야 한다');
  assert.deepEqual(planEvent.data.graph.carried_nodes, ['docs']);
  assert.equal(planEvent.data.graph.graph_revision, 1);

  const firstEvent = events.find((e) => e.type === 'plan_submitted' && e.data?.plan_version === 1);
  assert.equal(firstEvent.data.graph.carried, false, '최초 제출은 보존이 아니라 확정이다');
});

test('replan: reset_graph 로 명시하면 평면 DAG 로 돌아가고 patch 카운터도 리셋된다', async (t) => {
  const s = await stage(t, { label: 'replanreset' });
  const { ws, missions, mission, worker, critic, leadMcp } = s;

  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker, critic),
  });
  assert.ok(!submitted?.isError, `submit failed: ${JSON.stringify(submitted)}`);
  const patched = await patchGraph(leadMcp, mission.id, { set_nodes: [{ key: 'integrate', max_visits: 5 }] });
  assert.equal(patched.graph_revision, 1);

  step('graph 와 reset_graph 를 함께 보내면 어느 쪽이 이길지 모호하므로 거부한다');
  const both = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [{ step_key: 'spec', title: 'Write the spec', instructions: 'Draft it.', assignee_agent_id: worker.id }],
    reset_graph: true,
    graph: { edges: [{ from: 'spec', to: 'api' }] },
  });
  assert.ok(both?.isError, '상호배타 위반이 조용히 통과했다');
  assert.match(String(both.error?.error ?? ''), /cannot be combined with/);

  step('reset_graph 만 보내면 depends_on 에서 다시 유도한다');
  const reset = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    summary: 'abandon the branches',
    steps: [
      { step_key: 'docs', title: 'Write the docs', instructions: 'Document it.', assignee_agent_id: worker.id },
    ],
    reset_graph: true,
  });
  assert.ok(!reset?.isError, `reset failed: ${JSON.stringify(reset)}`);

  const detail = await missions.getMissionDetail(mission.id, ws.id);
  const after = detail.graph_spec;
  assert.equal(after.edges.filter((e) => e.kind === 'loop_back').length, 0, '폐기했는데 loop 가 남았다');
  assert.equal(after.edges.filter((e) => e.kind === 'conditional').length, 0);
  assert.equal(after.nodes.find((n) => n.key === 'integrate').max_visits, 1, 'patch 가 남아 있으면 안 된다');
  assert.equal(detail.graph_revision, 0, '새 기준선이므로 patch 카운터도 0 으로 돌아가야 한다');

  const events = await eventsOf(missions, mission.id, ws.id);
  const planEvent = events.find((e) => e.type === 'plan_submitted' && e.data?.plan_version === 2);
  assert.ok(planEvent, 'v2 제출 이벤트가 기록돼야 한다');
  assert.equal(planEvent.data.graph.carried, false, '교체한 replan 임이 trace 에 남아야 한다');
  assert.deepEqual(planEvent.data.graph.carried_nodes, []);
});

test('replan: graph 모드가 꺼진 미션은 reset_graph 도 조용히 무시하지 않고 거부한다', async (t) => {
  const s = await stage(t, { graphEnabled: false, label: 'replanplain' });
  const { mission, worker, leadMcp } = s;

  const refused = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [{ step_key: 'one', title: 'One', instructions: 'Do it.', assignee_agent_id: worker.id }],
    reset_graph: true,
  });
  assert.ok(refused?.isError, 'graph 모드가 꺼졌는데 reset_graph 가 통과했다');
  assert.match(String(refused.error?.error ?? ''), /does not have graph mode enabled/);
});

exitAfterTests();
