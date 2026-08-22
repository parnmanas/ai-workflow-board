// 단위 테스트 — 동적 max_output_tokens clamp (ticket 7d8ea7c9 후속).
//
// 이 테스트가 막는 실제 사고: 새 채팅 세션의 첫 턴(system prompt +
// AWB/agent/board/workspace instructions + MCP tool schema + 세션 메타데이터)이
// 33,537 input tokens 가 됐다. Claude Code CLI 자체의 고정 max_tokens
// 요청(32,000)을 더하면 합계 65,537 — vLLM 백엔드의 context_window(65,536)를
// 정확히 1 token 초과해 vLLM 이 요청 자체를 거부했다(HTTP 500). 아래 경계값은
// clamp 공식이 실제로 문제를 일으킨 그 숫자들로 검증되도록 그대로 사용한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ContextBudgetExhaustedError,
  DEFAULT_REQUESTED_MAX_OUTPUT_TOKENS,
  DEFAULT_SAFETY_MARGIN_TOKENS,
  MIN_OUTPUT_TOKENS,
  RuntimeLease,
  estimatePromptTokens,
  estimateTokens,
  resolveEffectiveMaxOutputTokens,
  resolveMaxOutputTokensEnv,
  validateRuntimeProfile,
} from '../dist/lib/runtime-profiles.js';

const REAL_CONTEXT_WINDOW = 65_536;
const REAL_KNOWN_INPUT = 33_537;
const REAL_REQUESTED_OUTPUT = 32_000; // 33,537 + 32,000 = 65,537 — 1 초과.

test('estimateTokens: 빈 값/nullish → 0, 그 외에는 ceil(chars/4)', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2, '내림이 아니라 올림');
});

test('estimatePromptTokens: 구성요소별 분해가 known_total 로 합산됨', () => {
  const est = estimatePromptTokens('role prompt text', 'harness append text', 'first turn text');
  assert.equal(est.role_prompt, estimateTokens('role prompt text'));
  assert.equal(est.harness_append, estimateTokens('harness append text'));
  assert.equal(est.first_turn, estimateTokens('first turn text'));
  assert.equal(est.known_total, est.role_prompt + est.harness_append + est.first_turn);
});

test('resolveEffectiveMaxOutputTokens: 65,537 경계(1 초과 — 실제 사고)는 정확히 1 만큼 줄어든다', () => {
  // 33,537(known input) + 32,000(requested output) = 65,537 — 65,536보다 1 초과.
  const effective = resolveEffectiveMaxOutputTokens({
    contextWindow: REAL_CONTEXT_WINDOW,
    knownInputTokens: REAL_KNOWN_INPUT,
    requestedMaxOutputTokens: REAL_REQUESTED_OUTPUT,
    safetyMarginTokens: 0,
  });
  // budget = 65536 - 33537 - 0 = 31999
  assert.equal(effective, 31_999);
  assert.ok(
    REAL_KNOWN_INPUT + effective <= REAL_CONTEXT_WINDOW,
    'clamp 된 요청은 실제 context window 안에 들어와야 한다',
  );
});

test('resolveEffectiveMaxOutputTokens: 정확히 65,536 경계(딱 맞음)는 clamp 되지 않는다', () => {
  // input + requested 합이 정확히 context window 와 같은 포함 경계.
  const inputTokens = REAL_CONTEXT_WINDOW - REAL_REQUESTED_OUTPUT; // 33,536
  const effective = resolveEffectiveMaxOutputTokens({
    contextWindow: REAL_CONTEXT_WINDOW,
    knownInputTokens: inputTokens,
    requestedMaxOutputTokens: REAL_REQUESTED_OUTPUT,
    safetyMarginTokens: 0,
  });
  assert.equal(effective, REAL_REQUESTED_OUTPUT, '정확히 들어맞으므로 clamp 불필요');
});

test('resolveEffectiveMaxOutputTokens: 65,535 경계(1 여유)는 clamp 되지 않는다', () => {
  const inputTokens = REAL_CONTEXT_WINDOW - REAL_REQUESTED_OUTPUT - 1; // 33,535
  const effective = resolveEffectiveMaxOutputTokens({
    contextWindow: REAL_CONTEXT_WINDOW,
    knownInputTokens: inputTokens,
    requestedMaxOutputTokens: REAL_REQUESTED_OUTPUT,
    safetyMarginTokens: 0,
  });
  assert.equal(effective, REAL_REQUESTED_OUTPUT, '1 token 여유로 들어맞으므로 clamp 불필요');
});

