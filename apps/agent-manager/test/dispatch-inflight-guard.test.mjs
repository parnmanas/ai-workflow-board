// Regression tests for the provision-spanning single-flight guard (ticket
// 3d180f85): stop a supervisor re-send from twin-spawning the same (ticket,
// role, agent) while the first dispatch is still provisioning/spawning.
//
// These are the REVERIFY of the four review blockers this rework closes:
//   #2 authoritative combine — the guard reserves in the REAL
//      TicketSessionManager._inflight registry (the same pid-checked map the
//      spawn consults), not a parallel process-local map. Every "gate" test
//      below drives the REAL TicketSessionManager (subclassed so only the CLI
//      fork is stubbed) and/or the REAL EventDispatcher.handleTrigger.
//   #1 force-respawn intent — a force_respawn suppressed while a dispatch holds
//      the slot is replayed exactly once on release (real force-respawn seam).
//   #3 real seams — the SIGTERM/reap and strand-drop proofs deliver a REAL
//      SIGTERM to a REAL child process and drive SubagentManager._sweepNow via
//      the #wireExitHandler seam (_trackForTest), per board lesson c555fbb6 —
//      NOT a fake returning spawn_failed and NOT a second call after a clean
//      completion.
//   #4 metric — dispatchSuppressionCounts() feeds the instance-heartbeat field.
//
// Non-vacuous: deleting the gate makes 'concurrent supervisor tick' spawn twice;
// dropping the force replay makes 'force_respawn preserved' spawn once.
//
// Compiled JS — agent-manager builds via `npm run build`; run with
//   node --test test/dispatch-inflight-guard.test.mjs
// against the dist tree, mirroring the other *.test.mjs files here.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { InflightDispatchTracker } from '../dist/lib/dispatch-preflight.js';
import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { TicketSessionManager as RealTicketMgr } from '../dist/lib/ticket-session-manager.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { CircuitBreaker } from '../dist/lib/circuit-breaker.js';

// ─────────────────────────────── helpers ───────────────────────────────

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
    url: 'http://127.0.0.1:0', // never reached — fetch is mocked to fail-closed
    apiKey: 'test-key',
    delegation: {
      enabled: true,
      persistentTicketSessions: true,
      maxConcurrent: 20,
      idleMinutes: 999,
      maxTurnsPerSession: 999,
      ...delegation,
    },
  };
}

// Real dummy child processes so a force-respawn / idle-reap delivers an ACTUAL
// SIGTERM to an ACTUAL process (blocker #3 wants a real signal, not a caught
// throw on a synthetic pid). Tracked + hard-killed in `after` so tests leak none.
const liveChildren = new Set();
function spawnDummyChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}
after(() => {
  for (const c of liveChildren) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  liveChildren.clear();
});

function makeSessionRecord(sessionKey, child) {
  return {
    sessionKey,
    pid: child.pid,
    cli_type: 'test',
    adapter: {
      cliType: 'test',
      formatTurn: (s) => String(s),
      parseStdoutLine: () => ({ stage: null, isResult: false, raw: null }),
      has: () => false,
    },
    child,
    configPath: null,
    configPathIsTemp: false,
    pidPath: null,
    turnCount: 1,
    startedAt: Date.now(),
    lastTouchedAt: Date.now(),
    idleTimer: null,
    unrespondedTurnCount: 0,
    unrespondedSince: null,
    unhealthyKilled: false,
    tap: null,
  };
}

