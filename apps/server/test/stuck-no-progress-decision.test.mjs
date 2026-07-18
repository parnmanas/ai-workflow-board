// Unit test — pure decideNoProgress + config clamp for the cause-agnostic
// no-progress hard-stall detector (ticket e7c87517). No NestJS boot / no DB:
// the threshold + pending logic is extracted into a pure function precisely so
// it is deterministically testable, mirroring decideForceRespawn's unit test.
//
// The load-bearing property proven here is the "24h no-progress is impossible"
// guarantee at the config level: whatever an operator puts in
// STUCK_DETECTOR_NO_PROGRESS_MS, the clamp keeps the threshold under 24h (and
// above a sane floor), so a zero-progress ticket is ALWAYS surfaced well before
// a day passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const mod = await import(
  'file://' + path.join(DIST, 'modules', 'agents', 'stuck-ticket-detector.service.js')
);
const { decideNoProgress, __test__ } = mod;

const H = 3_600_000;

test('decideNoProgress: age > threshold → stalled', () => {
  const now = 10_000_000;
  const r = decideNoProgress({ lastProgressAtMs: now - 4 * H, nowMs: now, noProgressMs: 3 * H, pending: false });
  assert.equal(r.stalled, true);
  assert.equal(r.ageMs, 4 * H);
});

test('decideNoProgress: age < threshold → not stalled', () => {
  const now = 10_000_000;
  const r = decideNoProgress({ lastProgressAtMs: now - 2 * H, nowMs: now, noProgressMs: 3 * H, pending: false });
  assert.equal(r.stalled, false);
});

test('decideNoProgress: exactly at threshold → stalled (>= boundary)', () => {
  const now = 10_000_000;
  const r = decideNoProgress({ lastProgressAtMs: now - 3 * H, nowMs: now, noProgressMs: 3 * H, pending: false });
  assert.equal(r.stalled, true);
});

test('decideNoProgress: a PENDING ticket is never a stall, regardless of age', () => {
  const now = 10_000_000;
  const r = decideNoProgress({ lastProgressAtMs: now - 48 * H, nowMs: now, noProgressMs: 3 * H, pending: true });
  assert.equal(r.stalled, false, 'a parked (human/prereq) ticket is intentionally idle, not stuck');
});

test('config: default no-progress threshold is 3h', () => {
  const def = __test__.readConfigFromEnv({});
  assert.equal(def.noProgressMs, 3 * H, 'default STUCK_DETECTOR_NO_PROGRESS_MS = 3h');
});

test('config clamp: a huge env value clamps under 24h (fat-finger cannot disable the guarantee)', () => {
  const hi = __test__.readConfigFromEnv({ STUCK_DETECTOR_NO_PROGRESS_MS: String(100 * H) });
  assert.ok(hi.noProgressMs <= 12 * H, 'clamps to the 12h ceiling');
  assert.ok(hi.noProgressMs < 24 * H, '24h no-progress is structurally impossible-without-alert');
});

test('config clamp: a tiny env value clamps up to the 30min floor', () => {
  const lo = __test__.readConfigFromEnv({ STUCK_DETECTOR_NO_PROGRESS_MS: '1000' });
  assert.ok(lo.noProgressMs >= 30 * 60_000, 'clamps up to the 30min floor');
});
