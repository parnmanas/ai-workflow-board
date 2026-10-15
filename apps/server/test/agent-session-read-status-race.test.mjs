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
