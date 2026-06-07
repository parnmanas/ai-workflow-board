// Unit test — classifyCliError (ticket 27806095).
//
// The one-shot exit handler uses this classifier to decide (a) whether an
// aggregated CLI result is a fatal-error report that must NOT be posted as an
// agent answer, and (b) whether the failure is non-retryable (usage-limit /
// auth) so the circuit-breaker opens immediately instead of after N failures.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCliError } from '../dist/lib/cli-error-signatures.js';

test('clean / empty input is non-fatal', () => {
  for (const v of [null, undefined, '', '   ', '\n\t']) {
    const c = classifyCliError(v);
    assert.equal(c.isFatal, false);
    assert.equal(c.nonRetryable, false);
    assert.equal(c.reason, '');
  }
});

test('a normal agent answer is non-fatal', () => {
  const c = classifyCliError('Here is the refactor you asked for. I updated foo.ts and added a test.');
  assert.equal(c.isFatal, false);
  assert.equal(c.nonRetryable, false);
});

test('codex usage-limit → fatal + non-retryable (the production incident text)', () => {
  const c = classifyCliError("[codex error] You've hit your usage limit. Upgrade to Pro to continue.");
  assert.equal(c.isFatal, true);
  assert.equal(c.nonRetryable, true);
  assert.equal(c.reason, 'usage_limit');
});

test('rate-limit / quota / 429 variants → non-retryable', () => {
  for (const s of [
    'Error: rate limited, retry later',
    'quota exceeded for this month',
    'HTTP 429 Too Many Requests',
    'You have exceeded your monthly limit',
  ]) {
    const c = classifyCliError(s);
    assert.equal(c.isFatal, true, `fatal: ${s}`);
    assert.equal(c.nonRetryable, true, `non-retryable: ${s}`);
  }
});

test('auth failures → fatal + non-retryable', () => {
  for (const s of [
    'Error: 401 Unauthorized',
    'authentication failed: invalid api key',
    'You are not logged in. Please run codex login.',
    'Forbidden (403)',
    'missing api key',
  ]) {
    const c = classifyCliError(s);
    assert.equal(c.isFatal, true, `fatal: ${s}`);
    assert.equal(c.nonRetryable, true, `non-retryable: ${s}`);
    assert.equal(c.reason, 'auth_failure');
  }
});

test('bare codex error (no usage/auth signature) → fatal but retryable', () => {
  const c = classifyCliError('[codex error] stream disconnected mid-turn');
  assert.equal(c.isFatal, true);
  assert.equal(c.nonRetryable, false);
  assert.equal(c.reason, 'codex_error');
});
