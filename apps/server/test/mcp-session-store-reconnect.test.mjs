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
// Fix: drop both the duplicate map and the MCP execution-push resolver.
// Runtime Host SSE is the sole execution delivery path; MCP servers remain
// reachable only by their tool-session id and are freed unconditionally on
// close/eviction/cleanup.
//
// This test drives SessionStore directly (a dependency-free singleton) with
// fake transports/servers, exercising the exact reconnect loop the ticket
// calls for: same agentId, sessions closed out of order, asserting the store
// size converges and a CLOSED session's server is no longer addressable.

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

test('removing a reconnect session makes its McpServer unreachable', async () => {
  const { sessionStore } = await loadSessionStore();
  const agent = `agent-${++seq}`;
  const base = sessionStore.size;

  const srv1 = fakeServer();
  sessionStore.register('s1', fakeTransport(), srv1, { agentId: agent, source: 'db' });
  const srv2 = fakeServer();
  sessionStore.register('s2', fakeTransport(), srv2, { agentId: agent, source: 'db' });

  // Reconnect overlap: each server is reachable only through its own session.
  assert.equal(sessionStore.size, base + 2);
  assert.equal(sessionStore.get('s1')?.server, srv1);
  assert.equal(sessionStore.get('s2')?.server, srv2);

  // Out-of-order close: the newer session closes first. No Agent-level lookup
  // remains that could keep returning or pinning its now-closed server.
  sessionStore.remove('s2');
  assert.equal(sessionStore.size, base + 1);
  assert.equal(sessionStore.get('s2'), undefined);
  assert.equal(sessionStore.get('s1')?.server, srv1);
  assert.equal(sessionStore.hasAgentSession(agent), true);

  // Last session closes → no live server, nothing pinned.
  sessionStore.remove('s1');
  assert.equal(sessionStore.size, base);
  assert.equal(sessionStore.hasAgentSession(agent), false);
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
    assert.equal(sessionStore.get(sid)?.server, server, `iteration ${i}: current session is live`);
    if (prev) assert.equal(sessionStore.get(prev), undefined, `iteration ${i}: prior session was removed`);
    prev = sid;
    prevServer = server;
  }

  // Close the final live session — converges back to baseline, no residue.
  sessionStore.remove(prev);
  assert.equal(sessionStore.size, base);
  assert.equal(sessionStore.hasAgentSession(agent), false);
  assert.ok(prevServer, 'sanity: loop ran');
});

test('agent-presence helpers remain scoped across overlapping tool sessions', async () => {
  const { sessionStore } = await loadSessionStore();
  const agentA = `agent-${++seq}`;
  const agentB = `agent-${++seq}`;
  const base = sessionStore.size;

  const a1 = fakeServer();
  sessionStore.register('a1', fakeTransport(), a1, { agentId: agentA, source: 'db' });
  const a2 = fakeServer();
  sessionStore.register('a2', fakeTransport(), a2, { agentId: agentA, source: 'db' });
  const b1 = fakeServer();
  sessionStore.register('b1', fakeTransport(), b1, { agentId: agentB, source: 'db' });

  assert.equal(sessionStore.hasAgentSession(agentA), true);
  assert.equal(sessionStore.hasAgentSession(agentB), true);
  assert.equal(sessionStore.hasAgentSession(`nobody-${seq}`), false);
  assert.equal(sessionStore.distinctAgentCount(), 2);

  sessionStore.remove('a1');
  sessionStore.remove('a2');
  assert.equal(sessionStore.hasAgentSession(agentA), false);
  assert.equal(sessionStore.hasAgentSession(agentB), true);
  sessionStore.remove('b1');
  assert.equal(sessionStore.size, base);
});
