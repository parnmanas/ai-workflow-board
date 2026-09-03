// QA flow: 사용자 확인(confirm) 노드 end-to-end (티켓 5dbe4aa2).
//
// `orchestration-graph-execution.test.mjs` 와 같은 방식이다 — 실제 엔진을 태우고,
// 에이전트가 하는 동작은 MCP HTTP 로, 사람이 하는 동작은 서비스 계층으로 나간다.
//
// 이 기능의 위험은 전부 "조용한 정지" 쪽에 있다. confirm 게이트는 정의상 미션을
// 멈추므로, 잘못 만들면 에러가 아니라 **아무 일도 일어나지 않는 상태**로 끝난다:
//
//   - 게이트가 병렬 슬롯을 먹으면 다른 분기까지 사람이 답할 때까지 멈춘다.
//   - 게이트가 매 pump 마다 재오픈되면 이전 판정이 지워지고 사람이 영원히 답한다.
//   - 리퍼가 게이트를 정지로 오인하면 90분 뒤 미션 자체가 failed 로 확정된다.
//   - 재진입한 게이트가 지난 판정을 들고 있으면 새 pass 의 답이 영구 409 가 된다.
//   - 사용자의 fail 피드백이 재실행 work order 에 실리지 않으면 같은 결과가 다시 온다.
//
// 아래 시나리오는 그 각각을 관측 가능한 산출물(디스패치된 room 수, work order 본문,
// timeline 이벤트 수, 리퍼 반환값)로 직접 확인한다.
//
// 이 파일에서 쓰는 그래프:
//
//     build ─┬─→ gate(confirm) ─(pass)────→ ship
//            │        │
//            │        └─(fail, loop_back)──→ build
//            └─→ docs                       (게이트와 무관한 병렬 분기)
//
// `max_parallel_steps: 1` 로 돌린다 — 게이트가 슬롯을 먹으면 `docs` 가 디스패치되지
// 못하므로, 슬롯 회계가 틀린 순간 테스트가 바로 붉어진다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, createWorkspace } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_CONFIRM_PORT || '7954';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

const HUMAN = { type: 'user', id: 'qa-operator', name: 'QA Operator' };
const OTHER_HUMAN = { type: 'user', id: 'qa-operator-2', name: 'Second Operator' };
const MIN = 60_000;

