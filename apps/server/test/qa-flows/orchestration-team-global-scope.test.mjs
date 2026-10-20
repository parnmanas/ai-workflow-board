// QA flow: 오케스트레이션 Team의 글로벌(account 비종속) 스코프 — 티켓 1b62b437.
//
// Team = 로스터(누가 무엇을 오케스트레이션할 수 있나), Mission = 실행·거버넌스 스코프
// (어느 account의 room/budget/project에서 도는가). 팀 슬롯은 Runtime Host + CLI + model
// 일 뿐 폴더도 실행 identity 도 없다 — 미션이 시작할 때 자기 account 의 project 폴더에
// 슬롯을 놓으면서 identity 가 생긴다. 이 파일은 그 축 분리가 끝까지 유지됨을 증명한다:
//
//   1. 글로벌 팀의 팀 행·슬롯 행에는 account 도 identity 도 없다. 슬롯이 account 안을
//      가리킬 수 있는 유일한 참조인 credential 은 글로벌이어야 한다 — 아니면 한 account 의
//      로그인을 허용된 모든 account 의 미션이 쓰게 된다.
//   2. 글로벌 팀의 create_orchestration_mission은 account_id를 요구하며 팀의
//      human이 설정한 허용목록 안의 값만 받아들인다; 결과 미션의 room/step/budget은
//      그 account로 스코핑되고, 미션은 그 account 의 project 에서 일한다 — 허용된 다른
//      account 는 같은 팀을 자기 project 로 돌린다.
//   3. account 종속 팀의 동작은 한 치도 바뀌지 않는다: account_id를 생략하면
//      여전히 팀 자신의 account가 기본값이고, 명시적으로 불일치하는 값은 이제
//      거절된다(새 동작 — 이전에는 team_id 조회 자체가 일치를 요구해서 애초에 조용히
//      불가능했다).
//   4. 글로벌 팀은 모든 account에서 보이지만(listTeams), 만든 account
//      (owner_account_id)만 쓸 수 있다.
//   5. max_open_missions는 팀 단위가 아니라 (팀, account) 단위로 강제된다 —
//      글로벌 팀의 account A 캡이 account B의 슬롯을 소비하지 않는다.
//   6. 미션이 일하는 곳은 그 미션 account 의 project 뿐이다 — 다른 account 의 project 는
//      미션 생성과 plan 제출에서 거절되고, step 은 미션 account 의 project 폴더에서 돈다.
//      (예전에는 dispatchStep 이 멤버십 행의 account 가 미션과 어긋난 멤버를 거절했다 —
//      가입 뒤 다른 account 로 옮겨진 Agent 를 막는 장치였다. 옮길 Agent 행이 없어졌고
//      슬롯 행의 account 는 팀 스코프의 정보용 스냅샷일 뿐이라, 이제 account 경계는 step 의
//      폴더가 정해지는 지점 — 미션의 project — 에 있다.)
//   7. pump() 안에서 드러난 디스패치 실패는 reportStep 한 번에 오케스트레이터를 정확히
//      한 번 깨운다.

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
  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: agent.account_id || '', label });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => { void client.close().catch(() => {}); });
  return client;
}

/** A Credential row — only its account scope matters to the slot reference check. */
async function credentialRow(ds, accountId, name) {
  const repo = ds.getRepository('Credential');
  return repo.save(repo.create({ account_id: accountId, name, provider: 'claude', encrypted_data: 'qa-not-a-secret' }));
}

