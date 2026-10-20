// QA flow: roster slots — who runs, never where.
//
// A team member used to be "an Agent someone created first", and then a slot
// spec that carried its own working folder — so a slot WAS an execution
// identity, every edit had to be pushed to the host, and the folder tied the
// whole team to one repository. Teams are reusable rosters now: a slot is
// Runtime Host + CLI + model (+ credential) and nothing else, and the folder
// comes from the mission's projects (that project's main clone on the slot's
// host). This file covers that contract end to end, against the real engine:
//
//   A. SLOTS — the team view reads a slot back with no folder and no identity
//      (a `working_dir` / `folder_scope` in the input is dropped, not stored);
//      identities appear only when a mission places a slot in a project folder,
//      where two slots that differ only by model share one identity yet stay two
//      assignable workers; an edit touches only its own row, and the
//      orchestrator's own roster row (`as_orchestrator`) only through the team;
//      removing a slot that already ran leaves the mission's history readable.
//
//   B. FOLDER SCOPE — a mission-level choice now. `shared` runs each step IN its
//      project's folder on the assignee's host with NO run provisioning (the
//      point: slots on one host share that project's tree), while `isolated`
//      provisions `.awb/orch/<mission>/<step>` under the project folder and
//      checks out the STEP's project. The work order and the brief tell each
//      side which situation it is in, and who shares the tree.
//
//   C. HOST COMMANDS — editing the roster never talks to a host (a slot is not
//      a runtime, and a running mission keeps the roster it was briefed with);
//      the next start prepares the runtimes it resolves, and a reopen restarts
//      them from the current team.
//
//   D. MODEL LIST — the slot editor's model dropdown re-enumerates on demand.
//
// The provisioning assertion is made on the RunProvision the dispatch actually
// ships (captured off RoomMessagingService), not only on the prompt text: the
// prompt is what the agent reads, but the provision is what decides whether the
// manager wipes and re-clones a directory — and pointing a `fresh` checkout at an
// operator's real project checkout is the failure `shared` exists to prevent.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createAccount, createProject } from '../helpers/fixtures.mjs';
import { buildTeam, createRuntimeHost, identityIn, slotSpec } from '../helpers/orchestration-team.mjs';

process.env.PORT = process.env.ORCHESTRATION_SLOT_PORT || '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

const HUMAN = { type: 'user', id: 'qa-operator', name: 'QA Operator' };
// 테스트마다 폴더를 따로 둔다 — shared 미션끼리의 (host, folder) 충돌 검사는 앱 전역이라,
// 같은 경로를 재사용하면 다른 테스트의 미션과 엉킨다(호스트가 달라 실제로는 안 겹치지만
// 읽는 사람이 그걸 따질 필요가 없게).
const SLOT_DIR = '/srv/awb-test/slot-tree';
const OTHER_DIR = '/srv/awb-test/other-tree';
const IDENTITY_DIR = '/srv/awb-test/identity-tree';
const SCOPE_SHARED_DIR = '/srv/awb-test/scope-shared-tree';
const SCOPE_OTHER_DIR = '/srv/awb-test/scope-other-tree';
const SECOND_SHARED_DIR = '/srv/awb-test/second-on-shared-host';
const SECOND_OTHER_DIR = '/srv/awb-test/second-on-other-host';
const BRIEF_DIR = '/srv/awb-test/brief-tree';
const PROPAGATE_DIR = '/srv/awb-test/propagate-tree';
const PROPAGATE_ORCH_DIR = '/srv/awb-test/propagate-orchestrator-tree';

async function loadServices() {
  const load = async (rel) => import(pathToFileURL(path.join(DIST, ...rel)).href);
  const team = await load(['modules', 'orchestration', 'orchestration-team.service.js']);
  const mission = await load(['modules', 'orchestration', 'orchestration-mission.service.js']);
  const runner = await load(['modules', 'orchestration', 'orchestration-runner.service.js']);
  const messaging = await load(['modules', 'chat-rooms', 'room-messaging.service.js']);
  const registry = await load(['modules', 'agent-manager', 'instance-registry.service.js']);
  const commands = await load(['modules', 'agent-manager', 'agent-manager-command.service.js']);
  const ledger = await load(['modules', 'agent-manager', 'command-ledger.service.js']);
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    RoomMessagingService: messaging.RoomMessagingService,
    InstanceRegistryService: registry.InstanceRegistryService,
    AgentManagerCommandService: commands.AgentManagerCommandService,
    CommandLedgerService: ledger.CommandLedgerService,
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

const byKey = (steps) => Object.fromEntries(steps.map((s) => [s.step_key, s]));

/** A slot (or a view of one) must carry no folder: the mission decides where it works. */
function assertNoFolder(obj, what) {
  for (const key of ['working_dir', 'folder_scope', 'shared_with']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(obj ?? {}, key), false,
      `${what} must not carry "${key}" — a slot names no folder, the mission's projects do`,
    );
  }
}

/** Everything posted into a room, in order — a brief or a work order. */
async function roomText(ds, roomId) {
  if (!roomId) return '';
  const rows = await ds.getRepository('ChatRoomMessage').find({ where: { room_id: roomId }, order: { created_at: 'ASC' } });
  return rows.map((r) => r.content || '').join('\n');
}

/** The work order the assignee actually received, read back out of its (latest) step room. */
async function workOrderFor(ds, step) {
  const fresh = await ds.getRepository('OrchestrationStep').findOne({ where: { id: step.id } });
  return roomText(ds, fresh?.room_id);
}

/** The runtime the dispatch handed the manager: the agent participant's spec snapshot in the step room. */
async function participantSpec(ds, step) {
  const fresh = await ds.getRepository('OrchestrationStep').findOne({ where: { id: step.id } });
  const row = await ds.getRepository('ChatRoomParticipant').findOne({
    where: { room_id: fresh?.room_id, participant_type: 'agent' },
  });
  return row?.runtime_spec ?? null;
}

/**
 * Record the `runProvision` option every dispatch passes to RoomMessagingService,
 * keyed by room id. The runner is the only caller that sets it for orchestration,
 * so this is a direct read of the dispatch's provisioning decision.
 */