test('resolveEffectiveMaxOutputTokens: safety_margin_tokens 가 예산을 추가로 줄인다', () => {
  const effective = resolveEffectiveMaxOutputTokens({
    contextWindow: REAL_CONTEXT_WINDOW,
    knownInputTokens: 0,
    requestedMaxOutputTokens: REAL_CONTEXT_WINDOW,
    safetyMarginTokens: 10_000,
  });
  assert.equal(effective, REAL_CONTEXT_WINDOW - 10_000);
});

// 리뷰 지적(P1) — 이전 구현은 budget < MIN_OUTPUT_TOKENS 일 때 반환값을
// MIN_OUTPUT_TOKENS 로 끌어올렸는데, 이러면 반환값이 budget 을 넘어서
// "effective_max_output <= context_window - input - safety_margin" 상한
// 불변식이 깨진다(예: context_window=65536, known_input=65000 이면
// budget=536 인데 1024 를 반환 — 합계 66024 로 여전히 초과). 이제는 하한을
// 억지로 채우는 대신 명시적으로 throw 해야 한다.
test('resolveEffectiveMaxOutputTokens: known input 만으로 이미 context window 를 넘으면 하한을 채우는 대신 throw 한다', () => {
  assert.throws(
    () => resolveEffectiveMaxOutputTokens({
      contextWindow: 1_000,
      knownInputTokens: 5_000, // input 만으로 이미 context window 초과
      requestedMaxOutputTokens: 32_000,
      safetyMarginTokens: 0,
    }),
    ContextBudgetExhaustedError,
  );
});

test('resolveEffectiveMaxOutputTokens: 리뷰 지적 예시(context_window=65536, known_input=65000) — budget=536 인데 1024 를 반환하지 않고 throw 한다', () => {
  assert.throws(
    () => resolveEffectiveMaxOutputTokens({
      contextWindow: 65_536,
      knownInputTokens: 65_000,
      requestedMaxOutputTokens: 32_000,
      safetyMarginTokens: 0,
    }),
    ContextBudgetExhaustedError,
  );
});

test('resolveEffectiveMaxOutputTokens: budget=MIN_OUTPUT_TOKENS(1024) 경계는 성공한다', () => {
  const contextWindow = 10_000;
  const knownInputTokens = contextWindow - MIN_OUTPUT_TOKENS; // budget = 정확히 1024
  const effective = resolveEffectiveMaxOutputTokens({
    contextWindow,
    knownInputTokens,
    requestedMaxOutputTokens: 32_000,
    safetyMarginTokens: 0,
  });
  assert.equal(effective, MIN_OUTPUT_TOKENS);
  assert.ok(knownInputTokens + effective <= contextWindow, '상한 불변식 유지');
});

test('resolveEffectiveMaxOutputTokens: budget=1023(MIN_OUTPUT_TOKENS 바로 아래) 경계는 throw 한다', () => {
  const contextWindow = 10_000;
  const knownInputTokens = contextWindow - (MIN_OUTPUT_TOKENS - 1); // budget = 정확히 1023
  assert.throws(
    () => resolveEffectiveMaxOutputTokens({
      contextWindow,
      knownInputTokens,
      requestedMaxOutputTokens: 32_000,
      safetyMarginTokens: 0,
    }),
    ContextBudgetExhaustedError,
  );
});

test('resolveMaxOutputTokensEnv: profile 에 context_window 없으면 → {} (기존 프로필 영향 없음)', () => {
  const resolution = resolveMaxOutputTokensEnv(
    { id: 'p', protocol: 'anthropic-compatible', base_url: 'http://x', model: 'm' },
    { rolePrompt: 'x', harnessAppend: '', firstTurnText: 'y' },
  );
  assert.deepEqual(resolution.env, {});
  assert.equal(resolution.effectiveMaxOutputTokens, null);
});

test('resolveMaxOutputTokensEnv: profile 이 null/undefined 여도 → {} (조건 없이 호출 가능)', () => {
  assert.deepEqual(resolveMaxOutputTokensEnv(null, {}).env, {});
  assert.deepEqual(resolveMaxOutputTokensEnv(undefined, {}).env, {});
});

