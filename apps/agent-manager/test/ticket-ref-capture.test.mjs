// Unit test — F-1 (ticket 24694916) mechanical ticket-action card capture.
//
// Proves the "누락 없이" capture math: given the CLI stream's tool_use + tool_result
// blocks, the right ticket ref is produced for every tracked action, the ticket id
// is resolved from the CORRECT source (result.id for creates, input ticket_id for
// existing-ticket actions — never a comment id), and reads/errors never emit a card.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bareToolName,
  trackedTicketTool,
  parseStreamToolResult,
  harvestTicketTitles,
  resolveTicketRef,
  formatTicketRefsContent,
  chunkTicketRefs,
  TICKET_ACTION_TOOLS,
  TICKET_TOOL_EXCLUSIONS,
  classifiedToolNames,
} from '../dist/lib/ticket-ref-capture.js';

test('bareToolName strips the MCP server prefix, tolerating any prefix', () => {
  assert.equal(bareToolName('mcp__awb__create_ticket'), 'create_ticket');
  assert.equal(bareToolName('mcp__ai-workflow-board__move_ticket'), 'move_ticket');
  assert.equal(bareToolName('Bash'), 'Bash'); // no `__` → unchanged
});

test('trackedTicketTool: mutating ticket tools tracked, reads/other tools ignored', () => {
  const create = trackedTicketTool('mcp__awb__create_ticket', { title: 'New', priority: 'high' });
  assert.deepEqual(create, { action: 'create', fromResult: true, inputTicketId: undefined, inputTitle: 'New' });

  const move = trackedTicketTool('mcp__awb__move_ticket', { ticket_id: 'T-1', status: 'review' });
  assert.deepEqual(move, { action: 'move', fromResult: false, inputTicketId: 'T-1', inputTitle: undefined });

  // Reads + non-ticket + the final reply tool must NOT be tracked (no card noise).
  assert.equal(trackedTicketTool('mcp__awb__get_ticket', { ticket_id: 'T-1' }), null);
  assert.equal(trackedTicketTool('mcp__awb__list_actions', {}), null);
  assert.equal(trackedTicketTool('mcp__awb__send_chat_room_message', { room_id: 'R' }), null);
  assert.equal(trackedTicketTool('mcp__awb__delete_ticket', { ticket_id: 'T-1' }), null); // excluded (would 404)
  assert.equal(trackedTicketTool('Bash', { command: 'ls' }), null);
  assert.equal(trackedTicketTool(undefined, {}), null);
});

test('parseStreamToolResult handles string, text-block array, and junk', () => {
  assert.deepEqual(parseStreamToolResult('{"id":"T-1","title":"X"}'), { id: 'T-1', title: 'X' });
  assert.deepEqual(
    parseStreamToolResult([{ type: 'text', text: '{"ticket_id":"T-2"}' }]),
    { ticket_id: 'T-2' },
  );
  assert.equal(parseStreamToolResult('not json'), null);
  assert.equal(parseStreamToolResult([{ type: 'image' }]), null);
  assert.equal(parseStreamToolResult(undefined), null);
});

test('harvestTicketTitles collects {id,title} from ticket / array / children shapes', () => {
  assert.deepEqual(harvestTicketTitles({ id: 'T-1', title: 'One', status: 'todo' }), [{ id: 'T-1', title: 'One' }]);
  assert.deepEqual(
    harvestTicketTitles([{ id: 'A', title: 'a' }, { id: 'B', title: 'b' }, { nope: 1 }]),
    [{ id: 'A', title: 'a' }, { id: 'B', title: 'b' }],
  );
  assert.deepEqual(
    harvestTicketTitles({ id: 'P', title: 'parent', children: [{ id: 'C', title: 'child' }] }),
    [{ id: 'P', title: 'parent' }, { id: 'C', title: 'child' }],
  );
  // board-less list_tickets → `{ tickets: [...], tags }` listing.
  assert.deepEqual(
    harvestTicketTitles({ tickets: [{ id: 'L-1', title: 'listed' }, { id: 'L-2' }], tags: [{ tag: 'bug', count: 1 }] }),
    [{ id: 'L-1', title: 'listed' }],
  );
  // A comment result ({id, ticket_id, content} — no title) must NOT pollute the cache.
  assert.deepEqual(harvestTicketTitles({ id: 'CMT-1', ticket_id: 'T-9', content: 'hi' }), []);
  assert.deepEqual(harvestTicketTitles('str'), []);
});

