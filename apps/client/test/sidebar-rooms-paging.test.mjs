// 사이드바 Chat 목록 점진적 표시 순수 로직 테스트 (티켓 0f3a0ec9).
//
// paginateSidebarRooms(슬라이스 + 활성 방 강제 포함)와 nextVisibleRoomCount
// (더보기/접기 카운트 전이)를 node:test 로 직접 검증한다. fetch·라우팅·React
// 렌더 없는 순수 함수라 하니스 불필요 (assistantEntry.test.mjs 와 동일 패턴).
//
// 실행:  node --import tsx --test apps/client/test/sidebar-rooms-paging.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIDEBAR_ROOMS_BASE_COUNT,
  SIDEBAR_ROOMS_PAGE_SIZE,
  nextVisibleRoomCount,
  paginateSidebarRooms,
} from '../src/components/sidebarRoomsPaging.ts';

const room = (id) => ({ id, type: 'dm', name: `Room ${id}`, unread_count: 0 });
const rooms27 = Array.from({ length: 27 }, (_, i) => room(`r${i}`));

test('상수: 기본 5개, 더보기 10개씩', () => {
  assert.equal(SIDEBAR_ROOMS_BASE_COUNT, 5);
  assert.equal(SIDEBAR_ROOMS_PAGE_SIZE, 10);
});

test('paginateSidebarRooms: 5개 이하면 전부 노출, 숨김 없음', () => {
  const rooms = [room('a'), room('b'), room('c')];
  const { displayRooms, hiddenRooms } = paginateSidebarRooms(rooms, SIDEBAR_ROOMS_BASE_COUNT, null);
  assert.deepEqual(displayRooms.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(hiddenRooms, []);
});

test('paginateSidebarRooms: 27개 중 5개만 노출, 나머지 22개는 숨김 (활성 방 없음)', () => {
  const { displayRooms, hiddenRooms } = paginateSidebarRooms(rooms27, SIDEBAR_ROOMS_BASE_COUNT, null);
  assert.deepEqual(displayRooms.map((r) => r.id), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.equal(hiddenRooms.length, 22);
});

test('paginateSidebarRooms: rooms 자체의 정렬 순서는 바꾸지 않는다', () => {
  const { displayRooms } = paginateSidebarRooms(rooms27, 15, null);
  assert.deepEqual(
    displayRooms.map((r) => r.id),
    rooms27.slice(0, 15).map((r) => r.id),
  );
});

test('paginateSidebarRooms: 더보기 2번(5→15→25) 시나리오', () => {
  let visible = SIDEBAR_ROOMS_BASE_COUNT;
  visible = nextVisibleRoomCount(visible, rooms27.length, true);
  assert.equal(visible, 15);
  let page = paginateSidebarRooms(rooms27, visible, null);
  assert.equal(page.displayRooms.length, 15);
  assert.equal(page.hiddenRooms.length, 12);

  visible = nextVisibleRoomCount(visible, rooms27.length, page.hiddenRooms.length > 0);
  assert.equal(visible, 25);
  page = paginateSidebarRooms(rooms27, visible, null);
  assert.equal(page.displayRooms.length, 25);
  assert.equal(page.hiddenRooms.length, 2);
});

test('paginateSidebarRooms: 활성 방이 잘린 구간 밖이면 맨 앞에 강제 포함되고 hidden 에서 빠진다', () => {
  const { displayRooms, hiddenRooms } = paginateSidebarRooms(rooms27, SIDEBAR_ROOMS_BASE_COUNT, 'r20');
  assert.equal(displayRooms[0].id, 'r20');
  assert.deepEqual(displayRooms.slice(1).map((r) => r.id), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.equal(displayRooms.length, 6);
  assert.ok(!hiddenRooms.some((r) => r.id === 'r20'));
  assert.equal(hiddenRooms.length, 21);
});

test('paginateSidebarRooms: 활성 방이 이미 노출 구간 안이면 중복 삽입하지 않는다', () => {
  const { displayRooms, hiddenRooms } = paginateSidebarRooms(rooms27, SIDEBAR_ROOMS_BASE_COUNT, 'r2');
  assert.deepEqual(displayRooms.map((r) => r.id), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.equal(hiddenRooms.length, 22);
});

test('paginateSidebarRooms: 존재하지 않는 activeRoomId 는 무시된다', () => {
  const { displayRooms, hiddenRooms } = paginateSidebarRooms(rooms27, SIDEBAR_ROOMS_BASE_COUNT, 'does-not-exist');
  assert.deepEqual(displayRooms.map((r) => r.id), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.equal(hiddenRooms.length, 22);
});

test('nextVisibleRoomCount: 남은 방이 있으면 10개씩 증가하되 총 개수를 넘지 않는다', () => {
  assert.equal(nextVisibleRoomCount(5, 27, true), 15);
  assert.equal(nextVisibleRoomCount(15, 27, true), 25);
  assert.equal(nextVisibleRoomCount(25, 27, true), 27); // 마지막 클릭은 2개만 남아도 클램프
});

test('nextVisibleRoomCount: 더 감출 방이 없으면(접기) 기본 5개로 되돌린다', () => {
  assert.equal(nextVisibleRoomCount(27, 27, false), SIDEBAR_ROOMS_BASE_COUNT);
});
