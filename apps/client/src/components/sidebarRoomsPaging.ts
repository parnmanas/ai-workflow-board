import type { ChatRoomListItem } from '../types';

// 사이드바 Chat 목록 점진적 표시 (티켓 0f3a0ec9). 기본 5개, "더보기" 클릭마다 10개씩.
export const SIDEBAR_ROOMS_BASE_COUNT = 5;
export const SIDEBAR_ROOMS_PAGE_SIZE = 10;

export interface SidebarRoomsPage {
  displayRooms: ChatRoomListItem[];
  hiddenRooms: ChatRoomListItem[];
}

export interface SidebarPage<T> {
  visibleItems: T[];
  hiddenItems: T[];
}

/**
 * 목록 자체의 정렬 순서는 건드리지 않는다 — 노출 개수만큼 앞에서 잘라내고,
 * 현재 열려 있는 항목(activeId)이 그 구간 밖에 있을 때만 맨 앞에 얹어 항상
 * 보이게 한다. (본문 목록과 순서가 어긋나지 않도록 재정렬은 하지 않는다.)
 *
 * Chat 방뿐 아니라 WORK 의 Teams/Orchestrations/Boards 서브메뉴도 같은 규칙을
 * 쓴다(티켓 03ca8b5b) — 목록마다 다른 접기 규칙을 두지 않기 위해 제네릭으로 뺐다.
 */
export function paginateSidebarItems<T extends { id: string }>(
  items: T[],
  visibleCount: number,
  activeId: string | null,
): SidebarPage<T> {
  const baseVisible = items.slice(0, visibleCount);
  const activeItem = activeId ? items.find((item) => item.id === activeId) || null : null;
  const visibleItems =
    activeItem && !baseVisible.some((item) => item.id === activeItem.id)
      ? [activeItem, ...baseVisible]
      : baseVisible;
  const visibleIds = new Set(visibleItems.map((item) => item.id));
  const hiddenItems = items.filter((item) => !visibleIds.has(item.id));
  return { visibleItems, hiddenItems };
}

/** "더보기"/"접기" 토글의 다음 visibleCount. 더 감출 항목이 없으면 기본 개수로 접는다. */
export function nextVisibleCount(
  currentCount: number,
  totalItems: number,
  hasHidden: boolean,
  baseCount: number = SIDEBAR_ROOMS_BASE_COUNT,
): number {
  return hasHidden ? Math.min(currentCount + SIDEBAR_ROOMS_PAGE_SIZE, totalItems) : baseCount;
}

export function paginateSidebarRooms(
  rooms: ChatRoomListItem[],
  visibleCount: number,
  activeRoomId: string | null,
): SidebarRoomsPage {
  const { visibleItems, hiddenItems } = paginateSidebarItems(rooms, visibleCount, activeRoomId);
  return { displayRooms: visibleItems, hiddenRooms: hiddenItems };
}

export function nextVisibleRoomCount(currentCount: number, totalRooms: number, hasHidden: boolean): number {
  return nextVisibleCount(currentCount, totalRooms, hasHidden);
}
