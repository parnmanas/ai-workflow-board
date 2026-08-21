// QA flow: 오케스트레이션 Team의 글로벌(workspace 비종속) 스코프 — 티켓 1b62b437.
//
// Team = 로스터(누가 무엇을 오케스트레이션할 수 있나), Mission = 실행·거버넌스 스코프
// (어느 workspace의 room/budget에서 도는가). 이 파일은 그 축 분리가 끝까지 유지됨을
// 증명한다:
//
//   1. 글로벌 팀의 로스터에는 글로벌(workspace 비종속) 에이전트만 들어갈 수 있다 —
//      workspace 종속 에이전트는 orchestrator/member로 거절된다.
//   2. 글로벌 팀의 create_orchestration_mission은 workspace_id를 요구하며 팀의
//      human이 설정한 허용목록 안의 값만 받아들인다; 결과 미션의 room/step/budget은
//      그 workspace로 스코핑된다.
//   3. workspace 종속 팀의 동작은 한 치도 바뀌지 않는다: workspace_id를 생략하면
//      여전히 팀 자신의 workspace가 기본값이고, 명시적으로 불일치하는 값은 이제
//      거절된다(새 동작 — 이전에는 team_id 조회 자체가 일치를 요구해서 애초에 조용히
//      불가능했다).
//   4. 글로벌 팀은 모든 workspace에서 보이지만(listTeams), 만든 workspace
//      (owner_workspace_id)만 쓸 수 있다.
//   5. max_open_missions는 팀 단위가 아니라 (팀, workspace) 단위로 강제된다 —
//      글로벌 팀의 workspace A 캡이 workspace B의 슬롯을 소비하지 않는다.
//   6. dispatchStep은 디스패치 시점에 assignee의 workspace를 재검증한다 — 팀 가입
//      이후 move_agent_to_workspace로 다른 workspace로 옮겨진 에이전트는 절대
//      스텝을 받지 않는다; 대신 실패 처리되고 오케스트레이터가 깨어난다(글로벌 팀
//      여부와 무관하게 기존에 있던 구멍도 닫는다).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createApiKey, createWorkspace } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_TEAM_GLOBAL_SCOPE_PORT || '7940';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

async function loadServices() {
  const team = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-team.service.js')).href
  );
  const mission = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')).href
  );
  const runner = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-runner.service.js')).href
  );
  const workspaceMove = await import(
    pathToFileURL(path.join(DIST, 'services', 'workspace-move.service.js')).href
  );
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    WorkspaceMoveService: workspaceMove.WorkspaceMoveService,
  };
}

const HUMAN = { type: 'user', id: 'qa-operator', name: 'QA Operator' };

let shared = null;
async function sharedApp(t) {
  if (!shared) {
    shared = await bootApp({ port: parseInt(process.env.PORT, 10) });
    const { app } = shared;
    shared.services = await loadServices();
    process.on('exit', () => { void app.close().catch(() => {}); });
  }
  return shared;
}

async function mcpForAgent(app, getDataSourceToken, port, agent, label, t) {
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: agent.workspace_id || '', label });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => { void client.close().catch(() => {}); });
  return client;
}

test('Orchestration Team: global roster integrity — only global agents may orchestrate or join a global team', async (t) => {
  const { app, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const ws = await createWorkspace(app, getDataSourceToken, 'roster-integrity');
  const scopedAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'scoped' });
  const globalOrch = await createAgent(app, getDataSourceToken, null, { name: 'global-orch' });
  const globalMember = await createAgent(app, getDataSourceToken, null, { name: 'global-member' });

  step('A workspace-scoped agent cannot orchestrate a global team');
  await assert.rejects(
    () => teams.createTeam({
      workspace_id: ws.id,
      is_global: true,
      name: 'Rejected global team',
      orchestrator_agent_id: scopedAgent.id,
      created_by: HUMAN.id,
    }),
    /global team/i,
  );

  step('A global agent can orchestrate a global team, which is stamped with the creating workspace as owner');
  const team = await teams.createTeam({
    workspace_id: ws.id,
    is_global: true,
    name: 'Global squad',
    orchestrator_agent_id: globalOrch.id,
    created_by: HUMAN.id,
    allowed_workspace_ids: [ws.id],
  });
  assert.equal(team.is_global, true);
  assert.equal(team.workspace_id, null);
  assert.equal(team.owner_workspace_id, ws.id);
  assert.deepEqual(team.allowed_workspace_ids, [ws.id]);

  step('A workspace-scoped agent is rejected as a member of the global team — clear 400');
  await assert.rejects(
    () => teams.addMember(team.id, ws.id, { agent_id: scopedAgent.id }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /global team/i);
      return true;
    },
  );

  step('A global agent joins the global team roster fine');
  const withMember = await teams.addMember(team.id, ws.id, { agent_id: globalMember.id });
  assert.equal(withMember.members.length, 1);
  assert.equal(withMember.members[0].agent_id, globalMember.id);
});

