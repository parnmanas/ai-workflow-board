import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAgentCommentPingPongGuard,
  shouldPendRepeatedWaiting,
  shouldSuppressTerminalAck,
  terminalAckKey,
} from '../dist/common/agent-comment-pingpong.js';

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

test('comment write boundary: third real waiting phrase stores only one pending audit', async () => {
  let pendingSaves = 0;
  let activities = 0;
  let commentSaves = 0;
  let mentionEvents = 0;
  const ticket = { id: 't1', title: '대기', description: 'planner 구현 계획 없음; 구현 대상 없음' };
  const recent = [ack('대기 유지: in-progress 0건'), ack('대기 결정: 작업 대상 없음')];
  const attempt = async () => {
    const result = await applyAgentCommentPingPongGuard({
      ticket, next: ack('대기 유지: planner 구현 계획 없음'), recent,
      pend: async () => { ticket.pending_user_action = true; pendingSaves++; activities++; },
    });
    if (!result.suppressed) { commentSaves++; mentionEvents++; }
    return result;
  };
  assert.equal((await attempt()).reason, 'repeated_waiting_without_work_target');
  assert.equal((await attempt()).reason, 'pending_user_action');
  assert.deepEqual({ pendingSaves, activities, commentSaves, mentionEvents },
    { pendingSaves: 1, activities: 1, commentSaves: 0, mentionEvents: 0 });
});

test('Review to Merging write boundary stores approval once and emits no duplicate receipt mention', async () => {
  const recent = [];
  let commentSaves = 0;
  let mentionEvents = 0;
  const write = async (next) => {
    const result = await applyAgentCommentPingPongGuard({
      ticket: { id: 't2', title: '구체 작업', base_repo_resource_id: 'repo-1' },
      next, recent, pend: async () => assert.fail('must not pend an actionable ticket'),
    });
    if (!result.suppressed) { recent.unshift(next); commentSaves++; mentionEvents++; }
    return result;
  };
  assert.equal((await write(ack('6bd700c9 승인, blocker 없음'))).suppressed, false);
  assert.equal((await write(ack('6bd700c9 승인 확인, blocker 없음'))).reason, 'duplicate_terminal_acknowledgement');
  assert.equal((await write(ack('6bd700c9 approved; no blockers'))).reason, 'duplicate_terminal_acknowledgement');
  assert.deepEqual({ commentSaves, mentionEvents }, { commentSaves: 1, mentionEvents: 1 });
});