test('resolveTicketRef CREATE: ticket id + title come from the result object', () => {
  const ctx = trackedTicketTool('mcp__awb__create_ticket', { title: 'New One' });
  const ref = resolveTicketRef(ctx, { id: 'T-new', title: 'New One', status: 'todo' }, false);
  assert.deepEqual(ref, { action: 'create', ticket_id: 'T-new', title: 'New One' });
});

test('resolveTicketRef add_comment: uses INPUT ticket_id, never the comment result id', () => {
  const ctx = trackedTicketTool('mcp__awb__add_comment', { ticket_id: 'T-real', content: 'hi' });
  // add_comment returns the COMMENT (its own id + ticket_id, no title).
  const result = { id: 'CMT-xyz', ticket_id: 'T-real', content: 'hi', author: 'agent' };
  const ref = resolveTicketRef(ctx, result, false, (id) => (id === 'T-real' ? '실제 티켓' : undefined));
  // The card must point at the TICKET, not the comment id, and pull the title from the cache.
  assert.deepEqual(ref, { action: 'comment', ticket_id: 'T-real', title: '실제 티켓' });
});

test('resolveTicketRef move: input ticket_id authoritative, title from result', () => {
  const ctx = trackedTicketTool('mcp__awb__move_ticket', { ticket_id: 'T-7' });
  const ref = resolveTicketRef(ctx, { id: 'T-7', title: 'Moved', status: 'done' }, false);
  assert.deepEqual(ref, { action: 'move', ticket_id: 'T-7', title: 'Moved' });
});

test('resolveTicketRef title fallback: cache → inputTitle → undefined', () => {
  const ctx = trackedTicketTool('mcp__awb__claim_ticket', { ticket_id: 'T-8' });
  // claim result has no title; cache miss + no input title → title omitted, card still emitted.
  const noTitle = resolveTicketRef(ctx, { claimed: true, ticket_id: 'T-8' }, false);
  assert.deepEqual(noTitle, { action: 'claim', ticket_id: 'T-8' });
  // cache hit supplies the title.
  const cached = resolveTicketRef(ctx, { claimed: true, ticket_id: 'T-8' }, false, () => '캐시 제목');
  assert.deepEqual(cached, { action: 'claim', ticket_id: 'T-8', title: '캐시 제목' });
});

test('resolveTicketRef returns null on error result or unresolvable ticket id', () => {
  const move = trackedTicketTool('mcp__awb__move_ticket', { ticket_id: 'T-1' });
  assert.equal(resolveTicketRef(move, { id: 'T-1', title: 'X' }, true), null, 'errored action → no card');
  const create = trackedTicketTool('mcp__awb__create_ticket', { title: 'X' });
  assert.equal(resolveTicketRef(create, { message: 'no id here' }, false), null, 'create with no result id → no card');
  const orphanMove = trackedTicketTool('mcp__awb__update_ticket', {}); // no input ticket_id
  assert.equal(resolveTicketRef(orphanMove, { message: 'nope' }, false), null, 'existing action with no id → no card');
});

test('formatTicketRefsContent renders Korean action labels as the text fallback', () => {
  const content = formatTicketRefsContent([
    { action: 'create', ticket_id: 'T-1', title: '새 티켓' },
    { action: 'move', ticket_id: 'T-2', title: '옮긴 티켓' },
    { action: 'weird', ticket_id: 'T-3' }, // unknown action → raw code; no title → id
  ]);
  assert.equal(
    content,
    '📋 티켓 생성: 새 티켓\n📋 티켓 이동: 옮긴 티켓\n📋 티켓 weird: T-3',
  );
});

// ── F-1 재요청 대응 (ticket 24694916): MCP 티켓-mutation surface 완결 분류 ──────
// 리뷰어 지적 — allowlist 가 9개뿐이라 update_child_ticket(status="done") 등 흔한
// mutation 이 카드 없이 조용히 누락(수용기준 #1 "누락 없이" 위배). 아래 테스트가
// 확장된 지원 표면·의도적 제외·신규 성공 경로를 고정한다(batch 다중-ref 는 board-less
// 전환으로 batch_operations 와 함께 삭제).