test('Orchestration Team: allowed_workspace_ids is validated against real workspace rows, not just normalized', async (t) => {
  const { app, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const ws = await createWorkspace(app, getDataSourceToken, 'allowlist-fk');
  const otherWs = await createWorkspace(app, getDataSourceToken, 'allowlist-fk-other');
  const orch = await createAgent(app, getDataSourceToken, null, { name: 'allowlist-fk-orch' });
  const bogusWorkspaceId = '00000000-0000-4000-8000-000000000000';

  step('createTeam rejects an allowed_workspace_ids entry that is not a real workspace row — 400, no orphan team persisted');
  await assert.rejects(
    () => teams.createTeam({
      workspace_id: ws.id,
      is_global: true,
      name: 'Bogus allow-list team',
      orchestrator_agent_id: orch.id,
      created_by: HUMAN.id,
      allowed_workspace_ids: [ws.id, bogusWorkspaceId],
    }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, new RegExp(bogusWorkspaceId));
      return true;
    },
  );
  const ds = app.get(getDataSourceToken());
  const orphan = await ds.getRepository('OrchestrationTeam').findOne({ where: { name: 'Bogus allow-list team' } });
  assert.equal(orphan, null, 'a team with an unvalidated allowed_workspace_ids entry must not be persisted');

  step('createTeam accepts allowed_workspace_ids once every entry is a real workspace');
  const team = await teams.createTeam({
    workspace_id: ws.id,
    is_global: true,
    name: 'Valid allow-list team',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
    allowed_workspace_ids: [ws.id, otherWs.id],
  });
  assert.deepEqual(new Set(team.allowed_workspace_ids), new Set([ws.id, otherWs.id]));

  step('updateTeam rejects the same bogus id on the allow-list-replace path — 400, previous allow-list untouched');
  await assert.rejects(
    () => teams.updateTeam(team.id, ws.id, { allowed_workspace_ids: [bogusWorkspaceId] }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, new RegExp(bogusWorkspaceId));
      return true;
    },
  );
  const unchanged = await teams.getTeam(team.id, ws.id);
  assert.deepEqual(new Set(unchanged.allowed_workspace_ids), new Set([ws.id, otherWs.id]));
});

