// QA flow: spec-declared roster slots.
//
// A team member used to be "an Agent someone created first". It is now a slot
// spec — Runtime Host + CLI + model + working folder + folder scope — and AWB
// provisions the backing Agent identity from it. This file covers the two halves
// of that change end to end, against the real engine:
//
//   A. IDENTITY LIFECYCLE — a slot mints an identity with the right runtime;
//      editing the spec edits that identity in place; changing the host mints a
//      new one; an operator-authored agent is never mutated; releasing an
//      identity deletes it only when it never ran.
//
//   B. FOLDER SCOPE — `shared` runs the step in the slot's working_dir with NO
//      run provisioning (that is the whole point: two slots naming one folder on
//      one host share a working tree), while `isolated` keeps the pre-existing
//      per-step `.awb/orch/<mission>/<step>` provisioning. The work order tells
//      the assignee which situation it is in, and names the teammates it shares
//      the tree with.
//
// The provisioning assertion is made on the RunProvision the dispatch actually
// ships (captured off RoomMessagingService), not only on the prompt text: the
// prompt is what the agent reads, but the provision is what decides whether the
// manager wipes and re-clones a directory — and pointing a `fresh` checkout at an
// operator's real working folder is the failure this design exists to prevent.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createWorkspace } from '../helpers/fixtures.mjs';
import { buildTeam, createRuntimeHost, slotSpec } from '../helpers/orchestration-team.mjs';

process.env.PORT = process.env.ORCHESTRATION_SLOT_PORT || '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

const HUMAN = { type: 'user', id: 'qa-operator', name: 'QA Operator' };
const SHARED_DIR = '/srv/awb-test/shared-tree';
const OTHER_DIR = '/srv/awb-test/other-tree';

async function loadServices() {
  const load = async (rel) => import(pathToFileURL(path.join(DIST, ...rel)).href);
  const team = await load(['modules', 'orchestration', 'orchestration-team.service.js']);
  const mission = await load(['modules', 'orchestration', 'orchestration-mission.service.js']);
  const runner = await load(['modules', 'orchestration', 'orchestration-runner.service.js']);
  const messaging = await load(['modules', 'chat-rooms', 'room-messaging.service.js']);
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    RoomMessagingService: messaging.RoomMessagingService,
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

/** The work order the assignee actually received, read back out of its step room. */
async function workOrderFor(ds, stepId) {
  const room = await ds.getRepository('ChatRoom').findOne({ where: { orchestration_step_id: stepId } });
  if (!room) return '';
  const rows = await ds.getRepository('ChatRoomMessage').find({ where: { room_id: room.id } });
  return rows.map((r) => r.content || '').join('\n');
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
    async forStep(ds, stepId) {
      const room = await ds.getRepository('ChatRoom').findOne({ where: { orchestration_step_id: stepId } });
      return room ? byRoom.get(room.id) ?? null : null;
    },
  };
}

// ─── A. Identity lifecycle ───────────────────────────────────────────────────

