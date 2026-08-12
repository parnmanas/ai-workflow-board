// Unit test — CircuitBreaker non-transient exit classification and dispatch gating.
//
// Validates:
//   (a) Non-transient exits (exit 0 w/ no comment, exit 41, etc.) increment
//       the failure counter and open the breaker after threshold (default 5).
//   (b) Transient exits (143/SIGTERM, 137/SIGKILL, 130/SIGINT) do NOT count.
//   (c) An open breaker blocks dispatch (shouldBlock returns reason string).
//   (d) reset() / resetAgent() clears the breaker.
//   (e) After cooldown, a half-open probe is allowed through.
//   (f) recordSuccess() (ticket b2e88390) only auto-clears a streak that
//       hadn't tripped yet — an already-OPEN breaker stays open until a
//       human/operator calls resetAgent() (restart_agent).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker } from '../dist/lib/circuit-breaker.js';

test('CircuitBreaker.isTransientExit classifies exit codes correctly', () => {
  // Transient — should NOT trip the breaker
  assert.equal(CircuitBreaker.isTransientExit(143), true, 'SIGTERM is transient');
  assert.equal(CircuitBreaker.isTransientExit(137), true, 'SIGKILL is transient');
  assert.equal(CircuitBreaker.isTransientExit(130), true, 'SIGINT is transient');
  assert.equal(CircuitBreaker.isTransientExit(null), true, 'null signal is transient');

  // Non-transient — should trip the breaker
  assert.equal(CircuitBreaker.isTransientExit(0), false, 'clean exit (no comment) is non-transient');
  assert.equal(CircuitBreaker.isTransientExit(41), false, 'gemini auth error is non-transient');
  assert.equal(CircuitBreaker.isTransientExit(1), false, 'generic error is non-transient');
  assert.equal(CircuitBreaker.isTransientExit(2), false, 'misuse is non-transient');
});

test('breaker opens after threshold consecutive failures', () => {
  const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'reviewer');

  // First two failures — breaker stays closed
  let r1 = cb.record(key, 41, 'Please set GEMINI_API_KEY');
  assert.equal(r1.justOpened, false);
  assert.equal(cb.shouldBlock(key), null);

  let r2 = cb.record(key, 41, 'Please set GEMINI_API_KEY');
  assert.equal(r2.justOpened, false);
  assert.equal(cb.shouldBlock(key), null);

  // Third failure — breaker opens
  let r3 = cb.record(key, 41, 'Please set GEMINI_API_KEY');
  assert.equal(r3.justOpened, true);
  assert.equal(r3.entry.consecutiveFailures, 3);

  // Now dispatch should be blocked
  const reason = cb.shouldBlock(key);
  assert.ok(reason, 'shouldBlock returns a reason string');
  assert.ok(reason.includes('circuit_breaker_open'));
  assert.ok(reason.includes('3 consecutive'));
});

test('default threshold is 5 consecutive failures before opening', () => {
  const cb = new CircuitBreaker(); // no opts → DEFAULT_THRESHOLD
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  // Four failures — breaker stays closed
  for (let i = 1; i <= 4; i++) {
    const r = cb.record(key, 41, 'Please set GEMINI_API_KEY');
    assert.equal(r.justOpened, false, `failure ${i} should not open the breaker`);
    assert.equal(r.entry.consecutiveFailures, i);
    assert.equal(cb.shouldBlock(key), null, `dispatch allowed after ${i} failures`);
  }

  // Fifth consecutive failure — breaker opens and ticket should pend
  const r5 = cb.record(key, 41, 'Please set GEMINI_API_KEY');
  assert.equal(r5.justOpened, true, 'fifth consecutive failure opens the breaker');
  assert.equal(r5.entry.consecutiveFailures, 5);
  assert.ok(cb.shouldBlock(key), 'dispatch blocked after 5 failures');
});

test('a successful response mid-streak resets the count (no pend before 5 consecutive)', () => {
  const cb = new CircuitBreaker(); // default threshold = 5
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  // 4 failures, then a success (agent posts a comment → reset() is called)
  for (let i = 0; i < 4; i++) cb.record(key, 41, 'boom');
  cb.reset(key); // success clears the counter

  // 4 more failures — still below threshold because the streak restarted
  for (let i = 1; i <= 4; i++) {
    const r = cb.record(key, 41, 'boom');
    assert.equal(r.justOpened, false, `post-reset failure ${i} should not open the breaker`);
  }
  assert.equal(cb.shouldBlock(key), null, 'still not blocked — only 4 consecutive since reset');

  // The 5th consecutive failure since the reset finally opens it
  const r5 = cb.record(key, 41, 'boom');
  assert.equal(r5.justOpened, true, '5 consecutive failures after reset opens the breaker');
  assert.equal(r5.entry.consecutiveFailures, 5);
});

