// 세션 턴에서 "읽어 줄 답" 을 고르는 순수 로직 회귀 테스트(docs/voice-operator.md "출력").
// 실행: node --import tsx --test apps/client/test/voice-turn-answer.test.mjs
//
// 고정하는 것:
//   1. 귀로 들을 것은 턴의 마지막 텍스트 덩어리다 — 도구·권한·질문·plan 이 덩어리를 끊는다.
//   2. 답 뒤에 정리용 도구로 끝난 턴은 비어 있지 않은 마지막 덩어리를 읽는다.
//   3. tool_update 는 덩어리를 끊지 않는다(늦게 온 갱신 때문에 답을 잃지 않게).
//   4. 사용자가 멈춘(cancelled) 턴은 읽지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TurnAnswerTracker,
  shouldSpeakFinishedTurn,
  turnAnswerText,
} from '../src/voice/turnAnswer.logic.ts';
// 서버 사본(음성 알림이 답의 첫머리를 싣는 데 쓴다) — 두 앱이 코드를 나눠 쓰지 않아 사본이 둘이다.
import { TurnAnswerTracker as ServerTurnAnswerTracker } from '../../server/src/modules/voice/turn-answer.ts';

let seq = 0;
function ev(type, payload = {}, turn_id = 't1') {
  seq += 1;
  return { id: `e${seq}`, seq, turn_id, type, payload, created_at: '2026-10-04T00:00:00.000Z' };
}

test('the last text segment after the last tool call is the answer', () => {
  const events = [
    ev('user_prompt', { text: '미션 상태 알려줘' }),
    ev('text', { text: '확인해 볼게요.' }),
    ev('tool_call', { tool_call_id: 'a', title: 'list_orchestration_missions' }),
    ev('tool_update', { tool_call_id: 'a', status: 'completed' }),
    ev('text', { text: '진행 중인 미션은 ' }),
    ev('text', { text: '두 개예요.' }),
  ];
  assert.equal(turnAnswerText(events, 't1'), '진행 중인 미션은 두 개예요.');
});

test('a turn that ends with a cleanup tool still reads the last non-empty segment', () => {
  const events = [
    ev('text', { text: '배포를 마쳤어요.' }),
    ev('tool_call', { tool_call_id: 'todo', title: 'TodoWrite' }),
    ev('plan', { entries: [] }),
  ];
  assert.equal(turnAnswerText(events, 't1'), '배포를 마쳤어요.');
});

test('a late tool_update does not cut the answer', () => {
  const tracker = new TurnAnswerTracker();
  tracker.push(ev('tool_call', { tool_call_id: 'bg' }, 't2'));
  tracker.push(ev('text', { text: '빌드는 백그라운드에서 돌아요.' }, 't2'));
  tracker.push(ev('tool_update', { tool_call_id: 'bg', status: 'in_progress' }, 't2'));
  const finished = tracker.push(ev('turn', { phase: 'finished', stop_reason: 'end_turn' }, 't2'));
  assert.deepEqual(finished, { turnId: 't2', stopReason: 'end_turn', answer: '빌드는 백그라운드에서 돌아요.' });
});

test('the tracker keeps turns apart and forgets a turn once it finishes', () => {
  const tracker = new TurnAnswerTracker();
  tracker.push(ev('text', { text: 'A 의 답' }, 'ta'));
  tracker.push(ev('text', { text: 'B 의 답' }, 'tb'));
  assert.equal(tracker.push(ev('turn', { phase: 'started' }, 'ta')), null);
  assert.equal(tracker.push(ev('turn', { phase: 'finished' }, 'ta'))?.answer, 'A 의 답');
  assert.equal(tracker.push(ev('turn', { phase: 'finished' }, 'ta'))?.answer, '', 'finished turns are forgotten');
  assert.equal(tracker.push(ev('turn', { phase: 'finished' }, 'tb'))?.answer, 'B 의 답');
});

test('cancelled or empty turns are not spoken', () => {
  assert.equal(shouldSpeakFinishedTurn({ turnId: 't', stopReason: 'cancelled', answer: '중간까지 쓴 답' }), false);
  assert.equal(shouldSpeakFinishedTurn({ turnId: 't', stopReason: 'end_turn', answer: '' }), false);
  assert.equal(shouldSpeakFinishedTurn({ turnId: 't', stopReason: 'end_turn', answer: '끝났어요.' }), true);
  assert.equal(shouldSpeakFinishedTurn({ turnId: 't', stopReason: 'max_tokens', answer: '잘린 답' }), true);
});

test('the server copy of the rule gives the same answers as the client (they must not drift)', () => {
  const fixtures = [
    [ev('text', { text: '확인해 볼게요.' }, 'x1'), ev('tool_call', {}, 'x1'), ev('text', { text: '두 개예요.' }, 'x1'), ev('turn', { phase: 'finished' }, 'x1')],
    [ev('text', { text: '배포를 마쳤어요.' }, 'x2'), ev('tool_call', {}, 'x2'), ev('plan', {}, 'x2'), ev('turn', { phase: 'finished', stop_reason: 'end_turn' }, 'x2')],
    [ev('tool_call', {}, 'x3'), ev('text', { text: '백그라운드.' }, 'x3'), ev('tool_update', {}, 'x3'), ev('turn', { phase: 'finished', stop_reason: 'cancelled' }, 'x3')],
    [ev('permission_request', {}, 'x4'), ev('turn', { phase: 'finished', stop_reason: 'error' }, 'x4')],
  ];
  for (const events of fixtures) {
    const client = new TurnAnswerTracker();
    const server = new ServerTurnAnswerTracker();
    const a = events.map((e) => client.push(e)).filter(Boolean);
    const b = events.map((e) => server.push(e)).filter(Boolean);
    assert.deepEqual(b, a);
  }
});