test('Orchestration Team: create_orchestration_mission for a global team — workspace_id required + allow-listed', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService, OrchestrationMissionService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);

  const wsA = await createWorkspace(app, getDataSourceToken, 'global-mission-a');
  const wsB = await createWorkspace(app, getDataSourceToken, 'global-mission-b');
  const orch = await createAgent(app, getDataSourceToken, null, { name: 'gm-orch' });
  const member = await createAgent(app, getDataSourceToken, null, { name: 'gm-member' });
  const orchMcp = await mcpForAgent(app, getDataSourceToken, port, orch, 'gm-orch', t);

  const team = await teams.createTeam({
    workspace_id: wsA.id,
    is_global: true,
    name: 'Global mission squad',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
    allowed_workspace_ids: [wsA.id],
  });
  await teams.addMember(team.id, wsA.id, { agent_id: member.id });

  step('workspace_id is required for a global team');
  const missing = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'no ws', objective: 'no ws',
  });
  assert.equal(missing.isError, true);
  assert.match(missing.error.error, /workspace_id is required/);

  step('An out-of-allow-list workspace_id is rejected');
  const notAllowed = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'wrong ws', objective: 'wrong ws', workspace_id: wsB.id,
  });
  assert.equal(notAllowed.isError, true);
  assert.match(notAllowed.error.error, /not on team .* allowed workspace/i);

  step('The allow-list is enforced by createMission itself, not just the MCP tool — a direct/REST-style call is rejected too (would otherwise bypass the whitelist via POST /api/orchestration/missions)');
  await assert.rejects(
    () => missions.createMission({
      workspace_id: wsB.id, team_id: team.id, title: 'REST bypass attempt', objective: 'REST bypass attempt',
      created_by_type: 'user', created_by: HUMAN.id,
    }),
    (e) => { assert.equal(e.status, 400); assert.match(e.message, /not on team .* allowed workspace/i); return true; },
  );

  step('An empty allow-list denies by default, even with a real workspace_id');
  const noListTeam = await teams.createTeam({
    workspace_id: wsA.id,
    is_global: true,
    name: 'No allow-list team',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
  });
  assert.deepEqual(noListTeam.allowed_workspace_ids, []);
  const denied = await orchMcp.callTool('create_orchestration_mission', {
    team_id: noListTeam.id, title: 'no list', objective: 'no list', workspace_id: wsA.id,
  });
  assert.equal(denied.isError, true);
  assert.match(denied.error.error, /no allowed workspaces configured/);

  step('An allow-listed workspace_id succeeds and the mission is fully scoped to it');
  const created = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Global mission', objective: 'Prove global team missions are workspace-scoped.',
    workspace_id: wsA.id,
  });
  assert.ok(!created.isError, `create failed: ${JSON.stringify(created)}`);
  assert.equal(created.status, 'planning');
  const detail = await missions.getMissionDetail(created.mission_id, wsA.id);
  assert.equal(detail.workspace_id, wsA.id, 'the mission is billed to the workspace the orchestrator chose');

  step('The dispatched step + its room are ALSO stamped with that workspace, not the (null) team workspace');
  const plan = await orchMcp.callTool('submit_orchestration_plan', {
    mission_id: created.mission_id,
    steps: [{ step_key: 'only', title: 'Only step', instructions: 'do it', assignee_agent_id: member.id }],
  });
  assert.ok(!plan.isError, `plan failed: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.dispatched_now, ['only']);
  const step1 = (await missions.listSteps(created.mission_id))[0];
  assert.equal(step1.workspace_id, wsA.id);
  const room = await ds.getRepository('ChatRoom').findOne({ where: { id: step1.room_id } });
  assert.equal(room.workspace_id, wsA.id);
});

test('Orchestration Team: workspace-scoped team behavior is unchanged by the global-team feature', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const wsA = await createWorkspace(app, getDataSourceToken, 'scoped-unchanged-a');
  const wsB = await createWorkspace(app, getDataSourceToken, 'scoped-unchanged-b');
  const orch = await createAgent(app, getDataSourceToken, wsA.id, { name: 'su-orch' });
  const orchMcp = await mcpForAgent(app, getDataSourceToken, port, orch, 'su-orch', t);

  const team = await teams.createTeam({
    workspace_id: wsA.id,
    name: 'Scoped-as-before squad',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
  });
  assert.equal(team.is_global, false);
  assert.equal(team.workspace_id, wsA.id);

  step('Omitting workspace_id still defaults to the team\'s own workspace (existing behavior, untouched)');
  const omitted = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'default ws', objective: 'default ws', start: false,
  });
  assert.ok(!omitted.isError, `create failed: ${JSON.stringify(omitted)}`);
  const missionsSvc = app.get(services.OrchestrationMissionService);
  const detail = await missionsSvc.getMissionDetail(omitted.mission_id, wsA.id);
  assert.equal(detail.workspace_id, wsA.id);
  await app.get(services.OrchestrationRunnerService).completeMission(omitted.mission_id, orch.id, {
    status: 'failed', summary: 'cleanup',
  });

  step('An explicit workspace_id matching the team\'s own workspace is accepted (no-op)');
  const matching = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'matching ws', objective: 'matching ws', workspace_id: wsA.id, start: false,
  });
  assert.ok(!matching.isError, `create failed: ${JSON.stringify(matching)}`);
  await app.get(services.OrchestrationRunnerService).completeMission(matching.mission_id, orch.id, {
    status: 'failed', summary: 'cleanup',
  });

  step('An explicit workspace_id that disagrees with the team\'s own workspace is rejected — new protection');
  const mismatched = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'mismatched ws', objective: 'mismatched ws', workspace_id: wsB.id,
  });
  assert.equal(mismatched.isError, true);
  assert.match(mismatched.error.error, /does not match this team's own workspace/);
});

test('Orchestration Team: global team visibility + owner-only write permission', async (t) => {
  const { app, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const owner = await createWorkspace(app, getDataSourceToken, 'perm-owner');
  const other = await createWorkspace(app, getDataSourceToken, 'perm-other');
  const orch = await createAgent(app, getDataSourceToken, null, { name: 'perm-orch' });
  const anotherGlobalAgent = await createAgent(app, getDataSourceToken, null, { name: 'perm-member' });

  const team = await teams.createTeam({
    workspace_id: owner.id,
    is_global: true,
    name: 'Owner-guarded team',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
  });

  step('listTeams(otherWorkspace) surfaces the global team even though it never touched that workspace');
  const listFromOther = await teams.listTeams(other.id);
  assert.ok(listFromOther.some((t) => t.id === team.id), 'global team must be visible from every workspace');

  step('getTeam is readable from any workspace');
  const readFromOther = await teams.getTeam(team.id, other.id);
  assert.equal(readFromOther.id, team.id);

  step('A non-owning workspace cannot rename, add members to, or delete the global team');
  await assert.rejects(
    () => teams.updateTeam(team.id, other.id, { name: 'hijacked' }),
    (e) => { assert.equal(e.status, 403); assert.match(e.message, /owned by a different workspace/); return true; },
  );
  await assert.rejects(
    () => teams.addMember(team.id, other.id, { agent_id: anotherGlobalAgent.id }),
    (e) => { assert.equal(e.status, 403); return true; },
  );
  await assert.rejects(
    () => teams.deleteTeam(team.id, other.id),
    (e) => { assert.equal(e.status, 403); return true; },
  );

  step('The owning workspace can still write to it normally');
  const renamed = await teams.updateTeam(team.id, owner.id, { name: 'Renamed by owner' });
  assert.equal(renamed.name, 'Renamed by owner');
  const withMember = await teams.addMember(team.id, owner.id, { agent_id: anotherGlobalAgent.id });
  assert.equal(withMember.members.length, 1);
});

test('Orchestration Team: max_open_missions is enforced per (team, workspace), not per team', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const wsA = await createWorkspace(app, getDataSourceToken, 'cap-a');
  const wsB = await createWorkspace(app, getDataSourceToken, 'cap-b');
  const orch = await createAgent(app, getDataSourceToken, null, { name: 'cap-orch' });
  const orchMcp = await mcpForAgent(app, getDataSourceToken, port, orch, 'cap-orch', t);

  const team = await teams.createTeam({
    workspace_id: wsA.id,
    is_global: true,
    name: 'Cap-per-workspace squad',
    orchestrator_agent_id: orch.id,
    created_by: HUMAN.id,
    max_open_missions: 1,
    allowed_workspace_ids: [wsA.id, wsB.id],
  });

  step('First mission in workspace A succeeds');
  const firstA = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'A-1', objective: 'A-1', workspace_id: wsA.id, start: false,
  });
  assert.ok(!firstA.isError, `create failed: ${JSON.stringify(firstA)}`);

  step('A second mission in workspace A is capped (limit 1 already open in A)');
  const secondA = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'A-2', objective: 'A-2', workspace_id: wsA.id, start: false,
  });
  assert.equal(secondA.isError, true);
  assert.equal(secondA.error.existing_mission_id, firstA.mission_id);

  step('A mission in workspace B succeeds anyway — B has its own independent slot');
  const firstB = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'B-1', objective: 'B-1', workspace_id: wsB.id, start: false,
  });
  assert.ok(!firstB.isError, `B slot should be independent of A's cap: ${JSON.stringify(firstB)}`);
  assert.notEqual(firstB.mission_id, firstA.mission_id);
});

