// CliAdapter base interface — one adapter per CLI flavor. Managers
// (SubagentManager / BaseSessionManager subclasses) hold a single adapter
// instance and consult it for everything that varies across CLIs:
//
//   - bin resolution
//   - argv construction (one-shot vs persistent session)
//   - stdin turn formatting (persistent only)
//   - stdout line parsing (turn-progress + completion signals)
//   - one-shot result aggregation (so non-MCP CLIs can post their answer
//     back to AWB through the manager's REST connection)

import type { ChildProcess, StdioOptions } from 'node:child_process';

export const ADAPTER_CAPABILITIES = Object.freeze({
  /** Bidirectional stream-json over stdin/stdout, multi-turn over one process. */
  PERSISTENT_SESSION: 'persistent_session' as const,
  /** The spawned CLI itself can call AWB MCP tools (claude/codex). When false, the
   *  manager collects the CLI's stdout via collectOneshotResult() and posts the
   *  answer to AWB on the adapter's behalf. */
  NATIVE_MCP: 'native_mcp' as const,
});

export type AdapterCapability =
  (typeof ADAPTER_CAPABILITIES)[keyof typeof ADAPTER_CAPABILITIES];

export const PARSE_STAGE = Object.freeze({
  THINKING: 'thinking' as const,
  COMPOSING: 'composing' as const,
});

export type ParseStage = (typeof PARSE_STAGE)[keyof typeof PARSE_STAGE];

/** Board/workspace harness override shipped on `agent_trigger` (the server's
 *  resolved `harness_config`, ticket e9c7a896). Every key is optional; a
 *  null/absent harness means "spawn exactly as before". `model` is folded
 *  into the spec's `model` field by spawn sites (harness wins over the
 *  per-agent Agent.model default) so adapters that only support a model
 *  flag get it for free; the remaining keys are applied by adapters that
 *  declare them in `harnessKeys()` and warn-skipped everywhere else. */
export interface HarnessSpec {
  /** Appended after the role prompt in --append-system-prompt (never replaces it). */
  system_prompt_append?: string;
  /** Extra --allowedTools entries, appended to the adapter's base allowlist. */
  allowed_tools?: string[];
  /** --disallowedTools entries. */
  disallowed_tools?: string[];
  /** --model override; beats the per-agent Agent.model default. */
  model?: string;
  /**
   * Ordered fallback model chain (ticket 61f4dd18), highest priority first.
   * NOT a CLI flag — a manager-side retry policy read at the spawn site to
   * build the model chain `[primaryModel, ...fallback_models]`. Deliberately
   * absent from HARNESS_SPEC_KEYS so partitionHarness() never treats it as an
   * adapter flag (it would otherwise be warn-skipped / stripped); the spawn
   * site reads it off the PRE-partition harness.
   */
  fallback_models?: string[];
  /** Permission policy override; each adapter maps supported values to native flags. */
  permission_mode?: string;
}

