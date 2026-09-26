// QA flow: 종료된 미션을 대화로 다시 진행할 수 있는가 (운영 요청 2026-09-26:
// "종료된 미션도 다시 대화를 통해서 수정하거나 진행할 수 있도록. 지금은 아예 대화가 안돼").
//
// 고치기 전의 증상: 미션이 끝나면 그 방의 발화가 403, 참여가 409 였고, orchestrator 의
// 모든 변경 툴이 409 였다. 그래서 "거의 맞는데 한 군데만 고쳐 달라" 를 표현할 방법이
// 새 미션을 처음부터 만드는 것뿐이었다 — 계획도 step 결과도 타임라인도 대화도 전부 버리고.
//
// 이 파일이 고정하는 계약:
//   1. 끝난 미션에도 사람이 말할 수 있다. **말한 것만으로는 상태가 바뀌지 않는다** — 질문만
//      하고 끝낼 수도 있어야 하므로 되살리기는 명시적 전이다.
//   2. orchestrator 가 `reopen_orchestration_mission` 으로 스스로 되살린다(= 대화만으로
//      이어서 진행되는 경로). 되살린 뒤 plan 제출·step 보고·재완료가 전부 다시 통한다.
//   3. 되살리기는 **상태만** 복구한다: 계획·step 결과·완료 조건·직전 result_summary·
//      타임라인이 그대로 남고, 이미 끝난 step 이 되돌아가지 않는다.
//   4. 거부는 출구를 알려준다: 종료 미션에서 막힌 orchestrator 툴의 409 메시지가
//      reopen 툴 이름을 담는다(agent 가 "끝났으니 할 게 없다" 로 멈추지 않게).
//   5. 좀비 안전: 취소된 라운드의 작업자는 되살린 뒤에도 보고할 수 없다(step 이 terminal).
//   6. 운영자 REST 입구(`missions/:id/reopen`)와 워크스페이스 경계·비인증 거부.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step as logStep } from '../helpers/boot.mjs';
import { createUser, createWorkspace, createApiKey } from '../helpers/fixtures.mjs';
import { buildTeam } from '../helpers/orchestration-team.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_REOPEN_PORT || '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');
const HUMAN = { type: 'user', id: 'human-reopen', name: 'Operator' };

async function loadServices() {
  const team = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-team.service.js')).href);
  const mission = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')).href);
  const runner = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-runner.service.js')).href);
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
  };
}

const byKey = (detail) => Object.fromEntries(detail.steps.map((s) => [s.step_key, s]));

