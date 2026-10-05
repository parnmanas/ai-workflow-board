// 이름 부르기(웨이크워드)·잠들기 규칙 회귀 테스트 — docs/voice-operator.md "이름 부르기 · 잠들기".
// 실행: node --import tsx --test apps/client/test/voice-wake.test.mjs
//
// 고정하는 것:
//   1. 부르는 말은 발화 맨 앞의 "앞머리 + 이름" · "이름 + 부름 조사" 이고, 뒤에 이어 한 말이 첫 요청이 된다.
//      문장 첫머리에 이름이 나온 이야기("자비스 진짜 좋다")와 이름만 한 발화(엔진이 용어집을 읊은 메아리일
//      수 있다)는 부름이 아니다.
//   2. 음성 인식의 작은 철자 틀림(자모 하나)은 같은 이름으로 보되, 짧은 이름은 엄격하다.
//   3. 이름은 낱말 경계에서 끝나야 하고("자비스트" 아님), 별칭으로도 부를 수 있으며, 여럿이면 가장
//      가깝게 맞은 operator 를 고른다.
//   4. 잠들기 표시는 operator 가 답 끝에 붙이고, 화면은 그걸 떼어 읽고 잠든다.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WAKE_PROMPT_NOTE,
  compactKey,
  editDistance,
  heardName,
  isFillerUtterance,
  matchWake,
  splitSleepMarker,
  stripWakeNote,
  toJamo,
  wakeTolerance,
  withVocative,
  withWakeNote,
} from '../src/voice/wake.logic.ts';

const jarvis = { id: 'j', name: 'Jarvis', aliases: ['자비스'] };
const friday = { id: 'f', name: '프라이데이', aliases: ['Friday'] };
const luna = { id: 'l', name: '루나', aliases: [] };
const ops = [jarvis, friday, luna];

const woke = (text, list = ops) => {
  const m = matchWake(text, list);
  return m ? { id: m.operator.id, rest: m.rest } : null;
};

test('prefix + name wakes the operator; what follows is the first request', () => {
  assert.deepEqual(woke('헤이 자비스, 오늘 배포 상태 알려줘.'), { id: 'j', rest: '오늘 배포 상태 알려줘.' });
  assert.deepEqual(woke('Hey Jarvis.'), { id: 'j', rest: '' });
  assert.deepEqual(woke('hey, JARVIS what is up'), { id: 'j', rest: 'what is up' });
  assert.deepEqual(woke('헤이자비스 PR 25 머지됐어?'), { id: 'j', rest: 'PR 25 머지됐어?' }, 'no space after the prefix');
  assert.deepEqual(woke('오케이 프라이데이 ralf 상태'), { id: 'f', rest: 'ralf 상태' });
  assert.deepEqual(woke('Hi Friday!'), { id: 'f', rest: '' });
  assert.deepEqual(woke('야 루나 뭐해'), { id: 'l', rest: '뭐해' });
});

test('a name called with a vocative particle wakes too', () => {
  assert.deepEqual(woke('자비스야, 티켓 몇 개 남았어?'), { id: 'j', rest: '티켓 몇 개 남았어?' });
  assert.deepEqual(woke('루나야'), { id: 'l', rest: '' });
  assert.deepEqual(woke('헤이 자비스야 이것 좀'), { id: 'j', rest: '이것 좀' });
  assert.equal(matchWake('헤이 자비스', ops).form, 'prefix');
  assert.equal(matchWake('자비스야 이것 좀', ops).form, 'vocative');
});

test('a lone name is not a call — the engine recites its vocabulary on short noise', () => {
  assert.equal(woke('자비스?'), null);
  assert.equal(woke('자비스, Jarvis.'), null, 'measured echo of the context on the first 1.5s of "헤이 자비스"');
  assert.equal(woke('Friday'), null);
});

test('talking about an operator is not calling it', () => {
  assert.equal(woke('자비스 진짜 좋다'), null, 'a name opening a sentence is a topic, not a call');
  assert.equal(woke('어제 자비스한테 물어봤는데'), null, 'the call must open the utterance');
  assert.equal(woke('헤이 자비스트 어때'), null, 'the name must end at a word boundary');
  assert.equal(woke('헤이 자비스 아까 그거', [jarvis])?.rest, '아까 그거', '"아" that starts the next word is not a vocative');
  assert.equal(woke('에이 그건 아니지'), null, 'a prefix-looking interjection without a name');
  assert.equal(woke(''), null);
  assert.equal(woke('헤이'), null);
});