async function loadServices() {
  const load = async (file) => import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', file)).href);
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

/** work order 프롬프트를 그 step 의 방들에서 그대로 읽는다(최신 방 우선). */
async function workOrdersFor(ds, stepId) {
  const rooms = await ds.getRepository('ChatRoom').find({ where: { orchestration_step_id: stepId } });
  const out = [];
  for (const room of rooms) {
    const rows = await ds.getRepository('ChatRoomMessage').find({ where: { room_id: room.id } });
    out.push({ roomId: room.id, createdAt: room.created_at, text: rows.map((r) => r.content || '').join('\n') });
  }
  return out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

async function readSteps(missions, missionId, workspaceId) {
  const detail = await missions.getMissionDetail(missionId, workspaceId);
  return { detail, byKey: Object.fromEntries(detail.steps.map((s) => [s.step_key, s])) };
}

/** 미션 room(= 오케스트레이터 wake 가 포스트되는 곳)의 메시지 수. */
async function missionRoomPostCount(ds, roomId) {
  if (!roomId) return 0;
  return ds.getRepository('ChatRoomMessage').count({ where: { room_id: roomId } });
}

const eventsOfType = (detail, type) => detail.events.filter((e) => e.type === type);

async function stage(t, { label, confirmPolicy = 'auto', graphEnabled = true } = {}) {
  const { app, port, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const reaper = app.get(services.OrchestrationReaperService);

  const ws = await createWorkspace(app, getDataSourceToken, `orch-cf-${label}`);
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
    name: `Confirm squad ${label}`,
    orchestrator_agent_id: lead.id,
    max_parallel_steps: 1,
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
    title: `Confirm mission ${label}`,
    objective: 'Exercise the human confirmation gate end to end.',
    // 슬롯 회계를 실제로 시험하기 위한 값 — 게이트가 슬롯을 먹으면 docs 가 못 나간다.
    max_parallel_steps: 1,
    graph_enabled: graphEnabled,
    confirm_policy: confirmPolicy,
    created_by_type: 'user',
    created_by: HUMAN.id,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);

  return { app, ds, ws, lead, worker, team, mission, missions, runner, reaper, leadMcp: await mcpFor(lead, 'lead') , workerMcp: await mcpFor(worker, 'worker') };
}

/** 위 다이어그램의 plan + graph. */
const planFor = (worker, { loopCap = 3 } = {}) => ({
  summary: 'build, ask a person, then either ship or rework.',
  steps: [
    { step_key: 'build', title: 'Build the page', instructions: 'Build it and attach a screenshot.', assignee_agent_id: worker.id },
    {
      step_key: 'gate',
      title: 'Does the page look right?',
      instructions: 'Look at the screenshot and the preview URL. Pass if the layout matches the mockup.',
      // assignee 를 일부러 주지 않는다 — confirm 노드는 사람이 답하므로 담당자가 없는
      // 것이 정상이고, 없어도 게이트가 열려야 한다.
    },
    { step_key: 'docs', title: 'Write the docs', instructions: 'Document it.', assignee_agent_id: worker.id },
    { step_key: 'ship', title: 'Ship it', instructions: 'Release it.', assignee_agent_id: worker.id },
  ],
  graph: {
    nodes: [
      { key: 'build', max_visits: loopCap },
      { key: 'gate', kind: 'confirm', max_visits: loopCap },
    ],
    edges: [
      { from: 'build', to: 'gate' },
      { from: 'build', to: 'docs' },
      { from: 'gate', to: 'ship', kind: 'conditional', when: { verdict: ['pass'] }, label: 'looks right' },
      { from: 'gate', to: 'build', kind: 'loop_back', when: { verdict: ['fail'] }, label: 'needs rework' },
    ],
    max_total_visits: 40,
  },
});

/** MCP 로 step 을 보고한다. lease token 은 실제 작업자처럼 현재 값을 실어 보낸다. */
async function report(mcp, stepId, body, { expectError = false } = {}) {
  const lease =
    'lease_token' in body
      ? body.lease_token
      : (await mcp.callTool('get_orchestration_step', { step_id: stepId }))?.lease_token;
  const result = await mcp.callTool('report_orchestration_step', {
    step_id: stepId,
    ...(lease ? { lease_token: lease } : {}),
    ...body,
  });
  if (expectError) {
    assert.ok(result?.isError, `expected rejection, got ${JSON.stringify(result)}`);
    return result;
  }
  assert.ok(!result?.isError, `report failed: ${JSON.stringify(result)}`);
  return result;
}

const SCREENSHOT = { kind: 'screenshot', ref: 'https://cdn.example.com/preview-42.png', label: 'home page' };
const PREVIEW = { kind: 'url', ref: 'https://preview.example.com/pr-42', label: 'live preview' };

/** build 를 done 으로 보고해 게이트를 여는 지점까지 진행시킨다. */
async function advanceToGate(s, { artifacts = [SCREENSHOT, PREVIEW], visit = 1 } = {}) {
  const { ws, missions, mission, workerMcp } = s;
  const { byKey } = await readSteps(missions, mission.id, ws.id);
  return report(workerMcp, byKey.build.id, {
    status: 'done',
    summary: 'built the page',
    artifacts,
    visit,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test('confirm 게이트: awaiting_user 로 멈추고, 하류는 막되 병렬 분기는 계속 진행한다', async (t) => {
  const s = await stage(t, { label: 'open' });
  const { ds, ws, missions, mission, worker, leadMcp } = s;

  step('confirm 노드를 담은 계획을 제출한다');
  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker),
  });
  assert.ok(!submitted?.isError, `submit failed: ${JSON.stringify(submitted)}`);
  assert.deepEqual(submitted.dispatched_now, ['build'], 'entry 만 나간다');

  step('build 가 결과물을 붙여 끝나면 게이트가 열린다');
  const afterBuild = await advanceToGate(s);
  let { detail, byKey } = await readSteps(missions, mission.id, ws.id);

  assert.equal(byKey.gate.status, 'awaiting_user', '게이트는 사람의 답을 기다리며 멈춘다');
  assert.equal(byKey.gate.visit, 1, '최초 오픈은 pass 1');
  assert.equal(byKey.gate.confirm_decision, null, '아직 판정 전');
  assert.equal(await roomCountFor(ds, byKey.gate.id), 0, 'confirm 노드는 subagent 를 띄우지 않는다');

  step('상류 결과물이 판정 근거로 스냅샷된다(요구사항 2)');
  assert.deepEqual(
    byKey.gate.artifacts.map((a) => a.ref).sort(),
    [PREVIEW.ref, SCREENSHOT.ref].sort(),
    '사람이 볼 스크린샷/URL 이 게이트에 붙어야 한다',
  );
  const requested = eventsOfType(detail, 'confirm_requested');
  assert.equal(requested.length, 1, '요청은 한 번만 기록된다');
  assert.deepEqual(requested[0].data.evidence_from, ['build'], '어느 step 의 산출물인지 감사 로그에 남는다');

  step('하류는 판정 전에는 절대 나가지 않는다(요구사항 4)');
  assert.equal(byKey.ship.status, 'pending');
  assert.equal(await roomCountFor(ds, byKey.ship.id), 0);

  step('게이트는 병렬 슬롯을 먹지 않는다 — max_parallel=1 인데도 docs 가 나갔다');
  assert.deepEqual(afterBuild.next_steps_dispatched.sort(), ['docs', 'gate']);
  assert.equal(byKey.docs.status, 'dispatched', '게이트가 슬롯을 먹었다면 docs 는 ready 로 남았을 것이다');

  step('게이트가 열려 있는 동안 pump 를 다시 돌려도 재오픈되지 않는다');
  const budgetBefore = detail.total_visits;
  // pause/resume 은 저장된 상태에서 엔진을 다시 진입시키는 경로다(재시작과 같다).
  await s.runner.pauseMission(mission.id, ws.id, HUMAN);
  await s.runner.resumeMission(mission.id, ws.id, HUMAN);
  ({ detail, byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.gate.status, 'awaiting_user', 'durable pause 는 재시작을 견딘다');
  assert.equal(byKey.gate.visit, 1, 'pass 번호가 재진입으로 올라가지 않는다');
  assert.equal(eventsOfType(detail, 'confirm_requested').length, 1, '재진입이 요청을 다시 기록하지 않는다');
  assert.equal(detail.total_visits, budgetBefore, '재진입이 예산을 이중으로 소진하지 않는다');
});

test('confirm 게이트: 같은 판정을 두 번 제출해도 정확히 한 번만 재개된다(요구사항 6)', async (t) => {
  const s = await stage(t, { label: 'idempotent' });
  const { ds, ws, missions, runner, mission, worker, leadMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  const gateId = byKey.gate.id;
  // 병렬 분기를 먼저 닫아 슬롯을 비운다 — max_parallel=1 이라 docs 가 in-flight 인
  // 동안에는 pass 하류가 슬롯을 못 얻어서, 이 테스트가 재려는 "한 번만 재개" 대신
  // 슬롯 회계를 재게 된다.
  await report(s.workerMcp, byKey.docs.id, { status: 'done', summary: 'documented', visit: 1 });

  step('첫 제출이 게이트를 통과시키고 pass 하류를 디스패치한다');
  const first = await runner.submitConfirmDecision(gateId, ws.id, HUMAN, {
    verdict: 'pass',
    feedback: 'looks good to me',
    visit: 1,
  });
  assert.equal(first.already_decided, false);
  assert.deepEqual(first.dispatched, ['ship']);

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const shipRooms = await roomCountFor(ds, byKey.ship.id);
  assert.equal(shipRooms, 1, 'pass 하류가 한 번 나갔다');

  step('새로고침/중복 클릭 — 같은 (visit, verdict) 재제출은 재개하지 않는다');
  const second = await runner.submitConfirmDecision(gateId, ws.id, HUMAN, {
    verdict: 'pass',
    feedback: 'looks good to me',
    visit: 1,
  });
  assert.equal(second.already_decided, true, '기존 판정을 그대로 돌려줘야 한다');
  assert.deepEqual(second.dispatched, [], '재개가 두 번 일어나면 안 된다');

  step('재접속한 다른 사용자가 같은 답을 눌러도 마찬가지다(visit 은 그대로 실어야 한다)');
  const third = await runner.submitConfirmDecision(gateId, ws.id, OTHER_HUMAN, {
    verdict: 'pass',
    visit: 1,
  });
  assert.equal(third.already_decided, true);

  step('visit 을 빠뜨린 요청은 이미 판정된 게이트에서도 400 이다');
  // 여기서 관대하게 흡수하면 "visit 없이 보내면 통과한다"가 클라이언트에게 학습된다.
  // 그 습관이 재진입한 게이트에 그대로 적용되는 순간 stale 방어가 무력해지므로,
  // 성공/실패 경로를 가리지 않고 입력 계약을 먼저 강제한다.
  await assert.rejects(
    () => runner.submitConfirmDecision(gateId, ws.id, OTHER_HUMAN, { verdict: 'pass' }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /"visit" is required/);
      return true;
    },
  );

  const { detail } = await readSteps(missions, mission.id, ws.id);
  assert.equal(await roomCountFor(ds, byKey.ship.id), shipRooms, '하류 subagent 는 딱 한 번만 떴다');
  assert.equal(eventsOfType(detail, 'confirm_decided').length, 1, '감사 로그에도 판정은 하나뿐이다');
  const decided = eventsOfType(detail, 'confirm_decided')[0];
  assert.equal(decided.actor_type, 'user');
  assert.equal(decided.actor_name, HUMAN.name, '최초 판정자가 기록으로 남는다');
  assert.equal(decided.data.verdict, 'pass');
  assert.equal(decided.data.has_feedback, true);

  step('다른 판정으로 뒤집으려는 시도는 조용히 덮어쓰지 않고 거부된다');
  await assert.rejects(
    () => runner.submitConfirmDecision(gateId, ws.id, HUMAN, { verdict: 'fail', visit: 1 }),
    (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /already decided "pass"/);
      return true;
    },
  );
});

test('confirm 게이트: fail 판정은 loop 로 되돌리고 사용자 피드백을 재실행 work order 에 싣는다(요구사항 5)', async (t) => {
  const s = await stage(t, { label: 'fail-loop' });
  const { ds, ws, missions, runner, mission, worker, leadMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  const gateId = byKey.gate.id;
  // 병렬 분기를 먼저 닫는다(max_parallel=1). 재작업이 슬롯을 얻게 하는 목적이지만,
  // 덤으로 "이미 끝난 형제 step 이 loop 재진입에 휩쓸려 다시 실행되지 않는다"는 더
  // 강한 단언이 된다 — done 이 pending 으로 되돌려지면 중복 실행이다.
  await report(s.workerMcp, byKey.docs.id, { status: 'done', summary: 'documented', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const docsStatusBefore = byKey.docs.status;
  assert.equal(docsStatusBefore, 'done');
  const docsRoomsBefore = await roomCountFor(ds, byKey.docs.id);
  const buildRoomsBefore = await roomCountFor(ds, byKey.build.id);

  const FEEDBACK = 'The footer overlaps the CTA at 1280px — fix the grid before resubmitting.';

  step('사용자가 사유와 함께 Fail 을 제출한다');
  const failed = await runner.submitConfirmDecision(gateId, ws.id, HUMAN, {
    verdict: 'fail',
    feedback: FEEDBACK,
    visit: 1,
  });
  // loop 본문 = loop.to(build)에서 forward 로 닿으면서 loop.from(gate)에 닿을 수 있는
  // node. 게이트 자신이 반드시 포함돼야 한다 — 포함되지 않으면 재작업이 끝나도 게이트가
  // done 인 채로 남아 사람에게 다시 묻지 않는다.
  assert.deepEqual(failed.loop_reentered.sort(), ['build', 'gate'], 'loop 본문(게이트 포함)만 재진입한다');
  assert.deepEqual(failed.dispatched, ['build'], '재작업이 곧바로 나간다');

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.build.visit, 2, 'build 는 두 번째 pass');
  assert.equal(byKey.ship.status, 'pending', 'pass 하류는 열리지 않는다');
  assert.equal(await roomCountFor(ds, byKey.ship.id), 0);

  step('게이트 밖 병렬 분기는 loop 재진입에 휩쓸리지 않는다');
  assert.equal(byKey.docs.status, docsStatusBefore, 'docs 는 loop 본문이 아니므로 리셋되지 않는다');
  assert.equal(await roomCountFor(ds, byKey.docs.id), docsRoomsBefore, '이미 끝난 형제를 다시 띄우지 않는다');

  step('재디스패치된 work order 본문에 사용자의 피드백이 그대로 들어간다');
  const orders = await workOrdersFor(ds, byKey.build.id);
  assert.equal(orders.length, buildRoomsBefore + 1, '재진입은 새 room 하나만 연다');
  const latest = orders[orders.length - 1].text;
  assert.match(latest, /## User confirmation/);
  assert.ok(latest.includes(FEEDBACK), '사용자가 쓴 문장이 그대로 실려야 한다');
  assert.match(latest, /FAIL/, '어느 판정이었는지도 함께 읽혀야 한다');
  assert.ok(latest.includes(HUMAN.name), '누가 판정했는지도 함께 실린다');

  step('재진입한 게이트: 라우팅 값은 지워지고, 판정 기록은 근거로 보존된다');
  assert.equal(byKey.gate.status, 'pending', '재진입한 게이트는 대기 상태로 돌아간다');
  assert.equal(byKey.gate.visit, 2);
  // verdict 는 반드시 비워져야 한다 — 남으면 사람이 답하기도 전에 pass edge 가
  // 만족된 것으로 판정돼 하류가 나간다.
  assert.equal(byKey.gate.verdict, '', '라우팅을 여는 값은 재진입 시 반드시 지워진다');
  // 반면 판정 기록은 남는다. 바로 위에서 확인한 "피드백이 재작업 work order 에 실린다"가
  // 이 보존에 의존한다 — 리셋에서 지우면 전달 직전에 사라진다.
  assert.equal(byKey.gate.confirm_decision.verdict, 'fail');
  assert.equal(byKey.gate.confirm_decision.visit, 1, '기록은 그것이 내려진 pass 를 가리킨다');

  step('두 번째 pass 에서 사람이 다시 답할 수 있다 — 이번엔 Pass');
  await report(s.workerMcp, byKey.build.id, {
    status: 'done',
    summary: 'fixed the grid',
    artifacts: [SCREENSHOT],
    visit: 2,
  });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.gate.status, 'awaiting_user', '게이트가 pass 2 로 다시 열린다');
  assert.equal(byKey.gate.visit, 2);

  // 보존된 pass 1 기록이 새 pass 의 답을 막지 않아야 한다 — 막히면 사람이 다시는
  // 답할 수 없는 게이트가 된다. 멱등 검사가 같은 pass 에만 발동하는 것이 그 근거다.
  const passed = await runner.submitConfirmDecision(gateId, ws.id, HUMAN, { verdict: 'pass', visit: 2 });
  assert.equal(passed.already_decided, false, '새 pass 의 판정은 이전 판정과 무관하게 받아들여진다');
  assert.deepEqual(passed.dispatched, ['ship'], 'pass edge 하류가 이제 나간다');

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.gate.confirm_decision.verdict, 'pass', '기록이 이번 pass 의 판정으로 갱신된다');
  assert.equal(byKey.gate.confirm_decision.visit, 2);

  const { detail } = await readSteps(missions, mission.id, ws.id);
  assert.equal(eventsOfType(detail, 'confirm_requested').length, 2, '게이트가 두 번 열린 것이 감사 로그에 남는다');
  assert.equal(eventsOfType(detail, 'confirm_decided').length, 2, '판정도 두 번');
});

test('confirm 게이트: fail 의 중복 제출도 pass 와 똑같이 멱등이다', async (t) => {
  // 플래너 반례(리뷰 라운드1). `fail` 은 같은 lock 안에서 loop 를 발화시키고
  // `loopBodyNodes` 가 **게이트 자신을 본문에 포함**하므로, 반환 시점의 게이트는 이미
  // `pending` + `visit=2` 다. 멱등 키가 "step 이 지금 몇 번째 pass 인가" 였을 때는 그 창의
  // 중복 fail 이 `is pending` 409 로 떨어져, 요구사항 6의 "중복·새로고침·재접속" 이
  // pass 에서만 성립했다. 실측으로 재현한 뒤 멱등 키를 `claimedVisit` 로 옮겨 고쳤다.
  const s = await stage(t, { label: 'fail-idempotent' });
  const { ds, ws, missions, runner, mission, worker, leadMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  await report(s.workerMcp, byKey.docs.id, { status: 'done', summary: 'documented', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const gateId = byKey.gate.id;

  const first = await runner.submitConfirmDecision(gateId, ws.id, HUMAN, {
    verdict: 'fail',
    feedback: 'redo it',
    visit: 1,
  });
  assert.equal(first.already_decided, false);
  assert.deepEqual(first.dispatched, ['build'], '재작업이 한 번 나갔다');

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  // 전제 고정: 이 시점의 게이트는 awaiting_user 가 아니라 pending 이고 visit 은 이미 2다.
  assert.equal(byKey.gate.status, 'pending');
  assert.equal(byKey.gate.visit, 2);
  const buildRooms = await roomCountFor(ds, byKey.build.id);

  step('같은 fail 을 다시 보내도 409 가 아니라 멱등 200 이다');
  const second = await runner.submitConfirmDecision(gateId, ws.id, HUMAN, {
    verdict: 'fail',
    feedback: 'redo it',
    visit: 1,
  });
  assert.equal(second.already_decided, true, 'pass 와 fail 이 같은 계약을 받아야 한다');
  assert.deepEqual(second.dispatched, [], '재개가 두 번 일어나면 안 된다');

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(await roomCountFor(ds, byKey.build.id), buildRooms, '재작업 subagent 는 한 번만 떴다');
  assert.equal(byKey.build.visit, 2, 'loop 가 두 번 돌지 않았다');

  const { detail } = await readSteps(missions, mission.id, ws.id);
  assert.equal(eventsOfType(detail, 'confirm_decided').length, 1, '감사 로그에도 판정은 하나뿐이다');
  assert.equal(eventsOfType(detail, 'node_revisited').length, 1, '재진입도 한 번뿐이다');

  step('같은 pass 에 다른 답을 보내면 여전히 409 다 — 멱등이 관대함이 되면 안 된다');
  await assert.rejects(
    () => runner.submitConfirmDecision(gateId, ws.id, OTHER_HUMAN, { verdict: 'pass', visit: 1 }),
    (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /already decided "fail"/);
      return true;
    },
  );
});

test('confirm 게이트: loop 재진입으로 stale 해진 화면의 제출은 409 로 거부된다', async (t) => {
  const s = await stage(t, { label: 'stale' });
  const { ws, missions, runner, mission, worker, leadMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  const gateId = byKey.gate.id;

  // pass 1 을 fail 로 돌려보내고 pass 2 로 다시 연다. docs 를 먼저 닫아 재작업이
  // 슬롯을 얻게 한다(max_parallel=1).
  await report(s.workerMcp, byKey.docs.id, { status: 'done', summary: 'documented', visit: 1 });
  await runner.submitConfirmDecision(gateId, ws.id, HUMAN, { verdict: 'fail', feedback: 'redo', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  await report(s.workerMcp, byKey.build.id, { status: 'done', summary: 'redone', visit: 2 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.gate.status, 'awaiting_user');
  assert.equal(byKey.gate.visit, 2);

  step('브라우저에 떠 있던 pass 1 화면이 제출하면 거부된다');
  await assert.rejects(
    () => runner.submitConfirmDecision(gateId, ws.id, HUMAN, { verdict: 'pass', visit: 1 }),
    (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /stale confirmation/);
      return true;
    },
  );

  const after = await readSteps(missions, mission.id, ws.id);
  assert.equal(after.byKey.gate.status, 'awaiting_user', '거부는 현재 pass 상태를 건드리지 않는다');
  assert.equal(after.byKey.gate.confirm_decision, null);
  assert.equal(after.byKey.ship.status, 'pending', '거부된 제출이 하류를 열지 않는다');

  step('visit 을 아예 빼도 우회되지 않는다 — 이 방어의 유일한 구멍이었다(리뷰 라운드1)');
  // optional 이던 시절에는 이 요청이 **성공**했다. 낡은 화면이 값을 빼는 것만으로
  // 아래 stale 대조를 통째로 건너뛰고 pass 2 를 pass 1 의 판단으로 확정해버린다.
  for (const bad of [{}, { visit: null }, { visit: '' }, { visit: 'two' }, { visit: 0 }, { visit: -1 }, { visit: 1.5 }, { visit: NaN }]) {
    await assert.rejects(
      () => runner.submitConfirmDecision(gateId, ws.id, HUMAN, { verdict: 'pass', ...bad }),
      (e) => {
        assert.equal(e.status, 400, `${JSON.stringify(bad)} 는 400 이어야 한다`);
        assert.match(e.message, /"visit" is required/);
        return true;
      },
      `${JSON.stringify(bad)} 가 통과하면 stale 방어가 무력해진다`,
    );
  }

  const stillOpen = await readSteps(missions, mission.id, ws.id);
  assert.equal(stillOpen.byKey.gate.status, 'awaiting_user', '거부들이 게이트를 건드리지 않았다');
  assert.equal(stillOpen.byKey.gate.confirm_decision, null, '어떤 판정도 기록되지 않았다');
  assert.equal(stillOpen.byKey.ship.status, 'pending');

  step('정상 요청(현재 pass)은 그대로 통과한다 — 강제가 정상 경로를 막지 않는다');
  const ok = await runner.submitConfirmDecision(gateId, ws.id, HUMAN, { verdict: 'pass', visit: 2 });
  assert.equal(ok.already_decided, false);
  assert.equal(ok.step.confirm_decision.visit, 2);
});

test('confirm 게이트: awaiting_user 미션을 리퍼가 정지로 오인해 죽이지 않는다', async (t) => {
  const s = await stage(t, { label: 'reaper' });
  const { ds, ws, missions, reaper, mission, worker, leadMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  let { detail, byKey } = await readSteps(missions, mission.id, ws.id);

  // docs 가 in-flight 로 남아 있으면 리퍼의 첫 가드(isInFlight)에 걸려서, 정작
  // 검증하려는 awaiting_user 가드를 지나쳐 통과해버린다. 먼저 닫아 둔다.
  await report(s.workerMcp, byKey.docs.id, { status: 'done', summary: 'documented', visit: 1 });
  ({ detail, byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.gate.status, 'awaiting_user');
  assert.ok(
    detail.steps.every((st) => !['dispatched', 'running'].includes(st.status)),
    '이제 in-flight 는 하나도 없다 — awaiting_user 가드만이 미션을 지킨다',
  );

  const postsBefore = await missionRoomPostCount(ds, detail.room_id);

  step('사람이 답하지 않은 채 타임아웃 창을 한참 넘겨도 리퍼는 손대지 않는다');
  // 리퍼 sweep 은 DB 전체를 훑고 이 파일의 다른 테스트도 같은 앱을 공유하므로,
  // runOnce() 의 반환 카운터는 **이 미션의** 결과가 아니다. 그래서 카운터가 아니라
  // 이 미션에 실제로 무슨 일이 일어났는지를 단언한다 — 스윕을 여러 번 돌려
  // step_timeout_minutes(기본 90분)와 running-stall 창(기본 20분)을 모두 크게 넘긴다.
  const eventCountBefore = detail.events.length;
  for (const offset of [1, 2, 3]) {
    await reaper.runOnce(new Date(Date.now() + offset * 8 * 60 * MIN));
  }

  const after = await readSteps(missions, mission.id, ws.id);
  assert.equal(after.detail.status, 'running', '미션은 여전히 살아 있다 — failed 로 확정되면 안 된다');
  assert.equal(after.byKey.gate.status, 'awaiting_user', '게이트도 그대로다 — 타임아웃으로 죽으면 안 된다');
  assert.equal(after.byKey.gate.confirm_decision, null, '리퍼가 판정을 대신 채워넣지 않는다');
  assert.equal(
    await missionRoomPostCount(ds, after.detail.room_id),
    postsBefore,
    '게이트가 열린 동안 오케스트레이터를 깨우는 포스트가 하나도 없어야 한다(subagent spawn 낭비)',
  );
  assert.equal(
    after.detail.events.length,
    eventCountBefore,
    `리퍼가 이 미션에 이벤트를 남기면 안 된다. 새로 생긴 것: ` +
      JSON.stringify(after.detail.events.slice(0, after.detail.events.length - eventCountBefore).map((e) => e.type)),
  );
  for (const forbidden of ['orchestrator_woken', 'mission_failed', 'step_failed', 'step_needs_recovery']) {
    assert.equal(eventsOfType(after.detail, forbidden).length, 0, `${forbidden} 이벤트가 생기면 안 된다`);
  }

  step('사람이 답하면 그 자리에서 정상적으로 이어진다');
  const decided = await s.runner.submitConfirmDecision(after.byKey.gate.id, ws.id, HUMAN, {
    verdict: 'pass',
    visit: 1,
  });
  assert.deepEqual(decided.dispatched, ['ship']);
});

test('confirm 게이트: confirm_policy "none" 미션은 confirm 그래프 제출을 거부한다(요구사항 8)', async (t) => {
  const s = await stage(t, { label: 'policy-none', confirmPolicy: 'none' });
  const { ws, missions, mission, worker, leadMcp } = s;

  step('none 정책에서는 confirm 노드가 담긴 계획이 거부된다');
  const rejected = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker),
  });
  assert.ok(rejected?.isError, `거부돼야 한다: ${JSON.stringify(rejected)}`);
  // JSON.stringify 로 보면 따옴표가 이스케이프돼 정규식이 어긋난다 — 실제 메시지를 본다.
  assert.match(String(rejected?.error?.error ?? ''), /confirm_policy is "none"/);

  const { detail } = await readSteps(missions, mission.id, ws.id);
  assert.equal(detail.steps.length, 0, '거부된 계획은 step 을 남기지 않는다');
  assert.equal(detail.confirm_policy, 'none', '정책은 상세 응답에 그대로 노출된다');

  step('같은 계획을 confirm 노드 없이 다시 내면 정상 수용된다 — 정책이 막는 것은 게이트뿐이다');
  const plan = planFor(worker);
  const accepted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    summary: plan.summary,
    steps: plan.steps.map((st) => (st.step_key === 'gate' ? { ...st, assignee_agent_id: worker.id } : st)),
    graph: {
      nodes: [{ key: 'build' }, { key: 'gate', kind: 'task' }],
      edges: [
        { from: 'build', to: 'gate' },
        { from: 'build', to: 'docs' },
        { from: 'gate', to: 'ship' },
      ],
      max_total_visits: 20,
    },
  });
  assert.ok(!accepted?.isError, `수용돼야 한다: ${JSON.stringify(accepted)}`);
});

test('confirm 게이트: key_steps 정책인데 게이트가 없으면 거부 대신 타임라인 경고가 남는다', async (t) => {
  const s = await stage(t, { label: 'policy-note', confirmPolicy: 'key_steps' });
  const { ws, missions, mission, worker, leadMcp } = s;

  const plan = planFor(worker);
  const accepted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    summary: plan.summary,
    steps: plan.steps.map((st) => (st.step_key === 'gate' ? { ...st, assignee_agent_id: worker.id } : st)),
    graph: {
      nodes: [{ key: 'gate', kind: 'task' }],
      edges: [
        { from: 'build', to: 'gate' },
        { from: 'build', to: 'docs' },
        { from: 'gate', to: 'ship' },
      ],
      max_total_visits: 20,
    },
  });
  // 거부하지 않는다 — "몇 개면 key_steps 를 만족하는가" 를 서버가 셀 수 없어서
  // 정량 강제는 정상 계획까지 막는 브리틀한 게이트가 된다.
  assert.ok(!accepted?.isError, `정책 미반영은 거부 사유가 아니다: ${JSON.stringify(accepted)}`);

  const { detail } = await readSteps(missions, mission.id, ws.id);
  const notes = detail.events.filter((e) => e.type === 'note' && /confirm_policy/.test(e.message));
  assert.equal(notes.length, 1, '운영자가 타임라인에서 정책 미반영을 볼 수 있어야 한다');
  assert.match(notes[0].message, /"key_steps"/);
});

test('confirm 게이트: 오케스트레이터의 skip 이 탈출구가 되고, 하류는 조용히 진행되지 않는다', async (t) => {
  const s = await stage(t, { label: 'skip' });
  const { ds, ws, missions, mission, worker, leadMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  let { byKey } = await readSteps(missions, mission.id, ws.id);

  step('오케스트레이터가 게이트를 skip 하면 durable pause 에서 벗어난다');
  const skipped = await leadMcp.callTool('update_orchestration_step', {
    step_id: byKey.gate.id,
    action: 'skip',
    note: 'the operator confirmed out of band',
  });
  assert.ok(!skipped?.isError, `skip failed: ${JSON.stringify(skipped)}`);

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(byKey.gate.status, 'skipped');

  step('그래도 pass edge 는 살아나지 않는다 — verdict 없이 분기가 열리면 사람의 판정이 무의미해진다');
  assert.notEqual(byKey.ship.status, 'dispatched', 'skip 이 pass 분기를 대신 눌러주지는 않는다');
  assert.equal(await roomCountFor(ds, byKey.ship.id), 0);
  // verdict 조건 edge 가 dead 라 하류는 blocked 로 확정되고, 오케스트레이터가 깨어나
  // 다음 행동을 결정한다. 이것이 의도된 동작이다.
  assert.equal(byKey.ship.status, 'blocked');
});

test('confirm 게이트: 두 사용자가 동시에 눌러도 재개는 한 번뿐이다', async (t) => {
  const s = await stage(t, { label: 'concurrent' });
  const { ds, ws, missions, runner, mission, worker, leadMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  await report(s.workerMcp, byKey.docs.id, { status: 'done', summary: 'documented', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const gateId = byKey.gate.id;

  step('두 요청을 준비해 함께 출발시킨다(고정 sleep 대신 실제 경합)');
  // withMissionLock 이 직렬화하므로 하나는 판정을 기록하고, 다른 하나는 그 뒤에
  // 실행돼 이미 판정된 게이트를 본다. 어느 쪽이 이길지는 정해져 있지 않으므로
  // 승자를 고정하지 않고 **관측 가능한 결과**만 단언한다.
  const settled = await Promise.allSettled([
    runner.submitConfirmDecision(gateId, ws.id, HUMAN, { verdict: 'pass', feedback: 'ok', visit: 1 }),
    runner.submitConfirmDecision(gateId, ws.id, OTHER_HUMAN, { verdict: 'pass', feedback: 'also ok', visit: 1 }),
  ]);

  assert.ok(
    settled.every((r) => r.status === 'fulfilled'),
    `같은 판정끼리는 둘 다 성공해야 한다(하나는 already_decided): ${JSON.stringify(settled)}`,
  );
  const resumed = settled.filter((r) => r.value.already_decided === false);
  assert.equal(resumed.length, 1, '재개한 쪽은 정확히 하나여야 한다');
  assert.deepEqual(resumed[0].value.dispatched, ['ship']);

  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  assert.equal(await roomCountFor(ds, byKey.ship.id), 1, '하류 subagent 는 한 번만 떴다');
  const { detail } = await readSteps(missions, mission.id, ws.id);
  assert.equal(eventsOfType(detail, 'confirm_decided').length, 1, '감사 로그에도 판정은 하나뿐이다');
});

test('confirm 게이트: 상반된 판정이 동시에 들어오면 하나만 이기고 나머지는 거부된다', async (t) => {
  const s = await stage(t, { label: 'conflict' });
  const { ds, ws, missions, runner, mission, worker, leadMcp } = s;

  await leadMcp.callTool('submit_orchestration_plan', { mission_id: mission.id, ...planFor(worker) });
  await advanceToGate(s);
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  await report(s.workerMcp, byKey.docs.id, { status: 'done', summary: 'documented', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const gateId = byKey.gate.id;

  const settled = await Promise.allSettled([
    runner.submitConfirmDecision(gateId, ws.id, HUMAN, { verdict: 'pass', visit: 1 }),
    runner.submitConfirmDecision(gateId, ws.id, OTHER_HUMAN, { verdict: 'fail', feedback: 'no', visit: 1 }),
  ]);

  const won = settled.filter((r) => r.status === 'fulfilled');
  const lost = settled.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1, '상반된 판정 중 하나만 기록돼야 한다');
  assert.equal(lost.length, 1, '나머지는 조용히 덮어쓰지 않고 거부돼야 한다');
  assert.equal(lost[0].reason.status, 409);
  // 어느 쪽이 이기든 패자는 **같은 사유**를 받아야 한다. 멱등 키가 step.visit 기준이던
  // 시절엔 fail 이 이겼을 때만 패자가 `is pending` 을 받아 이 단언이 순서에 의존했다 —
  // sql.js 가 FIFO 로 풀어 배열 첫 번째(pass)가 항상 이겼기 때문에 가려져 있었다.
  assert.match(lost[0].reason.message, /already decided/);

  const { detail, byKey: finalByKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(eventsOfType(detail, 'confirm_decided').length, 1);
  // 이긴 판정과 실제 실행이 반드시 일치해야 한다 — 여기가 어긋나면 사용자가 A 를
  // 눌렀는데 B 로 진행되고, 사후에 재구성조차 되지 않는다.
  const recorded = finalByKey.gate.confirm_decision.verdict;
  assert.equal(won[0].value.step.confirm_decision.verdict, recorded);
  if (recorded === 'pass') {
    assert.equal(await roomCountFor(ds, finalByKey.ship.id), 1, 'pass 였다면 pass 하류만 실행된다');
  } else {
    assert.equal(await roomCountFor(ds, finalByKey.ship.id), 0, 'fail 이었다면 pass 하류는 실행되지 않는다');
    assert.equal(finalByKey.build.visit, 2, 'fail 이었다면 loop 가 재진입한다');
  }
});

test('하위 호환: confirm_policy 가 비어 있는 기존 미션도 오류 없이 실행된다', async (t) => {
  // 이 컬럼은 DDL 마이그레이션 없이 엔티티 default + synchronize 로 추가된다. 백엔드와
  // 타이밍에 따라 **기존 행은 '' 나 NULL 로 남을 수 있고**, 그 값이 그대로 정책으로
  // 쓰이면 어느 분기에도 걸리지 않아 기능이 그 미션에서 영구 no-op 이 된다. 수용 기준의
  // "기존 mission 은 migration 후 오류 없이 실행된다" 가 실제로 재는 지점이 여기다.
  const s = await stage(t, { label: 'backfill' });
  const { ds, ws, missions, runner, mission, worker, leadMcp } = s;

  step('컬럼이 비어 있는 상태를 직접 만든다(백필 공백 재현)');
  await ds.getRepository('OrchestrationMission').update({ id: mission.id }, { confirm_policy: '' });
  const raw = await ds.getRepository('OrchestrationMission').findOne({ where: { id: mission.id } });
  assert.equal(raw.confirm_policy, '', '전제: 저장된 값이 비어 있다');

  step('읽는 쪽이 기본값으로 정규화해 상세 응답에 노출한다');
  let { detail } = await readSteps(missions, mission.id, ws.id);
  assert.equal(detail.confirm_policy, 'auto', '빈 값이 UI 셀렉트로 새어 나가면 안 된다');

  step('confirm 노드가 담긴 계획이 정상 수용되고 게이트가 열린다');
  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    ...planFor(worker),
  });
  assert.ok(!submitted?.isError, `빈 정책이 none 처럼 취급되면 안 된다: ${JSON.stringify(submitted)}`);

  await advanceToGate(s);
  let { byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(byKey.gate.status, 'awaiting_user');

  step('판정과 재개도 정상 동작한다');
  await report(s.workerMcp, byKey.docs.id, { status: 'done', summary: 'documented', visit: 1 });
  ({ byKey } = await readSteps(missions, mission.id, ws.id));
  const decided = await runner.submitConfirmDecision(byKey.gate.id, ws.id, HUMAN, { verdict: 'pass', visit: 1 });
  assert.deepEqual(decided.dispatched, ['ship']);
});

test('하위 호환: graph 모드가 꺼진 기존 wave 미션은 정책과 무관하게 예전 그대로 돈다', async (t) => {
  // confirm 노드는 graph 모드에서만 만들 수 있으므로, graph_enabled=false 인 기존
  // 미션은 confirm_policy 가 무엇이든 게이트를 가질 수 없다 — 기본값을 auto 로 둬도
  // 하위 호환이 깨지지 않는다는 주장의 근거가 이것이다. 주장으로 두지 않고 직접 잰다.
  const s = await stage(t, { label: 'wave-compat', graphEnabled: false, confirmPolicy: 'every_step' });
  const { ws, missions, mission, worker, leadMcp } = s;

  step('graph 없이 평범한 wave 계획을 제출한다');
  const plan = planFor(worker);
  const submitted = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    summary: plan.summary,
    steps: [
      { step_key: 'build', title: 'Build', instructions: 'Build it.', assignee_agent_id: worker.id },
      { step_key: 'ship', title: 'Ship', instructions: 'Ship it.', assignee_agent_id: worker.id, depends_on: ['build'] },
    ],
  });
  assert.ok(!submitted?.isError, `wave 계획은 그대로 받아들여져야 한다: ${JSON.stringify(submitted)}`);
  assert.deepEqual(submitted.dispatched_now, ['build']);

  const { detail, byKey } = await readSteps(missions, mission.id, ws.id);
  assert.equal(detail.graph_spec, null, 'graph 모드가 꺼진 미션은 그래프를 갖지 않는다');
  assert.equal(byKey.build.status, 'dispatched');
  assert.equal(byKey.ship.status, 'pending');
  assert.equal(detail.counts.awaitingUser, 0, '게이트가 생길 수 없으므로 사용자 대기도 없다');
  assert.ok(
    detail.steps.every((st) => st.status !== 'awaiting_user'),
    'every_step 정책이어도 wave 미션에는 게이트가 만들어지지 않는다',
  );

  step('진행도 예전 그대로다 — 사람 개입 없이 하류가 이어진다');
  const after = await report(s.workerMcp, byKey.build.id, { status: 'done', summary: 'built' });
  assert.deepEqual(after.next_steps_dispatched, ['ship'], 'wave 경로는 visit 없이도 그대로 동작한다');
});

exitAfterTests();