test('Slot spec → provisioned identity: the roster mints its own agents with the runtime it was given', async (t) => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const agentRepo = ds.getRepository('Agent');

  const ws = await createWorkspace(app, getDataSourceToken, 'slot-provision');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'slot-host' });

  step('Creating a team provisions an orchestrator identity from the spec alone — no agent existed beforehand');
  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Provisioning squad',
    created_by: HUMAN.id,
    orchestrator: slotSpec(host.id, { model: 'opus', working_dir: SHARED_DIR, folder_scope: 'shared' }),
  });
  assert.ok(team.orchestrator_agent_id, 'the team must come out of createTeam with a dispatchable orchestrator');

  const orchRow = await agentRepo.findOne({ where: { id: team.orchestrator_agent_id } });
  assert.equal(orchRow.manager_agent_id, host.id, 'the identity is linked to the Runtime Host the slot named');
  assert.equal(orchRow.type, 'claude', 'the CLI selector lands in Agent.type, as it does for every managed agent');
  assert.equal(orchRow.model, 'opus');
  assert.equal(orchRow.working_dir, SHARED_DIR);
  assert.equal(orchRow.is_active, 1);
  assert.equal(orchRow.origin, 'orchestration', 'the row is team-owned, so the roster may edit and retire it');

  step('The team view reads the spec back with the names the UI renders');
  assert.equal(team.orchestrator_runtime.manager_name, host.name);
  assert.equal(team.orchestrator_runtime.working_dir, SHARED_DIR);
  assert.equal(team.orchestrator_runtime.folder_scope, 'shared');

  step('A member slot mints its own identity — two slots are two workers even with an identical spec');
  const withOne = await teams.addMember(team.id, ws.id, {
    runtime: slotSpec(host.id, { working_dir: SHARED_DIR, folder_scope: 'shared' }),
    role_label: 'builder',
  });
  const withTwo = await teams.addMember(team.id, ws.id, {
    runtime: slotSpec(host.id, { working_dir: SHARED_DIR, folder_scope: 'shared' }),
    role_label: 'reviewer',
  });
  assert.equal(withTwo.members.length, 2);
  const [builder, reviewer] = ['builder', 'reviewer'].map((r) => withTwo.members.find((m) => m.role_label === r));
  assert.notEqual(builder.agent_id, reviewer.agent_id,
    'an identical spec must NOT collapse two slots into one worker — they need separate identities to get separate steps');
  assert.notEqual(builder.agent_name, reviewer.agent_name, 'and distinguishable names');

  step('...while still sharing the folder, which is what they were configured for');
  assert.equal(builder.runtime.working_dir, reviewer.runtime.working_dir);
  assert.ok(builder.runtime.shared_with.includes(reviewer.agent_name),
    `builder must report sharing with the reviewer, got ${JSON.stringify(builder.runtime.shared_with)}`);
  assert.ok(reviewer.runtime.shared_with.includes(builder.agent_name));
  assert.ok(reviewer.runtime.shared_with.includes(team.orchestrator_name),
    'the orchestrator sits in the same folder too, so it counts as a folder mate');
  assert.equal(withOne.members.length, 1, 'sanity: the first add really did land before the second');

  step('Editing the folder edits the SAME identity in place — the worker is not replaced');
  const moved = await teams.updateMember(team.id, ws.id, builder.id, {
    runtime: { working_dir: OTHER_DIR },
  });
  const movedBuilder = moved.members.find((m) => m.id === builder.id);
  assert.equal(movedBuilder.agent_id, builder.agent_id, 'a folder change must not mint a new identity');
  assert.equal(movedBuilder.runtime.working_dir, OTHER_DIR);
  const movedRow = await agentRepo.findOne({ where: { id: builder.agent_id } });
  assert.equal(movedRow.working_dir, OTHER_DIR, 'and the identity itself followed');
  assert.deepEqual(movedBuilder.runtime.shared_with, [], 'it no longer shares a tree with anyone');

  step('Changing the Runtime Host DOES mint a new identity — per-agent cli-home/api key live on the old machine');
  const otherHost = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'slot-host-2' });
  const rehosted = await teams.updateMember(team.id, ws.id, builder.id, {
    runtime: { manager_agent_id: otherHost.id },
  });
  const rehostedBuilder = rehosted.members.find((m) => m.id === builder.id);
  assert.notEqual(rehostedBuilder.agent_id, builder.agent_id, 'a host change is a new worker, not an edit');
  assert.equal(rehostedBuilder.runtime.manager_agent_id, otherHost.id);
  const retired = await agentRepo.findOne({ where: { id: builder.agent_id } });
  assert.equal(retired, null, 'the replaced identity never ran, so it is deleted rather than left behind');

  step('Removing a slot releases its identity; deleting the team releases the rest');
  await teams.removeMember(team.id, ws.id, rehostedBuilder.id);
  assert.equal(await agentRepo.findOne({ where: { id: rehostedBuilder.agent_id } }), null);
  await teams.deleteTeam(team.id, ws.id);
  assert.equal(await agentRepo.findOne({ where: { id: team.orchestrator_agent_id } }), null);
  assert.equal(await agentRepo.findOne({ where: { id: reviewer.agent_id } }), null);
});

