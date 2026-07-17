// Unit: durable dispatch outbox pure decision helpers (ticket e7c87517).
//
// These prove — WITHOUT a DataSource — the two load-bearing invariants the
// reviewer flagged:
//   1. `dispatchBackoffMs` is a capped exponential — no tight loop (floored at
//      base), no starvation (hard-capped at max).
//   2. `decideIntentReconcile` NEVER treats spawn success as resolution: only a
//      terminal / parked / archived / progressed / unstaffed ticket closes an
//      intent; a landed-but-silent dispatch stays OWED (→ dispatch/defer).
//   3. `readReconcilerConfig` clamps every knob so a fat-fingered env can't
//      disable the sub-24h guarantee or spin a hot retry loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const mod = await import('file://' + path.join(DIST, 'modules', 'agents', 'dispatch-intent.service.js'));
const { dispatchBackoffMs, decideIntentReconcile, DISPATCH_RECONCILE_SOURCE, __dispatch_test__ } = mod;
const { readReconcilerConfig, DISPATCH_RECONCILER_DEFAULTS } = __dispatch_test__;

test('dispatchBackoffMs — capped exponential (no tight loop, no starvation)', () => {
  const cfg = { baseBackoffMs: 1000, maxBackoffMs: 8000 };
  assert.equal(dispatchBackoffMs(1, cfg), 1000, 'attempt 1 = base');
  assert.equal(dispatchBackoffMs(2, cfg), 2000, 'attempt 2 = 2×base');
  assert.equal(dispatchBackoffMs(3, cfg), 4000, 'attempt 3 = 4×base');
  assert.equal(dispatchBackoffMs(4, cfg), 8000, 'attempt 4 = 8×base = cap');
  assert.equal(dispatchBackoffMs(5, cfg), 8000, 'attempt 5 capped at max — no starvation');
  assert.equal(dispatchBackoffMs(50, cfg), 8000, 'huge attempt count stays capped (no overflow)');
  assert.equal(dispatchBackoffMs(0, cfg), 1000, 'attempt 0 floored to base — never 0 (no hot loop)');
  assert.equal(dispatchBackoffMs(-5, cfg), 1000, 'negative floored to base');
});

test('decideIntentReconcile — resolution precedence; spawn is NOT resolution', () => {
  const base = {
    nowMs: 10_000, intentCreatedAtMs: 5_000, nextAttemptAtMs: 0,
    ticketMissing: false, archived: false, terminalOrUnrouted: false,
    parked: false, unstaffed: false, lastProgressAtMs: 0,
  };

  // Precedence — first match wins, all closing the intent.
  assert.deepEqual(decideIntentReconcile({ ...base, ticketMissing: true }), { action: 'resolve', reason: 'ticket_deleted' });
  assert.deepEqual(decideIntentReconcile({ ...base, archived: true }), { action: 'resolve', reason: 'archived' });
  assert.deepEqual(decideIntentReconcile({ ...base, terminalOrUnrouted: true }), { action: 'resolve', reason: 'terminal_or_unrouted' });
  assert.deepEqual(decideIntentReconcile({ ...base, parked: true }), { action: 'resolve', reason: 'parked' });
  // progressed = a forward-progress signal landed AFTER the intent was created.
  assert.deepEqual(
    decideIntentReconcile({ ...base, lastProgressAtMs: 6_000 }),
    { action: 'resolve', reason: 'progressed' },
    'progress after created_at resolves',
  );
  assert.deepEqual(decideIntentReconcile({ ...base, unstaffed: true }), { action: 'resolve', reason: 'unstaffed' });

  // CRITICAL (reviewer): NO everDispatched/processed input exists — a landed
  // dispatch with NO progress since creation is still OWED, never resolved.
  assert.deepEqual(
    decideIntentReconcile({ ...base, lastProgressAtMs: 5_000 }),
    { action: 'dispatch', reason: 'owed' },
    'progress AT created_at (not after) is not progress → still owed',
  );
  assert.deepEqual(
    decideIntentReconcile({ ...base, lastProgressAtMs: 0 }),
    { action: 'dispatch', reason: 'owed' },
    'zero progress + past backoff → dispatch (spawn success never closes it)',
  );

  // Backoff not elapsed → defer, not dispatch.
  assert.deepEqual(
    decideIntentReconcile({ ...base, nextAttemptAtMs: 20_000 }),
    { action: 'defer', reason: 'backoff' },
    'now < nextAttemptAt → defer',
  );

  // Terminal beats backoff — a resolved-worthy ticket closes even mid-backoff.
  assert.equal(
    decideIntentReconcile({ ...base, nextAttemptAtMs: 20_000, terminalOrUnrouted: true }).action,
    'resolve',
    'resolution precedence beats the backoff defer',
  );
});

test('readReconcilerConfig — clamps every knob within safe bounds', () => {
  // Absurd sweep → clamped under the 5-min ceiling (well below 24h guarantee).
  const hot = readReconcilerConfig({ DISPATCH_RECONCILER_SWEEP_MS: '1' });
  assert.ok(hot.sweepMs >= 15_000, 'sweep floored at 15s (no hot loop)');
  const slow = readReconcilerConfig({ DISPATCH_RECONCILER_SWEEP_MS: String(60 * 60_000) });
  assert.ok(slow.sweepMs <= 5 * 60_000, 'sweep capped at 5min (guarantee stays sub-24h)');

  // Backoff bounds.
  const tinyBackoff = readReconcilerConfig({ DISPATCH_RECONCILER_BASE_BACKOFF_MS: '1' });
  assert.ok(tinyBackoff.baseBackoffMs >= 10_000, 'base backoff floored at 10s');
  const hugeMax = readReconcilerConfig({ DISPATCH_RECONCILER_MAX_BACKOFF_MS: String(24 * 60 * 60_000) });
  assert.ok(hugeMax.maxBackoffMs <= 30 * 60_000, 'max backoff capped at 30min (no starvation)');

  // Disable flag.
  assert.equal(readReconcilerConfig({ DISPATCH_RECONCILER_ENABLED: 'false' }).enabled, false);
  assert.equal(readReconcilerConfig({}).enabled, DISPATCH_RECONCILER_DEFAULTS.enabled);

  // The reconcile source constant the emit chokepoint keys its skip-guard on.
  assert.equal(DISPATCH_RECONCILE_SOURCE, 'dispatch_reconcile');
});