export interface RuntimeProfileSpec {
  id: string;
  kind?: 'claude-backend';
  protocol: 'anthropic-compatible' | 'openai-compatible';
  base_url: string;
  model: string;
  /** Keep the Claude CLI/backend default by omitting `--effort`, even when the ticket preset has one. */
  omit_effort?: boolean;
  claude_executable?: string;
  cwd?: string;
  env?: Record<string, string>;
  args?: string[];
  credential_required?: boolean;
  credential_ref?: string;
  auth_env?: string;
  /** 백엔드 모델의 실제 context window(입력+출력 토큰 상한). 설정되면 spawn
   *  시점에 CLAUDE_CODE_MAX_CONTEXT_TOKENS 를 주입해, 미인식 커스텀 모델 id에
   *  대한 Claude Code 자체의 내부 추측 대신 실제 값을 쓰게 한다. 아래
   *  max_output_tokens 동적 clamp 의 기준값이기도 하다(ticket 7d8ea7c9 후속 —
   *  runtime-profiles.ts 의 resolveMaxOutputTokensEnv 참고). */
  context_window?: number;
  /** 이 백엔드에 요청할 출력 토큰 상한. Claude Code 자체 기본값(관측값
   *  32000)만으로도 큰 첫 턴 prompt 와 합쳐지면 context_window 를 넘길 수
   *  있다 — spawn 시점에 context_window 에서 known prompt 추정치와
   *  safety_margin_tokens 를 뺀 값으로 clamp 한 뒤 CLAUDE_CODE_MAX_OUTPUT_TOKENS
   *  로 주입한다. context_window 가 함께 설정된 경우에만 적용된다. */
  max_output_tokens?: number;
  /** ticket 41dc37cb round 3 — claude-with-vllm.sh 기준(운영 검증됨)의
   *  CLAUDE_CODE_AUTO_COMPACT_WINDOW 를 그대로 주입하기 위한 필드. 설정되면
   *  spawn 시점에 이 값을 CLAUDE_CODE_AUTO_COMPACT_WINDOW 로 주입해, CLI가
   *  context_window 상한에 닿기 전에 스스로 auto-compact 하도록 유도한다.
   *  생략 시 CLI 자체 기본 동작(기존 프로필 영향 없음). */
  auto_compact_window?: number;
  /** spawn 시점에 매니저가 볼 수 없는 모든 것(Claude Code 자체 기본 system
   *  prompt, CLI가 협상하는 MCP tool schema, 세션 메타데이터)을 위해 예약해
   *  두는 여유 토큰. 생략 시 DEFAULT_SAFETY_MARGIN_TOKENS(runtime-profiles.ts)
   *  로 기본값 지정된다. */
  safety_margin_tokens?: number;
  adapter?: {
    command?: string;
    module?: string;
    executable?: string;
    python?: string;
    venv?: string;
    cwd?: string;
    env?: Record<string, string>;
    args?: string[];
    base_url: string;
    startup_timeout_ms?: number;
    health_check?: string;
    lifecycle?: 'on_release' | 'manager_exit' | 'reuse';
  };
}

// Per-CLI FLAG keys only — the subset partitionHarness() maps onto adapter
// arguments. `fallback_models` is intentionally excluded (retry policy, not a
// flag); it rides on HarnessSpec but is consumed at the spawn site directly.
export const HARNESS_SPEC_KEYS = [
  'system_prompt_append',
  'allowed_tools',
  'disallowed_tools',
  'model',
  'permission_mode',
] as const;

/**
 * Split a harness into the subset `adapter` can apply (per its
 * `harnessKeys()`) and the key names it can't. Spawn sites log the skipped
 * keys and proceed — a harness key the CLI can't express is a graceful skip,
 * never a refusal to spawn. Returns `applied: null` when nothing survives so
 * downstream `if (harness)` guards keep their null-safe shape.
 */
export function partitionHarness(
  adapter: CliAdapter,
  harness: HarnessSpec | null | undefined,
): { applied: HarnessSpec | null; skipped: string[] } {
  if (!harness) return { applied: null, skipped: [] };
  const supported = new Set<string>(adapter.harnessKeys());
  const applied: HarnessSpec = {};
  const skipped: string[] = [];
  for (const key of HARNESS_SPEC_KEYS) {
    if (harness[key] === undefined) continue;
    if (supported.has(key)) (applied as any)[key] = harness[key];
    else skipped.push(key);
  }
  return { applied: Object.keys(applied).length > 0 ? applied : null, skipped };
}

/**
 * Build the ordered model chain to try for a spawn (ticket 61f4dd18). The
 * primary (whatever won the model precedence: effort-preset ?? harness ??
 * per-agent ?? null) is the head; the harness `fallback_models` list follows
 * in priority order. Empty/blank entries are dropped and duplicates collapse
 * (a fallback equal to the primary or to an earlier fallback adds no attempt).
 * `null` (CLI's own default) is a valid head — kept as the first element so a
 * board that only lists fallbacks still tries the CLI default first.
 *
 * A chain of length 1 == current behaviour (single spawn, no fallback).
 */
export function buildModelChain(
  primary: string | null | undefined,
  fallbacks: string[] | null | undefined,
): (string | null)[] {
  const head = typeof primary === 'string' && primary.trim() ? primary.trim() : null;
  const chain: (string | null)[] = [head];
  const seen = new Set<string>(head ? [head] : []);
  for (const raw of fallbacks ?? []) {
    const m = typeof raw === 'string' ? raw.trim() : '';
    if (!m || seen.has(m)) continue;
    seen.add(m);
    chain.push(m);
  }
  return chain;
}

