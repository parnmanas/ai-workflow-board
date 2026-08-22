// In-memory last-known-status cache for the chat_room_session_status SSE
// broadcast (ticket e18be8ff review round 1, P1 #2). The SSE push itself is
// fire-and-forget — a client that opens/re-enters a room between pushes has
// no way to learn "is there an active keep-alive/background task right now"
// until the next progress recheck or session exit. This store lets a fresh
// room view ask for the current snapshot instead of waiting.
//
// Liveness mirrors the client's own filter (ChatPage.tsx `isLive`): an entry
// with no future keep-alive deadline and no live background tasks is not
// "current" and is pruned rather than served.

export interface ChatSessionStatusEntry {
  agent_id: string;
  agent_name: string;
  keep_alive_until_ms: number | null;
  background_task_count: number;
}

const store = new Map<string, Map<string, ChatSessionStatusEntry>>();

function isLive(entry: ChatSessionStatusEntry, now: number): boolean {
  return (entry.keep_alive_until_ms !== null && entry.keep_alive_until_ms > now) || entry.background_task_count > 0;
}

export function setChatRoomSessionStatus(roomId: string, entry: ChatSessionStatusEntry): void {
  if (!isLive(entry, Date.now())) {
    store.get(roomId)?.delete(entry.agent_id);
    return;
  }
  let roomMap = store.get(roomId);
  if (!roomMap) {
    roomMap = new Map();
    store.set(roomId, roomMap);
  }
  roomMap.set(entry.agent_id, entry);
}

export function getChatRoomSessionStatus(roomId: string): ChatSessionStatusEntry[] {
  const roomMap = store.get(roomId);
  if (!roomMap) return [];
  const now = Date.now();
  const live: ChatSessionStatusEntry[] = [];
  for (const [agentId, entry] of roomMap) {
    if (isLive(entry, now)) {
      live.push(entry);
    } else {
      roomMap.delete(agentId);
    }
  }
  if (roomMap.size === 0) store.delete(roomId);
  return live;
}