test('An operator-authored agent on a roster is never mutated — a spec edit mints a team-owned identity instead', async (t) => {
  // This is the shape every pre-refactor roster row has after the back-fill
  // migration: the slot points at an agent a human made, which may also be a
  // ticket assignee or a chat participant. Editing one team must not reach into it.
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const agentRepo = ds.getRepository('Agent');

  const ws = await createWorkspace(app, getDataSourceToken, 'slot-legacy');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'legacy-host' });
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    workspaceId: ws.id,
    name: 'Legacy squad',
    host,
    team: { created_by: HUMAN.id },
    members: [{ role_label: 'builder' }],
  });

  step('Simulate the back-filled state: the slot points at an operator-authored agent with a derived spec');
  const operatorAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'operator-owned', hosted: false });
  await agentRepo.update({ id: operatorAgent.id }, {
    manager_agent_id: host.id,
    type: 'claude',
    working_dir: SHARED_DIR,
    origin: '',
  });
  const memberRow = await ds.getRepository('OrchestrationTeamMember').findOne({
    where: { team_id: squad.team.id, role_label: 'builder' },
  });
  await ds.getRepository('OrchestrationTeamMember').update({ id: memberRow.id }, {
    agent_id: operatorAgent.id,
    // The column is `simple-json`; hand it the object and let the entity
    // metadata encode it, exactly as the back-fill migration does.
    spec: slotSpec(host.id, { working_dir: SHARED_DIR }),
  });

  step('Editing that slot leaves the operator\'s agent untouched and points the slot at a new identity');
  const edited = await teams.updateMember(squad.team.id, ws.id, memberRow.id, {
    runtime: { model: 'sonnet' },
  });
  const editedMember = edited.members.find((m) => m.id === memberRow.id);
  assert.notEqual(editedMember.agent_id, operatorAgent.id,
    'the roster must not adopt-and-rewrite an agent a human owns');

  const untouched = await agentRepo.findOne({ where: { id: operatorAgent.id } });
  assert.ok(untouched, 'the operator\'s agent still exists');
  assert.equal(untouched.model, null, 'and its model was not rewritten by the team edit');
  assert.equal(untouched.origin, '', 'and it did not become team-owned');

  const minted = await agentRepo.findOne({ where: { id: editedMember.agent_id } });
  assert.equal(minted.origin, 'orchestration');
  assert.equal(minted.model, 'sonnet');
});

test('Releasing an identity that already ran retires it instead of deleting it, so mission history stays readable', async (t) => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const agentRepo = ds.getRepository('Agent');

  const ws = await createWorkspace(app, getDataSourceToken, 'slot-retire');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    workspaceId: ws.id,
    name: 'Retire squad',
    team: { created_by: HUMAN.id },
    members: [{ role_label: 'builder' }],
  });
  const builder = squad.member('builder');

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: squad.team.id,
    title: 'Retire mission',
    objective: 'Give the member some history.',
    created_by_type: 'user',
    created_by: HUMAN.id,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);
  await runner.submitPlan(mission.id, squad.orchestrator.id, {
    steps: [{ step_key: 'work', title: 'Do work', instructions: 'do it', assignee_agent_id: builder.id }],
  });

  step('Remove the member that ran a step — the identity survives, deactivated');
  const memberRow = squad.team.members.find((m) => m.agent_id === builder.id);
  await teams.removeMember(squad.team.id, ws.id, memberRow.id);
  const kept = await agentRepo.findOne({ where: { id: builder.id } });
  assert.ok(kept, 'an identity referenced by a finished step must not be deleted — the timeline resolves its name at read time');
  assert.equal(kept.is_active, 0, 'but it is deactivated, so nothing can dispatch to it again');

  step('The step it ran still resolves to a name, not to "(deleted agent)"');
  const detail = await missions.getMissionDetail(mission.id, ws.id);
  const workStep = detail.steps.find((s) => s.step_key === 'work');
  assert.ok(workStep.assignee_name && workStep.assignee_name.includes('/'),
    `the assignee must still render as <Manager>/<Agent>, got "${workStep.assignee_name}"`);
});

