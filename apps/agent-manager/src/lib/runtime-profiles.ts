import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import type { RuntimeProfileSpec } from './cli-adapters/base.js';
import { terminateDetachedProcessTree } from './process-tree.js';

interface AdapterLaunch {
  bin: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  baseUrl: string;
  healthUrl: string;
}

function resolveFrom(cwd: string | undefined, value: string): string {
  if (isAbsolute(value)) return value;
  return resolve(cwd || process.cwd(), value);
}

function venvBin(venv: string, name: string): string {
  return join(
    venv,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? `${name}.exe` : name,
  );
}

function expand(value: string, profile: RuntimeProfileSpec): string {
  return value
    .replaceAll('{backend_base_url}', profile.base_url)
    .replaceAll('{model}', profile.model)
    .replaceAll('{adapter_base_url}', profile.adapter?.base_url ?? '');
}

function buildAdapter(profile: RuntimeProfileSpec, credentialEnv: Record<string, string>): AdapterLaunch {
  const adapter = profile.adapter!;
  const cwd = adapter.cwd ? resolveFrom(profile.cwd, adapter.cwd) : profile.cwd;
  const venv = adapter.venv ? resolveFrom(cwd, adapter.venv) : undefined;
  let bin: string;
  let args: string[];
  if (adapter.module) {
    bin = adapter.python
      ? resolveFrom(cwd, adapter.python)
      : venv
        ? venvBin(venv, 'python')
        : process.platform === 'win32' ? 'python.exe' : 'python3';
    args = ['-m', adapter.module, ...(adapter.args ?? []).map(value => expand(value, profile))];
  } else if (adapter.executable) {
    bin = venv && !isAbsolute(adapter.executable)
      ? venvBin(venv, adapter.executable)
      : resolveFrom(cwd, adapter.executable);
    args = (adapter.args ?? []).map(value => expand(value, profile));
  } else if (adapter.command) {
    const [head, ...tail] = adapter.command.trim().split(/\s+/);
    bin = venv && !isAbsolute(head) ? venvBin(venv, head) : head;
    args = [...tail, ...(adapter.args ?? [])].map(value => expand(value, profile));
  } else {
    bin = '';
    args = [];
  }
  const baseUrl = adapter.base_url.replace(/\/$/, '');
  const authEnv = profile.auth_env || 'ANTHROPIC_AUTH_TOKEN';
  const secret = credentialEnv[authEnv] || credentialEnv.ANTHROPIC_API_KEY || '';
  const binDir = venv ? join(venv, process.platform === 'win32' ? 'Scripts' : 'bin') : '';
  return {
    bin,
    args,
    cwd,
    env: {
      ...process.env,
      ...(binDir ? { VIRTUAL_ENV: venv, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` } : {}),
      AWB_BACKEND_BASE_URL: profile.base_url,
      AWB_BACKEND_MODEL: profile.model,
      ...(adapter.env
        ? Object.fromEntries(Object.entries(adapter.env).map(([key, value]) => [key, expand(value, profile)]))
        : {}),
      ...(secret ? { [authEnv]: secret } : {}),
    },
    baseUrl,
    healthUrl: new URL(adapter.health_check || '/health', `${baseUrl}/`).toString(),
  };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Claude Code CLI 자체가 `--model`/내부 보조 요청에서 인식하는 alias
 *  4종(listModels()의 opus/sonnet/haiku/fable — cli-adapters/claude.ts와
 *  동일 목록을 여기서도 독립 유지: 이 모듈은 claude.ts 를 import하지
 *  않는다). */
export const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];
/** profile.model_alias 생략 시 `--model`에 실릴 기본 alias. 'sonnet'을
 *  고른 이유는 순전히 관례(일반 사용자용 기본 tier) — claudeEnv()가
 *  ANTHROPIC_DEFAULT_*_MODEL 네 tier 전부를 profile.model 로 이미
 *  덮어쓰므로 어떤 alias를 골라도 백엔드로 나가는 실제 모델은 동일하다. */
export const DEFAULT_CLAUDE_MODEL_ALIAS: ClaudeModelAlias = 'sonnet';

/** ticket 41dc37cb — spawn 사이트가 `--model`에 실제로 넘길 값. profile.model
 *  (raw provider id, 예: vLLM `--served-model-name`)을 절대 직접 반환하지
 *  않는다 — CLI가 그 문자열을 인식 못 하면 generate_session_title 같은 내부
 *  보조 요청이 unrecognized_model 로 거부되어 첫 턴부터 실패한다. 실제 백엔드
 *  라우팅은 claudeEnv()의 ANTHROPIC_DEFAULT_*_MODEL 오버라이드가 담당하므로,
 *  여기서는 CLI 자신이 유효하다고 인정하는 alias만 고르면 된다. */
export function resolveClaudeModelAlias(profile: RuntimeProfileSpec): ClaudeModelAlias {
  return profile.model_alias ?? DEFAULT_CLAUDE_MODEL_ALIAS;
}

export function validateRuntimeProfile(profile: RuntimeProfileSpec): void {
  const issues: string[] = [];
  if (profile.kind && profile.kind !== 'claude-backend') issues.push('kind must be "claude-backend"');
  if (!['anthropic-compatible', 'openai-compatible'].includes(profile.protocol)) {
    issues.push('protocol must be anthropic-compatible or openai-compatible');
  }
  if (!profile.base_url) issues.push('base_url is required');
  if (!profile.model) issues.push('model is required');
  if (profile.model_alias !== undefined && !CLAUDE_MODEL_ALIASES.includes(profile.model_alias)) {
    issues.push(`model_alias must be one of ${CLAUDE_MODEL_ALIASES.join(', ')}`);
  }
  if (profile.protocol === 'openai-compatible' && !profile.adapter) issues.push('adapter is required');
  if (profile.protocol === 'anthropic-compatible' && profile.adapter) issues.push('adapter must be omitted');
  if (profile.credential_required && !profile.credential_ref) issues.push('credential_ref is required');
  if (profile.adapter) {
    const count = [profile.adapter.command, profile.adapter.module, profile.adapter.executable].filter(Boolean).length;
    if (count > 1) issues.push('adapter must set only one of command, module, or executable');
    if (profile.adapter.lifecycle !== 'reuse' && count === 0) issues.push('adapter launch command is required unless lifecycle is reuse');
  }
  if (profile.context_window !== undefined && !isPositiveInt(profile.context_window)) {
    issues.push('context_window must be a positive integer');
  }
  if (profile.max_output_tokens !== undefined && !isPositiveInt(profile.max_output_tokens)) {
    issues.push('max_output_tokens must be a positive integer');
  }
  if (
    profile.safety_margin_tokens !== undefined &&
    !(Number.isInteger(profile.safety_margin_tokens) && profile.safety_margin_tokens >= 0)
  ) {
    issues.push('safety_margin_tokens must be a non-negative integer');
  }
  if (
    profile.context_window !== undefined &&
    profile.max_output_tokens !== undefined &&
    isPositiveInt(profile.context_window) &&
    isPositiveInt(profile.max_output_tokens) &&
    profile.max_output_tokens >= profile.context_window
  ) {
    issues.push('max_output_tokens must be less than context_window');
  }
  // 리뷰 지적(P1) — safety_margin_tokens(생략 시 기본값)이 context_window 를
  // known input 0(가장 유리한 경우)에서조차 MIN_OUTPUT_TOKENS 밑으로 깎으면,
  // 이 profile 은 어떤 prompt 길이에서도 resolveEffectiveMaxOutputTokens() 가
  // 항상 throw 하는 무의미한 설정이다 — 저장 시점에 명확히 거부한다.
  if (profile.context_window !== undefined && isPositiveInt(profile.context_window)) {
    const effectiveMargin = profile.safety_margin_tokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
    if (profile.context_window - effectiveMargin < MIN_OUTPUT_TOKENS) {
      issues.push(
        `context_window (${profile.context_window}) minus safety_margin_tokens ` +
        `(${effectiveMargin}${profile.safety_margin_tokens === undefined ? ', default' : ''}) ` +
        `leaves less than MIN_OUTPUT_TOKENS (${MIN_OUTPUT_TOKENS}) even for an empty prompt`,
      );
    }
  }
  if (issues.length) throw new Error(`Invalid Claude backend profile (${profile.id}): ${issues.join('; ')}`);
}

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

/**
 * Claude Code 자체의 내부 보조 요청(세션 제목 생성 등)은 `--model` argv
 * 플래그를 아예 거치지 않고 이 env 변수들로 모델을 고른다. 모델 하나만
 * 서빙하는 커스텀 백엔드 프로필(예: 단일 vLLM `--served-model-name`)은
 * 이 값들을 전부 `profile.model` 로 기본값 지정해야 한다 — 안 그러면 이
 * 보조 요청들이 CLI 자체 기본 모델명을 백엔드로 보내 `unrecognized_model`
 * 로 거부당하고, CLI 는 턴 전체를 실패시키기 전까지 몇 분간 재시도하며
 * 멈춘다 (ticket 7d8ea7c9 후속). ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL
 * 조합은 cli-adapters/deepseek.ts 에서 이미 검증된 페어링이고,
 * ANTHROPIC_DEFAULT_* 3종은 tier alias 를 다른 방식으로 해석하는 CLI
 * 버전에 대비해 방어적으로 포함했다. `profile.env`(claudeEnv() 에서 이
 * 뒤에 spread) 는 여전히 이 값들을 프로필별로 override 할 수 있다.
 */
const AUX_MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

// ticket 7d8ea7c9 후속(컨텍스트 윈도우 초과) — Claude Code CLI 바이너리에
// 실제로 존재함을 문자열 덤프로 확인한 env 변수:
//   - CLAUDE_CODE_MAX_CONTEXT_TOKENS: 미인식 커스텀 모델에 대해 CLI 가
//     내부적으로 가정하는 context window 를 실제 값으로 대체한다
//     ("... is not a model this version of Claude Code recognizes, so
//     auto-compact will keep this session within N tokens (the context
//     window it assumes) ... set CLAUDE_CODE_MAX_CONTEXT_TOKENS to its
//     real window").
//   - CLAUDE_CODE_MAX_OUTPUT_TOKENS: 요청당 max_tokens 상한
//     ("Claude's response exceeded the output token maximum. To configure
//     this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment
//     variable.").
// 실제 사고: vLLM 백엔드(context 65,536)에 첫 채팅 메시지가 system
// prompt+AWB/agent/board/workspace instructions+MCP tool schema+session
// metadata 만으로 33,537 input tokens 가 됐고, 여기에 CLI 의 고정
// max_output_tokens(관측값 32,000)를 더하면 65,537 로 정확히 1 token
// 초과해 vLLM 이 요청을 거부했다(HTTP 500).
/** 아무것도 override 하지 않을 때 Claude Code CLI 자체가 기본으로 요청하는
 *  max_tokens(위 사고에서 관측된 값) — profile 이 context_window 만 설정하고
 *  max_output_tokens 를 명시하지 않았을 때 이 값을 기준으로 clamp 한다. */
export const DEFAULT_REQUESTED_MAX_OUTPUT_TOKENS = 32_000;
/** spawn 시점에 이 모듈이 볼 수 없는 모든 것 — Claude Code 자체 기본
 *  system prompt, CLI가 AWB/host MCP 서버와 실시간으로 협상하는 tool
 *  schema, 세션 메타데이터 — 을 위해 예약하는 여유분. 관측된 실제 초과분
 *  (이 보드의 MCP tool 표면 기준, 한 단어짜리 첫 메시지만으로 33,500+
 *  토큰)보다 넉넉하게 잡았다. */
export const DEFAULT_SAFETY_MARGIN_TOKENS = 40_000;
/** 이보다 작은 출력 여유는 "쓸 만한 응답"으로 보지 않는다.
 *  resolveEffectiveMaxOutputTokens() 가 이 값을 채울 여유가 없으면(즉
 *  budget 자체가 이 밑이면) 상한을 억지로 끌어올리는 대신 throw 한다 —
 *  MIN_OUTPUT_TOKENS 로 바닥을 높이면 반환값이 budget 을 넘어 context_window
 *  상한 불변식이 깨지므로(리뷰 지적, P1) 이 값은 "완화된 하한"이 아니라
 *  "이 밑이면 실패로 본다"는 임계값이다. */
export const MIN_OUTPUT_TOKENS = 1_024;
/** 아래 best-effort 추정에 쓰는 대략적인 char-당-token 비율. 진짜
 *  tokenizer 가 아니며, 이 비율이 실제 토크나이저 대비 과대/과소 추정
 *  중 어느 쪽으로 치우치는지(특히 한국어 등 비-ASCII 텍스트에서)는
 *  검증된 바 없다 — estimatePromptTokens() 는 이 모듈이 볼 수 있는
 *  부분만 커버하며, 안전성은 이 비율의 정확도가 아니라
 *  safety_margin_tokens 와 resolveEffectiveMaxOutputTokens() 의 명시적
 *  실패 처리에 의존한다. */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/** 이 모듈이 직접 통제하는 텍스트 조각(role prompt, harness system-prompt
 *  append, 첫 턴 텍스트) 하나에 대한 best-effort 토큰 추정치. 진짜
 *  tokenizer 아님 — CHARS_PER_TOKEN_ESTIMATE 참고. */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export interface PromptTokenEstimate {
  role_prompt: number;
  harness_append: number;
  first_turn: number;
  /** 위 세 구성요소의 합. Claude Code 자체 기본 system prompt, MCP tool
   *  schema, 세션 메타데이터는 의도적으로 제외됨 — 이 모듈은 spawn
   *  시점에 그 부분들을 볼 수 없다. safety_margin_tokens 가 그 공백을
   *  커버한다. */
  known_total: number;
}

/** spawn 전에 이 모듈이 실제로 측정할 수 있는 입력의 구성요소별 분해
 *  (ticket 7d8ea7c9 수용 기준: "첫 턴 컨텍스트 구성요소별 토큰 로깅").
 *  호출부는 이 값을 최종 effective max output 과 함께 로깅해, 운영자가
 *  무엇이 known 이고 safety_margin_tokens 가 무엇을 보이지 않게 커버하는지
 *  볼 수 있게 한다. */
export function estimatePromptTokens(
  rolePrompt: string | null | undefined,
  harnessAppend: string | null | undefined,
  firstTurnText: string | null | undefined,
): PromptTokenEstimate {
  const role_prompt = estimateTokens(rolePrompt);
  const harness_append = estimateTokens(harnessAppend);
  const first_turn = estimateTokens(firstTurnText);
  return { role_prompt, harness_append, first_turn, known_total: role_prompt + harness_append + first_turn };
}

/** context_window 예산이 최소 출력 여유(MIN_OUTPUT_TOKENS)조차 남기지 못할
 *  때 resolveEffectiveMaxOutputTokens() 가 던지는 에러 — spawn 사이트가
 *  이걸 잡아 명확한 로그를 남기고 spawn 을 정상적으로 실패 처리한다(기존
 *  startRuntimeProfile/validateRuntimeProfile 실패와 동일한 catch 경로).
 *  `code`는 spawn 사이트가 다른 실패와 구분해 분류하고 싶을 때 쓴다. */
export class ContextBudgetExhaustedError extends Error {
  readonly code = 'context_budget_exhausted';
  constructor(message: string) {
    super(message);
    this.name = 'ContextBudgetExhaustedError';
  }
}

/** 순수 clamp 공식: effective_max_output <= context_window -
 *  known_input_tokens - safety_margin_tokens 를 **항상** 만족해야 한다(리뷰
 *  지적, P1) — 이전 구현은 이 값을 MIN_OUTPUT_TOKENS 로 하한 처리해서, 남은
 *  예산(budget)이 MIN_OUTPUT_TOKENS 보다 작을 때 반환값이 budget 을 넘어
 *  버려 상한 불변식 자체가 깨졌다(예: context_window=65536, known_input=65000
 *  이면 budget=536 인데 1024 를 반환 — 합계 66024 로 여전히 초과). budget 이
 *  MIN_OUTPUT_TOKENS 밑이면(known input 만으로 이미 예산을 거의 다 썼거나
 *  넘겼으면) 값을 억지로 끌어올리는 대신 ContextBudgetExhaustedError 를
 *  던진다 — 상한을 지키는 유일한 방법은 실패를 명시하는 것이다.
 *  65,535/65,536/65,537 세 경계값과 예산 고갈 케이스가
 *  test/runtime-profile-max-output-clamp.test.mjs 에서 검증됨. */
export function resolveEffectiveMaxOutputTokens(params: {
  contextWindow: number;
  knownInputTokens: number;
  requestedMaxOutputTokens: number;
  safetyMarginTokens: number;
}): number {
  const { contextWindow, knownInputTokens, requestedMaxOutputTokens, safetyMarginTokens } = params;
  const budget = contextWindow - knownInputTokens - safetyMarginTokens;
  if (budget < MIN_OUTPUT_TOKENS) {
    throw new ContextBudgetExhaustedError(
      `Claude backend context budget exhausted: context_window=${contextWindow} ` +
      `known_input≈${knownInputTokens} safety_margin=${safetyMarginTokens} leaves only ${budget} ` +
      `token(s) for output (minimum ${MIN_OUTPUT_TOKENS}). Raise context_window, lower ` +
      'safety_margin_tokens, or shrink the prompt.',
    );
  }
  return Math.min(requestedMaxOutputTokens, budget);
}

export interface MaxOutputTokensResolution {
  /** profile.context_window 가 없으면 {} — 기존 프로필은 CLI 자체 기본
   *  동작 그대로 유지된다. 있으면
   *  { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(effectiveMaxOutputTokens) }. */
  env: Record<string, string>;
  estimate: PromptTokenEstimate;
  /** profile.context_window 가 없으면 null(clamp 할 기준이 없음). */
  effectiveMaxOutputTokens: number | null;
  safetyMarginTokens: number;
}

/** spawn 시점 진입점(ticket 7d8ea7c9 후속, 수정범위 2) — 호출부가 이미 갖고
 *  있는 role prompt / harness system-prompt append / 첫 턴 텍스트로부터
 *  known input 크기를 추정하고, profile.context_window 에 맞는 동적
 *  CLAUDE_CODE_MAX_OUTPUT_TOKENS override 를 산출한다. profile 이
 *  context_window 를 선언하지 않으면 no-op(env: {}) — 호출부는 조건 없이
 *  항상 호출해도 된다. 예산이 고갈되면 resolveEffectiveMaxOutputTokens() 의
 *  ContextBudgetExhaustedError 가 그대로 전파된다 — 호출부는 이걸
 *  startRuntimeProfile() 실패와 동일하게 catch 해서 spawn 을 실패
 *  처리해야 한다(base-session-manager.ts/subagent-manager.ts 참고). */
export function resolveMaxOutputTokensEnv(
  profile: RuntimeProfileSpec | null | undefined,
  params: { rolePrompt?: string | null; harnessAppend?: string | null; firstTurnText?: string | null },
): MaxOutputTokensResolution {
  const estimate = estimatePromptTokens(params.rolePrompt, params.harnessAppend, params.firstTurnText);
  const safetyMarginTokens = profile?.safety_margin_tokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  if (!profile?.context_window) {
    return { env: {}, estimate, effectiveMaxOutputTokens: null, safetyMarginTokens };
  }
  const requestedMaxOutputTokens = profile.max_output_tokens ?? DEFAULT_REQUESTED_MAX_OUTPUT_TOKENS;
  const effectiveMaxOutputTokens = resolveEffectiveMaxOutputTokens({
    contextWindow: profile.context_window,
    knownInputTokens: estimate.known_total,
    requestedMaxOutputTokens,
    safetyMarginTokens,
  });
  return {
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(effectiveMaxOutputTokens) },
    estimate,
    effectiveMaxOutputTokens,
    safetyMarginTokens,
  };
}

/** 티켓 ee26302d(faa32380 감사 후속) — 이 문턱 미만 context_window 를 가진
 *  Claude backend profile 은 MCP 세션을 'compact' tool profile 로 옵트인해,
 *  AWB 서버가 ~205개 전체 대신 allowlist ~19개 tool만 등록하게 한다(서버측
 *  구현은 apps/server/src/modules/mcp/shared/tool-profiles.ts — allowlist
 *  밖 tool은 이름까지 등록에서 빠진다, stub 아님).
 *
 *  값 선택 근거: 실측된 raw tools/list 크기가 이 보드 기준 약
 *  57,000~67,500 실제 BPE 토큰(apps/server/test/mcp-tool-schema-budget.test.mjs)
 *  이고, 이 파일의 DEFAULT_SAFETY_MARGIN_TOKENS(40,000)조차 그보다 작다 —
 *  즉 이 raw 크기를 그대로/거의 그대로 받는 백엔드에서는 65,536 같은 작은
 *  context_window 는 이미 구조적으로 여유가 없다(ticket 7d8ea7c9 사고의
 *  context_window 자체가 65,536). 128,000 은 "이 raw 크기 하나만으로도
 *  빠듯한" 구간을 넉넉히 덮으면서, 200K+ 인 Anthropic 클라우드 tier
 *  (Haiku 4.5 이상)는 건드리지 않는 보수적인 초기값 — 실측 근거가 아니라
 *  판단값이므로, allowlist 밖 tool 호출 시도가 mcp.controller.ts의 기존
 *  요청 로그(bodyPreview)에 그대로 남는 실측이 쌓이면 조정 대상이다. */
export const TOOL_PROFILE_COMPACT_THRESHOLD_TOKENS = 128_000;

/**
 * Resolves the `X-AWB-Tool-Profile` header to attach to an MCP session's
 * request headers for a given (possibly absent) Claude backend profile.
 * Returns `{}` — never widens the tool surface — whenever `profile` is
 * absent, `context_window` is unset, or `context_window` is at/above the
 * threshold; every pre-existing caller (no profile, or a profile without
 * context_window) is unaffected. Only a genuinely small context_window
 * opts into 'compact'.
 */
export function resolveToolProfileHeader(
  profile: RuntimeProfileSpec | null | undefined,
): Record<string, string> {
  if (!profile?.context_window) return {};
  if (profile.context_window >= TOOL_PROFILE_COMPACT_THRESHOLD_TOKENS) return {};
  return { 'X-AWB-Tool-Profile': 'compact' };
}

export class RuntimeLease {
  #release: (() => Promise<void>) | null;
  #closed = false;

  constructor(
    readonly profile: RuntimeProfileSpec,
    readonly launch: AdapterLaunch | null,
    readonly child: ChildProcess | null,
    readonly credentialEnv: Record<string, string>,
    release: (() => Promise<void>) | null = null,
  ) {
    this.#release = release;
  }

  claudeEnv(): Record<string, string> {
    const secret = this.credentialEnv[this.profile.auth_env || 'ANTHROPIC_AUTH_TOKEN']
      || this.credentialEnv.ANTHROPIC_API_KEY;
    return {
      ...Object.fromEntries(AUX_MODEL_ENV_KEYS.map(key => [key, this.profile.model])),
      ...(this.profile.context_window ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(this.profile.context_window) } : {}),
      ...(this.profile.env ?? {}),
      ANTHROPIC_BASE_URL: this.launch?.baseUrl ?? this.profile.base_url.replace(/\/$/, ''),
      ...(secret ? { ANTHROPIC_AUTH_TOKEN: secret } : {}),
      ...(this.profile.protocol === 'openai-compatible' && !secret
        ? { ANTHROPIC_AUTH_TOKEN: 'awb-local-adapter' }
        : {}),
    };
  }

  claudeExecutable(): string | null {
    return this.profile.claude_executable ?? null;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#release) return this.#release();
    await this.terminate(false);
  }

  async terminate(managerDrain = false): Promise<void> {
    if (!this.child || this.profile.adapter?.lifecycle === 'reuse') return;
    if (!managerDrain && this.profile.adapter?.lifecycle === 'manager_exit') return;
    const exited = this.child.exitCode !== null || this.child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>(resolveExit => this.child!.once('exit', () => resolveExit()));
    if (this.child.pid) await terminateDetachedProcessTree(this.child.pid);
    await Promise.race([exited, new Promise<void>(resolveWait => setTimeout(resolveWait, 1_000))]);
  }
}

interface SharedRuntime {
  refs: number;
  lease: Promise<RuntimeLease>;
}
const sharedRuntimes = new Map<string, SharedRuntime>();

async function startUnshared(
  profile: RuntimeProfileSpec,
  credentialEnv: Record<string, string>,
): Promise<RuntimeLease> {
  validateRuntimeProfile(profile);
  if (!profile.adapter) return new RuntimeLease(profile, null, null, credentialEnv);
  const launch = buildAdapter(profile, credentialEnv);
  if (profile.adapter.lifecycle === 'reuse') {
    if (!(await healthy(launch.healthUrl))) throw new Error(`Adapter endpoint is not healthy: ${launch.healthUrl}`);
    return new RuntimeLease(profile, launch, null, credentialEnv);
  }
  if (isAbsolute(launch.bin)) {
    try {
      await access(launch.bin, fsConstants.X_OK);
    } catch {
      throw new Error(`Adapter executable is missing or not executable: ${launch.bin}`);
    }
  }
  if (await healthy(launch.healthUrl)) return new RuntimeLease(profile, launch, null, credentialEnv);
  const child = crossSpawn(launch.bin, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let spawnError: Error | null = null;
  child.once('error', error => { spawnError = error; });
  const timeout = profile.adapter.startup_timeout_ms ?? 120_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Adapter failed to start (${launch.bin}): ${(spawnError as Error).message}`);
    if (child.exitCode !== null) throw new Error(`Adapter exited before becoming ready (exit code ${child.exitCode})`);
    if (await healthy(launch.healthUrl)) return new RuntimeLease(profile, launch, child, credentialEnv);
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  const lease = new RuntimeLease(profile, launch, child, credentialEnv);
  await lease.terminate(true);
  throw new Error(`Adapter startup timed out after ${timeout}ms; health check: ${launch.healthUrl}`);
}

export async function startRuntimeProfile(
  profile: RuntimeProfileSpec,
  credentialEnv: Record<string, string> = {},
): Promise<RuntimeLease> {
  if (!profile.adapter) return startUnshared(profile, credentialEnv);
  const key = JSON.stringify(profile);
  let shared = sharedRuntimes.get(key);
  if (!shared) {
    shared = { refs: 0, lease: startUnshared(profile, credentialEnv) };
    sharedRuntimes.set(key, shared);
    shared.lease.catch(() => sharedRuntimes.delete(key));
  }
  shared.refs += 1;
  const owned = await shared.lease;
  return new RuntimeLease(profile, owned.launch, owned.child, credentialEnv, async () => {
    const current = sharedRuntimes.get(key);
    if (!current) return;
    current.refs = Math.max(0, current.refs - 1);
    if (current.refs > 0 || profile.adapter?.lifecycle === 'manager_exit') return;
    sharedRuntimes.delete(key);
    await owned.terminate();
  });
}

export function runtimeCredentialEnv(
  profile: RuntimeProfileSpec,
  credentialId: string | null | undefined,
  agentCredentialEnv: Record<string, string> | undefined,
): Record<string, string> {
  if (!profile.credential_ref) return {};
  if (!credentialId || credentialId !== profile.credential_ref) {
    throw new Error(
      `Claude backend profile "${profile.id}" references credential ${profile.credential_ref}, ` +
      'but the selected agent credential does not match',
    );
  }
  const authEnv = profile.auth_env || 'ANTHROPIC_AUTH_TOKEN';
  const secret = agentCredentialEnv?.[authEnv]
    ?? (authEnv === 'ANTHROPIC_AUTH_TOKEN' ? agentCredentialEnv?.ANTHROPIC_API_KEY : undefined);
  if (!secret) {
    if (profile.credential_required) throw new Error(`Claude backend profile "${profile.id}" requires an API-key credential`);
    return {};
  }
  return { [authEnv]: secret };
}

export async function shutdownRuntimeProfiles(): Promise<void> {
  const entries = [...sharedRuntimes.values()];
  sharedRuntimes.clear();
  await Promise.allSettled(entries.map(async entry => (await entry.lease).terminate(true)));
}
