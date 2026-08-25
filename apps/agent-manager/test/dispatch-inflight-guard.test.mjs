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
import {
  INFLIGHT_RESERVATION_STALE_MS,
  INFLIGHT_SUPPRESS_SAFETY_VALVE,
  INFLIGHT_SUPPRESS_SAFETY_VALVE_MIN_AGE_MS,
} from '../dist/lib/base-session-manager.js';

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
    silentExitVerifyDelayMs: 0, // skip the real grace delay (ticket 2fd06686) in tests
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
  constructor(cfg, { spawnGate = null, failSpawn = false, circuitBreaker } = {}) {
    super(cfg, circuitBreaker);
    this.spawnCount = 0;
    this.followUps = [];
    this.spawnGate = spawnGate; // optional deferred to hold a spawn in-flight
    // ticket 970d6692: force dispatchTrigger to decline with 'spawn_failed'
    // — an UNRELATED reason reached only AFTER its own circuit-breaker gate
    // already passed — so tests can drive the real dispatchTrigger→one-shot
    // fallback event-dispatcher.ts takes on any non-breaker decline.
    this.failSpawn = failSpawn;
  }
  async _spawnSession(sessionKey, _rolePrompt, _firstTurnText, _opts) {
    this.spawnCount++;
    if (this.spawnGate) await this.spawnGate.promise;
    if (this.failSpawn) return null;
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
        // A REAL child (not a fake pid number) so tryReserveDispatch's
        // OS-level liveness probe (round 3, ticket e90294e7) sees a genuinely
        // alive process, matching production where SubagentManager.spawn()
        // always forks a real one-shot. spawnDummyChild() is tracked in
        // liveChildren and hard-killed by the suite's `after()`.
        const child = spawnDummyChild();
        calls.spawn.push({ ...spec, pid: child.pid });
        return { spawned: true, pid: child.pid };
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
    // ticket 13160d20: main.ts는 TicketSessionManager를 항상 무조건 생성한다
    // (persistentTicketSessions는 handleTrigger/#dispatchTriggerBody가 dispatch를
    // 그것을 통해 라우팅할지만 게이팅할 뿐 — 인스턴스 자체와 _inflight 맵은
    // 항상 존재한다). 여기서 persistent:false일 때 null로 처리해버리면, 매니저의
    // 단순 존재 여부로만(config 플래그가 아니라) 잘못 분기하는 가드를 숨겨버렸다
    // — 정확히 이 티켓이 고치는 handleCommentMention 버그다.
    ticketSessionManager: mgr,
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

// A placed reservation (acquired && !live) now carries a generation nonce
// (ticket 26a92722) so a stale-generation release can be CAS-rejected. The nonce
// is a random UUID, so the shape-asserting deepEqual sites strip it first and a
// dedicated helper asserts it is a non-empty string where it matters.
function stripNonce(reservation) {
  if (reservation && typeof reservation === 'object' && 'nonce' in reservation) {
    const { nonce, ...rest } = reservation;
    return rest;
  }
  return reservation;
}
function assertNonce(reservation, msg = 'a placed reservation carries a generation nonce') {
  assert.equal(typeof reservation.nonce, 'string', msg);
  assert.ok(reservation.nonce.length > 0, msg);
}

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
  assert.deepEqual(stripNonce(r1), { acquired: true, live: false }, 'free key → reserved (fresh)');
  assertNonce(r1);

  const r2 = mgr.tryReserveDispatch('t', 'assignee', 'a');
  assert.equal(r2.acquired, false, 'a concurrent same-key trigger is the twin → refused');

  mgr.releaseDispatch('t', 'assignee', 'a');
  const r3 = mgr.tryReserveDispatch('t', 'assignee', 'a');
  assert.deepEqual(stripNonce(r3), { acquired: true, live: false }, 'release re-arms the slot');
  assertNonce(r3);
  assert.notEqual(r3.nonce, r1.nonce, 're-reservation issues a fresh generation nonce');
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

test('한 hold의 억제 N건은 알림 1건과 별개로 suppressed ack N건을 보고한다', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher, tracker } = makeDispatcher({ ticketMgr: mgr });
  const ackBodies = [];
  const commentCalls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const body = typeof init?.body === 'string' ? init.body : '';
    if (target.endsWith('/api/agent-manager/dispatch/ack')) {
      ackBodies.push(JSON.parse(body));
      return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; }, headers: { get: () => null } };
    }
    if (body.includes('"tools/call"')) commentCalls.push(JSON.parse(body));
    return {
      ok: true, status: 200,
      headers: { get: (name) => name.toLowerCase() === 'mcp-session-id' ? 'suppression-session' : null },
      async json() { return {}; }, async text() { return ''; },
    };
  };

  const holder = dispatcher.handleTrigger(evJson({ field_changed: 'holder' }));
  await waitFor(() => mgr.spawnCount === 1);
  await Promise.all([
    dispatcher.handleTrigger(evJson({ field_changed: 'twin-1' })),
    dispatcher.handleTrigger(evJson({ field_changed: 'twin-2' })),
    dispatcher.handleTrigger(evJson({ field_changed: 'twin-3' })),
  ]);
  await waitFor(() => ackBodies.filter((b) => b.outcome === 'suppressed').length === 3);
  await waitFor(() => commentCalls.some((c) => c?.params?.name === 'add_comment'));

  assert.equal(tracker.suppressedCount('inflight_dispatch'), 3, '실제 억제는 세 건이다');
  assert.deepEqual(
    ackBodies.filter((b) => b.outcome === 'suppressed').map((b) => b.trigger_id).sort(),
    ['twin-1', 'twin-2', 'twin-3'],
    '표시 throttle과 무관하게 억제된 각 trigger id를 서버에 보고해야 한다',
  );
  assert.equal(
    commentCalls.filter((c) => c?.params?.name === 'add_comment').length,
    1,
    '같은 hold-burst의 사용자 가시 알림은 한 번만 발행해야 한다',
  );

  gate.resolve();
  await holder;
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

test("dispatchTrigger's circuit-breaker pass is honored by the one-shot fallback, not re-queried (ticket 970d6692)", async () => {
  // Reproduces the reported production sequence: the breaker is OPEN and past
  // cooldown, dispatchTrigger's OWN circuit-breaker gate grants the single
  // half-open probe (stamping lastProbeAt), but dispatchTrigger declines
  // anyway for an UNRELATED reason (here: its _spawnSession fails), so
  // event-dispatcher falls back to a one-shot spawn — the SAME logical
  // attempt reaching a SECOND internal gate. Before the fix, that second gate
  // called shouldBlock() again, saw the lastProbeAt gate ① had just stamped,
  // and re-blocked with "opened 0s ago" — the breaker could never self-heal.
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
  const key = CircuitBreaker.key('a1', 't1', 'assignee');
  cb.record(key, 1, 'x');
  cb.record(key, 1, 'x'); // opens
  cb.getOpenBreakers()[0].entry.openedAt = Date.now() - 200; // cooldown elapsed

  const mgr = new RealTicketMgrStub(makeConfig(), { failSpawn: true, circuitBreaker: cb });
  const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

  await dispatcher.handleTrigger(evJson());

  assert.equal(mgr.spawnCount, 1, "dispatchTrigger's own gate passed and it attempted (and failed) its own spawn");
  assert.equal(calls.spawn.length, 1, 'declined for an unrelated reason → fell back to the one-shot spawn');
  assert.equal(
    calls.spawn[0].circuitBreakerDecision,
    null,
    "the fallback must carry dispatchTrigger's already-granted verdict (null = allowed) instead of leaving " +
      'spawn() to re-query shouldBlock() and re-block the attempt it was meant to allow',
  );
});

test("a pre-dispatchTrigger failure must NOT borrow dispatchTrigger's gate verdict — the one-shot fallback re-queries its own shouldBlock() (ticket 970d6692 round 3)", async () => {
  // Round-2 fix trusted dispatchTrigger's verdict whenever the WHOLE
  // try-block threw, including a failure BEFORE dispatchTrigger() was ever
  // called — fetchTicketContext() and the ticket-context mutation that
  // follows it both run first. That would silently bypass an OPEN breaker
  // that dispatchTrigger's shouldBlock() never actually got to consult.
  // Reproduce the pre-dispatch failure with a frozen ticket object:
  // fetchTicketContext() resolves fine, but the very next statement
  // (`ticket.current_column_id = ...`) throws (strict-mode write to a
  // frozen object) before dispatchTrigger is reached at all. Only the FIRST
  // ticket fetch (the persistent-session path) is frozen — the one-shot
  // fallback below makes its OWN independent fetchTicketContext call and
  // must get a normal mutable ticket, or it would fail closed for an
  // unrelated reason before ever reaching spawn().
  const savedFetchLocal = globalThis.fetch;
  let ticketFetchCount = 0;
  globalThis.fetch = async (url) => {
    if (typeof url !== 'string' || !url.includes('/api/agent/tickets/')) {
      return { ok: false, status: 503, async json() { return {}; }, async text() { return ''; } };
    }
    ticketFetchCount++;
    const ticket = ticketFetchCount === 1 ? Object.freeze({ id: 't1', title: 'x' }) : { id: 't1', title: 'x' };
    return {
      ok: true,
      status: 200,
      async json() {
        return ticket;
      },
      async text() {
        return '';
      },
    };
  };
  try {
    // Cooldown-elapsed OPEN breaker: if dispatchTrigger's gate HAD run, a
    // real probe would be allowed (null) — so passing that verdict through
    // unexamined is indistinguishable from the fix working, unless we check
    // the exact value received below.
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
    const key = CircuitBreaker.key('a1', 't1', 'assignee');
    cb.record(key, 1, 'x');
    cb.record(key, 1, 'x'); // opens
    cb.getOpenBreakers()[0].entry.openedAt = Date.now() - 200; // cooldown elapsed

    const mgr = new RealTicketMgrStub(makeConfig(), { circuitBreaker: cb });
    const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

    await dispatcher.handleTrigger(evJson());

    assert.equal(mgr.spawnCount, 0, "dispatchTrigger's own gate never ran — the throw happened before its call");
    assert.equal(calls.spawn.length, 1, 'still falls back to the one-shot spawn on the pre-dispatch failure');
    assert.equal(
      calls.spawn[0].circuitBreakerDecision,
      undefined,
      'must NOT borrow a verdict that was never actually computed — spawn() has to re-query shouldBlock() itself',
    );
  } finally {
    globalThis.fetch = savedFetchLocal;
  }
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
  const bothReachedSpawn = await waitFor(() => mgr.spawnCount === 2);
  assert.equal(bothReachedSpawn, true, 'both co-holders reached the gated spawn');
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

  await sub._sweepNow(); // drop-first delete + real SIGTERM to the real child (ticket b972b28c: awaits the live-task probe first — this dummy child has no descendants)

  // The real child actually dies from the SIGTERM.
  const died = await waitFor(() => !liveChildren.has(child) || isDead(child.pid), { timeoutMs: 4000 });
  assert.equal(died, true, 'the real child received the SIGTERM and exited');
  // Drop-first means the exit handler early-returns: NOT counted toward the
  // circuit breaker (an idle reap is a manager-initiated kill, not a death).
  assert.equal(sub.circuitBreaker.getOpenBreakers().length, 0, 'idle-reap not counted toward the breaker');
});

