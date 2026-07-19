import assert from 'node:assert/strict';
import test from 'node:test';
import { isAgentTerminalAcknowledgement } from '../dist/lib/terminal-ack-guard.js';

test('manager suppresses only same-state terminal approval acknowledgements', () => {
  assert.equal(isAgentTerminalAcknowledgement({
    actor_type: 'agent', content: '89ac69f 승인 확인, blocker 없음',
  }), true);
  assert.equal(isAgentTerminalAcknowledgement({
    actor_type: 'agent', terminal_ack: true, content: 'receipt',
  }), true);
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
