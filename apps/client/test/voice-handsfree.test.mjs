// 대화 모드의 순수 부분 회귀 테스트 — docs/voice-operator.md "대화 모드".
// 실행: node --import tsx --test apps/client/test/voice-handsfree.test.mjs
//
// 고정하는 것:
//   1. 발화 구간은 16 kHz mono 16-bit PCM WAV 로 나간다(셀프호스팅 게이트웨이·클라우드 공급자 모두 받는 형식).
//   2. 진폭은 [-1, 1] 밖이면 잘리고(클리핑), 음수·양수 끝이 PCM 범위에 정확히 맞는다.
//   3. VAD 프레임을 이어 붙인 구간이 실시간 자막에 그대로 쓰인다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { concatFrames, encodeWav, ensureAudioRunning, startHandsFree, END_OF_SPEECH_SILENCE_MS } from '../src/voice/handsFree.ts';
import { transcriptionFeedback } from '../src/voice/transcriptionFeedback.ts';

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

test('a suspended audio context resumes on a gesture before listening and removes gesture handlers', async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => { globalThis.document = previousDocument; });
  let allowed = false;
  let calls = 0;
  const context = new EventTarget();
  context.state = 'suspended';
  context.resume = () => {
    calls++;
    if (!allowed) return new Promise(() => {}); // Chrome queues resume until user activation.
    context.state = 'running';
    context.dispatchEvent(new Event('statechange'));
    return Promise.resolve();
  };
  let waiting = 0;
  let listening = false;
  const ready = ensureAudioRunning(context, undefined, () => waiting++).then(() => { listening = true; });
  await Promise.resolve();
  assert.equal(calls, 1, 'attempt resume immediately, before asynchronous model setup');
  assert.equal(waiting, 1);
  assert.equal(listening, false, 'a suspended microphone must not be labelled listening');
  allowed = true;
  document.dispatchEvent(new Event('pointerdown'));
  await ready;
  assert.equal(listening, true);
  document.dispatchEvent(new Event('keydown'));
  assert.equal(calls, 2, 'successful start removes both gesture handlers');
});

test('turning input off cancels a blocked audio context and later gestures do not start it', async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => { globalThis.document = previousDocument; });
  const context = new EventTarget();
  context.state = 'suspended';
  let calls = 0;
  context.resume = () => { calls++; return new Promise(() => {}); };
  const cancel = new AbortController();
  const ready = ensureAudioRunning(context, cancel.signal);
  cancel.abort();
  await assert.rejects(ready, { name: 'AbortError' });
  document.dispatchEvent(new Event('pointerdown'));
  assert.equal(calls, 1);
});

test('hands-free owns its context, unlocks before cold VAD loading and stops a late permission stream on cancellation', async (t) => {
  const { MicVAD } = await import('@ricky0123/vad-web');
  const previous = { AudioContext: globalThis.AudioContext, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), document: globalThis.document, newVad: MicVAD.new };
  globalThis.document = new EventTarget();
  let context;
  globalThis.AudioContext = class extends EventTarget {
    state = 'suspended';
    constructor() { super(); context = this; }
    async resume() { this.state = 'running'; this.dispatchEvent(new Event('statechange')); }
    async close() { this.state = 'closed'; }
  };
  let permission;
  let stopped = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: () => new Promise((resolve) => { permission = resolve; }),
  } } });
  MicVAD.new = async (options) => {
    assert.equal(context.state, 'running', 'audio is unlocked before loading the model');
    assert.equal(options.audioContext, context);
    assert.equal(options.startOnLoad, false);
    return { start: async () => { await options.getStream(); }, destroy: async () => {} };
  };
  t.after(() => {
    globalThis.AudioContext = previous.AudioContext;
    globalThis.document = previous.document;
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
    else delete globalThis.navigator;
    MicVAD.new = previous.newVad;
  });
  const cancel = new AbortController();
  const starting = startHandsFree({ onUtterance() {} }, { signal: cancel.signal });
  for (let i = 0; i < 20 && !permission; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(permission);
  cancel.abort();
  permission({ getTracks: () => [{ stop: () => stopped++ }] });
  await assert.rejects(starting, { name: 'AbortError' });
  assert.ok(stopped > 0, 'a granted stream cannot leave the microphone on after cancellation');
  assert.equal(context.state, 'closed');
});

test('filtered utterances explain why a working microphone did not send a prompt', () => {
  assert.match(transcriptionFeedback({ ignored: 'speaker_mismatch' }), /VOICE.*샘플/);
  assert.match(transcriptionFeedback({ ignored: 'insufficient_speech' }), /너무 짧/);
  assert.match(transcriptionFeedback({ ignored: 'no_speech' }), /인식하지 못/);
});