// ─── B. Folder scope ─────────────────────────────────────────────────────────

test('folder_scope: shared dispatches into the working folder with NO provisioning; isolated keeps the per-step folder', async (t) => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const provisions = captureProvisions(t, app.get(services.RoomMessagingService));

  const ws = await createWorkspace(app, getDataSourceToken, 'slot-folder-scope');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'scope-host' });

  step('Two members share one folder; a third is isolated under its own');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    workspaceId: ws.id,
    name: 'Scope squad',
    host,
    team: { max_parallel_steps: 4, created_by: HUMAN.id },
    members: [
      { role_label: 'writer', spec: { working_dir: SHARED_DIR, folder_scope: 'shared' } },
      { role_label: 'reader', spec: { working_dir: SHARED_DIR, folder_scope: 'shared' } },
      { role_label: 'loner', spec: { working_dir: OTHER_DIR, folder_scope: 'isolated' } },
    ],
  });
  const writer = squad.member('writer');
  const reader = squad.member('reader');
  const loner = squad.member('loner');

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: squad.team.id,
    title: 'Scope mission',
    objective: 'Prove each slot runs where its scope says.',
    max_parallel_steps: 4,
    created_by_type: 'user',
    created_by: HUMAN.id,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);
  await runner.submitPlan(mission.id, squad.orchestrator.id, {
    steps: [
      { step_key: 'write', title: 'Write a file', instructions: 'write', assignee_agent_id: writer.id },
      { step_key: 'read', title: 'Read the file', instructions: 'read', assignee_agent_id: reader.id },
      { step_key: 'alone', title: 'Build alone', instructions: 'build', assignee_agent_id: loner.id },
    ],
  });

  const steps = Object.fromEntries((await missions.listSteps(mission.id)).map((s) => [s.step_key, s]));
  assert.equal(steps.write.status, 'dispatched');
  assert.equal(steps.alone.status, 'dispatched');

  step('A shared slot ships NO RunProvision — the manager must not create, pin, or wipe a folder');
  assert.equal(await provisions.forStep(ds, steps.write.id), null,
    'a shared-scope dispatch must carry no run provisioning: a `fresh` checkout aimed at the operator\'s real working folder would rm -rf it');

  step('An isolated slot still ships the per-step .awb/orch provisioning it always did');
  const lonerProvision = await provisions.forStep(ds, steps.alone.id);
  assert.ok(lonerProvision, 'an isolated-scope dispatch must still provision');
  assert.equal(lonerProvision.kind, 'orchestration');
  assert.match(lonerProvision.workspace_folder, /^\.awb\/orch\/.+\/alone$/,
    `the step folder must stay mission-keyed + step-keyed, got "${lonerProvision.workspace_folder}"`);

  step('The shared work order names the real folder, the teammates in it, and the do-not-destroy rules');
  const sharedOrder = await workOrderFor(ds, steps.write.id);
  assert.match(sharedOrder, /Shared working folder/, 'the assignee is told it is in a shared tree');
  assert.ok(sharedOrder.includes(SHARED_DIR), `the absolute shared folder must be named, got: ${sharedOrder.slice(0, 400)}`);
  assert.ok(sharedOrder.includes(reader.name),
    'the teammate sharing the tree must be named — an unannounced shared folder reads as a race, not as collaboration');
  assert.match(sharedOrder, /do not re-clone|Do not delete, reset, or re-clone/i);
  assert.doesNotMatch(sharedOrder, /\.awb\/orch/, 'a shared slot must not be told about a per-step folder it never gets');

  step('The isolated work order keeps the old server-decided folder block');
  const isolatedOrder = await workOrderFor(ds, steps.alone.id);
  assert.match(isolatedOrder, /Working folder \(server-decided/);
  assert.match(isolatedOrder, /\.awb\/orch\//);
  assert.doesNotMatch(isolatedOrder, /Shared working folder/);

  step('A lone shared slot says so rather than naming phantom teammates');
  const solo = await teams.addMember(squad.team.id, ws.id, {
    runtime: slotSpec(host.id, { working_dir: '/srv/awb-test/solo-tree', folder_scope: 'shared' }),
    role_label: 'solo',
  });
  const soloMember = solo.members.find((m) => m.role_label === 'solo');
  assert.deepEqual(soloMember.runtime.shared_with, []);
});

