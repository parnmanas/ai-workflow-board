import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSessionsService } from '../dist/modules/agent-sessions/agent-sessions.service.js';

// Exercise the real read/reconciliation methods while controlling the transport.
// No timers: races in the same millisecond must be protected as well.
const sid = 'session-read-race';
const row = { session_id: sid, cwd: '/repo', title: 'Race' };
function setup() {
  const service = Object.create(AgentSessionsService.prototype);
  Object.assign(service, {
    live: new Map(), liveRevision: 0, awaiting: new Map(), mcpRefs: new Map(), hostNames: new Map([['host', 'Host']]),
    requireHost: () => ({ hostname: 'Host' }), managerName: async () => 'Host',
    dataSource: { getRepository: () => ({ find: async () => [] }) },
    logService: { info() {} },
  });
  service.emitUpdate = (state) => service.snapshot(state);
  let resolveRpc;
  service.rpc = () => new Promise((resolve) => { resolveRpc = resolve; });
  const seed = (status) => service.createState('host', 'Host', 'codex', sid, { cwd: '/repo', title: 'Race', status, driver_user_id: 'user' });
  const patch = (status) => service.applyState('host', 'codex', sid, { status });
  return { service, seed, patch, respond: (value) => resolveRpc(value) };
}

for (const op of ['history', 'list']) {
  const start = (s) => op === 'history'
    ? s.getSession('account', 'user', 'host', 'codex', sid)
    : s.listSessions('account', 'user', 'host', 'codex');
  const response = (status) => op === 'history'
    ? { session: row, events: [], live: status ? { status, resume_supported: true } : null }
    : { sessions: [{ ...row, ...(status ? { live_status: status } : {}) }] };
  const statusOf = (result) => op === 'history' ? result.live.status : result[0].live_status;

  for (const [old, current] of [['ready', 'busy'], ['busy', 'ready'], ['ready', 'awaiting_permission'], ['busy', 'closed']]) {
    test(`${op}: late ${old} snapshot cannot replace newer ${current} in the same millisecond`, async (t) => {
      t.mock.method(Date, 'now', () => 1792050000000);
      const f = setup(); f.seed(old);
      const pending = start(f.service);
      f.patch(current);
      f.respond(response(old));
      assert.equal(statusOf(await pending), current);
      assert.equal(f.service.liveSnapshot('host', 'codex', sid).status, current);
    });
  }

  test(`${op}: state first observed during the RPC survives a stale missing-process response`, async () => {
    const f = setup(); const pending = start(f.service);
    f.patch('busy'); f.respond(response(null));
    assert.equal(statusOf(await pending), 'busy');
  });

  test(`${op}: unchanged ghost state still reconciles to the manager`, async () => {
    const f = setup(); f.seed('busy'); const pending = start(f.service);
    f.respond(response(null)); assert.equal(statusOf(await pending), 'idle');
  });

  test(`${op}: another session's activity does not prevent reconciliation`, async () => {
    const f = setup(); f.seed('busy'); const pending = start(f.service);
    f.service.applyState('host', 'codex', 'another-session', { status: 'busy' });
    f.respond(response('ready')); assert.equal(statusOf(await pending), 'ready');
  });

  test(`${op}: an unchanged busy heartbeat supersedes an older ready read`, async () => {
    const f = setup(); f.seed('busy'); const pending = start(f.service);
    f.service.reconcileWithHeartbeat('host', [{ cli: 'codex', session_id: sid, status: 'busy' }]);
    f.respond(response('ready')); assert.equal(statusOf(await pending), 'busy');
  });
}

test('history seed does not overwrite an event received while resolving the host name', async () => {
  const f = setup();
  let finishName;
  f.service.managerName = () => new Promise((resolve) => { finishName = resolve; });
  const pending = f.service.getSession('account', 'user', 'host', 'codex', sid);
  f.respond({ session: row, events: [], live: { status: 'ready' } });
  await Promise.resolve();
  assert.ok(finishName);
  f.patch('busy'); finishName('Host');
  assert.equal((await pending).live.status, 'busy');
});

test('list protects activity received while loading ownership after the RPC returns', async () => {
  const f = setup(); f.seed('ready');
  let finishOwners;
  f.service.dataSource.getRepository = () => ({ find: () => new Promise((resolve) => { finishOwners = resolve; }) });
  const pending = f.service.listSessions('account', 'user', 'host', 'codex');
  f.respond({ sessions: [{ ...row, live_status: 'ready' }] });
  await Promise.resolve();
  assert.ok(finishOwners);
  f.patch('busy'); finishOwners([]);
  assert.equal((await pending)[0].live_status, 'busy');
});

const observation = (status, stateSeq, extra = {}) => ({ status, state_id: 'process-1', state_seq: stateSeq, turn_id: 'turn-1', ...extra });
const heartbeat = (service, patch) => service.reconcileWithHeartbeat('host', [{ cli: 'codex', session_id: sid, ...patch }]);

for (const [old, current] of [['ready', 'busy'], ['busy', 'ready'], ['busy', 'awaiting_permission'], ['busy', 'error']]) {
  test(`an older ${old} heartbeat cannot rewind the published ${current} state`, () => {
    const f = setup(); f.seed(old);
    f.service.applyState('host', 'codex', sid, observation(current, 3));
    assert.equal(heartbeat(f.service, observation(old, 2)), 0);
    assert.equal(f.service.liveSnapshot('host', 'codex', sid).status, current);
    const late = f.service.applyState('host', 'codex', sid, observation(old, 1));
    assert.equal(late.status, current, 'late event patches use the same ordering');
  });
}