// The old form of this test asserted that a account-scoped AGENT is rejected
// from a global team's roster, and later that the identities a global team
// provisioned were account-less. Neither has an input any more: a slot names a
// machine (Runtime Host + CLI + model), and it is not an identity at all — a
// mission places it in the mission account's project folders. What is left to
// hold is structural: the team row and its slot rows carry no account and no
// identity, and the one reference a slot makes INTO an account — a credential —
// must be global. The property that matters downstream is unchanged: a global
// team's mission never runs on another account's resources.
test('Orchestration Team: global roster integrity — a global team\'s rows carry no account or identity, and its slots no account credential', async (t) => {
  const { app, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);
  const memberRepo = ds.getRepository('OrchestrationTeamMember');

  const ws = await createAccount(app, getDataSourceToken, 'roster-integrity');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'roster-host' });

  step('A global team is stamped with the creating account as owner and no account of its own');
  const team = await teams.createTeam({
    account_id: ws.id,
    is_global: true,
    name: 'Global squad',
    orchestrator: slotSpec(host.id),
    created_by: HUMAN.id,
    allowed_account_ids: [ws.id],
  });
  assert.equal(team.is_global, true);
  assert.equal(team.account_id, null);
  assert.equal(team.owner_account_id, ws.id);
  assert.deepEqual(team.allowed_account_ids, [ws.id]);

  step('Its row carries no account and no orchestrator identity — a mission places the orchestrator, in the mission\'s account');
  const teamRow = await ds.getRepository('OrchestrationTeam').findOne({ where: { id: team.id } });
  assert.equal(teamRow.account_id, null, 'global team row carries no account');
  assert.equal(teamRow.orchestrator_agent_id, null, 'and no identity — a slot has no folder to be one in');

  step('So does every member slot it adds');
  const withMember = await teams.addMember(team.id, ws.id, { runtime: slotSpec(host.id), role_label: 'builder' });
  assert.equal(withMember.members.length, 1);
  assert.equal('agent_id' in withMember.members[0], false, 'a member view names no identity');
  const memberRow = await memberRepo.findOne({ where: { id: withMember.members[0].id } });
  assert.ok(memberRow, 'the slot row is addressed by its own id');
  assert.equal(memberRow.account_id, null);
  assert.equal(memberRow.agent_id, null);

  step('A global team\'s slot may only name a global credential — an account\'s login would run in every allowed account');
  const accountLogin = await credentialRow(ds, ws.id, 'account-login');
  const globalLogin = await credentialRow(ds, null, 'global-login');
  await assert.rejects(
    () => teams.addMember(team.id, ws.id, {
      runtime: slotSpec(host.id, { credential_id: accountLogin.id }),
      role_label: 'leaky',
    }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /not available to this team/);
      return true;
    },
  );
  const withGlobalLogin = await teams.addMember(team.id, ws.id, {
    runtime: slotSpec(host.id, { credential_id: globalLogin.id }),
    role_label: 'global-login',
  });
  assert.equal(withGlobalLogin.members.find((m) => m.role_label === 'global-login').runtime.credential_id, globalLogin.id);
  assert.ok(!withGlobalLogin.members.some((m) => m.role_label === 'leaky'), 'the refused slot left no row behind');

  step('A account-scoped team stamps its account onto its slot rows instead — and may use that account\'s credential');
  const scopedTeam = await teams.createTeam({
    account_id: ws.id,
    name: 'Scoped squad',
    orchestrator: slotSpec(host.id),
    created_by: HUMAN.id,
  });
  assert.equal(scopedTeam.account_id, ws.id);
  const scopedWithMember = await teams.addMember(scopedTeam.id, ws.id, {
    runtime: slotSpec(host.id, { credential_id: accountLogin.id }),
    role_label: 'builder',
  });
  const scopedRow = await memberRepo.findOne({ where: { id: scopedWithMember.members[0].id } });
  assert.equal(scopedRow.account_id, ws.id);
  assert.equal(scopedRow.agent_id, null, 'scoped or global, a slot row records no identity');
});