// ───────────── Part D: zombie-reservation recovery — TTL + safety valve (ticket 7c3ba9cf) ─────────────
//
// The 6h Review-column stall: a holder that hung mid-provisioning (its
// handleTrigger await never resolved → the try/finally releaseDispatch never
// ran) leaves a ZOMBIE reservation in the authoritative _inflight registry with
// NO pid to pid-check and NO TTL, so every supervisor retry is suppressed as a
// twin FOREVER. Two backstops reclaim it, both atomically (evict + re-reserve in
// the same synchronous CAS): (1) a wall-clock TTL, (2) an N-consecutive-
// suppression safety valve that also leaves an operator-visible warning.
// Non-vacuous: deleting either backstop makes the wedged-holder tests below hang
// the ticket (every retry refused, spawnCount stuck at 0).

// Deterministic clock override so a 10-min TTL is testable without a real wait.
function withClock(fn) {
  const realNow = Date.now;
  let t = 1_000_000; // arbitrary epoch
  Date.now = () => t;
  const advance = (ms) => {
    t += ms;
  };
  try {
    return fn(advance);
  } finally {
    Date.now = realNow;
  }
}

test('TTL: a reservation older than the stale window is evicted so a retry re-dispatches (authoritative)', () => {
  withClock((advance) => {
    const mgr = new RealTicketMgrStub(makeConfig());
    // A dispatch reserved the provision→spawn window, then HUNG (never released).
    assert.deepEqual(stripNonce(mgr.tryReserveDispatch('t', 'assignee', 'a')), { acquired: true, live: false });
    // Still inside the window → a retry is (correctly) refused as a twin.
    assert.equal(mgr.tryReserveDispatch('t', 'assignee', 'a').acquired, false, 'fresh hold refuses the twin');

    advance(INFLIGHT_RESERVATION_STALE_MS + 1); // holder is now a presumed zombie
    const evicted = mgr.tryReserveDispatch('t', 'assignee', 'a');
    assert.deepEqual(
      stripNonce(evicted),
      { acquired: true, live: false, evicted: 'stale' },
      'past the TTL the zombie is evicted and the retry re-reserves',
    );
    assertNonce(evicted);
    // The reclaim re-stamped reservedAt to now → the freshly reclaimed slot again
    // refuses a concurrent twin (no thrashing).
    assert.equal(mgr.tryReserveDispatch('t', 'assignee', 'a').acquired, false, 'reclaimed slot is a fresh hold');
  });
});

test('twin-safety: N rapid suppressions WITHIN the min-age gate do NOT valve (a healthy slow provision is never twinned)', () => {
  withClock(() => {
    const mgr = new RealTicketMgrStub(makeConfig());
    // A healthy holder is still provisioning; a bursty supervisor hammers the key
    // many times in quick succession (age stays ~0, well under the min-age gate).
    assert.deepEqual(stripNonce(mgr.tryReserveDispatch('t', 'assignee', 'a')), { acquired: true, live: false });
    for (let i = 0; i < INFLIGHT_SUPPRESS_SAFETY_VALVE + 3; i++) {
      const r = mgr.tryReserveDispatch('t', 'assignee', 'a');
      assert.equal(r.acquired, false, `rapid suppression #${i + 1} stays refused — no premature valve → no twin`);
      assert.equal(r.evicted, undefined, 'the count alone must not force-release inside the min-age window');
    }
  });
});

test('safety valve: N consecutive suppressions AND age past the min-age gate force-release (evicted:safety_valve)', () => {
  withClock((advance) => {
    const mgr = new RealTicketMgrStub(makeConfig());
    // A wedged holder that never released. Age it past the min-age gate (but still
    // under the TTL) — a healthy holder would have released well before now.
    assert.deepEqual(stripNonce(mgr.tryReserveDispatch('t', 'assignee', 'a')), { acquired: true, live: false });
    advance(INFLIGHT_SUPPRESS_SAFETY_VALVE_MIN_AGE_MS + 1_000);
    assert.ok(
      INFLIGHT_SUPPRESS_SAFETY_VALVE_MIN_AGE_MS + 1_000 < INFLIGHT_RESERVATION_STALE_MS,
      'sanity: still under the TTL so this exercises the valve, not the stale path',
    );
    // The first (N-1) retries are suppressed; the Nth crosses the valve.
    for (let i = 1; i < INFLIGHT_SUPPRESS_SAFETY_VALVE; i++) {
      assert.equal(
        mgr.tryReserveDispatch('t', 'assignee', 'a').acquired,
        false,
        `suppression ${i} < ${INFLIGHT_SUPPRESS_SAFETY_VALVE} → still refused`,
      );
    }
    const valved = mgr.tryReserveDispatch('t', 'assignee', 'a');
    assert.deepEqual(
      stripNonce(valved),
      { acquired: true, live: false, evicted: 'safety_valve' },
      `the ${INFLIGHT_SUPPRESS_SAFETY_VALVE}th consecutive suppression past the min-age gate force-releases`,
    );
    assertNonce(valved);
  });
});

test('safety-valve counter resets on releaseDispatch (a clean release re-arms the count)', () => {
  withClock((advance) => {
    const mgr = new RealTicketMgrStub(makeConfig());
    mgr.tryReserveDispatch('t', 'assignee', 'a');
    advance(INFLIGHT_SUPPRESS_SAFETY_VALVE_MIN_AGE_MS + 1_000); // past the age gate
    // Accumulate suppressions just short of the valve, then the holder RELEASES
    // cleanly (not a zombie) — this must reset the consecutive count.
    for (let i = 1; i < INFLIGHT_SUPPRESS_SAFETY_VALVE; i++) mgr.tryReserveDispatch('t', 'assignee', 'a');
    mgr.releaseDispatch('t', 'assignee', 'a');

    // A fresh hold; age it past the gate again so ONLY the counter (not the age
    // gate) governs. The very next suppression must count as #1, NOT continue from
    // the pre-release total — else it would valve immediately (proving the reset).
    assert.deepEqual(stripNonce(mgr.tryReserveDispatch('t', 'assignee', 'a')), { acquired: true, live: false });
    advance(INFLIGHT_SUPPRESS_SAFETY_VALVE_MIN_AGE_MS + 1_000);
    const r = mgr.tryReserveDispatch('t', 'assignee', 'a');
    assert.equal(r.acquired, false, 'post-release the counter restarts → this suppression does not instantly valve');
    assert.equal(r.evicted, undefined, 'no force-release: the consecutive count began fresh after the clean release');
  });
});

test('fallback slot (persistent sessions off) gets the same TTL zombie recovery', () => {
  withClock((advance) => {
    const tracker = new InflightDispatchTracker();
    const key = InflightDispatchTracker.key('t', 'assignee', 'a');
    const meta = { ticketId: 't', role: 'assignee', agentId: 'a' };
    const fresh = tracker.tryAcquireFallback(key, meta);
    assert.equal(fresh.acquired, true, 'free fallback slot → acquired');
    assert.equal(fresh.evicted, undefined, 'ticket 5e0f272d: a genuinely first-time claim is not "evicted" from anything');
    assert.equal(tracker.tryAcquireFallback(key, meta).acquired, false, 'held fallback slot → twin refused');

    advance(INFLIGHT_RESERVATION_STALE_MS + 1);
    const reclaimed = tracker.tryAcquireFallback(key, meta);
    assert.equal(reclaimed.acquired, true, 'past the TTL the fallback zombie is evicted and re-claimed');
    assert.equal(
      reclaimed.evicted,
      'stale',
      "ticket 5e0f272d: the TTL path now reports evicted:'stale' — parity with the authoritative tryReserveDispatch's 'stale' case",
    );
    assert.equal(tracker.tryAcquireFallback(key, meta).acquired, false, 'reclaimed fallback slot is a fresh hold');
  });
});

