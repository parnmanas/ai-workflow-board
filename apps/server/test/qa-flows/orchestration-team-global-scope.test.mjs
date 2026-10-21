// Account-owned teams and missions. Legacy Global/allow-list arguments cannot
// grant execution on another account's hosts; explicit Global credentials remain usable.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createApiKey, createAccount, createProject } from '../helpers/fixtures.mjs';
import { buildTeam, createRuntimeHost, slotSpec } from '../helpers/orchestration-team.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_TEAM_GLOBAL_SCOPE_PORT || '0';

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
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
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
  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: agent.host.account_id, label });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => { void client.close().catch(() => {}); });
  return client;
}

/** A Credential row — only its account scope matters to the slot reference check. */
async function credentialRow(ds, accountId, name) {
  const repo = ds.getRepository('Credential');
  return repo.save(repo.create({ account_id: accountId, name, provider: 'claude', encrypted_data: 'qa-not-a-secret' }));
}

test('legacy Global team creation cannot make an account host globally executable', async (t) => {
  const { app, modules, services } = await sharedApp(t);
  const ds = app.get(modules.getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const owner = await createAccount(app, modules.getDataSourceToken, 'global-legacy-owner');
  const other = await createAccount(app, modules.getDataSourceToken, 'global-legacy-other');
  const host = await createRuntimeHost(app, modules.getDataSourceToken, owner.id, { name: 'private-host' });
  const before = await ds.getRepository('OrchestrationTeam').count();
  await assert.rejects(teams.createTeam({
    account_id: owner.id, name: 'Legacy global', is_global: true,
    allowed_account_ids: [owner.id, other.id], orchestrator: slotSpec(host.id),
  }), /Runtime Host is not available to this team/);
  assert.equal(await ds.getRepository('OrchestrationTeam').count(), before, 'refused creation leaves no team');
});

test('team slots require owned hosts and own or explicit Global credentials', async (t) => {
  const { app, modules, services } = await sharedApp(t);
  const ds = app.get(modules.getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const owner = await createAccount(app, modules.getDataSourceToken, 'slot-owner');
  const other = await createAccount(app, modules.getDataSourceToken, 'slot-other');
  const host = await createRuntimeHost(app, modules.getDataSourceToken, owner.id, { name: 'owned' });
  const foreignHost = await createRuntimeHost(app, modules.getDataSourceToken, other.id, { name: 'foreign' });
  const own = await credentialRow(ds, owner.id, 'own login');
  const global = await credentialRow(ds, null, 'explicit Global login');
  const foreign = await credentialRow(ds, other.id, 'private login');
  const team = await teams.createTeam({ account_id: owner.id, name: 'Owned team', orchestrator: slotSpec(host.id, { credential_id: own.id }) });
  assert.equal(team.account_id, owner.id);
  await teams.addMember(team.id, owner.id, { role_label: 'shared login', runtime: slotSpec(host.id, { credential_id: global.id }) });
  await assert.rejects(teams.addMember(team.id, owner.id, { role_label: 'foreign host', runtime: slotSpec(foreignHost.id) }), /Runtime Host is not available/);
  await assert.rejects(teams.addMember(team.id, owner.id, { role_label: 'foreign credential', runtime: slotSpec(host.id, { credential_id: foreign.id }) }), /credential .* is not available/);
  assert.equal((await teams.getTeam(team.id, owner.id)).members.length, 1, 'refused slots do not change the roster');
});

test('Orchestration Team: mission account defaults to its owning team and rejects an explicit foreign account', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const wsA = await createAccount(app, getDataSourceToken, 'scoped-unchanged-a');
  const wsB = await createAccount(app, getDataSourceToken, 'scoped-unchanged-b');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    accountId: wsA.id,
    name: 'Scoped-as-before squad',
    team: { created_by: HUMAN.id },
  });
  const team = squad.team;
  const orch = squad.orchestrator;
  const orchMcp = await mcpForAgent(app, getDataSourceToken, port, orch, 'su-orch', t);
  assert.equal(team.is_global, false);
  assert.equal(team.account_id, wsA.id);

  step('Omitting account_id still defaults to the team\'s own account (existing behavior, untouched)');
  const omitted = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'default ws', objective: 'default ws', start: false,
  });
  assert.ok(!omitted.isError, `create failed: ${JSON.stringify(omitted)}`);
  const missionsSvc = app.get(services.OrchestrationMissionService);
  const detail = await missionsSvc.getMissionDetail(omitted.mission_id, wsA.id);
  assert.equal(detail.account_id, wsA.id);
  await app.get(services.OrchestrationRunnerService).completeMission(omitted.mission_id, { agentId: orch.id }, {
    status: 'failed', summary: 'cleanup',
  });

  step('An explicit account_id matching the team\'s own account is accepted (no-op)');
  const matching = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'matching ws', objective: 'matching ws', account_id: wsA.id, start: false,
  });
  assert.ok(!matching.isError, `create failed: ${JSON.stringify(matching)}`);
  await app.get(services.OrchestrationRunnerService).completeMission(matching.mission_id, { agentId: orch.id }, {
    status: 'failed', summary: 'cleanup',
  });

  step('An explicit account_id that disagrees with the team\'s own account is rejected — new protection');
  const mismatched = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'mismatched ws', objective: 'mismatched ws', account_id: wsB.id,
  });
  assert.equal(mismatched.isError, true);
  assert.match(mismatched.error.error, /caller account/);
});