/**
 * subagent-manager.ts와 base-session-manager.ts 양쪽 spawn 지점이 공유하는
 * 체인 결정 진입점 — ticket 41dc37cb 리뷰 라운드1. 바인딩된 Claude backend
 * profile은 세션을 하나의 endpoint 뒤 하나의 served model에 고정한다 —
 * 그 백엔드에는 폴백할 다른 model이 없다. `harness.fallback_models`는
 * plain-Anthropic 멀티티어 케이스(opus 시도 후 sonnet 시도 등)를 겨냥한
 * 것이라 단일-model 백엔드에는 아무 의미가 없다. 이를 profile-bound 체인
 * 까지 확장하면 폴백-적격 재시도의 `--model`이 다시 임의의 board-설정
 * 문자열이 될 것이다 — 실패를 복구하려는 바로 그 경로에서. 그래서
 * profile이 바인딩된 동안 체인은 `[null]`이다(길이 1 — buildModelChain의
 * bound 체크 참고; round 3가 profile 세션에서 `--model` 자체를 완전히
 * 없앴으므로 재시도할 alias조차 없다). 이로써 폴백 respawn은 no-op이
 * 되고 죽음은 fallback_models가 전혀 설정되지 않았을 때와 동일하게 일반
 * breaker/silent-exit 경로로 떨어진다. profile 없는 경로는
 * `buildModelChain`과 byte-for-byte 동일 — 무변경.
 */
export function resolveModelChain(
  effectiveModel: string | null,
  claudeRuntimeProfile: RuntimeProfileSpec | null | undefined,
  fallbackModels: string[] | null | undefined,
): (string | null)[] {
  return buildModelChain(effectiveModel, claudeRuntimeProfile ? null : fallbackModels);
}

/**
 * Ticket-level "effort preset" channel — a PARALLEL surface to HarnessSpec,
 * deliberately NOT folded into HARNESS_SPEC_KEYS. A Ticket carries an abstract
 * preset id; Board settings map that id to per-CLI options. The server resolves
 * the matched preset and ships it on the SSE `agent_trigger` payload (field
 * `effort_preset`). Claude expresses the rich surface (--effort flag +
 * `ultracode` prompt keyword); codex / antigravity get model-only and the rest
 * is gracefully skipped. Shapes must agree byte-for-byte with the server's
 * effort-preset config (JSON keys identical on both sides).
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/** The claude-family slice of a preset — the only CLI that maps the full
 *  surface. `effort` → claude `--effort`; `ultracode` → the prompt keyword
 *  appended to the task text / first session turn (NOT a flag); `model` →
 *  `--model` (folded into the model precedence at the spawn site). */
export interface EffortSlice {
  model?: string;
  effort?: EffortLevel;
  ultracode?: boolean;
}

/** The single matched/board-default preset shipped on the trigger event. Null
 *  on the wire (or after a defensive parse) means "no effort override — spawn
 *  exactly as before", mirroring the harness null-safe contract. */
export interface ResolvedEffortPreset {
  id: string;
  label?: string;
  claude?: EffortSlice;
  codex?: { model?: string };
  antigravity?: { model?: string };
  pi?: { model?: string };
}

/**
 * Pick the per-CLI slice of a resolved effort preset for `cliType`:
 *   - claude / deepseek → the rich `claude` slice (model + effort + ultracode)
 *   - codex             → the codex slice (model only)
 *   - antigravity       → the antigravity slice (model only)
 *   - pi                → the pi slice (model only)
 *   - anything else / a null preset → null
 * The return shape is normalized to `{ model?, effort?, ultracode? }` so the
 * spawn site can fold `model` into the model precedence and pass `effort` /
 * `ultracode` straight through (codex / antigravity / pi slices never carry
 * the latter two, so they degrade to model-only automatically).
 */
export function selectEffortSlice(
  cliType: string,
  preset: ResolvedEffortPreset | null | undefined,
): { model?: string; effort?: string; ultracode?: boolean } | null {
  if (!preset) return null;
  const t = String(cliType || '').toLowerCase();
  if (t === 'claude' || t === 'deepseek') {
    const s = preset.claude;
    if (!s) return null;
    return { model: s.model, effort: s.effort, ultracode: s.ultracode };
  }
  if (t === 'codex') {
    const s = preset.codex;
    if (!s) return null;
    return { model: s.model };
  }
  if (t === 'antigravity') {
    const s = preset.antigravity;
    if (!s) return null;
    return { model: s.model };
  }
  if (t === 'pi') {
    const s = preset.pi;
    if (!s) return null;
    return { model: s.model };
  }
  return null;
}

