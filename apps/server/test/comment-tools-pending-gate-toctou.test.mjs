// TOCTOU 재조회 회귀 테스트 — Q&A 4개 툴 (ask_question / answer_question /
// record_decision / handoff_to_agent). ticket 4f99a9f5, be934f61의
// add_comment freshForGate 패턴을 이식한 후속.
//
// 8fc94adf가 이식한 얼리 가드(isPendingUserActionBlocked, see
// comment-tools-pending-gate.test.mjs)는 핸들러 상단에서 1회 로드한 stale
// in-memory ticket 객체만 검사한다. 그 로드~저장 사이(resolveAuthor /
// hard-budget / resolveAuthorRole 등 다수의 await)에 별도 요청의
// pend_ticket 이 끼어들면 stale 객체에는 반영되지 않아 얼리 가드를 그대로
// 통과해버린다. 4f99a9f5는 각 핸들러의 저장 직전에 freshPendingGateBlocked
// 재조회를 추가해 이 창을 닫는다.
//
// agent-comment-pingpong.test.mjs의 add_comment TOCTOU 테스트("TOCTOU
// re-check before the write")와 동일한 기법을 쓴다: ticketRepo.findOne 을
// 호출 횟수별로 다른 상태를 반환하는 findOneImpl 오버라이드로 감싸, 실제
// concurrency 없이 로드~저장 창의 레이스를 결정론적으로 재현한다 — 1번째
// 호출(핸들러 상단 얼리 가드의 로드)은 pending=false, 2번째 이후(이번
// 수정으로 추가된 저장 직전 재확인)는 pending=true.
//
// Runs against compiled dist/ (requires `npm run build`) with a fully mocked
// DataSource — same recipe as agent-comment-pingpong.test.mjs's
// registeredAddCommentHarness — rather than a real sql.js DB, so the
// load-to-save race can be modeled deterministically without hooking a real
// repository.

import assert from 'node:assert/strict';
import test from 'node:test';
import { registerCommentTools } from '../dist/modules/mcp/tools/comment-tools.js';
import { Ticket } from '../dist/entities/Ticket.js';
import { Comment } from '../dist/entities/Comment.js';
import { Agent } from '../dist/entities/Agent.js';

function harness({ ticket, comments = [], agents = [], findOneImpl = null }) {
  const handlers = new Map();
  const server = { tool(name, _description, _schema, handler) { handlers.set(name, handler); } };
  const commentsById = new Map(comments.map((c) => [c.id, c]));
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  const counters = { commentSaves: 0, ticketSaves: 0, activities: 0 };
  let ticketFindOneCalls = 0;

  const commentRepo = {
    async findOne({ where: { id } }) { return commentsById.get(id) || null; },
    // handoff_to_agent's success path stamps agent_chain_depth via
    // computeTicketCommentChainDepth (ticket 07402c57), which calls find()
    // rather than findOne() — only exercised once a handoff actually saves.
    async find({ where: { ticket_id } }) {
      return [...commentsById.values()].filter((c) => c.ticket_id === ticket_id);
    },
    create(value) { return value; },
    async save(value) {
      const row = { id: value.id || `c${commentsById.size + 1}`, created_at: new Date(), ...value };
      commentsById.set(row.id, row);
      counters.commentSaves++;
      return row;
    },
    async update(where, patch) {
      const row = commentsById.get(where.id);
      if (row) Object.assign(row, patch);
    },
  };
  const ticketRepo = {
    // findOneImpl lets a test model the load-to-save TOCTOU window (ticket
    // be934f61 pattern): a per-call override that reports a DIFFERENT
    // pending state on the fix's re-check than on the handler's initial
    // load, the same way a concurrent pend_ticket() would race a real DB
    // round-trip. Every other test relies on the default (the live `ticket`
    // reference) and is unaffected.
    async findOne() {
      ticketFindOneCalls += 1;
      return findOneImpl ? findOneImpl(ticketFindOneCalls) : ticket;
    },
    async save(value) { counters.ticketSaves++; return value; },
    async update() { return { affected: 0 }; },
  };
  const agentRepo = {
    async findOne({ where: { id } }) { return agentsById.get(id) || null; },
  };
  const dataSource = {
    getRepository(entity) {
      if (entity === Ticket) return ticketRepo;
      if (entity === Comment) return commentRepo;
      if (entity === Agent) return agentRepo;
      return { async findOne() { return null; }, create(v) { return v; }, async save(v) { return v; }, async findBy() { return []; } };
    },
  };
  const ctx = {
    dataSource,
    activityService: { async logActivity() { counters.activities++; } },
    mentionService: { parseMentions: () => [], async resolveMentions() { return []; } },
    logger: { info() {}, warn() {}, error() {} },
    ticketRoleAssignmentService: null,
  };
  registerCommentTools(server, ctx);
  return { handlers, counters, ticket, commentsById, agentsById, getTicketFindOneCalls: () => ticketFindOneCalls };
}