test('Orchestration Team: private team visibility and owner-only writes', async (t) => {
  const { app, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const owner = await createAccount(app, getDataSourceToken, 'perm-owner');
  const other = await createAccount(app, getDataSourceToken, 'perm-other');
  const host = await createRuntimeHost(app, getDataSourceToken, owner.id, { name: 'perm-host' });

  const team = await teams.createTeam({
    account_id: owner.id,
    name: 'Owner-guarded team',
    orchestrator: slotSpec(host.id),
    created_by: HUMAN.id,
  });

  step('another account cannot list or read the team');
  const listFromOther = await teams.listTeams(other.id);
  assert.ok(!listFromOther.some((t) => t.id === team.id));

  await assert.rejects(teams.getTeam(team.id, other.id), /team not found in account/);

  step('A non-owning account cannot rename, add members to, or delete the global team');
  await assert.rejects(
    () => teams.updateTeam(team.id, other.id, { name: 'hijacked' }),
    (e) => { assert.equal(e.status, 404); assert.match(e.message, /team not found in account/); return true; },
  );
  await assert.rejects(
    () => teams.addMember(team.id, other.id, { runtime: slotSpec(host.id), role_label: 'builder' }),
    (e) => { assert.equal(e.status, 404); return true; },
  );
  await assert.rejects(
    () => teams.deleteTeam(team.id, other.id),
    (e) => { assert.equal(e.status, 404); return true; },
  );

  step('The owning account can still write to it normally');
  const renamed = await teams.updateTeam(team.id, owner.id, { name: 'Renamed by owner' });
  assert.equal(renamed.name, 'Renamed by owner');
  const withMember = await teams.addMember(team.id, owner.id, { runtime: slotSpec(host.id), role_label: 'builder' });
  assert.equal(withMember.members.length, 1);
});

test('Orchestration Team: mission capacity stays independent between account-owned teams', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const wsA = await createAccount(app, getDataSourceToken, 'cap-a');
  const wsB = await createAccount(app, getDataSourceToken, 'cap-b');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    accountId: wsA.id,
    name: 'Cap-per-account squad',
    team: {
      created_by: HUMAN.id,
      max_open_missions: 1,
      allowed_account_ids: [wsA.id, wsB.id],
    },
  });
  const team = squad.team;
  const orchMcp = await mcpForAgent(app, getDataSourceToken, port, squad.orchestrator, 'cap-orch', t);

  step('First mission in account A succeeds');
  const firstA = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'A-1', objective: 'A-1', account_id: wsA.id, start: false,
  });
  assert.ok(!firstA.isError, `create failed: ${JSON.stringify(firstA)}`);

  step('A second mission in account A is capped (limit 1 already open in A)');
  const secondA = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'A-2', objective: 'A-2', account_id: wsA.id, start: false,
  });
  assert.equal(secondA.isError, true);
  assert.equal(secondA.error.existing_mission_id, firstA.mission_id);

  assert.equal((await orchMcp.callTool('create_orchestration_mission', { team_id: team.id, title: 'foreign', objective: 'foreign', account_id: wsB.id, start: false })).isError, true);
  const squadB = await buildTeam(app, getDataSourceToken, teams, { accountId: wsB.id, name: 'B team', team: { max_open_missions: 1, created_by: HUMAN.id } });
  const mcpB = await mcpForAgent(app, getDataSourceToken, port, squadB.orchestrator, 'cap-b', t);
  step('Account B can use its own team independently');
  const firstB = await mcpB.callTool('create_orchestration_mission', {
    team_id: squadB.team.id, title: 'B-1', objective: 'B-1', account_id: wsB.id, start: false,
  });
  assert.ok(!firstB.isError, `B slot should be independent of A's cap: ${JSON.stringify(firstB)}`);
  assert.notEqual(firstB.mission_id, firstA.mission_id);
});

