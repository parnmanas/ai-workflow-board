// 음성 게이트웨이(VoiceService + 공급자) 회귀 테스트 — 실제 네트워크 없이 요청 모양을 고정한다.
//
// 고정하는 것 (docs/voice-operator.md):
//   1. 설정이 비었거나 틀리면 **조용히 다른 공급자로 넘어가지 않는다** — 상태에 사유를 싣고 409 로 거절한다.
//   2. 공급자마다 배열 필드 인코딩이 다르다: OpenAI `keywords[]`/`languages[]`, ElevenLabs 반복 `keyterms`.
//   3. 언어가 여럿이면 하나로 강제하지 않는다(섞어 쓴 영어 용어를 한글로 옮겨 적지 않게).
//   4. 셀프호스팅(OpenAI 호환) 서버에는 `language` + `prompt` 만 보내고, 키가 없어도 된다.
//   5. Soniox 는 실시간 WebSocket 하나로: 설정 → 오디오 → 빈 프레임, 확정 토큰만 모으고 제어 토큰은 버린다.
//   6. 공급자의 401/403 은 운영자가 고칠 설정 문제(409), 나머지 실패는 게이트웨이 실패(502).

import assert from 'node:assert/strict';
import test from 'node:test';
import { encrypt } from '../dist/services/encryption.service.js';
import { invalidateVoiceConfig } from '../dist/modules/voice/voice-config.js';
import { VoiceError, VoiceService } from '../dist/modules/voice/voice.service.js';
import { azureSsml } from '../dist/modules/voice/providers/azure.js';
import { elevenLabsKeyterms } from '../dist/modules/voice/providers/elevenlabs.js';

// 암호화 키를 저장소의 database/ 에 만들지 않게 — encrypt() 는 첫 호출 때 env 를 읽는다.
process.env.ENCRYPTION_KEY ??= 'voice-gateway-test-key';

function makeService(settings) {
  const rows = Object.entries(settings).map(([key, value]) => ({
    key,
    value: key.endsWith('.api_key') && value ? encrypt(value) : value,
  }));
  const dataSource = { getRepository: () => ({ find: async () => rows }) };
  const logs = [];
  const log = { warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]), info() {}, debug() {} };
  invalidateVoiceConfig();
  const service = new VoiceService(dataSource, log);
  return { service, logs };
}

function recordFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  return { calls, fetchImpl };
}

const audio = Buffer.from('fake-webm-bytes');

test('disabled, unknown and keyless providers are reported — never silently swapped', async () => {
  let { service } = makeService({});
  let status = await service.status(true);
  assert.deepEqual(status.stt, { provider: 'none', ready: false, error: null }, 'off is not an error');
  assert.deepEqual(status.lab, { stt: [], tts: [] }, 'no keys → nothing to compare');
  await assert.rejects(() => service.transcribe(audio, 'audio/webm'), (e) => e instanceof VoiceError && e.status === 409 && e.code === 'voice_stt_disabled');

  ({ service } = makeService({ 'voice.stt.provider': 'whisperx', 'voice.tts.provider': 'elevenlabs' }));
  status = await service.status(false);
  assert.equal(status.stt.ready, false);
  assert.match(status.stt.error, /Unknown speech-to-text provider "whisperx"/);
  assert.match(status.tts.error, /ElevenLabs API key is not set/);
  assert.equal(status.lab, undefined, 'lab list is admin-only');
});

