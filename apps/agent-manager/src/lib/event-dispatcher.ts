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
  postFsResponse,
  postChatRoomMessage,
} from './rest.js';
import { recordEvent } from './event-log-recorder.js';
import type { AwbConfig } from './rest.js';
import type { RunSessionBinding } from './base-session-manager.js';
import type { ManagedAgentContextRegistry } from './managed-agent-context.js';
import type { WorktreeManager, WorktreeMode } from './worktree-manager.js';
import { prepareChatAttachments } from './chat-attachment-prep.js';
import { injectWorkFolder } from './prompts.js';
import type { HarnessSpec, ResolvedEffortPreset, EffortLevel } from './cli-adapters/base.js';
import { createAdapter, ADAPTER_CAPABILITIES } from './cli-adapters/index.js';
import { EnvironmentProvisioner } from './environment-provisioner.js';
import type { ResolvedEnvironmentConfig } from './environment-provisioner.js';
import {
  parseRunProvision,
  provisionRunWorkspace,
  reconcileRunBaseWorkingDir,
  resolveRunFolder,
} from './run-provisioner.js';
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
): { url: string; branch: string } | null {
  const repo = baseRepo && typeof baseRepo === 'object' ? baseRepo as any : null;
  const ticketUrl = typeof repo?.url === 'string' ? repo.url.trim() : '';
  if (ticketUrl) {
    const branch = (typeof baseBranch === 'string' ? baseBranch.trim() : '')
      || (typeof repo?.default_branch === 'string' ? repo.default_branch.trim() : '');
    return { url: ticketUrl, branch };
  }
  const boardRepo = environment?.repositories[0];
  return boardRepo ? { url: boardRepo.url, branch: boardRepo.branch } : null;
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
//   - run with cwd = the agent's working_dir (project root)
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
}

export interface TicketDispatchResult {
  dispatched: boolean;
  pid?: number;
  firstTurn?: boolean;
  reason?: string;
}