/** One-line summary of an applied harness for spawn-site logs — the
 *  operator-visible proof (acceptance criterion of e9c7a896) that a board's
 *  harness actually reached the CLI flags. */
export function describeHarness(harness: HarnessSpec): string {
  const parts: string[] = [];
  if (harness.model) parts.push(`model=${harness.model}`);
  if (harness.permission_mode) parts.push(`permission_mode=${harness.permission_mode}`);
  if (harness.allowed_tools?.length) parts.push(`allowed_tools=+${harness.allowed_tools.length}`);
  if (harness.disallowed_tools?.length) parts.push(`disallowed_tools=${harness.disallowed_tools.length}`);
  if (harness.system_prompt_append) {
    parts.push(`system_prompt_append=${harness.system_prompt_append.length}ch`);
  }
  return parts.join(' ');
}

export interface OneshotSpec {
  rolePrompt: string;
  taskText: string;
  mcpConfigPath: string | null;
  /** Concrete process working directory selected for this run. Adapters with
   *  their own workspace-root flag (notably Codex `--cd`) should pass the same
   *  path explicitly so CLI-side root discovery cannot diverge from spawn cwd. */
  cwd?: string | null;
  /** Effective CLI home used by this spawn. Native-config adapters may read
   *  it immediately before descriptor creation to validate config plus any
   *  per-spawn overrides as one effective configuration. */
  cliHomeDir?: string | null;
  /** Per-run AWB attribution for native MCP adapters whose MCP config is
   *  loaded from their CLI home rather than a per-spawn JSON file. */
  mcpAttribution?: McpAttribution;
  /** Per-agent default model to pass to the CLI (e.g. `--model <id>`). When
   *  empty/null the adapter omits the flag and the CLI uses its own default
   *  (current behaviour). Resolved from Agent.model at spawn time; a
   *  harness `model` override is folded in here by the spawn site. */
  model?: string | null;
  /** Board/workspace harness, pre-filtered to this adapter's supported keys
   *  via partitionHarness(). Null/absent → spawn exactly as before. */
  harness?: HarnessSpec | null;
  /** Ticket-level effort preset, resolved to this CLI's slice at the spawn
   *  site (selectEffortSlice). claude maps it to `--effort`; null/absent →
   *  no flag. SEPARATE from harness — codex / antigravity never receive it. */
  effort?: string | null;
  /** Ticket-level "ultracode" opt-in — appends the `ultracode` keyword to the
   *  task text so the spawned Claude Code subagent enters multi-agent
   *  orchestration. NOT a flag. Ignored by non-claude adapters. */
  ultracode?: boolean;
}

export interface McpAttribution {
  clientType?: 'managed-subagent' | 'subagent';
  ticketId?: string;
  role?: string;
  triggerSource?: string;
  triggerId?: string;
  sessionId?: string;
}

export interface SessionSpec {
  rolePrompt: string;
  mcpConfigPath: string | null;
  /** 세션 전략이 선택한 실제 CLI lifecycle 동작과 식별자. */
  sessionMode?: 'persistent' | 'resume' | 'control';
  sessionId?: string;
  /** Per-agent default model — see OneshotSpec.model. */
  model?: string | null;
  /** Board/workspace harness — see OneshotSpec.harness. */
  harness?: HarnessSpec | null;
  /** Ticket-level effort preset slice — see OneshotSpec.effort. Applied at
   *  session creation only. */
  effort?: string | null;
  /** Ticket-level "ultracode" opt-in — see OneshotSpec.ultracode. For a
   *  session the keyword is folded into the composed system prompt at session
   *  creation only. */
  ultracode?: boolean;
}

export interface SpawnDescriptor {
  args: string[];
  stdio: StdioOptions;
  writePrompt?: (child: ChildProcess) => void;
  needsMcpConfig?: boolean;
}

export interface ParseResult {
  stage: ParseStage | null;
  isResult: boolean;
  isError: boolean;
  raw: any;
}

/** Per-turn image attachment payload handed to `formatTurn`. Currently
 *  Claude is the only adapter that consumes these (stream-json image
 *  content blocks); other adapters get the list but ignore it. */
export interface TurnImage {
  media_type: string;
  /** Base64 image bytes (no `data:` URI prefix). */
  data: string;
}

/** Token/cost usage extracted from a single CLI result event (ticket 6dd3f968).
 *  All fields are nullable — a CLI that doesn't report a given figure (Codex has
 *  no cost concept; Antigravity has no structured usage at all) omits it rather
 *  than guessing. Numbers are per-EVENT (one turn / one query), not cumulative —
 *  callers accumulate across turns themselves (see cli-usage-accumulator.ts). */
