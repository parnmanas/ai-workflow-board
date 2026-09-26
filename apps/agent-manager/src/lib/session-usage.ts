// 세션 토큰 사용량의 **단일 계약**.
//
// CLI 마다 이름도 의미도 다르다. 특히 `input_tokens` 가 캐시 히트를 포함하는지가
// 갈린다 — 이것을 정규화하지 않으면 화면의 숫자가 CLI 별로 다른 뜻이 된다:
//
//   claude  `usage.input_tokens` = 캐시 **제외** 신규 입력 (2 처럼 아주 작다).
//           실제 컨텍스트는 input + cache_read_input_tokens + cache_creation_input_tokens.
//           → input 만 보여 주면 "2 토큰 썼다"는 거짓이 나온다. (보고된 증상)
//   codex   `usage.input_tokens` = 캐시 **포함** (cached_input_tokens 가 그 내역).
//           → 여기서 캐시를 빼야 claude 와 같은 뜻이 된다. 안 빼면 이중 계산이다.
//   opencode `tokens.input` = 캐시 제외, `tokens.cache.{read,write}` 가 따로 온다.
//
// 그래서 이 파일의 계약은 하나다: **`input_tokens` 는 캐시를 제외한 신규 입력이다.**
// 네이티브 값이 캐시를 포함하는 CLI 는 자기 매핑에서 빼고 넘긴다.
//
// `reasoning_tokens` 는 `output_tokens` 의 **내역**이다(가산하지 않는다) — codex
// `reasoning_output_tokens`, claude `output_tokens_details.thinking_tokens`,
// opencode `tokens.reasoning` 모두 그렇다. total 에 더하면 두 번 센다.

/** 한 턴(또는 한 API 호출)의 토큰 사용량. 모든 수는 0 이상. */
export interface SessionUsage {
  /** 캐시 히트를 제외한 신규 입력 토큰. */
  input_tokens: number;
  output_tokens: number;
  /** 프롬프트 캐시에서 읽은 토큰(할인된 입력). */
  cached_read_tokens: number;
  /** 프롬프트 캐시에 쓴 토큰(claude 만 보고한다). */
  cache_write_tokens: number;
  /** output 의 내역 — total 에 가산하지 않는다. 모르면 0. */
  reasoning_tokens: number;
  /** input + cached_read + cache_write + output. CLI 가 주는 total 이 있으면 그것. */
  total_tokens: number;
  /** 지금 컨텍스트 창을 얼마나 쓰고 있는가(codex 가 보고한다). 모르면 생략. */
  context_tokens?: number;
  /** 모델의 컨텍스트 창 크기. 모르면 생략. */
  context_window?: number;
  /** 이 턴의 비용(USD). 비용 개념이 없는 CLI 는 생략. */
  cost_usd?: number;
}

function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function optional(value: unknown): number | undefined {
  const num = n(value);
  return num > 0 ? num : undefined;
}

export interface SessionUsageParts {
  /** 캐시 **제외** 신규 입력. 네이티브 값이 캐시를 포함하면 호출자가 먼저 뺀다. */
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
  /** CLI 가 직접 주는 total. 없으면 위 값들의 합으로 계산한다. */
  totalTokens?: unknown;
  contextTokens?: unknown;
  contextWindow?: unknown;
  costUsd?: unknown;
}

/**
 * 조각들을 계약에 맞춘 `SessionUsage` 로 만든다. 아무 토큰도 없으면 `null` —
 * 0 만 담긴 usage 이벤트를 만들면 화면에 "0 토큰" 이 찍혀 계측 실패와 구분되지 않는다.
 */
export function normalizeSessionUsage(parts: SessionUsageParts): SessionUsage | null {
  const input = n(parts.inputTokens);
  const output = n(parts.outputTokens);
  const cachedRead = n(parts.cachedReadTokens);
  const cacheWrite = n(parts.cacheWriteTokens);
  const reasoning = n(parts.reasoningTokens);
  const declaredTotal = n(parts.totalTokens);
  const summed = input + output + cachedRead + cacheWrite;
  if (summed === 0 && declaredTotal === 0) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    cached_read_tokens: cachedRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
    total_tokens: declaredTotal || summed,
    ...(optional(parts.contextTokens) !== undefined ? { context_tokens: optional(parts.contextTokens) } : {}),
    ...(optional(parts.contextWindow) !== undefined ? { context_window: optional(parts.contextWindow) } : {}),
    ...(typeof parts.costUsd === 'number' && Number.isFinite(parts.costUsd) && parts.costUsd > 0
      ? { cost_usd: parts.costUsd }
      : {}),
  };
}

/** 여러 API 호출을 한 턴으로 합친다. 컨텍스트 값은 **마지막** 것을 쓴다(누적이 아니다). */
export function addSessionUsage(acc: SessionUsage | null, next: SessionUsage | null): SessionUsage | null {
  if (!next) return acc;
  if (!acc) return { ...next };
  return {
    input_tokens: acc.input_tokens + next.input_tokens,
    output_tokens: acc.output_tokens + next.output_tokens,
    cached_read_tokens: acc.cached_read_tokens + next.cached_read_tokens,
    cache_write_tokens: acc.cache_write_tokens + next.cache_write_tokens,
    reasoning_tokens: acc.reasoning_tokens + next.reasoning_tokens,
    total_tokens: acc.total_tokens + next.total_tokens,
    ...(next.context_tokens ?? acc.context_tokens ? { context_tokens: next.context_tokens ?? acc.context_tokens } : {}),
    ...(next.context_window ?? acc.context_window ? { context_window: next.context_window ?? acc.context_window } : {}),
    ...(acc.cost_usd !== undefined || next.cost_usd !== undefined
      ? { cost_usd: (acc.cost_usd ?? 0) + (next.cost_usd ?? 0) }
      : {}),
  };
}

/** 트랜스크립트 `usage` 이벤트의 payload. 화면(SessionTranscript)이 읽는 키다. */
export function usageEventPayload(usage: SessionUsage): Record<string, unknown> {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    cached_read_tokens: usage.cached_read_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    // 호환: 예전 payload 이름(thought_tokens)을 읽는 화면이 있을 수 있다.
    thought_tokens: usage.reasoning_tokens,
    reasoning_tokens: usage.reasoning_tokens,
    ...(usage.context_tokens !== undefined ? { context_tokens: usage.context_tokens } : {}),
    ...(usage.context_window !== undefined ? { context_window: usage.context_window } : {}),
    ...(usage.cost_usd !== undefined ? { cost_usd: usage.cost_usd } : {}),
  };
}