test('end-to-end: a zombie reservation past the TTL no longer wedges the ticket — handleTrigger re-dispatches', async () => {
  await withClock(async (advance) => {
    const mgr = new RealTicketMgrStub(makeConfig());
    const { dispatcher } = makeDispatcher({ ticketMgr: mgr });
    // Simulate the wedged holder: a reservation placed then abandoned (its
    // handleTrigger hung and never released). No live session, no pid.
    assert.equal(mgr.tryReserveDispatch('t1', 'assignee', 'a1').acquired, true, 'the zombie holds the slot');
    assert.equal(mgr.spawnCount, 0, 'the wedged holder never spawned');

    advance(INFLIGHT_RESERVATION_STALE_MS + 1); // the holder is now a presumed zombie
    // The next supervisor cycle arrives — pre-fix this was suppressed forever.
    await dispatcher.handleTrigger(evJson());
    assert.equal(mgr.spawnCount, 1, 'the stale zombie was evicted and the retry actually re-dispatched');
    // The completed dispatch left a live session → healthy reuse, not wedged.
    assert.equal(mgr.tryReserveDispatch('t1', 'assignee', 'a1').live, true, 'recovered to a live-reuse state');
  });
});

test('safety-valve eviction posts an operator warning; a silent TTL eviction does not', async () => {
  // Capture MCP tools/call bodies so we can assert the safety-valve warning
  // comment is posted (and that a stale TTL eviction stays silent).
  const captured = [];
  const savedFetchLocal = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    if (body.includes('"initialize"')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'mcp-session-id' ? 'sess-1' : null) },
        async text() {
          return '';
        },
        async json() {
          return {};
        },
      };
    }
    if (body.includes('"tools/call"')) {
      try {
        captured.push(JSON.parse(body));
      } catch {
        /* ignore */
      }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async text() {
        return '';
      },
      async json() {
        return {};
      },
    };
  };
  try {
    // safety_valve → warning expected.
    {
      const mgr = new RealTicketMgrStub(makeConfig());
      mgr.tryReserveDispatch = () => ({ acquired: true, live: false, evicted: 'safety_valve' });
      const { dispatcher } = makeDispatcher({ ticketMgr: mgr });
      await dispatcher.handleTrigger(evJson());
      const posted = await waitFor(
        () =>
          captured.some(
            (c) =>
              c?.params?.name === 'add_comment' &&
              String(c?.params?.arguments?.content ?? '').includes('safety valve'),
          ),
        { timeoutMs: 3000 },
      );
      assert.equal(posted, true, 'a safety-valve force-release posts an operator warning comment');
    }
    // stale → silent (no warning comment for the routine TTL path).
    captured.length = 0;
    {
      const mgr = new RealTicketMgrStub(makeConfig());
      mgr.tryReserveDispatch = () => ({ acquired: true, live: false, evicted: 'stale' });
      const { dispatcher } = makeDispatcher({ ticketMgr: mgr });
      await dispatcher.handleTrigger(evJson());
      await delay(150);
      const warned = captured.some(
        (c) =>
          c?.params?.name === 'add_comment' &&
          String(c?.params?.arguments?.content ?? '').includes('safety valve'),
      );
      assert.equal(warned, false, 'a routine stale TTL eviction is silent (no operator warning)');
    }
  } finally {
    globalThis.fetch = savedFetchLocal;
  }
});

// ───────────── Part E: generation-nonce CAS on release (ticket 26a92722) ─────────────
//
// The residual live-twin window Part D left open: after a zombie holder H is
// evicted (TTL/safety-valve) and the slot is RE-RESERVED by a new holder N, H's
// hung `await` may finally resolve and its try/finally calls releaseDispatch on
// the SAME key. A key-only delete would wipe N's still-provisioning reservation
// (N has no pid yet), briefly re-opening the live-twin window. tryReserveDispatch
// now stamps a generation nonce per reservation; releaseDispatch only deletes on
// a nonce match (CAS), so H's stale-generation release is a no-op.
// Non-vacuous: reverting releaseDispatch to a key-only delete makes the
// "stale release must not evict the successor" asserts below fail (the twin
// window re-opens — the successor's reservation vanishes and a retry twin-spawns).

test('CAS: an evicted holder’s stale-generation release does NOT delete the successor’s reservation (authoritative)', () => {
  withClock((advance) => {
    const mgr = new RealTicketMgrStub(makeConfig());
    // Holder H reserves, then hangs.
    const h = mgr.tryReserveDispatch('t', 'assignee', 'a');
    assertNonce(h);

    // TTL passes → the next dispatch (N) evicts H and re-reserves with a NEW nonce.
    advance(INFLIGHT_RESERVATION_STALE_MS + 1);
    const n = mgr.tryReserveDispatch('t', 'assignee', 'a');
    assert.equal(n.evicted, 'stale', 'N reclaimed the zombie slot');
    assertNonce(n);
    assert.notEqual(n.nonce, h.nonce, 'N holds a distinct generation');

    // H’s hung await finally resolves → its finally releases with the OLD nonce.
    mgr.releaseDispatch('t', 'assignee', 'a', h.nonce);

    // N’s reservation must survive: a concurrent twin is still refused (the slot
    // is still held), i.e. the stale release did NOT re-open the twin window.
    assert.equal(
      mgr.tryReserveDispatch('t', 'assignee', 'a').acquired,
      false,
      'stale-generation release is a no-op — the successor’s hold is intact',
    );

    // N’s own (current-generation) release then clears the slot normally.
    mgr.releaseDispatch('t', 'assignee', 'a', n.nonce);
    const after = mgr.tryReserveDispatch('t', 'assignee', 'a');
    assert.equal(after.acquired, true, 'a matching-generation release frees the slot');
  });
});

test('CAS: a release with the CURRENT nonce (or no nonce) still frees the slot (authoritative)', () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  // Matching nonce → deletes.
  const r1 = mgr.tryReserveDispatch('t', 'assignee', 'a');
  mgr.releaseDispatch('t', 'assignee', 'a', r1.nonce);
  assert.equal(mgr.tryReserveDispatch('t', 'assignee', 'a').acquired, true, 'matching nonce clears the slot');

  // Legacy caller (no nonce) → unconditional delete, preserving old behavior.
  mgr.releaseDispatch('t', 'assignee', 'a');
  assert.equal(mgr.tryReserveDispatch('t', 'assignee', 'a').acquired, true, 'a nonce-less release still clears');
});

test('CAS: the fallback slot rejects an evicted holder’s stale-generation release too (persistent sessions off)', () => {
  withClock((advance) => {
    const tracker = new InflightDispatchTracker();
    const key = InflightDispatchTracker.key('t', 'assignee', 'a');
    const meta = { ticketId: 't', role: 'assignee', agentId: 'a' };

    const h = tracker.tryAcquireFallback(key, meta);
    assert.equal(h.acquired, true);
    assert.equal(typeof h.nonce, 'string');

    advance(INFLIGHT_RESERVATION_STALE_MS + 1);
    const n = tracker.tryAcquireFallback(key, meta);
    assert.equal(n.acquired, true, 'N reclaimed the stale fallback slot');
    assert.notEqual(n.nonce, h.nonce, 'N holds a distinct generation');

    // H’s late release with the OLD nonce must be a no-op.
    tracker.releaseFallback(key, h.nonce);
    assert.equal(
      tracker.isFallbackInflight(key),
      true,
      'stale-generation releaseFallback is a no-op — the successor’s hold is intact',
    );

    // N’s matching-generation release frees it.
    tracker.releaseFallback(key, n.nonce);
    assert.equal(tracker.isFallbackInflight(key), false, 'a matching-generation release frees the fallback slot');
  });
});

// ───────── Part F: comment_mention vs column-move trigger collision (ticket e90294e7) ─────────
//
// da4358ee's postmortem: a reviewer's single "change requested" comment that
// both (a) moves the ticket Review→In Progress AND (b) carries
// `@[role:assignee]` fires TWO independent triggers — agent_trigger
// (handleTrigger) and comment_mention (handleCommentMention) — for the exact
// same (ticket, role, agent) seat. Part A–E above proved handleTrigger's OWN
// twin (another agent_trigger for the same key) is caught by the authoritative
// _inflight reservation. But handleCommentMention's one-shot fallback never
// consulted that registry — it only asked forwardCommentMention for a LIVE
// session, which is blind to a column trigger still mid-provisioning (worktree
// checkout/rebase, no pid yet) — so the mention fell through and spawned an
// independent one-shot session racing the column trigger's session inside the
// SAME worktree (observed live: both exited without committing).
//
// Non-vacuous: reverting the `hasInflightOrLiveDispatch` gate in
// handleCommentMention (or TicketSessionManager's implementation of it) makes
// the first test below spawn a second (competing) session — calls.spawn.length
// would be 1 instead of 0.

function mentionEvJson(fields = {}) {
  return JSON.stringify({
    ticket_id: 't1',
    comment_id: 'c1',
    agent_id: 'a1',
    actor_id: 'reviewer-1',
    actor_type: 'agent',
    actor_name: 'Reviewer',
    content: '변경 요청 — 지적사항을 반영해 주세요.',
    role_prompt: '',
    mention_source: 'role',
    role_shortcut: 'assignee',
    ...fields,
  });
}

test('role-mention is suppressed while a column-move trigger for the SAME (ticket, role, agent) seat is still provisioning', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

  // The column-move trigger reserves the seat synchronously inside
  // handleTrigger and then blocks in _spawnSession (worktree provisioning) —
  // the session is NOT live yet, so forwardCommentMention alone would miss it.
  const pTrigger = dispatcher.handleTrigger(evJson());
  await waitFor(() => mgr.spawnCount === 1, { timeoutMs: 2000 });
  assert.equal(mgr._getLiveSession(KEY('t1', 'assignee', 'a1')), undefined, 'still provisioning — not live yet');

  // The SAME reviewer comment's @[role:assignee] mention arrives for the same seat.
  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(calls.spawn.length, 0, 'the mention did not spawn a competing one-shot session');

  gate.resolve();
  await pTrigger;
  assert.equal(mgr.spawnCount, 1, 'only the column-triggered session ever spawned');
  assert.ok(mgr._getLiveSession(KEY('t1', 'assignee', 'a1')), 'the column-triggered session completed normally');
});