export interface CliUsageSnapshot {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  /** USD, as reported by the CLI itself. null when the CLI has no cost concept
   *  (Codex/Gemini-family) or the underlying backend isn't priced in Anthropic
   *  terms (DeepSeek — see deepseek.ts override). */
  total_cost_usd: number | null;
}

/** Normalized "what the CLI is doing right now" signal, extracted from a single
 *  one-shot stdout event by {@link CliAdapter.parseProgressEvent}. The subagent
 *  manager renders these into `type='progress'` chat-room heartbeats for chat
 *  one-shots (ticket c47194d9 — Codex), the one-shot twin of the persistent
 *  Claude session's tool_use progress. `status` is the three user-visible states
 *  the chat window must tell apart: 'start' (작업 중), 'success' (완료),
 *  'error' (실패). */
export interface CliProgressEvent {
  /** Action family — selects the leading icon on a 'start' heartbeat. */
  kind: 'command' | 'tool' | 'file' | 'search' | 'task' | 'other';
  /** Short human label (e.g. '명령', 'awb:add_comment', '파일 변경'). */
  label: string;
  /** Optional detail rendered after the label (command text, query, paths). */
  detail?: string;
  /** Lifecycle state this event represents. */
  status: 'start' | 'success' | 'error';
}

export abstract class CliAdapter {
  static cliType = 'base';

  capabilities: Set<AdapterCapability> = new Set();

  has(cap: AdapterCapability): boolean {
    return this.capabilities.has(cap);
  }

  get cliType(): string {
    return (this.constructor as typeof CliAdapter).cliType;
  }

  abstract resolveBin(configured?: string | null): string;

  abstract buildOneshotSpawn(spec: OneshotSpec): SpawnDescriptor;

  buildSessionSpawn(_spec: SessionSpec): SpawnDescriptor {
    throw new Error(`${this.cliType}: buildSessionSpawn not implemented`);
  }

  /**
   * Encode a persistent-session turn. Persistent adapters (Claude) build
   * stream-json user messages here; one-shot adapters never call this path.
   *
   * `images` is an optional array of base64 image attachments the session
   * manager wants delivered inline (chat attachment vision). Adapters that
   * support inline image content blocks include them in the turn payload;
   * others ignore the list (the session manager already pushed the
   * metadata into the prompt text via composeChatRoomPrompt).
   */
  formatTurn(_text: string, _images?: TurnImage[]): string {
    throw new Error(`${this.cliType}: formatTurn not implemented`);
  }

  abstract parseStdoutLine(line: string): ParseResult;

  collectOneshotResult(_lines: string[]): string | null {
    return null;
  }

  /**
   * Extract a normalized progress signal from a single already-parsed one-shot
   * stdout event (the object `parseStdoutLine` put on `ParseResult.raw`, or a
   * freshly `JSON.parse`d line). The subagent manager calls this for CHAT
   * one-shots and posts the result as a `type='progress'` chat heartbeat — the
   * one-shot twin of the persistent Claude session's tool_use progress, so a
   * Codex chat shows its in-flight work in the chat window like Claude does.
   *
   * Default returns null (no progress surface — Claude chat takes the
   * persistent path, antigravity/custom CLIs opt in by overriding). Codex maps
   * its `item.started` / `item.completed` / `turn.failed` thread events onto the
   * three user-visible states. MUST be pure + best-effort: return null on
   * anything unrecognized and NEVER throw (it runs inside a stdout line handler).
   */
  parseProgressEvent(_raw: any): CliProgressEvent | null {
    return null;
  }

  /**
   * Extract token/cost usage from a single already-parsed CLI stdout event —
   * the object `parseStdoutLine` put on `ParseResult.raw`, or a freshly
   * `JSON.parse`d line. Called on EVERY stdout line (both oneshot and
   * persistent-session paths, ticket 6dd3f968) so it MUST be pure, best-effort,
   * and NEVER throw — a bad line returns null rather than breaking capture.
   *
   * Default returns null (no usage surface). Antigravity's plain-text output
   * has nothing structured to extract and inherits this as its permanent
   * answer; Claude/Codex override with their own event shapes.
   */
  extractUsage(_raw: any): CliUsageSnapshot | null {
    return null;
  }