test('trackedTicketTool: expanded ticket-mutation surface is fully tracked', () => {
  const cases = [
    ['update_child_ticket', { ticket_id: 'C-1', status: 'done' }, 'update', 'C-1'],
    ['decide_ticket_duplicate', { ticket_id: 'T-1', action: 'keep_independent' }, 'update', 'T-1'],
    ['correct_confirmed_ticket_duplicate', { ticket_id: 'T-1' }, 'update', 'T-1'],
    ['release_ticket', { ticket_id: 'T-3', agent_id: 'A-1' }, 'release', 'T-3'],
    ['unarchive_ticket', { ticket_id: 'T-4' }, 'unarchive', 'T-4'],
    ['add_ticket_prerequisites', { ticket_id: 'T-5', prerequisite_ticket_ids: ['P'] }, 'prereq', 'T-5'],
    ['remove_ticket_prerequisite', { ticket_id: 'T-6', prerequisite_ticket_id: 'P' }, 'prereq', 'T-6'],
    ['await_ci_run', { ticket_id: 'T-7', run_url: 'https://ci.example/1' }, 'ci_wait', 'T-7'],
  ];
  for (const [tool, input, action, ticketId] of cases) {
    const ctx = trackedTicketTool(`mcp__awb__${tool}`, input);
    assert.ok(ctx, `${tool} must be tracked`);
    assert.equal(ctx.action, action, `${tool} → action`);
    assert.equal(ctx.fromResult, false, `${tool} uses INPUT ticket_id, not the result id`);
    assert.equal(ctx.inputTicketId, ticketId, `${tool} inputTicketId`);
  }
});

test('trackedTicketTool: documented exclusions never emit a card', () => {
  // Deletes — the card would deep-link a ticket that no longer exists (404).
  assert.equal(trackedTicketTool('mcp__awb__delete_ticket', { ticket_id: 'T-1' }), null);
  assert.equal(trackedTicketTool('mcp__awb__delete_child_ticket', { ticket_id: 'C-1' }), null);
  // Attachment sub-resource I/O is not a ticket-lifecycle action.
  assert.equal(trackedTicketTool('mcp__awb__add_ticket_attachment', { ticket_id: 'T-1' }), null);
  assert.equal(trackedTicketTool('mcp__awb__delete_ticket_attachment', { ticket_id: 'T-1' }), null);
  // The assistant's own reply + the focus seat are not ticket-row mutations.
  assert.equal(trackedTicketTool('mcp__awb__send_chat_room_message', { room_id: 'R' }), null);
  assert.equal(trackedTicketTool('mcp__awb__set_current_task', { ticket_id: 'T-1' }), null);
  // Reads + non-ticket tools stay ignored (incl. the board-less list_tickets / project tools).
  assert.equal(trackedTicketTool('mcp__awb__get_ticket', { ticket_id: 'T-1' }), null);
  assert.equal(trackedTicketTool('mcp__awb__list_tickets', { status: ['todo'] }), null);
  assert.equal(trackedTicketTool('mcp__awb__list_ticket_prerequisites', { ticket_id: 'T-1' }), null);
  assert.equal(trackedTicketTool('mcp__awb__save_project', { name: 'P' }), null);
  assert.equal(trackedTicketTool('mcp__awb__get_project', { project_id: 'P-1' }), null);
});

// board-less (docs/tickets.md): the board / column / consensus / handoff / batch /
// merge-lease tools were deleted from the server, so the classification must not
// track them any more (a stale entry would fail tool-surface-parity).
test('removed board-model tools are no longer classified; board-less tools are', () => {
  const removed = [
    'list_boards', 'get_board', 'get_board_summary', 'create_board', 'update_board', 'delete_board',
    'move_board_to_workspace', 'create_column', 'update_column', 'delete_column', 'add_board_lesson',
    'list_board_lessons', 'update_board_lesson', 'list_prompt_templates', 'save_prompt_template',
    'delete_prompt_template', 'move_ticket_to_board', 'propose_move', 'record_agreement',
    'handoff_to_agent', 'reject_handoff', 'get_handoff_pipeline', 'create_benchmark_run',
    'submit_benchmark_score', 'get_benchmark_leaderboard', 'submit_feature_request',
    'propose_feature_chain', 'approve_feature', 'reject_feature', 'list_features', 'get_feature',
    'create_remote_improvement_ticket', 'check_review_drift', 'await_merge_lease',
    'release_merge_lease', 'get_allocated_tickets', 'batch_operations',
    'register_completion_verification', 'record_completion_verification',
  ];
  const classified = classifiedToolNames();
  for (const tool of removed) {
    assert.ok(!classified.has(tool), `${tool} was removed from the server — must not stay classified`);
    assert.equal(trackedTicketTool(`mcp__awb__${tool}`, { ticket_id: 'T-1' }), null, `${tool} must not track`);
  }
  for (const tool of ['list_tickets', 'list_projects', 'get_project', 'save_project']) {
    assert.ok(classified.has(tool), `${tool} must be classified`);
    assert.ok(!TICKET_ACTION_TOOLS[tool], `${tool} is not a ticket mutation card`);
  }
  assert.equal(TICKET_TOOL_EXCLUSIONS.list_tickets, 'read');
});

