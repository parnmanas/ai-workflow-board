// 티켓→보드 딥링크 공유 유틸 회귀 테스트 (티켓 dc5c0813).
//
// "보드에서 열기"(티켓 7815a958, TicketArtifact.tsx)와 Agent 상세 current task
// 클릭(AgentDetailModal.tsx)이 공유하는 canOpenTicketOnBoard/ticketBoardPath 를
// 그대로 구동한다. board_id 판정에 workspace_id 를 끌어들이면 이 테스트와
// ticket-artifact-view.test.mjs 의 "board_id 있고 아카이브 안 됐으면 활성 버튼"
// 케이스(workspace_id 없이 board_id 만 있는 ticket)가 어긋난다.
//
// 실행:  node --import tsx --test apps/client/test/ticket-board-link.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { canOpenTicketOnBoard, ticketBoardPath } from '../src/utils/ticketBoardLink.ts';

test('canOpenTicketOnBoard: board_id 있고 미아카이브면 true', () => {
  assert.equal(canOpenTicketOnBoard({ id: 't1', board_id: 'b1' }), true);
});

test('canOpenTicketOnBoard: board_id 없으면 false', () => {
  assert.equal(canOpenTicketOnBoard({ id: 't1' }), false);
});

test('canOpenTicketOnBoard: archived_at 있으면 board_id 있어도 false', () => {
  assert.equal(
    canOpenTicketOnBoard({ id: 't1', board_id: 'b1', archived_at: '2026-01-01T00:00:00.000Z' }),
    false,
  );
});

test('canOpenTicketOnBoard: workspace_id 없어도 board_id 판정에 관여하지 않는다', () => {
  assert.equal(canOpenTicketOnBoard({ id: 't1', board_id: 'b1', workspace_id: undefined }), true);
});

test('ticketBoardPath: /ws/<workspace_id>/boards/<board_id>?ticket=<id> 조합', () => {
  assert.equal(
    ticketBoardPath({ id: 't1', board_id: 'b1', workspace_id: 'w1' }),
    '/ws/w1/boards/b1?ticket=t1',
  );
});

test('ticketBoardPath: ticket id 를 encodeURIComponent 로 이스케이프', () => {
  assert.equal(
    ticketBoardPath({ id: 't 1&x', board_id: 'b1', workspace_id: 'w1' }),
    '/ws/w1/boards/b1?ticket=t%201%26x',
  );
});