test('reset clears the breaker', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  cb.record(key, 0);
  cb.record(key, 0); // opens
  assert.ok(cb.shouldBlock(key));

  cb.reset(key);
  assert.equal(cb.shouldBlock(key), null, 'after reset, dispatch is allowed');
});

// ---------------------------------------------------------------------------
// ticket b2e88390 — a lucky success must not silently fully close a breaker
// that already tripped and surfaced to a human via pend_ticket. recordSuccess()
// is what the real "agent succeeded" call sites use (subagent-manager.ts,
// ticket-session-manager.ts) — reset() itself stays available but is now
// reserved for explicit human/operator paths (resetAgent() / restart_agent).
// ---------------------------------------------------------------------------

test('recordSuccess on a sub-threshold (not-yet-open) streak clears it — same as reset()', () => {
  const cb = new CircuitBreaker(); // default threshold = 5
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  for (let i = 0; i < 4; i++) cb.record(key, 41, 'boom'); // below threshold, still closed
  cb.recordSuccess(key);

  // Streak restarted — 4 more failures still don't open it.
  for (let i = 1; i <= 4; i++) {
    const r = cb.record(key, 41, 'boom');
    assert.equal(r.justOpened, false, `post-recordSuccess failure ${i} should not open the breaker`);
  }
  assert.equal(cb.shouldBlock(key), null, 'still not blocked — only 4 consecutive since recordSuccess');
});

test('recordSuccess on a key with no entry at all is a harmless no-op', () => {
  const cb = new CircuitBreaker();
  const key = CircuitBreaker.key('agent-1', 'never-failed', 'assignee');
  assert.doesNotThrow(() => cb.recordSuccess(key));
  assert.equal(cb.shouldBlock(key), null);
});

test('recordSuccess on an OPEN breaker does NOT clear it — stays open for a human/operator', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  cb.record(key, 0);
  cb.record(key, 0); // opens — this is what pend_ticket fired against
  assert.ok(cb.shouldBlock(key), 'open right after threshold');

  // A half-open probe (or a mid-run comment) succeeds...
  cb.recordSuccess(key);

  // ...but the breaker is still open — one success is not a human sign-off.
  assert.ok(cb.shouldBlock(key), 'still blocked after a single success — recordSuccess must not auto-close an open breaker');
  assert.equal(cb.getOpenBreakers().length, 1, 'entry is still tracked as open');
});

test('recordSuccess on an OPEN breaker leaves it clearable only via resetAgent (operator path)', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  cb.record(key, 0);
  cb.record(key, 0); // opens
  cb.recordSuccess(key); // probe succeeded, stays open (see prior test)
  assert.ok(cb.shouldBlock(key));

  cb.resetAgent('agent-1'); // the restart_agent (human/operator) path
  assert.equal(cb.shouldBlock(key), null, 'operator resetAgent() still fully closes it');
});

test('resetAgent clears all entries for that agent', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const key1 = CircuitBreaker.key('agent-1', 'ticket-1', 'reviewer');
  const key2 = CircuitBreaker.key('agent-1', 'ticket-2', 'assignee');
  const key3 = CircuitBreaker.key('agent-2', 'ticket-3', 'reviewer');

  cb.record(key1, 41); cb.record(key1, 41); // opens
  cb.record(key2, 41); cb.record(key2, 41); // opens
  cb.record(key3, 1);  cb.record(key3, 1);  // opens

  cb.resetAgent('agent-1');
  assert.equal(cb.shouldBlock(key1), null, 'agent-1 key1 cleared');
  assert.equal(cb.shouldBlock(key2), null, 'agent-1 key2 cleared');
  assert.ok(cb.shouldBlock(key3), 'agent-2 key3 still blocked');
});

test('half-open probe allowed after cooldown', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100 }); // 100ms cooldown for test
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  cb.record(key, 41);
  cb.record(key, 41); // opens

  // Immediately blocked
  assert.ok(cb.shouldBlock(key));

  // Manually advance openedAt to simulate cooldown elapsed
  const entry = cb.getOpenBreakers()[0].entry;
  entry.openedAt = Date.now() - 200; // 200ms ago, past 100ms cooldown

  // Now should allow through (half-open probe)
  assert.equal(cb.shouldBlock(key), null, 'probe allowed after cooldown');
});