function captureProvisions(t, messaging) {
  const byRoom = new Map();
  const original = messaging.sendMessage.bind(messaging);
  messaging.sendMessage = (roomId, ...rest) => {
    const opts = rest[rest.length - 1];
    byRoom.set(roomId, opts && typeof opts === 'object' ? (opts.runProvision ?? null) : null);
    return original(roomId, ...rest);
  };
  t.after(() => {
    messaging.sendMessage = original;
  });
  return {
    async forStep(ds, step) {
      const fresh = await ds.getRepository('OrchestrationStep').findOne({ where: { id: step.id } });
      return fresh?.room_id ? byRoom.get(fresh.room_id) ?? null : null;
    },
  };
}

/**
 * A Runtime Host that answers like a real manager: it heartbeats (a command is
 * only issuable to a live instance) and every command sent to it really goes
 * through AgentManagerCommandService.issue. `createRuntimeHost` hosts are
 * VirtualAgent hosts whose start-time preparation the team helper
 * short-circuits — useless for a test that is about which commands are sent.
 */
async function liveHost(app, getDataSourceToken, registry, accountId, name) {
  const host = await createAgent(app, getDataSourceToken, accountId, { name, type: 'manager' });
  registry.upsert({
    instance_id: `${name}-instance`,
    agent_id: host.id,
    account_id: accountId,
    mode: 'manager',
    hostname: name,
    plugin_version: 'test',
    cli: 'claude',
    cli_adapters: ['claude', 'codex'],
    pid: 1,
    started_at: new Date().toISOString(),
  });
  return host;
}

/**
 * Record every host command (`{ command, ...args }`) and ack it at once, the way
 * the manager does — runtime preparation waits for that ack before a mission
 * may dispatch anything.
 */
function recordHostCommands(t, commands, ledger) {
  const issued = [];
  const originalIssue = commands.issue.bind(commands);
  commands.issue = async (inst, command, args, issuedBy) => {
    const res = await originalIssue(inst, command, args, issuedBy);
    issued.push({ command, ...(args ?? {}) });
    const rec = ledger.get(res.command_id);
    if (rec) ledger.recordOutcome(rec, 'ok', 'qa: acked');
    return res;
  };
  t.after(() => {
    commands.issue = originalIssue;
  });
  return issued;
}

// ─── A. Slots ────────────────────────────────────────────────────────────────

test('A slot names who runs, never where — the team view carries no folder and no identity', async () => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const memberRepo = ds.getRepository('OrchestrationTeamMember');

  const ws = await createAccount(app, getDataSourceToken, 'slot-provision');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'slot-host' });

  step('Creating a team keeps the orchestrator slot and drops the folder an older client still sends with it');
  const team = await teams.createTeam({
    account_id: ws.id,
    name: 'Provisioning squad',
    created_by: HUMAN.id,
    // 슬롯이 폴더를 싣던 시절의 입력 모양 그대로 — 거절하지 않고 버린다(어디서 일할지는
    // 미션의 project 가 정한다).
    orchestrator: { ...slotSpec(host.id, { cli: 'codex', model: 'opus' }), working_dir: SLOT_DIR, folder_scope: 'shared' },
  });
  assert.equal(team.orchestrator_runtime.manager_agent_id, host.id, 'the slot names the Runtime Host it was given');
  assert.equal(team.orchestrator_runtime.manager_name, host.name);
  assert.equal(team.orchestrator_runtime.cli, 'codex', 'the CLI selector lands in the slot');
  assert.equal(team.orchestrator_runtime.model, 'opus');
  assert.equal(team.orchestrator_name, `${host.name}/codex`, 'an orchestrator slot reads as <Host>/<cli>');
  assertNoFolder(team.orchestrator_runtime, 'the orchestrator slot view');
  assert.equal('orchestrator_agent_id' in team, false,
    'a slot is not an execution identity — the team view names none (a mission does, per project folder)');
  const teamRow = await ds.getRepository('OrchestrationTeam').findOne({ where: { id: team.id } });
  assertNoFolder(teamRow.orchestrator_spec, 'the stored orchestrator slot');
  assert.equal(teamRow.orchestrator_agent_id, null, 'a new team records no orchestrator identity');

  step('Two member slots with one spec are two roster entries, told apart by role_label');
  const sameSlot = { ...slotSpec(host.id), working_dir: SLOT_DIR, folder_scope: 'shared' };
  await teams.addMember(team.id, ws.id, { runtime: sameSlot, role_label: 'builder' });
  const withTwo = await teams.addMember(team.id, ws.id, { runtime: sameSlot, role_label: 'reviewer' });
  assert.equal(withTwo.members.length, 2, 'an identical spec is not rejected as a duplicate');
  const [builder, reviewer] = ['builder', 'reviewer'].map((r) => withTwo.members.find((m) => m.role_label === r));
  assert.notEqual(builder.id, reviewer.id, 'each slot has its own address — that is what a step is assigned to');
  assert.equal(builder.agent_name, `${host.name}/builder`, 'slot labels carry the host prefix');
  assert.equal(reviewer.agent_name, `${host.name}/reviewer`);
  for (const m of [builder, reviewer]) {
    assert.equal('agent_id' in m, false, `${m.agent_name}: a member view names no identity`);
    assertNoFolder(m.runtime, `${m.agent_name} runtime`);
    const row = await memberRepo.findOne({ where: { id: m.id } });
    assert.equal(row.agent_id, null, `${m.agent_name}: a new slot row records no identity`);
    assertNoFolder(row.spec, `${m.agent_name} stored slot`);
  }

  step('A folder-only edit changes nothing — there is no folder on the slot to edit');
  const before = (await memberRepo.findOne({ where: { id: builder.id } })).spec;
  const unchanged = await teams.updateMember(team.id, ws.id, builder.id, {
    runtime: { working_dir: OTHER_DIR, folder_scope: 'isolated' },
  });
  assert.deepEqual((await memberRepo.findOne({ where: { id: builder.id } })).spec, before,
    'the stored slot is byte-identical after an edit that only named a folder');
  assertNoFolder(unchanged.members.find((m) => m.id === builder.id).runtime, 'builder runtime after a folder edit');

  step('Changing the Runtime Host moves the slot — its name follows the machine, the rest of the slot stays');
  const otherHost = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'slot-host-2' });
  const moved = await teams.updateMember(team.id, ws.id, builder.id, { runtime: { manager_agent_id: otherHost.id } });
  const movedBuilder = moved.members.find((m) => m.id === builder.id);
  assert.equal(movedBuilder.runtime.manager_agent_id, otherHost.id);
  assert.equal(movedBuilder.agent_name, `${otherHost.name}/builder`, 'the same role on another machine is another name');
  assert.equal(movedBuilder.runtime.cli, 'claude', 'a partial edit keeps the fields it did not name');
  assert.deepEqual(movedBuilder.runtime.runtime_config, builder.runtime.runtime_config);

  step('A slot reference that does not resolve is refused with a 400 — nothing is stored');
  await assert.rejects(
    () => teams.updateMember(team.id, ws.id, builder.id, {
      runtime: { manager_agent_id: '00000000-0000-4000-8000-000000000000' },
    }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /Runtime Host .* does not exist/);
      return true;
    },
  );
  await assert.rejects(
    () => teams.addMember(team.id, ws.id, {
      runtime: slotSpec(host.id, { credential_id: '00000000-0000-4000-8000-00000000c0de' }),
      role_label: 'ghost',
    }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /not available to this team/);
      return true;
    },
  );
  await assert.rejects(
    () => teams.addMember(team.id, ws.id, {
      runtime: slotSpec(host.id, { cli_runtime_profile: 'qa-no-such-profile' }),
      role_label: 'ghost',
    }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /cli_runtime_profile "qa-no-such-profile" does not exist/);
      return true;
    },
  );
  assert.equal(await memberRepo.count({ where: { team_id: team.id } }), 2, 'no refused write left a row behind');
  assert.equal(
    (await memberRepo.findOne({ where: { id: builder.id } })).spec.manager_agent_id, otherHost.id,
    'and the refused host edit did not overwrite the slot',
  );

  step('Removing a slot deletes its row; deleting the team deletes the rest');
  await teams.removeMember(team.id, ws.id, builder.id);
  assert.equal(await memberRepo.findOne({ where: { id: builder.id } }), null);
  await teams.deleteTeam(team.id, ws.id);
  assert.equal(await memberRepo.count({ where: { team_id: team.id } }), 0, 'no member rows survive the team');
});

