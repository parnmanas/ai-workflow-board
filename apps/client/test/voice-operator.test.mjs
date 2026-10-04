// Operator(고정된 Agent Session) 화면 쪽 규칙 회귀 테스트 — docs/voice-operator.md "Operator".
// 실행: node --import tsx --test apps/client/test/voice-operator.test.mjs
//
// 고정하는 것:
//   1. operator 는 (Host, CLI, 세션 id) 셋이 모두 같은 세션 하나다 — CLI 만 달라도 다른 세션이다.
//   2. operator 지침은 말로 듣는 답(요약 먼저), 음성 인식 오류 되묻기, 되돌리기 어려운 일의 복창 확인을 담고,
//      지침 파일은 **없을 때만** 만들게 한다(저장소 안 세션이 그 저장소의 AGENTS.md 를 덮어쓰지 않게).
import test from 'node:test';
import assert from 'node:assert/strict';

import { OPERATOR_BRIEF, isOperatorSession } from '../src/voice/operator.ts';

const op = { manager_id: 'host-1', cli: 'claude', session_id: 's1', cwd: '', title: '', pinned_at: '', pinned_by: '' };

test('the operator is exactly one (host, cli, session) triple', () => {
  assert.equal(isOperatorSession(op, 'host-1', 'claude', 's1'), true);
  assert.equal(isOperatorSession(op, 'host-1', 'codex', 's1'), false);
  assert.equal(isOperatorSession(op, 'host-2', 'claude', 's1'), false);
  assert.equal(isOperatorSession(null, 'host-1', 'claude', 's1'), false);
});

test('the operator brief carries the voice rules and never overwrites an existing AGENTS.md', () => {
  assert.match(OPERATOR_BRIEF, /요약을 1~3문장/);
  assert.match(OPERATOR_BRIEF, /rolf\/ralf\/ragnar/);
  assert.match(OPERATOR_BRIEF, /복창하고 "네" 같은 명시적인 확인/);
  assert.match(OPERATOR_BRIEF, /AGENTS\.md 가 \*\*없을 때만\*\*/);
  assert.match(OPERATOR_BRIEF, /이미 있으면 건드리지 말고/);
});