  /**
   * Harness keys this adapter can express at spawn time. Base = `model`
   * only — every adapter already threads `spec.model` into its argv (codex /
   * antigravity gained `--model` in a52114b). Claude-family adapters
   * override with the full HARNESS_SPEC_KEYS set. Spawn sites use this via
   * partitionHarness() to warn + skip keys the CLI can't map.
   */
  harnessKeys(): ReadonlyArray<keyof HarnessSpec> {
    return ['model'];
  }

  /**
   * Per-spawn env overrides derived from the applied harness. Default none.
   * DeepSeek overrides this to mirror a harness `model` into ANTHROPIC_MODEL
   * so the flag and the env always agree (same flag/env-agreement rule as
   * 5380544 — prepareCliHome bakes the per-agent model into extra_env at
   * spawn_agent time, which would otherwise override a per-dispatch flag).
   * Merged LAST into the child env by spawn sites.
   */
  harnessEnv(_harness: HarnessSpec | null | undefined): Record<string, string> {
    return {};
  }

  /**
   * Best-effort enumeration of the model ids this CLI build accepts for its
   * `--model` flag (or model env). The manager calls this once at boot and
   * ships the result to AWB via the instance heartbeat (`available_models`)
   * so the admin UI can populate a per-agent model selector from the CLI
   * actually installed on this host — not a value hardcoded in AWB.
   *
   * Contract: MUST be best-effort and MUST NOT throw. Return [] when the CLI
   * can't be enumerated; the AWB client falls back to a free-text model
   * input in that case. Default [] = "no enumeration for this CLI".
   */
  async listModels(_credential?: AdapterCredential | null): Promise<string[]> {
    return [];
  }

  /**
   * Env-var name the underlying CLI consults to override its config home
   * directory. Manager uses this to point each managed agent at its own
   * `<MANAGER_HOME>/agents/<id>/cli-home/` so per-agent CLI state
   * (sessions, plugins, settings) stays isolated.
   *
   * Returning `null` means "this CLI has no config-home env var" — the
   * manager skips injection and the spawn shares whatever the manager
   * process inherited (typically the operator's $HOME).
   */
  configDirEnv(): string | null {
    return null;
  }

  /**
   * Names of operator-inherited environment variables that this CLI consults
   * for authentication (typically API keys). When the spawned agent has its
   * own per-agent credential configured, the manager removes these from the
   * child env BEFORE merging the per-agent credential's extraEnv — without
   * the strip, an operator-side `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`,
   * `GEMINI_API_KEY`, `GOOGLE_API_KEY`) silently overrides the per-agent
   * `.credentials.json` / `auth.json` / `oauth_creds.json` file the adapter
   * just wrote into the per-agent cli-home, defeating the whole point of
   * per-agent credentials.
   *
   * Returning [] (default) means "no env vars to strip" — used by adapters
   * that do not have a known operator-inherited auth env var.
   */
  authEnvKeys(): string[] {
    return [];
  }

  /**
   * Snapshot of a managed agent's CLI credential at heartbeat time —
   * just enough for the AWB admin UI to flag agents whose OAuth token is
   * about to expire. Read on every InstanceHeartbeat tick by `main.ts`'s
   * `agentCredentialMetaProvider`; never persisted on disk.
   *
   * Adapter contract: read whatever auth file the CLI keeps in
   * `cli-home` (claude → `.credentials.json`) and compute the values
   * below. Return `null` to signal "not applicable / nothing to surface"
   * (the CLI uses an env var, the adapter doesn't model expirations,
   * etc.). Errors must NOT throw — the heartbeat is best-effort.
   *
   * Importantly, the adapter NEVER returns the raw token. The fields
   * here are all derived metadata; the heartbeat ships the same shape
   * verbatim to AWB. This keeps the credential body inside the cli-home
   * dir on the manager host and out of any network traffic.
   */
  async readCredentialMeta(_cliHomeDir: string): Promise<AgentCredentialMeta | null> {
    return null;
  }

  /**
   * True when the CLI would surface an interactive workspace-trust dialog for
   * THIS dispatch — i.e. the CLI has a trust-dialog concept AND the resolved
   * harness does not bypass it (ticket 48aeab6e's dispatch preflight consults
   * this before spending an I/O read on {@link readTrustMeta}).
   *
   * Base default false: codex / antigravity / pi always spawn under a
   * hardcoded dangerously-bypass flag (see their buildOneshotSpawn) with no
   * analogous trust gate at all, so trust is never a concern for them
   * regardless of harness. ClaudeCliAdapter overrides.
   */
  requiresWorkspaceTrust(_harness?: HarnessSpec | null): boolean {
    return false;
  }

