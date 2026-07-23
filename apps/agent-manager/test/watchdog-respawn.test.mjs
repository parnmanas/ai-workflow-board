// Unit test — TicketSessionManager watchdog-UNHEALTHY respawn (ticket 54a66701).
//
// Root-cause: a persistent ticket session that goes unresponsive gets SIGTERM'd
// by the health watchdog (`#killUnhealthy` → sess.unhealthyKilled=true, exit
// 143) "for respawn". But `_onChildExit` returned early on `commented` (a
// deliverable persisted by an EARLIER turn) even for exit 143, so the wedged
// session died WITHOUT the fresh session the kill intended — the trigger work
// injected into the wedged child (its last turn) was lost until the server's
// 30-min stale backstop eventually re-fired ~90 min later.
//
// Contract pinned here:
//   1. UNHEALTHY kill + prior deliverable → RESPAWNS (does NOT let `commented`
//      swallow it) and posts NO silent-exit fallback.
//   2. UNHEALTHY kill + no prior deliverable → RESPAWNS (respawn replaces the
//      silent-exit fallback).
//   3. Voluntary post-comment completion (unhealthyKilled=false) → NO respawn,
//      still suppressed — the signal is the KILL CAUSE (unhealthyKilled), not
//      exit code 143. (regression: no spurious re-runs)
//   4. Genuine silent dead-state (unhealthyKilled=false, no comment) → the
//      existing silent-exit fallback still fires and there is NO respawn.
//      (regression)
//   5. Respawn budget carried across respawns is bounded → past the cap we stop
//      respawning and surface the stall (no exit-143 death loop).
//   6. Twin guard: if a concurrent dispatch already fresh-spawned under the same
//      key, the exit handler does NOT spawn a second (twin) session.
//   7. Respawn re-asserts current_task on the fresh session.
//   8. Respawn spawn-fail (null) degrades gracefully to the silent-exit path.
//
// Same seam as silent-exit-fallback.test.mjs: drive `_onChildExit` directly on
// a fake session and observe (a) whether the injected `_fallbackRespawn` closure
// was invoked and (b) whether the `/silent-exit-comment` REST endpoint was hit.
// `globalThis.fetch` is mocked and also answers the MCP handshake so the
// fire-and-forget `set_current_task` tool call can be observed.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TicketSessionManager } from '../dist/lib/ticket-session-manager.js';

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    silentExitVerifyDelayMs: 0, // skip the real grace delay (ticket 2fd06686) in tests
    delegation: {
      enabled: true,
      maxConcurrent: 10,
      idleMinutes: 999,
      maxTurnsPerSession: 999,
    },
  };
}

// A session record shaped like a live persistent ticket session mid-work
// (turn 10, single-model chain, no pending fallback).
function makeFakeSession(pid, overrides = {}) {
  const child = {
    pid,
    stdin: { write: () => true, end: () => {} },
    stdout: null,
    stderr: null,
    once: () => {},
  };
  return {
    sessionKey: 'ticket-wedge:assignee:agent-1',
    pid,
    ticketId: 'ticket-wedge',
    role: 'assignee',
    agentId: 'agent-1',
    cli_type: 'claude',
    adapter: {
      cliType: 'claude',
      formatTurn: (s) => String(s),
      parseStdoutLine: () => ({ stage: null, isResult: false, raw: null }),
    },
    child,
    configPath: null,
    configPathIsTemp: false,
    pidPath: null,
    turnCount: 10,
    startedAt: Date.now(),
    lastTouchedAt: Date.now(),
    idleTimer: null,
    unrespondedTurnCount: 0,
    unrespondedSince: null,
    unhealthyKilled: false,
    chainAttempt: 0,
    modelChain: [null],
    tap: null,
    ...overrides,
  };
}

// Install a `_fallbackRespawn` spy on a session: records each nextAttempt it is
// called with and (by default) returns a fresh session-ish record so the
// caller's post-respawn bookkeeping (unhealthyRespawnCount, set_current_task)
// runs. `returns: null` simulates a failed spawn; `returns: 'throw'` a throw.
function attachRespawnSpy(sess, opts = {}) {
  const state = { calls: [], returned: [] };
  sess._fallbackRespawn = async (nextAttempt) => {
    state.calls.push(nextAttempt);
    if (opts.returns === null) {
      state.returned.push(null);
      return null;
    }
    if (opts.returns === 'throw') throw new Error('spawn boom');
    const fresh = {
      pid: sess.pid + 1000,
      agentId: sess.agentId,
      sessionKey: sess.sessionKey,
      ticketId: sess.ticketId,
      role: sess.role,
    };
    state.returned.push(fresh);
    return fresh;
  };
  return state;
}