test('Identities come from a mission: a slot in a project folder — one spec, one identity, still two assignable workers', async () => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);

  const ws = await createAccount(app, getDataSourceToken, 'slot-identity');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'identity-host' });
  const project = await createProject(app, getDataSourceToken, ws.id, {
    name: 'slot-identity',
    hostFolders: [{ hostId: host.id, path: IDENTITY_DIR }],
  });

  // Opus 리뷰어 + Sonnet 구현자를 한 장비에 — 모델만 다른 두 슬롯이 이 설계가 지키려는 모양이다.
  const orchSlot = slotSpec(host.id, { cli: 'codex' });
  const opusSlot = slotSpec(host.id, { model: 'opus' });
  const sonnetSlot = slotSpec(host.id, { model: 'sonnet' });
  let team = await teams.createTeam({
    account_id: ws.id, name: 'Identity squad', created_by: HUMAN.id, max_parallel_steps: 4, orchestrator: orchSlot,
  });
  team = await teams.addMember(team.id, ws.id, { runtime: opusSlot, role_label: 'reviewer' });
  team = await teams.addMember(team.id, ws.id, { runtime: sonnetSlot, role_label: 'implementer' });
  const [reviewer, implementer] = ['reviewer', 'implementer'].map((r) => team.members.find((m) => m.role_label === r));

  step('Starting a mission places every slot in the project\'s folder on its host and freezes the result');
  const mission = await missions.createMission({
    account_id: ws.id,
    team_id: team.id,
    title: 'Identity mission',
    objective: 'Show where execution identities come from.',
    max_parallel_steps: 4,
    created_by_type: 'user',
    created_by: HUMAN.id,
    projects: [{ project_id: project.id }],
    folder_scope: 'shared',
  });
  await runner.startMission(mission.id, ws.id, HUMAN);
  const started = await missions.requireMission(mission.id, ws.id);
  const roster = started.runtime_roster;
  assert.ok(roster, 'start must store the resolved roster on the mission');

  const orchestratorId = identityIn(orchSlot, IDENTITY_DIR);
  assert.equal(started.orchestrator_agent_id, orchestratorId,
    'the orchestrator identity is its slot in the project folder: cli + folder + credential');
  assert.equal(started.orchestrator_spec.working_dir, IDENTITY_DIR);

  const runtimeOf = (slotId) => roster.runtimes.filter((r) => r.slot_id === slotId);
  const [rv] = runtimeOf(reviewer.id);
  const [im] = runtimeOf(implementer.id);
  assert.equal(rv.project_id, project.id);
  assert.equal(rv.spec.working_dir, IDENTITY_DIR, 'a slot works in its project\'s folder on its own host');
  assert.equal(rv.agent_id, identityIn(opusSlot, IDENTITY_DIR));
  assert.equal(rv.agent_id, im.agent_id,
    'two slots that differ only by model are ONE identity in one folder — the same CLI login in the same tree');
  assert.equal(rv.spec.model, 'opus');
  assert.equal(im.spec.model, 'sonnet');

  step('...yet the orchestrator can hand each of them a step, and both run at once');
  await runner.submitPlan(mission.id, { agentId: orchestratorId }, {
    steps: [
      { step_key: 'review', title: 'Review', instructions: 'review it', assignee: reviewer.id },
      { step_key: 'implement', title: 'Implement', instructions: 'build it', assignee: implementer.id },
    ],
  });
  const steps = byKey(await missions.listSteps(mission.id));
  assert.equal(steps.review.status, 'dispatched');
  assert.equal(steps.implement.status, 'dispatched',
    'concurrency is counted per slot — a shared identity must not serialise two workers');
  assert.equal(steps.review.assignee_slot, reviewer.id);
  assert.equal(steps.implement.assignee_slot, implementer.id);
  assert.equal(steps.review.assignee_agent_id, steps.implement.assignee_agent_id);
  assert.equal(steps.review.assignee_spec.model, 'opus', 'the model rides each step\'s spec, not the identity');
  assert.equal(steps.implement.assignee_spec.model, 'sonnet');
});

