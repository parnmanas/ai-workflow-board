// Unit test — CircuitBreaker non-transient exit classification and dispatch gating.
//
// Validates:
//   (a) Non-transient exits (exit 0 w/ no comment, exit 41, etc.) increment
//       the failure counter and open the breaker after threshold (default 3).
//   (b) Transient exits (143/SIGTERM, 137/SIGKILL, 130/SIGINT) do NOT count.
//   (c) An open breaker blocks dispatch (shouldBlock returns reason string).
//   (d) reset() / resetAgent() clears the breaker.
//   (e) After cooldown, a half-open probe is allowed through.

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

test('reset clears the breaker', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');

  cb.record(key, 0);
  cb.record(key, 0); // opens
  assert.ok(cb.shouldBlock(key));

  cb.reset(key);
  assert.equal(cb.shouldBlock(key), null, 'after reset, dispatch is allowed');
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