test('The planning brief tells the orchestrator who shares a folder, so it can sequence them', async (t) => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);

  const ws = await createWorkspace(app, getDataSourceToken, 'slot-brief');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'brief-host' });
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    workspaceId: ws.id,
    name: 'Brief squad',
    host,
    team: { created_by: HUMAN.id },
    members: [
      { role_label: 'alpha', spec: { working_dir: SHARED_DIR, folder_scope: 'shared' } },
      { role_label: 'beta', spec: { working_dir: SHARED_DIR, folder_scope: 'shared' } },
    ],
  });

  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: squad.team.id,
    title: 'Brief mission',
    objective: 'Read the roster.',
    created_by_type: 'user',
    created_by: HUMAN.id,
  });
  const started = await runner.startMission(mission.id, ws.id, HUMAN);
  const rows = await ds.getRepository('ChatRoomMessage').find({ where: { room_id: started.room_id } });
  const brief = rows.map((r) => r.content || '').join('\n');

  assert.match(brief, /Shared working folders/, 'the brief must call the shared folders out as a group');
  assert.ok(brief.includes(SHARED_DIR), 'and name the folder');
  assert.ok(brief.includes(squad.member('alpha').name) && brief.includes(squad.member('beta').name),
    'and name both members in it');
  assert.match(brief, /pass work through the filesystem/,
    'the capability half: co-located members can hand work over in place');
  assert.match(brief, /depends_on/,
    'the hazard half: concurrent steps in one tree must be sequenced, and the brief must say with what');
  assert.match(brief, new RegExp(`on host \\*\\*${host.name}`),
    'each member states the machine it runs on — that is what distinguishes otherwise identical members');
});

test('Runtime Host catalogue: offers every paired host, its installed CLIs, and the folders already in use on it', async (t) => {
  const { app, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  const teams = app.get(services.OrchestrationTeamService);

  const ws = await createWorkspace(app, getDataSourceToken, 'slot-hosts');
  const host = await createRuntimeHost(app, getDataSourceToken, ws.id, { name: 'catalogue-host' });

  step('A folder is offered once a slot names it, even before any agent has spawned in it');
  await buildTeam(app, getDataSourceToken, teams, {
    workspaceId: ws.id,
    name: 'Catalogue squad',
    host,
    team: { created_by: HUMAN.id },
    members: [{ role_label: 'builder', spec: { working_dir: SHARED_DIR } }],
  });

  const hosts = await teams.listRuntimeHosts(ws.id);
  const entry = hosts.find((h) => h.manager_agent_id === host.id);
  assert.ok(entry, 'the paired host must be offered');
  assert.equal(entry.is_online, false, 'no heartbeat in this test — an offline host is still authorable');
  assert.ok(entry.working_dirs.includes(SHARED_DIR),
    `the folder the slot named must be a one-click choice for the next slot, got ${JSON.stringify(entry.working_dirs)}`);
  assert.ok(entry.clis.includes('claude'),
    'the CLI an existing agent on this host runs must be offered even with no heartbeat');
});

exitAfterTests();