test('The orchestrator on its own roster keeps one editing surface — a runtime edit on that row is refused (409)', async () => {
  // `as_orchestrator` puts the planner on the roster as an executing member by
  // copying its slot. There is no identity on a slot to compare any more, so the
  // row is recognised as the orchestrator by carrying the very same slot spec;
  // editing its runtime there would fork a look-alike off the real orchestrator.
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);

  const ws = await createAccount(app, getDataSourceToken, 'slot-self');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'self-host' });
  const team = await teams.createTeam({
    account_id: ws.id, name: 'Self squad', created_by: HUMAN.id, orchestrator: slotSpec(host.id, { model: 'opus' }),
  });

  step('The roster row copies the orchestrator\'s slot');
  const withSelf = await teams.addMember(team.id, ws.id, { as_orchestrator: true, role_label: 'planner' });
  const planner = withSelf.members.find((m) => m.role_label === 'planner');
  assert.ok(planner, 'the orchestrator is on its own roster as an executing member');
  assert.deepEqual(planner.runtime, withSelf.orchestrator_runtime, 'the row is the orchestrator\'s own slot');

  step('Its runtime can only be edited on the team itself');
  const before = (await ds.getRepository('OrchestrationTeamMember').findOne({ where: { id: planner.id } })).spec;
  await assert.rejects(
    () => teams.updateMember(team.id, ws.id, planner.id, { runtime: { model: 'sonnet' } }),
    (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /this member IS the team orchestrator/);
      return true;
    },
  );
  assert.deepEqual(
    (await ds.getRepository('OrchestrationTeamMember').findOne({ where: { id: planner.id } })).spec, before,
    'the refused edit changed nothing',
  );

  step('...while the roster-only fields stay editable there');
  const relabelled = await teams.updateMember(team.id, ws.id, planner.id, { capabilities: 'plans, then rolls the results up' });
  assert.equal(relabelled.members.find((m) => m.id === planner.id).capabilities, 'plans, then rolls the results up');

  step('Editing the orchestrator on the team moves its roster copy along — the guard survives the edit');
  // 사본을 옛 spec 에 남겨 두면 "같은 slot spec" 판정에서 빠져, 첫 오케스트레이터 편집
  // 뒤부터 그 행을 따로 고칠 수 있게 된다(서브 리뷰에서 재현된 회귀).
  const edited = await teams.updateTeam(team.id, ws.id, { orchestrator: { model: 'haiku' } });
  const plannerAfter = edited.members.find((m) => m.id === planner.id);
  assert.equal(edited.orchestrator_runtime.model, 'haiku');
  assert.deepEqual(plannerAfter.runtime, edited.orchestrator_runtime, 'the roster copy follows the orchestrator');
  assert.equal(plannerAfter.capabilities, 'plans, then rolls the results up', 'roster-only fields are untouched');
  await assert.rejects(
    () => teams.updateMember(team.id, ws.id, planner.id, { runtime: { model: 'sonnet' } }),
    (e) => e.status === 409,
    'the copy is still recognised as the orchestrator after the edit',
  );
});

test('A slot edit never touches sibling slots — each row keeps its own spec', async () => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const memberRepo = ds.getRepository('OrchestrationTeamMember');

  const ws = await createAccount(app, getDataSourceToken, 'slot-sibling');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    accountId: ws.id,
    name: 'Sibling squad',
    team: { created_by: HUMAN.id },
    members: [{ role_label: 'builder' }, { role_label: 'reviewer' }],
  });

  step('Editing one slot\'s model leaves the sibling byte-identical');
  const builderRow = await memberRepo.findOne({ where: { id: squad.member('builder').slot_id } });
  const siblingBefore = await memberRepo.findOne({ where: { id: squad.member('reviewer').slot_id } });
  const edited = await teams.updateMember(squad.team.id, ws.id, builderRow.id, { runtime: { model: 'sonnet' } });
  const editedMember = edited.members.find((m) => m.id === builderRow.id);
  assert.equal(editedMember.runtime.model, 'sonnet', 'the edit lands on the slot it named');
  assert.equal(editedMember.runtime.manager_agent_id, builderRow.spec.manager_agent_id, 'a partial edit keeps the host');
  assert.deepEqual(editedMember.runtime.runtime_config, builderRow.spec.runtime_config, '...and the execution config');

  const siblingAfter = await memberRepo.findOne({ where: { id: siblingBefore.id } });
  assert.deepEqual(siblingAfter.spec, siblingBefore.spec, 'the sibling\'s spec is byte-identical');
  assert.equal(edited.members.find((m) => m.id === siblingBefore.id).runtime.model, null);
});

test('Removing a slot that already ran keeps the mission readable — the step keeps its name, project and folder', async () => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);

  const ws = await createAccount(app, getDataSourceToken, 'slot-retire');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    accountId: ws.id,
    name: 'Retire squad',
    team: { created_by: HUMAN.id },
    members: [{ role_label: 'builder' }],
  });
  const builder = squad.member('builder');

  const mission = await missions.createMission({
    account_id: ws.id,
    team_id: squad.team.id,
    title: 'Retire mission',
    objective: 'Give the member some history.',
    created_by_type: 'user',
    created_by: HUMAN.id,
    ...squad.missionDefaults,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);
  await runner.submitPlan(mission.id, { agentId: squad.orchestrator.id }, {
    steps: [{ step_key: 'work', title: 'Do work', instructions: 'do it', assignee: builder.slot_id }],
  });

  step('Remove the slot that ran a step — its row goes');
  await teams.removeMember(squad.team.id, ws.id, builder.slot_id);
  assert.equal(
    await ds.getRepository('OrchestrationTeamMember').findOne({ where: { id: builder.slot_id } }),
    null, 'the member row is gone',
  );

  step('The step still names the slot, the project and the folder it ran in — read from the mission\'s own snapshot');
  const detail = await missions.getMissionDetail(mission.id, ws.id);
  const workStep = detail.steps.find((s) => s.step_key === 'work');
  assert.equal(workStep.assignee_name, builder.name,
    `the assignee must still render as <Host>/<role>, got "${workStep.assignee_name}"`);
  assert.equal(workStep.assignee_slot, builder.slot_id);
  assert.equal(workStep.project_id, squad.project.id);
  assert.equal(workStep.project_name, squad.project.name);
  assert.equal(workStep.working_dir, builder.folder, 'the step\'s folder: its project\'s folder on the slot\'s host');
  assert.ok(detail.roster.members.some((m) => m.slot_id === builder.slot_id),
    'a started mission keeps the roster it was briefed with, even after the team changes');
});

