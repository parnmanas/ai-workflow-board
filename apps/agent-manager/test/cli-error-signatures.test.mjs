// Unit test — classifyCliError (ticket 27806095).
//
// The one-shot exit handler uses this classifier to decide (a) whether an
// aggregated CLI result is a fatal-error report that must NOT be posted as an
// agent answer, and (b) whether the failure is non-retryable (usage-limit /
// auth) so the circuit-breaker opens immediately instead of after N failures.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCliError, isFallbackEligible } from '../dist/lib/cli-error-signatures.js';
import { buildModelChain } from '../dist/lib/cli-adapters/base.js';

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
  // The [codex error] wrapper is itself the error context — no exit code needed.
  const c = classifyCliError("[codex error] You've hit your usage limit. Upgrade to Pro to continue.");
  assert.equal(c.isFatal, true);
  assert.equal(c.nonRetryable, true);
  assert.equal(c.reason, 'usage_limit');
});

test('rate-limit / quota / 429 variants → non-retryable (with error context)', () => {
  for (const s of [
    'Error: rate limited, retry later',
    'quota exceeded for this month',
    'HTTP 429 Too Many Requests',
    'You have exceeded your monthly limit',
  ]) {
    // A non-zero exit code supplies the error context.
    const c = classifyCliError(s, { exitCode: 1 });
    assert.equal(c.isFatal, true, `fatal: ${s}`);
    assert.equal(c.nonRetryable, true, `non-retryable: ${s}`);
  }
});

test('auth failures → fatal + non-retryable (with error context)', () => {
  for (const s of [
    'Error: 401 Unauthorized',
    'authentication failed: invalid api key',
    'You are not logged in. Please run codex login.',
    'Forbidden (403)',
    'missing api key',
  ]) {
    const c = classifyCliError(s, { exitCode: 1 });
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

// Regression (reviewer blocker): usage/auth signatures are common substrings of
// legitimate SWE answers. A clean exit-0 codex answer that merely *mentions*
// these terms must pass through as a valid agent answer — not be suppressed,
// not trip the breaker, not pend the ticket.
test('clean exit-0 answer mentioning 403/quota/429 → NOT fatal (no false positive)', () => {
  for (const s of [
    'Done — added a 403 Forbidden response for unauthorized users in auth.guard.ts.',
    'Added 429/quota handling to the rate limiter and a test for the monthly limit path.',
    'Refactored the unauthorized branch; the endpoint now returns 401 with a clear message.',
    'Implemented insufficient_quota retry/backoff and documented the upgrade to Pro flow.',
  ]) {
    const c = classifyCliError(s, { exitCode: 0 });
    assert.equal(c.isFatal, false, `not fatal: ${s}`);
    assert.equal(c.nonRetryable, false, `not non-retryable: ${s}`);
    assert.equal(c.reason, '', `no reason: ${s}`);
  }
});

test('no exit code + answer mentioning auth/usage terms → NOT fatal (needs error context)', () => {
  // Without an exit code and without a [codex error] wrapper there is no error
  // context, so the same wording stays a valid answer.
  const c = classifyCliError('We now return 403 Forbidden when the quota is exceeded.');
  assert.equal(c.isFatal, false);
  assert.equal(c.nonRetryable, false);
});

test('usage/auth wording with a non-zero exit → fatal (real failure context)', () => {
  const c = classifyCliError('request failed: 429 Too Many Requests', { exitCode: 1 });
  assert.equal(c.isFatal, true);
  assert.equal(c.nonRetryable, true);
  assert.equal(c.reason, 'usage_limit');
});

// ── 폴백 모델 체인 (ticket 61f4dd18) ──────────────────────────────

test('model-unavailable signatures → fatal + non-retryable + reason=model_unavailable', () => {
  for (const s of [
    'Error: model not found: claude-opus-9',
    'unknown model "gpt-nonexistent"',
    'The model claude-foo does not exist or you do not have access to it.',
    'invalid model specified',
    'model claude-bar is not available on your plan',
    'Your account does not have access to the model requested.',
  ]) {
    const c = classifyCliError(s, { exitCode: 1 });
    assert.equal(c.isFatal, true, `fatal: ${s}`);
    assert.equal(c.nonRetryable, true, `non-retryable: ${s}`);
    assert.equal(c.reason, 'model_unavailable', `reason: ${s}`);
  }
});

test('model-unavailable wording in a clean exit-0 answer → NOT fatal (false-positive guard)', () => {
  const c = classifyCliError(
    'Added handling for the "model not found" error path with a friendly message.',
    { exitCode: 0 },
  );
  assert.equal(c.isFatal, false);
  assert.equal(c.reason, '');
});

test('isFallbackEligible: usage_limit + model_unavailable are eligible; auth/codex are not', () => {
  const usage = classifyCliError('[codex error] hit your usage limit');
  const model = classifyCliError('unknown model xyz', { exitCode: 1 });
  const auth = classifyCliError('401 Unauthorized', { exitCode: 1 });
  const codex = classifyCliError('[codex error] stream disconnected');
  const clean = classifyCliError('all good', { exitCode: 0 });
  assert.equal(isFallbackEligible(usage), true, 'usage_limit eligible');
  assert.equal(isFallbackEligible(model), true, 'model_unavailable eligible');
  assert.equal(isFallbackEligible(auth), false, 'auth NOT eligible (same credential)');
  assert.equal(isFallbackEligible(codex), false, 'codex_error NOT eligible (plain retry)');
  assert.equal(isFallbackEligible(clean), false, 'clean answer NOT eligible');
});

test('buildModelChain: head = primary, fallbacks appended in order, dupes/blanks dropped', () => {
  assert.deepEqual(buildModelChain('opus', ['sonnet', 'haiku']), ['opus', 'sonnet', 'haiku']);
  // null / empty primary → head is null (CLI default), fallbacks still ride.
  assert.deepEqual(buildModelChain(null, ['sonnet']), [null, 'sonnet']);
  assert.deepEqual(buildModelChain('   ', ['sonnet']), [null, 'sonnet']);
  // primary duplicated in fallbacks is not repeated; blanks + later dupes drop.
  assert.deepEqual(buildModelChain('opus', ['opus', ' ', 'sonnet', 'sonnet']), ['opus', 'sonnet']);
  // no fallbacks → single-element chain (no fallback attempts).
  assert.deepEqual(buildModelChain('opus', undefined), ['opus']);
  assert.deepEqual(buildModelChain('opus', []), ['opus']);
});