test('soniox: one realtime socket — config, audio frames, empty end frame; only final non-control tokens', async () => {
  const sent = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      FakeWebSocket.last = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(data) {
      sent.push(data);
      if (data === '') {
        const msg = (obj) => this.onmessage?.({ data: JSON.stringify(obj) });
        msg({ tokens: [{ text: '티켓', is_final: true }, { text: ' 정리', is_final: false }] });
        msg({ tokens: [{ text: ' 정리해', is_final: true }, { text: '<fin>', is_final: true }] });
        msg({ tokens: [{ text: '줘', is_final: true }], finished: true });
      }
    }
    close() { this.closed = true; }
  }
  const { service } = makeService({
    'voice.stt.provider': 'soniox',
    'voice.soniox.api_key': 'snx_live',
    'voice.stt.languages': 'ko,en',
    'voice.stt.terms': 'AWB, rolf',
  });
  service.webSocketImpl = FakeWebSocket;
  const out = await service.transcribe(audio, 'audio/webm;codecs=opus');
  assert.equal(out.text, '티켓 정리해줘');
  assert.equal(out.provider, 'soniox');
  assert.equal(out.model, 'stt-rt-v5');
  assert.equal(FakeWebSocket.last.url, 'wss://stt-rt.soniox.com/transcribe-websocket');
  assert.equal(FakeWebSocket.last.closed, true);
  const config = JSON.parse(sent[0]);
  assert.deepEqual(config, {
    api_key: 'snx_live', model: 'stt-rt-v5', audio_format: 'auto', enable_endpoint_detection: false,
    language_hints: ['ko', 'en'], context: { terms: ['AWB', 'rolf'] },
  });
  assert.ok(sent[1] instanceof Uint8Array && Buffer.from(sent[1]).equals(audio));
  assert.equal(sent.at(-1), '');
});

test('soniox: an error message rejects with the provider status', async () => {
  class FailingWebSocket {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(data) { if (data === '') this.onmessage?.({ data: JSON.stringify({ tokens: [], error_code: 401, error_message: 'Invalid API key' }) }); }
    close() {}
  }
  const { service } = makeService({ 'voice.stt.provider': 'soniox', 'voice.soniox.api_key': 'bad' });
  service.webSocketImpl = FailingWebSocket;
  await assert.rejects(() => service.transcribe(audio, 'audio/webm'),
    (e) => e instanceof VoiceError && e.status === 409 && /soniox 401: Invalid API key/.test(e.message));
});

test('elevenlabs scribe: repeated keyterms, no forced language when several are configured', async () => {
  const { calls, fetchImpl } = recordFetch(() => new Response(JSON.stringify({ text: '배포 상태 알려줘' }), { status: 200 }));
  const { service } = makeService({
    'voice.stt.provider': 'elevenlabs',
    'voice.elevenlabs.api_key': 'xi_key',
    'voice.stt.languages': 'ko,en',
    'voice.stt.terms': 'agent-manager, rolf, a [bad] term',
  });
  service.fetchImpl = fetchImpl;
  const out = await service.transcribe(audio, 'audio/webm;codecs=opus');
  assert.equal(out.text, '배포 상태 알려줘');
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(init.headers['xi-api-key'], 'xi_key');
  const form = init.body;
  assert.equal(form.get('model_id'), 'scribe_v2');
  assert.equal(form.get('tag_audio_events'), 'false');
  assert.equal(form.get('language_code'), null, 'ko,en → let the model decide');
  assert.deepEqual(form.getAll('keyterms'), ['agent-manager', 'rolf'], 'forbidden characters are dropped');
  assert.equal(form.get('file').name, 'utterance.webm');
  assert.deepEqual(elevenLabsKeyterms(['one two three four five six', 'ok']), ['ok']);
});