// ─── B. Folder scope ─────────────────────────────────────────────────────────

test('Folder scope is per mission: shared runs in the project folder with NO provisioning; isolated provisions under it with the step\'s project', async (t) => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const provisions = captureProvisions(t, app.get(services.RoomMessagingService));

  const ws = await createAccount(app, getDataSourceToken, 'slot-folder-scope');

  step('Two members work in one project folder on one host; a third on another host');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    accountId: ws.id,
    name: 'Scope squad',
    folderScope: 'shared',
    team: { max_parallel_steps: 4, created_by: HUMAN.id },
    members: [
      { role_label: 'writer', spec: { working_dir: SCOPE_SHARED_DIR } },
      { role_label: 'reader', spec: { working_dir: SCOPE_SHARED_DIR } },
      { role_label: 'loner', max_concurrent: 2, spec: { working_dir: SCOPE_OTHER_DIR } },
    ],
  });
  const writer = squad.member('writer');
  const reader = squad.member('reader');
  const loner = squad.member('loner');
  assert.equal(writer.host.id, reader.host.id, 'sanity: one project folder per host, so writer and reader share a host');
  assert.notEqual(loner.host.id, writer.host.id);

  const shared = await missions.createMission({
    account_id: ws.id,
    team_id: squad.team.id,
    title: 'Shared scope mission',
    objective: 'Prove a shared mission runs each step in its project folder.',
    max_parallel_steps: 4,
    created_by_type: 'user',
    created_by: HUMAN.id,
    ...squad.missionDefaults,
  });
  assert.equal(shared.folder_scope, 'shared');
  await runner.startMission(shared.id, ws.id, HUMAN);
  await runner.submitPlan(shared.id, { agentId: squad.orchestrator.id }, {
    steps: [
      { step_key: 'write', title: 'Write a file', instructions: 'write', assignee: writer.slot_id },
      { step_key: 'read', title: 'Read the file', instructions: 'read', assignee: reader.slot_id },
      { step_key: 'alone', title: 'Build alone', instructions: 'build', assignee: loner.slot_id },
    ],
  });
  const s = byKey(await missions.listSteps(shared.id));
  for (const key of ['write', 'read', 'alone']) assert.equal(s[key].status, 'dispatched', `${key} must dispatch`);

  step('A shared step ships NO RunProvision — the manager must not create, pin, or wipe a folder');
  assert.equal(await provisions.forStep(ds, s.write), null,
    'a shared dispatch must carry no run provisioning: a `fresh` checkout aimed at the project\'s real checkout would rm -rf it');
  assert.equal(await provisions.forStep(ds, s.alone), null, 'every step of a shared mission, on every host');

  step('...and runs in the project folder itself, on the assignee\'s host');
  const writeSpec = await participantSpec(ds, s.write);
  assert.equal(writeSpec.working_dir, SCOPE_SHARED_DIR, 'the step\'s cwd is the project folder on the writer\'s host');
  assert.equal(writeSpec.manager_agent_id, writer.host.id);
  assert.equal(writeSpec.folder_scope, 'shared');
  assert.equal((await participantSpec(ds, s.alone)).working_dir, SCOPE_OTHER_DIR,
    'on the loner\'s host it is that host\'s folder for the same project');

  step('The shared work order names the folder, the teammate in it, and the do-not-destroy rules');
  const sharedOrder = await workOrderFor(ds, s.write);
  assert.match(sharedOrder, /Shared working folder/, 'the assignee is told it is in a shared tree');
  assert.ok(sharedOrder.includes(`\`${SCOPE_SHARED_DIR}\` — your current directory`),
    `the absolute shared folder must be named, got: ${sharedOrder.slice(0, 400)}`);
  assert.ok(sharedOrder.includes(`You are sharing this folder with: ${reader.name}`),
    'the teammate sharing the tree must be named — an unannounced shared folder reads as a race, not as collaboration');
  assert.match(sharedOrder, /Do not delete, reset, or re-clone/);
  assert.match(sharedOrder, /That is the shared working folder you are in/,
    'the project block recognises its main clone as the very folder the step runs in');
  assert.doesNotMatch(sharedOrder, /\.awb\/orch/, 'a shared step must not be told about a per-step folder it never gets');

  step('A lone shared slot says so rather than naming phantom teammates');
  const aloneOrder = await workOrderFor(ds, s.alone);
  assert.match(aloneOrder, /No other team member currently shares this folder/);
  assert.ok(!aloneOrder.includes(writer.name) && !aloneOrder.includes(reader.name));

  step('An isolated mission on two projects provisions a per-step folder under the project folder, checking out THAT step\'s project');
  const second = await createProject(app, getDataSourceToken, ws.id, {
    name: 'scope-second',
    repoUrl: 'https://github.com/example/second.git',
    hostFolders: [
      { hostId: writer.host.id, path: SECOND_SHARED_DIR },
      { hostId: loner.host.id, path: SECOND_OTHER_DIR },
    ],
  });
  const isolated = await missions.createMission({
    account_id: ws.id,
    team_id: squad.team.id,
    title: 'Isolated scope mission',
    objective: 'Prove an isolated mission gives each step its own checkout of its own project.',
    max_parallel_steps: 4,
    created_by_type: 'user',
    created_by: HUMAN.id,
    projects: [{ project_id: squad.project.id }, { project_id: second.id }],
    folder_scope: 'isolated',
  });
  // isolated 는 shared 미션과 폴더를 같이 써도 충돌하지 않는다 — step 마다 제 체크아웃이 있다.
  await runner.startMission(isolated.id, ws.id, HUMAN);
  await runner.submitPlan(isolated.id, { agentId: squad.orchestrator.id }, {
    steps: [
      { step_key: 'alone-a', title: 'Build the primary', instructions: 'build', assignee: loner.slot_id, project: squad.project.id },
      { step_key: 'alone-b', title: 'Build the second', instructions: 'build', assignee: loner.slot_id, project: second.id },
    ],
  });
  const iso = byKey(await missions.listSteps(isolated.id));
  assert.equal(iso['alone-a'].status, 'dispatched');
  assert.equal(iso['alone-b'].status, 'dispatched');

  const leaf = isolated.id.slice(0, 8);
  const provisionB = await provisions.forStep(ds, iso['alone-b']);
  assert.ok(provisionB, 'an isolated dispatch must provision');
  assert.equal(provisionB.kind, 'orchestration');
  assert.equal(provisionB.workspace_folder, `.awb/orch/${leaf}/alone-b`,
    `the step folder must stay mission-keyed + step-keyed, got "${provisionB.workspace_folder}"`);
  assert.equal(provisionB.repo?.url, 'https://github.com/example/second.git',
    'an isolated step checks out its OWN project — not the mission\'s primary one');
  const provisionA = await provisions.forStep(ds, iso['alone-a']);
  assert.equal(provisionA.repo?.url, squad.project.repo_url);

  const specB = await participantSpec(ds, iso['alone-b']);
  assert.equal(specB.working_dir, SECOND_OTHER_DIR,
    'the provisioned folder is relative to the step\'s project folder on the assignee\'s host');
  assert.equal(specB.folder_scope, 'isolated');

  step('The isolated work order keeps the server-decided folder block, under the project folder');
  const isolatedOrder = await workOrderFor(ds, iso['alone-b']);
  assert.match(isolatedOrder, /Working folder \(server-decided/);
  assert.ok(isolatedOrder.includes(`<project folder>/.awb/orch/${leaf}/alone-b`));
  assert.doesNotMatch(isolatedOrder, /Shared working folder/);
  assert.ok(isolatedOrder.includes(`## Project: ${second.name}`), 'the work order names the step\'s project');
  assert.ok(isolatedOrder.includes(`\`${SECOND_OTHER_DIR}\``), '...and that project\'s main clone on this host');
});