function makeAssistantToolUseLine(toolName, input = {}) {
  return {
    stage: 'composing',
    isResult: false,
    isError: false,
    raw: {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: toolName, input }] },
    },
  };
}

async function waitFor(fn, ms = 500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

let originalFetch;
let recordedRequests;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  recordedRequests = [];
  // Answers both the silent-exit REST POST and the MCP tool handshake
  // (initialize must echo an Mcp-Session-Id so callMcpTool proceeds to the
  // tools/call we want to observe for set_current_task).
  globalThis.fetch = async (url, init) => {
    let body = null;
    try {
      body = init?.body ? JSON.parse(init.body) : null;
    } catch {
      body = null;
    }
    recordedRequests.push({ url: String(url), method: init?.method || 'GET', body });
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-sid' },
    });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function findSilentExit() {
  return recordedRequests.find((r) => r.url.endsWith('/silent-exit-comment'));
}
function findToolCall(name) {
  return recordedRequests.find(
    (r) => r.body?.method === 'tools/call' && r.body?.params?.name === name,
  );
}

test('UNHEALTHY kill + prior deliverable → RESPAWNS, does not let `commented` suppress it', async () => {
  const mgr = new TicketSessionManager(makeConfig());
  const sess = makeFakeSession(21001, { unhealthyKilled: true });
  const spy = attachRespawnSpy(sess);
  // A deliverable was persisted by an EARLIER turn of this session…
  mgr._onStdoutParsed(
    sess,
    makeAssistantToolUseLine('mcp__awb__add_comment', { content: 'earlier partial work' }),
    '',
  );
  // …then the watchdog SIGTERM'd the wedged child (exit 143).
  await mgr._onChildExit(sess, 143, 'SIGTERM');

  assert.equal(spy.calls.length, 1, 'a fresh session was respawned despite the prior deliverable');
  assert.equal(spy.calls[0], 0, 'respawn kept the same model-chain index (wedge != model failure)');
  assert.equal(spy.returned[0].unhealthyRespawnCount, 1, 'respawn counter stamped on the fresh session');
  assert.equal(findSilentExit(), undefined, 'no silent-exit fallback on a watchdog respawn');
});

test('UNHEALTHY kill + no prior deliverable → RESPAWNS (respawn replaces silent-exit fallback)', async () => {
  const mgr = new TicketSessionManager(makeConfig());
  const sess = makeFakeSession(21002, { unhealthyKilled: true });
  const spy = attachRespawnSpy(sess);
  mgr._outputRings.set(sess.pid, ['claude: no response', 'watchdog: 30m elapsed']);

  await mgr._onChildExit(sess, 143, 'SIGTERM');

  assert.equal(spy.calls.length, 1, 'respawned the wedged session');
  assert.equal(findSilentExit(), undefined, 'watchdog respawn supersedes the silent-exit fallback');
});

test('regression: voluntary post-comment completion (unhealthyKilled=false, code 0) → NO respawn, suppressed', async () => {
  const mgr = new TicketSessionManager(makeConfig());
  const sess = makeFakeSession(21003, { unhealthyKilled: false });
  const spy = attachRespawnSpy(sess);
  mgr._onStdoutParsed(
    sess,
    makeAssistantToolUseLine('mcp__awb__add_comment', { content: 'work done — moving to Review' }),
    '',
  );

  await mgr._onChildExit(sess, 0, null);

  assert.equal(spy.calls.length, 0, 'a clean voluntary completion must NOT respawn');
  assert.equal(findSilentExit(), undefined, 'deliverable persisted → still suppressed (no fallback)');
});

test('regression: post-hoc crash after a comment (unhealthyKilled=false, code 1) → NO respawn, suppressed', async () => {
  const mgr = new TicketSessionManager(makeConfig());
  const sess = makeFakeSession(21031, { unhealthyKilled: false });
  const spy = attachRespawnSpy(sess);
  mgr._onStdoutParsed(
    sess,
    makeAssistantToolUseLine('mcp__awb__record_decision', { content: 'decided; moving' }),
    '',
  );
  // A non-watchdog SIGTERM (143) after the deliverable landed must NOT trip the
  // respawn — the signal is unhealthyKilled, not the exit code.
  await mgr._onChildExit(sess, 143, 'SIGTERM');

  assert.equal(spy.calls.length, 0, 'exit-143 alone (no unhealthyKilled) must NOT respawn');
  assert.equal(findSilentExit(), undefined, 'post-comment suppression still applies');
});