test('the suppression posts a ticket comment so the mention is not silently lost', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher } = makeDispatcher({ ticketMgr: mgr });

  const captured = [];
  const savedFetchLocal = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    if (body.includes('"initialize"')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'mcp-session-id' ? 'sess-1' : null) },
        async text() { return ''; },
        async json() { return {}; },
      };
    }
    if (body.includes('"tools/call"')) {
      try { captured.push(JSON.parse(body)); } catch { /* ignore */ }
    }
    return {
      ok: true, status: 200, headers: { get: () => null },
      async text() { return ''; }, async json() { return {}; },
    };
  };
  try {
    const pTrigger = dispatcher.handleTrigger(evJson());
    await waitFor(() => mgr.spawnCount === 1, { timeoutMs: 2000 });
    await dispatcher.handleCommentMention(mentionEvJson());

    const posted = await waitFor(
      () =>
        captured.some(
          (c) =>
            c?.params?.name === 'add_comment' &&
            c?.params?.arguments?.ticket_id === 't1' &&
            String(c?.params?.arguments?.content ?? '').includes('중복 dispatch 억제'),
        ),
      { timeoutMs: 3000 },
    );
    assert.equal(posted, true, 'a suppression notice was posted to the ticket');

    gate.resolve();
    await pTrigger;
  } finally {
    globalThis.fetch = savedFetchLocal;
  }
});

test('a direct @[agent:id] mention (no role) is NOT suppressed by an in-flight column trigger — it has no role to collide on', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

  const pTrigger = dispatcher.handleTrigger(evJson());
  await waitFor(() => mgr.spawnCount === 1, { timeoutMs: 2000 });

  await dispatcher.handleCommentMention(mentionEvJson({ mention_source: 'direct', role_shortcut: '' }));
  assert.equal(calls.spawn.length, 1, 'a direct mention still dispatches its own one-shot session');

  gate.resolve();
  await pTrigger;
});

test('a role-mention for a DIFFERENT role than the in-flight column trigger is NOT suppressed', async () => {
  const gate = deferred();
  const mgr = new RealTicketMgrStub(makeConfig(), { spawnGate: gate });
  const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

  const pTrigger = dispatcher.handleTrigger(evJson()); // role: assignee
  await waitFor(() => mgr.spawnCount === 1, { timeoutMs: 2000 });

  await dispatcher.handleCommentMention(mentionEvJson({ role_shortcut: 'reviewer' }));
  assert.equal(calls.spawn.length, 1, 'a different-role mention is an unrelated seat — dispatches normally');

  gate.resolve();
  await pTrigger;
});

test('baseline: a role-mention with no concurrent column trigger dispatches exactly as before', async () => {
  const { calls } = await (async () => {
    const mgr = new RealTicketMgrStub(makeConfig());
    const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });
    await dispatcher.handleCommentMention(mentionEvJson());
    return { calls };
  })();
  assert.equal(calls.spawn.length, 1, 'nothing in flight to collide with — the mention spawns its one-shot session');
});

// ───── Part F round 2 (reviewer 지적, e90294e7): the REVERSE dispatch order ─────
//
// The tests above only prove the "column trigger first" ordering is safe. The
// reviewer pointed out the real-world order from a review "change requested"
// comment is the OPPOSITE: the comment (carrying `@[role:assignee]`) posts
// FIRST, and the Review→In Progress column move — and its agent_trigger — land
// a moment AFTER. In that order, comment_mention's one-shot fallback is the
// FIRST of the two dispatch paths to reach the seat. A PEEK-only guard
// (hasInflightOrLiveDispatch) finds nothing to suppress against at that point
// — there IS no reservation yet, because nothing has claimed one — so the
// mention falls through to a one-shot spawn that (pre-fix) never registered
// itself in TicketSessionManager._inflight. The column trigger that follows
// then finds the seat free too and twin-spawns a persistent session, exactly
// reproducing da4358ee's sibling-session incident with the order flipped.
//
// Non-vacuous: reverting handleCommentMention back to a `hasInflightOrLiveDispatch`
// peek (instead of an atomic `tryReserveDispatch` claim held across the
// one-shot's full lifetime via `onExit`) makes the trigger below also spawn —
// mgr.spawnCount would be 1 instead of 0, and total spawns 2 instead of 1.

test('reverse order (round 2): role-mention arrives FIRST and claims the seat; the column-move trigger for the SAME seat that follows is suppressed — total spawns stays 1', async () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

  // Real wire payload: the reviewer's "change requested" comment carries the
  // role mention and is delivered as comment_mention BEFORE the column-move
  // agent_trigger for the same (ticket=t1, role=assignee, agent=a1) seat.
  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(calls.spawn.length, 1, 'the mention is first to the seat — it claims it and spawns its one-shot');
  assert.equal(
    typeof calls.spawn[0].onExit,
    'function',
    'the claimed seat is held via onExit for the one-shot\'s full lifetime, not released when spawn() merely returns a pid',
  );

  // The SAME reviewer comment's column move now lands, firing agent_trigger
  // for the identical seat.
  await dispatcher.handleTrigger(evJson());
  assert.equal(
    mgr.spawnCount,
    0,
    'the column trigger found the seat already claimed by the mention\'s one-shot and did not twin-spawn a persistent session',
  );
});

test('reverse order (round 2): once the mention\'s one-shot exits (onExit fires), the seat is free again for a later trigger', async () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(calls.spawn.length, 1);
  const onExit = calls.spawn[0].onExit;
  assert.equal(typeof onExit, 'function');

  // Simulate the one-shot subagent process actually exiting — SubagentManager
  // invokes this hook once, on process close, never on spawn() merely
  // returning a pid.
  onExit();

  // A later, unrelated trigger for the same seat is no longer blocked by a
  // stale reservation the mention forgot to release.
  await dispatcher.handleTrigger(evJson());
  assert.equal(mgr.spawnCount, 1, 'the seat was released on the one-shot\'s exit, so the later trigger dispatched normally');
});

// ───── Part F round 3 (reviewer 지적, e90294e7): a long-running one-shot outlives the TTL/safety-valve ─────
//
// Round 2 holds the claimed seat in the SAME `_inflight` map the column-move
// path's provisioning reservation uses — but that map's zombie recovery
// (INFLIGHT_RESERVATION_STALE_MS 10min TTL, INFLIGHT_SUPPRESS_SAFETY_VALVE
// after INFLIGHT_SUPPRESS_SAFETY_VALVE_MIN_AGE_MS 5min) was calibrated for the
// short provisioning window (seconds), not a one-shot mention session that may
// run many minutes of real agentic work. Without a fix, a one-shot older than
// the TTL — or hit by 3 suppressed retries past the 5-min gate — has its
// "provisioning" reservation reclaimed by a later trigger even though the
// process never released it, twin-spawning right on top of the still-running
// one-shot: round 2's bug again, just arriving late instead of immediately.
//
// Fix: once handleCommentMention's spawn() resolves with a real pid, it
// promotes the reservation via attachDispatchPid so tryReserveDispatch trusts
// an OS-level liveness probe (_isPidAlive) instead of age for the rest of that
// pid's life — only the pid's own release (onExit) or CONFIRMED death (a new
// 'dead_pid' evicted reason, a stronger-than-timer backstop for a crash that
// bypasses onExit) frees the seat.
//
// Non-vacuous: reverting the pid-liveness check in tryReserveDispatch's
// existing-reservation branch (back to the bare age-based TTL/safety-valve)
// makes the first two tests below fail — the reservation gets evicted despite
// the process being alive — and the third test's spawnCount/spawn-count
// assertions flip from 0/1 to 1/2 (twin-spawn).

test('pid-verified reservation survives TTL + safety-valve while the process stays alive (round 3)', () => {
  withClock(() => {
    const mgr = new RealTicketMgrStub(makeConfig());
    const child = spawnDummyChild();
    try {
      const r1 = mgr.tryReserveDispatch('t', 'assignee', 'a');
      assert.equal(r1.acquired, true);
      mgr.attachDispatchPid('t', 'assignee', 'a', r1.nonce, child.pid);

      // Past BOTH the safety-valve min-age gate and the full TTL, repeatedly —
      // a bare (no-pid) reservation would already have been force-evicted by
      // the very first of these retries.
      for (let i = 0; i < INFLIGHT_SUPPRESS_SAFETY_VALVE + 3; i++) {
        const r = mgr.tryReserveDispatch('t', 'assignee', 'a');
        assert.equal(r.acquired, false, `attempt #${i + 1} stays refused — a live pid overrides age-based eviction`);
        assert.equal(r.evicted, undefined, 'a confirmed-alive pid is never TTL/safety-valve evicted');
      }
    } finally {
      child.kill('SIGKILL');
    }
  });
});

test('a pid-verified reservation whose process died without releasing is reclaimed immediately as dead_pid — not wedged for the TTL (round 3 backstop)', async () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  const child = spawnDummyChild();
  const r1 = mgr.tryReserveDispatch('t', 'assignee', 'a');
  mgr.attachDispatchPid('t', 'assignee', 'a', r1.nonce, child.pid);

  // Proves the check is pid-based, not age-based: refused even at ~0ms age
  // because the pid is alive.
  assert.equal(mgr.tryReserveDispatch('t', 'assignee', 'a').acquired, false);

  // The owning process is killed WITHOUT its onExit release running (a crash
  // bypassing the normal round-2 release path) — this must not wedge the
  // ticket for the full 10-minute TTL the way a bare (no-pid) hang would.
  child.kill('SIGKILL');
  await waitFor(() => isDead(child.pid), { timeoutMs: 3000 });

  const reclaimed = mgr.tryReserveDispatch('t', 'assignee', 'a');
  assert.equal(reclaimed.acquired, true, 'a confirmed-dead pid is reclaimed immediately, no TTL wait needed');
  assert.equal(reclaimed.evicted, 'dead_pid', 'evicted for the dead-pid reason, distinct from stale/safety_valve');
});

