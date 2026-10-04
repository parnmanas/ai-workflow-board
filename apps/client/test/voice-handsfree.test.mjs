// 대화 모드의 순수 부분 회귀 테스트 — docs/voice-operator.md "대화 모드".
// 실행: node --import tsx --test apps/client/test/voice-handsfree.test.mjs
//
// 고정하는 것:
//   1. 발화 구간은 16 kHz mono 16-bit PCM WAV 로 나간다(셀프호스팅 게이트웨이·클라우드 공급자 모두 받는 형식).
//   2. 진폭은 [-1, 1] 밖이면 잘리고(클리핑), 음수·양수 끝이 PCM 범위에 정확히 맞는다.
//   3. VAD 프레임을 이어 붙인 구간이 실시간 자막에 그대로 쓰인다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { concatFrames, encodeWav, END_OF_SPEECH_SILENCE_MS } from '../src/voice/handsFree.ts';

test('encodeWav writes a 16 kHz mono 16-bit PCM WAV', async () => {
  const blob = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]));
  assert.equal(blob.type, 'audio/wav');
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.equal(buf.length, 44 + 6 * 2);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(4), 36 + 12);
  assert.equal(buf.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(buf.readUInt16LE(20), 1, 'PCM');
  assert.equal(buf.readUInt16LE(22), 1, 'mono');
  assert.equal(buf.readUInt32LE(24), 16000);
  assert.equal(buf.readUInt32LE(28), 32000, 'byte rate');
  assert.equal(buf.readUInt16LE(34), 16, 'bits');
  assert.equal(buf.toString('ascii', 36, 40), 'data');
  assert.equal(buf.readUInt32LE(40), 12);
  const samples = [0, 1, 2, 3, 4, 5].map((i) => buf.readInt16LE(44 + i * 2));
  assert.deepEqual(samples, [0, 32767, -32768, 32767, -32768, 16383]);
});

test('concatFrames joins VAD frames in order', () => {
  const out = concatFrames([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]);
  assert.deepEqual([...out], [1, 2, 3]);
});

test('end of speech waits about a second of silence — long enough for a breath, short enough to feel live', () => {
  assert.ok(END_OF_SPEECH_SILENCE_MS >= 800 && END_OF_SPEECH_SILENCE_MS <= 1500);
});
