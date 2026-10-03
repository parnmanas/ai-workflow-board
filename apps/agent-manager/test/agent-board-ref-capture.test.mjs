// Unit test — F-3 (ticket 3ca88253) board-summary 카드 캡처 (agent-status
// 캡처는 P4c-4 로 get_agent 와 함께 제거). get_board_summary 결과는 티켓 row 를
// 바꾸지 않으니 ticket_refs 에 못 들어간다. 대신 별도 board_refs 로 캡처된다.
// 이 테스트가 결과 shape → BoardRef 매핑과 fail-closed 를 고정한다.
// tool-surface 분류는 tool-surface-parity.test 가 별도로 본다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  trackedBoardTool,
  resolveBoardRef,
  chunkBoardRefs,
  formatBoardRefsContent,
  BOARD_ACTION_TOOLS,
} from '../dist/lib/ticket-ref-capture.js';

// ─── agent (removed in P4c-4 with get_agent — board only below) ───

// ─── board ──────────────────────────────────────────────────────────────────

test('trackedBoardTool: get_board_summary 만 추적, get_board·list_boards 는 무시', () => {
  assert.deepEqual(
    trackedBoardTool('mcp__awb__get_board_summary', { board_id: 'B-1' }),
    { tool: 'get_board_summary', inputBoardId: 'B-1' },
  );
  // get_board(전체 상세)는 다른 목적으로도 쓰이는 범용 조회라 캡처 대상이 아니다.
  assert.equal(trackedBoardTool('mcp__awb__get_board', { id: 'B-1' }), null);
  assert.equal(trackedBoardTool('mcp__awb__list_boards', {}), null);
  assert.equal(trackedBoardTool('Bash', {}), null);
  assert.equal(trackedBoardTool(undefined, {}), null);
});

test('trackedBoardTool: board_id 가 input 에 없으면 inputBoardId 는 undefined(결과에 없기 때문)', () => {
  const ctx = trackedBoardTool('mcp__awb__get_board_summary', {});
  assert.deepEqual(ctx, { tool: 'get_board_summary', inputBoardId: undefined });
});

test('BOARD_ACTION_TOOLS: 정확히 get_board_summary 하나 → summary', () => {
  assert.deepEqual(BOARD_ACTION_TOOLS, { get_board_summary: 'summary' });
});

test('resolveBoardRef: get_board_summary 결과({board,columns})에서 board_id(input)+title(결과) 캡처', () => {
  const ctx = trackedBoardTool('mcp__awb__get_board_summary', { board_id: 'B-1' });
  const ref = resolveBoardRef(ctx, { board: 'AWB', description: '', columns: [] }, false);
  assert.deepEqual(ref, { board_id: 'B-1', title: 'AWB' });
});

test('resolveBoardRef: board 필드가 없으면 title 없이 board_id 만(id 는 input 에서 왔으므로 여전히 유효)', () => {
  const ctx = trackedBoardTool('mcp__awb__get_board_summary', { board_id: 'B-1' });
  const ref = resolveBoardRef(ctx, { columns: [] }, false);
  assert.deepEqual(ref, { board_id: 'B-1' });
});

test('resolveBoardRef fail-closed: 에러 → 카드 없음, input board_id 없으면(딥링크 불가) 카드 없음', () => {
  // get_board_summary 결과 자체엔 board id 가 없다 — input 에서 못 얻으면 딥링크할
  // 방법이 없으므로 결과 shape 와 무관하게 fail-closed.
  const noId = trackedBoardTool('mcp__awb__get_board_summary', {});
  assert.equal(resolveBoardRef(noId, { board: 'AWB' }, false), null, 'input board_id 없음 → null');

  const ctx = trackedBoardTool('mcp__awb__get_board_summary', { board_id: 'B-1' });
  assert.equal(resolveBoardRef(ctx, { board: 'AWB' }, true), null, '에러 결과 → 카드 없음');
});

test('chunkBoardRefs: 서버 message-당 bound 초과분을 다중 카드로 분할(누락 없이)', () => {
  const refs = Array.from({ length: 21 }, (_, i) => ({ board_id: `B-${i}` }));
  const chunks = chunkBoardRefs(refs, 20);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => c.length), [20, 1]);
  assert.equal(chunks.flat().length, 21, '21번째도 버려지지 않는다');
  assert.deepEqual(chunkBoardRefs([], 20), [], '빈 입력 → 메시지 없음');
  assert.equal(chunkBoardRefs(refs, 0).length, 1, 'size 0 → 단일 청크(방어)');
});

test('formatBoardRefsContent: 메타 못 읽는 표면용 한글 텍스트 폴백', () => {
  const content = formatBoardRefsContent([
    { board_id: 'B-1', title: 'AWB' },
    { board_id: 'B-2' },
  ]);
  assert.equal(content, '📊 보드: AWB\n📊 보드: B-2');
});
