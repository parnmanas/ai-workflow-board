// Chat Session Manager — keeps one CLI child alive per chat room so
// successive messages reuse the same KV cache instead of paying cold-start
// + MCP handshake per turn.

import {
  BaseSessionManager,
  type MonitorMeta,
  type SessionAwareConfig,
  type SessionRecord,
} from './base-session-manager.js';
import { fetchChatRoomHistory } from './rest.js';
import { composeChatRoomPrompt } from './prompts.js';
import type { CliAdapter } from './cli-adapters/base.js';
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

  constructor(config: SessionAwareConfig, adapter?: CliAdapter) {
    super(
      config,
      {
        keyField: 'roomId',
        logTag: '[chat-session]',
        cfgPrefix: 'cfg-chat-',
        kindLabel: 'chat_session',
      },
      adapter,
    );
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

    const dedupKey = `msg:${spec.senderId || ''}:${spec.createdAt || ''}`;
    if (!this._rememberDedup(dedupKey)) {
      return { dispatched: false, reason: 'duplicate_chat' };
    }

    const sess = this._getSession(spec.roomId);

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
      spec.roomId,
      spec.rolePrompt || '',
      firstTurnText,
      { onProgress: spec.onProgress, monitorMeta, agentContext: spec.agentContext },
    );
    if (!spawned) return { dispatched: false, reason: 'spawn_failed' };
    return { dispatched: true, pid: spawned.pid, firstTurn: true };
  }

  _snapshot(): Array<Pick<SessionRecord, 'pid' | 'turnCount' | 'startedAt' | 'lastTouchedAt'> & {
    roomId: string;
  }> {
    return Array.from(this._sessions.values()).map((s) => ({
      roomId: s.roomId,
      pid: s.pid,
      turnCount: s.turnCount,
      startedAt: s.startedAt,
      lastTouchedAt: s.lastTouchedAt,
    }));
  }
}