test('The planning brief tells the orchestrator which members share a project folder, so it can sequence them', async () => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);

  const ws = await createAccount(app, getDataSourceToken, 'slot-brief');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    accountId: ws.id,
    name: 'Brief squad',
    folderScope: 'shared',
    team: { created_by: HUMAN.id },
    members: [
      { role_label: 'alpha', spec: { working_dir: BRIEF_DIR } },
      { role_label: 'beta', spec: { working_dir: BRIEF_DIR } },
    ],
  });
  const alpha = squad.member('alpha');
  const beta = squad.member('beta');
  const memberHost = alpha.host;

  const mission = await missions.createMission({
    account_id: ws.id,
    team_id: squad.team.id,
    title: 'Brief mission',
    objective: 'Read the roster.',
    created_by_type: 'user',
    created_by: HUMAN.id,
    ...squad.missionDefaults,
  });
  const started = await runner.startMission(mission.id, ws.id, HUMAN);
  const brief = await roomText(ds, started.room_id);

  step('Each member is listed by slot id, with the project it can take and its folder there');
  for (const m of [alpha, beta]) {
    assert.ok(brief.includes(`**${m.name}** (slot: \`${m.slot_id}\`)`),
      `${m.name}: the brief must address the member by its slot id — that is what a step's assignee is`);
  }
  assert.ok(
    brief.includes(`can work on **${squad.project.name}** (\`${squad.project.id}\`) — its folder on this host: \`${BRIEF_DIR}\``),
    'the brief names the project folder on the member\'s host',
  );
  assert.ok(brief.includes(`on host **${memberHost.name}**`),
    'each member states the machine it runs on — that is what distinguishes otherwise identical members');

  step('The shared folder is called out as a group, with both the capability and the hazard');
  assert.match(brief, /\*\*Shared folders\.\*\*/, 'the brief must say steps run in the project folder itself');
  assert.ok(brief.includes(`- \`${BRIEF_DIR}\` on **${memberHost.name}**: ${alpha.name}, ${beta.name}`),
    'and name the folder, its host, and both members in it');
  assert.match(brief, /pass work through the filesystem/, 'the capability half: co-located members can hand work over in place');
  assert.match(brief, /depends_on/,
    'the hazard half: concurrent steps in one tree must be sequenced, and the brief must say with what');

  step('An isolated mission of the same team says the opposite: every step gets its own checkout');
  const isolated = await missions.createMission({
    account_id: ws.id,
    team_id: squad.team.id,
    title: 'Isolated brief mission',
    objective: 'Read the roster again.',
    created_by_type: 'user',
    created_by: HUMAN.id,
    ...squad.missionDefaults,
    folder_scope: 'isolated',
  });
  const isolatedStarted = await runner.startMission(isolated.id, ws.id, HUMAN);
  const isolatedBrief = await roomText(ds, isolatedStarted.room_id);
  assert.match(isolatedBrief, /\*\*Isolated folders\.\*\*/);
  assert.doesNotMatch(isolatedBrief, /Shared folders/, 'an isolated mission has no shared tree to warn about');
});

test('Runtime Host catalogue: every paired host and its CLIs — and no folder list, because a slot names no folder', async () => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const teams = app.get(services.OrchestrationTeamService);

  const ws = await createAccount(app, getDataSourceToken, 'slot-hosts');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'catalogue-host' });
  const idle = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'idle-host' });

  step('A CLI is offered once a slot on that host names it, even before any heartbeat');
  const team = await teams.createTeam({
    account_id: ws.id, name: 'Catalogue squad', created_by: HUMAN.id, orchestrator: slotSpec(host.id),
  });
  await teams.addMember(team.id, ws.id, { runtime: slotSpec(host.id, { cli: 'codex' }), role_label: 'builder' });

  const hosts = await teams.listRuntimeHosts(ws.id);
  const entry = hosts.find((h) => h.manager_agent_id === host.id);
  assert.ok(entry, 'the paired host must be offered');
  assert.equal(entry.is_online, false, 'no heartbeat in this test — an offline host is still authorable');
  assert.ok(entry.clis.includes('claude') && entry.clis.includes('codex'),
    `the CLIs the slots on this host run must be offered with no heartbeat, got ${JSON.stringify(entry.clis)}`);
  assert.equal('working_dirs' in entry, false,
    'a slot names no folder, so the catalogue offers none — the mission\'s projects decide where work happens');

  step('A host no slot uses yet is still offered');
  const idleEntry = hosts.find((h) => h.manager_agent_id === idle.id);
  assert.ok(idleEntry, 'every paired host is a candidate');
  assert.deepEqual(idleEntry.clis, [], 'with no heartbeat and no slot there is nothing to claim it runs');
});