test('Orchestration Team: dispatchStep re-validates workspace legality — a member moved after joining is never dispatched to', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService, OrchestrationMissionService, OrchestrationRunnerService, WorkspaceMoveService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);
  const runner = app.get(OrchestrationRunnerService);
  const workspaceMove = app.get(WorkspaceMoveService);

  const wsA = await createWorkspace(app, getDataSourceToken, 'move-bug-a');
  const wsB = await createWorkspace(app, getDataSourceToken, 'move-bug-b');
  const orch = await createAgent(app, getDataSourceToken, wsA.id, { name: 'move-bug-orch' });
  const stayer = await createAgent(app, getDataSourceToken, wsA.id, { name: 'move-bug-stayer' });
  const mover = await createAgent(app, getDataSourceToken, wsA.id, { name: 'move-bug-mover' });

  const team = await teams.createTeam({
    workspace_id: wsA.id,
    name: 'Move-bug squad',
    orchestrator_agent_id: orch.id,
    max_parallel_steps: 4,
    created_by: HUMAN.id,
  });
  await teams.addMember(team.id, wsA.id, { agent_id: stayer.id });
  await teams.addMember(team.id, wsA.id, { agent_id: mover.id });

  step('mover joins while still in workspace A, then is moved to workspace B — membership row is left stale (pre-existing bug)');
  await workspaceMove.commitAgentMove(mover.id, wsB.id, { actor_id: HUMAN.id, actor_name: HUMAN.name });
  const moverRow = await ds.getRepository('Agent').findOne({ where: { id: mover.id } });
  assert.equal(moverRow.workspace_id, wsB.id);
  const staleMembership = await ds.getRepository('OrchestrationTeamMember').findOne({ where: { team_id: team.id, agent_id: mover.id } });
  assert.ok(staleMembership, 'the membership row is NOT cleaned up by the move — this is the gap dispatchStep must catch');

  step('Start a mission and submit a plan with one step per member, both dependency-free');
  const mission = await missions.createMission({
    workspace_id: wsA.id, team_id: team.id, title: 'Move-bug mission', objective: 'Prove stale membership cannot be dispatched to.',
    created_by_type: 'user', created_by: HUMAN.id,
  });
  const started = await runner.startMission(mission.id, wsA.id, HUMAN);
  const plan = await runner.submitPlan(mission.id, orch.id, {
    steps: [
      { step_key: 'stays', title: 'Goes to the agent still in A', instructions: 'do it', assignee_agent_id: stayer.id },
      { step_key: 'moved', title: 'Goes to the agent moved to B', instructions: 'do it', assignee_agent_id: mover.id },
    ],
  });

  step('The legitimate step dispatches normally; the stale one is failed instead, and the orchestrator is woken');
  const steps = await missions.listSteps(mission.id);
  const byKey = Object.fromEntries(steps.map((s) => [s.step_key, s]));
  assert.equal(byKey.stays.status, 'dispatched', 'an in-workspace member is unaffected by the fix');
  assert.equal(byKey.moved.status, 'failed', 'the moved member must never receive the work order');
  assert.match(byKey.moved.result_summary, /workspace/);
  assert.equal(byKey.moved.room_id, null, 'no room was ever created for the illegal dispatch');

  const events = await ds.getRepository('OrchestrationEvent').find({ where: { mission_id: mission.id }, order: { created_at: 'ASC' } });
  assert.ok(events.some((e) => e.type === 'orchestrator_woken'), 'a dispatch failure must wake the orchestrator, same as a reported failure');

  step('The wake prompt actually reached the orchestrator\'s room');
  const roomMsgs = await ds.getRepository('ChatRoomMessage').find({ where: { room_id: started.room_id }, order: { created_at: 'ASC' } });
  assert.ok(roomMsgs.length >= 2, 'brief + wake-up, at minimum');
  assert.match(roomMsgs[roomMsgs.length - 1].content, /moved/);
});

