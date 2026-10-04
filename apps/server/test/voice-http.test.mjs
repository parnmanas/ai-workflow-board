// 음성 게이트웨이 HTTP 배선 — docs/voice-operator.md.
//
// 공급자 요청 모양은 voice-gateway.test.mjs 가 고정한다. 여기서는 실제 앱을 띄워 그 사이의 배선을 본다:
//   1. voice.use 는 기본 admin 전용이고, Voice lab 은 admin 만 부른다.
//   2. Admin Settings 로 저장한 voice.* 가 곧바로 반영된다(설정 캐시가 저장 때 비워진다).
//   3. /transcribe 는 raw 오디오 본문을 그대로 받아(http-body-parsers) 공급자에 multipart 로 넘긴다.
//   4. /speakable → /speech 가 화면의 낭독 흐름 그대로 동작하고, 오디오 바이트가 그대로 돌아온다.
//   5. 공급자가 꺼져 있거나 키가 틀리면 409 + 사유 — 대체 경로로 조용히 넘어가지 않는다.
//
// 네트워크 없이: OpenAI 호환 공급자의 base_url 을 이 테스트가 띄운 가짜 서버로 둔다.
// 실행: node --test --test-force-exit test/voice-http.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createUser } from './helpers/fixtures.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';

async function call(url, init) {
  const res = await fetch(url, init);
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null;
  try { body = JSON.parse(buf.toString('utf8')); } catch { body = null; }
  return { status: res.status, body, buf, headers: res.headers };
}