// ─── C. Host commands ────────────────────────────────────────────────────────

test('Roster edits never talk to a host; the next start prepares the runtimes it resolves, a reopen restarts them from the current team', async (t) => {
  // History: a slot used to BE an identity, so every edit had to reach the host
  // — `restart_agent` for an in-place edit, `stop_agent` + `spawn_agent` when the
  // edit changed the identity — because the manager caches the whole launch
  // context at spawn and otherwise kept running the old CLI. A slot is not a
  // runtime any more: a runtime is (slot × project folder), resolved when a
  // mission starts. So an edit has nothing live to propagate to — a running
  // mission keeps the roster it was briefed with — and the commands moved to
  // where runtimes are made: start prepares them (`spawn_agent`, awaited before
  // anything is dispatched) and a reopen restarts them from the CURRENT team.
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const registry = app.get(services.InstanceRegistryService);
  const commands = app.get(services.AgentManagerCommandService);
  const ledger = app.get(services.CommandLedgerService);

  const ws = await createAccount(app, getDataSourceToken, 'slot-propagate');
  const host = await liveHost(app, getDataSourceToken, registry, ws.id, 'propagate-host');
  const orchHost = await liveHost(app, getDataSourceToken, registry, ws.id, 'propagate-orch-host');
  const project = await createProject(app, getDataSourceToken, ws.id, {
    name: 'propagate',
    hostFolders: [
      { hostId: host.id, path: PROPAGATE_DIR },
      { hostId: orchHost.id, path: PROPAGATE_ORCH_DIR },
    ],
  });
  const issued = recordHostCommands(t, commands, ledger);
  const quietly = async (what, fn) => {
    issued.length = 0;
    const out = await fn();
    assert.deepEqual(issued, [],
      `${what} must not send the host anything, got ${JSON.stringify(issued.map((c) => c.command))}`);
    return out;
  };

  step('Building the roster sends nothing — no runtime exists until a mission places the slots');
  let team = await quietly('createTeam', () => teams.createTeam({
    account_id: ws.id, name: 'Propagate squad', created_by: HUMAN.id,
    orchestrator: slotSpec(orchHost.id, { cli: 'codex', model: 'gpt-5.6-luna' }),
  }));
  team = await quietly('addMember', () => teams.addMember(team.id, ws.id, { runtime: slotSpec(host.id), role_label: 'builder' }));
  const memberId = team.members[0].id;

  step('No slot edit reaches a host: CLI, model, host, a no-op re-submit, the blurb, a folder, the orchestrator');
  const edit = (patch) => () => teams.updateMember(team.id, ws.id, memberId, patch);
  await quietly('a CLI change', edit({ runtime: { cli: 'codex' } }));
  await quietly('a model change', edit({ runtime: { model: 'gpt-5.6-sol' } }));
  await quietly('a host change', edit({ runtime: { manager_agent_id: orchHost.id } }));
  await quietly('moving it back', edit({ runtime: { manager_agent_id: host.id } }));
  await quietly('a no-op re-submit', edit({ runtime: { model: 'gpt-5.6-sol' } }));
  await quietly('a capability edit', edit({ capabilities: 'now with a longer blurb' }));
  await quietly('a folder in the input (dropped)', edit({ runtime: { working_dir: '/srv/awb-test/moved', folder_scope: 'isolated' } }));
  await quietly('an orchestrator edit', () => teams.updateTeam(team.id, ws.id, { orchestrator: { model: 'gpt-5.6-terra' } }));
  const withExtra = await quietly('adding a slot', () => teams.addMember(team.id, ws.id, { runtime: slotSpec(host.id), role_label: 'extra' }));
  await quietly('removing a slot', () => teams.removeMember(team.id, ws.id, withExtra.members.find((m) => m.role_label === 'extra').id));

  step('Starting a mission prepares exactly the runtimes it resolved — the edited slots, in the project folders');
  const mission = await missions.createMission({
    account_id: ws.id,
    team_id: team.id,
    title: 'Propagate mission',
    objective: 'Bring the edited roster up.',
    created_by_type: 'user',
    created_by: HUMAN.id,
    projects: [{ project_id: project.id }],
    folder_scope: 'shared',
  });
  issued.length = 0;
  await runner.startMission(mission.id, ws.id, HUMAN);
  assert.deepEqual(issued.map((c) => c.command), ['spawn_agent', 'spawn_agent'],
    `one spawn per runtime, none of them a restart — got ${JSON.stringify(issued.map((c) => c.command))}`);
  const builderId = identityIn({ cli: 'codex' }, PROPAGATE_DIR);
  const orchestratorId = identityIn({ cli: 'codex' }, PROPAGATE_ORCH_DIR);
  const spawnedBuilder = issued.find((c) => c.agent_id === builderId);
  assert.ok(spawnedBuilder, `the builder's runtime (codex in ${PROPAGATE_DIR}) must be prepared, got ${JSON.stringify(issued)}`);
  assert.equal(spawnedBuilder.cli, 'codex', 'the CLI edit is what comes up');
  assert.equal(spawnedBuilder.model, 'gpt-5.6-sol');
  assert.equal(spawnedBuilder.working_dir, PROPAGATE_DIR, 'in the project\'s folder on the slot\'s host');
  const spawnedOrchestrator = issued.find((c) => c.agent_id === orchestratorId);
  assert.ok(spawnedOrchestrator, 'the orchestrator\'s runtime is prepared too');
  assert.equal(spawnedOrchestrator.model, 'gpt-5.6-terra', 'the orchestrator edit was picked up by this start');
  assert.equal(spawnedOrchestrator.working_dir, PROPAGATE_ORCH_DIR);

  step('An edit while the mission runs sends nothing, and the running mission keeps the roster it was briefed with');
  await quietly('an edit mid-mission', edit({ runtime: { model: 'gpt-5.6-nova' } }));
  const running = await missions.requireMission(mission.id, ws.id);
  assert.equal(running.runtime_roster.members[0].spec.model, 'gpt-5.6-sol');

  step('A human reopen restarts every runtime, members re-resolved from the CURRENT team');
  await runner.cancelMission(mission.id, ws.id, HUMAN, 'qa: stop it so it can be reopened');
  issued.length = 0;
  await runner.reopenMission(mission.id, ws.id, HUMAN);
  assert.ok(issued.length > 0 && issued.every((c) => c.command === 'restart_agent'),
    `a reopen must restart (not spawn) — CLI processes captured the old launch context, got ${JSON.stringify(issued.map((c) => c.command))}`);
  const restartedBuilder = issued.find((c) => c.agent_id === builderId);
  assert.ok(restartedBuilder, 'the builder\'s runtime is restarted');
  assert.equal(restartedBuilder.model, 'gpt-5.6-nova', 'the mid-mission edit is what the reopen brings up');
  assert.ok(issued.some((c) => c.agent_id === orchestratorId),
    'a human reopen keeps nothing alive — the orchestrator is restarted as well');
  const reopened = await missions.requireMission(mission.id, ws.id);
  assert.equal(reopened.runtime_roster.members[0].spec.model, 'gpt-5.6-nova', 'and the stored roster now says so');
});