test('Orchestration Team: a team\'s mission works only in its own account\'s projects — refused at create and at plan time', async (t) => {
  const { app, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService, OrchestrationMissionService, OrchestrationRunnerService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);
  const runner = app.get(OrchestrationRunnerService);

  const wsA = await createAccount(app, getDataSourceToken, 'own-projects-a');
  const wsB = await createAccount(app, getDataSourceToken, 'own-projects-b');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    accountId: wsA.id,
    name: 'Own-projects squad',
    team: { max_parallel_steps: 4, created_by: HUMAN.id, allowed_account_ids: [wsA.id, wsB.id] },
    members: [{ role_label: 'builder' }],
  });
  const builder = squad.member('builder');
  const defaultsA = await squad.missionDefaultsFor(wsA.id);
  // wsB 의 project — 팀이 일해도 되는 account 이고 같은 호스트들에 폴더도 있다. 다른 것은
  // account 뿐이다. wsA 의 미션이 이 폴더에서 일하면 wsB 의 체크아웃을 wsA 의 예산으로 고친다.
  const foreign = await createProject(app, getDataSourceToken, wsB.id, {
    name: 'foreign',
    hostFolders: [
      { hostId: builder.host.id, path: '/srv/awb-test/own-projects-foreign' },
      { hostId: squad.orchestrator.host.id, path: '/srv/awb-test/own-projects-foreign-orch' },
    ],
  });
  const base = {
    account_id: wsA.id, team_id: squad.team.id, objective: 'Stay inside the mission\'s account.',
    created_by_type: 'user', created_by: HUMAN.id,
  };

  step('createMission refuses a project of another account — even an account the team may work for');
  await assert.rejects(
    () => missions.createMission({ ...base, title: 'Foreign project', projects: [{ project_id: foreign.id }] }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /not found in this mission's account/);
      assert.ok(e.message.includes(foreign.id), 'the message names the offending project');
      return true;
    },
  );
  step('...through the legacy repo_ref alias as well');
  await assert.rejects(
    () => missions.createMission({ ...base, title: 'Foreign repo_ref', repo_ref: { project_id: foreign.id } }),
    (e) => { assert.equal(e.status, 400); assert.match(e.message, /not found in this mission's account/); return true; },
  );

  step('A plan step cannot reach outside the mission\'s projects either');
  const mission = await missions.createMission({ ...base, title: 'Own projects', ...defaultsA });
  await runner.startMission(mission.id, wsA.id, HUMAN);
  await assert.rejects(
    () => runner.submitPlan(mission.id, { agentId: squad.orchestrator.id }, {
      steps: [{ step_key: 'outside', title: 'Outside', instructions: 'do it', assignee: builder.slot_id, project: foreign.id }],
    }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /is not one of this mission's projects/);
      return true;
    },
  );
  assert.equal((await missions.listSteps(mission.id)).length, 0, 'the refused plan wrote nothing');

  step('A step lands in the mission\'s own project folder; its step row and room carry the mission\'s account');
  await runner.submitPlan(mission.id, { agentId: squad.orchestrator.id }, {
    steps: [{ step_key: 'inside', title: 'Inside', instructions: 'do it', assignee: builder.slot_id }],
  });
  const [inside] = await missions.listSteps(mission.id);
  assert.equal(inside.status, 'dispatched');
  assert.equal(inside.account_id, wsA.id);
  assert.equal(inside.project_id, defaultsA.projects[0].project_id);
  assert.equal(inside.assignee_spec.working_dir, builder.folder);
  const room = await ds.getRepository('ChatRoom').findOne({ where: { id: inside.room_id } });
  assert.equal(room.account_id, wsA.id);
  const participant = await ds.getRepository('ChatRoomParticipant').findOne({
    where: { room_id: inside.room_id, participant_type: 'agent' },
  });
  assert.equal(participant.runtime_spec.working_dir, builder.folder, 'the manager is handed the wsA project\'s folder');
});

