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
// replaying the HOLDER's identity instead of the suppressed force's own payload
// (the pre-fix bug the reviewer caught) makes the holder-H/force-F replay drop as
// duplicate_trigger, spawning once instead of twice.
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

test('holder(field_changed=H) + suppressed force(field_changed=F): replay carries the FORCE identity → real SIGTERM, spawnCount 2', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher, tracker } = makeDispatcher({ ticketMgr: mgr });

  // Holder H carries a REAL trigger identity (field_changed=H), so its dispatch
  // records `trigger:H` in the dedup set — kept until child exit, NOT cleared on
  // a successful spawn. THIS is the case the reviewer flagged: the pre-fix replay
  // reused the holder's own raw, so it re-entered as `trigger:H`, hit the
  // remembered dedup entry, and dropped as duplicate_trigger — the fresh-session
  // intent silently lost. (The old test used a holder with no field_changed, so
  // `trigger:H` was never remembered and the bug never surfaced — vacuous.)
  const pH = dispatcher.handleTrigger(evJson({ field_changed: 'trig-holder-H' }));
  // Force-respawn F with a DISTINCT identity (field_changed=F) arrives while H
  // holds the slot → suppressed here, its OWN payload captured for the replay.
  await dispatcher.handleTrigger(evJson({ force_respawn: true, field_changed: 'trig-force-F' }));
  assert.equal(tracker.suppressedCount('inflight_dispatch'), 1, 'the force-respawn was suppressed');

  // H finishes → spawns session S_H (real child), releases the slot.
  gate.resolve();
  await pH;
  assert.equal(mgr.spawnCount, 1, 'holder H spawned once');
  const sH = mgr._getLiveSession(KEY('t1', 'assignee', 'a1'));
  assert.ok(sH, 'holder session is live after H completes');

  // The suppressed force replays with F's OWN (never-dispatched, so un-deduped)
  // identity → it force-respawns the live session: a REAL SIGTERM kills S_H and a
  // fresh S_F spawns. With the pre-fix holder-identity replay this stays at 1
  // (dropped as duplicate_trigger) — so this pair of assertions is the
  // non-vacuous regression guard for blocker #1.
  const replayed = await waitFor(() => mgr.spawnCount === 2, { timeoutMs: 4000 });
  assert.equal(replayed, true, 'the suppressed force_respawn replayed → a fresh respawn occurred');
  await delay(150);
  assert.equal(mgr.spawnCount, 2, 'replayed exactly once (burst coalesced) — no runaway loop');
  const sF = mgr._getLiveSession(KEY('t1', 'assignee', 'a1'));
  assert.ok(sF && sF.pid !== sH.pid, 'the surviving session is the fresh force-respawn, not the killed holder');
});

test('provisioning window: a BURST of suppressed forces coalesces to exactly ONE replay', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher, tracker } = makeDispatcher({ ticketMgr: mgr });

  // Holder H holds the slot across its provisioning+spawn window.
  const pH = dispatcher.handleTrigger(evJson({ field_changed: 'trig-holder-H' }));
  // THREE distinct force-respawns arrive during the hold → all suppressed, but
  // #pendingForce keeps only the first (one per key). onRelease hands back a
  // single payload → a single replay, no matter the burst size.
  await dispatcher.handleTrigger(evJson({ force_respawn: true, field_changed: 'trig-f1' }));
  await dispatcher.handleTrigger(evJson({ force_respawn: true, field_changed: 'trig-f2' }));
  await dispatcher.handleTrigger(evJson({ force_respawn: true, field_changed: 'trig-f3' }));
  assert.equal(tracker.suppressedCount('inflight_dispatch'), 3, 'all three forces were suppressed');

  gate.resolve();
  await pH;
  // Exactly one respawn from the coalesced burst: 1 (holder) → 2 (single replay).
  const replayed = await waitFor(() => mgr.spawnCount === 2, { timeoutMs: 4000 });
  assert.equal(replayed, true, 'the burst produced a respawn');
  await delay(200);
  assert.equal(mgr.spawnCount, 2, 'three suppressed forces coalesced into exactly ONE replay');
});

test('LIVE session + two concurrent force-respawns → exactly ONE respawn, the second drops as inflight_spawn (no twin)', async () => {
  // Reviewer (b): on a LIVE session tryReserveDispatch returns {live:true} for
  // BOTH forces — NO gate-level reservation, so neither is suppressed at the
  // handleTrigger gate (correcting the earlier "1 holder + pending" claim). The
  // twin is instead prevented at the spawn seam: the first force force-respawns
  // (kills the live session, reserves _inflight, holds in _spawnSession) and the
  // second, arriving mid-respawn, is dropped by the REAL
  // `_inflight.has && !dispatchReserved` guard → exactly one fresh session.
  const mgr = new RealTicketMgrStub(makeConfig());
  const { dispatcher, tracker } = makeDispatcher({ ticketMgr: mgr });

  // Establish the live session S0.
  await dispatcher.handleTrigger(evJson({ field_changed: 'trig-0' }));
  assert.equal(mgr.spawnCount, 1, 'baseline: one live session');
  const s0 = mgr._getLiveSession(KEY('t1', 'assignee', 'a1'));
  assert.ok(s0, 'S0 is live');

  // Hold the NEXT spawn (the respawn) so the two forces race across the window.
  const gate = deferred();
  mgr.spawnGate = gate;

  const pF1 = dispatcher.handleTrigger(evJson({ force_respawn: true, field_changed: 'trig-f1' }));
  const pF2 = dispatcher.handleTrigger(evJson({ force_respawn: true, field_changed: 'trig-f2' }));

  // One force wins and holds at the spawn gate (spawnCount → 2); the other is
  // dropped at the spawn seam. Neither is suppressed at the gate (live reuse).
  await waitFor(() => mgr.spawnCount === 2, { timeoutMs: 3000 });
  assert.equal(tracker.suppressedCount('inflight_dispatch'), 0, 'live forces are NOT gate-suppressed (both saw live)');

  gate.resolve();
  await Promise.all([pF1, pF2]);
  await delay(150);

  // Exactly one respawn — never a twin. spawnCount stays 2 (S0 killed, one fresh).
  assert.equal(mgr.spawnCount, 2, 'the second concurrent force did NOT spawn a twin');
  const live = mgr._getLiveSession(KEY('t1', 'assignee', 'a1'));
  assert.ok(live, 'a single live session remains');
  assert.notEqual(live.pid, s0.pid, 'the live session is the fresh respawn, not the killed S0');
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