test('small recognition slips still match; short names must be exact', () => {
  assert.deepEqual(woke('헤이 재비스 오늘 일정'), { id: 'j', rest: '오늘 일정' }, 'one vowel off');
  assert.deepEqual(woke('Hey Javis'), { id: 'j', rest: '' }, 'one letter dropped');
  assert.deepEqual(woke('헤이 프라이대이'), { id: 'f', rest: '' });
  assert.deepEqual(woke('헤이, 잡이스.'), { id: 'j', rest: '' }, 'measured: ragnar ASR wrote 자비스 as 잡이스 — same sound (liaison)');
  assert.equal(toJamo('잡이스'), toJamo('자비스'));
  assert.equal(toJamo('재'), toJamo('제'), 'ㅐ and ㅔ sound the same');
  assert.equal(woke('헤이 쟈베스'), null, 'two slips in a six-jamo name is another word');
  assert.equal(wakeTolerance(toJamo('루나').length), 1);
  assert.equal(wakeTolerance(toJamo('max').length), 0);
  assert.equal(woke('hey mux', [{ id: 'm', name: 'Max', aliases: [] }]), null, 'three letters: exact only');
});

test('the closest operator wins when several are near', () => {
  const pair = [{ id: 'a', name: '루나', aliases: [] }, { id: 'b', name: '루다', aliases: [] }];
  assert.equal(matchWake('헤이 루다', pair).operator.id, 'b');
  assert.equal(matchWake('헤이 루나', pair).operator.id, 'a');
  assert.equal(matchWake('헤이 자비스', ops).heard, '자비스', 'heard is the name as written in the transcript');
});

test('compactKey ignores case, spaces and punctuation like the server does', () => {
  assert.equal(compactKey(' JAR-VIS! '), 'jarvis');
  assert.equal(compactKey('자 비 스'), '자비스');
  assert.equal(editDistance(toJamo('자비스'), toJamo('재비스')), 1);
});

test('the vocative follows the last syllable: 자비스야, 민준아', () => {
  assert.equal(withVocative('자비스'), '자비스야');
  assert.equal(withVocative('민준'), '민준아');
  assert.equal(withVocative('Jarvis'), 'Jarvis야');
  assert.deepEqual(woke('민준아 오늘 뭐 해', [{ id: 'm', name: '민준', aliases: [] }]), { id: 'm', rest: '오늘 뭐 해' });
});

test('heardName shows how the engine spelled the name, for registering an alias', () => {
  assert.equal(heardName('헤이 자비스.'), '자비스');
  assert.equal(heardName('Hey, Jarvis!'), 'Jarvis');
  assert.equal(heardName('자비스'), '자비스');
});

test('the sleep marker is taken off the answer and tells the screen to sleep', () => {
  assert.deepEqual(splitSleepMarker('알겠습니다. 필요하면 다시 불러 주세요. [[sleep]]'), { text: '알겠습니다. 필요하면 다시 불러 주세요.', sleep: true });
  assert.deepEqual(splitSleepMarker('좋아요 [[ SLEEP ]]'), { text: '좋아요', sleep: true });
  assert.deepEqual(splitSleepMarker('배포를 시작할게요.'), { text: '배포를 시작할게요.', sleep: false });
  assert.equal(splitSleepMarker('a [[sleep]]').sleep, true, 'the regex keeps no state between calls');
  assert.equal(splitSleepMarker('b [[sleep]]').sleep, true);
});

test('the wake note rides the first request and is hidden on screen', () => {
  const sent = withWakeNote('오늘 배포 상태 알려줘');
  assert.ok(sent.startsWith(WAKE_PROMPT_NOTE));
  assert.match(WAKE_PROMPT_NOTE, /\[\[sleep\]\]/);
  assert.deepEqual(stripWakeNote(sent), { text: '오늘 배포 상태 알려줘', noted: true });
  assert.deepEqual(stripWakeNote('그냥 질문'), { text: '그냥 질문', noted: false });
});