test('openai: gpt-transcribe gets languages[]/keywords[]; a self-hosted server gets language + prompt and no key', async () => {
  let { calls, fetchImpl } = recordFetch(() => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
  let { service } = makeService({
    'voice.stt.provider': 'openai',
    'voice.openai.api_key': 'sk-test',
    'voice.stt.languages': 'ko,en',
    'voice.stt.terms': 'AWB, ragnar',
  });
  service.fetchImpl = fetchImpl;
  await service.transcribe(audio, 'audio/mp4');
  let form = calls[0].init.body;
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.equal(form.get('model'), 'gpt-transcribe');
  assert.deepEqual(form.getAll('languages[]'), ['ko', 'en']);
  assert.deepEqual(form.getAll('keywords[]'), ['AWB', 'ragnar']);
  assert.equal(form.get('language'), null, 'never both languages[] and language');
  assert.equal(form.get('file').name, 'utterance.m4a');

  ({ calls, fetchImpl } = recordFetch(() => new Response(JSON.stringify({ text: 'ok' }), { status: 200 })));
  ({ service } = makeService({
    'voice.stt.provider': 'openai',
    'voice.openai.base_url': 'http://192.168.0.6:8100/v1/',
    'voice.stt.model': 'Qwen/Qwen3-ASR-1.7B',
    'voice.stt.languages': 'ko,en',
    'voice.stt.terms': 'AWB, ragnar',
  }));
  service.fetchImpl = fetchImpl;
  assert.equal((await service.status(false)).stt.ready, true, 'self-hosted needs no key');
  await service.transcribe(audio, 'audio/webm');
  form = calls[0].init.body;
  assert.equal(calls[0].url, 'http://192.168.0.6:8100/v1/audio/transcriptions');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(form.get('language'), 'ko');
  assert.equal(form.get('prompt'), 'AWB, ragnar.');
  assert.deepEqual(form.getAll('keywords[]'), []);
});

test('local (self-hosted awb-voice-server): own URL and key, language + prompt, gateway-chosen default voice', async () => {
  const mp3 = Buffer.from('ID3local');
  const { calls, fetchImpl } = recordFetch((url) => {
    if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: '롤프 상태 알려줘' }), { status: 200 });
    if (url.endsWith('/audio/voices')) {
      return new Response(JSON.stringify({ voices: [{ id: 'sohee', name: 'Sohee', language: 'ko', gender: 'female', request: { secret: 1 } }], default: 'sohee' }), { status: 200 });
    }
    return new Response(mp3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  });
  const { service } = makeService({
    'voice.stt.provider': 'local',
    'voice.tts.provider': 'local',
    'voice.local.base_url': 'http://192.168.0.6:8410/v1/',
    'voice.local.api_key': 'ragnar-key',
    // OpenAI 클라우드 설정은 그대로 둔다 — 셀프호스팅과 동시에 설정해 둘 수 있어야 한다.
    'voice.openai.api_key': 'sk-cloud',
    'voice.stt.languages': 'ko,en',
    'voice.stt.terms': 'AWB, rolf',
  });
  service.fetchImpl = fetchImpl;
  const status = await service.status(true);
  assert.equal(status.stt.ready, true);
  assert.equal(status.tts.ready, true, 'the gateway owns the default voice — no voice setting needed');
  assert.ok(status.lab.stt.includes('local') && status.lab.stt.includes('openai'));

  const out = await service.transcribe(audio, 'audio/webm;codecs=opus');
  assert.equal(out.text, '롤프 상태 알려줘');
  assert.equal(calls[0].url, 'http://192.168.0.6:8410/v1/audio/transcriptions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ragnar-key');
  const form = calls[0].init.body;
  assert.equal(form.get('model'), null, 'blank model = the server default');
  assert.equal(form.get('language'), 'ko');
  assert.equal(form.get('prompt'), 'AWB, rolf.');
  assert.equal(form.get('file').name, 'utterance.webm', 'the gateway decodes whatever the browser recorded');

  const spoken = await service.synthesize('배포가 끝났어요.');
  assert.ok(spoken.audio.equals(mp3));
  assert.equal(calls.at(-1).url, 'http://192.168.0.6:8410/v1/audio/speech');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { input: '배포가 끝났어요.', voice: 'default', response_format: 'mp3', language: 'ko' });

  const voices = await service.listVoices('local');
  assert.deepEqual(voices, [{ id: 'sohee', name: 'Sohee', language: 'ko', gender: 'female' }], 'backend request details stay on the server');

  const { service: unset } = makeService({ 'voice.stt.provider': 'local' });
  assert.match((await unset.status(false)).stt.error, /Self-hosted voice server URL is not set/);
});

