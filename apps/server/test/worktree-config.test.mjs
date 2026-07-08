// Worktree / merge convention — config module (worktree 규약 chain, ticket 4ba844ea).
//
// Covers the pure resolver + validator contract the whole chain hinges on:
//   (a) resolveBoardWorktreeMode is null-safe — null / undefined / unknown /
//       malformed all degrade to the regression baseline 'per_ticket'
//   (b) resolveBoardUsePr is null-safe — null/undefined → false, and it reads
//       the DB boolean, the sql.js 0/1 int, and "true"/"1" strings correctly
//   (c) the write-path validators REJECT a typo (so REST can 400) and ACCEPT +
//       normalize the valid / wire-encoded forms
//   (d) the defaults exported for reuse are exactly per_ticket / false
//
// Imports the compiled module from dist/ (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKTREE_MODES,
  DEFAULT_WORKTREE_MODE,
  DEFAULT_USE_PR,
  isWorktreeMode,
  resolveBoardWorktreeMode,
  resolveBoardUsePr,
  validateWorktreeModeInput,
  validateUsePrInput,
} from '../dist/common/worktree-config.js';

test('defaults are the regression baseline: per_ticket / false', () => {
  assert.deepEqual([...WORKTREE_MODES], ['per_ticket', 'shared']);
  assert.equal(DEFAULT_WORKTREE_MODE, 'per_ticket');
  assert.equal(DEFAULT_USE_PR, false);
});

test('isWorktreeMode: only the two known modes pass', () => {
  assert.equal(isWorktreeMode('per_ticket'), true);
  assert.equal(isWorktreeMode('shared'), true);
  assert.equal(isWorktreeMode('PER_TICKET'), false);
  assert.equal(isWorktreeMode('worktree'), false);
  assert.equal(isWorktreeMode(''), false);
  assert.equal(isWorktreeMode(null), false);
  assert.equal(isWorktreeMode(undefined), false);
  assert.equal(isWorktreeMode(1), false);
});

test('resolveBoardWorktreeMode: null-safe read, unknown → per_ticket', () => {
  assert.equal(resolveBoardWorktreeMode('per_ticket'), 'per_ticket');
  assert.equal(resolveBoardWorktreeMode('shared'), 'shared');
  // null / undefined / empty / garbage all fall back to the default
  assert.equal(resolveBoardWorktreeMode(null), 'per_ticket');
  assert.equal(resolveBoardWorktreeMode(undefined), 'per_ticket');
  assert.equal(resolveBoardWorktreeMode(''), 'per_ticket');
  assert.equal(resolveBoardWorktreeMode('nonsense'), 'per_ticket');
});

test('resolveBoardUsePr: null-safe read across bool / int / string encodings', () => {
  // native boolean
  assert.equal(resolveBoardUsePr(true), true);
  assert.equal(resolveBoardUsePr(false), false);
  // null / undefined → default false
  assert.equal(resolveBoardUsePr(null), false);
  assert.equal(resolveBoardUsePr(undefined), false);
  // sql.js 0/1 integer
  assert.equal(resolveBoardUsePr(1), true);
  assert.equal(resolveBoardUsePr(0), false);
  // string encodings
  assert.equal(resolveBoardUsePr('true'), true);
  assert.equal(resolveBoardUsePr('1'), true);
  assert.equal(resolveBoardUsePr('false'), false);
  assert.equal(resolveBoardUsePr('anything'), false);
});

test('validateWorktreeModeInput: rejects a typo, accepts the two modes', () => {
  assert.equal(validateWorktreeModeInput('per_ticket').ok, true);
  assert.deepEqual(validateWorktreeModeInput('shared'), { ok: true, value: 'shared' });

  const bad = validateWorktreeModeInput('per-ticket');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /worktree_mode must be one of/);

  assert.equal(validateWorktreeModeInput(null).ok, false);
  assert.equal(validateWorktreeModeInput(undefined).ok, false);
  assert.equal(validateWorktreeModeInput(1).ok, false);
});

test('validateUsePrInput: accepts bool + wire encodings, rejects genuine non-boolean', () => {
  assert.deepEqual(validateUsePrInput(true), { ok: true, value: true });
  assert.deepEqual(validateUsePrInput(false), { ok: true, value: false });
  // common wire encodings normalise to a real boolean
  assert.deepEqual(validateUsePrInput(1), { ok: true, value: true });
  assert.deepEqual(validateUsePrInput('true'), { ok: true, value: true });
  assert.deepEqual(validateUsePrInput(0), { ok: true, value: false });
  assert.deepEqual(validateUsePrInput('false'), { ok: true, value: false });

  // genuine non-boolean 400s instead of being coerced
  const bad = validateUsePrInput('yes');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /use_pr must be a boolean/);
  assert.equal(validateUsePrInput(2).ok, false);
  assert.equal(validateUsePrInput({}).ok, false);
  assert.equal(validateUsePrInput(null).ok, false);
});