test('resolveMaxOutputTokensEnv: context_window 만 설정 시 DEFAULT_REQUESTED_MAX_OUTPUT_TOKENS 를 clamp 한다', () => {
  // known_total ≈ 20,000 토큰(80,000자) — DEFAULT_SAFETY_MARGIN_TOKENS(40,000)와
  // 합쳐도 budget(≈5,536)이 MIN_OUTPUT_TOKENS 이상으로 남아 정상 clamp만
  // 검증하고, 아래 예산-고갈 케이스와 겹치지 않는다.
  const longPrompt = 'x'.repeat(80_000);
  const resolution = resolveMaxOutputTokensEnv(
    { id: 'p', protocol: 'anthropic-compatible', base_url: 'http://x', model: 'm', context_window: REAL_CONTEXT_WINDOW },
    { rolePrompt: longPrompt, harnessAppend: '', firstTurnText: '' },
  );
  assert.equal(resolution.safetyMarginTokens, DEFAULT_SAFETY_MARGIN_TOKENS);
  const expected = resolveEffectiveMaxOutputTokens({
    contextWindow: REAL_CONTEXT_WINDOW,
    knownInputTokens: resolution.estimate.known_total,
    requestedMaxOutputTokens: DEFAULT_REQUESTED_MAX_OUTPUT_TOKENS,
    safetyMarginTokens: DEFAULT_SAFETY_MARGIN_TOKENS,
  });
  assert.ok(expected < DEFAULT_REQUESTED_MAX_OUTPUT_TOKENS, '이 테스트는 clamp 가 실제로 걸리는 경우를 검증해야 함');
  assert.equal(resolution.effectiveMaxOutputTokens, expected);
  assert.deepEqual(resolution.env, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(expected) });
});

test('resolveMaxOutputTokensEnv: 예산이 고갈되면 ContextBudgetExhaustedError 가 그대로 전파된다', () => {
  // known_total 이 DEFAULT_SAFETY_MARGIN_TOKENS 와 합쳐 context_window 를
  // 넘어서게 충분히 긴 prompt.
  const hugePrompt = 'x'.repeat(200_000); // ≈ 50,000 토큰
  assert.throws(
    () => resolveMaxOutputTokensEnv(
      { id: 'p', protocol: 'anthropic-compatible', base_url: 'http://x', model: 'm', context_window: REAL_CONTEXT_WINDOW },
      { rolePrompt: hugePrompt, harnessAppend: '', firstTurnText: '' },
    ),
    ContextBudgetExhaustedError,
  );
});

