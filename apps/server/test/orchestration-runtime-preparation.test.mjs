import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestrationRunnerService } from '../dist/modules/orchestration/orchestration-runner.service.js';
import { runtimeIdentityKey } from '../dist/common/runtime-spec.js';

const spec = (dir) => ({ manager_agent_id: 'host-1', cli: 'claude', working_dir: dir,
  folder_scope: 'shared', credential_id: 'credential-1', model: null, runtime_config: { strategy: 'single', permission_mode: 'approve' } });

function fixture(provision) {
  const orch = spec('/orch');
  const member = spec('/member');
  const team = { id: 'team', name: 'Team', enabled: 1,
    orchestrator_agent_id: runtimeIdentityKey(orch), orchestrator_spec: orch };
  const mission = { id: 'mission', account_id: 'account', team_id: team.id, status: 'failed',
    room_id: 'room', orchestrator_agent_id: team.orchestrator_agent_id, orchestrator_spec: orch,
    finished_at: new Date(), failure_reason: 'auth', result_summary: 'previous result',
    excluded_member_ids: [], extra_member_specs: [] };
  const members = [
    { agent_id: runtimeIdentityKey(member), spec: member, role_label: 'builder' },
    { agent_id: runtimeIdentityKey(member), spec: member, role_label: 'reviewer' },
  ];
  const events = [];
  const runner = new OrchestrationRunnerService(
    { save: async () => { events.push('save'); } }, {}, { findOne: async () => team },
    { find: async () => members }, {}, {}, {}, {}, {}, {},
    { requireMission: async () => mission, listSteps: async () => [], recordEvent: async () => {} },
    {}, {}, { warn() {} }, undefined, undefined, undefined,
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
  assert.deepEqual(events, []);
  assert.equal(calls.length, 2, 'same identity in two slots is restarted once');
  assert.ok(calls.every(({ opts }) => opts.restart && opts.waitForAckMs > 0));
  release();
  await result;
  assert.equal(mission.status, 'running');
  assert.equal(mission.result_summary, 'previous result');
  assert.deepEqual(events, ['save', 'dispatch']);
});

test('failed credential preparation leaves the mission terminal and sends no wake', async () => {
  const { runner, mission, events } = fixture(async () => ({ ok: false, reason: 'credential unavailable' }));
  await assert.rejects(runner.reopenMission(mission.id, mission.account_id, human), /credential unavailable/);
  assert.equal(mission.status, 'failed');
  assert.equal(mission.failure_reason, 'auth');
  assert.deepEqual(events, []);
});

test('initial preparation awaits hosts without requesting a process restart', async () => {
  const calls = [];
  const { runner, mission, team } = fixture(async (runtime, opts) => {
    calls.push(opts);
    return { ok: true };
  });
  await runner.provisionMissionRoster(mission, team);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((opts) => !opts.restart && opts.waitForAckMs === 30_000));
});

test('an MCP reopen keeps its calling orchestrator alive while restarting members', async () => {
  const calls = [];
  const { runner, mission } = fixture(async (runtime, opts) => {
    calls.push({ runtime, opts });
    return { ok: true };
  });
  runner.requireOrchestrator = () => {};
  await runner.reopenMission(mission.id, mission.account_id, {
    type: 'agent', id: mission.orchestrator_agent_id, runtimeKey: mission.orchestrator_agent_id,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runtime.working_dir, '/member');
  assert.equal(calls[0].opts.restart, true);
});

test('first start waits for authentication before creating a room or changing draft status', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { runner, mission, team, events } = fixture(async (runtime) => {
    calls.push(runtime);
    await barrier;
    return { ok: false, reason: 'credential unavailable' };
  });
  mission.status = 'draft';
  mission.room_id = null;
  // A previous failed start can leave a snapshot; a new start uses the current team.
  mission.orchestrator_spec = spec('/old-orchestrator');
  runner.missionProject = async () => null;
  runner.buildRosterForMission = async () => [{ agent_id: 'member' }];
  const pending = runner.startMission(mission.id, mission.account_id, human);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mission.status, 'draft');
  assert.deepEqual(events, []);
  assert.equal(calls[0].working_dir, team.orchestrator_spec.working_dir);
  release();
  await assert.rejects(pending, /credential unavailable/);
  assert.equal(mission.status, 'draft');
  assert.equal(mission.room_id, null);
});