  /**
   * Read whether `cwd` is trust-approved in this agent's CLI config home, for
   * the dispatch-time preflight gate (ticket 48aeab6e) — a SEPARATE concern
   * from {@link readCredentialMeta}'s heartbeat-only auth snapshot: this one
   * gates a spawn BEFORE it happens rather than just informing the admin UI.
   *
   * Return `null` to mean "can't tell" (no config file yet, unreadable,
   * unrecognized shape) — the preflight fails OPEN on null, matching every
   * other ambiguous-probe convention in this codebase (an I/O hiccup must
   * never wedge a ticket). Only called when {@link requiresWorkspaceTrust}
   * returned true. Base default null — only meaningful for adapters that can
   * return true there.
   */
  async readTrustMeta(_cliHomeDir: string, _cwd: string): Promise<CliTrustMeta | null> {
    return null;
  }

  /**
   * `cwd`를 이 에이전트의 CLI 설정 홈에서 멱등하게 trust-승인 상태로 표시한다
   * (ticket 152e3606) — Action/QA/security run 작업폴더(`.awb/act|qa|base`)가
   * 프로비저닝/확정된 직후, {@link readTrustMeta}를 참조하기 전에 디스패치
   * 레이어가 호출한다. AWB 스스로 그 폴더를 만들고 `.claude/settings.json`도
   * 직접 심었으므로 사람이 남길 trust 판단이 없다 — 읽기 전용 preflight
   * ({@link readTrustMeta} / `decideCliTrustReadiness`, ticket 48aeab6e)가
   * 지금까지 할 수 있었던 건 "감지 후 차단"뿐이었는데, 비대화형 run
   * (Action/QA/security)에는 그 대화상자를 수락해줄 사람이 아예 없어서
   * 차단이 곧 무한 대기로 이어졌다 — 이 함수가 그 간극을 메운다.
   *
   * 정신적으로는 반드시 best-effort여야 한다: 여기서 던진 에러는 호출자가
   * 잡아서 로그만 남기고, 원래대로라면 성공했을 디스패치를 절대 중단시키지
   * 않는다(예: `bypassPermissions` 아래에서는 trust 자체가 무의미하므로).
   * 베이스 기본값은 no-op — {@link requiresWorkspaceTrust}를 구현하는
   * 어댑터에만 의미가 있다.
   *
   * 주의: 티켓 디스패치가 쓰는 per-ticket worktree(`.awb/wt/<ticket>`)에서는
   * `requiresWorkspaceTrust(harness)`가 참일 때(운영자가 명시적으로
   * 비-bypassPermissions `permission_mode`를 설정한 경우)는 호출자가 이
   * 함수를 아예 부르지 않는다 — 그 경로는 ticket 48aeab6e가 의도적으로
   * 설계한 게이트(그런 운영자는 trust 승인을 사람이 직접 하길 원한다)이고,
   * 실제로 `cli-readiness-block-pend.test.mjs`가 그 계약을 고정해둔
   * 테스트다. `requiresWorkspaceTrust`가 거짓(기본 bypassPermissions)일
   * 때는 호출자가 이 함수를 fire-and-forget으로(await하지 않고) 호출해
   * 미리 시딩해둔다 — 지금 당장은 무관하지만 그 폴더가 나중에
   * non-bypass harness로 재사용될 때를 대비한다.
   */
  async ensureWorkspaceTrust(_cliHomeDir: string, _cwd: string): Promise<void> {
    return;
  }

