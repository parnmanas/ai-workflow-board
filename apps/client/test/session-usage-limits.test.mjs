import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionLimitWindows, mergeSessionLimitEvents } from '../src/components/sessions/sessionUsageLimits.logic.ts';
import { buildTranscript } from '../src/components/sessions/sessionTranscript.logic.ts';
const event = (at, used) => ({ id: at, seq: 1, turn_id: '', type: 'usage_limits', created_at: at, payload: {
  limit_id: 'provider', observed_at: at, windows: [{ id: 'primary', used_percent: used, window_minutes: 300, resets_at: '2026-10-28T00:00:00Z' }],
} });

test('latest quota replaces previous percentages; delayed history cannot overwrite it', () => {
  const current = event('2026-10-27T12:00:00Z', 80);
  const old = event('2026-10-27T11:00:00Z', 20);
  assert.equal(sessionLimitWindows([current, old])[0].usedPercent, 80);
  assert.equal(sessionLimitWindows([old, current])[0].usedPercent, 80);
  assert.equal(sessionLimitWindows([event('2026-10-27T13:00:00Z', 0)])[0].usedPercent, 0);
  assert.deepEqual(buildTranscript([old, current]), [], 'quota metadata never renders as chat content');
});

test('missing or malformed measurements remain unknown rather than zero', () => {
  assert.deepEqual(sessionLimitWindows([]), []);
  assert.deepEqual(sessionLimitWindows([event('bad-date', 20)]), []);
  assert.deepEqual(sessionLimitWindows([event('2026-10-27T12:00:00Z', null)]), []);
  assert.deepEqual(sessionLimitWindows([event('2026-10-27T12:00:00Z', NaN)]), []);
});


test('focus snapshots keep only the newest valid quota per limit', () => {
  const newer = event('2026-10-27T12:00:00Z', 68);
  const old = event('2026-10-27T11:00:00Z', 20);
  assert.deepEqual(mergeSessionLimitEvents([newer], [old]), [newer]);
  assert.deepEqual(mergeSessionLimitEvents([old], [newer, newer]), [newer]);
  assert.deepEqual(mergeSessionLimitEvents([newer], [event('invalid', 20)]), [newer]);
});
