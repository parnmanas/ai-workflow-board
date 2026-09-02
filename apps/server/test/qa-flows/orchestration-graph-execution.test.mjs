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
  const result = await mcp.callTool('report_orchestration_step', { step_id: stepId, ...body });
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
  const afterSpec = await report(workerMcp, byKey.spec.id, { status: 'done', summary: 'spec written' });
  assert.deepEqual(afterSpec.next_steps_dispatched.sort(), ['api', 'ui'], 'fan-out이 병렬로 나간다');

  // ── 4. fan-in: join=all ─────────────────────────────────────────────────
  step('integrate는 api와 ui가 둘 다 끝나야 시작한다');
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const afterApi = await report(workerMcp, byKey.api.id, { status: 'done', summary: 'api done' });
  assert.deepEqual(afterApi.next_steps_dispatched, [], 'join=all — 한쪽만 끝나면 아직 대기');
  const afterUi = await report(workerMcp, byKey.ui.id, { status: 'done', summary: 'ui done' });
  assert.deepEqual(afterUi.next_steps_dispatched, ['integrate'], '둘 다 끝나자 fan-in이 시작된다');

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const afterIntegrate = await report(workerMcp, byKey.integrate.id, { status: 'done', summary: 'wired' });
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
  await report(workerMcp, byKey.spec.id, { status: 'done', summary: 'spec written' });

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

exitAfterTests();
