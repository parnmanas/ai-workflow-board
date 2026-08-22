// 단위 테스트 — buildChatFallbackMessage (ticket 7d8ea7c9 후속, 수정범위 5:
// "context 오류의 사용자 가시화 및 silent failure 금지"). 응답 없이 종료된
// 세션은 이전엔 이유 설명 없이 raw CLI 출력만 덤프했다. 캡처된 tail 이 알려진
// context-window/출력 토큰 초과 신호와 일치하면, 이제 메시지가 가능성 있는
// 원인을 짚고 해결 방법을 알려준다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChatFallbackMessage } from '../dist/lib/chat-session-manager.js';

test('빈 body → exit code 와 무관하게 출력 없음 메시지', () => {
  assert.equal(buildChatFallbackMessage('', 1), '⚠️ Agent가 응답하지 못했습니다 (출력 없음).');
  assert.equal(buildChatFallbackMessage('', null), '⚠️ Agent가 응답하지 못했습니다 (출력 없음).');
});

test('평범한 CLI 크래시 tail → raw 출력만, context-window 힌트 없음', () => {
  const message = buildChatFallbackMessage('Error: ECONNRESET', 1);
  assert.match(message, /CLI 출력:/);
  assert.match(message, /ECONNRESET/);
  assert.doesNotMatch(message, /컨텍스트 윈도우/);
});

test('context-window 초과 tail → context_window/max_output_tokens/safety_margin_tokens 를 짚는 힌트', () => {
  const body = 'The model has reached its context window limit.';
  const message = buildChatFallbackMessage(body, 1);
  assert.match(message, /CLI 출력:/);
  assert.match(message, new RegExp(body));
  assert.match(message, /컨텍스트 윈도우/);
  assert.match(message, /context_window\/max_output_tokens\/safety_margin_tokens/);
});

test('CLAUDE_CODE_MAX_OUTPUT_TOKENS 초과 tail → 동일한 힌트', () => {
  const body = "Claude's response exceeded the output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";
  const message = buildChatFallbackMessage(body, 1);
  assert.match(message, /컨텍스트 윈도우/);
});

test('exit code 0(에러 컨텍스트 없음)에서 "context window" 를 언급해도 → 힌트 없음 (classifyCliError 와 동일한 오탐 방지 규칙)', () => {
  // classifyCliError 는 실제 에러 컨텍스트(비정상 종료 코드 / codex-error
  // wrapper)가 있을 때만 이 신호를 인식한다 — 실제로는 초과가 없는데 그
  // 문구를 우연히 인용한 tail 에 대한 오탐을 막는다.
  const message = buildChatFallbackMessage('mentions context window limit in passing', 0);
  assert.doesNotMatch(message, /컨텍스트 윈도우/);
});
