// Routes parsed SSE events (trigger / chat_request / chat_room_message /
// board_update / comment_mention / fs_request) to the appropriate session or
// subagent manager. Extracted from EventStream so the SSE pipe can stay a thin
// connect/parse loop.
//
// Runtime Host invariant: events run only through an explicitly owned Agent
// runtime. There is no editor/stdin main-session fallback; unavailable routes
// fail closed and are logged.

import { log } from './logging.js';
import { loadAgentInfo } from './config.js';
import { spawnFailureTracker } from './spawn-failure-tracker.js';
import {
  fetchTicketContext,
  fetchChatRoomHistory,
  fetchAgentRecord,
  fetchRepositoryCredential,
  hasNewAgentComment,
  postFsResponse,
  postChatRoomMessage,
  postDispatchAck,
  provisionManagedAgentApiKey,
} from './rest.js';
import { readApiKey, writeApiKey, writeMcpConfig } from './managed-agent-store.js';
import { recordEvent } from './event-log-recorder.js';
import type { AwbConfig } from './rest.js';
import type { RunSessionBinding } from './base-session-manager.js';
import type { ManagedAgentContextRegistry } from './managed-agent-context.js';
import type { WorktreeManager, WorktreeMode } from './worktree-manager.js';
import { prepareChatAttachments } from './chat-attachment-prep.js';
import { injectWorkFolder, worktreeInstructionsFor } from './prompts.js';
import type { ChatReplyMode } from './prompts.js';
import { DispatchBlockerTracker, DispatchBlockTracker, InflightDispatchTracker, PendingDispatchRetry, RoleSpawnSuppressor, classifyWorktreeOutcome, decideCliAuthReadiness, decideCliTrustReadiness, managedWorktreePath, provisioningPendReason } from './dispatch-preflight.js';
import type { PendingRetryEntry, RetryScheduler } from './dispatch-preflight.js';
import { SessionLimitDeferStore } from './session-limit-defer.js';
import type { HarnessSpec, RuntimeProfileSpec, ResolvedEffortPreset, EffortLevel } from './cli-adapters/base.js';
import type { AgentRuntimeConfig } from './runtime/runtime-types.js';
import type {
  RuntimeDispatchResult,
  RuntimeSupervisor,
} from './runtime/runtime-supervisor.js';
import type { RuntimeEvent } from './runtime/runtime-events.js';
import { createAdapter, ADAPTER_CAPABILITIES } from './cli-adapters/index.js';
import {
  parseRunProvision,
  provisionRunWorkspace,
  reconcileRunBaseWorkingDir,
  resolveRunFolder,
  resolveRunCompletionRoute,
} from './run-provisioner.js';

interface ResolvedEnvironmentConfig {
  repositories: Array<{ resource_id?: string; url: string; target_dir: string; branch: string; post_clone_commands: string[] }>;
  env_vars: Record<string, string>;
  setup_commands: string[];
  setup_timeout_seconds: number;
  version: number;
}
import { FolderMutex } from './run-execution-lock.js';
import type { RunLockHandle } from './run-execution-lock.js';
import { fireAndForgetTool } from './mcp-client.js';
import { mentionTriggerId } from './subagent-manager.js';
import { SHARED_WORKTREE_COLD_IMPORT_TTL_MINUTES } from './constants.js';
import { createHash } from 'node:crypto';
import {
  SkillMaterializer,
  type RuntimeSkillSnapshot,
} from './skills/skill-materializer.js';

/**
 * Defensive parse of the `harness_config` field on a flattened agent_trigger
 * event (ticket e9c7a896). The server ships the resolved board/workspace
 * harness as a JSON object (or omits it — older servers / unconfigured
 * boards). Accepts an object or a JSON string, keeps only the known keys
 * with the right runtime types, and degrades to null on anything else —
 * a malformed harness must never block the dispatch it rides on.
 */