/** work order 에서 lease token 을 읽는다 — 보고에 필수다. */
async function leaseOf(ds, stepId) {
  const rooms = await ds.getRepository('ChatRoom').find({ where: { orchestration_step_id: stepId } });
  rooms.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  if (!rooms[0]) return null;
  const rows = await ds.getRepository('ChatRoomMessage').find({ where: { room_id: rooms[0].id } });
  const text = rows.map((r) => r.content || '').join('\n');
  return /lease_token`?:?\s*`?([0-9a-f-]{36})`?/i.exec(text)?.[1] ?? null;
}

test('종료된 미션을 대화로 되살려 이어서 진행한다', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => {
    void app.close().catch(() => {});
  });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const services = await loadServices();
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const base = `http://127.0.0.1:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'mission-reopen');
  const other = await createWorkspace(app, getDataSourceToken, 'mission-reopen-other');
  const operator = await createUser(app, getDataSourceToken, { name: 'reopen-operator' });
  const token = app.get(AuthService).createSession(operator.id);
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Workspace-Id': ws.id };

  const squad = await buildTeam(app, getDataSourceToken, teams, {
    workspaceId: ws.id,
    name: 'Reopen squad',
    team: { max_parallel_steps: 2, created_by: HUMAN.id },
    members: [{ role_label: 'builder' }],
  });
  const lead = squad.orchestrator;
  const worker = squad.member('builder');

  const leadKey = await createApiKey(app, getDataSourceToken, lead.id, { workspaceId: ws.id, label: 'lead' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, { workspaceId: ws.id, label: 'worker' });
  const leadMcp = new McpClient({ baseUrl: base, apiKey: leadKey.raw_key });
  const workerMcp = new McpClient({ baseUrl: base, apiKey: workerKey.raw_key });
  t.after(() => {
    void leadMcp.close().catch(() => {});
    void workerMcp.close().catch(() => {});
  });

  logStep('미션을 한 라운드 돌려 실제로 완료시킨다');
  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: squad.team.id,
    title: 'Reopen mission',
    objective: 'ship v1',
    created_by: HUMAN.id,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);
  await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [{ step_key: 'build', title: 'Build v1', instructions: 'build it', assignee_agent_id: worker.id }],
  });
  let detail = await missions.getMissionDetail(mission.id, ws.id);
  const buildStep = byKey(detail).build;
  await workerMcp.callTool('report_orchestration_step', {
    step_id: buildStep.id,
    status: 'done',
    summary: 'v1 빌드 완료',
    lease_token: await leaseOf(ds, buildStep.id),
  });
  const completed = await leadMcp.callTool('complete_orchestration_mission', {
    mission_id: mission.id,
    status: 'completed',
    summary: 'v1 을 납품했다',
  });
  assert.ok(completed && !completed.isError, `완료가 성공해야 한다: ${JSON.stringify(completed)}`);
  detail = await missions.getMissionDetail(mission.id, ws.id);
  assert.equal(detail.status, 'completed');
  assert.ok(detail.finished_at, '완료 시각이 찍힌다');
  const planVersionAtCompletion = detail.plan_version;

  logStep('끝난 미션에서 orchestrator 툴은 거부되지만, 거부가 출구를 알려준다');
  const refusedPlan = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [{ step_key: 'tweak', title: 'Tweak', instructions: 'tweak', assignee_agent_id: worker.id }],
  });
  assert.ok(refusedPlan?.isError, '끝난 미션에는 계획을 넣을 수 없다');
  const refusedText = JSON.stringify(refusedPlan);
  assert.match(refusedText, /reopen_orchestration_mission/, '막기만 하지 않고 다음 한 수를 알려준다');

  logStep('사람이 끝난 미션 방에서 말할 수 있고, 그것만으로는 상태가 바뀌지 않는다');
  await fetch(`${base}/api/orchestration/missions/${mission.id}/join-conversation`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ workspace_id: ws.id }),
  });
  const said = await fetch(`${base}/api/chat-rooms/${detail.room_id}/messages`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ content: 'v1 좋은데 버튼 색만 바꿔 줄 수 있어?' }),
  });
  assert.equal(said.status, 201, '끝난 미션에서도 운영자는 orchestrator 에게 말할 수 있다');
  assert.equal(
    (await missions.getMissionDetail(mission.id, ws.id)).status,
    'completed',
    '말한 것만으로 되살아나면 질문만 하려던 사람이 미션 상태를 거짓으로 만든다',
  );

  logStep('orchestrator 가 스스로 되살린다 — 대화만으로 이어서 진행되는 경로');
  const reopened = await leadMcp.callTool('reopen_orchestration_mission', {
    mission_id: mission.id,
    reason: '운영자가 버튼 색 변경을 요청',
  });
  assert.ok(reopened && !reopened.isError, `되살리기가 성공해야 한다: ${JSON.stringify(reopened)}`);
  assert.equal(reopened.status, 'running');

  detail = await missions.getMissionDetail(mission.id, ws.id);
  assert.equal(detail.status, 'running');
  assert.equal(detail.finished_at, null, '더 이상 끝난 미션이 아니다');
  assert.equal(detail.result_summary, 'v1 을 납품했다', '직전 라운드의 보고는 기록으로 남는다');
  assert.equal(detail.plan_version, planVersionAtCompletion, '되살리기는 계획을 건드리지 않는다');
  assert.equal(byKey(detail).build.status, 'done', '이미 끝난 step 을 되돌리지 않는다');
  assert.ok(
    detail.events.some((e) => e.type === 'mission_reopened' && /버튼 색/.test(e.message)),
    '되살린 사유가 타임라인에 남는다',
  );

  logStep('되살린 뒤 방에 깨우기 글이 들어가 orchestrator 가 맥락을 되찾는다');
  const roomText = (await ds.getRepository('ChatRoomMessage').find({ where: { room_id: detail.room_id } }))
    .map((r) => r.content || '')
    .join('\n');
  assert.match(roomText, /REOPENED this finished mission/i, '되살아났다는 사실이 방에 남는다');
  assert.match(roomText, /운영자가 버튼 색 변경을 요청/, '무엇을 요청받았는지도 함께');
  assert.match(roomText, /v1 을 납품했다/, '직전 라운드의 결론도 함께 — 없으면 처음부터 다시 계획한다');

  logStep('되살린 미션에서 계획·보고·재완료가 전부 다시 통한다');
  const replan = await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [
      { step_key: 'build', title: 'Build v1', instructions: 'build it', assignee_agent_id: worker.id },
      { step_key: 'recolor', title: 'Recolor the button', instructions: 'change the colour', assignee_agent_id: worker.id, depends_on: ['build'] },
    ],
  });
  assert.ok(replan && !replan.isError, `되살린 뒤에는 계획이 통해야 한다: ${JSON.stringify(replan)}`);
  detail = await missions.getMissionDetail(mission.id, ws.id);
  const recolor = byKey(detail).recolor;
  assert.equal(recolor.status, 'dispatched', '새 step 이 실제로 디스패치된다');
  await workerMcp.callTool('report_orchestration_step', {
    step_id: recolor.id,
    status: 'done',
    summary: '버튼 색을 바꿨다',
    lease_token: await leaseOf(ds, recolor.id),
  });
  const recompleted = await leadMcp.callTool('complete_orchestration_mission', {
    mission_id: mission.id,
    status: 'completed',
    summary: 'v1 + 버튼 색 변경까지 납품',
  });
  assert.ok(recompleted && !recompleted.isError, `재완료가 되어야 한다: ${JSON.stringify(recompleted)}`);
  detail = await missions.getMissionDetail(mission.id, ws.id);
  assert.equal(detail.status, 'completed');
  assert.equal(detail.result_summary, 'v1 + 버튼 색 변경까지 납품', '새 완료가 요약을 덮어쓴다');

  logStep('이미 살아 있는 미션은 되살릴 수 없다');
  await runner.reopenMission(mission.id, ws.id, HUMAN, {});
  const already = await leadMcp.callTool('reopen_orchestration_mission', { mission_id: mission.id });
  assert.ok(already?.isError, 'running 미션의 되살리기는 거부된다');
  assert.match(JSON.stringify(already), /only a finished mission/i);

  logStep('취소된 미션도 되살아나지만, 취소된 라운드의 좀비는 여전히 보고할 수 없다');
  const cancelled = await missions.createMission({
    workspace_id: ws.id,
    team_id: squad.team.id,
    title: 'Cancelled mission',
    objective: 'stop halfway',
    created_by: HUMAN.id,
  });
  await runner.startMission(cancelled.id, ws.id, HUMAN);
  await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: cancelled.id,
    steps: [{ step_key: 'half', title: 'Half done', instructions: 'start', assignee_agent_id: worker.id }],
  });
  const halfStep = byKey(await missions.getMissionDetail(cancelled.id, ws.id)).half;
  const zombieLease = await leaseOf(ds, halfStep.id);
  await runner.cancelMission(cancelled.id, ws.id, HUMAN, '방향이 바뀌었다');
  await runner.reopenMission(cancelled.id, ws.id, HUMAN, { reason: '다시 필요해졌다' });
  const afterReopen = await missions.getMissionDetail(cancelled.id, ws.id);
  assert.equal(afterReopen.status, 'running', '취소된 미션도 되살아난다');
  assert.equal(byKey(afterReopen).half.status, 'cancelled', '취소된 step 은 취소된 채로 남는다');
  const zombie = await workerMcp.callTool('report_orchestration_step', {
    step_id: halfStep.id,
    status: 'done',
    summary: '좀비의 지각 보고',
    lease_token: zombieLease,
  });
  assert.ok(zombie?.isError, '취소된 라운드의 작업자는 되살린 뒤에도 보고할 수 없다');
  assert.match(JSON.stringify(zombie), /already cancelled/i, 'terminal step 가드가 막는다');

  logStep('운영자 REST 입구 — 경계와 인증');
  await runner.completeMission(cancelled.id, lead.id, { status: 'failed', summary: '접는다' });
  const restReopen = await fetch(`${base}/api/orchestration/missions/${cancelled.id}/reopen`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ workspace_id: ws.id, reason: '사람이 직접 되살린다' }),
  });
  // 형제 라우트(cancel/pause/resume)와 같은 Nest 기본 201 — res.json() 이 상태를 바꾸지 않는다.
  assert.equal(restReopen.status, 201);
  assert.equal((await restReopen.json()).status, 'running');

  await runner.completeMission(cancelled.id, lead.id, { status: 'failed', summary: '다시 접는다' });
  const wrongWs = await fetch(`${base}/api/orchestration/missions/${cancelled.id}/reopen`, {
    method: 'POST',
    headers: { ...H, 'X-Workspace-Id': other.id },
    body: JSON.stringify({ workspace_id: other.id }),
  });
  assert.equal(wrongWs.status, 404, '다른 워크스페이스에서는 미션 자체가 보이지 않는다');
  const anon = await fetch(`${base}/api/orchestration/missions/${cancelled.id}/reopen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: ws.id }),
  });
  assert.ok(anon.status === 401 || anon.status === 403, `인증 없이는 되살릴 수 없다 (got ${anon.status})`);

  logStep('남의 미션은 orchestrator 가 아닌 agent 가 되살릴 수 없다');
  await assert.rejects(
    () => runner.reopenMission(cancelled.id, ws.id, { type: 'agent', id: worker.id, name: 'worker' }, {}),
    (e) => e.status === 403 || e.status === 409,
    'member agent 는 미션을 되살릴 권한이 없다',
  );
});

exitAfterTests();
