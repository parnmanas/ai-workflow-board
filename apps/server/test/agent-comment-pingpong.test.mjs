import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldPendRepeatedWaiting,
  shouldSuppressTerminalAck,
  terminalAckKey,
} from '../dist/common/agent-comment-pingpong.js';
import { registerCommentTools } from '../dist/modules/mcp/tools/comment-tools.js';
import { Ticket } from '../dist/entities/Ticket.js';
import { Comment } from '../dist/entities/Comment.js';
import { Agent } from '../dist/entities/Agent.js';
import { activityEvents } from '../dist/services/activity.service.js';

const ack = (content, metadata) => ({ author_type: 'agent', content, metadata });

test('Review to Merging permits one approval and suppresses same SHA/state receipts', () => {
  const approval = ack('6bd700c9 승인, blocker 없음');
  assert.equal(shouldSuppressTerminalAck(approval, []), false);
  assert.equal(shouldSuppressTerminalAck(ack('6bd700c9 approved; no blockers'), [approval]), true);
  assert.equal(shouldSuppressTerminalAck(ack('6bd700c9 승인 확인, blocker 없음'), [approval]), true);
});

test('structured terminal events share the same semantic key', () => {
  const structured = ack('receipt', { terminal_ack: true, sha: '6bd700c9', approval_status: 'approved', blocker_status: 'none' });
  assert.equal(terminalAckKey(structured), '6bd700c9:approved:none');
  assert.equal(shouldSuppressTerminalAck(structured, [structured]), true);
  assert.equal(terminalAckKey(ack('receipt', { terminal_ack: true })), null);
  assert.equal(
    terminalAckKey(ack('receipt', { terminal_ack: true, transition_id: 'review-42' })),
    'cycle:review-42:approved:none',
  );
});

test('questions, change requests and handoffs are delivered', () => {
  for (const content of ['6bd700c9 승인 질문?', '6bd700c9 변경 요청', 'handoff 새 작업', 'consensus 합의']) {
    assert.equal(terminalAckKey(ack(content)), null);
  }
});

test('third waiting comment without a work target pends; actionable tickets do not', () => {
  const recent = [ack('대기 유지: in-progress 0건'), ack('대기 결정: 작업 대상 없음')];
  const next = ack('대기 유지: waiting');
  assert.equal(shouldPendRepeatedWaiting({ next, recent, ticketDescription: '사람의 결정 대기' }), true);
  assert.equal(shouldPendRepeatedWaiting({ next, recent, ticketDescription: 'planner 구현 계획 없음; 구현 대상 없음' }), true);
  assert.equal(shouldPendRepeatedWaiting({ next, recent, ticketDescription: 'apps/server/src/a.ts 구현' }), false);
});

