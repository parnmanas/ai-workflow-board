// Voice lab(엔진 고르기) 순수 로직 회귀 테스트(docs/voice-operator.md "선정 절차").
// 실행: node --import tsx --test apps/client/test/voice-lab.test.mjs
//
// 고정하는 것:
//   1. CER 은 공백·문장부호·대소문자를 세지 않고, 영어 용어를 한글로 옮겨 적은 것은 오류로 센다.
//   2. 블라인드 클립은 문장마다 다시 섞인다 — A 가 늘 같은 공급자면 블라인드가 아니다.
//   3. 요약은 평점 순이고, 실패한 클립은 평점·지연에 섞이지 않고 따로 센다.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  characterErrorRate,
  clipLabel,
  planBlindClips,
  summarizeBlindTest,
} from '../src/components/admin/voiceLab.logic.ts';

test('CER ignores spacing, punctuation and case', () => {
  assert.equal(characterErrorRate('PR 을 머지해 줘.', 'pr을 머지해줘'), 0);
  assert.equal(characterErrorRate('', 'anything'), null);
  assert.equal(characterErrorRate('abcd', ''), 1);
});

test('transliterating an English term counts as an error', () => {
  const cer = characterErrorRate('agent-manager 재시작', '에이전트 매니저 재시작');
  assert.ok(cer > 0.5, `expected a large error, got ${cer}`);
  assert.equal(characterErrorRate('롤프 재시작', '랄프 재시작'), 1 / 5, 'rolf vs ralf is exactly one character');
});

test('blind clips are reshuffled per sentence and labelled A, B, C…', () => {
  const candidates = [
    { key: 'eleven', provider: 'elevenlabs', voice: 'v1', model: '' },
    { key: 'azure', provider: 'azure', voice: 'ko-KR-SunHiNeural', model: '' },
    { key: 'typecast', provider: 'typecast', voice: 'tc', model: '' },
  ];
  // 고정 난수열: 첫 문장과 둘째 문장의 순서가 달라지게.
  const seq = [0.9, 0.1, 0.1, 0.9];
  let i = 0;
  const clips = planBlindClips(2, candidates, () => seq[i++ % seq.length]);
  assert.equal(clips.length, 6);
  const order = (s) => clips.filter((c) => c.sentenceIndex === s).map((c) => c.candidateKey);
  assert.deepEqual(clips.filter((c) => c.sentenceIndex === 0).map((c) => c.label), ['A', 'B', 'C']);
  assert.notDeepEqual(order(0), order(1));
  for (let s = 0; s < 2; s++) assert.deepEqual([...order(s)].sort(), ['azure', 'eleven', 'typecast']);
  assert.equal(clipLabel(26), 'A1');
});

test('summary ranks by average rating and keeps failures apart', () => {
  const candidates = [
    { key: 'a', provider: 'p', voice: '', model: '' },
    { key: 'b', provider: 'q', voice: '', model: '' },
  ];
  const clips = [
    { sentenceIndex: 0, label: 'A', candidateKey: 'a', url: 'u', latencyMs: 400, error: null, rating: 3 },
    { sentenceIndex: 0, label: 'B', candidateKey: 'b', url: 'u', latencyMs: 900, error: null, rating: 5 },
    { sentenceIndex: 1, label: 'A', candidateKey: 'b', url: null, latencyMs: null, error: 'quota', rating: null },
    { sentenceIndex: 1, label: 'B', candidateKey: 'a', url: 'u', latencyMs: 600, error: null, rating: 4 },
  ];
  const summary = summarizeBlindTest(clips, candidates);
  assert.deepEqual(summary.map((s) => s.candidateKey), ['b', 'a']);
  assert.deepEqual(summary[0], { candidateKey: 'b', rated: 1, averageRating: 5, averageLatencyMs: 900, failures: 1 });
  assert.deepEqual(summary[1], { candidateKey: 'a', rated: 2, averageRating: 3.5, averageLatencyMs: 500, failures: 0 });
});
