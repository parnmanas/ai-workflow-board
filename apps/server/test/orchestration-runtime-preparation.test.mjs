import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestrationRunnerService } from '../dist/modules/orchestration/orchestration-runner.service.js';
import { runtimeIdentityKey } from '../dist/common/runtime-spec.js';

// A team slot names no folder; the mission's project decides where it runs
// (its folder on the slot's host). These fixtures place every slot on host-1,
// where the mission's one project lives in /work/app.
const PROJECT_FOLDER = '/work/app';
const slot = (model = null) => ({ manager_agent_id: 'host-1', cli: 'claude', credential_id: 'credential-1', model,
  runtime_config: { strategy: 'single', permission_mode: 'approve' } });
const exec = (spec, dir, scope = 'shared') => ({ ...spec, working_dir: dir, folder_scope: scope, cli_runtime_profile: null });

function fixture(provision) {
  const team = { id: 'team', name: 'Team', enabled: 1, account_id: 'account', orchestrator_agent_id: null,
    orchestrator_spec: slot() };
  // The orchestrator the mission room already has — kept across a reopen.
  const orchestratorExec = exec(slot(), PROJECT_FOLDER);
  const mission = { id: 'mission', title: 'Mission', account_id: 'account', team_id: team.id, status: 'failed',
    room_id: 'room', orchestrator_agent_id: runtimeIdentityKey(orchestratorExec), orchestrator_spec: orchestratorExec,
    finished_at: new Date(), failure_reason: 'auth', result_summary: 'previous result',
    projects: [{ project_id: 'project-1', branch: '' }], folder_scope: 'shared', runtime_roster: null,
    excluded_member_ids: [], extra_member_specs: [], user_chat_mode: 'open' };
  // Two slots that differ only by model: in one project folder they are ONE
  // execution identity (cli + folder + credential), so they are prepared once.
  const members = [
    { id: 'slot-builder', agent_id: null, spec: slot('opus'), role_label: 'builder', capabilities: '', max_concurrent: 1 },
    { id: 'slot-reviewer', agent_id: null, spec: slot('sonnet'), role_label: 'reviewer', capabilities: '', max_concurrent: 1 },
  ];
  const projects = {
    getInAccount: async (id, accountId) => (id === 'project-1' && accountId === 'account'
      ? { id, account_id: accountId, name: 'App', repo_url: 'https://example.test/app.git', default_branch: 'main', instructions: '' }
      : null),
    hostFolders: async () => new Map([['host-1', PROJECT_FOLDER]]),
  };
  const teams = { listMembers: async () => members, listRuntimeHosts: async () => [] };
  const dataSource = { getRepository: () => ({ find: async () => [], findOne: async () => null }) };
  const events = [];
  const missionRepo = { save: async () => { events.push('save'); }, find: async () => [] };
  const runner = new OrchestrationRunnerService(
    missionRepo, {}, { findOne: async () => team },
    { find: async () => members, findOne: async () => null }, { create: (r) => r, save: async (r) => ({ ...r, id: 'new-room' }) },
    { create: (r) => r, save: async (r) => r }, {}, {}, dataSource, {},
    { requireMission: async () => mission, listSteps: async () => [], recordEvent: async () => {} },
    teams, {}, { warn() {}, info() {} }, undefined, undefined, projects,
    { provisionSlotIdentity: provision },
  );
  runner.postToRoom = async () => { events.push('dispatch'); };
  return { runner, mission, team, members, events };
}

const human = { type: 'user', id: 'human', name: 'Operator' };

test('human rerun restarts each distinct identity before making the mission runnable', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { runner, mission, events } = fixture(async (runtime, opts) => {
    calls.push({ runtime, opts });
    await barrier;
    return { ok: true };
  });
  const result = runner.reopenMission(mission.id, mission.account_id, human);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mission.status, 'failed');
  assert.deepEqual(events, ['save'], 'only the re-resolved roster is stored before the hosts answer');
  assert.equal(calls.length, 1, 'orchestrator and both member slots are one identity in one folder — restarted once');
  assert.ok(calls.every(({ opts }) => opts.restart && opts.waitForAckMs > 0));
  assert.equal(calls[0].runtime.working_dir, PROJECT_FOLDER, 'runtimes run in the project folder on their host');
  release();
  await result;
  assert.equal(mission.status, 'running');
  assert.equal(mission.result_summary, 'previous result');
  assert.deepEqual(events, ['save', 'save', 'dispatch']);
  assert.equal(mission.runtime_roster.members.length, 2, 'both slots stay separately assignable');
});