test('regression: genuine silent dead-state (unhealthyKilled=false, no comment) → silent-exit fallback, NO respawn', async () => {
  const mgr = new TicketSessionManager(makeConfig());
  const sess = makeFakeSession(21004, { unhealthyKilled: false });
  const spy = attachRespawnSpy(sess);
  mgr._outputRings.set(sess.pid, ['fatal: segfault']);

  await mgr._onChildExit(sess, 1, null);

  assert.equal(spy.calls.length, 0, 'a non-watchdog exit must not watchdog-respawn');
  const fb = findSilentExit();
  assert.ok(fb, 'the silent-exit fallback still fires for a genuine dead state');
  assert.equal(fb.body.exit_code, 1);
});

test('death-loop bound: respawn budget exhausted → stops respawning, surfaces the stall', async () => {
  const mgr = new TicketSessionManager(makeConfig());
  // unhealthyRespawnCount already far above any sane cap → the next attempt is
  // refused. (Deliberately not importing the exact constant so the test is
  // decoupled from its value; 99 is guaranteed over the bound.)
  const sess = makeFakeSession(21005, { unhealthyKilled: true, unhealthyRespawnCount: 99 });
  const spy = attachRespawnSpy(sess);
  mgr._outputRings.set(sess.pid, ['wedged again']);

  await mgr._onChildExit(sess, 143, 'SIGTERM');

  assert.equal(spy.calls.length, 0, 'exhausted budget → no further respawn (no exit-143 death loop)');
  const fb = findSilentExit();
  assert.ok(fb, 'exhausted budget surfaces the stall via the silent-exit fallback');
  assert.equal(fb.body.exit_code, 143);
});

test('twin guard: a live replacement already exists → skip respawn (no twin)', async () => {
  const mgr = new TicketSessionManager(makeConfig());
  const sess = makeFakeSession(21006, { unhealthyKilled: true });
  const spy = attachRespawnSpy(sess);
  // A concurrent dispatchTrigger already fresh-spawned under the same key in
  // the window between #killUnhealthy's delete and this exit. process.pid is a
  // guaranteed-alive pid so _getLiveSession returns it as a live replacement.
  const live = makeFakeSession(process.pid, { unhealthyKilled: false });
  live.sessionKey = sess.sessionKey;
  mgr._sessions.set(sess.sessionKey, live);

  await mgr._onChildExit(sess, 143, 'SIGTERM');

  assert.equal(spy.calls.length, 0, 'no respawn when a live replacement already exists');
  assert.equal(findSilentExit(), undefined, 'twin guard returns early — no fallback either');
});

test('respawn re-asserts current_task on the fresh session', async () => {
  const mgr = new TicketSessionManager(makeConfig());
  const sess = makeFakeSession(21007, { unhealthyKilled: true });
  const spy = attachRespawnSpy(sess);

  await mgr._onChildExit(sess, 143, 'SIGTERM');
  assert.equal(spy.calls.length, 1);

  // set_current_task is fire-and-forget through the MCP handshake — poll for it.
  const seen = await waitFor(() => !!findToolCall('set_current_task'));
  assert.ok(seen, 'current_task is re-asserted so the server does not free the cap slot');
  const call = findToolCall('set_current_task');
  assert.equal(call.body.params.arguments.ticket_id, 'ticket-wedge');
  assert.equal(call.body.params.arguments.role, 'assignee');
});

test('graceful degradation: respawn spawn-fail (null) + no comment → falls through to silent-exit', async () => {
  const mgr = new TicketSessionManager(makeConfig());
  const sess = makeFakeSession(21008, { unhealthyKilled: true });
  const spy = attachRespawnSpy(sess, { returns: null });
  mgr._outputRings.set(sess.pid, ['spawn failed']);

  await mgr._onChildExit(sess, 143, 'SIGTERM');

  assert.equal(spy.calls.length, 1, 'respawn was attempted');
  assert.ok(findSilentExit(), 'a failed respawn degrades to the silent-exit fallback');
});