// 1번째 호출(얼리 가드)은 원래 상태, 2번째 이후(저장 직전 재확인)는 그
// 사이 사람이 pend 한 것처럼 pending_user_action=true를 반환.
function pendsAfterFirstLoad(baseTicket) {
  return (callNo) => (callNo === 1
    ? { ...baseTicket, pending_user_action: false }
    : { ...baseTicket, pending_user_action: true });
}

const AGENT_INPUT = { author_type: 'agent', author_id: 'a1', author: 'A' };

test('ask_question: blocks the save when pending_user_action flips true after the initial load (TOCTOU fix)', async () => {
  const ticket = { id: 't1', workspace_id: 'w1', pending_user_action: false };
  const h = harness({ ticket, findOneImpl: pendsAfterFirstLoad(ticket) });

  const res = await h.handlers.get('ask_question')({ ticket_id: 't1', content: '질문', ...AGENT_INPUT }, {});
  const parsed = JSON.parse(res.content[0].text);

  assert.equal(h.getTicketFindOneCalls(), 2, '얼리 가드 로드 + 저장 직전 재확인, 총 2회 조회해야 함');
  assert.deepEqual(parsed, { suppressed: true, reason: 'pending_user_action' });
  assert.equal(h.counters.commentSaves, 0, '재확인에서 막혔으면 질문 코멘트가 저장되면 안 됨');
});

test('ask_question: saves normally when nothing pends in the load-to-save window (regression baseline)', async () => {
  const ticket = { id: 't2', workspace_id: 'w1', pending_user_action: false };
  const h = harness({ ticket });

  const res = await h.handlers.get('ask_question')({ ticket_id: 't2', content: '질문', ...AGENT_INPUT }, {});
  const parsed = JSON.parse(res.content[0].text);

  assert.equal(parsed.suppressed, undefined, '아무도 pend하지 않았으면 억제되면 안 됨');
  assert.equal(h.counters.commentSaves, 1);
});

test('ask_question: user-authored calls skip the re-check (only the initial load reads the ticket)', async () => {
  const ticket = { id: 't3', workspace_id: 'w1', pending_user_action: false };
  const h = harness({ ticket, findOneImpl: () => ticket });

  const res = await h.handlers.get('ask_question')(
    { ticket_id: 't3', content: '사람 질문', author_type: 'user', author_id: 'u1', author: 'U' }, {},
  );
  const parsed = JSON.parse(res.content[0].text);

  assert.equal(h.getTicketFindOneCalls(), 1, 'user 저작은 재확인 대상이 아님 — 초기 로드 1회만 조회해야 함');
  assert.equal(parsed.suppressed, undefined);
  assert.equal(h.counters.commentSaves, 1);
});

test('answer_question: blocks the save when pending_user_action flips true after the initial load (TOCTOU fix)', async () => {
  const ticket = { id: 't4', workspace_id: 'w1', pending_user_action: false };
  const question = { id: 'q1', ticket_id: 't4', type: 'question', status: 'open', author_type: 'user', author: 'U', content: 'Q?' };
  const h = harness({ ticket, comments: [question], findOneImpl: pendsAfterFirstLoad(ticket) });

  const res = await h.handlers.get('answer_question')(
    { question_comment_id: 'q1', content: '답변', ...AGENT_INPUT }, {},
  );
  const parsed = JSON.parse(res.content[0].text);

  assert.equal(h.getTicketFindOneCalls(), 2);
  assert.deepEqual(parsed, { suppressed: true, reason: 'pending_user_action' });
  assert.equal(h.counters.commentSaves, 0, '답변이 저장되면 안 됨');
  assert.equal(h.commentsById.get('q1').status, 'open', '막힌 답변이 질문을 auto-resolve 하면 안 됨');
});