test('tts: provider requests carry the configured voice/model and return the audio bytes', async () => {
  const mp3 = Buffer.from('ID3fake');
  const { calls, fetchImpl } = recordFetch((url) => {
    if (url.startsWith('https://texttospeech.googleapis.com')) {
      return new Response(JSON.stringify({ audioContent: mp3.toString('base64') }), { status: 200 });
    }
    return new Response(mp3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  });

  let { service } = makeService({
    'voice.tts.provider': 'elevenlabs', 'voice.elevenlabs.api_key': 'xi', 'voice.tts.voice': 'voice123',
  });
  service.fetchImpl = fetchImpl;
  let out = await service.synthesize('배포가 끝났어요.');
  assert.ok(out.audio.equals(mp3));
  assert.equal(out.contentType, 'audio/mpeg');
  assert.equal(calls.at(-1).url, 'https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { text: '배포가 끝났어요.', model_id: 'eleven_v4_turbo' });

  ({ service } = makeService({
    'voice.tts.provider': 'azure', 'voice.azure.api_key': 'az', 'voice.azure.region': 'eastus',
    'voice.tts.voice': 'ko-KR-SunHi:DragonHDLatestNeural',
  }));
  service.fetchImpl = fetchImpl;
  await service.synthesize('R&D <팀>');
  assert.equal(calls.at(-1).url, 'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(calls.at(-1).init.body,
    "<speak version='1.0' xml:lang='ko-KR'><voice name='ko-KR-SunHi:DragonHDLatestNeural'>R&amp;D &lt;팀&gt;</voice></speak>");
  assert.equal(azureSsml('x', 'en-US-AvaMultilingualNeural').includes("xml:lang='en-US'"), true);

  ({ service } = makeService({
    'voice.tts.provider': 'google', 'voice.google.api_key': 'g', 'voice.tts.voice': 'ko-KR-Chirp3-HD-Kore',
  }));
  service.fetchImpl = fetchImpl;
  out = await service.synthesize('안녕하세요');
  assert.ok(out.audio.equals(mp3), 'base64 audioContent is decoded');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body).voice, { languageCode: 'ko-KR', name: 'ko-KR-Chirp3-HD-Kore' });

  ({ service } = makeService({
    'voice.tts.provider': 'typecast', 'voice.typecast.api_key': 'tc', 'voice.tts.voice': 'tc_abc', 'voice.stt.languages': 'ko',
  }));
  service.fetchImpl = fetchImpl;
  await service.synthesize('안녕하세요');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body),
    { voice_id: 'tc_abc', text: '안녕하세요', model: 'ssfm-v30', output: { audio_format: 'mp3' }, language: 'kor' });
});

test('tts: a provider without a voice asks for one instead of guessing — and is not reported ready', async () => {
  const { service } = makeService({ 'voice.tts.provider': 'elevenlabs', 'voice.elevenlabs.api_key': 'xi' });
  const status = await service.status(false);
  assert.equal(status.tts.ready, false);
  assert.match(status.tts.error, /Pick a voice for elevenlabs/);
  await assert.rejects(() => service.synthesize('안녕'), (e) => e instanceof VoiceError && e.code === 'voice_tts_no_voice');
});

test('lab override: another provider does not inherit the configured provider\'s voice', async () => {
  const { calls, fetchImpl } = recordFetch(() => new Response(Buffer.from('x'), { status: 200 }));
  const { service } = makeService({
    'voice.tts.provider': 'elevenlabs', 'voice.elevenlabs.api_key': 'xi', 'voice.tts.voice': 'eleven-voice',
    'voice.openai.api_key': 'sk',
  });
  service.fetchImpl = fetchImpl;
  await service.synthesize('테스트', { provider: 'openai' });
  assert.equal(JSON.parse(calls.at(-1).init.body).voice, 'marin', 'OpenAI default voice, not the ElevenLabs id');
});

test('upstream failures map to 409 (fix the key) or 502 (provider broke) and are logged', async () => {
  const { fetchImpl } = recordFetch((url) => (url.includes('speech-to-text')
    ? new Response(JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }), { status: 401 })
    : new Response('upstream exploded', { status: 500 })));
  const { service, logs } = makeService({
    'voice.stt.provider': 'elevenlabs', 'voice.tts.provider': 'elevenlabs',
    'voice.elevenlabs.api_key': 'xi', 'voice.tts.voice': 'v',
  });
  service.fetchImpl = fetchImpl;
  await assert.rejects(() => service.transcribe(audio, 'audio/webm'),
    (e) => e.status === 409 && e.message === 'elevenlabs 401: Invalid API key');
  await assert.rejects(() => service.synthesize('안녕'),
    (e) => e.status === 502 && e.message === 'elevenlabs 500: upstream exploded');
  assert.equal(logs.filter((l) => l[0] === 'warn' && l[1] === 'Voice').length, 2);
});

test('speech requests are bounded; speakable chunks come from the shared normalizer', async () => {
  const { service } = makeService({});
  assert.deepEqual(service.speakable('```js\nx()\n```'), []);
  assert.deepEqual(service.speakable('네. 끝났어요.'), ['네. 끝났어요.']);
  await assert.rejects(() => service.synthesize(''), (e) => e.code === 'voice_text_empty');
  await assert.rejects(() => service.synthesize('가'.repeat(2001)), (e) => e.status === 413);
});