test('resolveTicketRef: newly-supported success paths each emit a card (누락 없이)', () => {
  // update_child_ticket(status="done") — the reviewer's key omission. Child id is
  // the input ticket_id; the result is the updated child (carries the title).
  const child = trackedTicketTool('mcp__awb__update_child_ticket', { ticket_id: 'C-1', status: 'done' });
  assert.deepEqual(
    resolveTicketRef(child, { id: 'C-1', title: '하위 작업', status: 'done', parent_id: 'P-1' }, false),
    { action: 'update', ticket_id: 'C-1', title: '하위 작업' },
  );
  // add_ticket_prerequisites — input ticket_id authoritative; title from cache.
  const prereq = trackedTicketTool('mcp__awb__add_ticket_prerequisites', { ticket_id: 'T-5', prerequisite_ticket_ids: ['P'] });
  assert.deepEqual(
    resolveTicketRef(prereq, { ticket_id: 'T-5', prerequisites: [{ prerequisite_ticket_id: 'P' }] }, false, () => '의존 티켓'),
    { action: 'prereq', ticket_id: 'T-5', title: '의존 티켓' },
  );
  // await_ci_run — blocking-flag mutation; ticket from input.
  const ci = trackedTicketTool('mcp__awb__await_ci_run', { ticket_id: 'T-7', run_url: 'https://ci.example/1' });
  assert.deepEqual(
    resolveTicketRef(ci, { ok: true, ticket_id: 'T-7' }, false),
    { action: 'ci_wait', ticket_id: 'T-7' },
  );
});

test('formatTicketRefsContent: expanded action labels render in Korean', () => {
  const content = formatTicketRefsContent([
    { action: 'release', ticket_id: 'T-1', title: '해제' },
    { action: 'unarchive', ticket_id: 'T-2' },
    { action: 'prereq', ticket_id: 'T-3', title: '의존' },
    { action: 'ci_wait', ticket_id: 'T-4' },
  ]);
  assert.equal(
    content,
    '📋 티켓 클레임 해제: 해제\n📋 티켓 아카이브 해제: T-2\n📋 티켓 선행조건: 의존\n📋 티켓 CI 대기: T-4',
  );
});

// ── 2차 재요청 대응 (ticket 24694916): typed-comment mutations ──
// 리뷰어 지적 — ask_question / answer_question / record_decision 은 comment row 를
// 만들거나 질문 상태를 바꾸는 성공 mutation 인데 미분류라 카드가 조용히 누락됐다.
// (reject_handoff 다중-ref 경로는 board-less 전환으로 tool 과 함께 삭제됐다.)

test('trackedTicketTool: typed-comment mutations (ask/answer/decision) are tracked', () => {
  // ask_question / record_decision carry an INPUT ticket_id (authoritative).
  const ask = trackedTicketTool('mcp__awb__ask_question', { ticket_id: 'T-1', content: 'Q?' });
  assert.deepEqual(ask, { action: 'question', fromResult: false, inputTicketId: 'T-1', inputTitle: undefined });
  const decide = trackedTicketTool('mcp__awb__record_decision', { ticket_id: 'T-3', content: 'We will X' });
  assert.deepEqual(decide, { action: 'decision', fromResult: false, inputTicketId: 'T-3', inputTitle: undefined });
  // answer_question keys on question_comment_id — NO input ticket_id. It is still
  // tracked; the ticket id is resolved from the result row (see next test).
  const answer = trackedTicketTool('mcp__awb__answer_question', { question_comment_id: 'CMT-q', content: 'A.' });
  assert.deepEqual(answer, { action: 'answer', fromResult: false, inputTicketId: undefined, inputTitle: undefined });
});

