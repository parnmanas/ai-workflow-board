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
import { fetchChatRoomHistory } from './rest.js';
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

export class ChatSessionManager
  extends BaseSessionManager
  implements ChatSessionManagerContract
{
  #historyRing = new Map<string, ChatHistoryEntry[]>();
  #HISTORY_MAX = 30;

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
    return { dispatched: true, pid: spawned.pid, firstTurn: true };
  }

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