test('Orchestration Team: allowed_account_ids is validated against real account rows, not just normalized', async (t) => {
  const { app, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const ws = await createAccount(app, getDataSourceToken, 'allowlist-fk');
  const otherWs = await createAccount(app, getDataSourceToken, 'allowlist-fk-other');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'allowlist-fk-host' });
  const bogusAccountId = '00000000-0000-4000-8000-000000000000';

  step('createTeam rejects an allowed_account_ids entry that is not a real account row — 400, no orphan team persisted');
  await assert.rejects(
    () => teams.createTeam({
      account_id: ws.id,
      is_global: true,
      name: 'Bogus allow-list team',
      orchestrator: slotSpec(host.id),
      created_by: HUMAN.id,
      allowed_account_ids: [ws.id, bogusAccountId],
    }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, new RegExp(bogusAccountId));
      return true;
    },
  );
  const ds = app.get(getDataSourceToken());
  const orphan = await ds.getRepository('OrchestrationTeam').findOne({ where: { name: 'Bogus allow-list team' } });
  assert.equal(orphan, null, 'a team with an unvalidated allowed_account_ids entry must not be persisted');

  step('createTeam accepts allowed_account_ids once every entry is a real account');
  const team = await teams.createTeam({
    account_id: ws.id,
    is_global: true,
    name: 'Valid allow-list team',
    orchestrator: slotSpec(host.id),
    created_by: HUMAN.id,
    allowed_account_ids: [ws.id, otherWs.id],
  });
  assert.deepEqual(new Set(team.allowed_account_ids), new Set([ws.id, otherWs.id]));

  step('updateTeam rejects the same bogus id on the allow-list-replace path — 400, previous allow-list untouched');
  await assert.rejects(
    () => teams.updateTeam(team.id, ws.id, { allowed_account_ids: [bogusAccountId] }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, new RegExp(bogusAccountId));
      return true;
    },
  );
  const unchanged = await teams.getTeam(team.id, ws.id);
  assert.deepEqual(new Set(unchanged.allowed_account_ids), new Set([ws.id, otherWs.id]));
});

