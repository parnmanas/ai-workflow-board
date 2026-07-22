// Unit test — F-3 (ticket 3ca88253) agent-status / board-summary 카드 캡처.
//
// get_agent · get_board_summary 결과는 티켓 row 를 바꾸지 않으니 ticket_refs 에 못
// 들어간다. 대신 별도 agent_refs / board_refs 로 캡처된다. 이 테스트가 두 tool의 실제
// 결과 shape → AgentRef/BoardRef 매핑과 fail-closed(에러/미인식 shape → 카드 없음)를
// 고정한다. tool-surface 분류(list_agents/get_board 는 read 로 남는다는 것 포함)는
// tool-surface-parity.test 가 별도로 본다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  trackedAgentTool,
  resolveAgentRef,
  chunkAgentRefs,
  formatAgentRefsContent,
  AGENT_ACTION_TOOLS,
  trackedBoardTool,
  resolveBoardRef,
  chunkBoardRefs,
  formatBoardRefsContent,
  BOARD_ACTION_TOOLS,
} from '../dist/lib/ticket-ref-capture.js';

// ─── agent ──────────────────────────────────────────────────────────────────

test('trackedAgentTool: get_agent 만 추적, list_agents·티켓 tool·비-MCP tool 은 무시', () => {
  assert.deepEqual(trackedAgentTool('mcp__awb__get_agent'), { tool: 'get_agent' });
  // list_agents(다건 조회)는 "특정 agent" 상태 카드가 아니라서 read 로 남는다.
  assert.equal(trackedAgentTool('mcp__awb__list_agents'), null);
  assert.equal(trackedAgentTool('mcp__awb__create_ticket'), null);
  assert.equal(trackedAgentTool('mcp__awb__get_board_summary'), null);
  assert.equal(trackedAgentTool('Bash'), null);
  assert.equal(trackedAgentTool(undefined), null);
});

test('AGENT_ACTION_TOOLS: 정확히 get_agent 하나 → status', () => {
  assert.deepEqual(AGENT_ACTION_TOOLS, { get_agent: 'status' });
});

test('resolveAgentRef: get_agent 결과(Agent 엔티티 그대로)에서 id(+name) 캡처', () => {
  const ctx = trackedAgentTool('mcp__awb__get_agent');
  const ref = resolveAgentRef(ctx, { id: 'A-1', name: 'Rolf', type: 'claude', is_online: true }, false);
  assert.deepEqual(ref, { agent_id: 'A-1', name: 'Rolf' });
});

test('resolveAgentRef: name 없어도 id 만으로 카드는 뜬다(클릭 시 재조회로 보강)', () => {
  const ctx = trackedAgentTool('mcp__awb__get_agent');
  const ref = resolveAgentRef(ctx, { id: 'A-2' }, false);
  assert.deepEqual(ref, { agent_id: 'A-2' });
});

test('resolveAgentRef fail-closed: 에러·id 없음·비객체·빈 문자열 id → 카드 없음', () => {
  const ctx = trackedAgentTool('mcp__awb__get_agent');
  assert.equal(resolveAgentRef(ctx, { id: 'A-1', name: 'X' }, true), null, '에러 결과 → 카드 없음');
  assert.equal(resolveAgentRef(ctx, { name: 'no id' }, false), null, 'id 없으면 무의미 → null');
  assert.equal(resolveAgentRef(ctx, { id: '' }, false), null, '빈 문자열 id → null');
  assert.equal(resolveAgentRef(ctx, 'not an object', false), null, '비객체 결과 → null');
  assert.equal(resolveAgentRef(ctx, ['A-1'], false), null, '배열 결과 → null');
});

test('chunkAgentRefs: 서버 message-당 bound 초과분을 다중 카드로 분할(누락 없이)', () => {
  const refs = Array.from({ length: 21 }, (_, i) => ({ agent_id: `A-${i}` }));
  const chunks = chunkAgentRefs(refs, 20);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => c.length), [20, 1]);
  assert.equal(chunks.flat().length, 21, '21번째도 버려지지 않는다');
  assert.deepEqual(chunkAgentRefs([], 20), [], '빈 입력 → 메시지 없음');
  assert.equal(chunkAgentRefs(refs, 0).length, 1, 'size 0 → 단일 청크(방어)');
});

test('formatAgentRefsContent: 메타 못 읽는 표면용 한글 텍스트 폴백', () => {
  const content = formatAgentRefsContent([
    { agent_id: 'A-1', name: 'Rolf' },
    { agent_id: 'A-2' },
  ]);
  assert.equal(content, '🧑‍💻 Agent: Rolf\n🧑‍💻 Agent: A-2');
});

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
