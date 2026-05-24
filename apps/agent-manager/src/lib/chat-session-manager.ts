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
    // OS-level liveness check — same single-source-of-truth reconciliation
    // ticket-session does. A stale record (child reaped without exit
    // handler) gets purged here so the next branch falls through to a fresh
    // spawn instead of dispatching a turn into a dead stdin.
    const sess = this._getLiveSession(sessionKey);

    if (sess) {
      // Acceptance criterion: explicit "reused existing pid=…" log so the
      // log stream clearly distinguishes follow-ups from fresh spawns.
      log(
        `[chat-session] reused existing pid=${sess.pid} room=${spec.roomId.slice(0, 8)} agent=${(spec.agentId || '').slice(0, 8)} turn=${sess.turnCount + 1}`,
      );
      this._sendFollowUp(sess, spec.content || '', { onProgress: spec.onProgress });
      return { dispatched: true, pid: sess.pid };
    }

    // Synchronous race guard: if another dispatch is already past this point
    // for the same (room, agent), drop this one. Without it, two concurrent
    // chat events with the same dedup-evading payload (e.g. different
    // sender ids but same room+agent target) can both pass the live-session
    // check and each spawn a child — exactly the bug ticket
    // 52e581ce flagged. The reservation flips synchronously between the
    // check above and the `_spawnSession` await below.
    if (this._inflight.has(sessionKey)) {
      log(
        `[chat-session] dispatch dropped (spawn already in-flight for same key): room=${spec.roomId.slice(0, 8)} agent=${(spec.agentId || '').slice(0, 8)}`,
      );
      // Roll back the dedup mark so the retried message (when the in-flight
      // spawn finishes and a real follow-up turn becomes possible) isn't
      // silently swallowed as a duplicate.
      this._forgetDedup(dedupKey);
      return { dispatched: false, reason: 'inflight_spawn' };
    }

    if (!this._ensureCapacity()) {
      this._forgetDedup(dedupKey);
      return { dispatched: false, reason: 'cap_busy' };
    }

    // Reserve the in-flight slot SYNCHRONOUSLY here — before any await — so a
    // racing dispatch on the same (room, agent) trips the guard above on
    // its second check. The chat path has at least one async hop (history
    // fetch) before the spawn itself; if we deferred the reservation past
    // that hop, two concurrent calls would both clear the guard during the
    // fetch and each call `_spawnSession`, reproducing the duplicate-pid
    // bug the dedup ticket was opened for.
    this._inflight.set(sessionKey, {
      agentId: spec.agentId || '',
      roomId: spec.roomId,
    });

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
    let spawned: SessionRecord | null = null;
    try {
      spawned = await this._spawnSession(
        sessionKey,
        spec.rolePrompt || '',
        firstTurnText,
        { onProgress: spec.onProgress, monitorMeta, agentContext: spec.agentContext },
      );
      // Stamp roomId / agentId on the record BEFORE clearing the inflight
      // reservation — `_spawnSession` lands the record in `_sessions`
      // before returning, so a racing dispatch that just passed the
      // live-session check would otherwise observe a session with empty
      // identity fields.
      if (spawned) {
        spawned.roomId = spec.roomId;
        spawned.agentId = spec.agentId;
        spawned._effectiveApiKey = spec.agentContext?.api_key || this._config.apiKey;
      }
    } finally {
      this._inflight.delete(sessionKey);
    }
    if (!spawned) {
      this._forgetDedup(dedupKey);
      return { dispatched: false, reason: 'spawn_failed' };
    }
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
