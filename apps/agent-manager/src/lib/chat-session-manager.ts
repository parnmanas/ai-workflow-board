// Chat Session Manager — keeps one CLI child alive per (chat room, agent)
// pair so successive messages reuse the same KV cache instead of paying
// cold-start + MCP handshake per turn. The composite key matters when a
// manager hosts multiple managed agents that each participate in the same
// room: each agent gets its own session under its own identity, instead
// of clobbering each other on a shared roomId-only session.

import {
  BaseSessionManager,
  type MonitorMeta,
  type SessionAwareConfig,
  type SessionRecord,
} from './base-session-manager.js';
import type { ParseResult } from './cli-adapters/base.js';
import { fetchChatRoomHistory, postChatRoomMessage } from './rest.js';
import { log } from './logging.js';
import { composeChatRoomPrompt } from './prompts.js';
import type {
  ChatDispatchArgs,
  ChatDispatchResult,
  ChatSessionManager as ChatSessionManagerContract,
} from './event-dispatcher.js';

interface ChatHistoryEntry {
  sender_type?: string;
  sender_id?: string;
  sender_name?: string;
  content?: string;
  created_at?: string;
}

/** Max lines kept in the per-session output ring buffer. */
const OUTPUT_RING_MAX = 80;
/** Max characters sent in the fallback chat message body. */
const FALLBACK_MAX_CHARS = 1500;

