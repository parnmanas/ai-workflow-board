import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const root = await fs.mkdtemp(join(tmpdir(), 'awb-chat-warmup-'));
process.env.AWB_AGENT_MANAGER_HOME = root;
const { BaseSessionManager } = await import('../dist/lib/base-session-manager.js');
const { ChatSessionManager } = await import('../dist/lib/chat-session-manager.js');
const { createRuntimeAdapterResolver } = await import('../dist/lib/runtime/runtime-registry.js');
const { createAdapter } = await import('../dist/lib/cli-adapters/index.js');
const { RuntimeSupervisor } = await import('../dist/lib/runtime/runtime-supervisor.js');
after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const config = { url: 'http://127.0.0.1:0', apiKey: 'fixture', delegation: { enabled: true, claudeBin: process.execPath, maxConcurrent: 10 } };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('warm restart opens a real idle child and waits for scoped exit cleanup before proceeding', { timeout: 15000 }, async t => {
  const resolver = createRuntimeAdapterResolver();
  const children = [];
  const cleanupStarted = deferred();
  const cleanupDone = deferred();
  let writes = 0;
  class Harness extends BaseSessionManager {
    _writeTurn(...args) { writes++; return super._writeTurn(...args); }
    async _onChildExit(sess) { if (sess.roomId === 'target') { cleanupStarted.resolve(); await cleanupDone.promise; } }
  }
  const manager = new Harness(config, { keyField: 'sessionKey', cfgPrefix: 'warmup-', logTag: '[warmup]', kindLabel: 'chat_session',
    adapterResolver: { ports: resolver.ports, resolve: (...a) => resolver.resolve(...a), buildSession: (...a) => resolver.buildSession(...a),
      shouldRetry: (...a) => resolver.shouldRetry(...a), spawnProcess: () => {
        const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        children.push(child); return child;
      } } });
  t.after(async () => {
    cleanupDone.resolve();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill(); await closed;
    }
    await manager.stop();
  });
  for (const room of ['target', 'another']) {
    const sess = await manager._spawnSession(`${room}|agent`, '', 'must not be submitted', { warmup: true });
    assert.ok(sess); sess.child.ref(); sess.roomId = room; sess.agentId = 'agent';
    assert.equal(sess.turnCount, 0);
    assert.ok(!sess._currentTurn);
  }
  assert.equal(writes, 0, 'warmup never writes a user prompt');
  let finished = false;
  const stopping = manager.stopForRoom('target', 'agent', true).then(() => { finished = true; });
  await cleanupStarted.promise;
  assert.equal(finished, false, 'restart waits for the actual exit hook');
  assert.ok(manager._getSession('another|agent'));
  assert.doesNotThrow(() => process.kill(children[1].pid, 0), 'other room remains alive');
  cleanupDone.resolve();
  await stopping;
  assert.equal(manager._getSession('target|agent'), undefined);
});

test('the first real message after warmup receives preserved room history exactly once', async t => {
  const turns = [];
  let spawnOptions;
  class Harness extends ChatSessionManager {
    async _spawnSession(key, _role, _text, opts) {
      spawnOptions = opts;
      const sess = { sessionKey: key, pid: process.pid, cli_type: 'claude', adapter: createAdapter('claude'), turnCount: 0 };
      this._sessions.set(key, sess);
      return sess;
    }
    _sendFollowUp(_sess, text) { turns.push(text); }
  }
  const manager = new Harness(config);
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  manager.recordRoomMessage({ room_id: 'room', message_id: 'old', sender_type: 'user', sender_id: 'user', sender_name: 'Human', content: 'preserved history' });
  const base = { roomId: 'room', agentId: 'agent', senderId: 'user', senderName: 'Human', agentContext: { cli: 'claude', api_key: 'fixture' } };
  await manager.dispatch({ ...base, messageId: 'warm', content: '', warmup: true });
  assert.equal(spawnOptions.warmup, true);
  assert.equal(turns.length, 0);
  await manager.dispatch({ ...base, messageId: 'real-1', content: 'next actual message' });
  assert.equal(turns.length, 1);
  assert.match(turns[0], /preserved history/);
  assert.match(turns[0], /next actual message/);
  await manager.dispatch({ ...base, messageId: 'real-2', content: 'one more message' });
  assert.equal(turns.length, 2);
  assert.doesNotMatch(turns[1], /preserved history/);
});

test('Hermes reopens only the selected room and prepareOnly never prompts the agent', async t => {
  const events = [];
  const supervisor = new RuntimeSupervisor({ rootDir: join(root, 'hermes'), command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url))], awbUrl: config.url,
    onEvent: event => events.push(event) });
  t.after(() => supervisor.stopAll());
  const request = { agentId: 'shared-agent', runId: 'chat:target', leaseId: 'lease', cwd: process.cwd(), apiKey: 'fixture',
    runtimeId: 'hermes', runtimeConfig: { strategy: 'single', permission_mode: 'trusted' }, task: '', prepareOnly: true };
  const target = await supervisor.dispatch(request);
  const other = await supervisor.dispatch({ ...request, runId: 'chat:other' });
  assert.equal(target.stopReason, 'ready');
  assert.equal(events.length, 0);
  assert.equal(await supervisor.closeRuns('shared-agent', ['chat:target']), 1);
  const reopened = await supervisor.dispatch(request);
  assert.notEqual(reopened.sessionId, target.sessionId);
  assert.equal(supervisor.getSession('shared-agent', 'chat:other').sessionId, other.sessionId);
  const result = await supervisor.dispatch({ ...request, prepareOnly: false, task: 'first actual message' });
  assert.equal(result.sessionId, reopened.sessionId);
  assert.equal(result.stopReason, 'end_turn');
});