function registeredAddCommentHarness({ ticket, recent = [], concurrentReads = 0 }) {
  const handlers = new Map();
  const server = { tool(name, _description, _schema, handler) { handlers.set(name, handler); } };
  const stored = [...recent];
  const uniqueKeys = new Set(stored.map(c => c.operational_recurrence_key).filter(Boolean));
  const counters = { commentSaves: 0, activities: 0, mentionResolves: 0, pendingUpdates: 0 };
  let readCount = 0;
  let releaseReads;
  const readsReleased = concurrentReads > 0 ? new Promise(resolve => { releaseReads = resolve; }) : null;

  const commentRepo = {
    async find() {
      const snapshot = [...stored];
      if (concurrentReads > 0 && ++readCount <= concurrentReads) {
        if (readCount === concurrentReads) releaseReads();
        await readsReleased;
      }
      return snapshot;
    },
    async findOne() { return null; },
    create(value) { return value; },
    async save(value) {
      if (value.operational_recurrence_key && uniqueKeys.has(value.operational_recurrence_key)) {
        const error = new Error('unique constraint failed: comments.operational_recurrence_key');
        error.code = 'SQLITE_CONSTRAINT';
        throw error;
      }
      if (value.operational_recurrence_key) uniqueKeys.add(value.operational_recurrence_key);
      const row = { id: `c${stored.length + 1}`, created_at: new Date(), ...value };
      stored.unshift(row);
      counters.commentSaves++;
      return row;
    },
    async update() {},
  };
  const ticketRepo = {
    async findOne() { return ticket; },
    async update(where, patch) {
      if (where.pending_user_action === false && ticket.pending_user_action === false) {
        Object.assign(ticket, patch);
        counters.pendingUpdates++;
        return { affected: 1 };
      }
      return { affected: 0 };
    },
  };
  const agentRepo = { async findOne() { return { id: 'reviewer', name: 'Reviewer', workspace_id: ticket.workspace_id, role_prompt: '' }; } };
  const dataSource = { getRepository(entity) {
    if (entity === Ticket) return ticketRepo;
    if (entity === Comment) return commentRepo;
    if (entity === Agent) return agentRepo;
    return { async findOne() { return null; }, create(v) { return v; }, async save(v) { return v; }, async findBy() { return []; } };
  } };
  const ctx = {
    dataSource,
    activityService: { async logActivity() { counters.activities++; } },
    mentionService: {
      parseMentions(content) { return content.includes('@[role:reviewer') ? [{}] : []; },
      async resolveMentions() { counters.mentionResolves++; return [{ type: 'agent', id: 'reviewer', roleShortcut: 'reviewer' }]; },
    },
    logger: { info() {}, warn() {}, error() {} },
    ticketRoleAssignmentService: null,
  };
  registerCommentTools(server, ctx);
  return { addComment: handlers.get('add_comment'), counters, stored };
}

test('registered add_comment boundary atomically pends concurrent third waits with one audit and no save/mention', async () => {
  const ticket = { id: 't1', workspace_id: 'w1', title: '대기', description: 'planner 구현 계획 없음; 구현 대상 없음', pending_user_action: false };
  const harness = registeredAddCommentHarness({
    ticket,
    recent: [ack('대기 유지: in-progress 0건'), ack('대기 결정: 작업 대상 없음')],
    concurrentReads: 2,
  });
  const input = { ticket_id: 't1', author_type: 'agent', author_id: 'assignee', author: 'Assignee', author_role: 'assignee', content: '대기 유지: planner 구현 계획 없음' };
  await Promise.all([harness.addComment({ ...input }, {}), harness.addComment({ ...input }, {})]);
  assert.deepEqual(harness.counters, { commentSaves: 0, activities: 1, mentionResolves: 0, pendingUpdates: 1 });
  await harness.addComment({ ...input }, {});
  assert.deepEqual(harness.counters, { commentSaves: 0, activities: 1, mentionResolves: 0, pendingUpdates: 1 });
});

test('registered add_comment Review to Merging boundary saves/emits one concurrent approval and zero later receipts', async () => {
  const ticket = { id: 't2', workspace_id: 'w1', title: '구체 작업', description: 'apps/server/src/a.ts', pending_user_action: false };
  const harness = registeredAddCommentHarness({ ticket, concurrentReads: 2 });
  let sseMentions = 0;
  const onMention = () => { sseMentions++; };
  activityEvents.on('comment_mention', onMention);
  try {
    const base = { ticket_id: 't2', author_type: 'agent', author_id: 'assignee', author: 'Assignee', author_role: 'assignee' };
    await Promise.all([
      harness.addComment({ ...base, content: '@[role:reviewer|Reviewer] 6bd700c9 승인, blocker 없음' }, {}),
      harness.addComment({ ...base, content: '@[role:reviewer|Reviewer] 6bd700c9 approved; no blockers' }, {}),
    ]);
    await harness.addComment({ ...base, content: '@[role:reviewer|Reviewer] 6bd700c9 승인 확인, blocker 없음' }, {});
    assert.deepEqual(harness.counters, { commentSaves: 1, activities: 1, mentionResolves: 1, pendingUpdates: 0 });
    assert.equal(sseMentions, 1);
  } finally {
    activityEvents.off('comment_mention', onMention);
  }
});