/** OpenAI 호환 오디오 서버 흉내 — 받은 요청을 기록하고 고정 응답을 준다. */
async function startFakeAudioServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: req.url, headers: req.headers, body });
      if (req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: ' 롤프 세션 상태 알려줘 ' }));
      } else if (req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(Buffer.from('ID3-fake-mp3'));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

test('voice gateway: permissions, settings, transcribe, speakable → speech, and honest failures', async (t) => {
  const fake = await startFakeAudioServer();
  t.after(() => fake.close());
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const base = `http://localhost:${port}`;

  const admin = await createUser(app, getDataSourceToken, { name: 'admin', role: 'admin' });
  const plain = await createUser(app, getDataSourceToken, { name: 'plain', role: 'user' });
  const adminAuth = { Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}` };
  const plainAuth = { Authorization: `Bearer ${app.get(AuthService).createSession(plain.id)}` };
  const json = { 'Content-Type': 'application/json' };

  // 1. 권한
  assert.equal((await call(`${base}/api/voice/config`, { headers: plainAuth })).status, 403, 'voice.use is admin-only by default');
  assert.equal((await call(`${base}/api/voice/lab/speech`, { method: 'POST', headers: { ...plainAuth, ...json }, body: '{}' })).status, 403);

  // 꺼져 있으면 꺼져 있다고 말한다.
  let config = await call(`${base}/api/voice/config`, { headers: adminAuth });
  assert.equal(config.status, 200);
  assert.deepEqual(config.body.stt, { provider: 'none', ready: false, error: null });
  const off = await call(`${base}/api/voice/transcribe`, { method: 'POST', headers: { ...adminAuth, 'Content-Type': 'audio/webm' }, body: Buffer.from('x') });
  assert.equal(off.status, 409);
  assert.equal(off.body.error, 'voice_stt_disabled');

  // 2. Admin Settings 로 저장 → 바로 반영
  const saved = await call(`${base}/api/admin/settings`, {
    method: 'PATCH', headers: { ...adminAuth, ...json },
    body: JSON.stringify({ settings: {
      'voice.stt.provider': 'openai',
      'voice.tts.provider': 'openai',
      'voice.openai.base_url': fake.url,
      'voice.stt.model': 'local-asr',
      'voice.tts.model': 'local-tts',
      'voice.tts.voice': 'kore',
      'voice.stt.languages': 'ko,en',
      'voice.stt.terms': 'AWB, rolf',
    } }),
  });
  assert.equal(saved.status, 200, saved.buf.toString());
  config = await call(`${base}/api/voice/config`, { headers: adminAuth });
  assert.equal(config.body.stt.ready, true, JSON.stringify(config.body));
  assert.deepEqual(config.body.tts, { provider: 'openai', ready: true, error: null, voice: 'kore' });
  assert.deepEqual(config.body.lab, { stt: ['openai'], tts: ['openai'] });
  const settingsList = await call(`${base}/api/admin/settings`, { headers: adminAuth });
  assert.ok(settingsList.body.some((s) => s.key === 'voice.soniox.api_key' && s.is_secret), 'voice keys are listed as secrets');

  // 3. raw 오디오 → 공급자 multipart
  const clip = Buffer.from('webm-bytes-\u0000\u0001\u0002');
  const transcribed = await call(`${base}/api/voice/transcribe`, {
    method: 'POST', headers: { ...adminAuth, 'Content-Type': 'audio/webm;codecs=opus' }, body: clip,
  });
  assert.equal(transcribed.status, 200, transcribed.buf.toString());
  assert.equal(transcribed.body.text, '롤프 세션 상태 알려줘');
  assert.equal(transcribed.body.provider, 'openai');
  assert.equal(transcribed.body.model, 'local-asr');
  const upstream = fake.seen.find((s) => s.url === '/v1/audio/transcriptions');
  assert.match(String(upstream.headers['content-type']), /^multipart\/form-data/);
  assert.equal(upstream.headers.authorization, undefined, 'self-hosted: no key, no Authorization header');
  assert.ok(upstream.body.includes(clip), 'the recorded bytes reach the provider untouched');
  assert.ok(upstream.body.includes(Buffer.from('filename="utterance.webm"')));
  assert.ok(upstream.body.includes(Buffer.from('AWB, rolf.')), 'vocabulary rides the prompt for a self-hosted server');

  // 4. 낭독 흐름: 화면용 답 → 조각 → 소리
  const speakable = await call(`${base}/api/voice/speakable`, {
    method: 'POST', headers: { ...adminAuth, ...json },
    body: JSON.stringify({ text: '## 결과\n배포 끝났어요.\n```sh\nnpm run build\n```\n- 커밋 3f2c3761 반영' }),
  });
  assert.equal(speakable.status, 200);
  assert.deepEqual(speakable.body.chunks, ['결과. 배포 끝났어요. 커밋 반영.']);
  const speech = await call(`${base}/api/voice/speech`, {
    method: 'POST', headers: { ...adminAuth, ...json }, body: JSON.stringify({ text: speakable.body.chunks[0] }),
  });
  assert.equal(speech.status, 200);
  assert.equal(speech.headers.get('content-type'), 'audio/mpeg');
  assert.equal(speech.headers.get('cache-control'), 'no-store');
  assert.equal(speech.buf.toString(), 'ID3-fake-mp3');
  const ttsUpstream = JSON.parse(fake.seen.find((s) => s.url === '/v1/audio/speech').body.toString());
  assert.deepEqual(ttsUpstream, { model: 'local-tts', input: '결과. 배포 끝났어요. 커밋 반영.', voice: 'kore', response_format: 'mp3' });

  // lab 은 활성 공급자와 무관하게 고른 공급자를 부른다 — 키가 없으면 그 사유로 거절한다.
  const labNoKey = await call(`${base}/api/voice/lab/speech`, {
    method: 'POST', headers: { ...adminAuth, ...json }, body: JSON.stringify({ provider: 'elevenlabs', text: '안녕' }),
  });
  assert.equal(labNoKey.status, 409);
  assert.match(labNoKey.body.message, /ElevenLabs API key is not set/);

  // 5. 모르는 공급자 이름은 대체하지 않고 거절한다.
  await call(`${base}/api/admin/settings`, {
    method: 'PATCH', headers: { ...adminAuth, ...json }, body: JSON.stringify({ settings: { 'voice.tts.provider': 'clova' } }),
  });
  const unknown = await call(`${base}/api/voice/speech`, {
    method: 'POST', headers: { ...adminAuth, ...json }, body: JSON.stringify({ text: '안녕' }),
  });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.error, 'voice_tts_unknown_provider');
});
