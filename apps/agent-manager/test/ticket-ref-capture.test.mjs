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
  resolveBatchTicketRefs,
  resolveRejectHandoffRefs,
  formatTicketRefsContent,
} from '../dist/lib/ticket-ref-capture.js';

test('bareToolName strips the MCP server prefix, tolerating any prefix', () => {
  assert.equal(bareToolName('mcp__awb__create_ticket'), 'create_ticket');
  assert.equal(bareToolName('mcp__ai-workflow-board__move_ticket'), 'move_ticket');
  assert.equal(bareToolName('Bash'), 'Bash'); // no `__` → unchanged
});

test('trackedTicketTool: mutating ticket tools tracked, reads/other tools ignored', () => {
  const create = trackedTicketTool('mcp__awb__create_ticket', { title: 'New', priority: 'high' });
  assert.deepEqual(create, { action: 'create', fromResult: true, inputTicketId: undefined, inputTitle: 'New' });

  const move = trackedTicketTool('mcp__awb__move_ticket', { ticket_id: 'T-1', target_column_name: 'Review' });
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
  const ref = resolveTicketRef(ctx, { id: 'T-7', title: 'Moved', column_id: 'c' }, false);
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
// 확장된 지원 표면·의도적 제외·신규 성공 경로·batch 다중-ref 를 고정한다.

test('trackedTicketTool: expanded ticket-mutation surface is fully tracked', () => {
  const cases = [
    ['update_child_ticket', { ticket_id: 'C-1', status: 'done' }, 'update', 'C-1'],
    ['move_ticket_to_board', { ticket_id: 'T-2', target_board_id: 'B-9' }, 'move', 'T-2'],
    ['release_ticket', { ticket_id: 'T-3', agent_id: 'A-1' }, 'release', 'T-3'],
    ['unarchive_ticket', { ticket_id: 'T-4' }, 'unarchive', 'T-4'],
    ['add_ticket_prerequisites', { ticket_id: 'T-5', prerequisite_ticket_ids: ['P'] }, 'prereq', 'T-5'],
    ['remove_ticket_prerequisite', { ticket_id: 'T-6', prerequisite_ticket_id: 'P' }, 'prereq', 'T-6'],
    ['handoff_to_agent', { ticket_id: 'T-7', target_agent_id: 'A-2' }, 'handoff', 'T-7'],
    ['propose_move', { ticket_id: 'T-8', target_column_name: 'Review' }, 'propose', 'T-8'],
    ['record_agreement', { ticket_id: 'T-9', status: 'agree' }, 'consensus', 'T-9'],
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
  // create_remote_improvement_ticket files on ANOTHER instance → off-instance 404.
  assert.equal(trackedTicketTool('mcp__awb__create_remote_improvement_ticket', { source_ticket_id: 'T-1' }), null);
  // Reads + non-ticket tools stay ignored.
  assert.equal(trackedTicketTool('mcp__awb__get_ticket', { ticket_id: 'T-1' }), null);
  assert.equal(trackedTicketTool('mcp__awb__list_ticket_prerequisites', { ticket_id: 'T-1' }), null);
  assert.equal(trackedTicketTool('mcp__awb__create_board', { name: 'B' }), null);
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
  // handoff_to_agent — result is the handoff comment; ticket comes from input.
  const handoff = trackedTicketTool('mcp__awb__handoff_to_agent', { ticket_id: 'T-7', target_agent_id: 'A-2', content: 'x' });
  assert.deepEqual(
    resolveTicketRef(handoff, { id: 'CMT-h', ticket_id: 'T-7', type: 'handoff' }, false),
    { action: 'handoff', ticket_id: 'T-7' },
  );
  // propose_move — result is the proposal comment; ticket from input.
  const propose = trackedTicketTool('mcp__awb__propose_move', { ticket_id: 'T-8', target_column_name: 'Review' });
  assert.deepEqual(
    resolveTicketRef(propose, { comment: { id: 'CMT-p' } }, false, () => '제안 티켓'),
    { action: 'propose', ticket_id: 'T-8', title: '제안 티켓' },
  );
  // record_agreement — result is {comment, consensus, moved}; ticket from input.
  const agree = trackedTicketTool('mcp__awb__record_agreement', { ticket_id: 'T-9', status: 'agree' });
  assert.deepEqual(
    resolveTicketRef(agree, { comment: { id: 'CMT-a' }, consensus: {}, moved: false }, false),
    { action: 'consensus', ticket_id: 'T-9' },
  );
});

test('batch_operations: one call fans out to MANY refs, zipped with results[]', () => {
  const ctx = trackedTicketTool('mcp__awb__batch_operations', {
    operations: [
      { action: 'create-ticket', column: 'To Do', title: '배치 생성' },
      { action: 'move-ticket', ticketId: 'T-move', toColumn: 'Review' },
      { action: 'update-child', ticketId: 'C-done', status: 'done' },
      { action: 'add-comment', ticketId: 'T-cmt', author: 'a', content: 'hi' },
      { action: 'add-child', ticketId: 'P-1', title: '새 하위' },
      { action: 'move-ticket', ticketId: 'T-fail', toColumn: 'Nope' }, // fails on server
      { action: 'reindex-magic' },                                     // untracked op
    ],
  });
  assert.equal(ctx.action, 'batch');
  assert.ok(Array.isArray(ctx.batchOps) && ctx.batchOps.length === 7);

  const result = {
    results: [
      { success: true, ticketId: 'T-created' },              // create → NEW id
      { success: true, ticketId: 'T-move', movedTo: 'Review' },
      { success: true, ticketId: 'C-done' },
      { success: true, commentId: 'CMT-1' },                 // add-comment → only commentId
      { success: true, ticketId: 'CH-1' },                   // add-child → NEW child id
      { error: 'Column "Nope" not found' },                  // failed → no ref
      { error: 'Unknown action: reindex-magic' },            // untracked → no ref
    ],
  };
  const refs = resolveBatchTicketRefs(ctx, result, false, (id) => (id === 'T-cmt' ? '코멘트 대상' : undefined));
  assert.deepEqual(refs, [
    { action: 'create', ticket_id: 'T-created', title: '배치 생성' }, // title from op
    { action: 'move', ticket_id: 'T-move' },
    { action: 'update', ticket_id: 'C-done' },
    { action: 'comment', ticket_id: 'T-cmt', title: '코멘트 대상' },  // ticket from INPUT, title from cache
    { action: 'create', ticket_id: 'CH-1', title: '새 하위' },        // add-child NEW id, title from op
  ]);
});

test('resolveBatchTicketRefs: whole-tool error or malformed result yields nothing', () => {
  const ctx = trackedTicketTool('mcp__awb__batch_operations', {
    operations: [{ action: 'create-ticket', title: 'X' }],
  });
  // A tool_result flagged is_error → emit nothing even if a stray results[] is present.
  assert.deepEqual(resolveBatchTicketRefs(ctx, { results: [{ success: true, ticketId: 'T' }] }, true), []);
  // No results[] array (an error string / unexpected shape) → nothing.
  assert.deepEqual(resolveBatchTicketRefs(ctx, { error: 'boom' }, false), []);
  assert.deepEqual(resolveBatchTicketRefs(ctx, 'nope', false), []);
});

test('formatTicketRefsContent: expanded action labels render in Korean', () => {
  const content = formatTicketRefsContent([
    { action: 'release', ticket_id: 'T-1', title: '해제' },
    { action: 'unarchive', ticket_id: 'T-2' },
    { action: 'prereq', ticket_id: 'T-3', title: '의존' },
    { action: 'handoff', ticket_id: 'T-4' },
    { action: 'propose', ticket_id: 'T-5' },
    { action: 'consensus', ticket_id: 'T-6' },
  ]);
  assert.equal(
    content,
    '📋 티켓 클레임 해제: 해제\n📋 티켓 아카이브 해제: T-2\n📋 티켓 선행조건: 의존\n📋 티켓 핸드오프: T-4\n📋 티켓 이동 제안: T-5\n📋 티켓 합의: T-6',
  );
});

// ── 2차 재요청 대응 (ticket 24694916): typed-comment mutations + reject_handoff ──
// 리뷰어 지적 — ask_question / answer_question / record_decision 은 comment row 를
// 만들거나 질문 상태를 바꾸는 성공 mutation 인데 미분류라 카드가 조용히 누락됐고,
// reject_handoff 는 "비표준 키" 라는 이유로 제외됐지만 실제로는 defect 티켓을 생성하는
// 명백한 mutation. 아래 테스트가 세 comment 경로와 reject_handoff 다중-ref 를 고정한다.

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

test('reject_handoff: one result → defect (reject) + re-blocked follow-up (prereq)', () => {
  const ctx = trackedTicketTool('mcp__awb__reject_handoff', { followup_ticket_id: 'F-1', reason: '결함' });
  assert.equal(ctx.action, 'reject');
  assert.equal(ctx.rejectHandoff, true);
  assert.equal(ctx.inputTicketId, 'F-1');
  // Real result shape: HandoffService.rejectHandoff → {defect_ticket_id, defect_board_id,
  // source_ticket_id, followup_pending_on_tickets} spread + {followup: <full ticket>}.
  const result = {
    defect_ticket_id: 'D-9',
    defect_board_id: 'B-src',
    source_ticket_id: 'S-1',
    followup_pending_on_tickets: true,
    followup: { id: 'F-1', title: '후속 작업', column_id: 'c' },
  };
  const refs = resolveRejectHandoffRefs(ctx, result, false, (id) => (id === 'D-9' ? '반려 결함 티켓' : undefined));
  assert.deepEqual(refs, [
    { action: 'reject', ticket_id: 'D-9', title: '반려 결함 티켓' }, // defect: title from cache
    { action: 'prereq', ticket_id: 'F-1', title: '후속 작업' },      // follow-up: title from result
  ]);
  // Fail-closed: an errored tool_result, or a shape with no defect id, emits nothing
  // relevant. A missing followup still yields the defect ref alone.
  assert.deepEqual(resolveRejectHandoffRefs(ctx, result, true), []);
  assert.deepEqual(resolveRejectHandoffRefs(ctx, { message: 'not a handoff relay' }, false), []);
  assert.deepEqual(
    resolveRejectHandoffRefs(
      trackedTicketTool('mcp__awb__reject_handoff', { followup_ticket_id: 'F-2' }),
      { defect_ticket_id: 'D-2' }, false,
    ),
    [{ action: 'reject', ticket_id: 'D-2' }, { action: 'prereq', ticket_id: 'F-2' }],
  );
});

test('formatTicketRefsContent: comment + reject action labels render in Korean', () => {
  const content = formatTicketRefsContent([
    { action: 'question', ticket_id: 'T-1', title: '질문' },
    { action: 'answer', ticket_id: 'T-2' },
    { action: 'decision', ticket_id: 'T-3', title: '결정문' },
    { action: 'reject', ticket_id: 'D-9', title: '반려 결함' },
  ]);
  assert.equal(
    content,
    '📋 티켓 질문: 질문\n📋 티켓 답변: T-2\n📋 티켓 결정: 결정문\n📋 티켓 반려: 반려 결함',
  );
});
