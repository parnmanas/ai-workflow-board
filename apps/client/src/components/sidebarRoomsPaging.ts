import type { ChatRoomListItem } from '../types';

// 사이드바 Chat 목록 점진적 표시 (티켓 0f3a0ec9). 기본 5개, "더보기" 클릭마다 10개씩.
export const SIDEBAR_ROOMS_BASE_COUNT = 5;
export const SIDEBAR_ROOMS_PAGE_SIZE = 10;

export interface SidebarRoomsPage {
  displayRooms: ChatRoomListItem[];
  hiddenRooms: ChatRoomListItem[];
}

/**
 * rooms 자체의 정렬 순서는 건드리지 않는다 — 노출 개수만큼 앞에서 잘라내고,
 * 현재 열려 있는 방(activeRoomId)이 그 구간 밖에 있을 때만 맨 앞에 얹어 항상
 * 보이게 한다. (RoomListPanel 과 순서가 어긋나지 않도록 재정렬은 하지 않는다.)
 */
export function paginateSidebarRooms(
  rooms: ChatRoomListItem[],
  visibleCount: number,
  activeRoomId: string | null,
): SidebarRoomsPage {
  const baseVisibleRooms = rooms.slice(0, visibleCount);
  const activeRoom = activeRoomId ? rooms.find((room) => room.id === activeRoomId) || null : null;
  const displayRooms =
    activeRoom && !baseVisibleRooms.some((room) => room.id === activeRoom.id)
      ? [activeRoom, ...baseVisibleRooms]
      : baseVisibleRooms;
  const displayedIds = new Set(displayRooms.map((room) => room.id));
  const hiddenRooms = rooms.filter((room) => !displayedIds.has(room.id));
  return { displayRooms, hiddenRooms };
}

/** "더보기"/"접기" 토글의 다음 visibleCount. 더 감출 방이 없으면 기본 5개로 접는다. */
export function nextVisibleRoomCount(currentCount: number, totalRooms: number, hasHidden: boolean): number {
  return hasHidden
    ? Math.min(currentCount + SIDEBAR_ROOMS_PAGE_SIZE, totalRooms)
    : SIDEBAR_ROOMS_BASE_COUNT;
}