test('resolveMaxOutputTokensEnv: max_output_tokens/safety_margin_tokens 명시값이 기본값을 override 한다', () => {
  const resolution = resolveMaxOutputTokensEnv(
    {
      id: 'p',
      protocol: 'anthropic-compatible',
      base_url: 'http://x',
      model: 'm',
      context_window: REAL_CONTEXT_WINDOW,
      max_output_tokens: 8_000,
      safety_margin_tokens: 100,
    },
    { rolePrompt: '', harnessAppend: '', firstTurnText: '' },
  );
  assert.equal(resolution.safetyMarginTokens, 100);
  // known_total ≈ 0 이므로 effective = min(8000, 65536 - 0 - 100) = 8000 (clamp 안 됨).
  assert.equal(resolution.effectiveMaxOutputTokens, 8_000);
  assert.deepEqual(resolution.env, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' });
});

test('claudeEnv(): profile.context_window 가 설정되면 CLAUDE_CODE_MAX_CONTEXT_TOKENS 를 주입한다', () => {
  const lease = new RuntimeLease(
    { id: 'p', protocol: 'anthropic-compatible', base_url: 'http://x', model: 'm', context_window: REAL_CONTEXT_WINDOW },
    null,
    null,
    {},
  );
  assert.equal(lease.claudeEnv().CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(REAL_CONTEXT_WINDOW));
});

test('claudeEnv(): context_window 없으면 CLAUDE_CODE_MAX_CONTEXT_TOKENS 없음 (회귀 안전 기본값)', () => {
  const lease = new RuntimeLease(
    { id: 'p', protocol: 'anthropic-compatible', base_url: 'http://x', model: 'm' },
    null,
    null,
    {},
  );
  assert.equal('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in lease.claudeEnv(), false);
});

test('claudeEnv(): profile.env 이 CLAUDE_CODE_MAX_CONTEXT_TOKENS 를 여전히 override 할 수 있다', () => {
  const lease = new RuntimeLease(
    {
      id: 'p',
      protocol: 'anthropic-compatible',
      base_url: 'http://x',
      model: 'm',
      context_window: REAL_CONTEXT_WINDOW,
      env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: 'operator-override' },
    },
    null,
    null,
    {},
  );
  assert.equal(lease.claudeEnv().CLAUDE_CODE_MAX_CONTEXT_TOKENS, 'operator-override');
});

// ── validateRuntimeProfile: 신규 선택적 필드 ──────────────────────────

test('validateRuntimeProfile: context_window/max_output_tokens/safety_margin_tokens 를 가진 profile 을 허용한다', () => {
  assert.doesNotThrow(() => validateRuntimeProfile({
    id: 'p',
    protocol: 'anthropic-compatible',
    base_url: 'http://x',
    model: 'm',
    context_window: REAL_CONTEXT_WINDOW,
    max_output_tokens: 8_000,
    safety_margin_tokens: 1_000,
  }));
});

test('validateRuntimeProfile: context_window/max_output_tokens 가 양의 정수가 아니면 거부한다', () => {
  for (const bad of [0, -1, 1.5, 'not-a-number']) {
    assert.throws(
      () => validateRuntimeProfile({
        id: 'p', protocol: 'anthropic-compatible', base_url: 'http://x', model: 'm', context_window: bad,
      }),
      /context_window must be a positive integer/,
    );
    assert.throws(
      () => validateRuntimeProfile({
        id: 'p', protocol: 'anthropic-compatible', base_url: 'http://x', model: 'm', max_output_tokens: bad,
      }),
      /max_output_tokens must be a positive integer/,
    );
  }
});

test('validateRuntimeProfile: 음수 safety_margin_tokens 를 거부한다', () => {
  assert.throws(
    () => validateRuntimeProfile({
      id: 'p', protocol: 'anthropic-compatible', base_url: 'http://x', model: 'm', safety_margin_tokens: -1,
    }),
    /safety_margin_tokens must be a non-negative integer/,
  );
});

test('validateRuntimeProfile: max_output_tokens >= context_window 를 거부한다', () => {
  assert.throws(
    () => validateRuntimeProfile({
      id: 'p',
      protocol: 'anthropic-compatible',
      base_url: 'http://x',
      model: 'm',
      context_window: 10_000,
      max_output_tokens: 10_000,
    }),
    /max_output_tokens must be less than context_window/,
  );
});

// 리뷰 지적(P1) — context_window 가 (생략 시 기본값으로 간주하는)
// safety_margin_tokens 조차 감당 못 하면, 이 profile 은 어떤 prompt
// 길이에서도 resolveEffectiveMaxOutputTokens() 가 항상 throw 하는
// 무의미한 설정이다 — 저장 시점에 거부되어야 한다.
test('validateRuntimeProfile: context_window - safety_margin_tokens(기본값) < MIN_OUTPUT_TOKENS 를 거부한다', () => {
  // safety_margin_tokens 생략 → DEFAULT_SAFETY_MARGIN_TOKENS(40,000) 적용.
  // context_window=8,000 이면 known input 0(가장 유리한 경우)에서도
  // budget = 8,000 - 40,000 < 0 < MIN_OUTPUT_TOKENS.
  assert.throws(
    () => validateRuntimeProfile({
      id: 'p', protocol: 'anthropic-compatible', base_url: 'http://x', model: 'm', context_window: 8_000,
    }),
    /leaves less than MIN_OUTPUT_TOKENS/,
  );
});

test('validateRuntimeProfile: context_window - safety_margin_tokens(명시값) < MIN_OUTPUT_TOKENS 를 거부한다', () => {
  assert.throws(
    () => validateRuntimeProfile({
      id: 'p',
      protocol: 'anthropic-compatible',
      base_url: 'http://x',
      model: 'm',
      context_window: 2_000,
      safety_margin_tokens: 1_500, // 2,000 - 1,500 = 500 < MIN_OUTPUT_TOKENS(1,024)
    }),
    /leaves less than MIN_OUTPUT_TOKENS/,
  );
});

test('validateRuntimeProfile: context_window - safety_margin_tokens == MIN_OUTPUT_TOKENS 경계는 통과한다', () => {
  assert.doesNotThrow(() => validateRuntimeProfile({
    id: 'p',
    protocol: 'anthropic-compatible',
    base_url: 'http://x',
    model: 'm',
    context_window: 2_000,
    safety_margin_tokens: 2_000 - MIN_OUTPUT_TOKENS, // budget(known input 0 기준) = 정확히 MIN_OUTPUT_TOKENS
  }));
});