export interface TicketSessionManager {
  dispatchTrigger(args: TicketTriggerArgs): Promise<TicketDispatchResult>;
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
  // ticket 9f26f091 — per-(ticket,role) git worktree isolation. When set, a
  // trigger for a managed agent runs under a dedicated worktree cwd instead
  // of the agent's shared working_dir, so branch switches can't bleed across
  // tickets on focus transitions. Optional/null reverts to shared-cwd.
  worktreeManager?: WorktreeManager | null;
  // ticket 354d336b — board environment provisioner. When set, a trigger that
  // carries a resolved environment_config provisions the agent's working
  // environment (clone/update repos, run setup commands) before the spawn.
  // Optional/null reverts to no provisioning (current behaviour).
  environmentProvisioner?: EnvironmentProvisioner | null;
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
  #environmentProvisioner: EnvironmentProvisioner | null;
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
    this.#environmentProvisioner = deps.environmentProvisioner ?? null;
  }

  /**
   * ticket 9f26f091: rewrite a managed agent's execution-context cwd to a
   * dedicated per-(ticket,role) git worktree before a trigger spawn. The
   * worktree dir is deterministic, so a fresh spawn after an idle-reap / unpend
   * reattaches to the SAME tree (branch + uncommitted work intact) — the
   * follow-up reuse path doesn't re-spawn, so it stays in the worktree the live
   * child already holds. Mutates the passed context object in place (it is a
   * fresh literal from #resolveAgentContext, never the registry record). No-op
   * when worktree isolation is disabled, the agent isn't managed, or git
   * worktree is unavailable (falls back to the shared working_dir).
   */
  async #applyWorktreeCwd(
    agentContext: AgentExecutionContext | undefined,
    ticketId: string | undefined,
    role: string | undefined,
    mode: WorktreeMode | undefined,
    poolSize: number | undefined,
    bootstrapRepo: { url: string; branch?: string } | null,
  ): Promise<void> {
    if (!agentContext || !this.#worktreeManager || !ticketId || !role) return;
    if ((this.#config as any)?.delegation?.worktreeIsolation === false) return;
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
        agentContext.cwd = res.cwd;
      } else if (res.reason && res.reason !== 'disabled') {
        log(
          `[worktree] isolation skipped for ticket=${ticketId.slice(0, 8)} role=${role}: ${res.reason} — using shared cwd ${agentContext.cwd}`,
        );
      }
    } catch (err: any) {
      log(`[worktree] resolveCwd failed (${err?.message ?? err}); using shared cwd`);
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
    if (!this.#worktreeManager || !this.#worktreeManager.enabled) return;
    if ((this.#config as any)?.delegation?.worktreeIsolation === false) return;
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
  async #cleanupArchivedTicketWorkspace(ticketId: string): Promise<void> {
    if (!this.#worktreeManager || !this.#worktreeManager.enabled) return;
    if ((this.#config as any)?.delegation?.worktreeIsolation === false) return;
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

    // ticket 9f26f091: route this ticket into its own git worktree so a branch
    // switch here can't contaminate another ticket sharing the agent's
    // working_dir. worktree 규약 ②: the worktree lands under
    // `<working_dir>/.awb/wt/`, per_ticket|shared picked from the board mode the
    // server flattened onto the event. Both the persistent ticket-session and
    // one-shot subagent fallback below read agentContext.cwd, so one rewrite
    // covers both paths.
    await this.#applyWorktreeCwd(
      agentContext,
      ev.ticket_id,
      ev.action,
      parseWorktreeMode(ev.worktree_mode),
      typeof ev.max_concurrent_tickets_per_agent === 'number'
        ? ev.max_concurrent_tickets_per_agent
        : undefined,
      resolveBootstrapRepository(ev.base_repo, ev.base_branch, envConfig),
    );

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

    // Board environment setup (ticket 354d336b). The server ships the resolved
    // environment_config (repos with concrete urls, env_vars, setup_commands).
    // Provision the agent's working environment BEFORE either spawn path runs —
    // clone/update repos under the agent home and run setup commands, once per
    // (agent, config-fingerprint). env_vars apply on EVERY dispatch (process
    // env, not persisted on disk) so they're threaded to the spawn regardless
    // of whether provisioning ran or was skipped. A provisioning FAILURE aborts
    // the dispatch (never start work in a broken environment) and surfaces the
    // error as a ticket comment.
    const envVars = envConfig?.env_vars && Object.keys(envConfig.env_vars).length > 0
      ? envConfig.env_vars
      : undefined;
    if (envConfig && this.#environmentProvisioner) {
      const provisionAgentId = agentContext?.agent_id || selfAgentId;
      if (!provisionAgentId) {
        log(`[env-provision] no agent id resolvable for ticket=${ev.ticket_id} — skipping provisioning`);
      } else {
        log(
          `Trigger carries environment_config: ticket=${ev.ticket_id} repos=${envConfig.repositories.length} setup=${envConfig.setup_commands.length} env_vars=${Object.keys(envConfig.env_vars).length}`,
        );
        const result = await this.#environmentProvisioner.provision({
          agentId: provisionAgentId,
          config: envConfig,
          ticketId: ev.ticket_id,
        });
        if (!result.ok) {
          if (!result.reported && ev.ticket_id) {
            const detail = (result.steps.length > 0 ? `\n\n실행 단계:\n${result.steps.map((s) => `- ${s}`).join('\n')}` : '');
            await fireAndForgetTool(this.#config, 'add_comment', {
              ticket_id: ev.ticket_id,
              content:
                `⚠️ **환경 프로비저닝 실패** — 작업을 시작하지 않고 디스패치를 중단했습니다.\n\n` +
                `\`\`\`\n${result.error || 'unknown error'}\n\`\`\`${detail}\n\n` +
                `Board 환경설정(repositories / setup_commands)을 확인한 뒤 다시 트리거하세요. ` +
                `(fingerprint=\`${result.fingerprint.slice(0, 12)}\`, 약 5분 동안 재시도/재알림을 억제합니다.)`,
            });
          }
          log(
            `Trigger aborted — environment provisioning failed: ticket=${ev.ticket_id} fp=${result.fingerprint.slice(0, 8)} reported=${result.reported === true}`,
          );
          return;
        }
        if (!result.skipped) {
          log(`Environment provisioned for ticket=${ev.ticket_id} fp=${result.fingerprint.slice(0, 8)}`);
        }
      }
    }

    const delegation = (this.#config as any)?.delegation ?? {};
    const delegationEnabled = delegation.enabled !== false;
    const persistentTicket = delegation.persistentTicketSessions !== false;

    if (delegationEnabled && persistentTicket && this.#ticketSessionManager) {
      try {
        const ticket = await fetchTicketContext(this.#config, ev.ticket_id);
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
        void this.#cleanupArchivedTicketWorkspace(ev.ticket_id);
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