// The REAL TicketSessionManager, with ONLY the CLI fork stubbed. _spawnSession
// forks a real dummy child so its pid is genuinely alive at the OS level (so
// _getLiveSession's real `process.kill(pid,0)` probe sees it) and a real SIGTERM
// actually kills it. Every guard path — _inflight reservation, _getLiveSession
// reuse, dispatchReserved hand-off, force-respawn — is the production code.
class RealTicketMgrStub extends RealTicketMgr {
  constructor(cfg, { spawnGate = null } = {}) {
    super(cfg);
    this.spawnCount = 0;
    this.followUps = [];
    this.spawnGate = spawnGate; // optional deferred to hold a spawn in-flight
  }
  async _spawnSession(sessionKey, _rolePrompt, _firstTurnText, _opts) {
    this.spawnCount++;
    if (this.spawnGate) await this.spawnGate.promise;
    const child = spawnDummyChild();
    const sess = makeSessionRecord(sessionKey, child);
    this._sessions.set(sessionKey, sess);
    return sess;
  }
  _sendFollowUp(sess, turnText, _opts) {
    this.followUps.push({ pid: sess.pid, turnText });
    sess.turnCount++;
    sess.lastTouchedAt = Date.now();
  }
}

function makeDispatcher({ persistent = true, ticketMgr, worktreeManager, subagentManager } = {}) {
  const calls = { spawn: [], comments: [] };
  const wt =
    worktreeManager !== undefined
      ? worktreeManager
      : {
          async resolveCwd() {
            return { isWorktree: true, cwd: '/tmp/wt', reused: false, mode: 'per_ticket' };
          },
          async verifyCheckout() {
            return { ok: true };
          },
          async verifyPushReadiness() {
            return { ok: true };
          },
        };
  const sub =
    subagentManager ??
    {
      canSpawn: () => true,
      async spawn(spec) {
        calls.spawn.push(spec);
        return { spawned: true, pid: 4242 };
      },
    };
  const managedAgentContexts = {
    get(id) {
      if (!id) return undefined;
      return {
        agent_id: id,
        api_key: 'k',
        working_dir: '/tmp/wd',
        mcp_config_path: '/tmp/mcp.json',
        cli: 'claude',
        cli_home_dir: '/tmp/home',
      };
    },
  };
  const tracker = new InflightDispatchTracker();
  const mgr = ticketMgr ?? new RealTicketMgrStub(makeConfig({ persistentTicketSessions: persistent }));
  const config = makeConfig({ persistentTicketSessions: persistent });
  const dispatcher = new EventDispatcher(config, {
    ticketSessionManager: persistent ? mgr : null,
    subagentManager: sub,
    worktreeManager: wt,
    managedAgentContexts,
    inflightDispatchTracker: tracker,
  });
  return { dispatcher, mgr, tracker, calls };
}

function evJson(fields = {}) {
  return JSON.stringify({
    ticket_id: 't1',
    action: 'assignee',
    actor_name: 'a1',
    trigger_source: 'supervisor',
    base_repo: { id: 'r1', url: 'https://example.com/r.git', default_branch: 'main' },
    ...fields,
  });
}

const KEY = (t, r, a) => InflightDispatchTracker.key(t, r, a);

// Fail-closed fetch so handleTrigger's REST helpers (fetchTicketContext,
// fetchRepositoryCredential) resolve to null fast without real network.
let savedFetch;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    async json() {
      return {};
    },
    async text() {
      return '';
    },
  });
});
afterEach(() => {
  globalThis.fetch = savedFetch;
});

// ───────────── Part A: authoritative reservation on the REAL registry ─────────────

test('tryReserveDispatch reserves in the REAL _inflight; a twin is refused, release re-arms', () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  const r1 = mgr.tryReserveDispatch('t', 'assignee', 'a');
  assert.deepEqual(r1, { acquired: true, live: false }, 'free key → reserved (fresh)');

  const r2 = mgr.tryReserveDispatch('t', 'assignee', 'a');
  assert.equal(r2.acquired, false, 'a concurrent same-key trigger is the twin → refused');

  mgr.releaseDispatch('t', 'assignee', 'a');
  const r3 = mgr.tryReserveDispatch('t', 'assignee', 'a');
  assert.deepEqual(r3, { acquired: true, live: false }, 'release re-arms the slot');
});