test('answer_question: saves normally when nothing pends in the load-to-save window (regression baseline)', async () => {
  const ticket = { id: 't5', workspace_id: 'w1', pending_user_action: false };
  const question = { id: 'q2', ticket_id: 't5', type: 'question', status: 'open', author_type: 'user', author: 'U', content: 'Q?' };
  const h = harness({ ticket, comments: [question] });

  const res = await h.handlers.get('answer_question')(
    { question_comment_id: 'q2', content: '답변', ...AGENT_INPUT }, {},
  );
  const parsed = JSON.parse(res.content[0].text);

  assert.equal(parsed.suppressed, undefined);
  assert.equal(h.counters.commentSaves, 1);
  assert.equal(h.commentsById.get('q2').status, 'resolved');
});

test('record_decision: blocks the save when pending_user_action flips true after the initial load (TOCTOU fix)', async () => {
  const ticket = { id: 't6', workspace_id: 'w1', pending_user_action: false };
  const h = harness({ ticket, findOneImpl: pendsAfterFirstLoad(ticket) });

  const res = await h.handlers.get('record_decision')({ ticket_id: 't6', content: '결정', ...AGENT_INPUT }, {});
  const parsed = JSON.parse(res.content[0].text);

  assert.equal(h.getTicketFindOneCalls(), 2);
  assert.deepEqual(parsed, { suppressed: true, reason: 'pending_user_action' });
  assert.equal(h.counters.commentSaves, 0, '결정 코멘트가 저장되면 안 됨');
});

test('record_decision: saves normally when nothing pends in the load-to-save window (regression baseline)', async () => {
  const ticket = { id: 't7', workspace_id: 'w1', pending_user_action: false };
  const h = harness({ ticket });

  const res = await h.handlers.get('record_decision')({ ticket_id: 't7', content: '결정', ...AGENT_INPUT }, {});
  const parsed = JSON.parse(res.content[0].text);

  assert.equal(parsed.suppressed, undefined);
  assert.equal(h.counters.commentSaves, 1);
});

test('handoff_to_agent: blocks the save AND the reassignment when pending_user_action flips true after the initial load (TOCTOU fix)', async () => {
  const ticket = { id: 't8', workspace_id: 'w1', pending_user_action: false, assignee_id: 'orig', assignee: 'Original' };
  const targetAgent = { id: 'target1', name: 'Target', workspace_id: 'w1', role_prompt: '' };
  const h = harness({ ticket, agents: [targetAgent], findOneImpl: pendsAfterFirstLoad(ticket) });

  const res = await h.handlers.get('handoff_to_agent')(
    { ticket_id: 't8', target_agent_id: 'target1', content: '인계', ...AGENT_INPUT }, {},
  );
  const parsed = JSON.parse(res.content[0].text);

  assert.equal(h.getTicketFindOneCalls(), 2);
  assert.deepEqual(parsed, { suppressed: true, reason: 'pending_user_action' });
  assert.equal(h.counters.commentSaves, 0, '핸드오프 코멘트가 저장되면 안 됨');
  assert.equal(h.counters.ticketSaves, 0, '재배정도 함께 막혀야 함 — 얼리 가드와 동일 스코프');
  assert.equal(ticket.assignee_id, 'orig', '원래 담당자가 유지돼야 함');
});

test('handoff_to_agent: succeeds normally when nothing pends in the load-to-save window (regression baseline)', async () => {
  const ticket = { id: 't9', workspace_id: 'w1', pending_user_action: false, assignee_id: 'orig', assignee: 'Original' };
  const targetAgent = { id: 'target2', name: 'Target2', workspace_id: 'w1', role_prompt: '' };
  const h = harness({ ticket, agents: [targetAgent] });

  const res = await h.handlers.get('handoff_to_agent')(
    { ticket_id: 't9', target_agent_id: 'target2', content: '인계', ...AGENT_INPUT }, {},
  );
  const parsed = JSON.parse(res.content[0].text);

  assert.equal(parsed.suppressed, undefined);
  assert.equal(h.counters.commentSaves, 1);
  assert.equal(h.counters.ticketSaves, 1);
});
