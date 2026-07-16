// Ticket-session concurrency + seat-release lifecycle (ticket 1fcba693).
//
// Two things the reviewer asked for:
//   • P1 — a MANAGER-inclusive proof that ONE agent runs THREE ticket sessions
//     with OVERLAPPING live windows (not just three SSE triggers arriving): the
//     three sessions are all held mid-spawn simultaneously (no per-agent mutex),
//     then coexist in _sessions; a 4th at cap=3 is dropped.
//   • The three seat-release LEAKS that stranded current_task + the ticket claim
//     until the server sweeps — the root cause of the slow-recovery incident:
//       (b) a respawn / model-fallback child never got the release listener;
//       (c) a session reaped WITHOUT an 'exit' event was purged but not released;
//       (a) SIGTERM / self-update stop() didn't drain the fire-and-forget release
//           POSTs, so process.exit cut them off.
//
// Drives the REAL TicketSessionManager with only the CLI fork stubbed (a real
// dummy child → real pid, real 'exit', safe SIGTERM), mirroring
// dispatch-inflight-guard.test.mjs. MCP tool calls are observed via a fetch mock
// (watchdog-respawn.test.mjs style). Each leak test is DISCRIMINATING: it fails
// against the pre-fix code (delete the fix → no release fires).

import { test, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { TicketSessionManager as RealTicketMgr } from '../dist/lib/ticket-session-manager.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function waitFor(pred, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await delay(stepMs);
  }
  return pred();
}
function makeConfig(delegation = {}) {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    delegation: {
      enabled: true, persistentTicketSessions: true,
      maxConcurrent: 20, idleMinutes: 999, maxTurnsPerSession: 999, ...delegation,
    },
  };
}

const liveChildren = new Set();
function spawnDummyChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: ['pipe', 'ignore', 'ignore'] });
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}
after(() => {
  for (const c of liveChildren) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  liveChildren.clear();
});

function makeSessionRecord(sessionKey, child) {
  return {
    sessionKey, pid: child.pid, cli_type: 'test',
    adapter: { cliType: 'test', formatTurn: (s) => String(s), parseStdoutLine: () => ({ stage: null, isResult: false, raw: null }), has: () => false },
    child, configPath: null, configPathIsTemp: false, pidPath: null,
    turnCount: 1, startedAt: Date.now(), lastTouchedAt: Date.now(),
    idleTimer: null, unrespondedTurnCount: 0, unrespondedSince: null, unhealthyKilled: false, tap: null,
  };
}

class RealTicketMgrStub extends RealTicketMgr {
  constructor(cfg, { spawnGate = null } = {}) {
    super(cfg);
    this.spawnCount = 0;
    this.spawnGate = spawnGate;
  }
  async _spawnSession(sessionKey, _rolePrompt, _firstTurnText, _opts) {
    this.spawnCount++;
    if (this.spawnGate) await this.spawnGate.promise;
    const child = spawnDummyChild();
    const sess = makeSessionRecord(sessionKey, child);
    this._sessions.set(sessionKey, sess);
    return sess;
  }
  _sendFollowUp() {}
}

// ── MCP tool-call observation ───────────────────────────────────────────────
let originalFetch, recordedRequests;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  recordedRequests = [];
  globalThis.fetch = async (url, init) => {
    let body = null;
    try { body = init?.body ? JSON.parse(init.body) : null; } catch { body = null; }
    recordedRequests.push({ url: String(url), method: init?.method || 'GET', body });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-sid' } });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });
function findToolCall(name) {
  return recordedRequests.find((r) => r.body?.method === 'tools/call' && r.body?.params?.name === name);
}
function baseSpec(over) {
  return {
    role: 'assignee', rolePrompt: '', ticketPrompt: '', columnPrompt: null,
    ticket: { title: 'T' }, forceRespawn: false, maxConcurrentTicketsPerAgent: 5, ...over,
  };
}

// ── P1: three overlapping sessions for one agent ────────────────────────────
test('P1: one agent, 3 tickets, cap>=3 → three sessions START concurrently and OVERLAP; a 4th at cap is dropped', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const spec = baseSpec({ agentId: 'solo', maxConcurrentTicketsPerAgent: 3 });

  const dispatches = [1, 2, 3].map((n) =>
    mgr.dispatchTrigger({ ...spec, ticketId: `t${n}`, triggerId: `g${n}`, ticket: { title: `T${n}` } }));

  // Overlap proof: all three reach _spawnSession and are held there together —
  // if a per-agent mutex serialized them, only one would be in-flight at a time.
  await waitFor(() => mgr.spawnCount === 3);
  assert.equal(mgr.spawnCount, 3, 'all three sessions started concurrently (held mid-spawn together — no per-agent serialization)');

  gate.resolve();
  const results = await Promise.all(dispatches);
  assert.equal(results.filter((r) => r.dispatched).length, 3, 'three dispatched');
  assert.equal(mgr._sessions.size, 3, 'three sessions coexist — overlapping live windows');
  const pids = new Set([...mgr._sessions.values()].map((s) => s.pid));
  assert.equal(pids.size, 3, 'three distinct child processes');
  const tickets = [...mgr._sessions.values()].map((s) => s.ticketId).sort();
  assert.deepEqual(tickets, ['t1', 't2', 't3'], 'three distinct tickets, same agent');

  const r4 = await mgr.dispatchTrigger({ ...spec, ticketId: 't4', triggerId: 'g4', ticket: { title: 'T4' } });
  assert.equal(r4.dispatched, false, 'a 4th ticket at cap=3 is dropped');
  assert.equal(r4.reason, 'agent_cap_busy');

  await mgr.stop();
});