test('fillers are not requests; a confirming "네" is', () => {
  assert.equal(isFillerUtterance('음...'), true);
  assert.equal(isFillerUtterance('어'), true);
  assert.equal(isFillerUtterance('  '), true);
  assert.equal(isFillerUtterance('네'), false);
  assert.equal(isFillerUtterance('아니'), false);
});

// ─── 탭의 깨어 있음 상태(wakeState) ─────────────────────────────────────────
import { wakeStore } from '../src/voice/wakeState.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('waking hands the first request over once; leaving the operator page puts it to sleep', async () => {
  wakeStore.setEnabled(true);
  assert.equal(wakeStore.state.mode, 'sleeping');
  wakeStore.wake('j', '오늘 배포 상태 알려줘');
  const detach = wakeStore.attach('j');
  assert.deepEqual([wakeStore.state.mode, wakeStore.state.operatorId], ['awake', 'j']);
  assert.equal(wakeStore.takeFirstPrompt('f'), null, 'another operator does not get it');
  assert.equal(wakeStore.takeFirstPrompt('j'), '오늘 배포 상태 알려줘');
  assert.equal(wakeStore.takeFirstPrompt('j'), null, 'only once');

  // React 개발 모드처럼 떼었다 곧바로 다시 붙이면 깨어 있는 채다.
  detach();
  const again = wakeStore.attach('j');
  await tick();
  assert.equal(wakeStore.state.mode, 'awake');
  again();
  await tick();
  assert.deepEqual([wakeStore.state.mode, wakeStore.state.operatorId], ['sleeping', null], 'the last view closed — asleep');
});

test('a late sleep signal from the previous operator does not put the new one to sleep', async () => {
  wakeStore.setEnabled(true);
  wakeStore.wake('j', null);
  const detachJ = wakeStore.attach('j');
  wakeStore.wake('f', '랄프 상태'); // 대화 중에 다른 operator 를 불렀다
  const detachF = wakeStore.attach('f');
  detachJ();
  await tick();
  wakeStore.sleep('j');
  assert.deepEqual([wakeStore.state.mode, wakeStore.state.operatorId], ['awake', 'f']);
  wakeStore.sleep('f');
  assert.equal(wakeStore.state.mode, 'sleeping');
  detachF();
  await tick();
});

test('switching name calling off ends the conversation; the mic is shared by count', () => {
  wakeStore.setEnabled(true);
  wakeStore.wake('j', 'x');
  wakeStore.setEnabled(false);
  assert.deepEqual([wakeStore.state.mode, wakeStore.state.operatorId], ['off', null]);
  assert.equal(wakeStore.takeFirstPrompt('j'), null, 'a pending first request is dropped too');
  const a = wakeStore.claimMic();
  const b = wakeStore.claimMic();
  assert.equal(wakeStore.state.micClaims, 2);
  a();
  a();
  assert.equal(wakeStore.state.micClaims, 1, 'releasing twice counts once');
  b();
  assert.equal(wakeStore.state.micClaims, 0);
});

test('a wake whose operator page never opens falls back asleep', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wakeStore.setEnabled(true);
  wakeStore.wake('j', null);
  t.mock.timers.tick(9_000);
  assert.equal(wakeStore.state.mode, 'awake');
  t.mock.timers.tick(1_500);
  assert.equal(wakeStore.state.mode, 'sleeping');
});

// ─── 전사에서 보이는 모습 ───────────────────────────────────────────────────
import { buildTranscript } from '../src/components/sessions/sessionTranscript.logic.ts';
import { OPERATOR_REPORT_PREFIX, isOperatorReportPrompt } from '../src/voice/wake.logic.ts';

test('the transcript folds AWB work reports, hides the wake note and the sleep marker', () => {
  const ev = (id, type, payload, turn_id) => ({ id, seq: 0, turn_id, type, payload, created_at: '2026-10-04T00:00:00.000Z' });
  const blocks = buildTranscript([
    ev('a', 'user_prompt', { text: withWakeNote('오늘 배포 상태 알려줘') }, 't1'),
    ev('b', 'text', { text: '모두 정상이에요. [[sleep]]' }, 't1'),
    ev('c', 'user_prompt', { text: `${OPERATOR_REPORT_PREFIX} 다른 세션 소식 1건입니다.\n\n1. 완료 — rolf / Codex` }, 't2'),
    ev('d', 'text', { text: '롤프 세션이 끝났어요.' }, 't2'),
  ]);
  const prompts = blocks.filter((b) => b.kind === 'prompt');
  assert.deepEqual(prompts.map((b) => [b.text.split('\n')[0], !!b.voice, !!b.report]), [
    ['오늘 배포 상태 알려줘', true, false],
    [`${OPERATOR_REPORT_PREFIX} 다른 세션 소식 1건입니다.`, false, true],
  ]);
  assert.equal(blocks.find((b) => b.kind === 'assistant').text, '모두 정상이에요.');
  assert.equal(isOperatorReportPrompt('그냥 질문'), false);
});