test('Orchestration Team: a dispatch failure surfaced during reportStep wakes the orchestrator exactly once, not twice', async (t) => {
  // 이 티켓의 같은 diff 안에서 발생했다가 고쳐진 버그에 대한 회귀 가드다: pump()가
  // 디스패치 실패 시 decideWake()를 스스로 호출했었는데, reportStep(과
  // failStepExternally)도 pump() 반환 직후 decideWake를 호출한다 — 둘이 겹치면
  // reportStep이 유발한 pump() 안에서 디스패치 실패가 드러났을 때 reportStep 호출
  // 한 번에 대해 wake 메시지가 두 번(agent-manager가 subagent spawn 두 번으로
  // 취급하는 실제 채팅 포스트 두 번) 올라갔다.
  const { app, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService, OrchestrationMissionService, OrchestrationRunnerService, WorkspaceMoveService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);
  const runner = app.get(OrchestrationRunnerService);
  const workspaceMove = app.get(WorkspaceMoveService);

  const wsA = await createWorkspace(app, getDataSourceToken, 'double-wake-a');
  const wsB = await createWorkspace(app, getDataSourceToken, 'double-wake-b');
  const orch = await createAgent(app, getDataSourceToken, wsA.id, { name: 'double-wake-orch' });
  const first = await createAgent(app, getDataSourceToken, wsA.id, { name: 'double-wake-first' });
  const second = await createAgent(app, getDataSourceToken, wsA.id, { name: 'double-wake-second' });

  const team = await teams.createTeam({
    workspace_id: wsA.id, name: 'Double-wake squad', orchestrator_agent_id: orch.id,
    max_parallel_steps: 4, created_by: HUMAN.id,
  });
  await teams.addMember(team.id, wsA.id, { agent_id: first.id });
  await teams.addMember(team.id, wsA.id, { agent_id: second.id });
  await workspaceMove.commitAgentMove(second.id, wsB.id, { actor_id: HUMAN.id, actor_name: HUMAN.name });

  const mission = await missions.createMission({
    workspace_id: wsA.id, team_id: team.id, title: 'Double-wake mission',
    objective: 'Prove one pump-time dispatch failure yields exactly one wake.',
    created_by_type: 'user', created_by: HUMAN.id,
  });
  const started = await runner.startMission(mission.id, wsA.id, HUMAN);
  // "blocked-on-first"는 "first"에 의존하므로 submitPlan 자체로는 디스패치되지
  // 않는다 — "first"가 done으로 보고되어야만, 즉 reportStep이 유발하는 pump()
  // 안에서만 디스패치 가능해진다.
  await runner.submitPlan(mission.id, orch.id, {
    steps: [
      { step_key: 'first', title: 'First step', instructions: 'do it', assignee_agent_id: first.id },
      {
        step_key: 'blocked-on-first', title: 'Depends on first, assigned to the moved agent',
        instructions: 'do it', assignee_agent_id: second.id, depends_on: ['first'],
      },
    ],
  });

  const beforeCount = await ds.getRepository('ChatRoomMessage').count({ where: { room_id: started.room_id } });
  assert.equal(beforeCount, 1, 'sanity: only the initial brief is in the mission room before the report');

  const [firstStep] = await missions.listSteps(mission.id).then((all) => all.filter((s) => s.step_key === 'first'));
  const report = await runner.reportStep(firstStep.id, first.id, { status: 'done', summary: 'done' });
  assert.equal(report.orchestrator_woken, true, 'the newly-dispatchable-but-illegal step must still trigger a wake');

  const stepsAfter = await missions.listSteps(mission.id);
  const blocked = stepsAfter.find((s) => s.step_key === 'blocked-on-first');
  assert.equal(blocked.status, 'failed', 'dispatch to the moved agent must fail, not silently skip');

  const wokenEvents = await ds.getRepository('OrchestrationEvent').find({
    where: { mission_id: mission.id, type: 'orchestrator_woken' },
  });
  assert.equal(wokenEvents.length, 1, 'exactly one orchestrator_woken event — not one from pump() and another from reportStep');

  const roomMsgsAfter = await ds.getRepository('ChatRoomMessage').find({
    where: { room_id: started.room_id }, order: { created_at: 'ASC' },
  });
  assert.equal(roomMsgsAfter.length, 2, 'brief + exactly one wake message, not two');
  assert.match(
    roomMsgsAfter[1].content,
    /failed/i,
    'the single wake correctly reports the dispatch failure as the reason, not a generic stalled message',
  );
});

exitAfterTests();