export function parseHarnessConfig(raw: unknown): HarnessSpec | null {
  let obj: any = raw;
  if (typeof obj === 'string') {
    if (!obj.trim()) return null;
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: HarnessSpec = {};
  if (typeof obj.system_prompt_append === 'string' && obj.system_prompt_append.trim()) {
    out.system_prompt_append = obj.system_prompt_append;
  }
  for (const key of ['allowed_tools', 'disallowed_tools'] as const) {
    if (Array.isArray(obj[key])) {
      const list = obj[key].filter((t: unknown) => typeof t === 'string' && (t as string).trim());
      if (list.length > 0) out[key] = list;
    }
  }
  for (const key of ['model', 'permission_mode'] as const) {
    if (typeof obj[key] === 'string' && obj[key].trim()) out[key] = obj[key].trim();
  }
  // Ordered fallback model chain (ticket 61f4dd18) — priority order preserved,
  // blanks dropped. NOT a CLI flag (see HarnessSpec.fallback_models): the spawn
  // site reads it off the pre-partition harness to build the model chain.
  if (Array.isArray(obj.fallback_models)) {
    const list = obj.fallback_models
      .filter((m: unknown) => typeof m === 'string' && (m as string).trim())
      .map((m: string) => m.trim());
    if (list.length > 0) out.fallback_models = list;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Required fields of RuntimeProfileSpec (cli-adapters/base.ts) — NOT
 *  `provider`, which was never part of the actual wire/DB schema (ticket
 *  7d8ea7c9 root cause B). The old `provider` check meant every real profile
 *  failed validation and silently returned null, so no per-agent Claude
 *  backend profile could ever apply. */
function isRuntimeProfileShape(value: any): value is RuntimeProfileSpec {
  return (
    typeof value.id === 'string'
    && (value.protocol === 'anthropic-compatible' || value.protocol === 'openai-compatible')
    && typeof value.base_url === 'string'
    && typeof value.model === 'string'
  );
}

export function parseRuntimeProfile(raw: unknown): RuntimeProfileSpec | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    log(`parseRuntimeProfile: expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw} — dropping`);
    return null;
  }
  const value = raw as any;
  if (!isRuntimeProfileShape(value)) {
    log(
      `parseRuntimeProfile: malformed runtime profile (id=${String(value?.id ?? '')}) — ` +
        `missing/invalid required field(s), dropping and spawning without a runtime profile`,
    );
    return null;
  }
  return value as RuntimeProfileSpec;
}

/** 티켓 0fbe802c: ticket-dispatch 경로(#dispatchTriggerBody)의 runtime profile
 *  우선순위 결정 — per-agent DB 프로필(rawCliRuntimeProfile로 전달된
 *  ev.cli_runtime_profile)이 정상 파싱되면 그것을 최우선으로 쓰고, 없을 때만
 *  인스턴스 전역 `--runtime-profile` 오버라이드(instanceOverride)로 폴백한다.
 *  오버라이드조차 없으면(undefined) null → CLI 기본값.
 *
 *  이전에는 인스턴스 오버라이드가 설정되어 있으면(!== undefined) 항상
 *  최우선이라 다중-agent 호스트에서 오버라이드가 모든 agent의 티켓 작업을
 *  자신의 per-agent 프로필과 무관하게 그 백엔드로 강제했다 — chat 경로에서
 *  7d8ea7c9가 고친 것과 동일한 교차 오염. chat 경로는 오버라이드를 아예
 *  참조하지 않지만(전적으로 per-agent 소스), ticket-dispatch 경로는 per-agent
 *  프로필이 없는 agent에게는 여전히 인스턴스 단위 오버라이드가 유효한
 *  폴백으로 남는다 — 단일-agent 호스트가 `--runtime-profile <file>`로 DB
 *  변경 없이 전체를 그 백엔드로 돌리는 기존 용법을 보존하기 위함. */
export function resolveTriggerRuntimeProfile(
  rawCliRuntimeProfile: unknown,
  instanceOverride: RuntimeProfileSpec | null | undefined,
): RuntimeProfileSpec | null {
  return parseRuntimeProfile(rawCliRuntimeProfile) ?? instanceOverride ?? null;
}

/** ticket 7d8ea7c9 (review round 1 + round 2): chat_room_message broadcast의
 *  agent별 profile map에서 바로 이 responder의 Claude backend profile을
 *  골라낸다. chat_request(단일 대상 agent → 평면 cli_runtime_profile
 *  필드)와 달리 chat_room_message는 방의 모든 멤버에게 팬아웃되므로, 서버는
 *  해석된 profile을 agent_id로 키잉해 보낸다(RoomMessagingService가
 *  Claude-type 멤버마다 하나씩 항목을 해석) — 각 매니저는 단일 ambient
 *  필드에 의존하는 대신 맵에서 자기 responder의 항목을 먼저 골라 쓴다.
 *
 *  라운드 2 P1: 이 responder의 map 항목이 없거나(또는 형식 오류) 해석
 *  실패하면 resolveTriggerRuntimeProfile과 동일하게 instanceOverride로
 *  폴백한다 — 라운드 1은 오버라이드를 아예 참조하지 않아 per-agent 프로필이
 *  없는 chat agent가 인스턴스 `--runtime-profile` 플래그까지 무시하고
 *  CLI 기본값(Anthropic 클라우드)으로 떨어지는 회귀가 있었다. 우선순위는
 *  동일: 이 responder의 map 항목 > 인스턴스 오버라이드 > null.
 *  responderAgentId가 빈 값(매니저 자신의 ambient identity, 해석된 managed
 *  agent 없음)인 경우는 이 라운드의 논의 대상이 아니었으므로 라운드 1의
 *  기존 계약(map을 보지 않고 즉시 null)을 그대로 보존한다. */
export function resolveRoomBroadcastRuntimeProfile(
  payload: any,
  responderAgentId: string,
  instanceOverride: RuntimeProfileSpec | null | undefined,
): RuntimeProfileSpec | null {
  if (!responderAgentId) return null;
  const map = payload?.cli_runtime_profiles;
  const raw = map && typeof map === 'object' ? map[responderAgentId] : undefined;
  return parseRuntimeProfile(raw) ?? instanceOverride ?? null;
}

/** Valid claude `--effort` levels (current AWB vocabulary). A preset slice
 *  carrying anything else has its `effort` dropped (the rest of the slice
 *  survives) so a malformed level can never reach the CLI flag. */
const EFFORT_LEVELS = new Set<EffortLevel>(['low', 'medium', 'high', 'max']);

/** Retired effort levels that may still sit in stale board settings, mapped to
 *  their nearest live tier. The claude CLI dropped its old top tier `xhigh` in
 *  favour of `max` (ticket 3188fd1b); a stale `xhigh` preset is folded to `max`
 *  before validation so it survives as a valid level instead of being silently
 *  dropped. */
const LEGACY_EFFORT_ALIASES: Record<string, EffortLevel> = { xhigh: 'max' };

export const PI_TICKET_DISPATCH_BLOCK_REASON = 'pi_ticket_mcp_unsupported';
export const PI_TICKET_DISPATCH_BLOCK_COMMENT =
  '⚠️ **PI 티켓 디스패치 차단** — PI CLI는 현재 MCP를 지원하지 않아 AWB의 ' +
  '`get_ticket`, `add_comment`, `move_ticket` 도구를 호출할 수 없고, 티켓을 자율적으로 진행할 수 없습니다. ' +
  '조용히 정체되는 세션을 만들지 않도록 spawn 전에 디스패치를 중단하고 티켓을 대기 상태로 전환했습니다.\n\n' +
  'PI는 현재 **chat 전용**으로 사용하세요. 이 티켓을 진행하려면 Claude/Codex 등 AWB MCP 지원 agent에 ' +
  '배정한 뒤 User 탭에서 Resume 하세요.';

/**
 * Defensive parse of the `effort_preset` field on a flattened agent_trigger
 * event (ticket-level abstract effort preset). The server ships the resolved,
 * matched preset object (or omits it — older servers / boards with no preset).
 * Accepts an object or a JSON string, keeps only the known per-CLI slices with
 * the right runtime types, and degrades to null on anything else — a malformed
 * preset must never block the dispatch it rides on (mirror parseHarnessConfig).
 *
 * A preset with no usable `id` is dropped (the id is the stable slug every
 * downstream consumer keys on). Unknown effort levels are stripped rather than
 * rejecting the whole preset, so a board can still ship `model` / `ultracode`.
 */
export function parseEffortPreset(raw: unknown): ResolvedEffortPreset | null {
  let obj: any = raw;
  if (typeof obj === 'string') {
    if (!obj.trim()) return null;
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.id !== 'string' || !obj.id.trim()) return null;
  const out: ResolvedEffortPreset = { id: obj.id.trim() };
  if (typeof obj.label === 'string' && obj.label.trim()) out.label = obj.label;
  if (obj.claude && typeof obj.claude === 'object' && !Array.isArray(obj.claude)) {
    const c: { model?: string; effort?: EffortLevel; ultracode?: boolean } = {};
    if (typeof obj.claude.model === 'string' && obj.claude.model.trim()) c.model = obj.claude.model.trim();
    if (typeof obj.claude.effort === 'string') {
      const level = obj.claude.effort.trim().toLowerCase();
      const mapped = (LEGACY_EFFORT_ALIASES[level] ?? level) as EffortLevel;
      if (EFFORT_LEVELS.has(mapped)) c.effort = mapped;
    }
    if (typeof obj.claude.ultracode === 'boolean') c.ultracode = obj.claude.ultracode;
    if (Object.keys(c).length > 0) out.claude = c;
  }
  for (const key of ['codex', 'antigravity', 'pi'] as const) {
    const slice = obj[key];
    if (slice && typeof slice === 'object' && !Array.isArray(slice)) {
      if (typeof slice.model === 'string' && slice.model.trim()) {
        out[key] = { model: slice.model.trim() };
      }
    }
  }
  return out;
}

/**
 * Defensive parse of the `environment_config` field on a flattened agent_trigger
 * event (ticket 354d336b). The server ships the resolved environment setup —
 * repositories with concrete urls, env_vars, setup_commands — as a JSON object
 * (or omits it for older servers / unconfigured boards). Accepts an object or a
 * JSON string, keeps only the known keys with the right runtime types, and
 * degrades to null on anything else — a malformed environment_config must never
 * block the dispatch it rides on (mirror parseHarnessConfig). A repository
 * without a usable url is dropped (it can't be cloned).
 */
export function parseEnvironmentConfig(raw: unknown): ResolvedEnvironmentConfig | null {
  let obj: any = raw;
  if (typeof obj === 'string') {
    if (!obj.trim()) return null;
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const repositories: ResolvedEnvironmentConfig['repositories'] = [];
  if (Array.isArray(obj.repositories)) {
    for (const r of obj.repositories) {
      if (!r || typeof r !== 'object') continue;
      const url = typeof r.url === 'string' ? r.url.trim() : '';
      if (!url) continue;
      const target_dir = typeof r.target_dir === 'string' && r.target_dir.trim() ? r.target_dir.trim() : '';
      if (!target_dir) continue;
      repositories.push({
        resource_id: typeof r.resource_id === 'string' ? r.resource_id.trim() : '',
        url,
        target_dir,
        branch: typeof r.branch === 'string' ? r.branch.trim() : '',
        post_clone_commands: Array.isArray(r.post_clone_commands)
          ? r.post_clone_commands.filter((c: unknown) => typeof c === 'string' && (c as string).trim())
          : [],
      });
    }
  }

  const env_vars: Record<string, string> = {};
  if (obj.env_vars && typeof obj.env_vars === 'object' && !Array.isArray(obj.env_vars)) {
    for (const [k, v] of Object.entries(obj.env_vars)) {
      if (typeof k === 'string' && k.trim() && typeof v === 'string') env_vars[k] = v;
    }
  }

  const setup_commands = Array.isArray(obj.setup_commands)
    ? obj.setup_commands.filter((c: unknown) => typeof c === 'string' && (c as string).trim())
    : [];

  if (repositories.length === 0 && Object.keys(env_vars).length === 0 && setup_commands.length === 0) {
    return null;
  }

  const timeout = Number(obj.setup_timeout_seconds);
  return {
    repositories,
    env_vars,
    setup_commands,
    setup_timeout_seconds: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 600,
    version: Number.isFinite(Number(obj.version)) ? Math.floor(Number(obj.version)) : 0,
  };
}

/** Select the checkout used to bootstrap an empty managed-agent working_dir.
 * Ticket binding is authoritative; the board environment's first repository
 * is the fallback when the ticket deliberately inherits board settings. */
export function resolveBootstrapRepository(
  baseRepo: unknown,
  baseBranch: unknown,
  environment: ResolvedEnvironmentConfig | null,
): { resourceId: string; url: string; branch: string } | null {
  const repo = baseRepo && typeof baseRepo === 'object' ? baseRepo as any : null;
  const ticketUrl = typeof repo?.url === 'string' ? repo.url.trim() : '';
  if (ticketUrl) {
    const branch = (typeof baseBranch === 'string' ? baseBranch.trim() : '')
      || (typeof repo?.default_branch === 'string' ? repo.default_branch.trim() : '');
    return { resourceId: typeof repo?.id === 'string' ? repo.id : '', url: ticketUrl, branch };
  }
  const boardRepo = environment?.repositories[0];
  return boardRepo ? { resourceId: boardRepo.resource_id || '', url: boardRepo.url, branch: boardRepo.branch } : null;
}

/**
 * Parse the board worktree placement mode off the flattened agent_trigger
 * event (worktree 규약 ②). Returns the concrete enum only for a recognized
 * value; anything else (absent / typo / pre-② server) → undefined, which makes
 * WorktreeManager.resolveCwd fall back to its per_ticket default. Never throws.
 */
export function parseWorktreeMode(raw: unknown): WorktreeMode | undefined {
  return raw === 'per_ticket' || raw === 'shared' ? raw : undefined;
}

export function buildDispatchEnvVars(
  boardEnv: Record<string, string> | null | undefined,
  cwd: string | undefined,
  worktreeMode: WorktreeMode | undefined,
  ticketId: unknown,
): Record<string, string> {
  return {
    ...(boardEnv ?? {}),
    ...(cwd ? { AWB_WORK_FOLDER: cwd } : {}),
    AWB_WORKTREE_MODE: worktreeMode ?? 'per_ticket',
    AWB_TICKET_ID: String(ticketId || ''),
  };
}

/** Every ticket dispatch is fail-closed until an isolated checkout can be
 * produced. Old events never fall back to the storage container. */
export function validateWorktreeProvisioningInputs(args: {
  mode: WorktreeMode | undefined;
  hasAgentContext: boolean;
  hasManager: boolean;
  ticketId?: string;
  role?: string;
  repositoryResourceId?: string;
}): string | null {
  if (!args.hasAgentContext) return 'missing_agent_context';
  if (!args.hasManager) return 'missing_worktree_manager';
  if (!args.ticketId) return 'missing_ticket_id';
  if (!args.role) return 'missing_role';
  if (!args.repositoryResourceId) return 'missing_repository_resource';
  return null;
}

// Hard cap on consecutive agent-to-agent turns within a single chat room OR
// a single ticket's comment-mention chain. Server stamps `agent_chain_depth`
// on every chat_room_message AND comment_mention (ticket 07402c57 ported the
// chat-room mechanism to the ticket-comment `@[...]` mention path); when the
// depth reaches the cap we record into history but stop delegating — the
// chain resets once a human sends/comments next.
export const AGENT_CHAIN_DEPTH_CAP = 3;

// ticket d34075b5 — one-time comment posted when a shared warm-pool `pool_exhausted`
// dispatch is queued for the manager-owned backoff retry (the on-demand reclaim
// couldn't free a slot). Deliberately NOT the "유효한 Git 체크아웃" broken-checkout
// copy: pool exhaustion is a transient, self-healing condition, so this states that
// recovery is autonomous (no operator action needed unless it persists).
const POOL_EXHAUSTED_RETRY_COMMENT =
  `⚠️ **shared worktree 풀 고갈 (pool_exhausted)** — 공유 warm-pool 의 모든 슬롯이 활성 lease 라 에이전트를 실행하지 않고 디스패치를 보류했습니다.\n\n` +
  `on-demand lease 재조정을 즉시 시도했지만 회수 가능한 슬롯이 없었습니다 (reclaim grace(20분) 이내의 lease 이거나, 같은 working_dir 를 공유하는 다른 보드와의 일시적 경합).\n\n` +
  `매니저가 이 트리거를 **자동 재시도 큐**에 넣었습니다 — 백오프로 재시도하며, 활성 티켓이 끝나 슬롯을 반납하거나(또는 주기/부팅 재조정이 leaked lease 를 회수하는) 즉시 재프로비저닝합니다. **서버 재푸시가 필요 없습니다.**\n\n` +
  `재시도 한도까지 계속 고갈이면 운영자 확인을 위해 자동으로 pend 되며, max_concurrent_tickets_per_agent(풀 크기 N)와 이 working_dir 를 공유하는 보드 구성을 점검하세요.`;

// ─── ST-6 per-call agent execution context ──────────────────────────────
// Manager-side multi-tenancy. When an event targets a managed agent the
// dispatcher resolves that agent's runtime context (cwd, on-disk
// mcp-config path, raw apiKey) and threads it through to every spawn site
// so child claude/codex/antigravity processes:
//   - run ticket work in a prepared WT checkout; non-ticket chat uses the
//     configured storage directory without treating it as a repository
//   - authenticate to AWB MCP under the agent's own apiKey (not the
//     manager's), so tool-call attribution lands on the agent
//   - reuse the manager's pre-written mcp-config.json instead of a fresh
//     per-spawn tempfile (skipped automatically when configPath given)
//
// Always optional. When undefined, every manager falls back to its own
// config.apiKey and the inherited process cwd — matching pre-ST-6
// behavior so single-agent setups keep working unchanged.
export interface AgentExecutionContext {
  agent_id: string;
  workspace_id: string;
  api_key: string;
  cwd: string;
  /** Pre-written `claude --mcp-config` file. Manager writes once per agent. */
  mcp_config_path: string;
  /** ST-6 follow-up: which CLI to fork (claude / codex / antigravity / custom).
   *  Per-agent rather than manager-wide so one manager host can drive a
   *  mix of agents. SubagentManager / BaseSessionManager memoize the
   *  adapter per cliType so the cost is one createAdapter() per cli over
   *  the manager's lifetime. */
  cli: string;
  /** ST-7 follow-up: per-agent CLI home dir. Spawn injects this into the
   *  child env via the adapter's configDirEnv() (CLAUDE_CONFIG_DIR /
   *  GEMINI_HOME / CODEX_HOME) so per-agent sessions / plugins /
   *  settings stay isolated under <MANAGER_HOME>/agents/<id>/cli-home/. */
  cli_home_dir: string;
  /** Per-agent credential extras (e.g. ANTHROPIC_API_KEY for api_key-mode
   *  credentials). Empty / undefined for subscription-mode and unset
   *  agents — those carry auth via files inside cli_home_dir instead. */
  extra_env?: Record<string, string>;
  /** Provider string of the per-agent credential applied at spawn time
   *  (`claude_subscription`, `claude_api_key`, `codex_subscription`, …).
   *  null / undefined when no per-agent credential was set — spawn sites
   *  read this to decide whether to strip operator-inherited auth env vars
   *  (ANTHROPIC_API_KEY etc.) before merging the agent's credential. */
  credential_provider?: string | null;
  credential_id?: string | null;
  /** Per-agent default model (Agent.model). Passed into the adapter build
   *  spec so the spawned subagent / session runs under `--model <id>`.
   *  null/undefined = the CLI's own default (no flag). */
  model?: string | null;
  /** Required explicit runtime strategy and permission policy. */
  runtime_config?: AgentRuntimeConfig | null;
}

// ─── Session manager interfaces ──────────────────────────────────────────
// These thin contracts mirror the duck-typed surface the dispatcher uses.
// Concrete implementations land in ST-2 phase C.

export interface SubagentSpawnArgs {
  kind: 'trigger' | 'chat';
  taskText: string;
  rolePrompt: string;
  triggerId?: string;
  chatRequestId?: string;
  ticketId: string;
  agentId: string;
  /** Workspace role slug the spawn is acting as. When set together with
   *  ticketId, SubagentManager pins it onto the per-spawn mcp-config via
   *  X-AWB-Subagent-Role / X-AWB-Subagent-Ticket-Id headers so server-side
   *  resolveAuthorRole attributes the comment to the single triggered role
   *  instead of the agent's full multi-role set. Empty for chat / non-role
   *  spawns. */
  role?: string;
  /** Server trigger_source that caused this spawn. Sensitive tools can use
   *  the per-session header to distinguish post-Done retrospective reviewer
   *  runs from other reviewer wake-ups on the same ticket. */
  triggerSource?: string;
  /** Internal: server-arbitrated retry attempt for a standalone mention. */
  _silentExitAttempt?: 0 | 1;
  /** Chat room id for one-shot chat spawns. When set, non-MCP adapters
   *  (codex, antigravity) post their collected result to this room via REST
   *  instead of as a ticket comment. */
  roomId?: string;
  /** ST-6: per-event managed-agent runtime context. Optional. */
  agentContext?: AgentExecutionContext;
  /** Resolved board/workspace harness from the trigger event (e9c7a896).
   *  Null/absent → spawn exactly as before. */
  harness?: HarnessSpec | null;
  runtimeProfile?: RuntimeProfileSpec | null;
  /** Ticket-level abstract effort preset, resolved server-side and shipped on
   *  the trigger event (`effort_preset`). SEPARATE channel from `harness`; the
   *  spawn site picks the per-CLI slice via selectEffortSlice. Null/absent →
   *  no effort override. */
  effortPreset?: ResolvedEffortPreset | null;
  /** Per-spawn lifetime override for unusually long initialization work. */
  ttlMinutes?: number;
  /** Non-secret env vars from the board environment_config (ticket 354d336b),
   *  injected into the spawned CLI's environment. Applied on every spawn (not
   *  persisted on disk like the cloned repos). Absent → none. */
  envVars?: Record<string, string>;
  /** 내부용 (ticket 61f4dd18): fallback 모델 체인. 최초 spawn 은 비워두고
   *  spawn() 이 harness.model + harness.fallback_models 로 계산한다. 폴백
   *  respawn 에서만 exit 핸들러가 채워 넘긴다 — 재계산을 피하고 시도 인덱스를
   *  이어가기 위함. head=주 모델(null=CLI 기본), 이후=우선순위 순 폴백. */
  _modelChain?: (string | null)[];
  /** 내부용 (ticket 61f4dd18): 이번 spawn 이 사용하는 _modelChain 인덱스.
   *  0=주 모델. 폴백 respawn 마다 1씩 증가. */
  _chainAttempt?: number;
  /** ticket e9d0e8bc: fired ONCE when this spawn's subagent process exits (any
   *  reason — normal, crash, kill). Used to release a run-lifetime folder lock
   *  the dispatcher acquired before provisioning. Invoked even when a kill/reaper
   *  path force-dropped the record, so it must be idempotent on the caller side. */
  onExit?: () => void;
  /** ticket 55d3063f: QA/security run identity, threaded so the one-shot exit
   *  handler can sweep the turn end for orphaned background tasks and finalize a
   *  stranded run as `error` — the one-shot twin of the `run` binding the
   *  persistent chat path carries on ChatDispatchArgs (89716f04). Undefined for
   *  an ordinary chat / non-run spawn. */
  run?: RunSessionBinding;
  /** ticket 970d6692 (review round 2): precomputed circuit-breaker verdict for
   *  THIS logical spawn attempt. Set (including explicit `null`) only by
   *  event-dispatcher.ts's dispatchTrigger→one-shot fallback, where
   *  dispatchTrigger already called CircuitBreaker.shouldBlock() for the same
   *  (agent, ticket, role) key moments earlier and did NOT decline with
   *  `circuit_breaker_open` — meaning the breaker already cleared this
   *  attempt. SubagentManager.spawn() trusts this instead of re-querying,
   *  because a second shouldBlock() call for the SAME attempt would consume
   *  the just-granted half-open probe's `lastProbeAt` stamp and re-block it
   *  (the original bug). `undefined` (the default for every other spawn()
   *  call site — chat one-shots, mention triggers) preserves the original
   *  self-contained check. */
  circuitBreakerDecision?: string | null;
}

export interface SubagentSpawnResult {
  spawned: boolean;
  pid?: number;
  reason?: string;
  /** Secret-free detail for a classified failure reason (e.g. the exact
   *  `mcp_servers.<name>` config key an `invalid_mcp_transport` reason names) —
   *  ticket da4358ee. Absent for reasons that carry no extra detail. */
  detail?: string;
  /** Bare `mcp_servers.<name>` key for an `invalid_mcp_transport` reason
   *  (ticket da4358ee review round 2) — the operator notification must name
   *  THIS key, not assume it's always `awb`. Absent for every other reason. */
  serverKey?: string;
}

export interface SubagentManager {
  canSpawn(): boolean;
  spawn(args: SubagentSpawnArgs): Promise<SubagentSpawnResult>;
}

export interface ChatDispatchArgs {
  roomId: string;
  /** Agent identity that should respond to this message. For self-handling
   *  this is the manager's own agent id; for managed-agent fan-out it is
   *  the matched managed agent's id. Used as part of the chat session key
   *  so multiple agents in the same room get separate persistent CLI
   *  sessions instead of clobbering each other. */
  agentId: string;
  senderId: string;
  senderName: string;
  /** Persisted chat_room_messages.id. Preferred over event timestamps for
   * cross-event idempotency between chat_request and chat_room_message. */
  messageId?: string;
  createdAt: string;
  content: string;
  rolePrompt: string;
  /** Current room title (server SSE `room_name`). Empty string for an
   *  untitled room — the first-turn prompt then asks the subagent to generate
   *  a title and persist it via the set_chat_room_name MCP tool. */
  roomName?: string;
  /** ticket e6d32e9d: server SSE `is_action_room`. True when this room was
   *  minted by an Action dispatch (ChatRoom.action_id set). The first-turn
   *  prompt then tells the subagent to perform the task DIRECTLY instead of
   *  filing an AWB ticket, and skips the auto-title instruction. */
  isActionRoom?: boolean;
  /** ticket 9fd27487: 이번 디스패치가 실제로 프로비저닝된 절대경로 cwd
   *  (`.awb/act/<action8>` 또는 `.awb/chat/<room8>`) — opt-in하지 않은 채팅
   *  workspace라면 그냥 에이전트의 통상적인 working_dir 루트일 뿐인 `agentContext.cwd`와는
   *  다르다. 프로비저닝이 실행되어 성공했을 때만 값이 설정되므로, 기본값(여기서는
   *  undefined)일 때는 첫 턴 프롬프트의 폴더 경계 블록이 working_dir 루트 자체를
   *  "네게 배정된 작업폴더"라고 잘못 주장하지 않고 그대로 부재 상태를 유지한다. */
  provisionedWorkFolder?: string;
  onProgress?: (stage: string) => void;
  /** ST-6: per-event managed-agent runtime context. When set, the chat
   *  session spawns under this agent's identity (apiKey + cwd + cli) so the
   *  reply is attributed to the right agent and lands in the room they're
   *  a member of. Undefined when the manager itself is the participant. */
  agentContext?: AgentExecutionContext;
  /** ticket 7d8ea7c9: resolved agent > workspace Claude backend profile for
   *  this chat turn — the chat-path twin of TicketTriggerArgs.runtimeProfile.
   *  Undefined/null when the responder isn't a Claude agent or no profile
   *  resolves; BaseSessionManager then spawns exactly as before (Anthropic
   *  default endpoint, agentContext.model / harness / CLI default). */
  runtimeProfile?: RuntimeProfileSpec | null;
  /** Per-message attachments as projected by the server in the SSE / history
   *  payload. ChatSessionManager fetches the bytes it needs (vision content
   *  blocks for Claude, inline text for text-ish mime) before assembling the
   *  turn. Undefined / empty when the message has no attachments. */
  attachments?: any[];
  /** ticket 89716f04 — set when this chat dispatch carries a QA/security
   *  run_provision hint. ChatSessionManager stamps it on the session so the
   *  one-shot run's turn end is swept for orphaned background tasks. Undefined
   *  for an ordinary chat turn. */
  run?: RunSessionBinding;
  /** ticket e9d0e8bc: fired ONCE when the dispatched session's subagent process
   *  exits (any reason). Used to release a run-lifetime folder lock. Only wired
   *  when this dispatch actually spawns / owns a session (result.dispatched);
   *  a declined dispatch never calls it, so the dispatcher releases on that path
   *  itself. Idempotent on the caller side (kill paths may double-fire). */
  onExit?: () => void;
}

export interface ChatDispatchResult {
  dispatched: boolean;
  pid?: number;
  firstTurn?: boolean;
  reason?: string;
}

export interface ChatSessionManager {
  dispatch(args: ChatDispatchArgs): Promise<ChatDispatchResult>;
  recordRoomMessage(payload: any): void;
}

export interface ColumnPrompt {
  name?: string;
  content?: string;
}

export interface TicketTriggerArgs {
  ticketId: string;
  role: string;
  triggerId: string;
  agentId: string;
  rolePrompt: string;
  ticketPrompt: string;
  columnPrompt: ColumnPrompt | null;
  ticket: any;
  forceRespawn: boolean;
  triggerSource?: string;
  /** ST-6: per-event managed-agent runtime context. Optional. */
  agentContext?: AgentExecutionContext;
  /** Per-board cap for distinct active tickets per agent. Server's
   *  TriggerLoopService already enforces this; the manager keeps a
   *  defensive drop in case two triggers raced past the server gate
   *  before the first set_current_task arrived. Defaults to 1 when the
   *  server didn't include it (older server). */
  maxConcurrentTicketsPerAgent?: number;
  /** Resolved board/workspace harness from the trigger event (e9c7a896).
   *  Applied at SESSION CREATION only — a live session's CLI flags are
   *  fixed at spawn; follow-up turns into an existing pid keep the
   *  harness the session was born with. Null/absent → spawn as before. */
  harness?: HarnessSpec | null;
  runtimeProfile?: RuntimeProfileSpec | null;
  /** Ticket-level abstract effort preset (`effort_preset`). Like harness it is
   *  applied at SESSION CREATION only — a live session's `--effort` flag is
   *  fixed at spawn. Null/absent → no effort override. */
  effortPreset?: ResolvedEffortPreset | null;
  /** Non-secret env vars from the board environment_config (ticket 354d336b),
   *  injected into the spawned CLI's environment at SESSION CREATION. A live
   *  session keeps the env it was born with. Absent → none. */
  envVars?: Record<string, string>;
  /** Manager-owned worktree policy appended to every initial and follow-up
   * ticket turn. Unlike repository files, this is present even for a newly
   * created empty checkout. */
  worktreeInstructions?: string;
  /** ticket 3d180f85: handleTrigger already reserved this (ticket, role, agent)
   *  key in the authoritative `_inflight` map for the whole provision→spawn
   *  window (via tryReserveDispatch). When true, dispatchTrigger must NOT
   *  re-drop on its own `_inflight.has` self-check, nor set/delete `_inflight`
   *  itself — the dispatcher owns that reservation's lifecycle. Absent/false →
   *  legacy behavior (dispatchTrigger manages its own spawn-window reservation). */
  dispatchReserved?: boolean;
}

/** Outcome of `TicketSessionManager.tryReserveDispatch` (ticket 3d180f85). */
export interface DispatchReservation {
  /** false → a fresh spawn for this exact key is already in flight (provisioning
   *  or spawning); the caller suppresses the twin. true → proceed. */
  acquired: boolean;
  /** true → a live session already exists for the key (no reservation placed;
   *  the dispatch will reuse it as a follow-up turn). false → the provisioning→
   *  spawn reservation was just placed and the caller MUST release it. */
  live: boolean;
  /** 좀비 예약을 강제 회수하고 이 dispatch 가 새 예약을 잡았다는 신호
   *  (ticket 7c3ba9cf). 'stale' = TTL(`INFLIGHT_RESERVATION_STALE_MS`) 초과
   *  예약을 evict, 'safety_valve' = TTL 미도달이나 연속 억제가 임계에 도달해
   *  강제 해제, 'dead_pid' = pid 부착된 예약의 소유 프로세스가 OS 레벨에서
   *  이미 종료됨을 확인해 즉시 회수(ticket e90294e7 round 3). dispatcher 는
   *  이때 티켓에 경고를 남긴다. 정상 취득이면 undefined. */
  evicted?: 'stale' | 'safety_valve' | 'dead_pid';
  /** generation nonce (ticket 26a92722). 예약이 실제로 배치된 경우(acquired &&
   *  !live)에만 채워진다. dispatcher 는 이 값을 finally 의 releaseDispatch 에
   *  그대로 넘겨, 이 예약이 이후 evict 되고 슬롯이 재예약된 뒤 지연 도착한
   *  release 가 새 예약을 지우지 못하도록 CAS 를 성립시킨다. */
  nonce?: string;
}

export interface TicketDispatchResult {
  dispatched: boolean;
  pid?: number;
  firstTurn?: boolean;
  reason?: string;
}

export interface TicketSessionManager {
  dispatchTrigger(args: TicketTriggerArgs): Promise<TicketDispatchResult>;
  /** ticket 3d180f85 — authoritative provision-spanning single-flight. Reserve
   *  the (ticket, role, agent) key in the SAME `_inflight` registry the spawn
   *  consults, BEFORE provisioning, so a concurrent supervisor re-send during a
   *  provisioning stall is suppressed instead of twin-spawning. Optional so a
   *  minimal/legacy TicketSessionManager (or a test fake) that omits it makes
   *  the dispatcher fall back to a process-local slot. */
  tryReserveDispatch?(ticketId: string, role: string, agentId: string): DispatchReservation;
  /** Release a reservation placed by tryReserveDispatch (live===false). Idempotent.
   *  `nonce` (ticket 26a92722): tryReserveDispatch 가 반환한 값을 그대로 넘기면
   *  현재 예약의 nonce 와 일치할 때만 삭제하는 CAS 가 적용된다 — evict 된 좀비
   *  홀더의 지연 release 가 새 예약을 지우는 no-op 이 되도록. */
  releaseDispatch?(ticketId: string, role: string, agentId: string, nonce?: string): void;
  /** ticket e90294e7 round 3 — promote a provisioning reservation to a
   *  pid-verified one once a caller's spawn() resolves with a real OS pid, so
   *  tryReserveDispatch's zombie recovery trusts an OS-level liveness probe
   *  instead of the provisioning-window TTL/safety-valve for the remainder of
   *  that process's lifetime. Nonce-CAS guarded like releaseDispatch. Optional
   *  so a minimal/legacy contract (or test fake) that omits it just keeps
   *  today's TTL-only behavior. */
  attachDispatchPid?(ticketId: string, role: string, agentId: string, nonce: string | undefined, pid: number): void;
  /** targetAgentId — comment_mention 이벤트의 수신 agent(per-agent 스코프).
   *  식별되면 그 agent 의 세션에만 주입하고, 라이브 세션이 없으면 false 를
   *  반환해 one-shot 스폰 경로를 살린다(멘션 swallow/오배달 방지, T7 리뷰 #3). */
  forwardCommentMention(ticketId: string, mention: any, targetAgentId?: string): boolean;
  forwardBoardUpdate(ticketId: string, ev: any): boolean;
  /** Read-only peek — true when (ticketId, role, agentId) already owns a LIVE
   *  session OR an in-flight provisioning reservation (ticket e90294e7).
   *  `forwardCommentMention` only sees sessions that finished spawning, so it
   *  misses a column-move trigger for the SAME (ticket, role, agent) seat that
   *  is still provisioning (worktree checkout / rebase). `handleCommentMention`
   *  consults this right before its one-shot spawn fallback so a role-shortcut
   *  mention doesn't race a second, independent session into that seat. Does
   *  NOT reserve anything — the caller only needs to know whether to skip its
   *  own spawn. Optional so a minimal/legacy contract (or test fake) that omits
   *  it just keeps today's behavior (never suppresses on this check).*/
  hasInflightOrLiveDispatch?(ticketId: string, role: string, agentId: string): boolean;
}

/** Which registry backs a claimed dispatch seat — the REAL
 *  TicketSessionManager `_inflight` map (persistent ticket sessions on) or the
 *  process-local InflightDispatchTracker fallback slot (sessions off).
 *  Mirrors the branch handleTrigger's own `canAuthoritative` already makes. */
export type DispatchSeatKind = 'authoritative' | 'fallback';

/** A claimed (ticket, role, agent) dispatch seat (ticket 77b28217 — common
 *  factory for handleTrigger's `triggerSeat` and handleCommentMention's
 *  `mentionSeat`, which independently hand-rolled this same contract and let
 *  the same twin-dispatch bug recur across four tickets: 13160d20 → fdf6714e
 *  → f0d1da19 → 6de97a41. Ticket 8c15e7f7's `SEAT_CELLS` parity table
 *  (dispatch-inflight-guard.test.mjs Part I) is the safety net this factory is
 *  built to keep green). Held for the spawned one-shot's FULL lifetime via
 *  `SubagentSpawnArgs.onExit`, not just until `spawn()` resolves a pid. */
export interface DispatchSeat {
  /** Set by the caller once ownership hands off to the spawned process's
   *  `onExit` hook, so the caller's own provisioning-window `finally` no
   *  longer releases out from under the still-running one-shot. */
  transferred: boolean;
  /** Release the underlying reservation. Idempotent; CAS-guarded by `nonce`
   *  on the backing registry (a stale-generation release is a no-op). */
  release: () => void;
  /** Promote the provisioning-window reservation to a pid-verified one, so
   *  the backing registry's zombie recovery trusts OS-level liveness over its
   *  TTL/safety-valve for the rest of the one-shot's lifetime. */
  promote: (pid: number) => void;
}

export interface CreateDispatchSeatArgs {
  kind: DispatchSeatKind;
  ticketId: string;
  role: string;
  agentId: string;
  nonce?: string;
  /** Consulted only when kind==='authoritative'. */
  tsm?: TicketSessionManager | null;
  /** Consulted only when kind==='fallback'. */
  inflightDispatch: InflightDispatchTracker;
  /** The InflightDispatchTracker.key(...) this seat was reserved under.
   *  Required when kind==='fallback'. */
  inflightKey?: string | null;
  /** Extra step run AFTER the core release — e.g. the shared
   *  #replayPendingForce force-respawn replay (ticket f0d1da19, shared with
   *  handleCommentMention's mentionSeat since ticket 3b8f24ec). */
  onReleased?: () => void;
}

/** Build a `{transferred, release, promote}` seat handle over whichever
 *  registry backs this dispatch. Pure registry dispatch: callers still decide
 *  WHEN to construct one (only on a freshly-placed reservation, never a live-
 *  session reuse) and wire `release`/`promote` into
 *  `SubagentSpawnArgs.onExit` / the spawn-success branch themselves — this
 *  factory only unifies the authoritative-vs-fallback branching both call
 *  sites previously duplicated. */
export function createDispatchSeat(args: CreateDispatchSeatArgs): DispatchSeat {
  return {
    transferred: false,
    release: () => {
      if (args.kind === 'authoritative') {
        args.tsm?.releaseDispatch?.(args.ticketId, args.role, args.agentId, args.nonce);
      } else {
        args.inflightDispatch.releaseFallback(args.inflightKey!, args.nonce);
      }
      args.onReleased?.();
    },
    promote: (pid: number) => {
      if (args.kind === 'authoritative') {
        args.tsm?.attachDispatchPid?.(args.ticketId, args.role, args.agentId, args.nonce, pid);
      } else {
        args.inflightDispatch.attachDispatchPid(args.inflightKey!, args.nonce, pid);
      }
    },
  };
}

export interface FsBrowserResult {
  ok: boolean;
  error?: string;
  code?: string;
  [key: string]: any;
}

export interface FsBrowser {
  handle(args: {
    op: string;
    path: string;
    offset?: number;
    limit?: number;
    name?: string;
  }): Promise<FsBrowserResult>;
}

export interface PromptComposer {
  composeTriggerPrompt(
    ticket: any,
    rolePrompt: string,
    ticketPrompt: string,
    ticketId: string,
    columnPrompt: ColumnPrompt | null,
    extraInstructions?: string | null,
  ): string;
  composeChatPrompt(
    rolePrompt: string,
    history: any[],
    newMessage: string,
    roomId?: string,
    usesNativeMcp?: ChatReplyMode,
    workFolder?: string,
  ): string;
  composeChatRoomPrompt(
    roomId: string,
    history: any[],
    msg: { content: string; sender_name: string; sender_id: string },
    attachments?: any[],
    usesNativeMcp?: ChatReplyMode,
    historyAttachments?: Map<any, any[]>,
    roomName?: string,
    isActionRoom?: boolean,
    workFolder?: string,
  ): string;
  composeCommentMentionPrompt(
    ticket: any,
    rolePrompt: string,
    mention: any,
    ticketId: string,
  ): string;
}

export interface AgentManagerCommandSink {
  handle(raw: string): Promise<void>;
}

export interface EventDispatcherDeps {
  subagentManager?: SubagentManager | null;
  chatSessionManager?: ChatSessionManager | null;
  ticketSessionManager?: TicketSessionManager | null;
  /** Process-lifetime CLI override. undefined inherits the event snapshot;
   * null explicitly disables runtimes. Never persists to the server. */
  runtimeProfileOverride?: RuntimeProfileSpec | null;
  fsBrowser?: FsBrowser | null;
  prompts?: PromptComposer | null;
  // ST-5b — handler for agent_manager_command SSE events. Optional so the
  // dispatcher stays usable in pre-ST-5b harnesses (and tests that don't
  // care about manager control commands).
  agentManagerCommandHandler?: AgentManagerCommandSink | null;
  // ST-6 — managed-agent runtime context registry. When set, events
  // targeted at managed agents owned by this manager dispatch with the
  // managed agent's apiKey + cwd + mcp-config (instead of the manager's
  // defaults).
  managedAgentContexts?: ManagedAgentContextRegistry | null;
  // Required ticket checkout manager. Missing provisioning is fail-closed.
  worktreeManager?: WorktreeManager | null;
  // ticket 3d180f85 — shared provision-spanning single-flight coordinator.
  // Injected as a singleton (like circuitBreaker) so main.ts can read its
  // suppression-reason metric for the instance heartbeat. Omitted → the
  // dispatcher makes its own (fine for tests that don't inspect the metric).
  inflightDispatchTracker?: InflightDispatchTracker | null;
  // ticket d34075b5 — cumulative per-reason dispatch-BLOCK counter. Injected as a
  // singleton so main.ts can surface it on the instance heartbeat
  // (`dispatch_block_counts`), mirroring inflightDispatchTracker. Omitted → the
  // dispatcher makes its own (fine for tests that don't inspect the metric).
  dispatchBlockTracker?: DispatchBlockTracker | null;
  // ticket d34075b5 — on-demand warm-pool lease reclaim. Invoked the instant a
  // shared-mode dispatch hits `pool_exhausted` so a leaked lease is reclaimed
  // immediately (accelerated reconciliation) instead of waiting up to the periodic
  // reconcile tick + a lucky server re-push. Returns the number of leases
  // reclaimed. Wired in main.ts to reconcilePoolLeasesAll; omitted in tests /
  // per_ticket-only setups → the fast-path degrades to the legacy abort.
  poolReclaimTrigger?: (() => Promise<number>) | null;
  // ticket d34075b5 review follow-up — injectable timer surface for the
  // manager-owned pool_exhausted retry queue, so the integration harness drives the
  // backoff deterministically. Omitted → real unref'd setTimeout/clearTimeout.
  poolRetryScheduler?: RetryScheduler | null;
  // ticket d34075b5 review follow-up — attempt bound for the pool_exhausted retry
  // queue before it gives up and pends for the operator. Omitted → production
  // default (8, ≈22.5 min of backoff spanning the 20-min reclaim grace). Tests
  // shrink it for a fast give-up assertion.
  poolRetryMaxAttempts?: number | null;
  // ticket 467f714a — durable harness session-limit defer store. Injected as a
  // singleton so main.ts constructs it with the persistence path (and boot
  // rehydrate) and wires the exit-side recorder into it. Omitted → the dispatcher
  // makes an in-memory-only one (fine for tests that inject their own or don't
  // exercise the defer path).
  sessionLimitDeferStore?: SessionLimitDeferStore | null;
  /** ACP runtime owner. Hermes events never fall back to CLI managers. */
  runtimeSupervisor?: RuntimeSupervisor | null;
}

export class EventDispatcher {
  #config: AwbConfig;
  #subagentManager: SubagentManager | null;
  #chatSessionManager: ChatSessionManager | null;
  #ticketSessionManager: TicketSessionManager | null;
  #fsBrowser: FsBrowser | null;
  #prompts: PromptComposer | null;
  #agentManagerCommandHandler: AgentManagerCommandSink | null;
  #managedAgentContexts: ManagedAgentContextRegistry | null;
  #worktreeManager: WorktreeManager | null;
  #runtimeProfileOverride: RuntimeProfileSpec | null | undefined;
  #runtimeSupervisor: RuntimeSupervisor | null;
  // ticket a3047a86: per-ticket de-dup for dispatch-preflight blocker comments
  // (broken worktree / missing push credential). The abort already suppresses
  // the spawn; this keeps the SAME blocker from re-posting a ticket comment on
  // every re-trigger, while a different blocker or a post-recovery failure still
  // posts once. Singleton dispatcher → one tracker covers all this manager's
  // tickets; cleared on a fully-green preflight.
  readonly #dispatchBlockers = new DispatchBlockerTracker();
  // ticket feaa7ab0: per-(ticket,role) suppressor for the supervisor
  // re-dispatch storm. Once a ticket-role aborts preflight for a durable
  // blocker (broken/foreign worktree, missing push credential), supervisor-
  // sourced re-triggers for the SAME ticket-role are DROPPED before
  // re-provisioning (within a cooldown), while human/state-changed triggers
  // always pass and a green preflight re-arms it. This is what actually stops
  // the repeated spawn/provision churn; the abort alone only skips the spawn.
  readonly #spawnSuppressor = new RoleSpawnSuppressor();
  // ticket 3d180f85: provision-spanning single-flight coordinator. handleTrigger
  // reserves the (ticket, role, agent) key in the AUTHORITATIVE
  // TicketSessionManager._inflight registry (via tryReserveDispatch) BEFORE
  // worktree provisioning and releases it after the spawn outcome, so a
  // concurrent supervisor re-send during a provisioning stall is suppressed
  // instead of twin-spawning past the spawn-window guards. This tracker owns the
  // process-local fallback slot (persistent sessions off), the suppression-reason
  // metric surfaced on the instance heartbeat, and the suppressed-force-respawn
  // intent replayed once on release.
  readonly #inflightDispatch: InflightDispatchTracker;
  /** Per-reason dispatch-suppression counts for the instance-heartbeat metric
   *  (ticket 3d180f85, mirrors circuitBreaker → open_breaker_count). Empty when
   *  nothing has been suppressed. */
  dispatchSuppressionCounts(): Record<string, number> {
    return this.#inflightDispatch.suppressionCounts();
  }
  // ticket d34075b5: cumulative per-reason dispatch-BLOCK counter (worktree /
  // push-credential preflight aborts, incl. shared-pool `pool_exhausted`). A
  // singleton injected from main.ts so its counts ride the instance heartbeat as
  // `dispatch_block_counts` — the durable, server-visible signal that a dispatch
  // was dropped. Own instance for tests that don't inject one.
  readonly #dispatchBlockTracker: DispatchBlockTracker;
  // ticket d34075b5: on-demand warm-pool lease reclaim, invoked when a shared-mode
  // dispatch hits `pool_exhausted` (accelerated reconciliation). null when unwired.
  readonly #poolReclaimTrigger: (() => Promise<number>) | null;
  /** Per-reason dispatch-BLOCK counts for the instance-heartbeat metric (ticket
   *  d34075b5, mirrors dispatchSuppressionCounts). Empty when nothing has been
   *  blocked. */
  dispatchBlockCounts(): Record<string, number> {
    return this.#dispatchBlockTracker.counts();
  }
  // ticket d34075b5 review follow-up: manager-owned bounded-backoff retry queue for
  // shared warm-pool `pool_exhausted` dispatches. A dispatch that can't provision a
  // pool slot (and whose on-demand reclaim freed nothing) is queued here and
  // re-driven autonomously — no lucky server re-push required. Constructed in the
  // ctor so its callbacks can close over `this` (handleTrigger / config).
  readonly #poolRetry: PendingDispatchRetry;
  /** A slot is known to have freed — re-drive every queued pool_exhausted retry now
   *  (ticket d34075b5). Called by the terminal/archive cleanup and by main.ts's
   *  periodic/boot reconcile (via EventStream) when a lease is reclaimed. */
  wakePoolRetries(reason: string): void {
    this.#poolRetry.wake(reason);
  }
  /** Queued pool_exhausted retry count — test / observability. */
  pendingPoolRetryCount(): number {
    return this.#poolRetry.size();
  }
  // ticket 467f714a: durable harness session-limit defer store. A session-limit
  // exit (`You've hit your session limit · resets …`) opens a per-agent defer
  // WINDOW here; handleTrigger then coalesces every re-dispatch in the window into
  // a single pending intent (no spawn, no twin) and replays each exactly once at
  // the reset instant. Owned so its resume callback can close over handleTrigger;
  // main.ts injects the persisted instance so the window survives a restart.
  readonly #sessionDefer: SessionLimitDeferStore;
  /** ticket 467f714a blocker #1 — the freshest trigger `raw` this manager
   *  dispatched per (ticket, role, agent) key, captured in handleTrigger. When a
   *  session dies of a harness session limit, `recordHarnessSessionLimit` looks
   *  up the dead task's key here and SEEDS a durable pending intent from that raw,
   *  so the original work replays at reset even if NO further supervisor/mention
   *  trigger arrives in the window. Bounded: consumed on seed, evicted when the
   *  ticket leaves the flow (moved/archived), and hard-capped (FIFO) as a backstop.
   *  In-memory only — the seed lands as a DURABLE intent in #sessionDefer, so this
   *  need only survive dispatch→exit within one lifetime. */
  readonly #inflightTriggerRaw = new Map<string, string>();
  static readonly #INFLIGHT_RAW_CAP = 512;
  /** Remember the raw of a trigger we are about to dispatch (blocker #1). FIFO-
   *  capped so a long-lived manager can't grow it unbounded from keys that never
   *  hit a session limit. */
  #rememberTriggerRaw(key: string, raw: string): void {
    this.#inflightTriggerRaw.delete(key); // re-insert to move to newest (FIFO)
    this.#inflightTriggerRaw.set(key, raw);
    while (this.#inflightTriggerRaw.size > EventDispatcher.#INFLIGHT_RAW_CAP) {
      const oldest = this.#inflightTriggerRaw.keys().next().value;
      if (oldest === undefined) break;
      this.#inflightTriggerRaw.delete(oldest);
    }
  }
  /** Evict every remembered trigger raw for a ticket (blocker #1) — the ticket
   *  left the active flow (moved/archived), so a late session-limit death must
   *  not seed a stale re-drive. Keys are `${ticketId}:${role}:${agentId}`. */
  #forgetTriggerRawForTicket(ticketId: string): void {
    if (!ticketId) return;
    const prefix = `${ticketId}:`;
    for (const key of [...this.#inflightTriggerRaw.keys()]) {
      if (key.startsWith(prefix)) this.#inflightTriggerRaw.delete(key);
    }
  }
  /** Record a recognized harness session-limit exit — open/extend the agent's
   *  defer window AND seed the dead task itself as a durable pending intent
   *  (ticket 467f714a blocker #1), so it replays exactly once at reset even with
   *  no later trigger. Called by the ticket-session / one-shot exit handlers
   *  (wired through EventStream). `deferUntilMs` is already resolved (parsed reset,
   *  or a conservative default) by the caller. `ticketId`/`role` identify the dead
   *  task (present for ticket triggers; a one-shot mention death omits a usable
   *  role). Returns whether a fresh window opened. */
  recordHarnessSessionLimit(info: {
    agentId: string;
    ticketId?: string;
    role?: string;
    deferUntilMs: number;
    reason?: string;
    resetLabel?: string;
  }): { opened: boolean } {
    const res = this.#sessionDefer.recordSessionLimit(info.agentId, {
      deferUntilMs: info.deferUntilMs,
      reason: info.reason,
      resetLabel: info.resetLabel,
    });
    if (res.opened) {
      log(
        `[dispatch] harness session-limit defer opened agent=${info.agentId.slice(0, 8)} ` +
          `until=${new Date(info.deferUntilMs).toISOString()} label="${info.resetLabel ?? ''}" ` +
          `— supervisor/mention re-dispatch deferred until reset`,
      );
    }
    // blocker #1: seed the failed original task as a durable intent from the raw
    // we captured when we dispatched it, so a reset with NO intervening trigger
    // still replays it exactly once. Consume the raw (the durable intent now owns
    // the re-drive). Skipped when there is no usable ticket key or captured raw
    // (e.g. a one-shot mention death) — the mention/trigger coalesce paths and the
    // server supervisor's own re-push cover those.
    if (info.ticketId) {
      const key = InflightDispatchTracker.key(info.ticketId, info.role || '', info.agentId);
      const raw = this.#inflightTriggerRaw.get(key);
      if (raw) {
        const { created } = this.#sessionDefer.addPendingIntent(
          info.agentId,
          { ticketId: info.ticketId, role: info.role || '', agentId: info.agentId },
          raw,
          { kind: 'trigger' },
        );
        this.#inflightTriggerRaw.delete(key);
        if (created) {
          log(
            `[dispatch] harness session-limit seeded dead task as pending intent ` +
              `ticket=${info.ticketId.slice(0, 8)} role=${info.role || '_'} agent=${info.agentId.slice(0, 8)}`,
          );
          this.#postDeferAuditComment(info.ticketId, info.resetLabel ?? '');
        }
      }
    }
    return res;
  }
  /** Current session-limit defer state for an agent — test / observability. */
  sessionDeferState(agentId: string): ReturnType<SessionLimitDeferStore['deferState']> {
    return this.#sessionDefer.deferState(agentId);
  }
  /** Count of coalesced pending resume intents (all agents, or one) — test /
   *  observability. */
  pendingSessionDeferCount(agentId?: string): number {
    return this.#sessionDefer.pendingIntentCount(agentId);
  }
  /** Post the ONE audit-visible defer comment for a newly-deferred ticket-role
   *  (ticket 467f714a — the "audit-visible defer 사유" completion criterion).
   *  Fired exactly once per intent creation across all three sources (exit-time
   *  seed, supervisor trigger, comment mention); repeats coalesce silently. Plain
   *  note (no @mention) so it never re-triggers an agent. Fire-and-forget — a
   *  failed POST must never affect dispatch. */
  #postDeferAuditComment(ticketId: string, resetLabel: string): void {
    if (!ticketId) return;
    fireAndForgetTool(this.#config, 'add_comment', {
      ticket_id: ticketId,
      content:
        '⏸️ **Harness 세션 한도로 재디스패치 유예** — 이 agent 의 CLI 세션 한도가 소진되어 ' +
        '(`session limit`) 재설정 시각까지 이 (ticket, role) 의 dispatch 를 spawn 하지 않고 ' +
        '단일 pending intent 로 합쳤습니다. supervisor/mention 재트리거는 세션을 새로 만들지 ' +
        '않으며, 재설정 후 **정확히 1회** 재개됩니다' +
        (resetLabel ? ` (reset: ${resetLabel})` : '') +
        '. (ticket 467f714a)',
      // ticket 3c8b8026: 이 파일의 모든 순수 자동 알림 add_comment 호출은
      // auto_notice:true 를 실어 서버가 activity-log actor_id 를 'system' 으로
      // 남기게 한다 — 그래야 이 알림이 스스로를 재트리거해 억제→알림→재트리거의
      // 자기증폭 루프를 만들지 않는다(코멘트 본문의 author 표시는 그대로 유지).
      metadata: { auto_notice: true },
    });
  }
  // ticket e9d0e8bc: folder-keyed run-lifetime lock. One per manager process
  // (this dispatcher is a singleton), so it serializes same-scenario QA/security
  // runs across the whole provision→execute window. Keyed by the absolute run
  // folder; different scenarios never contend.
  readonly #runExecLock = new FolderMutex();

  constructor(config: AwbConfig, deps: EventDispatcherDeps = {}) {
    this.#config = config;
    this.#subagentManager = deps.subagentManager ?? null;
    this.#chatSessionManager = deps.chatSessionManager ?? null;
    this.#ticketSessionManager = deps.ticketSessionManager ?? null;
    this.#fsBrowser = deps.fsBrowser ?? null;
    this.#prompts = deps.prompts ?? null;
    this.#agentManagerCommandHandler = deps.agentManagerCommandHandler ?? null;
    this.#managedAgentContexts = deps.managedAgentContexts ?? null;
    this.#worktreeManager = deps.worktreeManager ?? null;
    this.#runtimeProfileOverride = deps.runtimeProfileOverride;
    this.#runtimeSupervisor = deps.runtimeSupervisor ?? null;
    this.#inflightDispatch = deps.inflightDispatchTracker ?? new InflightDispatchTracker();
    this.#dispatchBlockTracker = deps.dispatchBlockTracker ?? new DispatchBlockTracker();
    this.#poolReclaimTrigger = deps.poolReclaimTrigger ?? null;
    // ticket d34075b5 review follow-up: the pool_exhausted retry queue replays via
    // handleTrigger (the same idempotent unit the force_respawn replay uses), pends
    // for the operator on give-up, and pre-checks ticket eligibility so a pended /
    // terminal ticket's queued retry is dropped before it fires.
    this.#poolRetry = new PendingDispatchRetry({
      onRetry: (raw) => this.handleTrigger(raw),
      onGiveUp: (entry) => this.#pendExhaustedPoolRetry(entry),
      verify: (entry) => this.#isPoolRetryEligible(entry),
      scheduler: deps.poolRetryScheduler ?? undefined,
      maxAttempts: deps.poolRetryMaxAttempts ?? undefined,
      log,
    });
    // ticket 467f714a: the session-limit defer store replays each pending intent
    // through handleTrigger at the reset instant (the same idempotent unit the
    // pool retry + force_respawn replay use — so the twin reservation re-engages).
    // main.ts injects the persisted, disk-backed instance; a bare dispatcher makes
    // an in-memory one. Either way we (re-)wire the resume + rehydrate here.
    this.#sessionDefer = deps.sessionLimitDeferStore ?? new SessionLimitDeferStore();
    // Route each replayed intent by kind: a trigger re-drives the ticket-role via
    // handleTrigger (re-acquiring the twin reservation — the process-local dedupe);
    // a coalesced mention is re-delivered via handleCommentMention. For triggers we
    // forward the spawned pid back to the store via `onSpawned` (blocker #3): the
    // store persists it on the `dispatching` intent so a crash between spawn and ack
    // leaves a reapable survivor handle that the next boot terminates before
    // re-driving — the durable exactly-once the process-local reservation can't give
    // across a restart. A mention has no durable session to reap, so it passes none.
    this.#sessionDefer.setResumeHandler((intent, onSpawned) =>
      intent.kind === 'mention'
        ? this.handleCommentMention(intent.raw)
        : this.handleTrigger(intent.raw, { onDispatched: (pid) => onSpawned(pid) }),
    );
    this.#sessionDefer.load();
  }

  /**
   * ticket 9f26f091: rewrite a managed agent's execution-context cwd to a
   * dedicated per-(ticket,role) git worktree before a trigger spawn. The
   * worktree dir is deterministic, so a fresh spawn after an idle-reap / unpend
   * reattaches to the SAME tree (branch + uncommitted work intact) — the
   * follow-up reuse path doesn't re-spawn, so it stays in the worktree the live
   * child already holds. Mutates the passed context object in place (it is a
   * fresh literal from #resolveAgentContext, never the registry record).
   */
  async #applyWorktreeCwd(
    agentContext: AgentExecutionContext | undefined,
    ticketId: string | undefined,
    role: string | undefined,
    mode: WorktreeMode | undefined,
    poolSize: number | undefined,
    bootstrapRepo: { resourceId?: string; url: string; branch?: string; credential?: { username?: string; token: string } | null } | null,
  ): Promise<{ ok: boolean; reason?: string; blockerKind?: string; detail?: string; path?: string; coldSharedWorktree?: boolean }> {
    const requiredError = validateWorktreeProvisioningInputs({
      mode,
      hasAgentContext: Boolean(agentContext),
      hasManager: Boolean(this.#worktreeManager),
      ticketId,
      role,
      repositoryResourceId: bootstrapRepo?.resourceId,
    });
    if (requiredError) return { ok: false, reason: requiredError, blockerKind: `worktree:${requiredError}` };
    if (!agentContext || !this.#worktreeManager || !ticketId || !role) return { ok: true };
    try {
      // worktree 규약 ②: the manager fixes the root at `<working_dir>/.awb/wt`
      // internally, so no worktreesRoot is passed. mode (per_ticket|shared) is
      // the board setting the server flattened onto the trigger event. poolSize
      // (규약 ⑥, shared mode only) = the board concurrency the server also
      // flattened on — sizes the warm-pool at N = max_concurrent_tickets_per_agent.
      const res = await this.#worktreeManager.resolveCwd({
        baseWorkingDir: agentContext.cwd,
        ticketId,
        role,
        mode,
        poolSize,
        bootstrapRepo,
      });
      if (res.isWorktree) {
        log(
          `[worktree] ticket=${ticketId.slice(0, 8)} role=${role} agent=${agentContext.agent_id.slice(0, 8)} mode=${res.mode ?? mode ?? 'per_ticket'} cwd=${res.cwd}${res.reused ? ' (reused)' : ' (new)'}`,
        );
        // ticket feaa7ab0: a successful `git worktree add` is NOT proof the cwd
        // is a usable checkout of the EXPECTED repo. Verify (is-inside-work-tree
        // + HEAD resolves + origin matches) before handing it to a spawn, so an
        // empty/half-written/foreign checkout aborts here instead of burning a
        // CLI session and triggering a re-dispatch storm.
        const checkout = await this.#worktreeManager.verifyCheckout(res.cwd, bootstrapRepo?.url);
        if (!checkout.ok) {
          const reason = checkout.reason || 'invalid_checkout';
          // Report WHICH checkout path failed (completion criterion #5). The cwd
          // is credential-free, but reduce it to the working_dir-relative managed
          // form (`.awb/wt/…`) when possible so we never echo an absolute host
          // layout into the ticket comment/activity.
          const path = managedWorktreePath(agentContext.cwd, res.cwd);
          log(
            `[worktree] checkout verification failed for ticket=${ticketId.slice(0, 8)} role=${role}: ${reason}${checkout.detail ? ` (${checkout.detail})` : ''} path=${path}`,
          );
          return { ok: false, reason, blockerKind: `worktree:${reason}`, detail: checkout.detail, path };
        }
        agentContext.cwd = res.cwd;
        return {
          ok: true,
          coldSharedWorktree: res.mode === 'shared' && res.reused === false,
        };
      }
      const gate = classifyWorktreeOutcome(res);
      if (gate.blocked) {
        log(
          `[worktree] isolation provisioning failed for ticket=${ticketId.slice(0, 8)} role=${role}: ${gate.reason}`,
        );
        return { ok: false, reason: gate.reason, blockerKind: gate.kind };
      }
      return { ok: true };
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      log(`[worktree] resolveCwd failed (${reason})`);
      return { ok: false, reason, blockerKind: 'worktree:error' };
    }
  }

  /** ticket d34075b5 — pre-retry eligibility for a queued pool_exhausted trigger.
   *  Returns false the moment the ticket leaves the active flow so the queued retry
   *  is dropped instead of replayed: a human/give-up PEND (no inbound SSE, so this
   *  is the ONLY signal for it) or a TERMINAL column (work finished). A failed fetch
   *  returns true (fail OPEN) — a transient REST hiccup must never abandon a live
   *  ticket; the terminal/archive/move board_update path cancels proactively anyway. */
  async #isPoolRetryEligible(entry: PendingRetryEntry): Promise<boolean> {
    const ticket = await fetchTicketContext(this.#config, entry.ticketId);
    if (!ticket) return true;
    if (ticket.pending_user_action) return false;
    if (ticket.terminal_entered_at) return false;
    return true;
  }

  /** ticket d34075b5 — the pool_exhausted retry queue gave up after its attempt
   *  bound: the pool stayed exhausted with no reclaimable lease across the whole
   *  backoff window, i.e. genuine sustained over-subscription (not a leaked lease).
   *  Pend for operator attention — the same operator-exposure guarantee the legacy
   *  transient-blocker backoff gave, now decoupled from lucky server re-pushes.
   *  e7c87517's 24h no-progress backstop remains the ultimate net. */
  async #pendExhaustedPoolRetry(entry: PendingRetryEntry): Promise<void> {
    if (!entry.ticketId) return;
    const reason =
      `shared worktree 풀 고갈(pool_exhausted)이 매니저 자동 재시도 ${entry.attempts}회(약 20분 이상) 후에도 지속 — ` +
      `회수 가능한 leaked lease 가 없어 실제 풀 과다구독으로 판단됩니다. max_concurrent_tickets_per_agent(풀 크기 N)와 이 working_dir 를 공유하는 보드 구성을 점검하고 unpend 로 재개하세요.`;
    await fireAndForgetTool(this.#config, 'pend_ticket', { ticket_id: entry.ticketId, reason });
    await fireAndForgetTool(this.#config, 'add_comment', {
      ticket_id: entry.ticketId,
      content:
        `⛔ **shared worktree 풀 고갈 지속 — 자동 재시도 한도 초과, pend** — 매니저가 ${entry.attempts}회 자동 재시도했지만 슬롯이 반납/회수되지 않아 디스패치를 pend 했습니다.\n\n` +
        `leaked lease 는 이미 회수 grace(20분) 를 넘겨 재조정 대상이었으므로, 남은 원인은 이 working_dir 를 공유하는 보드들의 실제 동시 실행 수가 풀 크기 N 을 초과하는 과다구독입니다.\n\n` +
        `**조치:** max_concurrent_tickets_per_agent 를 늘리거나, 이 working_dir 를 공유하는 보드/에이전트 구성을 분리한 뒤 unpend 하세요. (원인-불문 no-progress 백스톱: e7c87517)`,
      metadata: { auto_notice: true }, // ticket 3c8b8026 — 자기 재트리거 방지, #postDeferAuditComment 주석 참고
    });
    log(`[pool-retry] pended ticket=${entry.ticketId.slice(0, 8)} role=${entry.role} after ${entry.attempts} exhausted retries`);
  }

  /**
   * 티켓이 terminal 컬럼에 진입하면 매니저가 소유한 checkout에서 해당 티켓의
   * Git 흔적을 정리한다. 서버의 terminal_entered_at을 재확인하고, worktree가
   * clean하며 티켓 branch가 base에 포함된 경우에만 worktree와 로컬/origin ref를
   * 삭제한다. 보류 결과는 티켓 코멘트에 남기며 전체 처리는 best-effort다.
   */
  async #cleanupTerminalTicketWorktrees(ticketId: string): Promise<void> {
    if (!this.#worktreeManager) return;
    if (!this.#managedAgentContexts) return;
    try {
      const ticket = await fetchTicketContext(this.#config, ticketId);
      // terminal_entered_at is null whenever the ticket is NOT currently in a
      // terminal column — that's our gate. A failed fetch (null ticket) is
      // treated as "unknown → skip" so a transient REST error can't nuke a
      // live ticket's worktree.
      if (!ticket || !ticket.terminal_entered_at) return;
      let total = 0;
      const seenDirs = new Set<string>();
      for (const ctx of this.#managedAgentContexts.list()) {
        if (!ctx.working_dir) continue;
        // worktree 규약 ②: the worktree root is derived from working_dir
        // (`<working_dir>/.awb/wt`) inside the manager, so agents sharing one
        // working_dir dedupe on that alone.
        if (seenDirs.has(ctx.working_dir)) continue;
        seenDirs.add(ctx.working_dir);
        const cleanup = await this.#worktreeManager.cleanupTerminalTicketGit({
          baseWorkingDir: ctx.working_dir,
          ticketId,
          baseBranch: ticket.base_repo?.default_branch || ticket.base_branch || 'main',
          repositoryResourceId: ticket.base_repo?.id,
        });
        total += cleanup.removedWorktrees;
        if (cleanup.heldReasons.length > 0 || cleanup.remainingBranches.length > 0) {
          await fireAndForgetTool(this.#config, 'add_comment', {
            ticket_id: ticketId,
            content:
              `⚠️ Git 자동 정리를 보류했습니다.\n\n사유:\n- ${cleanup.heldReasons.join('\n- ') || '잔여 브랜치 확인 필요'}\n\n` +
              `잔여 브랜치: ${cleanup.remainingBranches.join(', ') || '없음'}`,
            metadata: { dedupe_key: `terminal-git-cleanup-held:${ticket.terminal_entered_at}` },
          });
        }
      }
      if (total > 0) {
        log(
          `[worktree] terminal ticket=${ticketId.slice(0, 8)} reclaimed ${total} worktree(s)`,
        );
        // ticket d34075b5: a terminal move just released this ticket's shared pool
        // slot — re-drive any pool_exhausted retry starved on a full pool now,
        // instead of waiting out its backoff (the "slot release → re-dispatch" path).
        this.#poolRetry.wake(`slot_release:terminal:${ticketId.slice(0, 8)}`);
      }
    } catch (err: any) {
      log(
        `[worktree] terminal cleanup failed for ticket=${ticketId.slice(0, 8)}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * worktree 규약 ⑤: when a ticket is ARCHIVED, physically remove everything it
   * used across every managed agent this manager owns — its per_ticket worktree
   * (`.awb/wt/<ticket8>`, force-removed even if dirty) AND its QA/Security run
   * workspace (`.awb/qa/<ticket8>`). The reusable 'shared' worktree is never
   * touched (removeTicketWorktrees skips it).
   *
   * Distinct from #cleanupTerminalTicketWorktrees:
   *   - triggered by the archive board_update (action==='archived'), not a move;
   *   - also reclaims the run workspace, which Done-time terminal cleanup leaves;
   *   - covers tickets archived straight from a NON-terminal column (obsolete /
   *     superseded work) that never entered terminal and so never hit terminal
   *     cleanup — the primary case that motivated 규약 ⑤.
   *
   * No REST re-fetch gate is used (terminal cleanup re-reads terminal_entered_at
   * because 'moved' doesn't reveal the destination's terminal-ness). The
   * 'archived' action IS the confirmation, archived tickets are filtered out of
   * most REST reads anyway, and both removals are idempotent no-ops when the
   * dirs are already gone (e.g. the worktree was reclaimed at Done). Best-effort,
   * fire-and-forget; never throws.
   */
  async #cleanupArchivedTicketWorkspace(ticketId: string, repositoryResourceId?: string): Promise<void> {
    if (!this.#worktreeManager) return;
    if (!this.#managedAgentContexts) return;
    try {
      let worktrees = 0;
      let runDirs = 0;
      const seenDirs = new Set<string>();
      for (const ctx of this.#managedAgentContexts.list()) {
        if (!ctx.working_dir) continue;
        // The worktree + run-workspace roots both derive from working_dir
        // (`<working_dir>/.awb/{wt,qa}`), so agents sharing one working_dir
        // dedupe on that alone.
        if (seenDirs.has(ctx.working_dir)) continue;
        seenDirs.add(ctx.working_dir);
        worktrees += await this.#worktreeManager.removeTicketWorktrees({
          baseWorkingDir: ctx.working_dir,
          ticketId,
          repositoryResourceId,
        });
        if (
          await this.#worktreeManager.removeTicketRunWorkspace({
            baseWorkingDir: ctx.working_dir,
            ticketId,
          })
        ) {
          runDirs++;
        }
      }
      if (worktrees > 0 || runDirs > 0) {
        log(
          `[worktree] archived ticket=${ticketId.slice(0, 8)} reclaimed ${worktrees} worktree(s) + ${runDirs} run workspace(s)`,
        );
      }
      if (worktrees > 0) {
        // ticket d34075b5: an archive released this ticket's shared pool slot —
        // re-drive any starved pool_exhausted retry now (slot release → re-dispatch).
        this.#poolRetry.wake(`slot_release:archived:${ticketId.slice(0, 8)}`);
      }
    } catch (err: any) {
      log(
        `[worktree] archive cleanup failed for ticket=${ticketId.slice(0, 8)}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * ST-6: resolve a managed-agent context by id (the event's target agent).
   * Returns null when (a) no registry is wired, (b) the id doesn't match
   * any registered managed agent, or (c) the agent is not yet bootstrapped
   * (apikey not provisioned, working_dir empty). The dispatcher falls
   * through to manager-default behavior in those cases.
   */
  #resolveAgentContext(eventAgentId: string | undefined | null): AgentExecutionContext | undefined {
    if (!eventAgentId || !this.#managedAgentContexts) return undefined;
    const ctx = this.#managedAgentContexts.get(eventAgentId);
    if (!ctx) return undefined;
    if (!ctx.api_key || !ctx.working_dir || !ctx.mcp_config_path) return undefined;
    return {
      agent_id: ctx.agent_id,
      workspace_id: ctx.workspace_id,
      api_key: ctx.api_key,
      cwd: ctx.working_dir,
      mcp_config_path: ctx.mcp_config_path,
      cli: ctx.cli || 'claude',
      cli_home_dir: ctx.cli_home_dir,
      extra_env: ctx.extra_env,
      credential_provider: ctx.credential_provider ?? null,
      credential_id: ctx.credential_id ?? null,
      model: ctx.model ?? null,
      runtime_config: ctx.runtime_config ?? null,
    };
  }

  async #scopeAgentContext(
    context: AgentExecutionContext | undefined,
    workspaceId: string | undefined | null,
  ): Promise<AgentExecutionContext | undefined> {
    const scope = String(workspaceId || '').trim();
    if (!context || !scope || context.workspace_id === scope) return context;
    let apiKey = await readApiKey(context.agent_id, scope);
    if (!apiKey) {
      const issued = await provisionManagedAgentApiKey(this.#config, context.agent_id, scope);
      if (!issued?.raw_key) throw new Error(`Could not provision workspace-scoped key for ${scope}`);
      apiKey = issued.raw_key;
      await writeApiKey(context.agent_id, apiKey, scope);
    }
    // Ticket ee26302d: cross-workspace re-scoping — no resolved profile in
    // scope here either (same gap as agent-manager-commands.ts's spawn_agent
    // / #refreshMcpConfig), always writes 'full'. Corrected by the next
    // actual spawn through base-session-manager.ts / subagent-manager.ts.
    const mcpConfigPath = await writeMcpConfig(context.agent_id, this.#config.url, apiKey, scope);
    return { ...context, workspace_id: scope, api_key: apiKey, mcp_config_path: mcpConfigPath };
  }

  async #dispatchHermes(args: {
    agentContext: AgentExecutionContext;
    runId: string;
    leaseId: string;
    task: string;
    systemContext?: string;
    skillSnapshot?: (RuntimeSkillSnapshot & { run_id?: string }) | null;
    // ticket a837879c 2차 재리뷰 지적 #1 — this dispatch's own event stream,
    // scoped to just this call. Chat call sites use it to collect
    // `message_delta` text so delivery can be confirmed by what Hermes
    // actually said, not by `stopReason` alone.
    onEvent?: (event: RuntimeEvent) => void;
  }): Promise<RuntimeDispatchResult> {
    if (!this.#runtimeSupervisor) {
      const err: any = new Error('Hermes runtime supervisor is not available on this Runtime Host');
      err.code = 'runtime_supervisor_unavailable';
      throw err;
    }
    let skillDirectory = '';
    if (args.skillSnapshot) {
      const materializationId = `run-${createHash('sha256')
        .update(args.skillSnapshot.run_id || args.runId)
        .digest('hex')
        .slice(0, 32)}`;
      const root = args.agentContext.cli_home_dir
        ? `${args.agentContext.cli_home_dir}/runs`
        : `${args.agentContext.cwd}/.awb/runtime-runs`;
      skillDirectory = await new SkillMaterializer(root).materialize(
        materializationId,
        args.skillSnapshot,
      );
    }
    return this.#runtimeSupervisor.dispatch({
      agentId: args.agentContext.agent_id,
      runId: args.runId,
      leaseId: args.leaseId,
      cwd: args.agentContext.cwd,
      apiKey: args.agentContext.api_key,
      runtimeId: args.agentContext.cli,
      runtimeConfig: args.agentContext.runtime_config,
      model: args.agentContext.model,
      systemContext: [
        args.systemContext,
        skillDirectory
          ? `Immutable AWB skill snapshot directory: ${skillDirectory}`
          : '',
      ].filter(Boolean).join('\n\n'),
      task: args.task,
      onEvent: args.onEvent,
    });
  }

  // ticket a837879c 리뷰 지적 #2 — Hermes 디스패치 실패의 err.message 원문(실행 경로,
  // 명령 인자, ACP 프로토콜 data 등을 포함할 수 있음)을 채팅에 그대로 노출하지 않기
  // 위한 allowlist. #dispatchHermes()/RuntimeSupervisor가 던지는 Error.code 값과
  // ACP session/prompt의 stopReason 값만 통과시키고, 목록 밖은 전부
  // 'runtime_dispatch_error'로 뭉뚱그린다. err.message 는 로그/spawnFailureTracker
  // 에만 남는다.
  static readonly #HERMES_CHAT_ERROR_CODES = new Set([
    'runtime_supervisor_unavailable',
    'runtime_not_configured',
    'runtime_unknown',
    'runtime_unavailable',
    'runtime_config_invalid',
    'runtime_not_supported',
    'runtime_collaboration_denied',
    'hermes_session_not_found',
    'hermes_session_owner_mismatch',
    'hermes_session_lease_mismatch',
    'hermes_session_cwd_mismatch',
    'acp_timeout',
    'acp_aborted',
    'acp_closed',
    'acp_process_exited',
    'acp_malformed_message',
    'acp_message_too_large',
    'acp_remote_error',
    'acp_write_failed',
    'max_tokens',
    'max_turn_requests',
    'refusal',
    'cancelled',
    // ticket a837879c 리뷰 지적 #1(2차) — end_turn 자체는 send_chat_room_message
    // 성공의 증거가 아니라는 지적에 대응해 신설한 두 코드. #reportHermesDispatchOutcome
    // 참고.
    'hermes_empty_reply',
    'hermes_reply_post_failed',
    // ticket e8105c84 리뷰 라운드1 지적 — end_turn 자체는 코멘트 멘션에 대한
    // add_comment 응답의 증거가 아니라는 지적에 대응해 신설. #reportHermesMentionOutcome
    // 참고.
    'hermes_mention_no_reply',
    // ticket e8105c84 리뷰 라운드3 지적 — pre-dispatch baseline 자체를 못 구한
    // 경우를 "코멘트 0개"와 구분하기 위해 신설. #reportHermesMentionOutcome 참고.
    'hermes_mention_baseline_unavailable',
  ]);

  // 실패를 세 곳에 일관되게 노출한다: (a) 매니저 로그(전체 detail, classify()가
  // category='hermes'로 잡도록 "Hermes <prefix> failed closed:" 형식 고정),
  // (b) spawnFailureTracker(대시보드 degraded 배지 — base-session-manager.ts/
  // subagent-manager.ts의 CLI spawn 실패와 동일한 신호 경로 재사용, 리뷰 지적 #3),
  // (c) 채팅방(allowlist 코드 + 일반 안내만, 리뷰 지적 #2). 채팅 POST 자체의 실패는
  // 빈 catch로 삼키지 않고 로그로 남긴다(리뷰 지적 #3).
  async #reportHermesDispatchFailure(
    logPrefix: string,
    roomId: string | undefined,
    agentId: string | undefined,
    code: string,
    detail: string,
  ): Promise<void> {
    log(`${logPrefix} failed closed: ${code} ${detail}`);
    spawnFailureTracker.record({ cli: 'hermes', code, message: detail });
    if (!roomId || !agentId) return;
    const chatCode = EventDispatcher.#HERMES_CHAT_ERROR_CODES.has(code)
      ? code
      : 'runtime_dispatch_error';
    const posted = await postChatRoomMessage(
      this.#config,
      roomId,
      agentId,
      `⚠️ **Hermes 런타임 실행 실패** (\`${chatCode}\`)\n\n` +
        `이 메시지에 응답하지 못했습니다. Agent Manager 로그를 확인한 뒤 다시 시도하세요.`,
    ).catch((postErr: any) => {
      log(`${logPrefix} failure notice POST threw: room=${roomId} ${postErr?.message ?? postErr}`);
      return false;
    });
    if (!posted) {
      log(`${logPrefix} failure notice did not reach room=${roomId} (code=${chatCode})`);
    }
  }

  // dispatch()가 throw 없이 resolve해도 ACP session/prompt 가 'end_turn' 이외의
  // stopReason 으로 끝나면 응답 전달이 실제로 완료됐다는 보장이 없다 — stopReason
  // 을 확인해 'end_turn' 이 아니면 실패와 동일하게 다룬다.
  //
  // ticket a837879c 리뷰 지적 #1(2차 재리뷰) — 'end_turn' 자체도 send_chat_room_message
  // 호출이 실제로 성공했다는 증거는 아니라는 지적. Hermes 자신이 그 MCP 도구를
  // 호출했는지를 ACP tool-call 관측으로 추정하는 대신(Hermes ACP 구현이 MCP 도구
  // 호출을 tool_call 알림의 title/kind 에 어떻게 담는지는 벤더 재량이라 검증 불가),
  // 채팅 응답 채널 자체를 Manager 소유로 바꿨다 — Hermes 는 이제 최종 답변을 일반
  // 텍스트로만 작성하고(prompts.ts 의 'agent_manager_delivers' 모드,
  // chatReplyInstructions 참고), 그 세션에서 관측된 agent_message_chunk 델타를
  // 호출부가 모아 넘긴 replyText 를 여기서 직접 postChatRoomMessage 로 방에
  // 게시한다. recordSuccess 는 그 POST 가 실제로 성공했을 때만 호출되므로,
  // "정상 종료처럼 보이지만 채팅 응답 없음"이 성공으로 잘못 기록될 수 없다.
  async #reportHermesDispatchOutcome(
    logPrefix: string,
    roomId: string | undefined,
    agentId: string | undefined,
    result: RuntimeDispatchResult,
    replyText: string,
  ): Promise<void> {
    if (result.stopReason !== 'end_turn') {
      await this.#reportHermesDispatchFailure(
        logPrefix,
        roomId,
        agentId,
        result.stopReason,
        `session ${result.sessionId} ended without confirming delivery (stop=${result.stopReason})`,
      );
      return;
    }
    const trimmed = replyText.trim();
    if (!trimmed) {
      await this.#reportHermesDispatchFailure(
        logPrefix,
        roomId,
        agentId,
        'hermes_empty_reply',
        `session ${result.sessionId} ended with end_turn but produced no reply text`,
      );
      return;
    }
    if (!roomId || !agentId) {
      // No chat room to deliver into (e.g. a future non-chat caller) — the
      // ACP session itself completed normally, nothing left to confirm.
      spawnFailureTracker.recordSuccess('hermes');
      return;
    }
    const posted = await postChatRoomMessage(this.#config, roomId, agentId, trimmed)
      .catch((postErr: any) => {
        log(`${logPrefix} reply POST threw: room=${roomId} ${postErr?.message ?? postErr}`);
        return false;
      });
    if (!posted) {
      await this.#reportHermesDispatchFailure(
        logPrefix,
        roomId,
        agentId,
        'hermes_reply_post_failed',
        `session ${result.sessionId} completed but reply POST to room=${roomId} failed`,
      );
      return;
    }
    spawnFailureTracker.recordSuccess('hermes');
  }

  // ticket d946862a: handleCommentMention의 Hermes 분기는 채팅방이 없는
  // 호출부라 #reportHermesDispatchFailure의 (c) 채팅 POST leg가 항상
  // no-op이다(roomId/agentId를 undefined로 넘김) — 로그 classify()/
  // spawnFailureTracker 신호는 거기서 이미 커버되지만, 멘션을 남긴 사람은
  // 티켓 자체를 보지 않는 한 실패를 알 방법이 없었다. 이 티켓 코멘트 leg를
  // 별도로 둔다. #postDeferAuditComment와 동일하게 평문(멘션 없음)이라
  // agent 재트리거 체인을 새로 만들지 않는다.
  async #notifyHermesMentionFailureOnTicket(ticketId: string, code: string): Promise<void> {
    if (!ticketId) return;
    const chatCode = EventDispatcher.#HERMES_CHAT_ERROR_CODES.has(code)
      ? code
      : 'runtime_dispatch_error';
    await fireAndForgetTool(this.#config, 'add_comment', {
      ticket_id: ticketId,
      content:
        `⚠️ **Hermes 런타임 실행 실패** (\`${chatCode}\`)\n\n` +
        '이 멘션에 응답하지 못했습니다. Agent Manager 로그를 확인한 뒤 다시 멘션해 주세요.',
      metadata: { auto_notice: true }, // ticket 3c8b8026 — 자기 재트리거 방지, #postDeferAuditComment 주석 참고
    });
  }

  // ticket e8105c84: #dispatchHermes()가 throw 없이 resolve하는 성공 경로도
  // #reportHermesDispatchOutcome과 마찬가지로 stopReason이 'end_turn'이 아니면
  // 응답이 실제로 완료됐다는 보장이 없다 — 종전에는 handleCommentMention이 이
  // 케이스를 log()만 남기고 spawnFailureTracker/티켓 어느 쪽에도 신호를 남기지
  // 않았다. 이 경로는 replyText를 관측하지 않으므로(Hermes가 add_comment MCP
  // 도구를 직접 호출) #reportHermesDispatchOutcome을 그대로 재사용할 수 없고,
  // stopReason 검사만 골라 재사용한다.
  //
  // 리뷰 라운드1 지적: stopReason이 'end_turn'이어도 Hermes가 실제로
  // add_comment를 호출했다는 보장은 아니다 — 이 티켓이 막아야 하는 바로 그
  // "무응답인데 성공 처리" 케이스가 'end_turn' 경로 안에도 남아있었다.
  //
  // 리뷰 라운드2 지적: 최초 구현은 timestamp 커트오프(+클록 스큐 버퍼)로
  // "새 코멘트"를 판정했는데, 그러면 같은 agent가 디스패치 직전(버퍼 이내)에
  // 남긴 그냥 예전 코멘트를 이번 응답으로 오인해 false positive가 났다.
  // hasNewAgentComment로 교체 — 디스패치 직전 실제 코멘트 id 집합
  // (knownCommentIds, handleCommentMention이 prompt 구성용으로 이미 수행한
  // fetch에서 그대로 스냅샷)에 없는 새 id가 이 agent 이름으로 나타났는지만
  // 본다. 시간 폭 없이 정확한 집합 멤버십이라 클록 스큐도, "그냥 예전
  // 코멘트" 오인도 둘 다 없다.
  //
  // 리뷰 라운드3 지적: knownCommentIds가 null이면(pre-dispatch fetch 실패
  // 또는 응답에 comments 누락) diff 자체를 신뢰할 수 없다 — 빈 Set으로
  // 취급해 diff를 강행하면 이미 있던 동일 agent 코멘트가 전부 "새 응답"으로
  // 오탐된다. baseline을 못 구한 경우는 정상적으로 코멘트가 0개인 경우와
  // 구분해 별도 코드(hermes_mention_baseline_unavailable)로 fail-closed —
  // diff를 아예 시도하지 않는다.
  async #reportHermesMentionOutcome(
    ticketId: string,
    agentId: string,
    knownCommentIds: ReadonlySet<string> | null,
    result: RuntimeDispatchResult,
  ): Promise<void> {
    if (result.stopReason !== 'end_turn') {
      await this.#reportHermesDispatchFailure(
        'Hermes mention dispatch',
        undefined,
        undefined,
        result.stopReason,
        `session ${result.sessionId} ended without confirming delivery (stop=${result.stopReason})`,
      );
      await this.#notifyHermesMentionFailureOnTicket(ticketId, result.stopReason);
      return;
    }
    if (!knownCommentIds) {
      await this.#reportHermesDispatchFailure(
        'Hermes mention dispatch',
        undefined,
        undefined,
        'hermes_mention_baseline_unavailable',
        `session ${result.sessionId} ended with end_turn but the pre-dispatch comment baseline for ` +
          `ticket=${ticketId} could not be captured — cannot verify agent=${agentId} actually replied`,
      );
      await this.#notifyHermesMentionFailureOnTicket(ticketId, 'hermes_mention_baseline_unavailable');
      return;
    }
    const replied = await hasNewAgentComment(this.#config, ticketId, agentId, knownCommentIds);
    if (!replied) {
      await this.#reportHermesDispatchFailure(
        'Hermes mention dispatch',
        undefined,
        undefined,
        'hermes_mention_no_reply',
        `session ${result.sessionId} ended with end_turn but agent=${agentId} posted no new comment on ticket=${ticketId}`,
      );
      await this.#notifyHermesMentionFailureOnTicket(ticketId, 'hermes_mention_no_reply');
      return;
    }
    spawnFailureTracker.recordSuccess('hermes');
  }

  /**
   * Chat-event variant: events.controller delivers a chat_room_message to a
   * manager whenever any of its managed agents participates in the room, but
   * the wire payload doesn't single out which one should reply. We pick the
   * first managed agent in `agent_member_ids` whose runtime context is fully
   * bootstrapped — that's the identity the spawned chat session runs under.
   * Returns undefined when no match exists (manager itself is the participant
   * and the spawn should fall back to manager defaults).
   */
  #resolveAgentContextFromMembers(
    memberIds: string[],
    excludeAgentId?: string | null,
  ): AgentExecutionContext | undefined {
    if (!memberIds.length || !this.#managedAgentContexts) return undefined;
    for (const id of memberIds) {
      // The sender never answers its own message. Skipping it here (rather
      // than dropping the whole event) is what lets a SIBLING managed agent
      // on the same host pick the message up.
      if (excludeAgentId && id === excludeAgentId) continue;
      const ctx = this.#resolveAgentContext(id);
      if (ctx) return ctx;
    }
    return undefined;
  }

  /**
   * ticket c0c0b1e4: classify why #resolveAgentContext(id) came back undefined
   * for a single candidate id. 'unmanaged'/'no_id' are routine (the id was
   * never this manager's to resolve) — only 'not_bootstrapped' means the
   * registry HAS an entry (this manager does own the agent) but it never
   * finished bootstrapping (missing api_key/working_dir/mcp_config_path,
   * e.g. a manager-restart rehydration miss). Only that case is worth
   * surfacing as an error; the rest is filtering noise.
   */
  #agentContextMissReason(
    eventAgentId: string | undefined | null,
  ): 'no_id' | 'unmanaged' | 'not_bootstrapped' {
    if (!eventAgentId || !this.#managedAgentContexts) return 'no_id';
    return this.#managedAgentContexts.get(eventAgentId) ? 'not_bootstrapped' : 'unmanaged';
  }

  /** Members variant of {@link #agentContextMissReason} for
   *  #resolveAgentContextFromMembers callers — reports 'not_bootstrapped' if
   *  ANY candidate is a registered-but-broken managed agent, even when other
   *  members in the list are simply unmanaged. Also returns the specific
   *  member id that triggered a 'not_bootstrapped' verdict (ticket c0c0b1e4
   *  리뷰 지적 #3) — callers must notify using THAT id, not memberIds[0], since
   *  the broken member need not be first in the list. */
  #agentContextMissReasonForMembers(
    memberIds: string[],
  ): { reason: 'no_id' | 'unmanaged' | 'not_bootstrapped'; brokenId: string } {
    if (!memberIds.length || !this.#managedAgentContexts) return { reason: 'no_id', brokenId: '' };
    let sawUnmanaged = false;
    for (const id of memberIds) {
      const reason = this.#agentContextMissReason(id);
      if (reason === 'not_bootstrapped') return { reason, brokenId: id };
      if (reason === 'unmanaged') sawUnmanaged = true;
    }
    return { reason: sawUnmanaged ? 'unmanaged' : 'no_id', brokenId: '' };
  }

  /**
   * ticket c0c0b1e4: previously an unresolved agent context (undefined from
   * #resolveAgentContext/#resolveAgentContextFromMembers) skipped every
   * downstream identity check and fell through to a generic "dropped (no
   * delegation path)" log line that classify() never picks up — a fully
   * silent drop with no signal beyond the local log file. Logs a
   * classify()-matchable line (category='agent-context', level='error' — see
   * error-log-uploader.ts) whenever the miss is the genuine 'not_bootstrapped'
   * case; routine 'unmanaged'/'no_id' misses are left as-is. Returns whether
   * it reported, so callers know whether a user-facing notice is also worth
   * posting.
   */
  #reportAgentContextMiss(
    logPrefix: string,
    reason: 'no_id' | 'unmanaged' | 'not_bootstrapped',
    idLabel: string,
  ): boolean {
    if (reason !== 'not_bootstrapped') return false;
    log(
      `${logPrefix}: agent context unresolved (registered but not bootstrapped — possible rehydration miss) agent=${idLabel}`,
    );
    return true;
  }

  /** Best-effort chat-room notice for a #reportAgentContextMiss(...) hit —
   *  mirrors #reportHermesDispatchFailure's fire-and-log POST pattern. */
  async #notifyAgentContextMissInRoom(
    logPrefix: string,
    roomId: string | undefined,
    agentId: string,
  ): Promise<void> {
    if (!roomId || !agentId) return;
    const posted = await postChatRoomMessage(
      this.#config,
      roomId,
      agentId,
      '⚠️ **에이전트 실행 정보를 찾을 수 없습니다**\n\n' +
        '이 메시지에 응답하지 못했습니다. Agent Manager가 이 에이전트의 실행 컨텍스트를 ' +
        '아직 준비하지 못한 상태입니다(재시작 직후 rehydration 미완료 등). 잠시 후 다시 시도해 주세요.',
    ).catch((postErr: any) => {
      log(`${logPrefix} agent-context-miss notice POST threw: room=${roomId} ${postErr?.message ?? postErr}`);
      return false;
    });
    if (!posted) {
      log(`${logPrefix} agent-context-miss notice did not reach room=${roomId}`);
    }
  }

  /**
   * True when the sender is an identity this host owns — the manager itself or
   * one of its managed agents.
   *
   * This used to be the whole self-gate: any message from an owned identity was
   * dropped before dispatch, which meant two agents hosted by the same manager
   * could never talk to each other (the sibling's runtime was never spawned).
   * It is now only half the gate — the caller drops the message solely when NO
   * other managed member of the room can take it, i.e. when the only remaining
   * candidate would be the sender answering itself. Loop prevention across a
   * real two-agent conversation is the `agent_chain_depth` cap's job.
   */
  #senderIsOwnedIdentity(senderId: string | undefined | null): boolean {
    if (!senderId) return false;
    const selfAgentId = loadAgentInfo()?.agent_id || '';
    if (selfAgentId && senderId === selfAgentId) return true;
    return !!this.#managedAgentContexts?.has(senderId);
  }

  /** Route a raw SSE event payload to the right handler. */
  dispatch(eventType: string, raw: string): void | Promise<void> {
    if (!raw) return;
    switch (eventType) {
      case 'agent_trigger':
      case 'board_update':
      case 'chat_request':
      case 'chat_room_message':
      case 'comment_mention':
      case 'fs_request':
      case 'agent_manager_command':
        recordEvent(eventType, raw);
        break;
      default:
        return; // silently drop unknown event types (e.g. agent_typing)
    }
    switch (eventType) {
      case 'agent_trigger':
        return this.handleTrigger(raw);
      case 'board_update':
        return this.handleBoardUpdate(raw);
      case 'chat_request':
        return this.handleChatRequest(raw);
      case 'chat_room_message':
        return this.handleChatRoomMessage(raw);
      case 'comment_mention':
        return this.handleCommentMention(raw);
      case 'fs_request':
        return this.handleFsRequest(raw);
      case 'agent_manager_command':
        return this.#agentManagerCommandHandler
          ? this.#agentManagerCommandHandler.handle(raw)
          : undefined;
    }
  }

  async handleFsRequest(raw: string): Promise<void> {
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch (err: any) {
      log(`Failed to parse fs_request: ${err?.message ?? err}`);
      return;
    }
    const requestId = ev.request_id;
    if (!requestId) {
      log('fs_request missing request_id — dropped');
      return;
    }

    // ST-7 follow-up: never short-circuit with FS_BROWSER_DISABLED on the
    // dispatcher side. The previous null-fsBrowser branch was a defensive
    // belt that misled operators into thinking they needed to enable
    // fs_browser in config — but config gating was already removed in
    // fs-browser.ts. If main.ts somehow forgot to wire a FsBrowser, lazy-
    // construct one here so browsing still works. Logged once when it
    // happens so the wiring bug is visible.
    //
    // 2026-08-17 보안 감사: 이 폴백은 fsSection 으로 `null` 을 넘겨서 운영자가
    // 설정한 `fs_browser.roots` 를 통째로 버리고 있었다 — main.ts 배선이 빠진
    // 순간 스코프 제한이 조용히 사라져 호스트 전체가 열린다. 반드시 main.ts 와
    // 동일한 섹션을 넘겨서 폴백 경로에서도 스코프가 유지되게 한다.
    if (!this.#fsBrowser) {
      log('handleFsRequest: no FsBrowser wired — lazy-constructing a default. Fix main.ts wiring.');
      const { FsBrowser } = await import('./fs-browser.js');
      this.#fsBrowser = new FsBrowser(this.#config, (this.#config as any)?.fs_browser || null);
    }

    const result = await this.#fsBrowser.handle({
      op: ev.op,
      path: ev.path,
      offset: ev.offset,
      limit: ev.limit,
      name: ev.name,
    });
    await postFsResponse(this.#config, requestId, result);
    log(
      `fs_request ${ev.op} ${ev.path} → ${result.ok ? 'ok' : `err:${result.code || 'FS_ERROR'}`}`,
    );
  }

  /** ticket 3b8f24ec: shared by handleTrigger's own `triggerSeat` AND
   *  handleCommentMention's `mentionSeat` (both via createDispatchSeat's
   *  `onReleased` hook, ticket 77b28217) — replay a single suppressed
   *  force-respawn once whichever (ticket, role, agent) seat held
   *  `inflightKey` releases, so a force_respawn suppressed while a MENTION
   *  held the seat (not only a trigger, ticket f0d1da19) still gets its one
   *  guaranteed re-run instead of sitting stuck until some later trigger for
   *  the same key happens to consume it. Re-parses the SUPPRESSED event's OWN
   *  captured raw (`recordSuppression`'s `raw`, captured inside handleTrigger's
   *  own reservation gate — a mention never carries force_respawn and never
   *  calls recordSuppression itself), never the releasing holder's own
   *  identity: replaying THAT would re-enter dispatchTrigger with an
   *  already-remembered `field_changed` and get dropped as `duplicate_trigger`
   *  (the exact regression ticket f0d1da19 fixed). Always re-enters
   *  handleTrigger — a mention holder never registers a trigger identity with
   *  dispatchTrigger's own dedup set, so there is nothing here for the replay
   *  to collide with. */
  #replayPendingForce(inflightKey: string | null, ticketId: string, role: string): void {
    if (!inflightKey) return;
    const { pendingForceRaw } = this.#inflightDispatch.onRelease(inflightKey);
    if (!pendingForceRaw) return;
    log(
      `[dispatch] replaying suppressed force_respawn after holder released: ` +
        `ticket=${ticketId.slice(0, 8)} role=${role || '_'}`,
    );
    let forcedRaw: string | null = null;
    try {
      forcedRaw = JSON.stringify({ ...JSON.parse(pendingForceRaw), force_respawn: true });
    } catch {
      forcedRaw = null;
    }
    if (forcedRaw) {
      // Fire-and-forget so we don't extend the caller's finally/onExit; the
      // replay re-enters handleTrigger cleanly (re-acquires the slot,
      // force-respawns fresh).
      this.handleTrigger(forcedRaw).catch((err: any) =>
        log(`[dispatch] force_respawn replay failed: ${err?.message ?? err}`),
      );
    }
  }

  async handleTrigger(
    raw: string,
    opts?: { onDispatched?: (pid: number | null) => void },
  ): Promise<void> {
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch (err: any) {
      log(`Failed to parse trigger: ${err?.message ?? err}`);
      return;
    }

    // Defensive filter: server recipient-scopes agent_trigger by
    // scope.agent_id. ST-6: when this manager owns the target agent, accept
    // the event and resolve a per-call execution context so the spawn lands
    // under the managed agent's identity (cwd / apiKey / mcp-config) rather
    // than the manager's defaults.
    const selfAgentId = loadAgentInfo()?.agent_id || '';
    const eventAgentId = ev.actor_name || ev.agent_id || '';
    let agentContext = this.#resolveAgentContext(eventAgentId);
    agentContext = await this.#scopeAgentContext(agentContext, ev.workspace_id);
    const envConfig = parseEnvironmentConfig(ev.environment_config);
    if (
      selfAgentId &&
      eventAgentId &&
      selfAgentId !== eventAgentId &&
      !agentContext
    ) {
      log(`Trigger dropped (not for this agent): target=${eventAgentId} self=${selfAgentId}`);
      this.#reportAgentContextMiss(
        'Trigger',
        this.#agentContextMissReason(eventAgentId),
        eventAgentId,
      );
      return;
    }

    // ── ticket 467f714a: harness session-limit defer gate ──
    // A prior session-limit exit (`You've hit your session limit · resets …`)
    // opened a per-agent defer window: until the reset instant every spawn hits the
    // SAME account session wall and dies, so the supervisor's force-respawn storm +
    // role-mention re-dispatch only burn doomed sessions and race twin provisioning
    // (exactly d34075b5's twin + duplicate-rebase-strand incident). While the window
    // is live we DON'T spawn — we coalesce each re-dispatch into a SINGLE pending
    // intent per (ticket, role, agent) and replay it exactly once at reset (see
    // SessionLimitDeferStore). An explicit operator `manual` trigger bypasses (escape
    // hatch, mirroring RoleSpawnSuppressor — a human who switched accounts / knows
    // better recovers immediately; if it re-hits the wall it just re-records the
    // window). Placed before the provisioning single-flight so a deferred trigger
    // never even reserves a slot.
    const deferAgentId = ev.actor_name || '';
    if (typeof ev.ticket_id === 'string' && ev.ticket_id && ev.trigger_source !== 'manual') {
      const defer = this.#sessionDefer.deferState(deferAgentId);
      if (defer.deferred) {
        const { created } = this.#sessionDefer.addPendingIntent(
          deferAgentId,
          { ticketId: ev.ticket_id, role: ev.action || '', agentId: deferAgentId },
          raw,
          { kind: 'trigger' },
        );
        log(
          `Trigger deferred — harness session limit: ticket=${ev.ticket_id.slice(0, 8)} ` +
            `role=${ev.action || '_'} agent=${deferAgentId.slice(0, 8) || '_'} ` +
            `source=${ev.trigger_source || '_'} until=${
              defer.deferUntilMs ? new Date(defer.deferUntilMs).toISOString() : '?'
            } (${created ? 'new pending intent' : 'coalesced'})`,
        );
        // One audit comment per newly-deferred ticket-role — the "audit-visible
        // defer 사유"; repeats of the same ticket-role coalesce silently.
        if (created) this.#postDeferAuditComment(ev.ticket_id, defer.resetLabel ?? '');
        return;
      }
    }

    // ticket feaa7ab0: suppress the supervisor re-dispatch storm. When this
    // ticket-role already aborted preflight for a durable blocker, a SUPERVISOR-
    // sourced re-trigger inside the cooldown window is dropped BEFORE we re-run
    // the (racy, git-heavy) provisioning — this is what actually stops the
    // repeated spawn/provision churn and the live-twin window. Human / state-
    // changed triggers (comment, manual, manager_restart, column_move) are not
    // `supervisor` sourced, so they always pass and let an operator recover
    // immediately after fixing the environment.
    const fromSupervisor = ev.trigger_source === 'supervisor';
    const suppression = this.#spawnSuppressor.shouldSuppress(ev.ticket_id, ev.action, {
      now: Date.now(),
      fromSupervisor,
    });
    if (suppression.suppress) {
      log(
        `Trigger suppressed — ticket-role in provisioning-failure backoff: ticket=${ev.ticket_id} role=${ev.action} blocker=${suppression.kind} aborts=${suppression.count} age=${Math.round((suppression.sinceMs ?? 0) / 1000)}s (supervisor re-dispatch dropped; fix env then comment/manual-trigger to recover)`,
      );
      return;
    }

    // ── ticket 3d180f85: provision-spanning single-flight gate ──
    // Reserve the (ticket, role, agent) key BEFORE the worktree provisioning in
    // #dispatchTriggerBody (the previously-unguarded window). A concurrent
    // same-key trigger — a supervisor re-send arriving while the first dispatch
    // is still provisioning/spawning — is suppressed here instead of double-
    // provisioning and twin-spawning past the spawn-window guards. The
    // reservation lives in the AUTHORITATIVE TicketSessionManager._inflight
    // registry (the same pid-checked map the spawn consults) when persistent
    // ticket sessions are on — the default and the config the twin incident was
    // observed under; a process-local fallback slot covers the persistent-off
    // (one-shot-only) config, whose spawn authority is findDuplicateSpawn.
    const dispatchAgentId = ev.actor_name || '';
    const inflightKey =
      typeof ev.ticket_id === 'string' && ev.ticket_id
        ? InflightDispatchTracker.key(ev.ticket_id, ev.action || '', dispatchAgentId)
        : null;
    // ticket 467f714a blocker #1: remember this proceeding trigger's raw keyed by
    // (ticket, role, agent). If its spawned session later dies of a harness session
    // limit, recordHarnessSessionLimit seeds this exact raw as the durable re-drive
    // intent — so the work resumes at reset even if NO further trigger arrives.
    // Reached only past the defer + suppression gates (a deferred/suppressed trigger
    // returned earlier), so we only remember triggers we actually act on.
    if (inflightKey) this.#rememberTriggerRaw(inflightKey, raw);
    const delegationCfg = (this.#config as any)?.delegation ?? {};
    const canAuthoritative =
      delegationCfg.enabled !== false &&
      delegationCfg.persistentTicketSessions !== false &&
      typeof this.#ticketSessionManager?.tryReserveDispatch === 'function';
    let reservation: DispatchReservation | null = null;
    if (inflightKey) {
      if (canAuthoritative) {
        reservation = this.#ticketSessionManager!.tryReserveDispatch!(
          ev.ticket_id,
          ev.action || '',
          dispatchAgentId,
        );
      } else {
        const acq = this.#inflightDispatch.tryAcquireFallback(inflightKey, {
          ticketId: ev.ticket_id,
          role: ev.action || '',
          agentId: dispatchAgentId,
        });
        // ticket 6de97a41 (fdf6714e 후속): acq.evicted를 버리지 않고 그대로 전파해야
        // 아래의 zombie reservation reclaimed 로그가 fallback 모드에서도 발화한다.
        reservation = { acquired: acq.acquired, live: false, nonce: acq.nonce, evicted: acq.evicted };
      }
      if (!reservation.acquired) {
        // A fresh spawn for this exact key is already provisioning/spawning →
        // this is the twin. Bump the reason metric, capture THIS suppressed
        // force event's own raw payload to replay (blocker #1 — replaying the
        // holder's identity instead would be deduped away), and post at most one
        // throttled note.
        const isForce = ev.force_respawn === true;
        const { surface } = this.#inflightDispatch.recordSuppression(
          'inflight_dispatch',
          inflightKey,
          { force: isForce, raw },
        );
        this.#ackDispatch(ev, 'suppressed', 'inflight_dispatch');
        log(
          `[dispatch] twin suppressed (inflight_dispatch): another dispatch is already ` +
            `provisioning/spawning ticket=${ev.ticket_id.slice(0, 8)} role=${ev.action || '_'} ` +
            `agent=${dispatchAgentId.slice(0, 8) || '_'} force_respawn=${isForce} ` +
            `(suppressed_total=${this.#inflightDispatch.suppressedCount()})`,
        );
        if (surface) {
          // Plain note (no @mention) → never re-triggers an agent. Throttled by
          // the tracker to one post per storm-burst so a supervisor re-send
          // flood doesn't spam the ticket.
          // ticket e341bcc2: metadata.dedupe_key 를 실으면, 새 hold-burst 의
          // post 가 티켓의 마지막 코멘트와 같은 키일 때 서버가 그 자리에서
          // repeat_count/last_repeated_at 만 bump 한다(새 row 아님). 상세 원인
          // (ticket id, reason)은 위 매니저 로그 줄에만 남기고 코멘트 본문에는
          // 넣지 않는다.
          // 리뷰 라운드2(ticket e341bcc2): 이 키는 표시용 로그가 아니라 정확히
          // 같은 (ticket, role, agent) 에만 합쳐야 하는 동작 키다 — 8자 축약은
          // 서로 다른 ticket/agent 가 같은 prefix 를 공유할 때 충돌해 남의
          // 억제 코멘트에 잘못 합쳐질 수 있으므로 전체 식별자를 그대로 쓴다.
          fireAndForgetTool(this.#config, 'add_comment', {
            ticket_id: ev.ticket_id,
            content:
              '⚠️ 중복 dispatch 억제 — 같은 (ticket, role) dispatch 가 이미 진행 중이라 ' +
              '새 트리거를 무시했습니다. force-respawn 이었다면 완료 직후 1회 재실행됩니다.',
            metadata: {
              dedupe_key: `dispatch_suppress:inflight:${ev.ticket_id}:${ev.action || '_'}:${dispatchAgentId || '_'}`,
              // ticket 3c8b8026: 이 알림 자체가 코멘트→트리거 경로를 다시 타
              // 새 trigger_emitted 를 낳고, 그 트리거가 또 억제되며 알림을 한
              // 번 더 남기는 자기증폭 루프였다(재현: hard-budget 30회를
              // 16분만에 소진, 그중 27%가 순수 이 알림의 자기메아리). 서버는
              // auto_notice:true 인 코멘트의 activity-log actor_id 를
              // 'system' 으로 남겨 trigger-loop 의 기존 system-actor 가드가
              // 그대로 걸러내게 한다 — dedupe_key 로 합쳐지지 않는(=티켓의
              // 마지막 코멘트가 아닌) 최초 알림 발생 건에도 적용된다.
              auto_notice: true,
            },
          });
        }
        return;
      }
      // 좀비 예약 강제 회수(safety valve / TTL): 진행 중인 dispatch 없이 예약만
      // 남아 연속 재시도를 막던 (ticket,role) 예약을 tryReserveDispatch 가
      // 원자적으로 회수하고 새 예약을 잡아 acquired:true 로 반환한 경우다. TTL
      // 만료(stale)는 조용히 재-dispatch 하고, safety valve(연속 억제 N회)는
      // 티켓에 경고를 남겨 운영자가 프로비저닝 hang / codex exit-1 근본원인을
      // 확인하도록 유도한다.
      if (reservation.evicted) {
        log(
          `[dispatch] zombie reservation reclaimed (${reservation.evicted}): ` +
            `재-dispatch 진행 ticket=${ev.ticket_id.slice(0, 8)} role=${ev.action || '_'} ` +
            `agent=${dispatchAgentId.slice(0, 8) || '_'}`,
        );
        if (reservation.evicted === 'safety_valve') {
          // ticket e341bcc2: 문구만 한 줄로 축약하고 합치기(dedupe_key) 대상에서는
          // 제외했다 — 드물게 발생하고, 발생할 때마다 운영자가 프로비저닝 hang /
          // codex exit-1 같은 서로 다른 근본원인을 매번 확인해야 하는 경보라
          // repeat_count 로 뭉개면 오히려 빈도·타이밍 정보가 죽는다.
          fireAndForgetTool(this.#config, 'add_comment', {
            ticket_id: ev.ticket_id,
            content:
              '⚠️ 디스패치 dedupe 강제 해제 (safety valve) — 좀비 예약을 회수하고 재-dispatch 했습니다. ' +
              '반복되면 매니저 로그에서 프로비저닝 hang / codex exit-1 원인을 확인하세요.',
            metadata: { auto_notice: true }, // ticket 3c8b8026 — 자기 재트리거 방지, #postDeferAuditComment 주석 참고
          });
        }
      }
    }
    // We placed a reservation to release only when live===false (a fresh spawn);
    // a live reuse placed nothing.
    const reservedFresh = !!reservation && reservation.acquired && !reservation.live;
    // ticket f0d1da19: replay a single suppressed force-respawn once this
    // dispatch's hold on `inflightKey` ends — shared between the finally below
    // and (via the seat's `onReleased` hook, ticket 77b28217) the spawned
    // process's onExit hook, so whichever of them ends up firing the release
    // runs this exactly once. Logic lives in #replayPendingForce (ticket
    // 3b8f24ec), shared with handleCommentMention's mentionSeat.
    const replayPendingForce = (): void =>
      this.#replayPendingForce(inflightKey, ev.ticket_id, ev.action || '');
    // ticket f0d1da19: handleCommentMention holds its claimed seat via
    // SubagentSpawnArgs.onExit for the one-shot's FULL lifetime (ticket
    // e90294e7 round 2) — but handleTrigger's OWN fallback/authoritative
    // reservation used to release unconditionally right here, the instant
    // #dispatchTriggerBody returned (i.e. moments after spawn() merely resolved
    // a pid, not when the spawned one-shot actually exits). A role-mention for
    // the identical (ticket, role, agent) seat arriving in that few-ms window
    // found the seat already free and twin-spawned a second one-shot racing the
    // first. `triggerSeat` is only set when this trigger placed a FRESH
    // reservation (`reservedFresh`); #dispatchTriggerBody flips `.transferred`
    // the instant its one-shot spawn succeeds, wiring the seat's `release`
    // (ticket 77b28217's `createDispatchSeat` — the same factory
    // handleCommentMention's mentionSeat now uses) into that process's onExit
    // hook — from then on this outer finally must not release out from under
    // the still-running one-shot. `promote` mirrors handleCommentMention's
    // round-3 pid attach for BOTH reservation kinds: without it, a seat held via
    // onExit for the one-shot's full (possibly many-minute) turn stays pid:null
    // in whichever registry backs it — TicketSessionManager._inflight
    // (authoritative) or InflightDispatchTracker (fallback, ticket fdf6714e's
    // pid-liveness escape hatch) — so its zombie recovery only ever sees a
    // provisioning-window TTL/safety-valve and can force-evict a perfectly
    // healthy one-shot out from under itself.
    const triggerSeat: DispatchSeat | null = reservedFresh
      ? createDispatchSeat({
          kind: canAuthoritative ? 'authoritative' : 'fallback',
          ticketId: ev.ticket_id,
          role: ev.action || '',
          agentId: dispatchAgentId,
          nonce: reservation!.nonce,
          tsm: this.#ticketSessionManager,
          inflightDispatch: this.#inflightDispatch,
          inflightKey,
          onReleased: replayPendingForce,
        })
      : null;
    // Release handle for THIS reservation, shared between the finally below
    // and (via the seat above) the spawned process's onExit hook: the seat's
    // release (core CAS release + the force-respawn replay) when a fresh
    // reservation exists, or just the replay when this dispatch instead
    // reused a live session (reservedFresh===false — nothing to CAS-release,
    // but a suppressed force under `inflightKey` from an earlier holder may
    // still be pending).
    const releaseTriggerReservation = (): void => {
      if (triggerSeat) {
        triggerSeat.release();
      } else {
        replayPendingForce();
      }
    };
    try {
      await this.#dispatchTriggerBody(
        ev,
        agentContext,
        envConfig,
        canAuthoritative && reservedFresh,
        raw,
        opts,
        triggerSeat,
      );
    } finally {
      if (inflightKey && !triggerSeat?.transferred) {
        releaseTriggerReservation();
      }
    }
  }

  /** Provision → spawn body of a ticket trigger (ticket 3d180f85), run under the
   *  single-flight reservation handleTrigger acquired. Split out so one
   *  try/finally in handleTrigger straddles the whole provisioning window —
   *  every `return` / `throw` in here releases the slot, UNLESS the one-shot
   *  spawn branch below claims `triggerSeat` (ticket f0d1da19 — see below).
   *  `dispatchReserved` is true when handleTrigger holds the authoritative
   *  `_inflight` reservation for this key, so the persistent dispatchTrigger
   *  below must defer `_inflight` ownership to the dispatcher. `triggerSeat` is
   *  handleTrigger's OWN reservation release handle, set only when it acquired
   *  a FRESH reservation; the one-shot spawn branch below (fallback mode, or a
   *  declined persistent dispatch falling back to one-shot) transfers ownership
   *  to the spawned process's `onExit` hook on success
   *  (`triggerSeat.transferred = true`) instead of letting handleTrigger's
   *  finally release the seat while the one-shot is still running — mirroring
   *  handleCommentMention's mentionSeat pattern (ticket e90294e7 round 2), INCLUDING
   *  its round-3 pid promotion (`triggerSeat.promote`, mirroring `attachDispatchPid` /
   *  ticket fdf6714e's fallback-tracker equivalent) for BOTH reservation kinds: a
   *  seat transferred to onExit without also being promoted stays pid:null for
   *  the one-shot's whole turn, so its backing registry's zombie recovery only
   *  ever sees a provisioning-window TTL/safety-valve instead of an OS-level
   *  liveness probe (ticket f0d1da19). A successful PERSISTENT dispatch (below)
   *  does NOT set `.transferred`: that session's liveness is tracked separately
   *  (`_getLiveSession`), so releasing `_inflight` the instant dispatch succeeds
   *  is correct as before. */
  async #dispatchTriggerBody(
    ev: any,
    agentContext: AgentExecutionContext | undefined,
    envConfig: ResolvedEnvironmentConfig | null,
    dispatchReserved: boolean,
    raw: string,
    opts?: { onDispatched?: (pid: number | null) => void },
    triggerSeat?: DispatchSeat | null,
  ): Promise<void> {
    // Stock pi intentionally has no MCP client. A ticket session therefore
    // cannot read its ticket or leave the add_comment / move_ticket audit trail
    // that advances AWB. Fail before worktree provisioning or process spawn so
    // this capability gap is visible and cannot degrade into the generic
    // "subagent exited without a comment" fallback. Chat dispatch is handled by
    // separate entry points and remains supported through stdout harvesting.
    if (agentContext?.cli === 'pi' && ev.ticket_id) {
      if (this.#dispatchBlockers.shouldComment(ev.ticket_id, PI_TICKET_DISPATCH_BLOCK_REASON)) {
        await fireAndForgetTool(this.#config, 'add_comment', {
          ticket_id: ev.ticket_id,
          content: PI_TICKET_DISPATCH_BLOCK_COMMENT,
          metadata: { auto_notice: true }, // ticket 3c8b8026 — 자기 재트리거 방지, #postDeferAuditComment 주석 참고
        });
      }
      await fireAndForgetTool(this.#config, 'pend_ticket', {
        ticket_id: ev.ticket_id,
        reason:
          'PI는 현재 MCP 미지원으로 티켓을 자율 진행할 수 없습니다. ' +
          'Claude/Codex 등 AWB MCP 지원 agent로 재배정한 뒤 Resume 하세요 (PI는 chat만 지원).',
      });
      log(
        `Trigger blocked before spawn — PI has no MCP ticket support: ticket=${ev.ticket_id} role=${ev.action}`,
      );
      this.#ackDispatch(ev, 'nack', PI_TICKET_DISPATCH_BLOCK_REASON);
      return;
    }

    // ticket 9f26f091: route this ticket into its own git worktree so a branch
    // switch here can't contaminate another ticket sharing the agent's
    // working_dir. worktree 규약 ②: the worktree lands under
    // `<working_dir>/.awb/wt/`, per_ticket|shared picked from the board mode the
    // server flattened onto the event. Both the persistent ticket-session and
    // one-shot subagent fallback below read agentContext.cwd, so one rewrite
    // covers both paths.
    const selectedRepo = resolveBootstrapRepository(ev.base_repo, ev.base_branch, envConfig);
    const repoCredential = selectedRepo?.resourceId && agentContext?.agent_id
      ? await fetchRepositoryCredential(this.#config, selectedRepo.resourceId, agentContext.agent_id, ev.workspace_id)
      : null;
    const worktreeMode = parseWorktreeMode(ev.worktree_mode);
    const applyWorktree = () => this.#applyWorktreeCwd(
      agentContext,
      ev.ticket_id,
      ev.action,
      worktreeMode,
      typeof ev.max_concurrent_tickets_per_agent === 'number'
        ? ev.max_concurrent_tickets_per_agent
        : undefined,
      selectedRepo ? { ...selectedRepo, credential: repoCredential } : null,
    );
    let worktreeProvision = await applyWorktree();

    // ── ticket d34075b5: shared warm-pool exhaustion fast-path ──────────────
    // A `pool_exhausted` fallback almost always means a LEAKED lease — a worker
    // that died uncleanly (exit-143) before releasing its slot — because the
    // server concurrency gate holds concurrent ticket sessions ≤ N == pool size,
    // so a legitimately-full pool is unreachable in normal single-board operation.
    // The legacy behavior aborted here and waited for the periodic reconcile PLUS a
    // lucky server re-push to recover — the invisible drop e7c87517 could only catch
    // 24h later. Instead:
    //   (1) record the exhaustion on the durable, server-visible heartbeat metric
    //       so an operator sees a leaking / starved pool without log access;
    //   (2) kick an ON-DEMAND lease reclaim immediately (accelerated
    //       reconciliation) — it reuses the SAME live-worker + /proc guards as the
    //       periodic pass, so it never false-reclaims a live worker;
    //   (3) if that freed a slot, retry provisioning INLINE so THIS dispatch
    //       recovers autonomously (no server re-push needed); and
    //   (4) if nothing was reclaimable (a lease still inside the 20-min reclaim
    //       grace, or a genuine transient cross-board contention), hand the trigger
    //       to the manager-owned bounded-backoff RETRY QUEUE and return. The queue
    //       re-drives the dispatch on a backoff AND the instant a slot frees (a
    //       ticket goes terminal, or a periodic/boot reconcile reclaims a leaked
    //       lease), so recovery no longer needs a lucky server re-push — the exact
    //       dependency this ticket removes (review follow-up). This REPLACES the
    //       legacy fall-through to the durable-blocker path (spawnSuppressor.note →
    //       pend-after-3): pool_exhausted is a TRANSIENT, self-healing blocker and
    //       must not be treated like a durable env blocker (bad credential /
    //       not-a-git-repo), which still pends via the path below.
    if (!worktreeProvision.ok && worktreeProvision.reason === 'pool_exhausted') {
      this.#dispatchBlockTracker.record(worktreeProvision.blockerKind || 'worktree:pool_exhausted');
      const reclaimed = this.#poolReclaimTrigger
        ? await this.#poolReclaimTrigger().catch((err: any) => {
            log(`[worktree] on-demand pool reclaim failed: ${err?.message ?? err}`);
            return 0;
          })
        : 0;
      log(
        `[worktree] pool_exhausted for ticket=${String(ev.ticket_id).slice(0, 8)} role=${ev.action} — ` +
          `on-demand reclaim freed ${reclaimed} orphaned lease(s)` +
          (reclaimed > 0 ? '; retrying provisioning inline' : ' (no reclaimable lease — within-grace or genuine contention; queuing retry)'),
      );
      if (reclaimed > 0) worktreeProvision = await applyWorktree();

      if (!worktreeProvision.ok && ev.ticket_id) {
        // Still exhausted after the on-demand reclaim → queue the manager-owned
        // bounded-backoff retry, keyed single-flight on (ticket, role, agent) so a
        // duplicate trigger just refreshes it (no twin). Post the pool-specific
        // comment only for a NEW episode (never the misleading "Git 체크아웃 실패"
        // copy). No pend on the first abort — the queue pends only if it gives up
        // after its attempt bound (genuine sustained contention → operator). Then
        // RETURN: do NOT fall into the durable-blocker path below.
        const meta = { ticketId: ev.ticket_id, role: ev.action || '', agentId: ev.actor_name || '' };
        const { created } = this.#poolRetry.register(meta, raw);
        if (created) {
          await fireAndForgetTool(this.#config, 'add_comment', {
            ticket_id: ev.ticket_id,
            content: POOL_EXHAUSTED_RETRY_COMMENT,
            metadata: { auto_notice: true }, // ticket 3c8b8026 — 자기 재트리거 방지, #postDeferAuditComment 주석 참고
          });
        }
        log(
          `[worktree] pool_exhausted — queued manager-owned retry ticket=${String(ev.ticket_id).slice(0, 8)} ` +
            `role=${ev.action} (new_episode=${created}, queued=${this.#poolRetry.size()})`,
        );
        return;
      }
    }

    if (!worktreeProvision.ok) {
      const blockerKind = worktreeProvision.blockerKind || `worktree:${worktreeProvision.reason || 'unknown'}`;
      // ticket d34075b5: durable server-visible signal — count every provisioning
      // block by kind for the instance-heartbeat metric. A `pool_exhausted` block
      // with a ticket_id is fully handled (recorded + queued + returned) in the
      // fast-path above, so this path is durable-blocker-only; the guard covers the
      // degenerate no-ticket_id pool_exhausted case (already counted above → don't
      // double-count).
      if (worktreeProvision.reason !== 'pool_exhausted') {
        this.#dispatchBlockTracker.record(blockerKind);
      }
      // Record the abort per (ticket,role) so the next supervisor re-trigger is
      // suppressed at the gate above — even when the comment below is de-duped.
      const provisionBlock = this.#spawnSuppressor.note(ev.ticket_id, ev.action, blockerKind, Date.now());
      if (ev.ticket_id && this.#dispatchBlockers.shouldComment(ev.ticket_id, blockerKind)) {
        const detailLine = worktreeProvision.detail ? `\n세부: \`${worktreeProvision.detail}\`` : '';
        // Managed, working_dir-relative (credential-free) checkout path that
        // failed verification — completion criterion #5 ("실패 경로").
        const pathLine = worktreeProvision.path ? `\n경로: \`${worktreeProvision.path}\`` : '';
        // Durable env blocker (empty/foreign checkout, not-a-git-repo, …). A
        // transient pool_exhausted never reaches here — it self-heals via the
        // retry queue above — so this copy is unambiguously about a broken checkout.
        const content =
          `⚠️ **티켓 worktree 준비 실패** — 유효한 Git 체크아웃을 확보하지 못해 에이전트를 실행하지 않고 디스패치를 중단했습니다.\n\n` +
          `원인: \`${worktreeProvision.reason || 'unknown error'}\`${detailLine}${pathLine}\n\n` +
          `repository resource, credential과 working_dir 아래 AWB 관리 폴더(\`.awb/base\`, \`.awb/wt\`)를 확인한 뒤 다시 트리거하세요.\n\n` +
          `_동일 오류로 인한 supervisor 자동 재트리거는 백오프로 억제됩니다 — 환경을 고친 뒤 코멘트/수동 트리거로 재개하세요._`;
        await fireAndForgetTool(this.#config, 'add_comment', {
          ticket_id: ev.ticket_id,
          content,
          metadata: { auto_notice: true }, // ticket 3c8b8026 — 자기 재트리거 방지, #postDeferAuditComment 주석 참고
        });
      }
      // ticket 52eedadf: the cooldown backoff above thins the supervisor storm
      // but never STOPS it — a durable blocker keeps getting one probe per window
      // forever, and each probe is a fresh live-twin window. A pre-spawn
      // provisioning abort never reaches an exit handler, so it never fed the
      // circuit-breaker that would otherwise pend (the hole that looped ticket
      // c47194d9 for ~6h). So pend the ticket the moment the block is confirmed
      // durable: a DURABLE blocker (empty/foreign checkout, missing push
      // credential — isDurableProvisioningBlocker) pends on the FIRST abort so the
      // supervisor stops AT ONCE (`provisioning failure → 반복 trigger 없음`); a
      // transient/ambiguous one (path_conflict, resource unavailable) pends only
      // after it re-aborts DEFAULT_PEND_AFTER_ABORTS times, keeping a cooldown
      // self-heal window. Once pended, getAllocatedTickets skips it and the
      // supervisor stops re-emitting BOTH normal and forced triggers, so no strand
      // can spawn until an operator unpends (explicit retry) or a post-unpend green
      // preflight (reprovision success) clears the suppressor below. `shouldPend`
      // is true on exactly ONE abort per episode, so we pend once — no duplicate
      // pended-audit rows — and rely on the server pending gate (not repeated
      // pends) to hold.
      if (ev.ticket_id && provisionBlock.shouldPend) {
        await fireAndForgetTool(this.#config, 'pend_ticket', {
          ticket_id: ev.ticket_id,
          reason: provisioningPendReason({
            kind: blockerKind,
            reason: worktreeProvision.reason,
            detail: worktreeProvision.detail,
            count: provisionBlock.count,
          }),
        });
        log(
          `[worktree] durable provisioning block — pended ticket=${ev.ticket_id} role=${ev.action} blocker=${blockerKind} aborts=${provisionBlock.count}`,
        );
      }
      log(
        `Trigger aborted — ticket worktree verification failed: ticket=${ev.ticket_id} role=${ev.action} reason=${worktreeProvision.reason || 'unknown'} blocker=${blockerKind}${worktreeProvision.path ? ` path=${worktreeProvision.path}` : ''}`,
      );
      // Durable dispatch nack (ticket e7c87517): tell the server the spawn was
      // aborted so its reconciler re-dispatches once the worktree blocker
      // (pool_exhausted / missing repo / …) clears, instead of the trigger
      // silently evaporating — the exact 30603ce6 pool_exhausted incident.
      this.#ackDispatch(ev, 'nack', blockerKind);
      return;
    }

    // Board/workspace harness resolved server-side and flattened onto the
    // event (e9c7a896). Parsed here (ahead of its original single use-site
    // below) so the ticket 48aeab6e CLI-readiness gate immediately below can
    // also read harness.permission_mode.
    const harness = parseHarnessConfig(ev.harness_config);

    // ticket 48aeab6e: CLI workspace-trust / provider-auth readiness. Unlike
    // the push-credential gate below (assignee-only — only that role pushes),
    // this applies to EVERY role: any role's CLI spawn can hit an unapproved
    // workspace trust dialog or an expired, unrenewable OAuth session, and
    // both fail the CLI process itself before it does anything useful.
    // Catching it here (before spawn) saves the session/turn a doomed spawn
    // would burn and gives the operator ONE actionable comment instead of a
    // repeating "agent exited immediately" mystery (the incident that
    // motivated this ticket: a planner dispatch failed repeatedly on
    // checkout trust + an expired OAuth session while the assignee sat idle
    // across multiple supervisor cycles).
    //
    // ticket 73772059: hermes 는 이 게이트에서 제외한다. createAdapter('hermes')
    // 는 무조건 RuntimeSelectionError('runtime_unavailable') 를 던진다 — Hermes
    // 는 파일 기반 CLI trust dialog/credential 파일을 조회할 개념 자체가 없는
    // ACP 런타임이라 이 게이트의 전제가 애초에 성립하지 않는다. 이 가드가
    // 없으면 cli_home_dir 가 cli 타입과 무관하게 모든 agent 에 대해 채워져
    // 있어서(agent-manager-commands.ts 참고) hermes-cli role 디스패치가 항상 이
    // 블록에 진입했고, 잡히지 않은 throw 가 #ackDispatch 실행 전에
    // #dispatchTriggerBody 를 크래시시켰다(ack 자체가 없음 — 'processed'도
    // 'nack'도 아님). Hermes 는 자체 readiness 개념(RuntimeSupervisor/ACP
    // 세션의 runtime_config.permission_mode)을 따로 갖고 있으며, 아래 Hermes
    // 분기에서 별도로 처리된다.
    if (ev.ticket_id && agentContext?.cwd && agentContext?.cli_home_dir && agentContext?.cli !== 'hermes') {
      const adapter = createAdapter(agentContext.cli);
      const trustRequired = adapter.requiresWorkspaceTrust(harness);
      // ticket 152e3606 리뷰 반영: bypassPermissions(harness 미설정 또는
      // 명시적 bypassPermissions — trustRequired=false)일 때만 워크스페이스
      // trust를 미리 시딩한다. 이 디스패치 자체엔 trust가 무관하지만(스킵
      // 플래그가 이미 대화상자를 우회한다), 같은 폴더가 나중에 non-bypass
      // harness로 재사용되거나 Action/QA run이 같은 cwd를 재사용할 때를
      // 대비해 미리 해 둔다. 반대로 trustRequired=true(운영자가 명시적으로
      // bypassPermissions 아닌 permission_mode를 설정한 경우)에는 절대
      // 시딩하지 않는다 — ticket 48aeab6e가 설계한 "사람이 trust를 직접
      // 확인해야 한다"는 계약을 그대로 지킨다
      // (cli-readiness-block-pend.test.mjs의 "pends on the first abort"
      // 케이스가 이 계약을 고정해둔다).
      //
      // await하지 않고 fire-and-forget으로 던진다 — await를 걸면 이 핫
      // 디스패치 경로에 새 async yield point가 생겨 동시 트리거 처리
      // 순서를 흔든다(실측: dispatch-inflight-guard.test.mjs의 "두 동시
      // force-respawn → 정확히 1회만 재실행" 테스트가 await 버전에서
      // 깨졌다). 이 디스패치의 진행 여부가 시딩 완료를 기다릴 필요가
      // 없으므로(현재 스폰엔 trust가 무관) 안전하다.
      if (!trustRequired) {
        void adapter.ensureWorkspaceTrust(agentContext.cli_home_dir, agentContext.cwd).catch((err: any) => {
          log(
            `[cli-trust] background ensureWorkspaceTrust failed: ticket=${ev.ticket_id} cli=${agentContext.cli} ` +
              `cwd=${agentContext.cwd}: ${String(err?.message ?? err)}`,
          );
        });
      }
      const trustMeta = trustRequired
        ? await adapter.readTrustMeta(agentContext.cli_home_dir, agentContext.cwd)
        : null;
      let readiness = decideCliTrustReadiness({ required: trustRequired, probe: trustMeta });
      if (readiness.ok) {
        const credentialMeta = await adapter.readCredentialMeta(agentContext.cli_home_dir);
        readiness = decideCliAuthReadiness({ probe: credentialMeta, now: Date.now() });
      }
      if (!readiness.ok) {
        const blockerKind = readiness.reason || 'cli_readiness_unavailable';
        this.#dispatchBlockTracker.record(blockerKind);
        // Same durable-blocker de-dup + escalation as the worktree/push
        // gates: record the abort so the next supervisor re-trigger for this
        // ticket-role is suppressed, then pend on the episode's FIRST abort
        // (both reasons are in DURABLE_BLOCKER_REASONS — never self-heal).
        const provisionBlock = this.#spawnSuppressor.note(ev.ticket_id, ev.action, blockerKind, Date.now());
        if (this.#dispatchBlockers.shouldComment(ev.ticket_id, blockerKind)) {
          const isTrust = blockerKind === 'cli_trust_required';
          const content = isTrust
            ? `⚠️ **CLI workspace trust 미승인** — 이 CLI(\`${agentContext.cli}\`)의 workspace trust 승인이 확인되지 않아 에이전트를 실행하지 않고 디스패치를 중단했습니다.\n\n` +
              `세부: \`${readiness.detail || ''}\`\n\n` +
              `이 보드/워크스페이스 harness의 \`permission_mode\`를 \`bypassPermissions\`로 되돌리거나, ` +
              `\`${agentContext.cli_home_dir}/.claude.json\`의 \`projects["${agentContext.cwd}"].hasTrustDialogAccepted\`를 \`true\`로 설정한 뒤 다시 트리거하세요.\n\n` +
              `_동일 오류로 인한 supervisor 자동 재트리거는 억제됩니다 — trust를 수정한 뒤 티켓을 unpend(User 탭의 ▶ Resume) 하세요._`
            : `⚠️ **CLI 인증 만료** — 이 CLI(\`${agentContext.cli}\`)의 OAuth 세션이 만료되었고 자동 갱신할 refresh token도 없어 에이전트를 실행하지 않고 디스패치를 중단했습니다.\n\n` +
              `세부: \`${readiness.detail || ''}\`\n\n` +
              `해당 agent의 CLI 자격 증명을 재발급/재로그인한 뒤 다시 트리거하세요.\n\n` +
              `_동일 오류로 인한 supervisor 자동 재트리거는 억제됩니다 — 자격 증명을 고친 뒤 unpend 하세요._`;
          await fireAndForgetTool(this.#config, 'add_comment', {
            ticket_id: ev.ticket_id,
            content,
            metadata: { auto_notice: true }, // ticket 3c8b8026 — 자기 재트리거 방지, #postDeferAuditComment 주석 참고
          });
        }
        if (provisionBlock.shouldPend) {
          await fireAndForgetTool(this.#config, 'pend_ticket', {
            ticket_id: ev.ticket_id,
            reason: provisioningPendReason({
              kind: blockerKind,
              reason: readiness.reason,
              detail: readiness.detail,
              count: provisionBlock.count,
            }),
          });
          log(
            `[cli-readiness] durable provisioning block — pended ticket=${ev.ticket_id} role=${ev.action} blocker=${blockerKind} aborts=${provisionBlock.count}`,
          );
        }
        log(
          `Trigger aborted — CLI readiness check failed: ticket=${ev.ticket_id} role=${ev.action} reason=${blockerKind} cli=${agentContext.cli}`,
        );
        this.#ackDispatch(ev, 'nack', blockerKind);
        return;
      }
    }

    // ticket a3047a86: push-credential readiness. A repo with no usable
    // credential fails `git push` with `could not read Username for
    // 'https://github.com'` — after the agent already did all the work (this
    // stalled ticket 8436f96f's Merging twice). Scoped to the assignee role,
    // the only role that pushes (feature branch at In Progress, main at
    // Merging); reviewer/planner never push, so gating them would wedge review.
    // The assignee's In Progress push means this catches the failure at the
    // latest before Merging (usually earlier). verifyPushReadiness fails open
    // on anything but a confirmed auth rejection.
    if (
      ev.action === 'assignee'
      && ev.ticket_id && selectedRepo?.url && this.#worktreeManager && agentContext?.cwd
    ) {
      const readiness = await this.#worktreeManager.verifyPushReadiness(agentContext.cwd, selectedRepo.url);
      if (!readiness.ok) {
        const blockerKind = readiness.reason || 'push_credential_unavailable';
        // ticket d34075b5: durable server-visible signal — count the push-credential
        // block for the instance-heartbeat metric (mirrors the worktree path).
        this.#dispatchBlockTracker.record(blockerKind);
        // Same durable-blocker backoff as the worktree path: record so the next
        // supervisor re-trigger for this ticket-role is dropped at the gate.
        const provisionBlock = this.#spawnSuppressor.note(ev.ticket_id, ev.action, blockerKind, Date.now());
        if (this.#dispatchBlockers.shouldComment(ev.ticket_id, blockerKind)) {
          await fireAndForgetTool(this.#config, 'add_comment', {
            ticket_id: ev.ticket_id,
            content:
              `⚠️ **Git push 자격 증명 미확인** — 원격 인증이 준비되지 않아 작업을 시작하지 않고 디스패치를 중단했습니다.\n\n` +
              `원격: \`${selectedRepo.url}\`\n` +
              `원인: \`${readiness.detail || 'push credential unavailable'}\`\n\n` +
              `이 repository resource 에 GitHub 자격 증명(토큰)을 설정하거나 push 가능한 환경으로 전환한 뒤 다시 트리거하세요. ` +
              `(Merging 단계의 push 실패로 CLI 세션을 낭비하지 않도록 dispatch 전에 검증합니다.)`,
            metadata: { auto_notice: true }, // ticket 3c8b8026 — 자기 재트리거 방지, #postDeferAuditComment 주석 참고
          });
        }
        // ticket 52eedadf: a missing push credential is likewise durable (an
        // operator must add it) — escalate the same way as the worktree path so
        // the supervisor stops re-triggering once the episode is confirmed durable.
        if (provisionBlock.shouldPend) {
          await fireAndForgetTool(this.#config, 'pend_ticket', {
            ticket_id: ev.ticket_id,
            reason: provisioningPendReason({
              kind: blockerKind,
              reason: readiness.reason,
              detail: readiness.detail,
              count: provisionBlock.count,
            }),
          });
          log(
            `[push-credential] durable provisioning block — pended ticket=${ev.ticket_id} role=${ev.action} blocker=${blockerKind} aborts=${provisionBlock.count}`,
          );
        }
        log(
          `Trigger aborted — push credential unavailable: ticket=${ev.ticket_id} detail=${readiness.detail || ''}`,
        );
        // Durable dispatch nack (ticket e7c87517) — same recovery as the
        // worktree abort above: the server reconciler re-dispatches once a
        // usable push credential is attached.
        this.#ackDispatch(ev, 'nack', blockerKind);
        return;
      }
    }

    // Preflight fully green (worktree + push credential): clear any recorded
    // blocker so a later failure after recovery posts fresh and retries run, and
    // re-arm the ticket-role spawn suppressor so a future break backs off afresh.
    if (ev.ticket_id) {
      this.#dispatchBlockers.clear(ev.ticket_id);
      this.#spawnSuppressor.clear(ev.ticket_id, ev.action);
      // ticket d34075b5: the pool recovered for this (ticket, role, agent) — drop
      // any queued pool_exhausted retry. Covers all recovery routes: inline (reclaim
      // >0), a retry attempt that succeeded, and a server re-push that happened to
      // land after the pool freed on its own. A no-op when nothing was queued.
      this.#poolRetry.resolve({ ticketId: ev.ticket_id, role: ev.action || '', agentId: ev.actor_name || '' });
    }

    // worktree 규약 ④: name the ACTUAL work folder in the trigger prompt. The
    // server bakes a `{{AWB_WORK_FOLDER}}` placeholder into every non-merging
    // column workflow guide and ships only the working_dir-RELATIVE path
    // (ev.worktree_rel_path) — it never knows the absolute working_dir. We fill
    // the token with the concrete spawn cwd #applyWorktreeCwd just resolved
    // (agentContext.cwd == the real worktree/base dir the child runs in),
    // falling back to the relative path only when no cwd is resolvable. Gated on
    // ev.worktree_rel_path so a pre-④ server (field absent) leaves the prompt
    // byte-identical. Rewriting ev.column_prompt.content ONCE here covers all
    // three downstream compose sites — one-shot subagent, persistent first turn,
    // and follow-up turn — which each read ev.column_prompt.
    if (ev.worktree_rel_path && ev.column_prompt && typeof ev.column_prompt.content === 'string') {
      const workFolder = agentContext?.cwd || ev.worktree_rel_path;
      ev.column_prompt = {
        ...ev.column_prompt,
        content: injectWorkFolder(ev.column_prompt.content, workFolder),
      };
    }

    // harness was already parsed above (ahead of the ticket 48aeab6e
    // CLI-readiness gate); both the persistent-session and one-shot paths
    // below ship it to their spawn site.
    //
    // 티켓 0fbe802c: 우선순위는 resolveTriggerRuntimeProfile 참고 — per-agent
    // cli_runtime_profile > 인스턴스 --runtime-profile 오버라이드 > null.
    const runtimeProfile = resolveTriggerRuntimeProfile(ev.cli_runtime_profile, this.#runtimeProfileOverride);
    if (harness) {
      log(
        `Trigger carries harness_config: ticket=${ev.ticket_id} keys=${Object.keys(harness).join(',')}`,
      );
    }

    // Ticket-level abstract effort preset (separate channel from harness). The
    // server resolves the matched preset and flattens it onto the event as
    // `effort_preset`; both spawn paths below pick the per-CLI slice at their
    // spawn site (claude → --effort + ultracode keyword; codex/antigravity →
    // model-only).
    const effortPreset = parseEffortPreset(ev.effort_preset);
    if (effortPreset) {
      log(
        `Trigger carries effort_preset: id=${effortPreset.id}${effortPreset.label ? ` (${effortPreset.label})` : ''} ticket=${ev.ticket_id}`,
      );
    }

    // Board environment variables are process-only. Repository checkout is
    // exclusively owned by WT/QA provisioning and never happens here.
    //
    // Also expose the manager-resolved folder contract to child processes.
    // Prompts alone are not a reliable machine-readable boundary: project build
    // scripts can otherwise create a second `_compilecheck_*` worktree and throw
    // away the shared slot's warm Unity Library. Reserved AWB_* keys are layered
    // last so a board env cannot spoof the actual provisioned cwd/mode.
    const envVars = buildDispatchEnvVars(
      envConfig?.env_vars,
      agentContext?.cwd,
      worktreeMode,
      ev.ticket_id,
    );
    // 티켓 41e69c91: per_ticket(보드 기본값)에는 지금까지 폴더 경계 정책이
    // 전혀 전달되지 않았다 — prompts.ts 호출은 'shared'에만 있었다. 두 모드
    // 모두 worktreeInstructionsFor를 거치게 해서, leaf 문구 함수뿐 아니라
    // 모드 선택 로직 자체도 테스트로 검증되게 한다.
    const worktreeInstructions = worktreeInstructionsFor(worktreeMode, agentContext?.cwd || '');

    // Hermes is an ACP runtime owned by RuntimeSupervisor. Once selected it
    // never crosses into the CLI session/subagent fallback paths.
    if (agentContext?.cli === 'hermes') {
      try {
        const ticket = await fetchTicketContext(this.#config, ev.ticket_id);
        if (ticket) {
          ticket.current_column_id = ev.current_column_id || ticket.current_column_id || '';
          ticket.current_column_name = ev.current_column_name || ticket.current_column_name || '';
          ticket.current_column_kind = ev.current_column_kind || ticket.current_column_kind || '';
        }
        if (ticket && selectedRepo) {
          ticket.base_repo = {
            id: selectedRepo.resourceId,
            name: '',
            url: selectedRepo.url,
            default_branch: selectedRepo.branch,
          };
          ticket.base_branch = selectedRepo.branch;
        }
        const rolePrompt = ev.role_prompt || '';
        const taskText =
          this.#prompts?.composeTriggerPrompt(
            ticket,
            rolePrompt,
            ev.ticket_prompt || '',
            ev.ticket_id,
            ev.column_prompt || null,
          ) ?? `[trigger] ${ev.ticket_id}`;
        const result = await this.#dispatchHermes({
          agentContext,
          runId: `ticket:${ev.ticket_id}:${ev.action || '_'}`,
          leaseId: String(ev.worktree_lease_id || `cwd:${agentContext.cwd}`),
          systemContext: [
            rolePrompt,
            harness?.system_prompt_append || '',
            `Trigger source: ${ev.trigger_source || 'unknown'}`,
          ].filter(Boolean).join('\n\n'),
          task: taskText,
          skillSnapshot: ev.skill_snapshot ?? null,
        });
        log(
          `Trigger dispatched through Hermes ACP: ticket=${ev.ticket_id} ` +
          `session=${result.sessionId} stop=${result.stopReason}`,
        );
        // ticket 38fba2d3: dispatch() resolving without throwing isn't proof the
        // trigger was actually handled — mirrors e8105c84's #reportHermesMentionOutcome
        // stopReason check on the comment-mention path. This call site has no chat
        // room or comment channel to signal into (a column trigger, not a chat/mention),
        // so a non-end_turn stop folds into the #ackDispatch('nack', ...) channel this
        // function already uses for every other pre-spawn failure — dispatch-intent.service.ts
        // treats 'nack' as retryable (bounded backoff), so this self-heals instead of
        // acking 'processed' with no signal anywhere.
        if (result.stopReason !== 'end_turn') {
          await this.#reportHermesDispatchFailure(
            'Hermes trigger dispatch',
            undefined,
            undefined,
            result.stopReason,
            `session ${result.sessionId} ended without confirming delivery (stop=${result.stopReason}) ticket=${ev.ticket_id} role=${ev.action}`,
          );
          this.#ackDispatch(ev, 'nack', result.stopReason);
        } else {
          spawnFailureTracker.recordSuccess('hermes');
          this.#ackDispatch(ev, 'processed');
        }
      } catch (err: any) {
        log(`Hermes trigger dispatch failed closed: ${err?.code || ''} ${err?.message ?? err}`);
        this.#ackDispatch(ev, 'nack', err?.code || 'runtime_protocol_error');
      }
      return;
    }

    const delegation = (this.#config as any)?.delegation ?? {};
    const delegationEnabled = delegation.enabled !== false;
    const persistentTicket = delegation.persistentTicketSessions !== false;

    // ticket 970d6692 (review round 2): true once dispatchTrigger below has
    // run its OWN CircuitBreaker.shouldBlock() check for this (agent, ticket,
    // role) and NOT declined with `circuit_breaker_open` (that reason returns
    // immediately, never reaching the one-shot fallback at all) — so by the
    // time control reaches the fallback spawn() below, the breaker has
    // already cleared this exact logical attempt. Passed through so spawn()
    // trusts that verdict instead of calling shouldBlock() again, which would
    // consume the just-granted half-open probe's cooldown stamp a second time
    // and re-block the attempt it was meant to allow (the original bug).
    let circuitBreakerClearedByDispatchTrigger = false;
    // ticket 970d6692 (review round 3): the try block below also awaits
    // fetchTicketContext() and mutates the fetched ticket BEFORE calling
    // dispatchTrigger() — either of those failing must not be mistaken for
    // "dispatchTrigger's gate already ran". This flips true only immediately
    // before the dispatchTrigger() call itself, so the catch below can tell
    // a pre-dispatch failure apart from a failure inside/after the gate.
    let dispatchTriggerInvoked = false;

    if (delegationEnabled && persistentTicket && this.#ticketSessionManager) {
      try {
        const ticket = await fetchTicketContext(this.#config, ev.ticket_id);
        if (ticket) {
          ticket.current_column_id = ev.current_column_id || ticket.current_column_id || '';
          ticket.current_column_name = ev.current_column_name || ticket.current_column_name || '';
          ticket.current_column_kind = ev.current_column_kind || ticket.current_column_kind || '';
        }
        if (ticket && selectedRepo) {
          ticket.base_repo = { id: selectedRepo.resourceId, name: '', url: selectedRepo.url, default_branch: selectedRepo.branch };
          ticket.base_branch = selectedRepo.branch;
        }
        const rolePrompt = ev.role_prompt || '';
        const ticketPrompt = ev.ticket_prompt || '';
        const columnPrompt = ev.column_prompt || null;

        dispatchTriggerInvoked = true;
        const result = await this.#ticketSessionManager.dispatchTrigger({
          ticketId: ev.ticket_id || '',
          role: ev.action || '',
          triggerId: ev.field_changed || '',
          agentId: ev.actor_name || '',
          rolePrompt,
          ticketPrompt,
          columnPrompt,
          ticket,
          forceRespawn: ev.force_respawn === true,
          // ticket 3d180f85: handleTrigger holds the authoritative _inflight
          // reservation for this key across the whole provision→spawn window;
          // tell dispatchTrigger to defer _inflight ownership so it neither
          // self-drops on its own reservation nor releases it early.
          dispatchReserved,
          triggerSource: ev.trigger_source || '',
          agentContext,
          harness,
          runtimeProfile,
          effortPreset,
          envVars,
          worktreeInstructions,
          maxConcurrentTicketsPerAgent:
            typeof ev.max_concurrent_tickets_per_agent === 'number'
              ? ev.max_concurrent_tickets_per_agent
              : undefined,
        });

        if (result.dispatched) {
          log(
            `Trigger dispatched to ticket session: ticket=${ev.ticket_id} pid=${result.pid}${result.firstTurn ? ' (new session)' : ''}`,
          );
          // ticket 467f714a blocker #3: report the spawned pid the instant it
          // exists so a session-defer replay records it durably — a crash before
          // the outbox ack then leaves a reapable survivor handle on disk.
          opts?.onDispatched?.(typeof result.pid === 'number' ? result.pid : null);
          // Durable dispatch ack (ticket e7c87517): spawn STARTED — extends the
          // reconciler's retry grace. NOT resolution: only real forward progress
          // closes the intent, so a strand that dies silently still gets
          // re-dispatched after the grace elapses.
          this.#ackDispatch(ev, 'processed');
          return;
        }
        if (result.reason === 'duplicate_trigger') {
          log(`Trigger deduped: ticket=${ev.ticket_id} trigger=${ev.field_changed || ''}`);
          return;
        }
        if (result.reason === 'circuit_breaker_open') {
          log(`Trigger blocked by circuit-breaker: ticket=${ev.ticket_id} — not falling back to one-shot`);
          return;
        }
        // Reaching here means dispatchTrigger's own circuit-breaker gate did
        // NOT decline — see the comment on the declaration above.
        circuitBreakerClearedByDispatchTrigger = true;
        log(
          `Ticket session dispatch declined (${result.reason}), falling back to one-shot subagent`,
        );
      } catch (err: any) {
        // Only trust the gate if dispatchTrigger() was actually called: its
        // circuit-breaker check runs first and synchronously (no await)
        // before anything fallible inside dispatchTrigger, so once the call
        // has started, the check has definitely run. But fetchTicketContext()
        // and the ticket mutation above run BEFORE that call — a failure
        // there means dispatchTrigger, and its gate, never ran at all, so the
        // one-shot fallback below must re-query the breaker itself.
        circuitBreakerClearedByDispatchTrigger = dispatchTriggerInvoked;
        log(
          `Ticket session path failed: ${err?.message ?? err}, falling back to one-shot subagent`,
        );
      }
    }

    const canDelegate =
      delegationEnabled && this.#subagentManager && this.#subagentManager.canSpawn();

    if (canDelegate && this.#subagentManager) {
      try {
        const ticket = await fetchTicketContext(this.#config, ev.ticket_id);
        if (ticket && selectedRepo) {
          ticket.base_repo = { id: selectedRepo.resourceId, name: '', url: selectedRepo.url, default_branch: selectedRepo.branch };
          ticket.base_branch = selectedRepo.branch;
        }
        const rolePrompt = ev.role_prompt || '';
        const ticketPrompt = ev.ticket_prompt || '';
        const columnPrompt = ev.column_prompt || null;
        const taskText =
          this.#prompts?.composeTriggerPrompt(
            ticket,
            rolePrompt,
            ticketPrompt,
            ev.ticket_id,
            columnPrompt,
            worktreeInstructions,
          ) ?? `[trigger] ${ev.ticket_id}`;

        const result = await this.#subagentManager.spawn({
          kind: 'trigger',
          taskText,
          rolePrompt,
          triggerId: ev.field_changed || '',
          ticketId: ev.ticket_id || '',
          agentId: ev.actor_name || '',
          // Persistent ticket sessions already pin (ticket_id, role) on
          // their per-session mcp-config; mirror it on the one-shot fallback
          // so a subagent spawned through this path attributes its comments
          // to the triggering role instead of every role the agent holds.
          role: ev.action || '',
          triggerSource: ev.trigger_source || '',
          agentContext,
          harness,
          runtimeProfile,
          effortPreset,
          envVars,
          // ticket 970d6692: reuse dispatchTrigger's own circuit-breaker
          // verdict for this SAME attempt instead of letting spawn() query
          // shouldBlock() a second time — see the flag's declaration above.
          circuitBreakerDecision: circuitBreakerClearedByDispatchTrigger ? null : undefined,
          ttlMinutes: worktreeProvision.coldSharedWorktree
            ? SHARED_WORKTREE_COLD_IMPORT_TTL_MINUTES
            : undefined,
          // ticket f0d1da19: hold handleTrigger's OWN reservation (if any) for
          // this one-shot's FULL lifetime, not just until spawn() resolves a
          // pid — mirrors handleCommentMention's mentionSeat/onExit (ticket
          // e90294e7 round 2). Without this, a role-mention for the identical
          // seat arriving moments after this spawn() call resolves finds the
          // seat already free and twin-spawns a second one-shot racing this one.
          // A fallback-mode seat held this way is promoted with a pid below
          // (`triggerSeat.promote`) the same as an authoritative one — ticket
          // fdf6714e's InflightDispatchTracker.attachDispatchPid gives it the
          // same OS-level liveness escape hatch, so it isn't purely age-based
          // either (both kinds still ultimately release via `triggerSeat.release`
          // above on process exit, not on a timer).
          onExit: triggerSeat ? () => triggerSeat.release() : undefined,
        });

        if (result.spawned) {
          // ticket f0d1da19: ownership of the reservation (if any) now belongs
          // to the spawned process's onExit hook above — set `.transferred`
          // (and promote it to a pid-verified reservation, mirroring
          // handleCommentMention's round-3 attachDispatchPid, for whichever
          // registry backs this seat) BEFORE any callback below that could
          // throw. If `opts.onDispatched` threw with `.transferred` still
          // false, handleTrigger's outer `finally` would release the seat out
          // from under the still-running one-shot — reopening the exact twin
          // window this ticket closes — and a seat left un-promoted stays
          // pid:null for the one-shot's whole turn, subject to the
          // provisioning-window TTL/safety-valve instead of real OS-level
          // liveness.
          if (triggerSeat) {
            triggerSeat.transferred = true;
            if (typeof result.pid === 'number') triggerSeat.promote(result.pid);
          }
          log(`Trigger dispatched to subagent: ticket=${ev.ticket_id} pid=${result.pid}${agentContext ? ` agent=${agentContext.agent_id.slice(0, 8)}` : ''}`);
          // ticket 467f714a blocker #3: report the one-shot pid so a session-defer
          // replay records a durable, reapable survivor handle (crash-after-spawn).
          opts?.onDispatched?.(typeof result.pid === 'number' ? result.pid : null);
          // Durable dispatch ack (ticket e7c87517): one-shot subagent spawned →
          // processed (grace extension, not resolution).
          this.#ackDispatch(ev, 'processed');
          return;
        }
        if (result.reason === 'invalid_mcp_transport') {
          // ticket da4358ee: the CLI (codex) refused to launch because its own
          // config's mcp_servers.<name> has no resolvable transport (pre-spawn
          // validation, ticket 40d18474 — InvalidMcpTransportError). That is a
          // deterministic config error that reproduces IDENTICALLY on every
          // retry, so it gets the SAME durable-blocker treatment as a broken
          // worktree / missing push credential / unapproved CLI trust above:
          // comment once, pend on the FIRST abort (never wait out the cooldown
          // threshold), and nack so the server's dispatch outbox stops treating
          // it as owed — instead of retry-storming (the exact ~2-day,
          // 196-redispatch incident this ticket reports).
          const blockerKind = 'invalid_mcp_transport';
          this.#dispatchBlockTracker.record(blockerKind);
          const provisionBlock = this.#spawnSuppressor.note(ev.ticket_id, ev.action, blockerKind, Date.now());
          if (this.#dispatchBlockers.shouldComment(ev.ticket_id, blockerKind)) {
            // ticket da4358ee review round 2: the offending key is NOT always
            // `awb` — validateCodexMcpServers() reports on every `mcp_servers.<name>`
            // table, so a broken `mcp_servers.github` must name `github`, not a
            // hardcoded `awb`. result.serverKey carries the exact name from
            // InvalidMcpTransportError; strip backticks/newlines before splicing
            // it into a backtick-quoted span so a pathological key can't break
            // out of the code span or inject extra markdown.
            const safeServerKey = String(result.serverKey || 'awb')
              .replace(/[`\r\n]/g, '')
              .slice(0, 200);
            const mcpServerPath = `mcp_servers.${safeServerKey}`;
            await fireAndForgetTool(this.#config, 'add_comment', {
              ticket_id: ev.ticket_id,
              content:
                `⚠️ **MCP transport 설정 오류** — 이 CLI(\`${agentContext?.cli ?? 'codex'}\`)가 \`${mcpServerPath}\` 설정에서 해석 가능한 transport(\`url\` 또는 \`command\`)를 찾지 못해 에이전트를 실행하지 않고 디스패치를 중단했습니다.\n\n` +
                `마지막 오류: \`${result.detail || `invalid transport in ${mcpServerPath}`}\`\n\n` +
                `이 agent의 CLI 홈(config.toml)의 \`${mcpServerPath}\` 테이블(또는 harness/자격 증명 설정)을 점검해 고친 뒤 이 티켓을 unpend 하세요.\n\n` +
                `_동일 오류로 인한 supervisor 자동 재트리거는 억제됩니다 — 설정을 고친 뒤 unpend 하세요._`,
              metadata: { auto_notice: true }, // ticket 3c8b8026 — 자기 재트리거 방지, #postDeferAuditComment 주석 참고
            });
          }
          if (provisionBlock.shouldPend) {
            await fireAndForgetTool(this.#config, 'pend_ticket', {
              ticket_id: ev.ticket_id,
              reason: provisioningPendReason({
                kind: blockerKind,
                reason: blockerKind,
                detail: result.detail,
                count: provisionBlock.count,
              }),
            });
            log(
              `[mcp-transport] durable provisioning block — pended ticket=${ev.ticket_id} role=${ev.action} blocker=${blockerKind} aborts=${provisionBlock.count}`,
            );
          }
          log(
            `Trigger aborted — invalid MCP transport config: ticket=${ev.ticket_id} role=${ev.action} detail=${result.detail || ''}`,
          );
          this.#ackDispatch(ev, 'nack', blockerKind);
          return;
        }
        log(`Subagent spawn declined (${result.reason}); no further fallback in standalone mode`);
      } catch (err: any) {
        log(`Delegation path failed: ${err?.message ?? err}; dropping`);
      }
    }

    log(
      `Trigger processed (no delegation path spawned): ticket=${ev.ticket_id} role=${ev.action}`,
    );
  }

  /**
   * Durable dispatch outbox ack (ticket e7c87517). Fire-and-forget POST that
   * tells the server whether this `agent_trigger` actually spawned
   * (`processed`) or was aborted (`nack` + reason). Echoes the trigger_id the
   * server put on the SSE payload (`ev.field_changed`) so a stale ack for a
   * superseded dispatch is ignored server-side. `ev.action` is the role,
   * `ev.ticket_id` the ticket. Never throws / awaited-but-swallowed — the
   * server's reconciler falls back to its processing-grace timeout if the ack
   * never lands, so this can never block or fail a spawn.
   */
  #ackDispatch(ev: any, outcome: 'processed' | 'nack' | 'suppressed', reason?: string): void {
    void postDispatchAck(this.#config, {
      ticket_id: String(ev?.ticket_id || ''),
      role: String(ev?.action || ''),
      trigger_id: String(ev?.field_changed || ''),
      outcome,
      reason: reason ? String(reason).slice(0, 500) : '',
      skill_snapshot_run_id: String(ev?.skill_snapshot?.run_id || ''),
    });
  }

  async handleChatRequest(raw: string): Promise<void> {
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch (err: any) {
      log(`Failed to parse chat_request: ${err?.message ?? err}`);
      return;
    }

    // chat_request envelope-native: fields under ev.payload.* (asymmetric vs
    // agent_trigger which is flatten-on-emit).
    const payload = ev.payload || {};
    let agentContext = this.#resolveAgentContext(payload.agent_id || '');
    agentContext = await this.#scopeAgentContext(agentContext, payload.workspace_id);

    // ticket c0c0b1e4 (리뷰 지적 #1): a registered-but-not-bootstrapped miss must
    // be reported HERE, before any fallback dispatch is attempted — the hermes /
    // chatSessionManager / subagentManager attempts below can "succeed" using an
    // undefined agentContext (manager-default identity) and return early, which
    // would hide the miss entirely and run the turn under the wrong identity.
    if (!agentContext) {
      const missReason = this.#agentContextMissReason(payload.agent_id);
      if (this.#reportAgentContextMiss('Chat request', missReason, payload.agent_id)) {
        await this.#notifyAgentContextMissInRoom('Chat request', payload.room_id, payload.agent_id);
        return;
      }
    }

    const delegation = (this.#config as any)?.delegation ?? {};
    const delegationEnabled = delegation.enabled !== false;
    const persistentChat = delegation.persistentChatSessions !== false;

    // ticket 7d8ea7c9: RoomMessagingService resolves agent > workspace Claude
    // backend profile server-side (mirrors trigger-loop.service.ts's ticket
    // resolution) and stamps it on chat_request. chat_request is
    // envelope-native (see comment above), so this reads payload.* — NOT the
    // ev.cli_runtime_profile flattened field, which is agent_trigger-only.
    //
    // (리뷰 라운드 2, P1): 라운드 1은 여기서 멈추고 `this.#runtimeProfileOverride`를
    // 전혀 참조하지 않았다 — 인스턴스 전역 `--runtime-profile` 플래그가 켜져 있으면
    // 모든 채팅 참가자가 자신의 cli_runtime_profile과 무관하게 같은 backend로
    // 강제된다는 논리였다(root cause C). 그 논리는 "오버라이드로 절대 폴백하지
    // 않는다"와 "둘 다 설정됐을 때 per-agent가 오버라이드를 이긴다"를 혼동한 것이다
    // — 후자만이 실제로 교차 오염을 막으면서도, per-agent DB 프로필이 없는
    // agent에게는 여전히 오버라이드가 폴백으로 남는다. ticket-dispatch 경로의
    // resolveTriggerRuntimeProfile(티켓 0fbe802c, trigger-runtime-profile-priority.test.mjs로
    // 우선순위 검증됨)과 정확히 같은 방식이므로 여기서도 그대로 재사용해, 두 진입점이
    // 하나의 우선순위 계약(agent cli_runtime_profile > 인스턴스 오버라이드 > null)을
    // 공유하도록 한다.
    const runtimeProfile = resolveTriggerRuntimeProfile(payload.cli_runtime_profile, this.#runtimeProfileOverride);

    // ticket 9fd27487: handleChatRoomMessage의 run-workspace 프로비저닝에 대응하는
    // DM / @-멘션 쪽 짝. `chat_request`는 (chat_room_message와 달리) DM이나 명시적
    // @-멘션의 정식(canonical) 디스패치 경로다 — manager 에이전트 자신의 운영 채팅이
    // 바로 이 경우이므로, chat_room_message가 처리하는 그룹룸 턴만으로는 부족하고
    // 이 경로도 자체적인 cwd 고정이 필요하다. `run_provision`은 대상 workspace가
    // chat_workspace_folder_enabled를 켰을 때만 존재하며(서버 측 게이트), 채팅용
    // RunProvision은 항상 repo:null을 갖는다(ChatRoom에는 repo_ref 옵션이 없다) —
    // 그래서 여기서의 프로비저닝은 저비용 best-effort mkdir 수준으로 낮춰 처리한다.
    // QA/action 경로의 완전한 락 + "실패하면 디스패치 자체를 중단"하는 절차까지는
    // 쓸 필요가 없다(폴더 mkdir 하나 실패했다고 DM 답장을 통째로 버리는 쪽이 그냥
    // working_dir 루트에서 답하는 것보다 더 나쁜 결과다).
    let runContext = agentContext;
    // runContext.cwd와는 별도로 추적한다: composeChatPrompt에 폴더 경계 블록의
    // 트리거로 전달되는데, opt-in하지 않은 workspace라면 반드시 ''(블록 없음,
    // {{AWB_WORK_FOLDER}} 치환도 없음)을 유지해야 하기 때문이다 — 위에서
    // 프로비저닝이 실패한 뒤에는 runContext.cwd만 봐서는 "프로비저닝됨"과
    // "그냥 에이전트의 통상적인 working_dir 루트"를 구분할 수 없다.
    let provisionedWorkFolder = '';
    const runProvision = parseRunProvision(payload.run_provision);
    if (runProvision && agentContext) {
      const result = await provisionRunWorkspace(runProvision, agentContext.cwd);
      if (result.ok) {
        runContext = { ...agentContext, cwd: result.dir };
        provisionedWorkFolder = result.dir;
      } else {
        log(
          `[chat-request] run-workspace provisioning failed for room=${payload.room_id || ''} ` +
            `(continuing at working_dir root): ${result.error || 'unknown error'}`,
        );
      }
    }

    if (runContext?.cli === 'hermes') {
      const rolePrompt = payload.role_prompt || '';
      const taskText =
        this.#prompts?.composeChatPrompt(
          rolePrompt,
          Array.isArray(payload.history) ? payload.history : [],
          payload.new_message || '',
          payload.room_id || '',
          'agent_manager_delivers',
          provisionedWorkFolder,
        ) ?? `[chat] ${payload.new_message || ''}`;
      let replyText = '';
      try {
        const result = await this.#dispatchHermes({
          agentContext: runContext,
          runId: `chat:${payload.room_id || payload.user_id || 'direct'}:${runContext.agent_id}`,
          leaseId: runProvision?.run_id || `chat:${runContext.cwd}`,
          systemContext: rolePrompt,
          task: taskText,
          onEvent: (event) => {
            if (event.type === 'message_delta') replyText += event.text;
          },
        });
        log(
          `Chat request dispatched through Hermes ACP: room=${payload.room_id || ''} ` +
          `session=${result.sessionId} stop=${result.stopReason}`,
        );
        await this.#reportHermesDispatchOutcome(
          'Hermes chat dispatch',
          payload.room_id,
          runContext.agent_id,
          result,
          replyText,
        );
      } catch (err: any) {
        await this.#reportHermesDispatchFailure(
          'Hermes chat dispatch',
          payload.room_id,
          runContext.agent_id,
          err?.code || 'runtime_dispatch_error',
          err?.message ?? String(err),
        );
      }
      return;
    }

    if (
      delegationEnabled &&
      persistentChat &&
      this.#chatSessionManager &&
      payload.room_id
    ) {
      const chatResponderId =
        payload.agent_id || runContext?.agent_id || loadAgentInfo()?.agent_id || '';
      const onProgress = (stage: string): void => {
        const status = stage === 'thinking' ? 'thinking' : 'composing reply';
        this.#setChatRoomTyping(payload.room_id, true, status, chatResponderId).catch(() => {});
      };
      try {
        const result = await this.#chatSessionManager.dispatch({
          roomId: payload.room_id,
          agentId: payload.agent_id || runContext?.agent_id || loadAgentInfo()?.agent_id || '',
          senderId: payload.user_id || '',
          senderName: '',
          messageId: payload.message_id || '',
          createdAt: ev.timestamp || '',
          content: payload.new_message || '',
          rolePrompt: payload.role_prompt || '',
          onProgress,
          agentContext: runContext,
          runtimeProfile,
          provisionedWorkFolder,
        });
        if (result.dispatched) {
          log(
            `Chat request dispatched to session: room=${payload.room_id} pid=${result.pid}${result.firstTurn ? ' (new session)' : ''}`,
          );
          return;
        }
        if (result.reason === 'duplicate_chat') {
          log(
            `Chat request deduped: room=${payload.room_id} user=${payload.user_id} ts=${ev.timestamp || ''}`,
          );
          return;
        }
        log(
          `Chat session dispatch declined (${result.reason}), falling back to legacy path`,
        );
      } catch (err: any) {
        log(
          `Chat session path failed: ${err?.message ?? err}, falling back to legacy path`,
        );
      }
    }

    const canDelegate =
      delegationEnabled && this.#subagentManager && this.#subagentManager.canSpawn();

    if (canDelegate && this.#subagentManager) {
      const rolePrompt = payload.role_prompt || '';
      const history = Array.isArray(payload.history) ? payload.history : [];
      const newMessage = payload.new_message || '';
      // Non-NATIVE_MCP CLIs (codex / antigravity) can't call
      // send_chat_room_message themselves — the manager harvests their stdout
      // and posts the reply. Compose the channel instruction to match so the
      // subagent isn't told to use a tool it lacks (or to suppress the stdout
      // the manager reads).
      const usesNativeMcp = createAdapter(runContext?.cli).has(ADAPTER_CAPABILITIES.NATIVE_MCP);
      const taskText =
        this.#prompts?.composeChatPrompt(
          rolePrompt,
          history,
          newMessage,
          payload.room_id || '',
          usesNativeMcp,
          provisionedWorkFolder,
        ) ?? `[chat] ${newMessage}`;

      try {
        const result = await this.#subagentManager.spawn({
          kind: 'chat',
          taskText,
          rolePrompt,
          chatRequestId: payload.message_id || (
            payload.user_id
              ? `msg:${payload.user_id}:${ev.timestamp || ''}`
              : undefined
          ),
          ticketId: payload.ticket_id || '',
          agentId: payload.agent_id || '',
          roomId: payload.room_id || '',
          agentContext: runContext,
          runtimeProfile,
        });

        if (result.spawned) {
          log(
            `Chat request dispatched to subagent: agent=${payload.agent_id} pid=${result.pid}`,
          );
          return;
        }
        log(
          `Chat subagent spawn declined (${result.reason}); no further fallback in standalone mode`,
        );
      } catch (err: any) {
        log(`Chat delegation path failed: ${err?.message ?? err}; dropping`);
      }
    }

    log(
      `Chat request dropped (no delegation path): agent=${payload.agent_id} user=${payload.user_id}`,
    );
  }

  /**
   * Handle a comment_mention event. Server already filtered to the mentioned
   * agent, so no local filter step. Dispatch order:
   *   1. Live ticket session → forwardCommentMention
   *   2. Otherwise → one-shot subagent spawn with explicit "addressed to YOU"
   */
  async handleCommentMention(raw: string): Promise<void> {
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch (err: any) {
      log(`Failed to parse comment_mention: ${err?.message ?? err}`);
      return;
    }

    // The server is the first dedupe boundary; this is the final safety net for
    // old servers/replayed SSE. Only terminal approval receipts are suppressed.
    // Questions, change requests, consensus discussion and handoffs still flow.
    const { isAgentTerminalAcknowledgement } = await import('./terminal-ack-guard.js');
    if (isAgentTerminalAcknowledgement(ev)) {
      log(
        `Comment mention suppressed — duplicate terminal acknowledgement: ` +
          `ticket=${(ev.ticket_id || '').slice(0, 8) || '_'} ` +
          `comment=${(ev.comment_id || '').slice(0, 8) || '_'} ` +
          `actor=${(ev.actor_id || '').slice(0, 8) || '_'}`,
      );
      return;
    }

    // Loop guard (ticket 07402c57): server-stamped `agent_chain_depth` on an
    // agent-authored mention reached the cap — mirrors handleChatRoomMessage's
    // identical check. A user comment resets the chain (server recomputes
    // depth from scratch off the comment's own author, so it never reaches
    // the cap), so this only ever fires for genuine agent-mention ping-pong.
    if (ev.actor_type === 'agent') {
      const depth = typeof ev.agent_chain_depth === 'number' ? ev.agent_chain_depth : 0;
      if (depth >= AGENT_CHAIN_DEPTH_CAP) {
        log(
          `Comment mention suppressed — agent_chain_depth=${depth} >= cap ${AGENT_CHAIN_DEPTH_CAP}: ` +
            `ticket=${(ev.ticket_id || '').slice(0, 8) || '_'} ` +
            `comment=${(ev.comment_id || '').slice(0, 8) || '_'} ` +
            `actor=${(ev.actor_id || '').slice(0, 8) || '_'}`,
        );
        return;
      }
    }

    const ticketId = ev.ticket_id || '';
    const commentId = ev.comment_id || ev.field_changed || '';
    const agentId = ev.agent_id || ev.actor_name || '';
    let agentContext = this.#resolveAgentContext(agentId);
    agentContext = await this.#scopeAgentContext(agentContext, ev.workspace_id);

    // ticket c0c0b1e4 (handleChatRequest 리뷰 지적 #1과 동일 구조): fallback
    // 시도(hermes/ticketSessionManager/subagentManager) 전에 여기서 먼저
    // not_bootstrapped 미스를 걸러낸다 — room_id가 없는 호출부라 알림은 못
    // 띄우지만, 로그 승격만큼은 fallback 성공 여부와 무관하게 항상 일어나야 한다.
    if (!agentContext) {
      const missReason = this.#agentContextMissReason(agentId);
      if (this.#reportAgentContextMiss('Comment mention', missReason, agentId)) return;
    }

    const mention = {
      ticket_id: ticketId,
      comment_id: commentId,
      actor_name: ev.actor_name || '',
      actor_id: ev.actor_id || '',
      content: ev.content || '',
      mention_source: ev.mention_source || 'direct',
      role_shortcut: ev.role_shortcut || '',
    };

    const delegation = (this.#config as any)?.delegation ?? {};
    const delegationEnabled = delegation.enabled !== false;
    const persistentTicket = delegation.persistentTicketSessions !== false;

    // 티켓 71532b4f: #dispatchTriggerBody(handleTrigger)와 동일한 harness /
    // runtime profile / effort preset / env vars 계산 — 같은 in-file 함수
    // (parseHarnessConfig/resolveTriggerRuntimeProfile/parseEffortPreset/
    // parseEnvironmentConfig/parseWorktreeMode/buildDispatchEnvVars) 재사용.
    // 이전에는 이 값들을 전혀 계산하지 않아, agent에 명시 핀된 cli_runtime_profile이
    // 조용히 무시되고 순정 Claude로 돌았다(서버가 comment_mention 페이로드에
    // agent_trigger와 같은 이름의 필드를 싣도록 확장됨: event-registry.ts/
    // mention-dispatch-profile.ts). 트리거 경로와 동일하게 Hermes 분기 직전에
    // 계산해, 아래 Hermes 분기(harness.system_prompt_append)와 그 다음의 Claude
    // one-shot spawn() 양쪽에서 재사용한다 — 리뷰 지적(71532b4f): Hermes 분기가
    // harness를 계산 시점보다 먼저 실행·반환해 harness가 계속 무시되던 버그.
    const harness = parseHarnessConfig(ev.harness_config);
    const runtimeProfile = resolveTriggerRuntimeProfile(ev.cli_runtime_profile, this.#runtimeProfileOverride);
    const effortPreset = parseEffortPreset(ev.effort_preset);
    const envConfig = parseEnvironmentConfig(ev.environment_config);
    const worktreeMode = parseWorktreeMode(ev.worktree_mode);
    const envVars = buildDispatchEnvVars(envConfig?.env_vars, agentContext?.cwd, worktreeMode, ticketId);
    if (harness) {
      log(
        `Comment mention carries harness_config: ticket=${ticketId.slice(0, 8) || '_'} keys=${Object.keys(harness).join(',')}`,
      );
    }
    if (effortPreset) {
      log(
        `Comment mention carries effort_preset: id=${effortPreset.id}${effortPreset.label ? ` (${effortPreset.label})` : ''} ticket=${ticketId.slice(0, 8) || '_'}`,
      );
    }

    if (agentContext?.cli === 'hermes') {
      try {
        const ticket = ticketId ? await fetchTicketContext(this.#config, ticketId) : null;
        const rolePrompt = ev.role_prompt || '';
        const taskText =
          this.#prompts?.composeCommentMentionPrompt(
            ticket,
            rolePrompt,
            mention,
            ticketId,
          ) ?? `[mention] ${ticketId} ${commentId}`;
        // ticket e8105c84 리뷰 라운드2 지적: 이 스냅샷은 dispatch 시각이 아니라
        // dispatch 직전 실제 코멘트 id 집합이어야 한다 — timestamp 커트오프는
        // 클록 스큐를 흡수할 만큼 넓으면서 동시에 같은 agent의 "그냥 예전
        // 코멘트"를 오탐하지 않을 만큼 좁을 수 없다. id 집합 멤버십은 두 실패
        // 모드 모두 없다.
        //
        // 리뷰 라운드3 지적: fetchTicketContext()가 실패(ticket===null)하거나
        // 응답에 comments가 없으면 위 로직이 빈 Set을 만드는데, 이는 "코멘트가
        // 실제로 0개"와 구별이 안 된다 — baseline을 못 구한 것뿐인데 빈
        // 집합으로 diff하면 이미 있던 동일 agent 코멘트가 전부 "새 응답"으로
        // 오탐된다. null로 구분해 baseline 확보 실패 자체를 별도 실패
        // 경로(#reportHermesMentionOutcome)로 fail-closed 처리한다.
        const knownCommentIds: Set<string> | null = Array.isArray(ticket?.comments)
          ? new Set<string>(ticket.comments.map((c: any) => c?.id).filter(Boolean))
          : null;
        const result = await this.#dispatchHermes({
          agentContext,
          runId: `ticket:${ticketId}:${mention.role_shortcut || '_'}`,
          leaseId: String(ev.worktree_lease_id || `cwd:${agentContext.cwd}`),
          // 리뷰 지적(71532b4f): 컬럼 트리거 Hermes 분기와 동일하게 harness의
          // system_prompt_append를 합성 — 이전에는 rolePrompt만 실려 board/
          // workspace harness_config가 Hermes comment_mention에서만 무시됐다.
          systemContext: [rolePrompt, harness?.system_prompt_append || ''].filter(Boolean).join('\n\n'),
          task: taskText,
        });
        log(
          `Comment mention dispatched through Hermes ACP: ticket=${ticketId} ` +
          `session=${result.sessionId} stop=${result.stopReason}`,
        );
        await this.#reportHermesMentionOutcome(ticketId, agentContext.agent_id, knownCommentIds, result);
      } catch (err: any) {
        const code = err?.code || 'runtime_dispatch_error';
        // 채팅 경로(handleChatRequest/handleChatRoomMessage)와 동일한 로그
        // classify()/spawnFailureTracker 신호 — ticket a837879c 가 이미 검증한
        // "Hermes <prefix> failed closed:" 포맷을 그대로 재사용한다.
        await this.#reportHermesDispatchFailure(
          'Hermes mention dispatch',
          undefined,
          undefined,
          code,
          err?.message ?? String(err),
        );
        await this.#notifyHermesMentionFailureOnTicket(ticketId, code);
      }
      return;
    }

    if (delegationEnabled && persistentTicket && this.#ticketSessionManager && ticketId) {
      try {
        // 타깃은 ev.agent_id(uuid)만 — agentId 변수의 actor_name 폴백은 표시
        // 이름이라 세션 agentId 와의 동등 비교에 쓰면 안 된다.
        const forwarded = this.#ticketSessionManager.forwardCommentMention(
          ticketId,
          mention,
          ev.agent_id || '',
        );
        if (forwarded) {
          log(
            `Comment mention forwarded to ticket session: ticket=${ticketId} comment=${commentId}`,
          );
          return;
        }
      } catch (err: any) {
        log(`Ticket session forward failed for comment_mention: ${err?.message ?? err}`);
      }
    }

    // ticket 467f714a blocker #2: a mention with no live session to forward to
    // would spawn a fresh one-shot — but while this agent is in a harness
    // session-limit defer window that spawn hits the same account session wall and
    // dies. Instead of DROPPING the mention (which loses it if no later trigger
    // arrives), COALESCE it into the single pending intent for its (ticket, role,
    // agent) and replay it exactly once at reset. A role-shortcut mention keys on
    // its role, so it MERGES into an existing supervisor-trigger intent (kind stays
    // 'trigger' — the full re-drive); a mention with no trigger becomes a durable
    // 'mention' intent re-delivered via handleCommentMention. No spawn while
    // deferred — the doomed one-shot is never started ("재디스패치는 spawn하지 않고").
    const mentionDefer = this.#sessionDefer.deferState(agentId);
    if (mentionDefer.deferred) {
      const mentionRole = mention.mention_source === 'role' ? mention.role_shortcut || '' : '';
      const { created } = this.#sessionDefer.addPendingIntent(
        agentId,
        { ticketId, role: mentionRole, agentId },
        raw,
        { kind: 'mention' },
      );
      log(
        `Comment mention deferred — harness session limit: ticket=${ticketId.slice(0, 8) || '_'} ` +
          `role=${mentionRole || '_'} agent=${(agentId || '').slice(0, 8) || '_'} until=${
            mentionDefer.deferUntilMs ? new Date(mentionDefer.deferUntilMs).toISOString() : '?'
          } (${created ? 'new pending intent' : 'coalesced'}, no one-shot spawn while deferred)`,
      );
      if (created) this.#postDeferAuditComment(ticketId, mentionDefer.resetLabel ?? '');
      return;
    }

    // ticket e90294e7: a role-shortcut mention (@[role:assignee]) targets the
    // exact same (ticket, role, agent) seat a column-move trigger dispatches
    // to. A reviewer's single "change requested" comment that both moves the
    // ticket's column AND @-mentions that same role fires two independent
    // triggers (agent_trigger + comment_mention) for one seat; the live-session
    // check above (forwardCommentMention) only sees a column trigger AFTER it
    // finishes spawning, so during its provisioning window (worktree checkout /
    // rebase) this mention would otherwise fall through to a redundant one-shot
    // spawn — a second, independent session racing the first inside the same
    // worktree (observed live in ticket da4358ee: both sessions exited without
    // committing). Only role-shortcut mentions can collide this way — a direct
    // @[agent:id] mention carries no role and can't be matched against a column
    // trigger's (ticket, role) seat.
    //
    // Round 2 (reviewer 리뷰): a PEEK (hasInflightOrLiveDispatch) only catches
    // the "column trigger first" ordering. The real dispatch order from a
    // review-change-request comment is comment POSTED, then the column moves
    // — so comment_mention's one-shot provisioning is usually the FIRST of the
    // two to run, and a peek finds nothing to suppress against. The one-shot
    // spawn below never registered itself anywhere, so the column trigger that
    // follows moments later (dispatchTrigger's own tryReserveDispatch) finds
    // the seat free too — twin spawn either order. Fix: CLAIM the seat with
    // the SAME atomic tryReserveDispatch the column-trigger path uses (ticket
    // 3d180f85's `_inflight` CAS map), instead of merely peeking. Whichever of
    // the two dispatch paths reaches tryReserveDispatch first wins the seat;
    // the other — regardless of which one it is — sees it occupied and
    // suppresses. The reservation is held for the one-shot's FULL lifetime via
    // SubagentSpawnArgs.onExit (not just until spawn() returns a pid), so the
    // column trigger can't slip in and re-claim the seat while the one-shot is
    // still mid-turn.
    let mentionSeat: DispatchSeat | null = null;
    if (mention.mention_source === 'role' && mention.role_shortcut) {
      const targetAgentId = ev.agent_id || '';
      const tsm = this.#ticketSessionManager;
      // ticket 3b8f24ec: computed unconditionally, mirroring handleTrigger's
      // own unconditional `inflightKey` (this same bookkeeping key is
      // backend-agnostic — see InflightDispatchTracker.recordSuppression's
      // doc comment) — so a force-respawn trigger suppressed while THIS
      // mention holds the seat still replays once mentionSeat releases,
      // instead of sitting stuck until some later trigger for the same key
      // happens to consume it (mentionSeat previously omitted createDispatchSeat's
      // `onReleased` hook entirely).
      const mentionInflightKey = InflightDispatchTracker.key(ticketId, mention.role_shortcut, targetAgentId);
      const replayPendingForceForMention = (): void =>
        this.#replayPendingForce(mentionInflightKey, ticketId, mention.role_shortcut);
      const suppressForSeat = (): void => {
        log(
          `Comment mention suppressed — column-move trigger already owns this (ticket, role, agent) seat: ` +
            `ticket=${ticketId.slice(0, 8) || '_'} role=${mention.role_shortcut} agent=${targetAgentId.slice(0, 8) || '_'}`,
        );
        // 리뷰 라운드2(ticket e341bcc2): 위 inflight 사이트와 동일한 이유로
        // 전체 식별자를 쓴다 — 이 키는 로그가 아니라 정확히 같은
        // (ticket, role, agent) 에만 합쳐야 하는 동작 키다.
        fireAndForgetTool(this.#config, 'add_comment', {
          ticket_id: ticketId,
          content:
            '⚠️ 중복 dispatch 억제 — 컬럼 트리거가 같은 (ticket, role) 를 이미 실행 중이라 ' +
            '멘션 dispatch 를 무시했습니다. 이 코멘트는 진행 중인 세션이 함께 읽습니다.',
          metadata: {
            dedupe_key: `dispatch_suppress:mention_seat:${ticketId || '_'}:${mention.role_shortcut}:${targetAgentId || '_'}`,
            // ticket 3c8b8026 — 자기 재트리거 방지. 위 inflight_dispatch
            // 사이트의 주석 참고(동일 근거: 이 알림이 코멘트→트리거 경로를
            // 다시 타 자기증폭 루프를 만들던 문제).
            auto_notice: true,
          },
        });
      };
      // ticket 13160d20: handleTrigger 자신의 authoritative-vs-fallback 선택
      // (그쪽의 canAuthoritative)을 그대로 거울처럼 따른다 — 객체에
      // tryReserveDispatch가 존재하는지만 확인하는 방식이 아니라. main.ts는
      // TicketSessionManager를 항상 무조건 생성하므로, 메서드 존재 여부만
      // 확인하는 방식은 persistentTicketSessions:false 에서도 계속 true였다 —
      // TicketSessionManager._inflight에 조용히 예약해버리는데, 이 레지스트리는
      // handleTrigger의 fallback 경로(아래 InflightDispatchTracker)가 그
      // 모드에서 전혀 쓰지 않는 곳이다. 서로 겹치지 않는 두 예약 맵 때문에
      // 어느 dispatch 경로도 상대의 점유를 볼 수 없어, persistentTicketSessions:false
      // 에서는 도착 순서와 무관하게 e90294e7의 twin이 재현됐다.
      if (delegationEnabled && persistentTicket && typeof tsm?.tryReserveDispatch === 'function') {
        const reservation = tsm.tryReserveDispatch(ticketId, mention.role_shortcut, targetAgentId);
        // !acquired: a column trigger already holds the provisioning/spawn
        // window for this seat. live: a session went live in the narrow race
        // window between forwardCommentMention (above) and this reserve call
        // — same seat, already owned. Either way we don't spawn.
        if (!reservation.acquired || reservation.live) {
          suppressForSeat();
          return;
        }
        // Fresh reservation — WE now own this seat until the one-shot spawned
        // below exits (or we bail out before spawning it).
        mentionSeat = createDispatchSeat({
          kind: 'authoritative',
          ticketId,
          role: mention.role_shortcut,
          agentId: targetAgentId,
          nonce: reservation.nonce,
          tsm,
          inflightDispatch: this.#inflightDispatch,
          onReleased: replayPendingForceForMention,
        });
      } else if (
        persistentTicket &&
        tsm?.hasInflightOrLiveDispatch?.(ticketId, mention.role_shortcut, targetAgentId)
      ) {
        // Legacy/test double without tryReserveDispatch — best-effort peek,
        // 이 fix 이전과 동일한 동작. persistentTicket으로 게이팅한 이유:
        // persistentTicketSessions:false 에서는 handleTrigger가 애초에 이
        // 레지스트리에 예약하지 않으므로(아래 fallback 분기 참고), 여기서
        // peek해봤자 항상 false negative만 반환하는 무의미한 가드가 된다.
        suppressForSeat();
        return;
      } else if (!persistentTicket) {
        // Fallback 모드 (persistentTicketSessions:false, ticket 3d180f85의
        // 설계): handleTrigger는 컬럼 이동 트리거의 (ticket, role, agent) seat를
        // TicketSessionManager._inflight가 아니라 바로 이 SAME InflightDispatchTracker
        // 인스턴스에 예약한다(위쪽의 tryAcquireFallback 호출, event-dispatcher.ts).
        // 두 dispatch 경로가 하나의 공유 레지스트리에 대해 single-flight 하도록
        // 여기서도 동일한 key를 claim한다 — 위 authoritative 분기와 동일한 방식.
        // ticket fdf6714e (13160d20 후속 gap 해소): authoritative 경로의
        // attachDispatchPid와 대칭으로 InflightDispatchTracker도 이제 pid-liveness
        // 탈출구를 갖는다 — 아래 spawn 성공 시 attachDispatchPid로 pid를 연결하면,
        // one-shot이 INFLIGHT_RESERVATION_STALE_MS보다 오래 실행돼도 살아있는 한
        // 이 예약은 age-out되지 않는다.
        const acq = this.#inflightDispatch.tryAcquireFallback(mentionInflightKey, {
          ticketId,
          role: mention.role_shortcut,
          agentId: targetAgentId,
        });
        if (!acq.acquired) {
          suppressForSeat();
          return;
        }
        // ticket 6de97a41 (fdf6714e 후속): handleTrigger의 zombie reservation
        // reclaimed 로그와 동등하게, fallback seat가 dead-pid 회수로 재claim된
        // 경우를 여기서도 남긴다 — 이전에는 acq.evicted를 아무도 읽지 않아
        // silent-exit 계열 신호(직전 one-shot이 onExit 없이 죽음)가 무로그였다.
        if (acq.evicted) {
          log(
            `[dispatch] zombie reservation reclaimed (${acq.evicted}): ` +
              `재-dispatch 진행 ticket=${ticketId.slice(0, 8) || '_'} role=${mention.role_shortcut} ` +
              `agent=${targetAgentId.slice(0, 8) || '_'}`,
          );
        }
        mentionSeat = createDispatchSeat({
          kind: 'fallback',
          ticketId,
          role: mention.role_shortcut,
          agentId: targetAgentId,
          nonce: acq.nonce,
          tsm,
          inflightDispatch: this.#inflightDispatch,
          inflightKey: mentionInflightKey,
          onReleased: replayPendingForceForMention,
        });
      }
    }

    try {
      const canDelegate =
        delegationEnabled && this.#subagentManager && this.#subagentManager.canSpawn();
      if (canDelegate && this.#subagentManager) {
        try {
          const ticket = ticketId ? await fetchTicketContext(this.#config, ticketId) : null;
          const rolePrompt = ev.role_prompt || '';
          const taskText =
            this.#prompts?.composeCommentMentionPrompt(
              ticket,
              rolePrompt,
              mention,
              ticketId,
            ) ?? `[mention] ${ticketId} ${commentId}`;

          const seat = mentionSeat;
          const result = await this.#subagentManager.spawn({
            kind: 'trigger',
            taskText,
            rolePrompt,
            // per-(comment, target agent) — role 멘션의 공동 홀더 팬아웃(per-agent
            // SSE × 같은 commentId)이 rule 1 dedup 에 drop 되지 않게 agent 차원 포함.
            triggerId: mentionTriggerId(commentId, agentId),
            ticketId,
            agentId,
            // Pin role only for role-shortcut mentions (@assignee / @reviewer).
            // Direct @-mentions don't carry a role, so leaving it empty lets
            // server-side resolveAuthorRole pick the agent's single held role
            // (or stay null when ambiguous) instead of pinning a guess.
            role: mention.mention_source === 'role' ? mention.role_shortcut || '' : '',
            agentContext,
            harness,
            runtimeProfile,
            effortPreset,
            envVars,
            // ticket e90294e7 round 2: release the claimed seat when this
            // one-shot's process exits, not when spawn() merely returns a pid
            // — the column trigger must stay locked out for the seat's whole
            // lifetime, not just the synchronous spawn call.
            onExit: seat ? () => seat.release() : undefined,
          });
          if (result.spawned) {
            // ticket e90294e7 round 3 (fallback seats: ticket fdf6714e):
            // promote the claimed seat from a bare provisioning-window
            // reservation to a pid-verified one now that we have the
            // one-shot's real OS pid — from here on the backing registry
            // trusts OS-level liveness over its TTL/safety-valve for a
            // long-running one-shot (see ticket-session-manager.ts /
            // InflightDispatchTracker). onExit (above) still releases it on
            // exit either way.
            if (seat) {
              seat.transferred = true;
              if (result.pid) seat.promote(result.pid);
            }
            log(
              `Comment mention dispatched to subagent: ticket=${ticketId} comment=${commentId} pid=${result.pid}`,
            );
            return;
          }
          log(
            `Comment mention subagent spawn declined (${result.reason}); no further fallback in standalone mode`,
          );
        } catch (err: any) {
          log(`Comment mention delegation failed: ${err?.message ?? err}; dropping`);
        }
      }

      log(`Comment mention dropped (no delegation path): ticket=${ticketId} comment=${commentId}`);
    } finally {
      // Release the claimed seat on every exit path that did NOT hand it off
      // to the spawned one-shot's onExit hook above (decline, throw, no
      // delegation path). Idempotent; releaseDispatch no-ops on a missing/
      // stale-generation key.
      if (mentionSeat && !mentionSeat.transferred) {
        mentionSeat.release();
      }
    }
  }

  handleBoardUpdate(raw: string): void {
    try {
      const ev = JSON.parse(raw);
      // entity_type: 'ticket' | 'comment' | 'child_ticket' etc.
      // action: 'created' | 'updated' | 'moved' | 'deleted' | 'status_changed'

      // ticket 9f26f091 — terminal-ticket worktree reclamation. A column move
      // is the only signal that can carry a ticket into a terminal (done/
      // merged) column; when it does, drop the ticket's per-(ticket,role)
      // worktrees regardless of dirty state. The 10-min sweep can't do this —
      // it deliberately preserves dirty trees to protect pended WIP, and in
      // this repo a worktree goes permanently dirty after any build (untracked
      // tsbuildinfo / database dir), so a done/merged ticket's tree would never
      // be reclaimed and worktrees would accumulate unbounded. Fire-and-forget
      // so the live-session forward below stays synchronous.
      if (ev.entity_type === 'ticket' && ev.action === 'moved' && ev.ticket_id) {
        // ticket d34075b5: a move (to ANY column) invalidates a queued
        // pool_exhausted retry for THIS ticket — the trigger targeted the pre-move
        // column. Cancel it synchronously here (covers "이동" incl. lateral moves,
        // for which there's no terminal_entered_at). Slots freed by a terminal move
        // wake OTHER tickets' retries from inside #cleanupTerminalTicketWorktrees.
        this.#poolRetry.cancelByTicket(ev.ticket_id, 'ticket moved');
        // ticket 467f714a: a moved ticket's deferred re-dispatch must not replay at
        // reset (its pre-move trigger is stale). The agent's window itself stays —
        // other tickets may still be deferred. Also drop any remembered trigger raw
        // (blocker #1) so a late session-limit death can't seed a stale re-drive.
        this.#sessionDefer.cancelByTicket(ev.ticket_id, 'ticket moved');
        this.#forgetTriggerRawForTicket(ev.ticket_id);
        void this.#cleanupTerminalTicketWorktrees(ev.ticket_id);
      }

      // worktree 규약 ⑤ — archive reclamation. Archiving a ticket writes an
      // activity_log 'archived' row which fans out as this very board_update
      // (entity_type='ticket', action='archived'). That is the authoritative
      // "physically remove everything this ticket used" signal: its per_ticket
      // worktree AND its QA/Security run workspace. Distinct from the 'moved'
      // terminal cleanup above — it also reclaims the run workspace and covers
      // tickets archived straight from a non-terminal column. Fire-and-forget so
      // the live-session forward below stays synchronous.
      if (ev.entity_type === 'ticket' && ev.action === 'archived' && ev.ticket_id) {
        // ticket d34075b5: an archived ticket's queued pool_exhausted retry is moot.
        this.#poolRetry.cancelByTicket(ev.ticket_id, 'ticket archived');
        this.#sessionDefer.cancelByTicket(ev.ticket_id, 'ticket archived');
        this.#forgetTriggerRawForTicket(ev.ticket_id); // ticket 467f714a blocker #1
        void this.#cleanupArchivedTicketWorkspace(ev.ticket_id, ev.repository_resource_id);
      }

      if (this.#ticketSessionManager && ev.ticket_id) {
        const forwarded = this.#ticketSessionManager.forwardBoardUpdate(
          ev.ticket_id,
          ev,
        );
        if (forwarded) {
          log(
            `Board update forwarded to ticket session: ticket=${ev.ticket_id} ${ev.entity_type}.${ev.action}`,
          );
          return;
        }
      }

      // No live ticket session — drop. AWB events are exclusively a subagent
      // concern; standalone manager has no main-session fallback.
      log(
        `Board update dropped (no live ticket session): ticket=${ev.ticket_id} ${ev.entity_type}.${ev.action}`,
      );
    } catch (err: any) {
      log(`Failed to parse board_update: ${err?.message ?? err}`);
    }
  }

  /**
   * Post the room typing/status indicator.
   *
   * `agentId` MUST be the agent that is actually answering (the resolved
   * managed member), never this manager's own identity. The server renders the
   * indicator as `<Manager>/<Agent>` by resolving whatever agent_id it gets —
   * so passing the manager id made the UI say "<manager> is typing", losing the
   * agent half of the name. Falling back to loadAgentInfo() is a last resort
   * for the standalone case where no managed context resolved.
   */
  async #setChatRoomTyping(
    roomId: string,
    isTyping: boolean,
    status: string | null = null,
    agentId?: string,
  ): Promise<void> {
    try {
      const agentInfo = loadAgentInfo();
      const responderId = agentId || agentInfo?.agent_id || '';
      const url = `${this.#config.url.replace(/\/$/, '')}/api/agent/chat-rooms/${encodeURIComponent(roomId)}/typing`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'X-Agent-Key': this.#config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: responderId,
          // Hint only — the server re-resolves the canonical display name from
          // agent_id and this value is used solely when that lookup misses.
          agent_name:
            responderId === agentInfo?.agent_id
              ? agentInfo?.agent_name || (agentInfo as any)?.name || 'Agent'
              : '',
          is_typing: isTyping,
          status,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err: any) {
      log(`setChatRoomTyping failed: ${err?.message ?? err}`);
    }
  }

  async handleChatRoomMessage(raw: string): Promise<void> {
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch (err: any) {
      log(`Failed to parse chat_room_message: ${err?.message ?? err}`);
      return;
    }

    const p = ev.payload || ev;

    // Progress rows are tool-call heartbeats the agent-manager itself posts
    // while a spawned CLI is working. They share the chat stream so humans
    // can watch live, but they must never trigger another agent: fan-out can
    // deliver Agent A's heartbeat to Agent B (different sender_id, so the
    // self-guard below would let it through), and a typing indicator + CLI
    // spawn for a tool-call narration is exactly the loop this discriminator
    // exists to prevent. recordRoomMessage already drops these from the
    // in-memory history ring, so this early-exit is purely about delegation.
    if (p.type === 'progress') {
      log(
        `Chat room message is progress heartbeat (room=${p.room_id} sender=${p.sender_name || p.sender_id}) — skipping delegation`,
      );
      return;
    }

    // A targeted chat_request is the canonical execution path for user DMs
    // and @mentions because it preserves the exact target agent. The matching
    // chat_room_message remains necessary for UI/history fan-out, but must not
    // start another subagent for the same persisted message.
    if (Array.isArray(p.dispatch_agent_ids) && p.dispatch_agent_ids.length > 0) {
      this.#chatSessionManager?.recordRoomMessage(p);
      log(
        `Chat room message already routed by chat_request ` +
          `(room=${p.room_id || ''} message=${p.message_id || ''}) — skipping delegation`,
      );
      return;
    }

    // Resolve which managed agent (if any) should respond. Manager-fan-out
    // delivers chat events for any room where one of this manager's managed
    // agents is a member; the wire payload's agent_member_ids is the set we
    // pick from. When no managed agent matches we fall through to the
    // manager's own identity, which is the right behavior for rooms where
    // the manager itself is a participant.
    const memberIds: string[] = Array.isArray(p.agent_member_ids) ? p.agent_member_ids : [];
    // An agent never answers its own message, so the sender is excluded from
    // candidate selection. Any OTHER managed member — including a sibling
    // hosted by this same manager — is still eligible.
    const senderAgentId = p.sender_type === 'agent' ? p.sender_id || '' : '';
    let agentContext = this.#resolveAgentContextFromMembers(memberIds, senderAgentId);
    agentContext = await this.#scopeAgentContext(agentContext, p.workspace_id);

    // Two early-exit cases for agent-sent messages — both still record into
    // the chat ring so future dispatches see complete history:
    //   1. Self-message this host cannot hand to anybody else. A managed
    //      SIBLING is a legitimate target and must be allowed to pick the
    //      message up (that is the agent-to-agent case). We only drop when no
    //      other managed member resolved — then the spawn would fall back to
    //      the manager's own identity and answer the sender's own message.
    //   2. Loop guard: server-stamped `agent_chain_depth` reached the cap.
    if (p.sender_type === 'agent') {
      if (!agentContext && this.#senderIsOwnedIdentity(p.sender_id)) {
        this.#chatSessionManager?.recordRoomMessage(p);
        log(
          `Chat room message from self (${p.sender_name || p.sender_id}) ` +
            `with no other managed member in room=${p.room_id || ''} — skipping delegation`,
        );
        return;
      }
      const depth = typeof p.agent_chain_depth === 'number' ? p.agent_chain_depth : 0;
      if (depth >= AGENT_CHAIN_DEPTH_CAP) {
        this.#chatSessionManager?.recordRoomMessage(p);
        log(
          `Chat room message from agent (${p.sender_name || p.sender_id}) — agent_chain_depth=${depth} ` +
            `>= cap ${AGENT_CHAIN_DEPTH_CAP}, skipping delegation to break loop`,
        );
        return;
      }
    }

    // ticket c0c0b1e4 (리뷰 지적 #1,#3): registered-but-not-bootstrapped 미스는
    // 아래 run-provisioning/hermes/chatSessionManager/subagentManager fallback이
    // (매니저 자신의 cwd/신원으로) "성공"해 조용히 return 하기 전에 여기서 먼저
    // 걸러낸다 — self-message/chain-depth 스킵은 이미 위에서 끝났으므로 이 아래는
    // 전부 실제 dispatch 시도다. 알림의 agent_id는 memberIds[0]이 아니라 실제
    // broken managed member id를 쓴다(첫 멤버가 unmanaged이고 broken member가
    // 뒤에 있는 경우 잘못된 발신 id가 되는 것을 방지).
    // agentContext가 이미 정상 resolve됐다면(다른 멤버가 완전히 부팅됨) 절대
    // 여기 들어오면 안 된다 — #agentContextMissReasonForMembers는 "레지스트리에
    // 있는가"만 보고 재판정하므로, 이 가드 없이 무조건 호출하면 정상 resolve된
    // 케이스까지 not_bootstrapped로 오탐한다(라운드2 리뷰 대응 중 회귀 테스트로 발견).
    if (!agentContext) {
      // Same exclusion as the resolve above: the sender was skipped on purpose,
      // so it must not be re-judged here as a broken candidate.
      const candidateIds = senderAgentId ? memberIds.filter((id) => id !== senderAgentId) : memberIds;
      const membersMiss = this.#agentContextMissReasonForMembers(candidateIds);
      if (this.#reportAgentContextMiss('Chat room message', membersMiss.reason, candidateIds.join(','))) {
        await this.#notifyAgentContextMissInRoom('Chat room message', p.room_id, membersMiss.brokenId);
        return;
      }
    }

    // QA/security run-workspace provisioning (ticket 25db3cc6). A run-dispatch
    // chat_room_message carries a `run_provision` hint: prepare the working
    // folder (clone / fetch+ff-pull, reuse vs fresh) BEFORE spawning so the run
    // never improvises a folder. The prepared absolute path is pinned as the
    // subagent cwd, matching the folder the server-rendered prompt already names.
    // On failure, abort the dispatch, finalize the run as `error`, and post a
    // room message — the chat-room twin of the ticket-trigger provisioning abort.
    // An ordinary chat turn carries no run_provision → runContext stays untouched.
    let runContext = agentContext;
    // Always attribute the typing/status indicator to the agent that will
    // answer, not to this manager — otherwise the UI shows "<manager> is
    // thinking" instead of "<manager>/<agent>". Computed once and reused by
    // EVERY set AND clear call below: the client keys the indicator by
    // agent_id, so a clear sent under a different id leaves it stuck until the
    // 15s safety timeout. Provisioning may rebind runContext.cwd later, but
    // never its agent_id, so hoisting this here is safe.
    const roomResponderId =
      runContext?.agent_id || agentContext?.agent_id || loadAgentInfo()?.agent_id || '';
    const runProvision = parseRunProvision(p.run_provision);
    // ticket e9d0e8bc: run-lifetime folder lock for a QA/security run. Acquired
    // below (before provisioning) and held until the spawned run subagent's
    // process exits, whose onExit hook releases it. The try/finally spans the
    // whole provision→dispatch body so the lock is freed on EVERY path no spawn
    // took ownership of (provision-fail, decline, throw, drop). Release is
    // idempotent, so a defensive double-release is harmless. Ordinary chat turns
    // keep runLock null and are unaffected.
    let runLock: RunLockHandle | null = null;
    let runLockTransferred = false;
    try {
    if (runProvision) {
      log(
        `Chat room run dispatch: kind=${runProvision.kind} run=${runProvision.run_id.slice(0, 8)} ` +
          `folder=${runProvision.workspace_folder} checkout=${runProvision.checkout_mode} ` +
          `repo=${runProvision.repo ? runProvision.repo.url : 'none'}`,
      );
      // worktree 규약 ③: root the run folder at the agent's working_dir
      // (agentContext.cwd) so it lands at `<working_dir>/.awb/qa/<id8>`, matching
      // the path the server-rendered prompt names and symmetric with the worktree
      // manager's `.awb/wt/` root. Empty when no agent context resolved → the
      // provisioner falls back to the manager home (pre-규약-③ behavior).
      //
      // BUT the resolved cwd comes from the managed-agent CONTEXT registry, an
      // in-memory cache hydrated at the last spawn_agent. It can drift from the
      // server-authoritative working_dir (a set_working_dir that updated only the
      // heartbeat registry, or a working_dir changed on the server since spawn) —
      // and 규약 ③ applied to a stale base silently checks the run out at the wrong
      // path (the GameClient divergence this ticket exists for). Re-validate against
      // the server record at dispatch time; on drift, prefer the server value AND
      // heal the context cache so the next dispatch / ticket trigger is consistent.
      // Availability-first: a failed/empty fetch keeps the cached base (never blocks
      // a run on a transient server hiccup). Run dispatches are rare vs ticket
      // triggers, so the extra round-trip is cheap here.
      let baseWorkingDir = agentContext?.cwd || '';
      const revalAgentId = agentContext?.agent_id || '';
      if (revalAgentId) {
        const record = await fetchAgentRecord(this.#config, revalAgentId);
        const reconciled = reconcileRunBaseWorkingDir(baseWorkingDir, record?.working_dir);
        if (reconciled.drifted) {
          log(
            `[run-provision] ⚠️ working_dir drift for agent=${revalAgentId.slice(0, 8)}: ` +
              `cached='${baseWorkingDir || '(empty)'}' server='${reconciled.base}' — using the server ` +
              `value and healing the context cache (규약 ③ base was stale; prevents run misplacement)`,
          );
          this.#managedAgentContexts?.setWorkingDir(revalAgentId, reconciled.base);
          if (agentContext) agentContext.cwd = reconciled.base;
          baseWorkingDir = reconciled.base;
        } else if (!reconciled.serverAuthoritative) {
          log(
            `[run-provision] working_dir re-validation skipped for agent=${revalAgentId.slice(0, 8)} ` +
              `(server record unavailable) — using cached base '${baseWorkingDir || '(empty)'}'`,
          );
        }
      }
      // ticket e9d0e8bc: acquire the run-lifetime folder lock BEFORE provisioning,
      // keyed by the SAME absolute folder the provisioner uses (resolveRunFolder
      // shares run-provisioner's root logic). A second run of the same scenario
      // waits here — and then executes — instead of racing this run's checkout /
      // build in the shared folder. Different scenarios never contend. Gated by
      // delegation.runExecutionLock (default on) as a kill-switch.
      if ((this.#config as any)?.delegation?.runExecutionLock !== false) {
        const runFolder = resolveRunFolder(runProvision, baseWorkingDir);
        runLock = await this.#runExecLock.acquire(runFolder);
        if (runLock.wasBusy) {
          log(
            `[run-exec-lock] ${runProvision.kind} run=${runProvision.run_id.slice(0, 8)} ` +
              `serialized behind a concurrent same-folder run → ${runFolder}`,
          );
          const waitResponder = agentContext?.agent_id || loadAgentInfo()?.agent_id || '';
          if (p.room_id && waitResponder) {
            await postChatRoomMessage(
              this.#config,
              p.room_id,
              waitResponder,
              `ℹ️ **런 실행 직렬화** — 같은 시나리오의 선행 run 이 공유 작업폴더에서 실행 중이라 ` +
                `완료까지 대기한 뒤 진행했습니다 (동시 실행 시 워킹트리 clobber 방지).`,
            ).catch(() => {});
          }
        }
      }
      const result = await provisionRunWorkspace(runProvision, baseWorkingDir);
      if (!result.ok) {
        const responder = agentContext?.agent_id || loadAgentInfo()?.agent_id || '';
        if (p.room_id && responder) {
          const detail = result.steps.length > 0 ? `\n\n실행 단계:\n${result.steps.map((s) => `- ${s}`).join('\n')}` : '';
          await postChatRoomMessage(
            this.#config,
            p.room_id,
            responder,
            `⚠️ **런 작업폴더 프로비저닝 실패** — 작업을 시작하지 않고 디스패치를 중단했습니다.\n\n` +
              `\`\`\`\n${result.error || 'unknown error'}\n\`\`\`${detail}\n\n` +
              `시나리오의 repo / branch / checkout 설정을 확인한 뒤 다시 실행하세요.`,
          ).catch(() => {});
        }
        // Finalize the run as error so it doesn't hang waiting on the liveness
        // reaper — the run subagent never spawns, so nothing else will close it.
        // ticket 9fd27487: 'chat'에는 complete_*_run 툴 자체가 없다(일반 채팅방은
        // one-shot run이 아니다 — RunProvisionKind 참고); qa/security/action은
        // 공통 kind→tool 계약을 그대로 타고 간다(chat-session-manager.ts /
        // subagent-manager.ts의 orphan-sweep에서도 동일하게 사용). ticket
        // 2dc3c62f: 'orchestration'도 여기서 제외한다 — report_orchestration_step
        // 은 run_id/workspace_id가 아니라 step_id로 완료 처리하는 다른 모양의
        // 계약이라 resolveRunCompletionRoute에 억지로 맞추지 않는다; 대신 미션의
        // 기존 step_timeout_minutes reaper가 응답 없는 step을 회수한다
        // (run-provisioner.ts의 RunProvisionKind 문서 참고).
        if (runProvision.kind !== 'chat' && runProvision.kind !== 'orchestration') {
          const route = resolveRunCompletionRoute(runProvision.kind);
          await fireAndForgetTool(this.#config, route.completeTool, {
            run_id: runProvision.run_id,
            workspace_id: runProvision.workspace_id,
            status: route.failureStatus,
            summary: `작업폴더 프로비저닝 실패: ${result.error || 'unknown error'}`,
          });
        }
        if (p.room_id) await this.#setChatRoomTyping(p.room_id, false, '', roomResponderId).catch(() => {});
        log(`Chat room run dispatch aborted — provisioning failed: run=${runProvision.run_id.slice(0, 8)} dir=${result.dir}`);
        return;
      }
      // Surface non-fatal provisioning notes (stale .git/index.lock recovery, or a
      // serialized wait behind a concurrent same-scenario run) into the run room so
      // a recovery/conflict is visible in the run record rather than silently
      // swallowed (ticket 6254fb4e req 3). The run proceeds normally regardless.
      if (result.notes && result.notes.length > 0) {
        const noteResponder = agentContext?.agent_id || loadAgentInfo()?.agent_id || '';
        if (p.room_id && noteResponder) {
          await postChatRoomMessage(
            this.#config,
            p.room_id,
            noteResponder,
            `ℹ️ **런 작업폴더 프로비저닝 참고** — 아래 사유로 자동 복구/직렬화 후 정상 진행했습니다.\n` +
              result.notes.map((n) => `- ${n}`).join('\n'),
          ).catch(() => {});
        }
        log(
          `[run-provision] notes surfaced for run=${runProvision.run_id.slice(0, 8)}: ${result.notes.join(' | ')}`,
        );
      }
      // Pin the prepared folder as the subagent cwd (matches the prompt path).
      if (agentContext) runContext = { ...agentContext, cwd: result.dir };
      log(`Run workspace ready: run=${runProvision.run_id.slice(0, 8)} dir=${result.dir}`);
      // ticket 152e3606: run 작업폴더의 workspace trust를 시딩한다. run의
      // CLI 세션은 완전히 비대화형이라 trust 대화상자를 수락해줄 사람이
      // 없다 — 미신뢰 cwd는 경고만 내는 게 아니라 repo의
      // `.claude/settings.json` permissions.allow를 조용히 무시해버린다(이
      // 티켓이 존재하는 이유가 된 사고: allow 항목 22개가 무시되고 run이
      // 서버에 아무 실패도 안 보이는 채로 멈춤). AWB가 이 폴더를 직접
      // 만들었으므로 사람이 남길 trust 판단이 없다. 위쪽 티켓-디스패치
      // 게이트와 달리 이 경로는 spawn에 `harness`를 전혀 싣지 않으므로
      // (chatSessionManager.dispatch / 아래 subagentManager.spawn 모두
      // chat-room 턴엔 harness 필드가 없다) 이것과 짝지을 만한 차단-후-중단
      // 체크 자체가 없다 — 시딩이 이 경로의 수정 전부다. best-effort:
      // 시딩 실패로 run 자체를 중단시키지 않는다.
      if (runContext?.cwd && runContext?.cli_home_dir && runContext?.cli !== 'hermes') {
        await createAdapter(runContext.cli)
          .ensureWorkspaceTrust(runContext.cli_home_dir, runContext.cwd)
          .catch((err: any) => {
            log(
              `[cli-trust] ensureWorkspaceTrust failed: run=${runProvision.run_id.slice(0, 8)} ` +
                `cli=${runContext?.cli} cwd=${runContext?.cwd}: ${String(err?.message ?? err)}`,
            );
          });
      }
    }
    // ticket 9fd27487: composeChatRoomPrompt에 폴더 경계 블록 트리거로 전달된다.
    // 프로비저닝 실패(FAILURE)라면 위에서 이미 "런 작업폴더 프로비저닝 실패" abort
    // 경로로 return했으므로, 여기까지 도달했는데 runProvision이 truthy라는 것은
    // 항상 바로 위 줄의 cwd 고정이 성공했다는 뜻이다 — runContext.cwd를 그대로
    // 읽어도 안전하다. runProvision이 null/부재(opt-in하지 않은 workspace의
    // 일반 채팅 턴)라면 이 값은 ''로 유지된다.
    const provisionedWorkFolder = runProvision ? (runContext?.cwd || '') : '';

    // Three-stage typing contract:
    //   reading   — set immediately on receive
    //   thinking  — first stdout from subagent
    //   composing — first assistant content
    if (p.room_id) {
      await this.#setChatRoomTyping(p.room_id, true, '👀 reading context', roomResponderId);
    }

    const onProgress = p.room_id
      ? (stage: string): void => {
          const status = stage === 'thinking' ? 'thinking' : 'composing reply';
          this.#setChatRoomTyping(p.room_id, true, status, roomResponderId).catch(() => {});
        }
      : undefined;

    const delegation = (this.#config as any)?.delegation ?? {};
    const delegationEnabled = delegation.enabled !== false;
    const persistentChat = delegation.persistentChatSessions !== false;

    // ticket 7d8ea7c9 (review round 1): RoomMessagingService가 이제 그룹방
    // broadcast용 agent별 profile map(p.cli_runtime_profiles, agent_id로
    // 키잉)을 해석해 보낸다 — chat_room_message는 모든 멤버에게 팬아웃되므로,
    // chat_request의 단일 대상 필드처럼 평면 필드 하나로는 "지금 응답할 그
    // agent에게 맞는 backend"를 표현할 수 없다. roomResponderId(타이핑
    // 표시용으로 위에서 이미 계산됨)가 정확히 이 dispatch가 spawn할 그
    // agent이므로, 맵 키로 그대로 재사용한다.
    //
    // (리뷰 라운드 2, P1): resolveRoomBroadcastRuntimeProfile은 이제
    // chat_request와 동일하게 인스턴스 오버라이드로 폴백한다 — 위
    // handleChatRequest 호출부의 상세 사유 참고. 우선순위: 이 responder의
    // map 항목 > 인스턴스 오버라이드 > null.
    const runtimeProfile = resolveRoomBroadcastRuntimeProfile(p, roomResponderId, this.#runtimeProfileOverride);

    if (runContext?.cli === 'hermes') {
      try {
        const history = await fetchChatRoomHistory(this.#config, p.room_id);
        const prepared = await prepareChatAttachments(
          this.#config,
          p.room_id,
          Array.isArray(p.attachments) ? p.attachments : [],
          { fetchImages: false },
        );
        const rolePrompt = p.role_prompt || '';
        const taskText =
          this.#prompts?.composeChatRoomPrompt(
            p.room_id,
            history,
            {
              content: p.content || '',
              sender_name: p.sender_name || '',
              sender_id: p.sender_id || '',
            },
            prepared,
            'agent_manager_delivers',
            undefined,
            typeof p.room_name === 'string' ? p.room_name : '',
            !!p.is_action_room,
            provisionedWorkFolder,
          ) ?? `[chat_room] ${p.content || ''}`;
        const runId = runProvision?.run_id
          || `chat:${p.room_id || 'room'}:${runContext.agent_id}`;
        let replyText = '';
        const result = await this.#dispatchHermes({
          agentContext: runContext,
          runId,
          leaseId: runProvision?.run_id || `chat:${runContext.cwd}`,
          systemContext: rolePrompt,
          task: taskText,
          onEvent: (event) => {
            if (event.type === 'message_delta') replyText += event.text;
          },
        });
        this.#chatSessionManager?.recordRoomMessage(p);
        if (p.room_id) await this.#setChatRoomTyping(p.room_id, false, '', roomResponderId).catch(() => {});
        log(
          `Chat room dispatched through Hermes ACP: room=${p.room_id || ''} ` +
          `run=${runId} session=${result.sessionId} stop=${result.stopReason}`,
        );
        await this.#reportHermesDispatchOutcome(
          'Hermes room dispatch',
          p.room_id,
          runContext.agent_id,
          result,
          replyText,
        );
      } catch (err: any) {
        if (p.room_id) await this.#setChatRoomTyping(p.room_id, false, '', roomResponderId).catch(() => {});
        await this.#reportHermesDispatchFailure(
          'Hermes room dispatch',
          p.room_id,
          runContext.agent_id,
          err?.code || 'runtime_dispatch_error',
          err?.message ?? String(err),
        );
      }
      return;
    }

    if (delegationEnabled && persistentChat && this.#chatSessionManager && p.room_id) {
      // Responder identity: the matched managed agent when fan-out delivered
      // the event for one, otherwise this manager's own agent_id. Threaded
      // into the chat session key so multiple agents in the same room don't
      // share one CLI session.
      const responderAgentId = agentContext?.agent_id || loadAgentInfo()?.agent_id || '';
      try {
        const result = await this.#chatSessionManager.dispatch({
          roomId: p.room_id,
          agentId: responderAgentId,
          senderId: p.sender_id || '',
          senderName: p.sender_name || '',
          messageId: p.message_id || p.id || '',
          createdAt: p.created_at || '',
          content: p.content || '',
          rolePrompt: p.role_prompt || '',
          roomName: typeof p.room_name === 'string' ? p.room_name : '',
          // ticket e6d32e9d: Action Run rooms get "do the work directly" prompts.
          isActionRoom: !!p.is_action_room,
          onProgress,
          agentContext: runContext,
          runtimeProfile,
          provisionedWorkFolder,
          attachments: Array.isArray(p.attachments) ? p.attachments : [],
          // ticket 89716f04 — thread run identity so the session's turn end is
          // swept for orphaned background tasks (one-shot run, no re-invocation).
          // ticket 9fd27487: kind:'chat'은 의도적으로 제외한다 — 일반 채팅방은
          // complete_*_run 생명주기가 없는 계속 진행 중인 대화이므로(RunSessionBinding
          // 참고), 여기서 바인딩해 버리면 sweep이 에이전트의 정당한 장기 백그라운드
          // 작업까지 걷어가 버린다.
          // ticket 2dc3c62f: kind:'orchestration' 도 제외 — RunSessionBinding.kind
          // 타입 자체가 'qa'|'security'|'action'만 받고(base-session-manager.ts),
          // report_orchestration_step은 step_id 기반이라 이 run_id/workspace_id
          // 바인딩 계약과 모양이 다르다(run-provisioner.ts의 RunProvisionKind
          // 문서 참고).
          run: runProvision && runProvision.kind !== 'chat' && runProvision.kind !== 'orchestration'
            ? {
                kind: runProvision.kind,
                run_id: runProvision.run_id,
                workspace_id: runProvision.workspace_id,
              }
            : undefined,
          // ticket e9d0e8bc: release the run lock when this session's process
          // exits. Only wired when a run lock is held; undefined for chat turns.
          onExit: runLock ? () => runLock!.release() : undefined,
        });
        // Record into ring AFTER dispatch so the spawn path sees real prior
        // history rather than self-referencing the message that triggered it.
        this.#chatSessionManager?.recordRoomMessage(p);
        if (result.dispatched) {
          // The session now owns the run lock; its exit hook releases it.
          runLockTransferred = !!runLock;
          log(
            `Chat room message dispatched to session: room=${p.room_id} ` +
              `agent=${responderAgentId.slice(0, 8)} pid=${result.pid}` +
              `${result.firstTurn ? ' (new session)' : ''}`,
          );
          return;
        }
        if (result.reason === 'duplicate_chat') {
          log(
            `Chat room message deduped: room=${p.room_id} sender=${p.sender_id} ts=${p.created_at || ''}`,
          );
          return;
        }
        log(
          `Chat room session dispatch declined (${result.reason}), falling back to legacy path`,
        );
      } catch (err: any) {
        log(
          `Chat room session path failed: ${err?.message ?? err}, falling back to legacy path`,
        );
      }
    }

    const canDelegate =
      delegationEnabled && this.#subagentManager && this.#subagentManager.canSpawn();

    if (canDelegate && this.#subagentManager) {
      try {
        await this.#setChatRoomTyping(p.room_id, true, 'thinking', roomResponderId);
        const history = await fetchChatRoomHistory(this.#config, p.room_id);
        const rolePrompt = p.role_prompt || '';
        // Oneshot fallback path (Codex / Antigravity / non-persistent Claude):
        // prep attachments WITHOUT image fetches — there's no vision
        // content block surface here, so images degrade to metadata_only.
        // Text-ish attachments still get inlined into the prompt.
        const prepared = await prepareChatAttachments(
          this.#config,
          p.room_id,
          Array.isArray(p.attachments) ? p.attachments : [],
          { fetchImages: false },
        );
        // Oneshot fallback CLIs are typically codex / antigravity (claude takes
        // the persistent path above). Match the reply-channel instruction to
        // whether this CLI can call the AWB MCP tool itself.
        const usesNativeMcp = createAdapter(agentContext?.cli).has(ADAPTER_CAPABILITIES.NATIVE_MCP);
        const taskText =
          this.#prompts?.composeChatRoomPrompt(
            p.room_id,
            history,
            {
              content: p.content || '',
              sender_name: p.sender_name || '',
              sender_id: p.sender_id || '',
            },
            prepared,
            usesNativeMcp,
            // No history-attachment map / room title on the oneshot path; pass
            // through only the Action-room flag (ticket e6d32e9d) so a codex /
            // antigravity Action Run also gets "do the work directly" prompts.
            undefined,
            '',
            !!p.is_action_room,
            provisionedWorkFolder,
          ) ?? `[chat_room] ${p.content || ''}`;

        const result = await this.#subagentManager.spawn({
          kind: 'chat',
          taskText,
          rolePrompt,
          chatRequestId: p.message_id || p.id || `msg:${p.sender_id}:${p.created_at || ''}`,
          ticketId: '',
          agentId: agentContext?.agent_id || '',
          roomId: p.room_id || '',
          agentContext: runContext,
          runtimeProfile,
          // ticket e9d0e8bc: release the run lock when this oneshot exits.
          onExit: runLock ? () => runLock!.release() : undefined,
          // ticket 55d3063f: thread run identity so the oneshot exit handler
          // sweeps this turn end for orphaned background tasks (one-shot run,
          // no re-invocation) — the twin of the persistent path's `run` above.
          // ticket 9fd27487: kind:'chat' 제외 — persistent 경로 위쪽의 동일한
          // 가드 참고(RunSessionBinding에는 'chat' 멤버가 없다).
          // ticket 2dc3c62f: kind:'orchestration' 도 제외 — RunSessionBinding.kind
          // 타입 자체가 'qa'|'security'|'action'만 받고(base-session-manager.ts),
          // report_orchestration_step은 step_id 기반이라 이 run_id/workspace_id
          // 바인딩 계약과 모양이 다르다(run-provisioner.ts의 RunProvisionKind
          // 문서 참고).
          run: runProvision && runProvision.kind !== 'chat' && runProvision.kind !== 'orchestration'
            ? {
                kind: runProvision.kind,
                run_id: runProvision.run_id,
                workspace_id: runProvision.workspace_id,
              }
            : undefined,
        });

        if (result.spawned) {
          // The oneshot now owns the run lock; its exit hook releases it.
          runLockTransferred = !!runLock;
          await this.#setChatRoomTyping(p.room_id, true, 'composing reply', roomResponderId);
          log(
            `Chat room message dispatched to subagent: room=${p.room_id} pid=${result.pid}`,
          );
          return;
        }
        log(
          `Chat room subagent spawn declined (${result.reason}); no further fallback in standalone mode`,
        );
      } catch (err: any) {
        log(`Chat room delegation path failed: ${err?.message ?? err}; dropping`);
      }
    }

    log(
      `Chat room message dropped (no delegation path): room=${p.room_id} sender=${p.sender_name || p.sender_id}`,
    );
    } finally {
      // Release the run lock unless a spawned subagent took ownership above (its
      // exit hook releases it then). Idempotent + no-op for ordinary chat turns
      // (runLock null), so this safely covers every non-spawn exit path.
      if (runLock && !runLockTransferred) runLock.release();
    }
  }
}
