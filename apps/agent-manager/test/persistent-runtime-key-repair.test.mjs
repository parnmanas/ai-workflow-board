import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TicketSessionManager } from '../dist/lib/ticket-session-manager.js';
import { ChatSessionManager } from '../dist/lib/chat-session-manager.js';

for (const [kind, Base] of [['ticket', TicketSessionManager], ['chat', ChatSessionManager]]) {
  test(`${kind} session respawns after key repair and reuses unchanged credentials`, async t => {
    const signals = [];
    t.mock.method(process, 'kill', (pid, signal) => { signals.push([pid, signal]); return true; });
    t.mock.method(globalThis, 'fetch', async () => new Response('[]', {
      status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' },
    }));
    class Manager extends Base {
      spawned = [];
      followups = [];
      _isPidAlive() { return true; }
      async _spawnSession(sessionKey, _rolePrompt, _text, options) {
        const child = new EventEmitter();
        child.stdin = { end() {} };
        const sess = {
          sessionKey, pid: 900000 + this.spawned.length, child,
          cli_type: 'claude', adapter: { has: () => false },
          turnCount: 1, startedAt: Date.now(), lastTouchedAt: Date.now(), idleTimer: null,
        };
        this._sessions.set(sessionKey, sess);
        this.spawned.push({ sess, key: options.agentContext.api_key });
        return sess;
      }
      _sendFollowUp(sess) { this.followups.push(sess.pid); }
    }
    const manager = new Manager({
      url: 'http://awb.invalid', apiKey: 'manager-key',
      delegation: { enabled: true, maxConcurrent: 10, idleMinutes: 999 },
    });
    const dispatch = (key, turn) => {
      const agentContext = { api_key: key, cli: 'claude' };
      return kind === 'ticket'
        ? manager.dispatchTrigger({ ticketId: 'ticket', role: 'assignee', ticket: { title: 'Test' }, triggerId: `turn-${turn}`, agentContext })
        : manager.dispatch({ roomId: 'room', messageId: `turn-${turn}`, content: 'Continue', agentContext });
    };
    const first = await dispatch('old-key', 1);
    const same = await dispatch('old-key', 2);
    assert.equal(same.pid, first.pid);
    assert.equal(manager.spawned.length, 1);
    const repaired = await dispatch('new-key', 3);
    assert.equal(repaired.dispatched, true);
    assert.notEqual(repaired.pid, first.pid);
    assert.deepEqual(manager.spawned.map(s => s.key), ['old-key', 'new-key']);
    assert.deepEqual(manager.followups, [first.pid], 'no follow-up reaches the revoked-key child');
    assert.ok(signals.some(([pid, signal]) => pid === first.pid && signal === 'SIGTERM'));
    assert.equal(manager.spawned[0].sess.stopReason, 'credential_rotation');
    assert.equal(manager.spawned[1].sess._effectiveApiKey, 'new-key');
    assert.equal((await dispatch('new-key', 4)).pid, repaired.pid);
    manager._sessions.clear();
  });
}

test('rotated chat child exits without failing its replacement run or posting stale output', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' },
    });
  });
  const manager = new ChatSessionManager({ url: 'http://awb.invalid', apiKey: 'manager-key' });
  let released = 0;
  const old = {
    pid: 900000, sessionKey: 'room:agent', roomId: 'room', agentId: 'agent',
    stopReason: 'credential_rotation', turnCount: 1, _effectiveApiKey: 'revoked-key',
    _run: { kind: 'action', run_id: 'run', account_id: 'account' },
    releaseRunLock: () => { released++; },
  };
  const replacement = { ...old, pid: 900001, _effectiveApiKey: 'repaired-key', stopReason: undefined };
  manager._sessions.set(old.sessionKey, replacement);
  manager._collectOutputTail = () => 'Invalid API key';
  await manager._onChildExit(old, null, 'SIGTERM');
  assert.equal(released, 1, 'old child still releases its lifecycle resources');
  assert.equal(manager._sessions.get(old.sessionKey), replacement);
  assert.equal(requests.some(r => r.body?.method === 'tools/call'), false,
    'the old child must not complete the continuing run as failed');
  assert.equal(requests.some(r => /\/messages$/.test(r.url)), false,
    'the old child must not post a fallback message from its stale output');
  manager._sessions.clear();
});
