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
  postFsResponse,
} from './rest.js';
import { recordEvent } from './event-log-recorder.js';
import type { AwbConfig } from './rest.js';
import type { ManagedAgentContextRegistry } from './managed-agent-context.js';

// Hard cap on consecutive agent-to-agent turns within a single chat room.
// Server stamps `agent_chain_depth` on every chat_room_message; when the depth
// reaches the cap we record into history but stop delegating — the chain
// resets when a user sends the next message.
const AGENT_CHAIN_DEPTH_CAP = 3;

// ─── ST-6 per-call agent execution context ──────────────────────────────
// Manager-side multi-tenancy. When an event targets a managed agent the
// dispatcher resolves that agent's runtime context (cwd, on-disk
// mcp-config path, raw apiKey) and threads it through to every spawn site
// so child claude/codex/gemini processes:
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
  /** ST-6: per-event managed-agent runtime context. Optional. */
  agentContext?: AgentExecutionContext;
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
  senderId: string;
  senderName: string;
  createdAt: string;
  content: string;
  rolePrompt: string;
  onProgress?: (stage: string) => void;
  /** ST-6: per-event managed-agent runtime context. Optional. */
  agentContext?: AgentExecutionContext;
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
  /** ST-6: per-event managed-agent runtime context. Optional. */
  agentContext?: AgentExecutionContext;
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
  composeChatPrompt(rolePrompt: string, history: any[], newMessage: string): string;
  composeChatRoomPrompt(
    roomId: string,
    history: any[],
    msg: { content: string; sender_name: string; sender_id: string },
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

  constructor(config: AwbConfig, deps: EventDispatcherDeps = {}) {
    this.#config = config;
    this.#subagentManager = deps.subagentManager ?? null;
    this.#chatSessionManager = deps.chatSessionManager ?? null;
    this.#ticketSessionManager = deps.ticketSessionManager ?? null;
    this.#fsBrowser = deps.fsBrowser ?? null;
    this.#prompts = deps.prompts ?? null;
    this.#agentManagerCommandHandler = deps.agentManagerCommandHandler ?? null;
    this.#managedAgentContexts = deps.managedAgentContexts ?? null;
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
    };
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

    if (!this.#fsBrowser) {
      await postFsResponse(this.#config, requestId, {
        ok: false,
        error: 'fs_browser is not wired on this manager instance',
        code: 'FS_BROWSER_DISABLED',
      });
      return;
    }

    const result = await this.#fsBrowser.handle({
      op: ev.op,
      path: ev.path,
      offset: ev.offset,
      limit: ev.limit,
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
          agentContext,
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
          agentContext,
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
      const taskText =
        this.#prompts?.composeChatPrompt(rolePrompt, history, newMessage) ??
        `[chat] ${newMessage}`;

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

    // Two early-exit cases for agent-sent messages — both still record into
    // the chat ring so future dispatches see complete history:
    //   1. Self-message: never reply to your own send.
    //   2. Loop guard: server-stamped `agent_chain_depth` reached the cap.
    if (p.sender_type === 'agent') {
      const selfAgentId = loadAgentInfo()?.agent_id || '';
      if (selfAgentId && p.sender_id === selfAgentId) {
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
      try {
        const result = await this.#chatSessionManager.dispatch({
          roomId: p.room_id,
          senderId: p.sender_id || '',
          senderName: p.sender_name || '',
          createdAt: p.created_at || '',
          content: p.content || '',
          rolePrompt: p.role_prompt || '',
          onProgress,
        });
        // Record into ring AFTER dispatch so the spawn path sees real prior
        // history rather than self-referencing the message that triggered it.
        this.#chatSessionManager?.recordRoomMessage(p);
        if (result.dispatched) {
          log(
            `Chat room message dispatched to session: room=${p.room_id} pid=${result.pid}${result.firstTurn ? ' (new session)' : ''}`,
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
        const taskText =
          this.#prompts?.composeChatRoomPrompt(p.room_id, history, {
            content: p.content || '',
            sender_name: p.sender_name || '',
            sender_id: p.sender_id || '',
          }) ?? `[chat_room] ${p.content || ''}`;

        const result = await this.#subagentManager.spawn({
          kind: 'chat',
          taskText,
          rolePrompt,
          chatRequestId: `msg:${p.sender_id}:${p.created_at || ''}`,
          ticketId: '',
          agentId: '',
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