export class ChatSessionManager
  extends BaseSessionManager
  implements ChatSessionManagerContract
{
  #historyRing = new Map<string, ChatHistoryEntry[]>();
  #HISTORY_MAX = 30;

  // Per-session tracking for fallback detection.
  // Keyed by session pid (unique per child) to avoid leaking across sessions
  // that reuse the same sessionKey after respawn.
  #chatSent = new Set<number>();
  #outputRings = new Map<number, string[]>();

  constructor(config: SessionAwareConfig) {
    super(config, {
      keyField: 'sessionKey',
      logTag: '[chat-session]',
      cfgPrefix: 'cfg-chat-',
      kindLabel: 'chat_session',
    });
  }

  /** Stable key for one (room, responder agent) pair. The session-record's
   *  `roomId` and `agentId` fields are stamped separately so consumers
   *  (snapshot, monitor) can still slice by either dimension. */
  #makeKey(roomId: string, agentId: string): string {
    return `${roomId}|${agentId || '_'}`;
  }

  recordRoomMessage(payload: any): void {
    const rid = payload?.room_id;
    if (!rid) return;
    let buf = this.#historyRing.get(rid);
    if (!buf) {
      buf = [];
      this.#historyRing.set(rid, buf);
    }
    buf.push({
      sender_type: payload.sender_type,
      sender_id: payload.sender_id,
      sender_name: payload.sender_name,
      content: payload.content,
      created_at: payload.created_at,
    });
    while (buf.length > this.#HISTORY_MAX) buf.shift();
  }

  async dispatch(spec: ChatDispatchArgs): Promise<ChatDispatchResult> {
    if (!spec.roomId) return { dispatched: false, reason: 'no_room' };

    // Dedup is per (responder agent, sender, timestamp) so multiple managed
    // agents in the same room each react to the same wire event without
    // colliding on the dedup table. Without agentId in the key, the second
    // matched managed agent would always be skipped as a duplicate.
    const dedupKey = `msg:${spec.agentId || '_'}:${spec.senderId || ''}:${spec.createdAt || ''}`;
    if (!this._rememberDedup(dedupKey)) {
      return { dispatched: false, reason: 'duplicate_chat' };
    }

    const sessionKey = this.#makeKey(spec.roomId, spec.agentId);
    const sess = this._getSession(sessionKey);

    if (sess) {
      this._sendFollowUp(sess, spec.content || '', { onProgress: spec.onProgress });
      return { dispatched: true, pid: sess.pid };
    }

    if (!this._ensureCapacity()) {
      return { dispatched: false, reason: 'cap_busy' };
    }

    let history: ChatHistoryEntry[] = (this.#historyRing.get(spec.roomId) || []).slice();
    if (history.length === 0) {
      try {
        history = await fetchChatRoomHistory(this._config, spec.roomId);
      } catch {
        history = [];
      }
    }
    const firstTurnText = composeChatRoomPrompt(spec.roomId, history, {
      content: spec.content || '',
      sender_name: spec.senderName || '',
      sender_id: spec.senderId || '',
    });

    const monitorMeta: MonitorMeta = {};
    const spawned = await this._spawnSession(
      sessionKey,
      spec.rolePrompt || '',
      firstTurnText,
      { onProgress: spec.onProgress, monitorMeta, agentContext: spec.agentContext },
    );
    if (!spawned) return { dispatched: false, reason: 'spawn_failed' };
    // Stamp roomId / agentId on the record so snapshot() and any future
    // per-room or per-agent queries don't have to re-parse the composite key.
    spawned.roomId = spec.roomId;
    spawned.agentId = spec.agentId;
    spawned._effectiveApiKey = spec.agentContext?.api_key || this._config.apiKey;
    return { dispatched: true, pid: spawned.pid, firstTurn: true };
  }

  // -- Fallback detection overrides ------------------------------------------

  protected _onStdoutParsed(sess: SessionRecord, parsed: ParseResult, rawLine: string): void {
    // Buffer non-JSON lines (plain-text errors from the CLI).
    if (!parsed.raw) {
      const trimmed = rawLine.trim();
      if (trimmed) this.#pushOutput(sess.pid, trimmed);
    }
    // Detect send_chat_room_message tool use in Claude stream-json output.
    // assistant messages carry content blocks; each tool_use block has a `name`.
    if (parsed.raw?.type === 'assistant') {
      const content = parsed.raw?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block?.type === 'tool_use' &&
            typeof block.name === 'string' &&
            block.name.includes('send_chat_room_message')
          ) {
            this.#chatSent.add(sess.pid);
          }
        }
      }
    }
  }

  protected _onStderrLine(sess: SessionRecord, line: string): void {
    const trimmed = line.trim();
    if (trimmed) this.#pushOutput(sess.pid, trimmed);
  }

  protected async _onChildExit(
    sess: SessionRecord,
    _code: number | null,
    _signal: NodeJS.Signals | null,
  ): Promise<void> {
    const sent = this.#chatSent.has(sess.pid);
    const ring = this.#outputRings.get(sess.pid);

    // Cleanup tracking state regardless of outcome.
    this.#chatSent.delete(sess.pid);
    this.#outputRings.delete(sess.pid);

    if (sent) return; // Agent replied normally — nothing to do.

    const roomId: string | undefined = sess.roomId;
    const agentId: string | undefined = sess.agentId;
    if (!roomId || !agentId) return;

    // Build a human-readable fallback from buffered output.
    let body = (ring ?? []).join('\n').trim();
    if (body.length > FALLBACK_MAX_CHARS) {
      body = '…' + body.slice(-FALLBACK_MAX_CHARS);
    }

    const message = body
      ? `⚠️ Agent가 응답하지 못했습니다. CLI 출력:\n\`\`\`\n${body}\n\`\`\``
      : '⚠️ Agent가 응답하지 못했습니다 (출력 없음).';

    log(`[chat-session] fallback message for room=${roomId} agent=${agentId} pid=${sess.pid} outputLen=${body.length}`);
    const cfg = { ...this._config, apiKey: sess._effectiveApiKey || this._config.apiKey };
    await postChatRoomMessage(cfg, roomId, agentId, message);
  }

  #pushOutput(pid: number, line: string): void {
    let ring = this.#outputRings.get(pid);
    if (!ring) {
      ring = [];
      this.#outputRings.set(pid, ring);
    }
    ring.push(line);
    while (ring.length > OUTPUT_RING_MAX) ring.shift();
  }

  // ---------------------------------------------------------------------------

  _snapshot(): Array<Pick<SessionRecord, 'pid' | 'turnCount' | 'startedAt' | 'lastTouchedAt'> & {
    roomId: string;
    agentId: string;
  }> {
    return Array.from(this._sessions.values()).map((s) => ({
      roomId: s.roomId,
      agentId: s.agentId,
      pid: s.pid,
      turnCount: s.turnCount,
      startedAt: s.startedAt,
      lastTouchedAt: s.lastTouchedAt,
    }));
  }
}