test('failed credential preparation leaves the mission terminal and sends no wake', async () => {
  const { runner, mission, events } = fixture(async () => ({ ok: false, reason: 'credential unavailable' }));
  await assert.rejects(runner.reopenMission(mission.id, mission.account_id, human), /credential unavailable/);
  assert.equal(mission.status, 'failed');
  assert.equal(mission.failure_reason, 'auth');
  assert.equal(mission.runtime_roster, null, 'a failed reopen puts the previous roster back');
  assert.ok(!events.includes('dispatch'));
});

test('initial preparation awaits hosts without requesting a process restart', async () => {
  const calls = [];
  const { runner, mission, team } = fixture(async (runtime, opts) => {
    calls.push({ runtime, opts });
    return { ok: true };
  });
  mission.status = 'draft';
  mission.room_id = null;
  await runner.startMission(mission.id, mission.account_id, human);
  assert.equal(calls.length, 1);
  assert.ok(calls.every(({ opts }) => !opts.restart && opts.waitForAckMs === 30_000));
  assert.equal(mission.status, 'planning');
  assert.equal(mission.orchestrator_agent_id, runtimeIdentityKey(exec(team.orchestrator_spec, PROJECT_FOLDER)));
});

test('an MCP reopen keeps its calling orchestrator alive while restarting members', async () => {
  const calls = [];
  const { runner, mission, members } = fixture(async (runtime, opts) => {
    calls.push({ runtime, opts });
    return { ok: true };
  });
  // A member on another credential is a different identity from the orchestrator.
  members[0].spec = { ...members[0].spec, credential_id: 'credential-2' };
  runner.requireOrchestrator = () => {};
  await runner.reopenMission(mission.id, mission.account_id, {
    type: 'agent', id: mission.orchestrator_agent_id, runtimeKey: mission.orchestrator_agent_id,
  });
  assert.equal(calls.length, 1, 'the caller (orchestrator, shared with the reviewer slot) is not restarted');
  assert.equal(calls[0].runtime.credential_id, 'credential-2');
  assert.equal(calls[0].runtime.working_dir, PROJECT_FOLDER);
  assert.equal(calls[0].opts.restart, true);
});

test('first start waits for authentication before creating a room or changing draft status', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { runner, mission, events } = fixture(async (runtime) => {
    calls.push(runtime);
    await barrier;
    return { ok: false, reason: 'credential unavailable' };
  });
  mission.status = 'draft';
  mission.room_id = null;
  // A previous failed start can leave a snapshot; a new start uses the current team.
  mission.orchestrator_spec = exec(slot(), '/old-orchestrator');
  const pending = runner.startMission(mission.id, mission.account_id, human);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mission.status, 'draft');
  assert.ok(!events.includes('dispatch'));
  assert.equal(calls[0].working_dir, PROJECT_FOLDER, 'the orchestrator runs in the mission project folder');
  release();
  await assert.rejects(pending, /credential unavailable/);
  assert.equal(mission.status, 'draft');
  assert.equal(mission.room_id, null);
  assert.equal(mission.runtime_roster, null, 'a failed start leaves no roster behind');
});

test('a member whose host has none of the projects stops the start with a fix-it message', async () => {
  const { runner, mission, members } = fixture(async () => ({ ok: true }));
  mission.status = 'draft';
  mission.room_id = null;
  members[1].spec = { ...members[1].spec, manager_agent_id: 'host-2' };
  await assert.rejects(
    runner.startMission(mission.id, mission.account_id, human),
    (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /reviewer runs on .*no folder registered for any of this mission's projects \(App\)/);
      return true;
    },
  );
  assert.equal(mission.status, 'draft');
});

test('a mission with no project cannot start', async () => {
  const { runner, mission } = fixture(async () => ({ ok: true }));
  mission.status = 'draft';
  mission.room_id = null;
  mission.projects = null;
  await assert.rejects(runner.startMission(mission.id, mission.account_id, human), /names no project/);
});
