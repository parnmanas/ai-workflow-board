// Unit test — `ColumnRolePolicyService` glob matcher (ticket f886ada7).
//
// Verifies the small `globMatch(pattern, label)` helper exposed via the
// service's `__test__` namespace. The grammar is intentionally tiny — `*`
// wildcards only, case-insensitive — but the seeded default `BLOCKED-*`
// is what every workspace runs with on day one, so we lock the contract
// here so a regression can't quietly disable the gate-label legitimisation
// branch in the stuck detector.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const mod = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'column-policies', 'column-role-policy.service.js')
);
const { globMatch, parseRoleRouting, parseGateLabels } = mod.__test__;

test('globMatch — literal match, case-insensitive', () => {
  assert.equal(globMatch('blocked', 'BLOCKED'), true);
  assert.equal(globMatch('BLOCKED', 'blocked'), true);
  assert.equal(globMatch('Blocked', 'blocked'), true);
  assert.equal(globMatch('blocked', 'blockd'), false);
});

test('globMatch — single-trailing-* prefix wildcard', () => {
  assert.equal(globMatch('BLOCKED-*', 'BLOCKED-PHASE3'), true);
  assert.equal(globMatch('BLOCKED-*', 'blocked-phase3'), true);
  assert.equal(globMatch('BLOCKED-*', 'BLOCKED'), false, 'BLOCKED- prefix requires at least one trailing char or empty');
  assert.equal(globMatch('BLOCKED-*', 'OTHER-PHASE3'), false);
});

test('globMatch — empty inputs', () => {
  assert.equal(globMatch('', 'BLOCKED'), false);
  assert.equal(globMatch('BLOCKED-*', ''), false);
  assert.equal(globMatch('', ''), false);
});

test('globMatch — escape regex metachars in pattern', () => {
  // Real labels in the wild use dots / parens / brackets sometimes — the
  // matcher must treat them as literals, not regex syntax.
  assert.equal(globMatch('NEEDS.REVIEW', 'NEEDS.REVIEW'), true);
  assert.equal(globMatch('NEEDS.REVIEW', 'NEEDSXREVIEW'), false, 'dot must be literal');
  assert.equal(globMatch('NEEDS(*)', 'NEEDS(URGENT)'), true);
  assert.equal(globMatch('NEEDS(*)', 'NEEDS[URGENT]'), false);
});

test('parseRoleRouting — defensive against malformed JSON', () => {
  assert.deepEqual(parseRoleRouting('["assignee","reviewer"]'), ['assignee', 'reviewer']);
  assert.deepEqual(parseRoleRouting('[]'), []);
  assert.deepEqual(parseRoleRouting(''), []);
  assert.deepEqual(parseRoleRouting(null), []);
  assert.deepEqual(parseRoleRouting(undefined), []);
  assert.deepEqual(parseRoleRouting('{"not":"array"}'), []);
  assert.deepEqual(parseRoleRouting('not json'), []);
  // Filters out non-string / empty entries
  assert.deepEqual(parseRoleRouting('["a",null,"",42,"b"]'), ['a', 'b']);
});

test('parseGateLabels — same defensive shape as parseRoleRouting', () => {
  assert.deepEqual(parseGateLabels('["BLOCKED-*"]'), ['BLOCKED-*']);
  assert.deepEqual(parseGateLabels(''), []);
  assert.deepEqual(parseGateLabels('garbage'), []);
});