test('Orchestration Team: a dispatch failure surfaced during reportStep wakes the orchestrator exactly once, not twice', async (t) => {
  // 이 티켓의 같은 diff 안에서 발생했다가 고쳐진 버그에 대한 회귀 가드다: pump()가
  // 디스패치 실패 시 decideWake()를 스스로 호출했었는데, reportStep(과
  // failStepExternally)도 pump() 반환 직후 decideWake를 호출한다 — 둘이 겹치면
  // reportStep이 유발한 pump() 안에서 디스패치 실패가 드러났을 때 reportStep 호출
  // 한 번에 대해 wake 메시지가 두 번(agent-manager가 subagent spawn 두 번으로
  // 취급하는 실제 채팅 포스트 두 번) 올라갔다.
  //
  // 실패를 만드는 방법만 바뀌었다. 예전에는 멤버십 행의 account 를 어긋나게 고쳐
  // dispatchStep 의 account 재검증에 걸리게 했지만 그 재검증의 근거(옮길 수 있는 Agent
  // 행)가 사라졌다. 이제는 의존 step 의 실행 스냅샷에서 폴더를 지워, dispatchStep 이
  // "no runtime to run on" 으로 거절하게 한다 — 이 테스트가 보는 것은 실패 원인이 아니라
  // 그 실패가 오케스트레이터를 몇 번 깨우는가다.
  const { app, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService, OrchestrationMissionService, OrchestrationRunnerService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);
  const runner = app.get(OrchestrationRunnerService);

  const wsA = await createAccount(app, getDataSourceToken, 'double-wake-a');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    accountId: wsA.id,
    name: 'Double-wake squad',
    team: { max_parallel_steps: 4, created_by: HUMAN.id },
    members: [{ role_label: 'first' }, { role_label: 'second' }],
  });
  const team = squad.team;
  const orch = squad.orchestrator;
  const first = squad.member('first');
  const second = squad.member('second');
  const mission = await missions.createMission({
    account_id: wsA.id, team_id: team.id, title: 'Double-wake mission',
    objective: 'Prove one pump-time dispatch failure yields exactly one wake.',
    created_by_type: 'user', created_by: HUMAN.id,
    ...squad.missionDefaults,
  });
  const started = await runner.startMission(mission.id, wsA.id, HUMAN);
  // "blocked-on-first"는 "first"에 의존하므로 submitPlan 자체로는 디스패치되지
  // 않는다 — "first"가 done으로 보고되어야만, 즉 reportStep이 유발하는 pump()
  // 안에서만 디스패치 가능해진다.
  await runner.submitPlan(mission.id, { agentId: orch.id }, {
    steps: [
      { step_key: 'first', title: 'First step', instructions: 'do it', assignee: first.slot_id },
      {
        step_key: 'blocked-on-first', title: 'Depends on first, its runtime snapshot broken below',
        instructions: 'do it', assignee: second.slot_id, depends_on: ['first'],
      },
    ],
  });
  const planned = await missions.listSteps(mission.id);
  const blockedStep = planned.find((s) => s.step_key === 'blocked-on-first');
  const { working_dir: _dir, folder_scope: _scope, ...slotOnly } = blockedStep.assignee_spec;
  await ds.getRepository('OrchestrationStep').update({ id: blockedStep.id }, { assignee_spec: slotOnly });

  const beforeCount = await ds.getRepository('ChatRoomMessage').count({ where: { room_id: started.room_id } });
  assert.equal(beforeCount, 1, 'sanity: only the initial brief is in the mission room before the report');

  const firstStep = planned.find((s) => s.step_key === 'first');
  // lease token 은 dispatchStep 이 attempt 마다 발급해 work order 에 실어 보낸다 —
  // 실제 작업자가 그걸 복사해 오듯, 여기서도 현재 값을 그대로 되돌려준다(티켓 4d065f82).
  const freshFirst = await missions.requireStep(firstStep.id);
  const report = await runner.reportStep(firstStep.id, { agentId: first.id }, {
    status: 'done',
    summary: 'done',
    lease_token: freshFirst.lease_token,
  });
  assert.equal(report.orchestrator_woken, true, 'the newly-dispatchable-but-undispatchable step must still trigger a wake');

  const stepsAfter = await missions.listSteps(mission.id);
  const blocked = stepsAfter.find((s) => s.step_key === 'blocked-on-first');
  assert.equal(blocked.status, 'failed', 'a step that cannot be dispatched must fail, not silently skip');
  assert.match(blocked.result_summary, /no runtime to run on/, 'sanity: it failed for the reason this test set up');

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