test('resolveTicketRef: comment-mutation success paths each emit a card (누락 없이)', () => {
  // ask_question → result is the question comment {id, ticket_id}; ticket from input.
  const ask = trackedTicketTool('mcp__awb__ask_question', { ticket_id: 'T-1', content: 'Q?' });
  assert.deepEqual(
    resolveTicketRef(ask, { id: 'CMT-q', ticket_id: 'T-1', type: 'question', status: 'open' }, false, () => '질문 대상'),
    { action: 'question', ticket_id: 'T-1', title: '질문 대상' },
  );
  // answer_question → result is the answer comment; INPUT has no ticket_id, so the
  // ticket MUST come from the result row's ticket_id (never the comment id CMT-a).
  const answer = trackedTicketTool('mcp__awb__answer_question', { question_comment_id: 'CMT-q', content: 'A.' });
  assert.deepEqual(
    resolveTicketRef(answer, { id: 'CMT-a', ticket_id: 'T-1', type: 'answer', parent_id: 'CMT-q' }, false),
    { action: 'answer', ticket_id: 'T-1' },
  );
  // record_decision → result is the decision comment; ticket from input.
  const decide = trackedTicketTool('mcp__awb__record_decision', { ticket_id: 'T-3', content: 'We will X' });
  assert.deepEqual(
    resolveTicketRef(decide, { id: 'CMT-d', ticket_id: 'T-3', type: 'decision' }, false),
    { action: 'decision', ticket_id: 'T-3' },
  );
});

test('formatTicketRefsContent: comment action labels render in Korean', () => {
  const content = formatTicketRefsContent([
    { action: 'question', ticket_id: 'T-1', title: '질문' },
    { action: 'answer', ticket_id: 'T-2' },
    { action: 'decision', ticket_id: 'T-3', title: '결정문' },
  ]);
  assert.equal(
    content,
    '📋 티켓 질문: 질문\n📋 티켓 답변: T-2\n📋 티켓 결정: 결정문',
  );
});

// ── 3차 재요청 대응 (ticket 24694916): per-turn ref 절단 → 다중 메시지 chunking ──
// 리뷰어 지적 — 한 turn 에서 21개+ 성공 액션이면 매니저의 per-turn cap(20)이 21번째
// 이후를 조용히 버려 수용기준 #1("누락 없이") 위배. 서버 sanitizer 는 message 당 20개
// 로 bound 하므로, 매니저는 refs 를 20개씩 여러 메시지로 chunk 해 전부 방출해야 한다.
// 아래는 그 chunking 산술을 순수 단위로 고정한다(방출 자체는 chat-ticket-card-flush).

test('chunkTicketRefs: 21 refs split into 20 + 1, every ticket_id preserved in order', () => {
  const refs = Array.from({ length: 21 }, (_, i) => ({ action: 'create', ticket_id: `T-${i}` }));
  const chunks = chunkTicketRefs(refs, 20);
  assert.equal(chunks.length, 2, 'one over the per-message bound → a SECOND card, not a drop');
  assert.equal(chunks[0].length, 20, 'first message carries a full 20');
  assert.equal(chunks[1].length, 1, 'the 21st is carried, never truncated (누락 없이)');
  // Flatten back and prove the union equals the input exactly (order + ids).
  const flat = chunks.flat();
  assert.equal(flat.length, 21, 'no ref dropped across the split');
  assert.deepEqual(flat.map((r) => r.ticket_id), refs.map((r) => r.ticket_id), 'order preserved');
  assert.equal(new Set(flat.map((r) => r.ticket_id)).size, 21, 'all 21 distinct ids survive');
});

test('chunkTicketRefs: boundary + degenerate sizes', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ action: 'move', ticket_id: `T-${i}` }));
  assert.deepEqual(chunkTicketRefs([], 20), [], 'empty input → no messages');
  assert.equal(chunkTicketRefs(mk(20), 20).length, 1, 'exactly the bound → a single card');
  const forty = chunkTicketRefs(mk(40), 20);
  assert.deepEqual(forty.map((c) => c.length), [20, 20], 'exact multiple → even split');
  assert.deepEqual(chunkTicketRefs(mk(45), 20).map((c) => c.length), [20, 20, 5], 'remainder rides the last card');
  // Defensive: a non-positive size never divides-by-zero / infinite-loops — one chunk.
  assert.equal(chunkTicketRefs(mk(5), 0).length, 1, 'size 0 collapses to a single chunk');
  assert.equal(chunkTicketRefs(mk(5), -3).length, 1, 'negative size collapses to a single chunk');
});