  /**
   * Optional hook called once per spawn_agent after `ensureCliHomeDir`
   * creates the per-agent dir. Override to copy / symlink any
   * credentials or shared state the CLI needs before it can run — most
   * commonly the operator's auth token, which the CLI looks for inside
   * its config home and which a fresh per-agent home would miss.
   *
   * When the agent has its own per-agent credential configured (the
   * caller passes `credential` non-null), the adapter is expected to:
   *   - subscription kind → write the credential file(s) verbatim into
   *     cli-home and SKIP the operator-HOME symlink for any auth file
   *     it just wrote (otherwise the next call would clobber the
   *     per-agent value with the operator's).
   *   - api_key kind → return the matching `extraEnv` (ANTHROPIC_API_KEY,
   *     OPENAI_API_KEY, GEMINI_API_KEY) and remove any stale auth
   *     credential file that might still be symlinked from the operator
   *     HOME so the env var unambiguously decides auth.
   *
   * Returns extra environment variables to inject on every spawn for
   * this agent (api_key kind contributes; subscription kind returns {}).
   * Caller stores them in ManagedAgentContext.extra_env so both
   * subagents (one-shot) and persistent sessions pick them up.
   *
   * Throws on real I/O failures so the caller can surface them; the
   * caller is expected to wrap in try/catch since prep failure is
   * usually non-fatal (the CLI will surface its own "not authed"
   * error on next run, which is more actionable than a manager log
   * line about a missing file).
   */
  async prepareCliHome(
    _cliHomeDir: string,
    _credential?: AdapterCredential | null,
    _mcp?: AdapterMcpContext | null,
    // Per-agent default model (Agent.model). Most adapters pass the model via
    // the `--model` argv flag (see buildOneshotSpawn) and ignore this. The
    // deepseek adapter — which drives the claude binary against DeepSeek's
    // backend — uses it to set ANTHROPIC_MODEL so the env and the inherited
    // `--model` flag always carry the SAME value (precedence-independent).
    _model?: string | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    return { extraEnv: {} };
  }
}

/** Decrypted per-agent credential payload as it reaches the adapter. The
 *  manager has already validated AWB ownership; the adapter only checks the
 *  provider prefix matches its CLI before applying. */
export interface AdapterCredential {
  credential_id: string;
  provider: string;
  fields: Record<string, string>;
}

/** AWB MCP endpoint + per-agent apiKey, threaded into `prepareCliHome` so
 *  adapters whose CLI consumes MCP servers via a static config file (e.g.
 *  antigravity's `mcp_config.json` `mcpServers`) can persist the AWB server into
 *  the per-agent cli-home at spawn_agent time. Adapters that pass MCP
 *  config via a per-spawn flag (claude `--mcp-config`) ignore this and
 *  return early — the manager still writes its own `mcp-config.json` for
 *  those at the per-agent dir level. */
export interface AdapterMcpContext {
  /** Base AWB URL (e.g. `https://awb.example.com`); the `/mcp` suffix is
   *  appended by the adapter. */
  url: string;
  /** Per-agent apiKey (the same one written to `<agent>/apikey`) for the
   *  `Authorization: Bearer ...` header on the MCP server entry. */
  apiKey: string;
}

/**
 * Heartbeat-side credential snapshot. Produced by
 * `CliAdapter.readCredentialMeta(cliHomeDir)` once per heartbeat tick;
 * shipped to AWB via `instance-heartbeat` so the admin UI can render
 * "expires in N hours" badges without ever seeing the raw token.
 *
 * `kind`:
 *   - 'subscription' — OAuth credential file present (claude
 *     `.credentials.json` with `claudeAiOauth`); `expires_at_ms` and
 *     `refresh_token_present` are meaningful.
 *   - 'api_key' — env-var auth (`ANTHROPIC_API_KEY` etc.); no expiry
 *     concept, both fields are null/false.
 *   - 'unknown' — file present but unreadable / not in expected shape.
 *     Surface this so the UI can warn instead of silently appearing
 *     "always healthy".
 */
export interface AgentCredentialMeta {
  kind: 'subscription' | 'api_key' | 'unknown';
  /** OAuth access-token expiry (Unix milliseconds) or null when not
   *  applicable. Refreshed on every heartbeat so the value tracks the
   *  CLI's own silent-rotate of the access token. */
  expires_at_ms: number | null;
  /** True when an OAuth refresh_token is present and the access token
   *  can auto-renew. False for api_key kind (no refresh concept) and
   *  for subscription credentials missing the refresh_token field —
   *  in that second case, expiry is silent failure waiting to happen. */
  refresh_token_present: boolean;
}

/**
 * Dispatch-preflight-side trust snapshot. Produced by
 * `CliAdapter.readTrustMeta(cliHomeDir, cwd)` for the ticket 48aeab6e
 * dispatch gate — a single boolean, since (unlike credential expiry) there is
 * nothing else worth surfacing about a workspace-trust decision.
 */
export interface CliTrustMeta {
  /** hasTrustDialogAccepted for this exact cwd, per the CLI's own config. */
  trusted: boolean;
}
