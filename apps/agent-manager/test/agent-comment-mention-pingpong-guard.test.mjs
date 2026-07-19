import assert from 'node:assert/strict';
import test from 'node:test';
import { isAgentTerminalAcknowledgement } from '../dist/lib/terminal-ack-guard.js';
import { EventDispatcher } from '../dist/lib/event-dispatcher.js';

test('manager suppresses only same-state terminal approval acknowledgements', () => {
  assert.equal(isAgentTerminalAcknowledgement({
    actor_type: 'agent', content: '89ac69f 승인 확인, blocker 없음',
  }), true);
  assert.equal(isAgentTerminalAcknowledgement({
    actor_type: 'agent', terminal_ack: true, content: 'receipt', metadata: { event_id: 'approval-1' },
  }), true);
  assert.equal(isAgentTerminalAcknowledgement({
    actor_type: 'agent', terminal_ack: true, content: 'receipt',
  }), false, 'identity-free structured events must not suppress a later approval cycle');
});

test('manager delivers real agent work mentions', () => {
  for (const content of [
    '89ac69f 승인 관련 질문이 있습니다?',
    '89ac69f 변경 요청: 테스트를 추가해 주세요',
    'agent handoff: 새 작업을 맡아 주세요',
    'consensus 합의가 필요합니다',
  ]) assert.equal(isAgentTerminalAcknowledgement({ actor_type: 'agent', content }), false);
  assert.equal(isAgentTerminalAcknowledgement({ actor_type: 'user', content: '89ac69f 승인, blocker 없음' }), false);
});

test('EventDispatcher suppresses terminal receipts before forward/defer/spawn but forwards questions', async () => {
  let forwards = 0;
  let spawns = 0;
  const dispatcher = new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test', delegation: { enabled: true, persistentTicketSessions: true } },
    {
      ticketSessionManager: { forwardCommentMention() { forwards++; return true; } },
      subagentManager: { canSpawn() { return true; }, async spawn() { spawns++; return { spawned: true }; } },
    },
  );
  const base = { ticket_id: 'T1', comment_id: 'C1', agent_id: 'A1', actor_id: 'A2', actor_type: 'agent' };
  await dispatcher.handleCommentMention(JSON.stringify({ ...base, content: '89ac69f 승인, blocker 없음' }));
  assert.deepEqual({ forwards, spawns }, { forwards: 0, spawns: 0 });
  await dispatcher.handleCommentMention(JSON.stringify({ ...base, comment_id: 'C2', content: '89ac69f 승인 관련 질문?' }));
  assert.deepEqual({ forwards, spawns }, { forwards: 1, spawns: 0 });
});