test('tryReserveDispatch on a LIVE session returns live (reuse, no reservation placed)', async () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  const spec = {
    ticketId: 't',
    role: 'assignee',
    agentId: 'a',
    triggerId: 'trig-1',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'x' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  };
  const d = await mgr.dispatchTrigger(spec);
  assert.equal(d.dispatched, true);
  assert.equal(mgr.spawnCount, 1);

  const r = mgr.tryReserveDispatch('t', 'assignee', 'a');
  assert.deepEqual(r, { acquired: true, live: true }, 'live session → reuse, not a twin');
  // No reservation placed → a follow-up dispatch reuses the same pid.
  const d2 = await mgr.dispatchTrigger({ ...spec, triggerId: 'trig-2' });
  assert.equal(d2.pid, d.pid, 'reuse path — same pid');
  assert.equal(mgr.spawnCount, 1, 'no extra spawn');
});

test('distinct co-holder agentIds reserve independently (다중담당자 fan-out)', () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  assert.equal(mgr.tryReserveDispatch('t', 'assignee', 'agentA').acquired, true);
  assert.equal(mgr.tryReserveDispatch('t', 'assignee', 'agentB').acquired, true);
  // Same holder again → refused; the other holder is untouched.
  assert.equal(mgr.tryReserveDispatch('t', 'assignee', 'agentA').acquired, false);
});

test('dispatchReserved: no self-drop; a mid-flight twin drops as inflight_spawn; dispatcher owns release', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  // The dispatcher reserved the whole provision→spawn window.
  assert.equal(mgr.tryReserveDispatch('t', 'assignee', 'a').acquired, true);

  const spec = {
    ticketId: 't',
    role: 'assignee',
    agentId: 'a',
    triggerId: 'trig-1',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'x' },
    forceRespawn: false,
    dispatchReserved: true, // ← dispatcher owns the reservation
    maxConcurrentTicketsPerAgent: 5,
  };
  // With dispatchReserved, dispatchTrigger must NOT self-drop on our reservation —
  // it advances to _spawnSession and holds there at the gate.
  const pReserved = mgr.dispatchTrigger(spec);

  // While the reserved spawn is still in-flight (session not yet live, but the
  // dispatcher's reservation holds the key), a concurrent NON-reserved trigger
  // for the same key drops as inflight_spawn — the REAL strand-drop seam, not a
  // fake returning spawn_failed.
  const twin = await mgr.dispatchTrigger({ ...spec, triggerId: 'trig-2', dispatchReserved: false });
  assert.equal(twin.dispatched, false);
  assert.equal(twin.reason, 'inflight_spawn', 'real inflight-strand drop while the dispatcher holds the slot');

  gate.resolve();
  const rReserved = await pReserved;
  assert.equal(rReserved.dispatched, true, 'the reserved spawn succeeded (never self-dropped)');
  assert.equal(mgr.spawnCount, 1, 'the twin did not spawn — exactly one');

  // dispatchTrigger did NOT delete the reservation (dispatchReserved) — the
  // dispatcher owns it. Until it releases, the key still reads live (reuse).
  assert.equal(mgr.tryReserveDispatch('t', 'assignee', 'a').live, true);
  mgr.releaseDispatch('t', 'assignee', 'a');
});

// ───────────── Part B: EventDispatcher end-to-end over the REAL registry ─────────────

test('concurrent supervisor tick: two same-key triggers → exactly ONE spawn, one suppressed', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher, tracker } = makeDispatcher({ ticketMgr: mgr });

  const p1 = dispatcher.handleTrigger(evJson()); // reserves synchronously, then holds in _spawnSession
  const p2 = dispatcher.handleTrigger(evJson()); // slot held in the REAL _inflight → suppressed
  await p2;

  assert.equal(tracker.suppressedCount('inflight_dispatch'), 1, 'the twin re-send was suppressed');
  assert.equal(mgr.tryReserveDispatch('t1', 'assignee', 'a1').acquired, false, 'first dispatch still holds the real slot');

  gate.resolve();
  await p1;
  assert.equal(mgr.spawnCount, 1, 'only one spawn reached the session manager');
  // After the surviving dispatch completes, a live session exists → the slot
  // is free for reuse (not wedged).
  assert.equal(mgr.tryReserveDispatch('t1', 'assignee', 'a1').live, true, 'released to a live-reuse state');
});