test('reverse order + long-running one-shot (round 3): past the TTL/safety-valve window while still alive, a column-move trigger for the same seat stays suppressed — total spawns stays 1', async () => {
  const mgr = new RealTicketMgrStub(makeConfig());
  // The default subagentManager stub spawns a REAL dummy child (see
  // makeDispatcher above), so its pid is genuinely alive at the OS level —
  // exercising the actual attachDispatchPid wiring in handleCommentMention,
  // not a synthetic pid.
  const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

  // Role-mention arrives first (the real da4358ee ordering) and claims the seat.
  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(calls.spawn.length, 1, 'the mention claimed the seat and spawned its one-shot');
  assert.equal(mgr._isPidAlive(calls.spawn[0].pid), true, "sanity: the one-shot's real child is alive");

  // Fast-forward past both the safety-valve min-age gate and the full TTL
  // while the one-shot is STILL running and has released nothing — the exact
  // fake-clock scenario the reviewer asked for.
  const realNow = Date.now;
  Date.now = () => realNow() + INFLIGHT_RESERVATION_STALE_MS + 5 * 60_000;
  try {
    // The SAME reviewer comment's column move now lands for the identical
    // seat. Pre-round-3 this reservation was purely age-based, so this
    // trigger would find it "aged out" and twin-spawn a persistent session
    // right on top of the still-running one-shot.
    await dispatcher.handleTrigger(evJson());
  } finally {
    Date.now = realNow;
  }
  assert.equal(mgr.spawnCount, 0, 'the persistent column-triggered session did not twin-spawn — the live one-shot still owns the seat');
  assert.equal(calls.spawn.length, 1, 'total one-shot spawns across both dispatch paths stays at 1');
});

// ───────── Part G: persistentTicketSessions:false 에서도 동일한 충돌 (ticket 13160d20) ─────────
//
// Part F는 handleTrigger가 컬럼 이동 dispatch를 TicketSessionManager.dispatchTrigger
// (authoritative _inflight 레지스트리)로 라우팅할 때의 가드를 증명했다. Fallback
// 모드(persistentTicketSessions:false, ticket 3d180f85의 설계)에서는 handleTrigger가
// provisioning 구간을 아우르는 (ticket, role, agent) seat를 대신 프로세스-로컬
// InflightDispatchTracker에 예약한다 — handleCommentMention의 mention-seat 가드가
// (config와 무관하게 무조건, TicketSessionManager가 main.ts에서 항상 생성되므로)
// 조회하던 레지스트리와는 DIFFERENT 한 곳이다. 서로 겹치지 않는 두 맵 때문에 어느
// dispatch 경로도 상대의 점유를 볼 수 없어서, 기본 설정에서는 e90294e7이 닫은 바로
// 그 da4358ee twin이 persistentTicketSessions:false 에서는 도착 순서와 무관하게
// (EITHER order) 다시 재현 가능했다.
//
// Non-vacuous: handleCommentMention의 fallback-모드 분기를(이 티켓의 fix를) 되돌려
// TicketSessionManager.tryReserveDispatch만 무조건 쓰게 하면, 아래 테스트들은 1번이
// 아니라 2번 spawn한다 — mention-seat 가드가 handleTrigger의 fallback 경로가 전혀
// 쓰지 않는 레지스트리를 조회하게 되기 때문이다.

function makeGatedSubagentManager(gate) {
  const calls = [];
  return {
    stub: {
      canSpawn: () => true,
      async spawn(spec) {
        const child = spawnDummyChild();
        calls.push({ ...spec, pid: child.pid });
        await gate.promise;
        return { spawned: true, pid: child.pid };
      },
    },
    calls,
  };
}

test('fallback mode: role-mention is suppressed while a column-move trigger for the SAME seat is still provisioning/spawning', async () => {
  const gate = deferred();
  const { stub: subagentManager, calls: spawnCalls } = makeGatedSubagentManager(gate);
  const { dispatcher, tracker } = makeDispatcher({ persistent: false, subagentManager });

  // 컬럼 이동 트리거는 handleTrigger 내부에서(#dispatchTriggerBody가 worktree를
  // resolve하기도 전에) fallback seat를 동기적으로 예약한 뒤, one-shot spawn()
  // 호출에서 블록된다 — Part F의 첫 테스트가 게이팅하는 ticket-session provisioning
  // hang과 동일한 구조다.
  const pTrigger = dispatcher.handleTrigger(evJson());
  await waitFor(() => spawnCalls.length === 1, { timeoutMs: 2000 });
  assert.equal(
    tracker.isFallbackInflight(KEY('t1', 'assignee', 'a1')),
    true,
    'the column trigger holds the fallback reservation while its one-shot spawn is in flight',
  );

  // 같은 리뷰어 코멘트의 @[role:assignee] 멘션이 같은 seat에 대해 도착한다.
  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(spawnCalls.length, 1, 'the mention did not spawn a competing one-shot session');

  gate.resolve();
  await pTrigger;
  assert.equal(spawnCalls.length, 1, 'only the column-triggered one-shot ever spawned');
});

test('fallback mode reverse order: role-mention arrives FIRST and claims the fallback seat; the column-move trigger that follows is suppressed — total spawns stays 1', async () => {
  const { dispatcher, calls } = makeDispatcher({ persistent: false });

  // 실제 wire payload 순서(da4358ee): 리뷰어의 "변경 요청" 코멘트는 role
  // 멘션을 담고 있으며, 같은 seat에 대한 컬럼 이동 agent_trigger보다 먼저
  // comment_mention으로 전달된다.
  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(calls.spawn.length, 1, 'the mention is first to the seat — it claims the fallback slot and spawns its one-shot');
  assert.equal(
    typeof calls.spawn[0].onExit,
    'function',
    'the claimed fallback seat is held via onExit for the one-shot\'s full lifetime, not released when spawn() merely returns a pid',
  );

  await dispatcher.handleTrigger(evJson());
  assert.equal(
    calls.spawn.length,
    1,
    'the column trigger found the fallback seat already claimed by the mention\'s one-shot and did not twin-spawn',
  );
});

test('fallback mode: once the mention\'s one-shot exits (onExit fires), the fallback seat is free again for a later trigger', async () => {
  const { dispatcher, calls } = makeDispatcher({ persistent: false });

  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(calls.spawn.length, 1);
  const onExit = calls.spawn[0].onExit;
  assert.equal(typeof onExit, 'function');

  // one-shot subagent 프로세스가 실제로 종료되는 상황을 시뮬레이션한다.
  onExit();

  await dispatcher.handleTrigger(evJson());
  assert.equal(
    calls.spawn.length,
    2,
    "the fallback seat was released on the one-shot's exit, so the later column trigger dispatched normally",
  );
});

test('fallback mode baseline: a role-mention with no concurrent column trigger dispatches exactly as before', async () => {
  const { dispatcher, calls } = makeDispatcher({ persistent: false });
  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(calls.spawn.length, 1, 'nothing in flight to collide with — the mention spawns its one-shot session');
});

test('fallback mode a direct @[agent:id] mention (no role) is NOT suppressed by an in-flight column trigger — it has no role to collide on', async () => {
  const gate = deferred();
  const { stub: subagentManager, calls: spawnCalls } = makeGatedSubagentManager(gate);
  const { dispatcher } = makeDispatcher({ persistent: false, subagentManager });

  const pTrigger = dispatcher.handleTrigger(evJson());
  await waitFor(() => spawnCalls.length === 1, { timeoutMs: 2000 });

  // 트리거와 멘션이 같은 게이트를 공유하는 stub이므로, 멘션 호출을 여기서 바로
  // await 해버리면 그 spawn()도 같은 gate.promise에서 블록되어 절대 안 풀리는
  // 데드락이 된다(gate.resolve()는 이 아래에서만 호출됨) — pTrigger와 동일하게
  // 완료를 기다리지 않고 캡처만 한다.
  const pMention = dispatcher.handleCommentMention(
    mentionEvJson({ mention_source: 'direct', role_shortcut: '' }),
  );
  await waitFor(() => spawnCalls.length === 2, { timeoutMs: 2000 });
  assert.equal(spawnCalls.length, 2, 'a direct mention still dispatches its own one-shot session');

  gate.resolve();
  await Promise.all([pTrigger, pMention]);
});

// ───────────── Part G round 2 (ticket fdf6714e, 13160d20 후속): fallback tracker pid-liveness parity ─────────────
//
// Part F round 3 gave the AUTHORITATIVE `_inflight` registry a pid-liveness
// escape hatch (TicketSessionManager.attachDispatchPid + _isPidAlive) so a
// long-running one-shot's reservation is never TTL-evicted while its process
// stays alive. InflightDispatchTracker (the process-local registry fallback
// mode — persistentTicketSessions:false — uses instead) had no equivalent: a
// fallback seat still held by a live one-shot could be reclaimed by a later
// trigger past INFLIGHT_RESERVATION_STALE_MS. The two direct tests below prove
// InflightDispatchTracker.attachDispatchPid closes that gap on the tracker
// itself (mirroring Part F's low-level round-3 tests); the end-to-end test
// after them proves it through the real dispatcher.
//
// Non-vacuous: reverting the pid-liveness check in tryAcquireFallback's
// existing-reservation branch (back to the bare age-based TTL) makes both
// direct tests below fail, and flips the end-to-end test's final assertion
// back from 1 to 2 (twin-spawn).

