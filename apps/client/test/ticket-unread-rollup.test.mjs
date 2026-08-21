// TicketCard 미읽음 뱃지 롤업 순수 로직 테스트 (티켓 628f4b39).
//
// sumUnread 는 counts.tickets.perTicket(코멘트의 ticket_id — child/grandchild
// 일 수 있음)을 board 카드가 실제로 렌더하는 ROOT 티켓 단위로 말아 올린다.
// 서브태스크는 보드에 자기 카드가 없으므로, 이 롤업이 없으면 서브태스크 코멘트가
// 보드/사이드바 뱃지 합계엔 잡히는데 어느 카드에서도 보이지 않는 불일치가 생긴다.
// fetch·라우팅·React 렌더 없는 순수 함수라 하니스 불필요 (sidebar-rooms-paging.
// test.mjs 와 동일 패턴).
import test from 'node:test';
import assert from 'node:assert/strict';

import { sumUnread } from '../src/components/ticketUnreadRollup.ts';

const ticket = (id, children = []) => ({ id, children });

test('자식이 없으면 자기 자신의 perTicket 값만 반환', () => {
  assert.equal(sumUnread(ticket('t1'), { t1: 3 }), 3);
});

test('perTicket 에 항목이 없으면 0', () => {
  assert.equal(sumUnread(ticket('t1'), {}), 0);
  assert.equal(sumUnread(ticket('t1'), { other: 5 }), 0);
});

test('1단계 자식(서브태스크) 코멘트가 부모 카드 뱃지로 롤업된다', () => {
  const root = ticket('parent', [ticket('child1'), ticket('child2')]);
  const perTicket = { parent: 1, child1: 2, child2: 4 };
  assert.equal(sumUnread(root, perTicket), 7, '1 + 2 + 4');
});

test('2단계(root→child→grandchild)까지 재귀적으로 롤업된다', () => {
  const grandchild = ticket('gc1');
  const child = ticket('c1', [grandchild]);
  const root = ticket('root', [child]);
  const perTicket = { root: 1, c1: 2, gc1: 3 };
  assert.equal(sumUnread(root, perTicket), 6, '1 + 2 + 3 — grandchild 까지 도달해야 한다');
});

test('형제 서브태스크 중 일부만 unread 여도 합산은 정확하다', () => {
  const root = ticket('root', [ticket('c1'), ticket('c2'), ticket('c3')]);
  const perTicket = { c2: 5 }; // root, c1, c3 는 unread 없음(entry 자체가 없음)
  assert.equal(sumUnread(root, perTicket), 5);
});

test('children 이 undefined 여도(구 payload 폴백) 던지지 않는다', () => {
  assert.equal(sumUnread({ id: 't1' }, { t1: 2 }), 2);
});