// ---------------------------------------------------------------------------
// ticket 970d6692 — round 1 made shouldBlock() a fully pure read so both
// gates checking the SAME logical spawn attempt would agree. Review round 2
// caught that a FULLY pure read also lets a genuinely SEPARATE concurrent
// attempt for the same key sail through during the same half-open window
// (breaking the "single probe" invariant), and that recordSuccess() leaving
// `openedAt` untouched meant the elapsed-since-open condition, once true,
// stayed true forever — a permanent bypass, not a permanent block.
//
// The fix: `entry.lastProbeAt` anchors a rolling "one probe granted per
// cooldown window" throttle (see shouldBlock() in circuit-breaker.ts), and
// event-dispatcher.ts now calls shouldBlock() at most ONCE per logical
// attempt — dispatchTrigger's own check result is threaded into the one-shot
// fallback spawn() via `SubagentSpawnArgs.circuitBreakerDecision` instead of
// letting spawn() re-query (see the integration test in
// dispatch-inflight-guard.test.mjs: 'dispatchTrigger's circuit-breaker pass
// is honored by the one-shot fallback, not re-blocked').
// ---------------------------------------------------------------------------

test('a second, independent shouldBlock() check right after cooldown is blocked — only one probe per window', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'reviewer');

  cb.record(key, 1);
  cb.record(key, 1); // opens

  const entry = cb.getOpenBreakers()[0].entry;
  entry.openedAt = Date.now() - 200; // simulate cooldown elapsed

  // Attempt A: the first caller to check after cooldown elapses — e.g. the
  // ticket-trigger dispatch path.
  const attemptA = cb.shouldBlock(key);
  // Attempt B: a genuinely SEPARATE, concurrent attempt for the SAME key
  // (e.g. a comment-mention one-shot racing the ticket trigger) — NOT a
  // second gate re-checking attempt A's own already-granted spawn.
  const attemptB = cb.shouldBlock(key);

  assert.equal(attemptA, null, 'the first attempt is granted the half-open probe');
  assert.ok(attemptB, 'a second, independent concurrent attempt must NOT also get a probe');
  assert.ok(attemptB.includes('circuit_breaker_open'));
});

test('after a granted probe succeeds, the breaker stays open and the NEXT probe still needs a fresh cooldown', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  cb.record(key, 1);
  cb.record(key, 1); // opens
  const entry = cb.getOpenBreakers()[0].entry;
  entry.openedAt = Date.now() - 200; // cooldown elapsed

  assert.equal(cb.shouldBlock(key), null, 'half-open probe granted');
  cb.recordSuccess(key); // the probed spawn posted a real comment

  // Immediately after: still open (ticket b2e88390 — one success is not an
  // operator sign-off), and the next probe is a fresh cooldown away from the
  // grant, not immediately available again — recordSuccess() must not have
  // reopened the window early.
  assert.ok(cb.shouldBlock(key), 'still open right after a single success');
  assert.equal(cb.getOpenBreakers().length, 1, 'recordSuccess must not auto-close an open breaker');

  // Once another full cooldown has elapsed since that probe's grant, the
  // breaker allows exactly one more — repeating indefinitely until an
  // operator calls resetAgent() (restart_agent) or a real post-probe failure
  // re-stamps openedAt via record().
  entry.lastProbeAt = Date.now() - 200;
  assert.equal(cb.shouldBlock(key), null, 'a fresh cooldown since the last grant allows another probe');
});

test('shouldBlock() does not mutate openedAt — repeated blocked checks do not reset the cooldown', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  cb.record(key, 1);
  cb.record(key, 1); // opens
  const entry = cb.getOpenBreakers()[0].entry;
  const openedAt = entry.openedAt;

  // Several re-triggers arrive while still within cooldown (blocked).
  cb.shouldBlock(key);
  cb.shouldBlock(key);
  cb.shouldBlock(key);

  assert.equal(entry.openedAt, openedAt, 'repeated blocked checks must not reset openedAt / extend the cooldown');
});

test('a half-open probe that fails again restarts the cooldown via record(), not shouldBlock()', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  cb.record(key, 1);
  const opened = cb.record(key, 1); // opens
  assert.equal(opened.justOpened, true);

  const entry = cb.getOpenBreakers()[0].entry;
  entry.openedAt = Date.now() - 200; // simulate cooldown elapsed
  const preProbeOpenedAt = entry.openedAt;

  assert.equal(cb.shouldBlock(key), null, 'half-open probe allowed — reaches spawn');
  assert.equal(entry.openedAt, preProbeOpenedAt, 'shouldBlock() must not have touched openedAt');

  // The probe actually spawned and the retry failed again.
  const retried = cb.record(key, 1);
  assert.equal(retried.justOpened, false, 'repeat open must not re-fire pend_ticket');
  assert.ok(entry.openedAt > preProbeOpenedAt, 'a real post-probe failure restarts the cooldown');

  const reason = cb.shouldBlock(key);
  assert.ok(reason, 'freshly re-opened breaker blocks again with a fresh cooldown');
  assert.ok(reason.includes('circuit_breaker_open'));
});