test('fallback tracker: pid-verified reservation survives the TTL while the process stays alive (ticket fdf6714e)', () => {
  withClock((advance) => {
    const tracker = new InflightDispatchTracker();
    const key = KEY('t', 'assignee', 'a');
    const meta = { ticketId: 't', role: 'assignee', agentId: 'a' };
    const child = spawnDummyChild();
    try {
      const r1 = tracker.tryAcquireFallback(key, meta);
      assert.equal(r1.acquired, true);
      tracker.attachDispatchPid(key, r1.nonce, child.pid);

      advance(INFLIGHT_RESERVATION_STALE_MS + 1);
      const r2 = tracker.tryAcquireFallback(key, meta);
      assert.equal(r2.acquired, false, 'a live pid overrides age-based eviction, even past the TTL');
      assert.equal(r2.evicted, undefined, 'a confirmed-alive pid is never TTL evicted');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

test('fallback tracker: a pid-verified reservation whose process died without releasing is reclaimed immediately as dead_pid (ticket fdf6714e)', async () => {
  const tracker = new InflightDispatchTracker();
  const key = KEY('t', 'assignee', 'a');
  const meta = { ticketId: 't', role: 'assignee', agentId: 'a' };
  const child = spawnDummyChild();
  const r1 = tracker.tryAcquireFallback(key, meta);
  tracker.attachDispatchPid(key, r1.nonce, child.pid);

  // Proves the check is pid-based, not age-based: refused even at ~0ms age
  // because the pid is alive.
  assert.equal(tracker.tryAcquireFallback(key, meta).acquired, false);

  // The owning process is killed WITHOUT its onExit release running (a crash
  // bypassing the normal releaseFallback path) — this must not wedge the seat
  // for the full 10-minute TTL the way a bare (no-pid) hang would.
  child.kill('SIGKILL');
  await waitFor(() => isDead(child.pid), { timeoutMs: 3000 });

  const reclaimed = tracker.tryAcquireFallback(key, meta);
  assert.equal(reclaimed.acquired, true, 'a confirmed-dead pid is reclaimed immediately, no TTL wait needed');
  assert.equal(reclaimed.evicted, 'dead_pid', 'evicted for the dead-pid reason, distinct from a bare TTL evict');
});

test('fallback mode (ticket 13160d20 follow-up, closed by fdf6714e): past the TTL, a column trigger can NO LONGER reclaim a fallback seat still held by a live mention one-shot', async () => {
  const { dispatcher, calls } = makeDispatcher({ persistent: false });

  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(calls.spawn.length, 1, 'the mention claimed the fallback seat and spawned its one-shot');
  // onExit을 의도적으로 호출하지 않는다 — one-shot이 아직 "실행 중"인 상태를 유지.

  const realNow = Date.now;
  Date.now = () => realNow() + INFLIGHT_RESERVATION_STALE_MS + 1;
  try {
    await dispatcher.handleTrigger(evJson());
  } finally {
    Date.now = realNow;
  }
  assert.equal(
    calls.spawn.length,
    1,
    'fixed: the mention attached its one-shot\'s pid to the fallback seat, so the column trigger found it still alive past the TTL and stayed suppressed — no twin',
  );
});

// ───── Part G.1 (ticket 6de97a41, fdf6714e 후속): a fallback dead-pid reclaim
// must be OBSERVABLE, not just correct ─────
//
// The two direct tracker tests above (fdf6714e) prove tryAcquireFallback
// itself reclaims a dead-pid seat immediately and reports why via
// `evicted: 'dead_pid'`. But neither dispatcher call site read that field
// back: handleTrigger discarded it while reassembling its local `reservation`
// object (`{ acquired, live, nonce }` — no `evicted`), and handleCommentMention
// never inspected `acq.evicted` at all. So the ONE observable signal a
// fallback-mode dead-pid reclaim produces — the
// `[dispatch] zombie reservation reclaimed (dead_pid)` log the authoritative
// path already emits for the identical event (ticket-session-manager.ts) —
// never fired in fallback mode. A crashed one-shot's silent-exit recovery left
// no trace in the manager log.
//
// Non-vacuous: reverting either propagation (dropping `evicted` from
// handleTrigger's reassembled `reservation`, or removing the `acq.evicted`
// check in handleCommentMention's fallback branch) makes the matching test
// below fail on the stderr assertion — the reclaim still succeeds
// (calls.spawn.length still reaches 1) but the log line is gone.

async function captureStderr(fn) {
  const real = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = real;
  }
  return buf;
}

test('ticket 6de97a41: handleTrigger logs the eviction reason when it reclaims a dead-pid fallback seat', async () => {
  const { dispatcher, tracker, calls } = makeDispatcher({ persistent: false });
  const key = KEY('t1', 'assignee', 'a1');
  const zombie = spawnDummyChild();
  const seed = tracker.tryAcquireFallback(key, { ticketId: 't1', role: 'assignee', agentId: 'a1' });
  tracker.attachDispatchPid(key, seed.nonce, zombie.pid);
  zombie.kill('SIGKILL');
  await waitFor(() => isDead(zombie.pid), { timeoutMs: 3000 });

  const stderr = await captureStderr(() => dispatcher.handleTrigger(evJson()));
  assert.equal(
    calls.spawn.length,
    1,
    'the dead-pid seat was reclaimed immediately (no TTL wait) and a fresh one-shot spawned',
  );
  assert.match(
    stderr,
    /\[dispatch\] zombie reservation reclaimed \(dead_pid\)/,
    'previously silent: handleTrigger dropped acq.evicted while reassembling `reservation`, so this log never fired in fallback mode',
  );
});

test('ticket 6de97a41: handleCommentMention logs the eviction reason when it reclaims a dead-pid fallback seat', async () => {
  const { dispatcher, tracker, calls } = makeDispatcher({ persistent: false });
  const key = KEY('t1', 'assignee', 'a1');
  const zombie = spawnDummyChild();
  const seed = tracker.tryAcquireFallback(key, { ticketId: 't1', role: 'assignee', agentId: 'a1' });
  tracker.attachDispatchPid(key, seed.nonce, zombie.pid);
  zombie.kill('SIGKILL');
  await waitFor(() => isDead(zombie.pid), { timeoutMs: 3000 });

  const stderr = await captureStderr(() => dispatcher.handleCommentMention(mentionEvJson()));
  assert.equal(
    calls.spawn.length,
    1,
    'the dead-pid seat was reclaimed immediately (no TTL wait) and a fresh one-shot spawned',
  );
  assert.match(
    stderr,
    /\[dispatch\] zombie reservation reclaimed \(dead_pid\)/,
    'previously silent: handleCommentMention never read acq.evicted at all, so this log never fired in fallback mode',
  );
});

// ───── Part G.2 (ticket 5e0f272d, 6de97a41 후속): the TTL/stale fallback
// reclaim must be OBSERVABLE too, not just dead_pid ─────
//
// Part G.1 above proved the dead-pid propagation. But tryAcquireFallback's
// OTHER eviction path — a holder that hung mid-provisioning and never got a
// pid attached, aged out past INFLIGHT_RESERVATION_STALE_MS (ticket
// 7c3ba9cf's zombie recovery) — still returned `{ acquired: true, nonce }`
// with no `evicted` field, so the same (now-wired-up) log block never fired
// for THIS reason in fallback mode. The authoritative tryReserveDispatch
// already reports 'stale' for the identical situation.
//
// Non-vacuous: reverting the dispatch-preflight.ts fix (dropping the new
// `evicted: 'stale'` return in the TTL branch back to the old shared
// fallthrough) makes the stderr assertion below fail — the reclaim still
// succeeds (calls.spawn still reaches 1) but the log line is gone, exactly
// like Part G.1's dead_pid case pre-6de97a41.

test('ticket 5e0f272d: handleTrigger logs the eviction reason when it reclaims a TTL-stale fallback seat', async () => {
  await withClock(async (advance) => {
    const { dispatcher, tracker, calls } = makeDispatcher({ persistent: false });
    const key = KEY('t1', 'assignee', 'a1');
    // A holder that hung mid-provisioning (ticket 7c3ba9cf) — no pid ever
    // attached, so only the TTL clock (not the dead_pid backstop above) can
    // reclaim this seat.
    tracker.tryAcquireFallback(key, { ticketId: 't1', role: 'assignee', agentId: 'a1' });

    advance(INFLIGHT_RESERVATION_STALE_MS + 1);
    const stderr = await captureStderr(() => dispatcher.handleTrigger(evJson()));
    assert.equal(
      calls.spawn.length,
      1,
      'past the TTL the zombie fallback seat was evicted and a fresh one-shot spawned',
    );
    assert.match(
      stderr,
      /\[dispatch\] zombie reservation reclaimed \(stale\)/,
      'previously silent: tryAcquireFallback returned evicted:undefined for the TTL path, so this log never fired for a stale (non-dead_pid) fallback reclaim',
    );
  });
});

// ───── Part H: handleTrigger's OWN one-shot spawn must hold its seat until exit (ticket f0d1da19) ─────
//
// Parts F/G above proved handleCommentMention's claimed seat survives past
// spawn() resolving (held via onExit). But handleTrigger's OWN reservation for
// its OWN one-shot spawn — the fallback-mode column trigger, and a declined
// persistent dispatch falling back to one-shot — used to release
// UNCONDITIONALLY the instant #dispatchTriggerBody returned, i.e. moments
// after spawn() merely resolved a pid, not when the spawned process actually
// exits. A role-mention for the IDENTICAL (ticket, role, agent) seat arriving
// in that window (real order: a reviewer's single "change requested" comment
// fires both an agent_trigger and a comment_mention near-simultaneously —
// ticket da4358ee) found the seat already free and twin-spawned a second
// one-shot racing the trigger's own. No TTL wait needed — the window opens the
// instant spawn() resolves.
//
// Non-vacuous: reverting the `onExit`/`triggerSeat` wiring in
// #dispatchTriggerBody's one-shot spawn branch (and handleTrigger's matching
// finally) back to an unconditional release makes both 'does not twin-spawn'
// tests below spawn a SECOND one-shot — calls.spawn.length would be 2 instead
// of 1.

test('ticket f0d1da19: fallback mode — once handleTrigger\'s one-shot spawn resolves, the fallback seat stays held until the process exits, so an immediately-following mention does not twin-spawn', async () => {
  const { dispatcher, calls } = makeDispatcher({ persistent: false });

  await dispatcher.handleTrigger(evJson());
  assert.equal(calls.spawn.length, 1, 'the column trigger dispatched its one-shot');
  assert.equal(
    typeof calls.spawn[0].onExit,
    'function',
    "the fallback seat is held via onExit for the trigger's one-shot's full lifetime, not released the instant spawn() resolves",
  );

  // The same reviewer comment's @[role:assignee] mention arrives moments later.
  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(
    calls.spawn.length,
    1,
    "gap closed (ticket f0d1da19): the trigger's one-shot is still running — the mention found the fallback seat still held and did not twin-spawn",
  );
});

test('ticket f0d1da19: fallback mode — once the trigger\'s one-shot exits (onExit fires), the fallback seat is free again for a later mention', async () => {
  const { dispatcher, calls } = makeDispatcher({ persistent: false });

  await dispatcher.handleTrigger(evJson());
  assert.equal(calls.spawn.length, 1);
  const onExit = calls.spawn[0].onExit;
  assert.equal(typeof onExit, 'function');

  // Simulate the trigger's one-shot subagent process actually exiting.
  onExit();

  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(
    calls.spawn.length,
    2,
    "the fallback seat was released on the trigger's one-shot exit, so the later mention dispatched normally",
  );
});

test('ticket f0d1da19: authoritative-declined one-shot — once handleTrigger\'s spawn resolves, the seat stays held until the process exits, so an immediately-following mention does not twin-spawn', async () => {
  // dispatchTrigger declines for an unrelated reason (its own _spawnSession
  // fails) — event-dispatcher falls back to the SAME one-shot spawn branch
  // fallback mode uses, still holding handleTrigger's fresh AUTHORITATIVE
  // _inflight reservation (canAuthoritative && reservedFresh — persistent
  // sessions are on by default here).
  const mgr = new RealTicketMgrStub(makeConfig(), { failSpawn: true });
  const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

  await dispatcher.handleTrigger(evJson());
  assert.equal(calls.spawn.length, 1, "dispatchTrigger declined — fell back to the trigger's own one-shot spawn");
  assert.equal(
    typeof calls.spawn[0].onExit,
    'function',
    "the authoritative seat is held via onExit for the trigger's one-shot's full lifetime, not released the instant spawn() resolves",
  );

  await dispatcher.handleCommentMention(mentionEvJson());
  assert.equal(
    calls.spawn.length,
    1,
    "gap closed (ticket f0d1da19): the trigger's one-shot is still running — the mention found the authoritative seat still held and did not twin-spawn",
  );
});

// Reviewer-requested (round 3 parity, ticket f0d1da19): the test above only
// proves the immediate (~0ms age) window. handleTrigger's authoritative seat
// is now held via onExit for the one-shot's FULL turn (possibly many minutes)
// — like handleCommentMention's mentionSeat, it must also be PROMOTED via
// attachDispatchPid (`triggerSeat.promote`) once spawn() resolves a real pid,
// or it stays pid:null and is reclaimed by the SAME TTL/safety-valve backstop
// meant for a hung, never-actually-spawned provisioning reservation — evicting
// a perfectly healthy one-shot and twin-spawning on top of it.
//
// Non-vacuous: dropping the `triggerSeat.promote(result.pid)` call in
// #dispatchTriggerBody's spawn-success branch (event-dispatcher.ts) makes the
// very first loop iteration below fail — the pid:null seat is immediately
// evicted as 'stale' (the fast-forwarded age already exceeds
// INFLIGHT_RESERVATION_STALE_MS) instead of staying refused with
// evicted:undefined — and the trailing handleTrigger/handleCommentMention
// calls twin-spawn, pushing calls.spawn.length to 3 instead of 1.
test('ticket f0d1da19: authoritative-declined one-shot — the promoted seat survives TTL + safety-valve while the process stays alive, so later triggers/mentions stay suppressed', async () => {
  const mgr = new RealTicketMgrStub(makeConfig(), { failSpawn: true });
  const { dispatcher, calls } = makeDispatcher({ ticketMgr: mgr });

  await dispatcher.handleTrigger(evJson());
  assert.equal(calls.spawn.length, 1, "dispatchTrigger declined — fell back to the trigger's own one-shot spawn");
  assert.equal(mgr._isPidAlive(calls.spawn[0].pid), true, "sanity: the trigger's one-shot real child is alive");

  // Fast-forward past both the safety-valve min-age gate and the full TTL
  // while the trigger's one-shot is STILL running and has released nothing.
  const realNow = Date.now;
  Date.now = () => realNow() + INFLIGHT_RESERVATION_STALE_MS + 5 * 60_000;
  try {
    for (let i = 0; i < INFLIGHT_SUPPRESS_SAFETY_VALVE + 3; i++) {
      const r = mgr.tryReserveDispatch('t1', 'assignee', 'a1');
      assert.equal(r.acquired, false, `attempt #${i + 1} stays refused — a live pid overrides age-based eviction`);
      assert.equal(r.evicted, undefined, 'a confirmed-alive pid is never TTL/safety-valve evicted');
    }

    // A later supervisor re-send for the same seat through the real
    // handleTrigger path also stays suppressed instead of twin-spawning...
    await dispatcher.handleTrigger(evJson());
    // ...and so does a same-seat role-mention through the real
    // handleCommentMention path.
    await dispatcher.handleCommentMention(mentionEvJson());
  } finally {
    Date.now = realNow;
  }
  assert.equal(
    calls.spawn.length,
    1,
    "past the TTL/safety-valve window, the still-alive trigger one-shot's authoritative seat stayed held — neither the later trigger nor the mention twin-spawned",
  );
});

// Rebase-time addition (ticket f0d1da19 landed after ticket fdf6714e merged to
// main): `triggerSeat.promote` now attaches the pid to InflightDispatchTracker
// in fallback mode too (mirroring the authoritative branch above and
// fdf6714e's own attachDispatchPid wiring for handleCommentMention's fallback
// seat), so handleTrigger's OWN fallback seat gets the same TTL/safety-valve
// escape hatch as the authoritative one.
//
// Non-vacuous: dropping the fallback branch of `triggerSeat.promote` (the
// `else if (inflightKey) { this.#inflightDispatch.attachDispatchPid(...) }` in
// event-dispatcher.ts) makes this seat stay pid:null in the fallback tracker,
// so it age-outs past INFLIGHT_RESERVATION_STALE_MS exactly like the
// characterization test above did before fdf6714e — calls.spawn.length would
// go to 2 instead of staying at 1.
test('ticket f0d1da19: fallback mode — handleTrigger\'s own promoted fallback seat survives the TTL while the process stays alive, so later triggers/mentions stay suppressed', async () => {
  const { dispatcher, calls } = makeDispatcher({ persistent: false });

  await dispatcher.handleTrigger(evJson());
  assert.equal(calls.spawn.length, 1, 'the column trigger dispatched its one-shot');

  const realNow = Date.now;
  Date.now = () => realNow() + INFLIGHT_RESERVATION_STALE_MS + 1;
  try {
    await dispatcher.handleTrigger(evJson());
    await dispatcher.handleCommentMention(mentionEvJson());
  } finally {
    Date.now = realNow;
  }
  assert.equal(
    calls.spawn.length,
    1,
    "past the TTL, the still-alive trigger one-shot's fallback seat stayed held (pid-verified, ticket fdf6714e's escape hatch) — neither the later trigger nor the mention twin-spawned",
  );
});

// ─────────── Part I: 2×2 dispatch seat contract parity table (ticket 8c15e7f7) ───────────
//
// 이 티켓 이전까지, 위에서 증명한 필수 assertion 세트 —
//   (1) spawn 성공 후 프로세스가 살아있는 동안 같은 (ticket, role, agent) seat 의
//       다른 경로 dispatch 가 억제된다 (twin 0)
//   (2) 그 억제가 INFLIGHT_RESERVATION_STALE_MS 및 safety-valve(연속 억제 N회 +
//       min-age)를 넘겨도 pid-liveness 로 유지된다 (= promote 가 실제로 배선돼 있다)
//   (3) onExit 발화 후엔 seat 가 풀려 다음 dispatch 가 정상 진행된다
// 는 handleTrigger/handleCommentMention × authoritative/fallback 4칸에 대해
// "발견한 순서대로, 각자 다른 티켓에서" 흩어져 쌓였다 — 13160d20(mention
// fallback), fdf6714e(fallback pid-liveness), f0d1da19(trigger 자신의 one-shot
// occupancy + pid 승격) 순서로, 매번 반대쪽 칸의 동일 결함을 뒤늦게 재발견했다
// (티켓 본문 "왜" 표 참고). 아래 표는 그 동일 assertion 세트를 4칸에 명시적으로,
// 균일하게 적용한다 — 칸이 늘면 SEAT_CELLS 에 행만 추가하면 된다.
//
// 각 셀은 claim(자기 경로로 seat 를 선점)과 probe(반대 경로로 같은 seat 를 재시도)
// 를 정의한다. 두 dispatch 경로가 서로의 점유를 못 보는 것이 이 계열 티켓들의
// 반복된 결함 패턴이었으므로 cross-path probe 가 이 계약을 검증하는 데 가장
// 직접적이다 — 같은 이유로 Part F/G/H 의 기존 테스트도 전부 cross-path 로
// 검증한다. 같은 경로끼리의 twin(같은 supervisor 가 같은 트리거를 재전송)
// 억제는 Part A/B 가 이미 별도로 증명했으므로 여기서 반복하지 않는다.
// 4칸 모두 동일한 mgr(failSpawn:true)로 통일한다 — authoritative 모드에서
// handleTrigger 가 probe 로 쓰일 때(handleCommentMention 행들) dispatchTrigger 의
// PERSISTENT 세션 경로가 그대로 성공해버리면 calls.spawn(one-shot 카운터)이 아니라
// mgr.spawnCount(영구 세션 카운터)만 늘어 이 테이블의 공통 신호(calls.spawn.length)가
// 거짓으로 안 늘어난 것처럼 보인다 — 실제 결함이 아니라 두 카운터를 섞어 쓴
// 테스트 자체의 구멍이었다(seat 가 풀리면 트리거는 어느 경로로든 정상 진행되는
// 것이 맞고, 그 자체는 이 티켓의 관심사가 아니다). failSpawn:true 는 fallback 모드
// 셀에서는 persistentTicket=false 라 dispatchTrigger 시도 자체가 스킵되므로
// 완전히 무해하다 — 그래서 4칸 모두에 안전하게 통일할 수 있다.
function makeSeatHarness(persistent) {
  return makeDispatcher({
    persistent,
    ticketMgr: new RealTicketMgrStub(makeConfig(), { failSpawn: true }),
  });
}

const SEAT_CELLS = [
  {
    label: 'handleTrigger — authoritative (persistent dispatch declined → one-shot, ticket f0d1da19)',
    makeHarness: () => makeSeatHarness(true),
    claim: (h) => h.dispatcher.handleTrigger(evJson()),
    probe: (h) => h.dispatcher.handleCommentMention(mentionEvJson()),
    tryReserve: (h) => h.mgr.tryReserveDispatch('t1', 'assignee', 'a1'),
  },
  {
    label: 'handleTrigger — fallback (persistentTicketSessions:false one-shot, ticket 3d180f85/f0d1da19)',
    makeHarness: () => makeSeatHarness(false),
    claim: (h) => h.dispatcher.handleTrigger(evJson()),
    probe: (h) => h.dispatcher.handleCommentMention(mentionEvJson()),
    tryReserve: (h) =>
      h.tracker.tryAcquireFallback(KEY('t1', 'assignee', 'a1'), {
        ticketId: 't1',
        role: 'assignee',
        agentId: 'a1',
      }),
  },
  {
    label: 'handleCommentMention — authoritative (role-mention one-shot, ticket e90294e7)',
    makeHarness: () => makeSeatHarness(true),
    claim: (h) => h.dispatcher.handleCommentMention(mentionEvJson()),
    probe: (h) => h.dispatcher.handleTrigger(evJson()),
    tryReserve: (h) => h.mgr.tryReserveDispatch('t1', 'assignee', 'a1'),
  },
  {
    label:
      'handleCommentMention — fallback (persistentTicketSessions:false role-mention one-shot, ticket 13160d20/fdf6714e)',
    makeHarness: () => makeSeatHarness(false),
    claim: (h) => h.dispatcher.handleCommentMention(mentionEvJson()),
    probe: (h) => h.dispatcher.handleTrigger(evJson()),
    tryReserve: (h) =>
      h.tracker.tryAcquireFallback(KEY('t1', 'assignee', 'a1'), {
        ticketId: 't1',
        role: 'assignee',
        agentId: 'a1',
      }),
  },
];

for (const cell of SEAT_CELLS) {
  // Non-vacuous: 이 경로/모드의 seat 클레임을 onExit 대신 spawn() 직후 즉시
  // release 하도록 되돌리면(f0d1da19/e90294e7 이전 상태), 아래 probe 가 억제되지
  // 않고 두 번째 one-shot 을 spawn 해 calls.spawn.length 가 1이 아니라 2가 된다.
  test(`[8c15e7f7 seat parity] ${cell.label}: claimed seat suppresses the SAME (ticket,role,agent) seat's dispatch through the other path while the process is alive`, async () => {
    const h = cell.makeHarness();
    await cell.claim(h);
    assert.equal(h.calls.spawn.length, 1, 'the claim spawned exactly one one-shot');
    assert.equal(
      typeof h.calls.spawn[0].onExit,
      'function',
      "the seat is held via onExit for the one-shot's full lifetime, not released the instant spawn() resolves",
    );

    await cell.probe(h);
    assert.equal(
      h.calls.spawn.length,
      1,
      'the cross-path probe found the seat still held and did not twin-spawn',
    );
  });

  // Non-vacuous: 이 경로/모드의 spawn-성공 분기에서 promote()/attachDispatchPid
  // 호출을 지우면(fdf6714e 이전 상태), pid 가 붙지 않은 예약은 나이만으로
  // 판정돼 아래 루프의 첫 반복부터 evicted:'stale'(또는 안전밸브 통과 후
  // evicted:'safety_valve')로 재claim 되어 acquired:false 검증이 즉시 깨지고,
  // 뒤이은 실 dispatcher 호출들도 twin-spawn 해 calls.spawn.length 가 커진다.
  test(`[8c15e7f7 seat parity] ${cell.label}: the suppression survives past INFLIGHT_RESERVATION_STALE_MS and the safety-valve window while the process stays alive`, async () => {
    const h = cell.makeHarness();
    await cell.claim(h);
    assert.equal(h.calls.spawn.length, 1);
    assert.equal(
      h.mgr._isPidAlive(h.calls.spawn[0].pid),
      true,
      "sanity: the claimed one-shot's real child is alive",
    );

    const realNow = Date.now;
    Date.now = () => realNow() + INFLIGHT_RESERVATION_STALE_MS + 5 * 60_000;
    try {
      for (let i = 0; i < INFLIGHT_SUPPRESS_SAFETY_VALVE + 3; i++) {
        const r = cell.tryReserve(h);
        assert.equal(
          r.acquired,
          false,
          `attempt #${i + 1} stays refused — a live pid overrides age-based eviction`,
        );
        assert.equal(r.evicted, undefined, 'a confirmed-alive pid is never TTL/safety-valve evicted');
      }
      // 위 루프는 registry 자체만 증명한다 — 실제 handleTrigger/
      // handleCommentMention 이 그 registry 를 올바르게 consult 하는지는 같은
      // 경로의 재시도(supervisor resend)와 반대 경로 dispatch 를 real
      // dispatcher 호출로 한 번씩 더 확인해야 증명된다.
      await cell.claim(h);
      await cell.probe(h);
    } finally {
      Date.now = realNow;
    }
    assert.equal(
      h.calls.spawn.length,
      1,
      'past the TTL/safety-valve window the still-alive one-shot kept the seat — neither the same-path retry nor the cross-path probe twin-spawned',
    );
  });

  // Non-vacuous: onExit 로 이어지는 release 배선을 통째로 지우면(seat 가 다시는
  // 풀리지 않으면), 아래 probe 가 영원히 억제된 채로 남아 calls.spawn.length 가
  // 2 가 아니라 1에 멈춘다.
  test(`[8c15e7f7 seat parity] ${cell.label}: once the one-shot exits (onExit fires), the seat is free again for the next dispatch`, async () => {
    const h = cell.makeHarness();
    await cell.claim(h);
    assert.equal(h.calls.spawn.length, 1);
    const onExit = h.calls.spawn[0].onExit;
    assert.equal(typeof onExit, 'function');

    onExit();

    await cell.probe(h);
    assert.equal(
      h.calls.spawn.length,
      2,
      'the seat was released on exit, so the following cross-path dispatch proceeded normally',
    );
  });

  // ticket 3b8f24ec: 4th assertion in the parity table — a force-respawn
  // TRIGGER suppressed while THIS cell's path holds the seat must replay
  // once that seat releases, regardless of whether the holder is a trigger
  // or a mention. The force probe is always handleTrigger (only a column
  // trigger ever carries force_respawn — mentions don't), unlike claim/probe
  // above which alternate by cell.
  //
  // Non-vacuous: before ticket 3b8f24ec, handleCommentMention's mentionSeat
  // omitted createDispatchSeat's `onReleased` hook, so cells 3/4 (mention
  // holder) never called InflightDispatchTracker.onRelease() on release —
  // the suppressed force stayed pending and calls.spawn.length stuck at 1
  // instead of reaching 2. Cells 1/2 (trigger holder) already wired this
  // (ticket f0d1da19) and pass either way — applying the assertion to all 4
  // cells uniformly is the point (board lesson: this bug class recurs one
  // cell at a time — 13160d20 → fdf6714e → f0d1da19 → 6de97a41 → 3b8f24ec).
  test(`[8c15e7f7 seat parity] ${cell.label}: a force-respawn trigger suppressed while this seat is held replays once the seat releases`, async () => {
    const h = cell.makeHarness();
    await cell.claim(h);
    assert.equal(h.calls.spawn.length, 1);
    const onExit = h.calls.spawn[0].onExit;
    assert.equal(typeof onExit, 'function');

    await h.dispatcher.handleTrigger(evJson({ force_respawn: true, field_changed: 'trig-force-F' }));
    assert.equal(h.calls.spawn.length, 1, 'the force-respawn was suppressed, not twin-spawned');
    assert.equal(h.tracker.suppressedCount('inflight_dispatch'), 1, 'the suppression was recorded');

    onExit();

    const replayed = await waitFor(() => h.calls.spawn.length === 2, { timeoutMs: 4000 });
    assert.equal(
      replayed,
      true,
      'the suppressed force_respawn replayed exactly once after the holder released its seat',
    );
  });
}

function isDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
