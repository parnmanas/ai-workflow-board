// Routes parsed SSE events (trigger / chat_request / chat_room_message /
// board_update / comment_mention / fs_request) to the appropriate session or
// subagent manager. Extracted from EventStream so the SSE pipe can stay a thin
// connect/parse loop.
//
// Standalone-mode note: agent-manager does not have a Claude CLI on stdin to
// notify, so the legacy "sendChannelEvent fallback to main session" branches
// from claude-plugin's daemon.mjs are intentionally absent. When no delegation
// path is available, events are simply logged.

import { log } from './logging.js';
import { loadAgentInfo } from './config.js';
import {
  fetchTicketContext,
  fetchChatRoomHistory,
  fetchAgentRecord,
  fetchRepositoryCredential,
  postFsResponse,
  postChatRoomMessage,
  postDispatchAck,
} from './rest.js';
import { recordEvent } from './event-log-recorder.js';
import type { AwbConfig } from './rest.js';
import type { RunSessionBinding } from './base-session-manager.js';
import type { ManagedAgentContextRegistry } from './managed-agent-context.js';
import type { WorktreeManager, WorktreeMode } from './worktree-manager.js';
import { prepareChatAttachments } from './chat-attachment-prep.js';
import { injectWorkFolder } from './prompts.js';
import { DispatchBlockerTracker, InflightDispatchTracker, RoleSpawnSuppressor, classifyWorktreeOutcome, managedWorktreePath, provisioningPendReason } from './dispatch-preflight.js';
import type { HarnessSpec, ResolvedEffortPreset, EffortLevel } from './cli-adapters/base.js';
import { createAdapter, ADAPTER_CAPABILITIES } from './cli-adapters/index.js';
import {
  parseRunProvision,
  provisionRunWorkspace,
  reconcileRunBaseWorkingDir,
  resolveRunFolder,
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
  for (const key of ['codex', 'antigravity'] as const) {
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

// Hard cap on consecutive agent-to-agent turns within a single chat room.
// Server stamps `agent_chain_depth` on every chat_room_message; when the depth
// reaches the cap we record into history but stop delegating — the chain
// resets when a user sends the next message.
const AGENT_CHAIN_DEPTH_CAP = 3;

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
  /** Per-agent default model (Agent.model). Passed into the adapter build
   *  spec so the spawned subagent / session runs under `--model <id>`.
   *  null/undefined = the CLI's own default (no flag). */
  model?: string | null;
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
  /** Chat room id for one-shot chat spawns. When set, non-MCP adapters
   *  (codex, antigravity) post their collected result to this room via REST
   *  instead of as a ticket comment. */
  roomId?: string;
  /** ST-6: per-event managed-agent runtime context. Optional. */
  agentContext?: AgentExecutionContext;
  /** Resolved board/workspace harness from the trigger event (e9c7a896).
   *  Null/absent → spawn exactly as before. */
  harness?: HarnessSpec | null;
  /** Ticket-level abstract effort preset, resolved server-side and shipped on
   *  the trigger event (`effort_preset`). SEPARATE channel from `harness`; the
   *  spawn site picks the per-CLI slice via selectEffortSlice. Null/absent →
   *  no effort override. */
  effortPreset?: ResolvedEffortPreset | null;
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
}

export interface SubagentSpawnResult {
  spawned: boolean;
  pid?: number;
  reason?: string;
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
  onProgress?: (stage: string) => void;
  /** ST-6: per-event managed-agent runtime context. When set, the chat
   *  session spawns under this agent's identity (apiKey + cwd + cli) so the
   *  reply is attributed to the right agent and lands in the room they're
   *  a member of. Undefined when the manager itself is the participant. */
  agentContext?: AgentExecutionContext;
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
  /** Ticket-level abstract effort preset (`effort_preset`). Like harness it is
   *  applied at SESSION CREATION only — a live session's `--effort` flag is
   *  fixed at spawn. Null/absent → no effort override. */
  effortPreset?: ResolvedEffortPreset | null;
  /** Non-secret env vars from the board environment_config (ticket 354d336b),
   *  injected into the spawned CLI's environment at SESSION CREATION. A live
   *  session keeps the env it was born with. Absent → none. */
  envVars?: Record<string, string>;
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
  /** Release a reservation placed by tryReserveDispatch (live===false). Idempotent. */
  releaseDispatch?(ticketId: string, role: string, agentId: string): void;
  /** targetAgentId — comment_mention 이벤트의 수신 agent(per-agent 스코프).
   *  식별되면 그 agent 의 세션에만 주입하고, 라이브 세션이 없으면 false 를
   *  반환해 one-shot 스폰 경로를 살린다(멘션 swallow/오배달 방지, T7 리뷰 #3). */
  forwardCommentMention(ticketId: string, mention: any, targetAgentId?: string): boolean;
  forwardBoardUpdate(ticketId: string, ev: any): boolean;
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
  ): string;
  composeChatPrompt(
    rolePrompt: string,
    history: any[],
    newMessage: string,
    roomId?: string,
    usesNativeMcp?: boolean,
  ): string;
  composeChatRoomPrompt(
    roomId: string,
    history: any[],
    msg: { content: string; sender_name: string; sender_id: string },
    attachments?: any[],
    usesNativeMcp?: boolean,
    historyAttachments?: Map<any, any[]>,
    roomName?: string,
    isActionRoom?: boolean,
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
    this.#inflightDispatch = deps.inflightDispatchTracker ?? new InflightDispatchTracker();
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
  ): Promise<{ ok: boolean; reason?: string; blockerKind?: string; detail?: string; path?: string }> {
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
        return { ok: true };
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

  /**
   * ticket 9f26f091: when a ticket lands in a terminal column (done/merged),
   * force-remove its per-(ticket,role) worktrees across every managed agent
   * this manager owns — regardless of dirty state. Terminal-ness is read from
   * the server-maintained `Ticket.terminal_entered_at` (stamped on entering a
   * terminal column, cleared on leaving), so a position reorder inside a
   * non-terminal column or a bounce back out to In Progress never triggers
   * cleanup. The work is committed to the ticket's branch (or already merged)
   * by the time it's terminal, so the checkout is disposable: the branch ref
   * survives in the base repo even after its worktree is gone. Best-effort and
   * fire-and-forget; never throws.
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
        total += await this.#worktreeManager.removeTicketWorktrees({
          baseWorkingDir: ctx.working_dir,
          ticketId,
          repositoryResourceId: ticket.base_repo?.id,
        });
      }
      if (total > 0) {
        log(
          `[worktree] terminal ticket=${ticketId.slice(0, 8)} reclaimed ${total} worktree(s)`,
        );
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
      api_key: ctx.api_key,
      cwd: ctx.working_dir,
      mcp_config_path: ctx.mcp_config_path,
      cli: ctx.cli || 'claude',
      cli_home_dir: ctx.cli_home_dir,
      extra_env: ctx.extra_env,
      credential_provider: ctx.credential_provider ?? null,
      model: ctx.model ?? null,
    };
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
  #resolveAgentContextFromMembers(memberIds: string[]): AgentExecutionContext | undefined {
    if (!memberIds.length || !this.#managedAgentContexts) return undefined;
    for (const id of memberIds) {
      const ctx = this.#resolveAgentContext(id);
      if (ctx) return ctx;
    }
    return undefined;
  }

  /**
   * Self-gate for chat replies. A message counts as "self" when the sender is
   * either this manager's own agent_id OR one of the managed agents it
   * supervises — the latter is what stops a managed agent's reply from
   * triggering yet another spawn (until the chain-depth cap finally kicks in).
   */
  #senderIsSelf(senderId: string | undefined | null): boolean {
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
    // construct one here with empty config so browsing still works (the
    // FsBrowser default is unrestricted-from-$HOME). Logged once when it
    // happens so the wiring bug is visible.
    if (!this.#fsBrowser) {
      log('handleFsRequest: no FsBrowser wired — lazy-constructing a default. Fix main.ts wiring.');
      const { FsBrowser } = await import('./fs-browser.js');
      this.#fsBrowser = new FsBrowser(this.#config, null);
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

  async handleTrigger(raw: string): Promise<void> {
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
    const agentContext = this.#resolveAgentContext(eventAgentId);
    const envConfig = parseEnvironmentConfig(ev.environment_config);
    if (
      selfAgentId &&
      eventAgentId &&
      selfAgentId !== eventAgentId &&
      !agentContext
    ) {
      log(`Trigger dropped (not for this agent): target=${eventAgentId} self=${selfAgentId}`);
      return;
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
        reservation = { acquired: acq.acquired, live: false };
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
          fireAndForgetTool(this.#config, 'add_comment', {
            ticket_id: ev.ticket_id,
            content:
              '⚠️ **중복 dispatch 억제 (동일 ticket-role live twin 방지)** — 이미 이 ' +
              '(ticket, role) 에 대한 dispatch 가 프로비저닝/spawn 진행 중이라, ' +
              'supervisor 재시도로 도착한 새 트리거를 spawn 전에 억제했습니다. ' +
              '진행 중인 dispatch 가 세션을 새로 만들거나 재사용하며, 억제된 ' +
              'force-respawn 요청은 완료 직후 1회 재실행됩니다. (ticket 3d180f85)',
          });
        }
        return;
      }
    }
    // We placed a reservation to release only when live===false (a fresh spawn);
    // a live reuse placed nothing.
    const reservedFresh = !!reservation && reservation.acquired && !reservation.live;
    try {
      await this.#dispatchTriggerBody(
        ev,
        agentContext,
        envConfig,
        canAuthoritative && reservedFresh,
      );
    } finally {
      if (inflightKey) {
        if (reservedFresh) {
          if (canAuthoritative) {
            this.#ticketSessionManager!.releaseDispatch!(ev.ticket_id, ev.action || '', dispatchAgentId);
          } else {
            this.#inflightDispatch.releaseFallback(inflightKey);
          }
        }
        // Re-arm activity surfacing and replay a single suppressed force-respawn
        // (blocker #1): a force_respawn that arrived while this dispatch held the
        // slot had its fresh-session intent suppressed, and the server may not
        // re-send it (a prior dispatch refreshing the live session can clear the
        // stale supervisor condition). Replay it exactly once now, coalescing a
        // whole burst into one fresh respawn. Re-parse the SUPPRESSED FORCE
        // event's OWN payload (captured at suppression time), NOT the holder's
        // `raw`: the holder already recorded `trigger:<its field_changed>` in the
        // dedup set (kept until child exit), so replaying the holder identity here
        // is dropped as `duplicate_trigger` and the respawn silently never
        // happens. The suppressed force never reached dispatchTrigger, so its own
        // identity is un-deduped and re-enters cleanly to force-respawn.
        const { pendingForceRaw } = this.#inflightDispatch.onRelease(inflightKey);
        if (pendingForceRaw) {
          log(
            `[dispatch] replaying suppressed force_respawn after holder released: ` +
              `ticket=${ev.ticket_id.slice(0, 8)} role=${ev.action || '_'}`,
          );
          let forcedRaw: string | null = null;
          try {
            forcedRaw = JSON.stringify({ ...JSON.parse(pendingForceRaw), force_respawn: true });
          } catch {
            forcedRaw = null;
          }
          if (forcedRaw) {
            // Fire-and-forget so we don't extend this finally; the replay re-enters
            // handleTrigger cleanly (re-acquires the slot, force-respawns fresh).
            this.handleTrigger(forcedRaw).catch((err: any) =>
              log(`[dispatch] force_respawn replay failed: ${err?.message ?? err}`),
            );
          }
        }
      }
    }
  }

  /** Provision → spawn body of a ticket trigger (ticket 3d180f85), run under the
   *  single-flight reservation handleTrigger acquired. Split out so one
   *  try/finally in handleTrigger straddles the whole provisioning window —
   *  every `return` / `throw` in here releases the slot. `dispatchReserved` is
   *  true when handleTrigger holds the authoritative `_inflight` reservation for
   *  this key, so the persistent dispatchTrigger below must defer `_inflight`
   *  ownership to the dispatcher. */
  async #dispatchTriggerBody(
    ev: any,
    agentContext: AgentExecutionContext | undefined,
    envConfig: ResolvedEnvironmentConfig | null,
    dispatchReserved: boolean,
  ): Promise<void> {
    // ticket 9f26f091: route this ticket into its own git worktree so a branch
    // switch here can't contaminate another ticket sharing the agent's
    // working_dir. worktree 규약 ②: the worktree lands under
    // `<working_dir>/.awb/wt/`, per_ticket|shared picked from the board mode the
    // server flattened onto the event. Both the persistent ticket-session and
    // one-shot subagent fallback below read agentContext.cwd, so one rewrite
    // covers both paths.
    const selectedRepo = resolveBootstrapRepository(ev.base_repo, ev.base_branch, envConfig);
    const repoCredential = selectedRepo?.resourceId && agentContext?.agent_id
      ? await fetchRepositoryCredential(this.#config, selectedRepo.resourceId, agentContext.agent_id)
      : null;
    const worktreeProvision = await this.#applyWorktreeCwd(
      agentContext,
      ev.ticket_id,
      ev.action,
      parseWorktreeMode(ev.worktree_mode),
      typeof ev.max_concurrent_tickets_per_agent === 'number'
        ? ev.max_concurrent_tickets_per_agent
        : undefined,
      selectedRepo ? { ...selectedRepo, credential: repoCredential } : null,
    );
    if (!worktreeProvision.ok) {
      const blockerKind = worktreeProvision.blockerKind || `worktree:${worktreeProvision.reason || 'unknown'}`;
      // Record the abort per (ticket,role) so the next supervisor re-trigger is
      // suppressed at the gate above — even when the comment below is de-duped.
      const provisionBlock = this.#spawnSuppressor.note(ev.ticket_id, ev.action, blockerKind, Date.now());
      if (ev.ticket_id && this.#dispatchBlockers.shouldComment(ev.ticket_id, blockerKind)) {
        const detailLine = worktreeProvision.detail ? `\n세부: \`${worktreeProvision.detail}\`` : '';
        // Managed, working_dir-relative (credential-free) checkout path that
        // failed verification — completion criterion #5 ("실패 경로").
        const pathLine = worktreeProvision.path ? `\n경로: \`${worktreeProvision.path}\`` : '';
        await fireAndForgetTool(this.#config, 'add_comment', {
          ticket_id: ev.ticket_id,
          content:
            `⚠️ **티켓 worktree 준비 실패** — 유효한 Git 체크아웃을 확보하지 못해 에이전트를 실행하지 않고 디스패치를 중단했습니다.\n\n` +
            `원인: \`${worktreeProvision.reason || 'unknown error'}\`${detailLine}${pathLine}\n\n` +
            `repository resource, credential과 working_dir 아래 AWB 관리 폴더(\`.awb/base\`, \`.awb/wt\`)를 확인한 뒤 다시 트리거하세요.\n\n` +
            `_동일 오류로 인한 supervisor 자동 재트리거는 백오프로 억제됩니다 — 환경을 고친 뒤 코멘트/수동 트리거로 재개하세요._`,
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

    // Board/workspace harness resolved server-side and flattened onto the
    // event (e9c7a896). Parsed once here; both the persistent-session and
    // one-shot paths below ship it to their spawn site.
    const harness = parseHarnessConfig(ev.harness_config);
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
    const envVars = envConfig?.env_vars && Object.keys(envConfig.env_vars).length > 0
      ? envConfig.env_vars
      : undefined;

    const delegation = (this.#config as any)?.delegation ?? {};
    const delegationEnabled = delegation.enabled !== false;
    const persistentTicket = delegation.persistentTicketSessions !== false;

    if (delegationEnabled && persistentTicket && this.#ticketSessionManager) {
      try {
        const ticket = await fetchTicketContext(this.#config, ev.ticket_id);
        if (ticket && selectedRepo) {
          ticket.base_repo = { id: selectedRepo.resourceId, name: '', url: selectedRepo.url, default_branch: selectedRepo.branch };
          ticket.base_branch = selectedRepo.branch;
        }
        const rolePrompt = ev.role_prompt || '';
        const ticketPrompt = ev.ticket_prompt || '';
        const columnPrompt = ev.column_prompt || null;

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
          effortPreset,
          envVars,
          maxConcurrentTicketsPerAgent:
            typeof ev.max_concurrent_tickets_per_agent === 'number'
              ? ev.max_concurrent_tickets_per_agent
              : undefined,
        });

        if (result.dispatched) {
          log(
            `Trigger dispatched to ticket session: ticket=${ev.ticket_id} pid=${result.pid}${result.firstTurn ? ' (new session)' : ''}`,
          );
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
        log(
          `Ticket session dispatch declined (${result.reason}), falling back to one-shot subagent`,
        );
      } catch (err: any) {
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
          effortPreset,
          envVars,
        });

        if (result.spawned) {
          log(`Trigger dispatched to subagent: ticket=${ev.ticket_id} pid=${result.pid}${agentContext ? ` agent=${agentContext.agent_id.slice(0, 8)}` : ''}`);
          // Durable dispatch ack (ticket e7c87517): one-shot subagent spawned →
          // processed (grace extension, not resolution).
          this.#ackDispatch(ev, 'processed');
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
  #ackDispatch(ev: any, outcome: 'processed' | 'nack', reason?: string): void {
    void postDispatchAck(this.#config, {
      ticket_id: String(ev?.ticket_id || ''),
      role: String(ev?.action || ''),
      trigger_id: String(ev?.field_changed || ''),
      outcome,
      reason: reason ? String(reason).slice(0, 500) : '',
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
    const agentContext = this.#resolveAgentContext(payload.agent_id || '');
    const delegation = (this.#config as any)?.delegation ?? {};
    const delegationEnabled = delegation.enabled !== false;
    const persistentChat = delegation.persistentChatSessions !== false;

    if (
      delegationEnabled &&
      persistentChat &&
      this.#chatSessionManager &&
      payload.room_id
    ) {
      const onProgress = (stage: string): void => {
        const status = stage === 'thinking' ? 'thinking' : 'composing reply';
        this.#setChatRoomTyping(payload.room_id, true, status).catch(() => {});
      };
      try {
        const result = await this.#chatSessionManager.dispatch({
          roomId: payload.room_id,
          agentId: payload.agent_id || agentContext?.agent_id || loadAgentInfo()?.agent_id || '',
          senderId: payload.user_id || '',
          senderName: '',
          createdAt: ev.timestamp || '',
          content: payload.new_message || '',
          rolePrompt: payload.role_prompt || '',
          onProgress,
          agentContext,
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
      const usesNativeMcp = createAdapter(agentContext?.cli).has(ADAPTER_CAPABILITIES.NATIVE_MCP);
      const taskText =
        this.#prompts?.composeChatPrompt(
          rolePrompt,
          history,
          newMessage,
          payload.room_id || '',
          usesNativeMcp,
        ) ?? `[chat] ${newMessage}`;

      try {
        const result = await this.#subagentManager.spawn({
          kind: 'chat',
          taskText,
          rolePrompt,
          chatRequestId: payload.user_id
            ? `msg:${payload.user_id}:${ev.timestamp || ''}`
            : undefined,
          ticketId: payload.ticket_id || '',
          agentId: payload.agent_id || '',
          roomId: payload.room_id || '',
          agentContext,
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

    const ticketId = ev.ticket_id || '';
    const commentId = ev.comment_id || ev.field_changed || '';
    const agentId = ev.agent_id || ev.actor_name || '';
    const agentContext = this.#resolveAgentContext(agentId);
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
        });
        if (result.spawned) {
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

  async #setChatRoomTyping(
    roomId: string,
    isTyping: boolean,
    status: string | null = null,
  ): Promise<void> {
    try {
      const agentInfo = loadAgentInfo();
      const url = `${this.#config.url.replace(/\/$/, '')}/api/agent/chat-rooms/${encodeURIComponent(roomId)}/typing`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'X-Agent-Key': this.#config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: agentInfo?.agent_id || '',
          agent_name:
            agentInfo?.agent_name || (agentInfo as any)?.name || 'Agent',
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

    // Resolve which managed agent (if any) should respond. Manager-fan-out
    // delivers chat events for any room where one of this manager's managed
    // agents is a member; the wire payload's agent_member_ids is the set we
    // pick from. When no managed agent matches we fall through to the
    // manager's own identity, which is the right behavior for rooms where
    // the manager itself is a participant.
    const memberIds: string[] = Array.isArray(p.agent_member_ids) ? p.agent_member_ids : [];
    const agentContext = this.#resolveAgentContextFromMembers(memberIds);

    // Two early-exit cases for agent-sent messages — both still record into
    // the chat ring so future dispatches see complete history:
    //   1. Self-message: never reply to a send from this manager OR any of
    //      its own managed agents (otherwise a managed agent's reply would
    //      trigger another spawn until the chain-depth cap kicks in).
    //   2. Loop guard: server-stamped `agent_chain_depth` reached the cap.
    if (p.sender_type === 'agent') {
      if (this.#senderIsSelf(p.sender_id)) {
        this.#chatSessionManager?.recordRoomMessage(p);
        log(
          `Chat room message from self (${p.sender_name || p.sender_id}) — skipping delegation`,
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

    // QA/security run-workspace provisioning (ticket 25db3cc6). A run-dispatch
    // chat_room_message carries a `run_provision` hint: prepare the working
    // folder (clone / fetch+ff-pull, reuse vs fresh) BEFORE spawning so the run
    // never improvises a folder. The prepared absolute path is pinned as the
    // subagent cwd, matching the folder the server-rendered prompt already names.
    // On failure, abort the dispatch, finalize the run as `error`, and post a
    // room message — the chat-room twin of the ticket-trigger provisioning abort.
    // An ordinary chat turn carries no run_provision → runContext stays untouched.
    let runContext = agentContext;
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
        const completeTool = runProvision.kind === 'qa' ? 'complete_qa_run' : 'complete_security_run';
        await fireAndForgetTool(this.#config, completeTool, {
          run_id: runProvision.run_id,
          workspace_id: runProvision.workspace_id,
          status: 'error',
          summary: `작업폴더 프로비저닝 실패: ${result.error || 'unknown error'}`,
        });
        if (p.room_id) await this.#setChatRoomTyping(p.room_id, false, '').catch(() => {});
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
    }

    // Three-stage typing contract:
    //   reading   — set immediately on receive
    //   thinking  — first stdout from subagent
    //   composing — first assistant content
    if (p.room_id) {
      await this.#setChatRoomTyping(p.room_id, true, '👀 reading context');
    }

    const onProgress = p.room_id
      ? (stage: string): void => {
          const status = stage === 'thinking' ? 'thinking' : 'composing reply';
          this.#setChatRoomTyping(p.room_id, true, status).catch(() => {});
        }
      : undefined;

    const delegation = (this.#config as any)?.delegation ?? {};
    const delegationEnabled = delegation.enabled !== false;
    const persistentChat = delegation.persistentChatSessions !== false;

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
          createdAt: p.created_at || '',
          content: p.content || '',
          rolePrompt: p.role_prompt || '',
          roomName: typeof p.room_name === 'string' ? p.room_name : '',
          // ticket e6d32e9d: Action Run rooms get "do the work directly" prompts.
          isActionRoom: !!p.is_action_room,
          onProgress,
          agentContext: runContext,
          attachments: Array.isArray(p.attachments) ? p.attachments : [],
          // ticket 89716f04 — thread run identity so the session's turn end is
          // swept for orphaned background tasks (one-shot run, no re-invocation).
          run: runProvision
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
        await this.#setChatRoomTyping(p.room_id, true, 'thinking');
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
          ) ?? `[chat_room] ${p.content || ''}`;

        const result = await this.#subagentManager.spawn({
          kind: 'chat',
          taskText,
          rolePrompt,
          chatRequestId: `msg:${p.sender_id}:${p.created_at || ''}`,
          ticketId: '',
          agentId: agentContext?.agent_id || '',
          roomId: p.room_id || '',
          agentContext: runContext,
          // ticket e9d0e8bc: release the run lock when this oneshot exits.
          onExit: runLock ? () => runLock!.release() : undefined,
          // ticket 55d3063f: thread run identity so the oneshot exit handler
          // sweeps this turn end for orphaned background tasks (one-shot run,
          // no re-invocation) — the twin of the persistent path's `run` above.
          run: runProvision
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
          await this.#setChatRoomTyping(p.room_id, true, 'composing reply');
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
