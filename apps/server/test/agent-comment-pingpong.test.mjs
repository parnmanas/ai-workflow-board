import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
  assert.equal(shouldPendRepeatedWaiting({ next, recent, ticketDescription: 'apps/server/src/a.ts 구현' }), false);
});