test('a heartbeat preceding the identical event patch does not discard error details', () => {
  const f = setup(); f.seed('busy');
  heartbeat(f.service, observation('error', 3));
  const live = f.service.applyState('host', 'codex', sid, observation('error', 3, { last_error: 'Provider unavailable' }));
  assert.equal(live.status, 'error');
  assert.equal(live.last_error, 'Provider unavailable');
});

test('a reopened process starts a new sequence and delayed reports from the retired process are ignored', () => {
  const f = setup(); f.seed('busy');
  heartbeat(f.service, observation('busy', 20));
  f.service.applyState('host', 'codex', sid, observation('ready', 1, { state_id: 'process-2' }));
  heartbeat(f.service, observation('busy', 21));
  assert.equal(f.service.liveSnapshot('host', 'codex', sid).status, 'ready');
  heartbeat(f.service, observation('busy', 2, { state_id: 'process-2' }));
  assert.equal(f.service.liveSnapshot('host', 'codex', sid).status, 'busy');
});

test('the previous turn cannot clear a newly dispatched prompt before the manager accepts it', async () => {
  const f = setup(); f.seed('ready');
  heartbeat(f.service, observation('ready', 5));
  f.service.executionFor = async () => ({ account_id: 'account' });
  f.service.emitRequest = () => {};
  const prompt = await f.service.prompt('account', 'user', 'host', 'codex', sid, 'continue');
  heartbeat(f.service, observation('ready', 5));
  assert.equal(f.service.liveSnapshot('host', 'codex', sid).status, 'busy');
  heartbeat(f.service, observation('busy', 6, { turn_id: prompt.turn_id }));
  heartbeat(f.service, observation('ready', 7, { turn_id: prompt.turn_id }));
  assert.equal(f.service.liveSnapshot('host', 'codex', sid).status, 'ready');
  heartbeat(f.service, observation('busy', 6, { turn_id: prompt.turn_id }));
  assert.equal(f.service.liveSnapshot('host', 'codex', sid).status, 'ready');
});

test('a lost prompt recovers after its dispatch grace even if the manager sequence has not changed', async (t) => {
  let now = 1792050000000;
  t.mock.method(Date, 'now', () => now);
  const f = setup(); f.seed('ready');
  heartbeat(f.service, observation('ready', 5));
  f.service.executionFor = async () => ({ account_id: 'account' });
  f.service.emitRequest = () => {};
  await f.service.prompt('account', 'user', 'host', 'codex', sid, 'continue');
  now += 120_001;
  heartbeat(f.service, observation('ready', 5));
  assert.equal(f.service.liveSnapshot('host', 'codex', sid).status, 'ready');
});

test('listing after server restart seeds live state and reattaches a sidebar viewer for subsequent updates', async () => {
  const f = setup();
  const updates = [];
  f.service.emitUpdate = (state) => { const live = f.service.snapshot(state); updates.push(live); return live; };
  const pending = f.service.listSessions('account', 'user', 'host', 'codex');
  f.respond({ sessions: [{ ...row, live_status: 'busy', ...observation('busy', 3) }] });
  assert.equal((await pending)[0].live_status, 'busy');
  assert.equal(updates.at(-1).driver_user_id, 'user');
  heartbeat(f.service, observation('ready', 4));
  assert.equal(updates.at(-1).status, 'ready');
  assert.equal(updates.at(-1).driver_user_id, 'user');
  heartbeat(f.service, observation('busy', 2));
  assert.equal(updates.at(-1).status, 'ready');
});

test('listing does not take the driver from a different viewer', async () => {
  const f = setup(); const state = f.seed('ready'); state.driver_user_id = 'other-user';
  const pending = f.service.listSessions('account', 'user', 'host', 'codex');
  f.respond({ sessions: [{ ...row, live_status: 'ready' }] });
  await pending;
  assert.equal(f.service.liveSnapshot('host', 'codex', sid).driver_user_id, 'other-user');
});

test('list seed cannot overwrite a newer event arriving during host-name lookup', async () => {
  const f = setup();
  let finishName;
  f.service.managerName = () => new Promise((resolve) => { finishName = resolve; });
  const pending = f.service.listSessions('account', 'user', 'host', 'codex');
  f.respond({ sessions: [{ ...row, live_status: 'ready', ...observation('ready', 1) }] });
  for (let i = 0; i < 5 && !finishName; i++) await Promise.resolve();
  assert.ok(finishName);
  f.patch('busy'); finishName('Host');
  assert.equal((await pending)[0].live_status, 'busy');
});

for (const source of ['heartbeat', 'offline']) {
  test(`${source}: a missing process clears ready as well as active states`, () => {
    const f = setup(); f.seed('ready');
    assert.equal(source === 'heartbeat' ? f.service.reconcileWithHeartbeat('host', []) : f.service.markHostOffline('host'), 1);
    assert.equal(f.service.liveSnapshot('host', 'codex', sid).status, 'idle');
  });
}

test('browser snapshot timestamps strictly advance for transitions within a millisecond', (t) => {
  t.mock.method(Date, 'now', () => 1792050000000);
  const f = setup(); f.seed('ready');
  const busy = f.patch('busy');
  const ready = f.patch('ready');
  assert.ok(Date.parse(ready.updated_at) > Date.parse(busy.updated_at));
});
