// 서버 측 이름 부르기 판정 — apps/server/src/modules/voice/wake-match.ts.
//
// 고정하는 것 (화면 `apps/client/test/voice-wake.test.mjs` 와 같은 케이스를 양쪽에서 단언 —
// 웹 탭 상시청취·서버 매치·네이티브 백그라운드가 같은 말을 같은 operator 로 알아들어야 한다):
//   1. 발화 맨 앞의 "앞머리 + 이름" · "이름 + 부름 조사" 만 부름이다. 이름만·이름으로 시작하는
//      이야기는 부름이 아니다.
//   2. 작은 철자 틀림은 봐주되 짧은 이름은 엄격하다. 여럿이면 가장 가깝게 맞은 쪽이 이긴다.
//   3. 응답은 세션으로 가는 데 필요한 것만(operator id·이름·세션 주소 + heard·rest) 내보낸다.
//
// 실행: node --test test/voice-wake-match.test.mjs (dist 필요)

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchWakeOperator,
  toWakeMatchResponse,
} from '../dist/modules/voice/wake-match.js';

const jarvis = { id: 'j', name: 'Jarvis', aliases: ['자비스'] };
const friday = { id: 'f', name: '프라이데이', aliases: ['Friday'] };
const luna = { id: 'l', name: '루나', aliases: [] };
const ops = [jarvis, friday, luna];

const woke = (text, list = ops) => {
  const m = matchWakeOperator(text, list);
  return m ? { id: m.operator.id, rest: m.rest } : null;
};

test('prefix + name wakes the operator; what follows is the first request', () => {
  assert.deepEqual(woke('헤이 자비스, 오늘 배포 상태 알려줘.'), { id: 'j', rest: '오늘 배포 상태 알려줘.' });
  assert.deepEqual(woke('Hey Jarvis.'), { id: 'j', rest: '' });
  assert.deepEqual(woke('오케이 프라이데이 ralf 상태'), { id: 'f', rest: 'ralf 상태' });
  assert.deepEqual(woke('야 루나 뭐해'), { id: 'l', rest: '뭐해' });
});

test('a name called with a vocative particle wakes too', () => {
  assert.deepEqual(woke('자비스야, 티켓 몇 개 남았어?'), { id: 'j', rest: '티켓 몇 개 남았어?' });
  assert.deepEqual(woke('루나야'), { id: 'l', rest: '' });
  assert.equal(matchWakeOperator('헤이 자비스', ops).form, 'prefix');
  assert.equal(matchWakeOperator('자비스야 이것 좀', ops).form, 'vocative');
});

test('a lone name or a story about the operator is not a call', () => {
  assert.equal(woke('자비스?'), null);
  assert.equal(woke('Friday'), null);
  assert.equal(woke('자비스 진짜 좋다'), null);
  assert.equal(woke('헤이 자비스트 어때'), null);
});

test('the response carries only what the native client needs to route', () => {
  const full = {
    ...jarvis,
    manager_id: 'host-1', cli: 'claude', session_id: 's1',
    cwd: '/x', title: 't', account_id: 'a', extra: 'must not leak',
  };
  const res = toWakeMatchResponse(matchWakeOperator('헤이 자비스 시작해', [full]));
  assert.deepEqual(res.operator, { id: 'j', name: 'Jarvis', manager_id: 'host-1', cli: 'claude', session_id: 's1' });
  assert.equal(res.rest, '시작해');
  assert.deepEqual(toWakeMatchResponse(null), { operator: null, heard: '', rest: '', distance: -1, form: null });
});
