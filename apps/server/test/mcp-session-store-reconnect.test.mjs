// Behavioural regression — ticket 3960f036 (MCP McpServer orphan leak).
//
// Root cause: McpController kept a standalone `agentId → McpServer` map for
// push notifications, separate from the per-session `sessionStore`. Keyed by
// the stable agentId, it was overwritten on every reconnect and only deleted
// on close when no other session for the agent remained. An out-of-order close
// (a reconnect's session closing BEFORE the session it replaced) left the map
// pinning an already-closed McpServer — an orphan that could never be GC'd,
// plus a dead push target. Each orphan retained all 79 registered tool closures.
//
// Fix: drop the duplicate map; derive the push-target server on demand from
// the live session set via SessionStore.getLatestServerForAgent(). With no
// second source of truth, the only McpServer references are the per-session
// store entries, which are freed unconditionally on close/eviction/cleanup —
// so storage converges to the active-session count by construction.
//
// This test drives SessionStore directly (a dependency-free singleton) with
// fake transports/servers, exercising the exact reconnect loop the ticket
// calls for: same agentId, sessions closed out of order, asserting the store
// size converges and a CLOSED session's server is never returned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadSessionStore() {
  const distRoot = path.join(__dirname, '..', 'dist');
  const url = 'file://' + path.join(distRoot, 'modules', 'mcp', 'internal', 'session-store.js');
  try {
    return await import(url);
  } catch (err) {
    throw new Error(
      'This test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' + err.message,
    );
  }
}

// Minimal stand-ins. SessionStore only stores these by reference (identity) and
// calls transport.close() during TTL/LRU eviction — paths this test does not
// trigger, since it models the controller's onclose → sessionStore.remove().
let seq = 0;
function fakeTransport() {
  return { close: async () => {} };
}
function fakeServer() {
  return { __id: `server-${++seq}` };
}

// Date.now() has ~1ms resolution; back-to-back register() calls can land in the
// same millisecond. Await a real tick when a test needs lastActivity to advance
// so "most-recently-active" ordering is deterministic rather than tie-broken.
const tick = () => new Promise((r) => setTimeout(r, 2));

test('getLatestServerForAgent returns the newest LIVE session, never a closed one', async () => {
  const { sessionStore } = await loadSessionStore();
  const agent = `agent-${++seq}`;
  const base = sessionStore.size;

  const srv1 = fakeServer();
  sessionStore.register('s1', fakeTransport(), srv1, { agentId: agent, source: 'db' });
  await tick();
  const srv2 = fakeServer();
  sessionStore.register('s2', fakeTransport(), srv2, { agentId: agent, source: 'db' });

  // Reconnect overlap: both sessions live, newest (s2) is the push target.
  assert.equal(sessionStore.size, base + 2);
  assert.equal(sessionStore.getLatestServerForAgent(agent), srv2);

  // Out-of-order close: the NEWER session (s2) closes first. The old agentId
  // map would have kept returning the now-closed srv2; the derived lookup must
  // fall back to the still-live s1.
  sessionStore.remove('s2');
  assert.equal(sessionStore.size, base + 1);
  const afterClose = sessionStore.getLatestServerForAgent(agent);
  assert.equal(afterClose, srv1, 'must return the live session server');
  assert.notEqual(afterClose, srv2, 'must NEVER return the closed session server (the orphan-leak bug)');

  // Last session closes → no live server, nothing pinned.
  sessionStore.remove('s1');
  assert.equal(sessionStore.size, base);
  assert.equal(sessionStore.getLatestServerForAgent(agent), undefined);
});

test('repeated same-agentId reconnect loop converges to the active-session count', async () => {
  const { sessionStore } = await loadSessionStore();
  const agent = `agent-${++seq}`;
  const base = sessionStore.size;

  // Flaky-reconnect loop: each iteration opens a fresh session for the SAME
  // agent and closes the previous one. The store must stay at exactly one live
  // session for this agent the whole way through — never growing per reconnect,
  // which is the monotonic McpServer growth the ticket reported.
  let prev = null;
  let prevServer = null;
  for (let i = 0; i < 100; i++) {
    const sid = `loop-${i}`;
    const server = fakeServer();
    sessionStore.register(sid, fakeTransport(), server, { agentId: agent, source: 'db' });
    if (prev) sessionStore.remove(prev);
    // Exactly one live session for this agent at every step.
    assert.equal(sessionStore.size, base + 1, `iteration ${i}: store must hold one live session`);
    assert.equal(sessionStore.getLatestServerForAgent(agent), server, `iteration ${i}: latest server is the live one`);
    prev = sid;
    prevServer = server;
  }

  // Close the final live session — converges back to baseline, no residue.
  sessionStore.remove(prev);
  assert.equal(sessionStore.size, base);
  assert.equal(sessionStore.getLatestServerForAgent(agent), undefined);
  assert.ok(prevServer, 'sanity: loop ran');
});

test('most-recently-active live session wins; other agents are ignored', async () => {
  const { sessionStore } = await loadSessionStore();
  const agentA = `agent-${++seq}`;
  const agentB = `agent-${++seq}`;
  const base = sessionStore.size;

  const a1 = fakeServer();
  sessionStore.register('a1', fakeTransport(), a1, { agentId: agentA, source: 'db' });
  await tick();
  const a2 = fakeServer();
  sessionStore.register('a2', fakeTransport(), a2, { agentId: agentA, source: 'db' });
  const b1 = fakeServer();
  sessionStore.register('b1', fakeTransport(), b1, { agentId: agentB, source: 'db' });

  assert.equal(sessionStore.getLatestServerForAgent(agentA), a2, 'newest A session');
  assert.equal(sessionStore.getLatestServerForAgent(agentB), b1, 'B unaffected by A');

  // Touch the older A session so it becomes the most-recently-active; the
  // lookup must follow activity, not insertion order.
  await tick();
  sessionStore.touch('a1');
  assert.equal(sessionStore.getLatestServerForAgent(agentA), a1, 'follows lastActivity');

  // Unknown agent → undefined.
  assert.equal(sessionStore.getLatestServerForAgent(`nobody-${seq}`), undefined);

  sessionStore.remove('a1');
  sessionStore.remove('a2');
  sessionStore.remove('b1');
  assert.equal(sessionStore.size, base);
});