test('gate releases after a successful dispatch so a later same-key trigger re-enters', async () => {
  const { dispatcher, mgr, tracker } = makeDispatcher();
  await dispatcher.handleTrigger(evJson());
  assert.equal(mgr.spawnCount, 1);
  assert.equal(tracker.suppressedCount(), 0, 'a lone dispatch is never a twin');

  // A sequential re-trigger reuses the live session (follow-up), not suppressed.
  await dispatcher.handleTrigger(evJson({ field_changed: 'trig-2' }));
  assert.equal(mgr.spawnCount, 1, 'reuse — no extra spawn');
  assert.equal(mgr.followUps.length, 1, 'sequential re-trigger became a follow-up turn');
  assert.equal(tracker.suppressedCount(), 0);
});

test('gate releases on circuit_breaker_open (no wedge, no fall-through to one-shot)', async () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  // Force the circuit breaker open for this (agent, ticket, role).
  mgr.circuitBreaker.record(CircuitBreaker.key('a1', 't1', 'assignee'), 1, 'x', { forceOpen: true });
  const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

  await dispatcher.handleTrigger(evJson());
  assert.equal(mgr.spawnCount, 0, 'circuit open → no spawn');
  assert.equal(calls.spawn.length, 0, 'circuit-open does NOT fall back to a one-shot');
  // Slot released → not wedged.
  assert.equal(mgr.tryReserveDispatch('t1', 'assignee', 'a1').acquired, true, 'slot released on the circuit-open exit');
});

test('gate releases on a provisioning abort so a post-recovery retry proceeds', async () => {
  // No worktreeManager → provisioning fails closed and #dispatchTriggerBody
  // aborts before any spawn. The slot must still release.
  const { dispatcher, mgr } = makeDispatcher({ worktreeManager: null });
  await dispatcher.handleTrigger(evJson());
  assert.equal(mgr.spawnCount, 0, 'aborted before spawn');
  assert.equal(mgr.tryReserveDispatch('t1', 'assignee', 'a1').acquired, true, 'slot released on the provisioning-abort path');
});

test('gate releases even when the body throws (finally discipline)', async () => {
  const { dispatcher, mgr } = makeDispatcher({
    worktreeManager: {
      async resolveCwd() {
        return { isWorktree: true, cwd: '/tmp/wt', reused: false, mode: 'per_ticket' };
      },
      async verifyCheckout() {
        return { ok: true };
      },
      async verifyPushReadiness() {
        throw new Error('boom'); // uncaught in the push-readiness gate → propagates
      },
    },
  });
  await assert.rejects(() => dispatcher.handleTrigger(evJson()), /boom/);
  assert.equal(mgr.tryReserveDispatch('t1', 'assignee', 'a1').acquired, true, 'finally released the slot on throw');
});

test('distinct co-holders dispatch concurrently — neither is suppressed', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher, tracker } = makeDispatcher({ ticketMgr: mgr });

  const pA = dispatcher.handleTrigger(evJson({ actor_name: 'agentA' }));
  const pB = dispatcher.handleTrigger(evJson({ actor_name: 'agentB' }));
  // Both hold their own key in the real registry.
  assert.equal(mgr.tryReserveDispatch('t1', 'assignee', 'agentA').acquired, false);
  assert.equal(mgr.tryReserveDispatch('t1', 'assignee', 'agentB').acquired, false);
  assert.equal(tracker.suppressedCount(), 0, 'a distinct co-holder is never a twin');

  gate.resolve();
  await Promise.all([pA, pB]);
  assert.equal(mgr.spawnCount, 2, 'both co-holders spawned');
});

test('metric: dispatchSuppressionCounts() feeds the heartbeat field', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher } = makeDispatcher({ ticketMgr: mgr });

  const p1 = dispatcher.handleTrigger(evJson());
  await dispatcher.handleTrigger(evJson()); // suppressed
  await dispatcher.handleTrigger(evJson()); // suppressed
  assert.deepEqual(dispatcher.dispatchSuppressionCounts(), { inflight_dispatch: 2 });
  gate.resolve();
  await p1;
});