test('after a decision is read out, a short window takes the answer without the name', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  wakeStore.setEnabled(true);
  wakeStore.sleep();
  assert.equal(wakeStore.openFollowUp('j', 8_000), true);
  assert.equal(wakeStore.activeFollowUp(), 'j');
  t.mock.timers.tick(7_000);
  assert.equal(wakeStore.activeFollowUp(), 'j');
  t.mock.timers.tick(1_500);
  assert.equal(wakeStore.activeFollowUp(), null, 'the window closes by itself');
  assert.equal(wakeStore.state.followUp, null);

  wakeStore.openFollowUp('j');
  wakeStore.wake('j', '1번');
  assert.equal(wakeStore.state.followUp, null, 'answering (waking) closes it');
  assert.equal(wakeStore.openFollowUp('f'), false, 'not while someone is already awake — they listen anyway');
  wakeStore.sleep('j');
  wakeStore.setEnabled(false);
  assert.equal(wakeStore.openFollowUp('j'), false, 'name calling off: the mic is not ours to open');
});

test('a notification temporarily listens with name calling off and closes on silence', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  wakeStore.setEnabled(false);
  assert.equal(wakeStore.openNotificationFollowUp('j'), true);
  assert.equal(wakeStore.state.enabled, false);
  assert.equal(wakeStore.state.mode, 'sleeping');
  assert.equal(wakeStore.activeFollowUp(), 'j');
  t.mock.timers.tick(15_001);
  assert.equal(wakeStore.state.followUp, null);
  assert.equal(wakeStore.state.mode, 'off', 'persistent microphone remains off');
});

test('a started report request survives timeout and STT without switching operator', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  wakeStore.setEnabled(false);
  wakeStore.openNotificationFollowUp('j');
  t.mock.timers.tick(14_000);
  const utterance = wakeStore.holdFollowUp();
  assert.equal(utterance.operatorId, 'j');
  t.mock.timers.tick(2_000);
  assert.equal(wakeStore.activeFollowUp(), null, 'no new utterance starts after the deadline');
  assert.equal(wakeStore.state.mode, 'sleeping', 'finish recognition of the already started request');
  assert.equal(wakeStore.openNotificationFollowUp('f'), false, 'another cue cannot steal a spoken report request');
  wakeStore.wake(utterance.operatorId, '보고해');
  assert.equal(wakeStore.takeFirstPrompt('f'), null);
  assert.equal(wakeStore.takeFirstPrompt('j'), '보고해');
  utterance.release();
  assert.equal(wakeStore.state.mode, 'awake');
  assert.equal(wakeStore.openNotificationFollowUp('f'), false, 'do not interrupt an ongoing conversation');
  wakeStore.sleep('j');
  assert.equal(wakeStore.state.mode, 'off');
});

test('temporary input expires after an ignored utterance; manual off cancels pending recognition', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  wakeStore.setEnabled(false);
  wakeStore.openNotificationFollowUp('j');
  const utterance = wakeStore.holdFollowUp();
  t.mock.timers.tick(15_001);
  utterance.release(); utterance.release();
  assert.equal(wakeStore.state.mode, 'off');
  wakeStore.openNotificationFollowUp('j');
  const pending = wakeStore.holdFollowUp();
  wakeStore.setEnabled(false);
  assert.equal(wakeStore.state.followUp, null);
  assert.equal(wakeStore.state.mode, 'off');
  assert.equal(pending.isValid(), false, 'a cancelled transcription cannot route an unnamed request');
  pending.release();
  wakeStore.openNotificationFollowUp('f');
  assert.equal(wakeStore.activeFollowUp(), 'f', 'the old lease cannot close a later notification');
  wakeStore.closeNotificationFollowUp();
});