test('Orchestration Team: create_orchestration_mission for a global team — account_id required + allow-listed, projects of that account', async (t) => {
  const { app, port, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const { OrchestrationTeamService, OrchestrationMissionService } = services;
  const teams = app.get(OrchestrationTeamService);
  const missions = app.get(OrchestrationMissionService);

  const wsA = await createAccount(app, getDataSourceToken, 'global-mission-a');
  const wsB = await createAccount(app, getDataSourceToken, 'global-mission-b');
  const wsC = await createAccount(app, getDataSourceToken, 'global-mission-c');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    accountId: wsA.id,
    name: 'Global mission squad',
    team: { is_global: true, created_by: HUMAN.id, allowed_account_ids: [wsA.id, wsC.id] },
    members: [{ role_label: 'builder' }],
  });
  const team = squad.team;
  const orch = squad.orchestrator;
  const member = squad.member('builder');
  const orchMcp = await mcpForAgent(app, getDataSourceToken, port, orch, 'gm-orch', t);
  const defaultsA = await squad.missionDefaultsFor(wsA.id);

  step('account_id is required for a global team');
  const missing = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'no ws', objective: 'no ws',
  });
  assert.equal(missing.isError, true);
  assert.match(missing.error.error, /account_id is required/);

  step('An out-of-allow-list account_id is rejected');
  const notAllowed = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'wrong ws', objective: 'wrong ws', account_id: wsB.id,
  });
  assert.equal(notAllowed.isError, true);
  assert.match(notAllowed.error.error, /not on team .* allowed account/i);

  step('The allow-list is enforced by createMission itself, not just the MCP tool — a direct/REST-style call is rejected too (would otherwise bypass the whitelist via POST /api/orchestration/missions)');
  await assert.rejects(
    () => missions.createMission({
      account_id: wsB.id, team_id: team.id, title: 'REST bypass attempt', objective: 'REST bypass attempt',
      created_by_type: 'user', created_by: HUMAN.id,
    }),
    (e) => { assert.equal(e.status, 400); assert.match(e.message, /not on team .* allowed account/i); return true; },
  );

  step('An empty allow-list denies by default, even with a real account_id');
  // `create_orchestration_mission` 의 소유권 검사는 호출자를 그 팀의 orchestrator 슬롯(어느
  // project 폴더에서 도는 identity)과 대조하므로, 이 팀 자신의 orchestrator identity 키로
  // 호출해야 allow-list 분기까지 도달한다.
  const noListSquad = await buildTeam(app, getDataSourceToken, teams, {
    accountId: wsA.id,
    name: 'No allow-list team',
    team: { is_global: true, created_by: HUMAN.id },
  });
  const noListTeam = noListSquad.team;
  const noListMcp = await mcpForAgent(app, getDataSourceToken, port, noListSquad.orchestrator, 'gm-orch-nolist', t);
  assert.deepEqual(noListTeam.allowed_account_ids, []);
  const denied = await noListMcp.callTool('create_orchestration_mission', {
    team_id: noListTeam.id, title: 'no list', objective: 'no list', account_id: wsA.id,
    ...(await noListSquad.missionDefaultsFor(wsA.id)),
  });
  assert.equal(denied.isError, true);
  assert.match(denied.error.error, /no allowed accounts configured/);

  step('An allow-listed account_id succeeds and the mission is fully scoped to it — working in that account\'s project');
  const created = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Global mission', objective: 'Prove global team missions are account-scoped.',
    account_id: wsA.id, ...defaultsA,
  });
  assert.ok(!created.isError, `create failed: ${JSON.stringify(created)}`);
  assert.equal(created.status, 'planning', `the mission must start, got ${JSON.stringify(created)}`);
  const detail = await missions.getMissionDetail(created.mission_id, wsA.id);
  assert.equal(detail.account_id, wsA.id, 'the mission is billed to the account the orchestrator chose');
  assert.deepEqual(detail.projects.map((p) => p.project_id), defaultsA.projects.map((p) => p.project_id));

  step('The dispatched step + its room are ALSO stamped with that account, not the (null) team account');
  const plan = await orchMcp.callTool('submit_orchestration_plan', {
    mission_id: created.mission_id,
    // 레거시 별칭: 이 미션의 로스터에서 슬롯 하나에만 대응하는 실행 identity 는 그 슬롯으로 받아들여진다.
    steps: [{ step_key: 'only', title: 'Only step', instructions: 'do it', assignee_agent_id: member.id }],
  });
  assert.ok(!plan.isError, `plan failed: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.dispatched_now, ['only']);
  const step1 = (await missions.listSteps(created.mission_id))[0];
  assert.equal(step1.account_id, wsA.id);
  assert.equal(step1.assignee_slot, member.slot_id, 'the identity alias resolved to the member\'s slot');
  const room = await ds.getRepository('ChatRoom').findOne({ where: { id: step1.room_id } });
  assert.equal(room.account_id, wsA.id);

  step('A mission works only on projects of ITS OWN account — another account\'s project is refused, even for an allowed account');
  const crossed = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'crossed', objective: 'crossed', account_id: wsC.id, ...defaultsA, start: false,
  });
  assert.equal(crossed.isError, true);
  assert.match(crossed.error.error, /not found in this mission's account/);

  step('Another allowed account runs the same global team on its own project');
  const defaultsC = await squad.missionDefaultsFor(wsC.id);
  assert.notEqual(defaultsC.projects[0].project_id, defaultsA.projects[0].project_id, 'sanity: a wsC project, not wsA\'s');
  const createdC = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'Global mission in C', objective: 'Run the shared roster for another account.',
    account_id: wsC.id, ...defaultsC,
  });
  assert.ok(!createdC.isError, `create failed: ${JSON.stringify(createdC)}`);
  assert.equal(createdC.status, 'planning');
  const planC = await orchMcp.callTool('submit_orchestration_plan', {
    mission_id: createdC.mission_id,
    steps: [{ step_key: 'only', title: 'Only step', instructions: 'do it', assignee: member.slot_id }],
  });
  assert.ok(!planC.isError, `plan failed: ${JSON.stringify(planC)}`);
  assert.deepEqual(planC.dispatched_now, ['only']);
  const stepC = (await missions.listSteps(createdC.mission_id))[0];
  assert.equal(stepC.account_id, wsC.id);
  assert.equal(stepC.project_id, defaultsC.projects[0].project_id, 'the step works on wsC\'s project');
  assert.equal(stepC.assignee_spec.working_dir, member.folder, 'in that project\'s folder on the member\'s host');
  const roomC = await ds.getRepository('ChatRoom').findOne({ where: { id: stepC.room_id } });
  assert.equal(roomC.account_id, wsC.id);
});

test('Orchestration Team: account-scoped team behavior is unchanged by the global-team feature', async (t) => {
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
  assert.match(mismatched.error.error, /does not match this team's own account/);
});

test('Orchestration Team: global team visibility + owner-only write permission', async (t) => {
  const { app, modules, services } = await sharedApp(t);
  const { getDataSourceToken } = modules;
  const { OrchestrationTeamService } = services;
  const teams = app.get(OrchestrationTeamService);

  const owner = await createAccount(app, getDataSourceToken, 'perm-owner');
  const other = await createAccount(app, getDataSourceToken, 'perm-other');
  const host = await createRuntimeHost(app, getDataSourceToken, owner.id, { name: 'perm-host' });

  const team = await teams.createTeam({
    account_id: owner.id,
    is_global: true,
    name: 'Owner-guarded team',
    orchestrator: slotSpec(host.id),
    created_by: HUMAN.id,
  });

  step('listTeams(otherAccount) surfaces the global team even though it never touched that account');
  const listFromOther = await teams.listTeams(other.id);
  assert.ok(listFromOther.some((t) => t.id === team.id), 'global team must be visible from every account');

  step('getTeam is readable from any account');
  const readFromOther = await teams.getTeam(team.id, other.id);
  assert.equal(readFromOther.id, team.id);

  step('A non-owning account cannot rename, add members to, or delete the global team');
  await assert.rejects(
    () => teams.updateTeam(team.id, other.id, { name: 'hijacked' }),
    (e) => { assert.equal(e.status, 403); assert.match(e.message, /owned by a different account/); return true; },
  );
  await assert.rejects(
    () => teams.addMember(team.id, other.id, { runtime: slotSpec(host.id), role_label: 'builder' }),
    (e) => { assert.equal(e.status, 403); return true; },
  );
  await assert.rejects(
    () => teams.deleteTeam(team.id, other.id),
    (e) => { assert.equal(e.status, 403); return true; },
  );

  step('The owning account can still write to it normally');
  const renamed = await teams.updateTeam(team.id, owner.id, { name: 'Renamed by owner' });
  assert.equal(renamed.name, 'Renamed by owner');
  const withMember = await teams.addMember(team.id, owner.id, { runtime: slotSpec(host.id), role_label: 'builder' });
  assert.equal(withMember.members.length, 1);
});

test('Orchestration Team: max_open_missions is enforced per (team, account), not per team', async (t) => {
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
      is_global: true,
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

  step('A mission in account B succeeds anyway — B has its own independent slot');
  const firstB = await orchMcp.callTool('create_orchestration_mission', {
    team_id: team.id, title: 'B-1', objective: 'B-1', account_id: wsB.id, start: false,
  });
  assert.ok(!firstB.isError, `B slot should be independent of A's cap: ${JSON.stringify(firstB)}`);
  assert.notEqual(firstB.mission_id, firstA.mission_id);
});

test('Orchestration Team: a global team\'s mission works only in its own account\'s projects — refused at create and at plan time', async (t) => {
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
    team: { is_global: true, max_parallel_steps: 4, created_by: HUMAN.id, allowed_account_ids: [wsA.id, wsB.id] },
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