// ─── D. The model dropdown's data source ──────────────────────────────────────

test('Runtime Host model lists can be re-enumerated on demand — a cold CLI must not strand the slot editor on free text', async (t) => {
  // Reported symptom: opencode offered a text box for the model while other
  // screens offered a dropdown. Cause: a host enumerates models ONCE at boot by
  // shelling out to each CLI with a short timeout and treating any failure as
  // "no models", so a cold or slow CLI leaves its key missing from the heartbeat
  // — and the slot editor then has nothing to build a <select> from, forever.
  // The admin agent dialog already solved this with a probe; the fix gives the
  // roster the same probe under its OWN permission (MANAGE_ACTIONS, not
  // ADMIN_ACCESS) so authoring a team never requires instance-admin rights.
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const teams = app.get(services.OrchestrationTeamService);
  const registry = app.get(services.InstanceRegistryService);
  const commands = app.get(services.AgentManagerCommandService);
  const ledger = app.get(services.CommandLedgerService);

  const ws = await createAccount(app, getDataSourceToken, 'slot-models');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'models-host' });

  step('A host that never reported a model list for a CLI exposes no options for it');
  registry.upsert({
    instance_id: 'slot-models-instance',
    agent_id: host.id,
    account_id: ws.id,
    mode: 'manager',
    hostname: 'models-host',
    plugin_version: 'test',
    cli: 'claude',
    cli_adapters: ['claude', 'opencode'],
    pid: 1,
    started_at: new Date().toISOString(),
    // opencode is installed but reported NO models — the exact cold-enumeration
    // state that produced the free-text box.
    available_models: { claude: ['opus', 'sonnet'] },
  });
  let hosts = await teams.listRuntimeHosts(ws.id);
  let entry = hosts.find((h) => h.manager_agent_id === host.id);
  assert.ok(entry.clis.includes('opencode'), 'opencode is installed on this host');
  assert.deepEqual(entry.available_models.opencode, undefined,
    'and reports no models — so the editor has nothing to offer yet');

  step('Refreshing asks the host to re-list, waits for its ack, and returns the filled-in row');
  // Stand in for the manager: ack the command the way a real host does, which is
  // what the server-side wait is correlating on — an unrelated heartbeat must not
  // be mistaken for completion.
  const originalIssue = commands.issue.bind(commands);
  commands.issue = async (inst, command, args, issuedBy) => {
    const res = await originalIssue(inst, command, args, issuedBy);
    if (command === 'refresh_available_models') {
      registry.upsert({
        instance_id: 'slot-models-instance',
        agent_id: host.id,
        account_id: ws.id,
        mode: 'manager',
        hostname: 'models-host',
        plugin_version: 'test',
        cli: 'claude',
        cli_adapters: ['claude', 'opencode'],
        pid: 1,
        started_at: new Date().toISOString(),
        available_models: { claude: ['opus', 'sonnet'], opencode: ['opencode/big-pickle', 'opencode/space-bunny-free'] },
      });
      const rec = ledger.get(res.command_id);
      if (rec) ledger.recordOutcome(rec, 'ok', 'refreshed 2 CLI(s)');
    }
    return res;
  };
  t.after(() => { commands.issue = originalIssue; });

  const refreshed = await teams.refreshRuntimeHostModels(host.id, ws.id);
  assert.deepEqual(refreshed.available_models.opencode, ['opencode/big-pickle', 'opencode/space-bunny-free'],
    'the refreshed row must carry the newly enumerated models, so the editor can render a dropdown');

  step('An offline host is refused rather than silently answered with a stale list');
  const offlineHost = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'offline-host' });
  await assert.rejects(
    () => teams.refreshRuntimeHostModels(offlineHost.id, ws.id),
    (e) => { assert.equal(e.status, 409); assert.match(e.message, /offline/i); return true; },
  );

  step('An unknown host id is a 404, not a crash');
  await assert.rejects(
    () => teams.refreshRuntimeHostModels('00000000-0000-4000-8000-000000000000', ws.id),
    (e) => { assert.equal(e.status, 404); return true; },
  );

  step('A model the host does not list still round-trips — editing a slot must never drop it');
  const team = await teams.createTeam({
    account_id: ws.id,
    name: 'Model squad',
    created_by: HUMAN.id,
    orchestrator: slotSpec(host.id, { cli: 'opencode', model: 'opencode/retired-model' }),
  });
  assert.equal(team.orchestrator_runtime.model, 'opencode/retired-model',
    'an unlisted model is the operator\'s choice, not an error — the editor prepends it to the dropdown');
});

exitAfterTests();