// ---------------------------------------------------------------------------
// mem-leak v2 (f500ee56): #state must stay bounded over uptime. A key that
// fails below threshold then is abandoned, or an open breaker whose ticket is
// gone, used to persist forever. sweep()/the on-insert sweep + LRU cap fix it.
// ---------------------------------------------------------------------------

test('sweep() drops keys with no failure within the stale window', () => {
  const cb = new CircuitBreaker({ cooldownMs: 1000, staleMs: 1000 });
  cb.record(CircuitBreaker.key('a', 't1', 'assignee'), 41);
  cb.record(CircuitBreaker.key('a', 't2', 'assignee'), 41);
  assert.equal(cb.size, 2);

  // No time has passed — nothing is stale yet.
  assert.equal(cb.sweep(Date.now()), 0);
  assert.equal(cb.size, 2);

  // Far enough in the future that both are past the stale window.
  const removed = cb.sweep(Date.now() + 5000);
  assert.equal(removed, 2, 'both abandoned keys swept');
  assert.equal(cb.size, 0);
});

test('an abandoned OPEN breaker is collapsed once past the stale window', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, staleMs: 1000 });
  const key = CircuitBreaker.key('a', 't1', 'assignee');
  cb.record(key, 0);
  cb.record(key, 0); // opens
  assert.equal(cb.getOpenBreakers().length, 1);

  cb.sweep(Date.now() + 5000);
  assert.equal(cb.size, 0, 'open-but-abandoned breaker does not persist forever');
});

test('the on-insert sweep keeps the map from accumulating stale keys', () => {
  // staleMs tiny so any prior key is immediately stale on the next insert.
  const cb = new CircuitBreaker({ threshold: 100, cooldownMs: 1, staleMs: 1 });
  cb.record(CircuitBreaker.key('a', 't1', 'assignee'), 41); // size 1
  // Busy-wait past the 1ms stale window without a fake clock.
  const until = Date.now() + 5;
  while (Date.now() < until) { /* spin */ }
  cb.record(CircuitBreaker.key('a', 't2', 'assignee'), 41);
  // t1 was swept by the insert of t2 — only the fresh key remains.
  assert.equal(cb.size, 1, 'on-insert sweep collapsed the abandoned key');
});

test('#state is bounded by maxKeys — oldest closed key evicted on overflow', () => {
  const cb = new CircuitBreaker({ threshold: 100, maxKeys: 10, cooldownMs: 60_000 });
  // 50 distinct sub-threshold (closed) keys; nothing is stale (60s cooldown).
  for (let i = 0; i < 50; i++) {
    cb.record(CircuitBreaker.key('a', 't' + i, 'assignee'), 41);
  }
  assert.equal(cb.size, 10, 'map capped at maxKeys');
});

test('cap eviction preserves live open breakers over closed ones', () => {
  const cb = new CircuitBreaker({ threshold: 2, maxKeys: 3, cooldownMs: 60_000 });
  const open1 = CircuitBreaker.key('a', 'open1', 'r');
  cb.record(open1, 0);
  cb.record(open1, 0); // open, and the oldest entry by lastFailureAt
  cb.record(CircuitBreaker.key('a', 'c1', 'r'), 41); // closed
  cb.record(CircuitBreaker.key('a', 'c2', 'r'), 41); // closed; size now 3 (full)
  cb.record(CircuitBreaker.key('a', 'c3', 'r'), 41); // overflow → evicts a closed key

  assert.equal(cb.size, 3);
  assert.ok(cb.shouldBlock(open1), 'open breaker preserved despite being oldest');
});

test('getOpenBreakers returns only open entries', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const key1 = CircuitBreaker.key('agent-1', 'ticket-1', 'reviewer');
  const key2 = CircuitBreaker.key('agent-1', 'ticket-2', 'assignee');

  cb.record(key1, 41);          // 1 failure, not open
  cb.record(key2, 0);
  cb.record(key2, 0);           // opens

  const open = cb.getOpenBreakers();
  assert.equal(open.length, 1);
  assert.equal(open[0].key, key2);
});