test('no ticket_id → gate is a no-op (never suppresses, never wedges)', async () => {
  const { dispatcher, mgr, tracker } = makeDispatcher();
  await dispatcher.handleTrigger(evJson({ ticket_id: '' }));
  await dispatcher.handleTrigger(evJson({ ticket_id: '' }));
  assert.equal(tracker.suppressedCount(), 0);
  assert.deepEqual(dispatcher.dispatchSuppressionCounts(), {});
  assert.equal(mgr.spawnCount, 0, 'no ticket id → provisioning aborts, but the guard neither suppresses nor leaks');
});

// ───────────── Part B/#1: suppressed force-respawn is preserved (real SIGTERM) ─────────────

test('force_respawn suppressed while a dispatch holds the slot is REPLAYED once (real force-respawn SIGTERM)', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher, tracker } = makeDispatcher({ ticketMgr: mgr });

  // Holder A (normal) reserves + holds inside _spawnSession.
  const pA = dispatcher.handleTrigger(evJson());
  // Force-respawn F arrives while A holds the slot → its fresh-session intent is
  // suppressed here (would be silently lost without blocker #1).
  await dispatcher.handleTrigger(evJson({ force_respawn: true, field_changed: 'trig-force' }));
  assert.equal(tracker.suppressedCount('inflight_dispatch'), 1, 'the force-respawn was suppressed');

  // A finishes → spawns session S_A (real child), releases the slot.
  gate.resolve();
  await pA;
  assert.equal(mgr.spawnCount, 1, 'holder A spawned once');

  // The suppressed force-respawn is now replayed EXACTLY once — it force-respawns
  // the live session: a real SIGTERM kills S_A and a fresh S_B spawns.
  const replayed = await waitFor(() => mgr.spawnCount === 2, { timeoutMs: 4000 });
  assert.equal(replayed, true, 'suppressed force_respawn was replayed → a fresh respawn occurred');
  // Exactly once — no runaway replay loop.
  await delay(150);
  assert.equal(mgr.spawnCount, 2, 'replayed exactly once (burst coalesced)');
});

// ───────────── Part C/#3: REAL SIGTERM/idle-reap seam (board lesson c555fbb6) ─────────────

test('SubagentManager idle-reap: _sweepNow delivers a REAL SIGTERM via #wireExitHandler drop-first — reaped, not counted', async () => {
  const sub = new SubagentManager(makeConfig());
  const child = spawnDummyChild();
  const rec = {
    pid: child.pid,
    kind: 'trigger',
    cli_type: 'claude',
    trigger_id: 'trig-reap',
    chat_request_id: null,
    ticket_id: 'ticket-reap',
    agent_id: 'agent-reap',
    role: 'assignee',
    room_id: null,
    started_at: Date.now() - 60 * 60_000,
    expected_completion_at: Date.now() - 1, // TTL already exceeded → idle-reap
    config_path: null,
    config_path_is_temp: false,
    process_handle: child,
    captureOutput: false,
    outLines: [],
    tailLines: [],
    commentSent: false,
    tap: null,
  };
  // Drive the REAL exit-handler seam (not _handleOneshotExit directly).
  sub._trackForTest(rec);
  assert.equal(isDead(child.pid), false, 'the real child is alive before the sweep');

  sub._sweepNow(); // drop-first delete + real SIGTERM to the real child

  // The real child actually dies from the SIGTERM.
  const died = await waitFor(() => !liveChildren.has(child) || isDead(child.pid), { timeoutMs: 4000 });
  assert.equal(died, true, 'the real child received the SIGTERM and exited');
  // Drop-first means the exit handler early-returns: NOT counted toward the
  // circuit breaker (an idle reap is a manager-initiated kill, not a death).
  assert.equal(sub.circuitBreaker.getOpenBreakers().length, 0, 'idle-reap not counted toward the breaker');
});

function isDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
