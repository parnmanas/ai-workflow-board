import { useEffect, useRef, useState } from 'react';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { roomActivity } from '../activity';
import type { ActivityView } from '../activity';

/**
 * 방(room)별 "지금 누가 작업 중인가" — 왼쪽 프레임의 채팅 행이 읽는 라이브 사실.
 *
 * 방에는 상태 컬럼이 없다. 에이전트가 작업 중임을 알리는 신호는 `chat_room_typing`
 * SSE 뿐이고, 그건 지금 열어 둔 방만이 아니라 **모든 방**에 대해 도착한다. ChatPage 의
 * `typingAgents` 는 선택된 방만 걸러 쓰므로(오른쪽 프레임의 "…is typing" 줄),
 * 목록이 쓸 수 있는 방별 맵을 여기서 따로 모은다.
 *
 * `is_typing:false` 프레임이 유실될 수 있어 TTL 로도 만료시킨다 — 그렇지 않으면
 * 끝난 작업의 점이 새로고침 전까지 영원히 돈다(ChatPage 의 15초 안전 타이머와 같은 근거).
 */
export const ROOM_ACTIVITY_TTL_MS = 20_000;

interface WorkingEntry {
  name: string;
  atMs: number;
}

export type RoomWorkingMap = Record<string, Record<string, WorkingEntry>>;

/** SSE 프레임 하나를 맵에 반영한다(순수 — 테스트가 직접 구동한다). */
export function applyTypingFrame(
  map: RoomWorkingMap,
  frame: { room_id?: string; agent_id?: string; agent_name?: string; is_typing?: boolean },
  nowMs: number,
): RoomWorkingMap {
  const roomId = frame?.room_id;
  const agentId = frame?.agent_id;
  if (!roomId || !agentId) return map;
  const room = map[roomId] || {};
  if (frame.is_typing) {
    return { ...map, [roomId]: { ...room, [agentId]: { name: frame.agent_name || 'Agent', atMs: nowMs } } };
  }
  if (!room[agentId]) return map;
  const nextRoom = { ...room };
  delete nextRoom[agentId];
  const next = { ...map };
  if (Object.keys(nextRoom).length === 0) delete next[roomId];
  else next[roomId] = nextRoom;
  return next;
}

/** TTL 이 지난 항목을 떨군다. 바뀐 게 없으면 **같은 참조**를 돌려준다(불필요한 렌더 방지). */
export function pruneRoomWorking(map: RoomWorkingMap, nowMs: number, ttlMs = ROOM_ACTIVITY_TTL_MS): RoomWorkingMap {
  let changed = false;
  const next: RoomWorkingMap = {};
  for (const [roomId, agents] of Object.entries(map)) {
    const kept: Record<string, WorkingEntry> = {};
    for (const [agentId, entry] of Object.entries(agents)) {
      if (nowMs - entry.atMs < ttlMs) kept[agentId] = entry;
      else changed = true;
    }
    if (Object.keys(kept).length > 0) next[roomId] = kept;
  }
  return changed ? next : map;
}

export function roomWorkingNames(map: RoomWorkingMap, roomId: string): string[] {
  return Object.values(map[roomId] || {}).map((entry) => entry.name);
}

export interface RoomActivityLookup {
  /** 그 방의 진행 상태 — 아무도 작업 중이 아니면 idle(점을 찍지 않는다). */
  view: (roomId: string) => ActivityView;
}

export function useRoomActivity(): RoomActivityLookup {
  const [working, setWorking] = useState<RoomWorkingMap>({});
  const workingRef = useRef(working);
  workingRef.current = working;

  useBoardStreamEvent('chat_room_typing', (data: any) => {
    setWorking((prev) => applyTypingFrame(prev, data || {}, Date.now()));
  });

  // 만료 스윕은 보여 줄 것이 있을 때만 돈다.
  useEffect(() => {
    if (Object.keys(working).length === 0) return;
    const timer = setInterval(() => setWorking((prev) => pruneRoomWorking(prev, Date.now())), 5_000);
    return () => clearInterval(timer);
  }, [working]);

  return {
    view: (roomId: string) => roomActivity({ workingNames: roomWorkingNames(workingRef.current, roomId) }),
  };
}
