// Routes parsed SSE events (trigger / chat_request / chat_room_message /
// board_update / comment_mention / fs_request) to the appropriate session or
// subagent manager. Extracted from EventStream so the SSE pipe can stay a thin
// connect/parse loop.
//
// Standalone-mode note: agent-manager does not have a Claude CLI on stdin to
// notify, so the legacy "sendChannelEvent fallback to main session" branches
// from claude-plugin's daemon.mjs are intentionally absent. When no delegation
// path is available, events are simply logged.

import { join } from 'node:path';
import { log } from './logging.js';
import { loadAgentInfo } from './config.js';
import {
  fetchTicketContext,
  fetchChatRoomHistory,
  postFsResponse,
} from './rest.js';
import { recordEvent } from './event-log-recorder.js';
import { MANAGED_AGENTS_DIR } from './constants.js';
import type { AwbConfig } from './rest.js';
import type { ManagedAgentContextRegistry } from './managed-agent-context.js';
import type { WorktreeManager } from './worktree-manager.js';
import { prepareChatAttachments } from './chat-attachment-prep.js';
import type { HarnessSpec, ResolvedEffortPreset, EffortLevel } from './cli-adapters/base.js';
import { createAdapter, ADAPTER_CAPABILITIES } from './cli-adapters/index.js';

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
  return Object.keys(out).length > 0 ? out : null;
}

/** Valid claude `--effort` levels. A preset slice carrying anything else has
 *  its `effort` dropped (the rest of the slice survives) so a malformed level
 *  can never reach the CLI flag. */
const EFFORT_LEVELS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);

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
    if (typeof obj.claude.effort === 'string' && EFFORT_LEVELS.has(obj.claude.effort as EffortLevel)) {
      c.effort = obj.claude.effort as EffortLevel;
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
}

export interface TicketDispatchResult {
  dispatched: boolean;
  pid?: number;
  firstTurn?: boolean;
  reason?: string;
}

export interface TicketSessionManager {
  dispatchTrigger(args: TicketTriggerArgs): Promise<TicketDispatchResult>;
  forwardCommentMention(ticketId: string, mention: any): boolean;
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
  ): Promise<void> {
    if (!agentContext || !this.#worktreeManager || !ticketId || !role) return;
    if ((this.#config as any)?.delegation?.worktreeIsolation === false) return;
    try {
      const res = await this.#worktreeManager.resolveCwd({
        baseWorkingDir: agentContext.cwd,
        worktreesRoot: join(MANAGED_AGENTS_DIR, agentContext.agent_id, 'worktrees'),
        ticketId,
        role,
      });
      if (res.isWorktree) {
        log(
          `[worktree] ticket=${ticketId.slice(0, 8)} role=${role} agent=${agentContext.agent_id.slice(0, 8)} cwd=${res.cwd}${res.reused ? ' (reused)' : ' (new)'}`,
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
      const seenRoots = new Set<string>();
      for (const ctx of this.#managedAgentContexts.list()) {
        if (!ctx.working_dir) continue;
        const worktreesRoot = join(MANAGED_AGENTS_DIR, ctx.agent_id, 'worktrees');
        const dedupeKey = `${ctx.working_dir} ${worktreesRoot}`;
        if (seenRoots.has(dedupeKey)) continue;
        seenRoots.add(dedupeKey);
        total += await this.#worktreeManager.removeTicketWorktrees({
          baseWorkingDir: ctx.working_dir,
          worktreesRoot,
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
    if (
      selfAgentId &&
      eventAgentId &&
      selfAgentId !== eventAgentId &&
      !agentContext
    ) {
      log(`Trigger dropped (not for this agent): target=${eventAgentId} self=${selfAgentId}`);
      return;
    }

    // ticket 9f26f091: route this (ticket,role) into its own git worktree so a
    // branch switch here can't contaminate another ticket sharing the agent's
    // working_dir. Both the persistent ticket-session and one-shot subagent
    // fallback below read agentContext.cwd, so one rewrite covers both paths.
    await this.#applyWorktreeCwd(agentContext, ev.ticket_id, ev.action);

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
        const forwarded = this.#ticketSessionManager.forwardCommentMention(
          ticketId,
          mention,
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
          triggerId: `mention:${commentId}`,
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
          onProgress,
          agentContext,
          attachments: Array.isArray(p.attachments) ? p.attachments : [],
        });
        // Record into ring AFTER dispatch so the spawn path sees real prior
        // history rather than self-referencing the message that triggered it.
        this.#chatSessionManager?.recordRoomMessage(p);
        if (result.dispatched) {
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
          ) ?? `[chat_room] ${p.content || ''}`;

        const result = await this.#subagentManager.spawn({
          kind: 'chat',
          taskText,
          rolePrompt,
          chatRequestId: `msg:${p.sender_id}:${p.created_at || ''}`,
          ticketId: '',
          agentId: agentContext?.agent_id || '',
          roomId: p.room_id || '',
          agentContext,
        });

        if (result.spawned) {
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
  }
}
