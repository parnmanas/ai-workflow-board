// Unit test for the dependency-free 5-field cron evaluator (qa-cron.ts —
// ticket b6bb7efd). All evaluation is UTC. Covers parse validation, the
// next-firing walk, step/range/list grammar, and the Vixie-cron dom/dow OR rule.
//
// Imports the compiled module from dist/ (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, isValidCron, nextCronAfter } from '../dist/modules/qa/qa-cron.js';

test('isValidCron: accepts well-formed exprs, rejects malformed ones', () => {
  for (const ok of ['0 3 * * *', '*/15 * * * *', '0 0,12 * * 1-5', '30 9 1 1 *', '0 9-17/2 * * *']) {
    assert.ok(isValidCron(ok), `should accept "${ok}"`);
  }
  for (const bad of ['', '0 3 * *', '0 3 * * * *', '60 * * * *', '* 24 * * *', '0 0 0 1 *', '0 0 32 1 *', '0 0 * 13 *', '0 0 * * 7', 'a b c d e', '*/0 * * * *']) {
    assert.ok(!isValidCron(bad), `should reject "${bad}"`);
  }
});

test('nextCronAfter: daily "0 3 * * *" fires at the next 03:00 UTC', () => {
  // from 02:59 same day -> 03:00 same day
  let next = nextCronAfter('0 3 * * *', new Date('2026-06-25T02:59:00Z'));
  assert.equal(next.toISOString(), '2026-06-25T03:00:00.000Z');
  // from 03:00 exactly -> strictly AFTER, so next day 03:00
  next = nextCronAfter('0 3 * * *', new Date('2026-06-25T03:00:00Z'));
  assert.equal(next.toISOString(), '2026-06-26T03:00:00.000Z');
  // seconds are ignored (minute resolution): 03:00:30 -> next day
  next = nextCronAfter('0 3 * * *', new Date('2026-06-25T03:00:30Z'));
  assert.equal(next.toISOString(), '2026-06-26T03:00:00.000Z');
});

test('nextCronAfter: step minutes "*/15 * * * *" rounds up to the next quarter hour', () => {
  assert.equal(nextCronAfter('*/15 * * * *', new Date('2026-06-25T10:07:00Z')).toISOString(), '2026-06-25T10:15:00.000Z');
  assert.equal(nextCronAfter('*/15 * * * *', new Date('2026-06-25T10:15:00Z')).toISOString(), '2026-06-25T10:30:00.000Z');
  assert.equal(nextCronAfter('*/15 * * * *', new Date('2026-06-25T10:59:00Z')).toISOString(), '2026-06-25T11:00:00.000Z');
});

test('nextCronAfter: dow restriction "0 9 * * 1" fires on the next Monday 09:00 UTC', () => {
  // 2026-06-25 is a Thursday; next Monday is 2026-06-29.
  const next = nextCronAfter('0 9 * * 1', new Date('2026-06-25T12:00:00Z'));
  assert.equal(next.getUTCDay(), 1, 'lands on Monday');
  assert.equal(next.toISOString(), '2026-06-29T09:00:00.000Z');
});

test('nextCronAfter: Vixie OR rule — both dom AND dow restricted matches EITHER', () => {
  // "0 0 13 * 5" = midnight on the 13th OR any Friday. 2026-06-25 (Thu) ->
  // next Friday 2026-06-26 fires before the next 13th.
  const next = nextCronAfter('0 0 13 * 5', new Date('2026-06-25T12:00:00Z'));
  assert.equal(next.toISOString(), '2026-06-26T00:00:00.000Z', 'Friday matches via the OR rule');
});

test('nextCronAfter: unsatisfiable expression returns null (no infinite loop)', () => {
  // Feb 30 never exists; dom-only restriction so the OR rule cannot rescue it.
  assert.equal(nextCronAfter('0 0 30 2 *', new Date('2026-01-01T00:00:00Z')), null);
});

test('parseCron: list + range expand correctly', () => {
  const f = parseCron('0 0,12 1-3 * *');
  assert.deepEqual([...f.minute], [0]);
  assert.deepEqual([...f.hour].sort((a, b) => a - b), [0, 12]);
  assert.deepEqual([...f.dom].sort((a, b) => a - b), [1, 2, 3]);
  assert.ok(f.domRestricted, 'dom flagged restricted');
  assert.ok(!f.dowRestricted, 'dow not restricted');
});
