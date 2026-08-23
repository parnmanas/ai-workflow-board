// Unit test — classifyCliError (ticket 27806095).
//
// The one-shot exit handler uses this classifier to decide (a) whether an
// aggregated CLI result is a fatal-error report that must NOT be posted as an
// agent answer, and (b) whether the failure is non-retryable (usage-limit /
// auth) so the circuit-breaker opens immediately instead of after N failures.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCliError, isFallbackEligible } from '../dist/lib/cli-error-signatures.js';
import { buildModelChain, resolveModelChain } from '../dist/lib/cli-adapters/base.js';

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

// ticket 467f714a: the harness SESSION-limit line is distinct from usage_limit —
// it heals by TIME (defer to reset), so it must classify as `session_limit` and
// NOT be fallback-eligible (a different model on the same account still hits the
// session wall). This is the exact string that killed d34075b5's dispatch loop.
test('harness session limit (the d34075b5 incident text) → session_limit, non-retryable, NOT fallback', () => {
  const c = classifyCliError(
    "You've hit your session limit · resets 12:30am (Asia/Seoul)",
    { exitCode: 1 },
  );
  assert.equal(c.isFatal, true);
  assert.equal(c.nonRetryable, true);
  assert.equal(c.reason, 'session_limit', 'labeled session_limit, not usage_limit');
  assert.equal(isFallbackEligible(c), false, 'a model switch cannot clear a session cap');
});

test('session-limit variants → session_limit (with error context)', () => {
  for (const s of [
    "You've hit your session limit · resets 3pm (America/New_York)",
    'session limit reached; try again later',
    'You have reached your weekly limit for this model',
    'You have hit your 5-hour limit',
  ]) {
    const c = classifyCliError(s, { exitCode: 1 });
    assert.equal(c.isFatal, true, `fatal: ${s}`);
    assert.equal(c.reason, 'session_limit', `session_limit: ${s}`);
  }
});

test('clean exit-0 answer mentioning "session limit" → NOT fatal (no false positive)', () => {
  const c = classifyCliError(
    'Added a session limit banner to the settings page and a test for the reset copy.',
    { exitCode: 0 },
  );
  assert.equal(c.isFatal, false);
  assert.equal(c.reason, '');
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

// ── 컨텍스트 윈도우/출력 토큰 초과 (ticket 7d8ea7c9 후속) ──────────────

test('context-window/출력 토큰 초과 신호 → fatal + 재시도불가, fallback 대상 아님', () => {
  for (const s of [
    "Claude's response exceeded the output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
    'The model has reached its context window limit.',
    'tengu_context_window_exceeded',
    'tengu_max_tokens_reached',
    'model_context_window_exceeded: request too large',
  ]) {
    const c = classifyCliError(s, { exitCode: 1 });
    assert.equal(c.isFatal, true, `치명적이어야 함: ${s}`);
    assert.equal(c.nonRetryable, true, `재시도불가여야 함: ${s}`);
    assert.equal(c.reason, 'context_window_exceeded', `사유: ${s}`);
    assert.equal(isFallbackEligible(c), false, `같은 백엔드의 다른 모델로는 해결되지 않음: ${s}`);
  }
});

test('정상 exit-0 답변에 context-window 문구가 있어도 → fatal 아님 (오탐 방지 가드)', () => {
  const c = classifyCliError(
    'Fixed the bug where we hit the context window limit on the first turn.',
    { exitCode: 0 },
  );
  assert.equal(c.isFatal, false);
  assert.equal(c.reason, '');
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

// ticket 41dc37cb 리뷰 라운드1 — subagent-manager.ts/base-session-manager.ts가
// 공유하는 순수 체인-결정 함수. 두 spawn 사이트가 각자 buildModelChain을
// 직접 호출하던 걸 이 함수 하나로 합쳐, "profile 활성화 시 fallback_models를
// 무시한다"는 불변식이 한쪽에서만 적용되고 다른 쪽에서 누락되는 것을
// 구조적으로 막는다.
const FIXTURE_PROFILE = {
  id: 'p',
  protocol: 'anthropic-compatible',
  base_url: 'http://127.0.0.1:1',
  model: 'qwen3-coder-next',
};

test('resolveModelChain: profile 없으면 buildModelChain과 byte-for-byte 동일 (기존 동작 무회귀)', () => {
  assert.deepEqual(resolveModelChain('opus', null, ['sonnet', 'haiku']), buildModelChain('opus', ['sonnet', 'haiku']));
  assert.deepEqual(resolveModelChain(null, null, ['sonnet']), buildModelChain(null, ['sonnet']));
  assert.deepEqual(resolveModelChain('opus', null, undefined), buildModelChain('opus', undefined));
});

test('resolveModelChain: Claude backend profile이 활성화되면 harness.fallback_models를 통째로 무시한다', () => {
  // raw 값이 CLI-recognized alias가 아니어도(오히려 그런 경우가 대부분) 체인에
  // 절대 실리지 않는다 — 단일 alias만 남아 체인 길이 1, 폴백 respawn 자체가
  // 트리거되지 않는다(subagent-manager.ts/base-session-manager.ts의
  // `chainAttempt + 1 < modelChain.length` 가드 참고).
  assert.deepEqual(
    resolveModelChain('sonnet', FIXTURE_PROFILE, ['opus', 'claude-legacy-raw-id']),
    ['sonnet'],
  );
  // fallback_models가 애초에 없어도 결과는 동일 — 동작 변화 없음.
  assert.deepEqual(resolveModelChain('sonnet', FIXTURE_PROFILE, undefined), ['sonnet']);
  assert.deepEqual(resolveModelChain('sonnet', FIXTURE_PROFILE, []), ['sonnet']);
});
