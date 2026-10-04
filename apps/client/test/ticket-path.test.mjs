// 티켓 딥링크 공유 유틸 (board-less, docs/tickets.md).
//
// 티켓은 워크스페이스 하나의 풀에 있으므로 workspace + id 만으로 주소가 된다:
// `/ws/<ws>/tickets?ticket=<id>` (`&comment=<id>` 로 코멘트 스크롤). 예전 보드
// 딥링크(`/boards/<board>?ticket=`)는 클라이언트가 board id 를 모르는 경우가 많았다.
// TicketArtifact "티켓 열기" · QA/Security 의 fix 티켓 링크 · 알림/멘션 이동이 공유한다.
//
// 실행: node --import tsx --test test/ticket-path.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { canOpenTicket, ticketPath, ticketsPagePath } from '../src/utils/ticketPath.ts';

test('ticketPath: /ws/<ws>/tickets?ticket=<id>', () => {
  assert.equal(ticketPath('w1', 't1'), '/ws/w1/tickets?ticket=t1');
  assert.equal(ticketsPagePath('w1'), '/ws/w1/tickets');
});

test('ticketPath: comment 가 있으면 함께 싣고, 비어 있으면 뺀다', () => {
  assert.equal(ticketPath('w1', 't1', { commentId: 'c9' }), '/ws/w1/tickets?ticket=t1&comment=c9');
  assert.equal(ticketPath('w1', 't1', { commentId: null }), '/ws/w1/tickets?ticket=t1');
  assert.equal(ticketPath('w1', 't1', { commentId: '' }), '/ws/w1/tickets?ticket=t1');
});

test('ticketPath: id 는 쿼리 인코딩된다', () => {
  const url = new URL(`http://x${ticketPath('w1', 't 1&x=y')}`);
  assert.equal(url.searchParams.get('ticket'), 't 1&x=y');
  assert.equal(url.searchParams.has('x'), false);
});

test('canOpenTicket: workspace 와 id 가 모두 있어야 열 수 있다 (보관 여부는 무관)', () => {
  assert.equal(canOpenTicket({ id: 't1', workspace_id: 'w1' }), true);
  assert.equal(canOpenTicket({ id: 't1', workspace_id: 'w1', archived_at: '2026-01-01' }), true);
  assert.equal(canOpenTicket({ id: 't1' }), false);
  assert.equal(canOpenTicket({ workspace_id: 'w1' }), false);
  assert.equal(canOpenTicket(null), false);
});