// ── Leak (b): respawn child gets the seat-release listener ───────────────────
test('leak b: a model-fallback RESPAWN child’s exit releases the seat (current_task + claim)', async () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  await mgr.dispatchTrigger(baseSpec({ ticketId: 't-b', agentId: 'agent-b', triggerId: 'trig-b' }));
  const initial = mgr._sessions.get('t-b:assignee:agent-b');
  assert.ok(initial?._fallbackRespawn, 'fallback respawn closure attached to the initial child');

  const respawned = await initial._fallbackRespawn(1);
  assert.ok(respawned && respawned.pid !== initial.pid, 'a distinct respawn child was spawned');

  recordedRequests.length = 0;
  respawned.child.kill('SIGKILL'); // the RESPAWN child dies
  await waitFor(() => !!findToolCall('release_ticket'));

  const rel = findToolCall('release_ticket');
  assert.ok(rel, 'respawn child exit RELEASES the ticket claim (leak b fixed)');
  assert.equal(rel.body.params.arguments.ticket_id, 't-b');
  assert.equal(rel.body.params.arguments.agent_id, 'agent-b');
  assert.ok(findToolCall('clear_current_task'), 'respawn child exit clears current_task');

  await mgr.stop();
});

// ── Leak (c): reap-without-exit releases on purge ────────────────────────────
test('leak c: a session reaped WITHOUT an exit event releases the seat when _getLiveSession purges it', async () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  await mgr.dispatchTrigger(baseSpec({ ticketId: 't-c', agentId: 'agent-c', triggerId: 'trig-c' }));
  const key = 't-c:assignee:agent-c';
  const sess = mgr._sessions.get(key);

  // Simulate a reap that Node never surfaced as 'exit': disable the exit
  // listeners (so the exit-closure release can NOT fire), then kill the child so
  // its pid goes dead. The only possible release is now the purge path.
  sess.child.removeAllListeners('exit');
  sess.child.kill('SIGKILL');
  await waitFor(() => !mgr._isPidAlive(sess.pid));

  recordedRequests.length = 0;
  const live = mgr._getLiveSession(key);
  assert.equal(live, undefined, 'reaped session purged from _sessions');
  await waitFor(() => !!findToolCall('release_ticket'));

  const rel = findToolCall('release_ticket');
  assert.ok(rel, 'stale-reap RELEASES the claim on purge (leak c fixed)');
  assert.equal(rel.body.params.arguments.ticket_id, 't-c');
  assert.ok(findToolCall('clear_current_task'), 'stale-reap clears current_task');

  await mgr.stop();
});

// ── Leak (a): stop() drains the seat release before resolving ────────────────
test('leak a: stop() DRAINS the seat release from the session record (survives SIGTERM/self-update)', async () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  await mgr.dispatchTrigger(baseSpec({ ticketId: 't-a', agentId: 'agent-a', triggerId: 'trig-a' }));
  const sess = mgr._sessions.get('t-a:assignee:agent-a');

  // Disable the child-exit slot-release so the ONLY possible release is the
  // stop() drain — this is exactly leak a: a SIGKILL-only child's exit-closure
  // release fires after the grace, un-awaited, and is cut off by process.exit.
  sess.child.removeAllListeners('exit');
  recordedRequests.length = 0;

  await mgr.stop();

  const rel = findToolCall('release_ticket');
  assert.ok(rel, 'stop() drained the claim release with the exit closure disabled (leak a fixed)');
  assert.equal(rel.body.params.arguments.ticket_id, 't-a');
  assert.equal(rel.body.params.arguments.agent_id, 'agent-a');
  assert.ok(findToolCall('clear_current_task'), 'stop() drained the current_task clear');
});
