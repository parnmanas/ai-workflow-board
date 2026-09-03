// 회귀 테스트 — 알림 provider 3종(discord/slack/telegram)의 요청 상한 (티켓 ebee0637).
//
// 고치기 전: provider 들이 raw `fetch` 를 썼고 요청 타임아웃이 없었다. 연결은
// 받아주고 응답을 돌려주지 않는 엔드포인트 하나면 `provider.send()` 가 영원히
// pending 으로 남고, `UserChannelDispatcherService.dispatchForUser` 가 바인딩들을
// `Promise.all` 로 묶어 기다리므로 그 사용자의 팬아웃 전체가 함께 매달렸다.
// 팬아웃을 fire-and-forget 이 아니라 `await` 하는 호출부는 그대로 영구 정지했다.
//
// 검증 방식: production 코드의 URL(`https://discord.com/...` 등)은 그대로 두고
// `globalThis.fetch` 를 얇은 프록시로 감싸 **호스트만** 로컬 테스트 서버로 돌린다.
// 실제 undici fetch, 실제 TCP 소켓, provider 가 건넨 실제 `AbortSignal` 이
// 그대로 쓰이므로 "상한이 진짜 매달린 소켓을 끊는가" 를 확인할 수 있다.
// 매달림은 두 가지 형태를 모두 재현한다 — 헤더조차 안 보내는 경우와,
// 헤더는 보내고 본문에서 멈추는 경우(본문 읽기에도 상한이 걸려야 한다).
//
// 상한 초과가 예외로 새면 안 된다는 점은 dispatcher 를 실제로 돌려 확인한다:
// 매달린 바인딩이 섞여 있어도 `Promise.all` 이 거부 없이 끝나고 나머지 바인딩은
// 정상 발송돼야 한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

// 암호화 키를 미리 고정한다 — 안 하면 encryption.service 가 데이터 디렉터리에
// 키 파일을 만든다(테스트가 남기면 안 되는 부작용).
process.env.ENCRYPTION_KEY = 'ebee0637-notification-timeout-test-key';

async function loadDist(...segments) {
  const url = 'file://' + path.join(DIST, ...segments);
  try {
    return await import(url);
  } catch (err) {
    throw new Error(
      '이 테스트는 서버 빌드 산출물이 필요하다. `npm run --workspace=apps/server build` 를 먼저 실행할 것. 원인: ' + err.message,
    );
  }
}

const { DiscordUserProvider } = await loadDist('services', 'notification-providers', 'discord.provider.js');
const { SlackUserProvider } = await loadDist('services', 'notification-providers', 'slack.provider.js');
const { TelegramUserProvider } = await loadDist('services', 'notification-providers', 'telegram.provider.js');
const { UserChannelDispatcherService } = await loadDist('services', 'notification-providers', 'dispatcher.service.js');
const { NOTIFY_HTTP_TIMEOUT_ENV, notifyHttpTimeoutMs } = await loadDist('services', 'notification-providers', 'http.js');
const { encrypt } = await loadDist('services', 'encryption.service.js');

const REAL_FETCH = globalThis.fetch;
const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * 한 third-party 호스트를 흉내내는 로컬 서버.
 * `state.mode` 로 응답 방식을 바꾼다:
 *   'ok'        — 정상 JSON 응답
 *   'hang'      — 헤더조차 보내지 않고 소켓만 붙잡는다
 *   'hang-body' — 헤더는 보내고 본문을 끝내지 않는다
 */
async function startOrigin(respondOk) {
  const state = { mode: 'ok', requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      state.requests.push({
        method: req.method,
        path: req.url,
        authorization: req.headers['authorization'] || null,
        body: raw,
      });
      if (state.mode === 'hang') return;
      if (state.mode === 'hang-body') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '64' });
        res.write('{"ok":');
        return;
      }
      respondOk(req, res, jsonResponder(res));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    reset(mode = 'ok') { state.mode = mode; state.requests.length = 0; },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function jsonResponder(res) {
  return (obj, status = 200) => {
    const buf = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(buf.length) });
    res.end(buf);
  };
}

const discordOrigin = await startOrigin((req, _res, json) => {
  if (req.url === '/api/v10/users/@me/channels') return json({ id: 'dm-channel-1' });
  if (req.url.endsWith('/messages')) return json({ id: 'message-1' });
  if (req.url.startsWith('/api/v10/channels/')) return json({ id: 'channel-probe' });
  return json({ message: 'unexpected path ' + req.url }, 404);
});
const slackOrigin = await startOrigin((req, _res, json) => {
  if (req.url === '/api/chat.postMessage') return json({ ok: true, ts: '1.0' });
  if (req.url === '/api/auth.test') return json({ ok: true, user: 'awb-bot' });
  return json({ ok: false, error: 'unexpected path ' + req.url }, 404);
});
const telegramOrigin = await startOrigin((req, _res, json) => {
  if (req.url.endsWith('/sendMessage')) return json({ ok: true, result: { message_id: 7 } });
  if (req.url.endsWith('/getMe')) return json({ ok: true, result: { username: 'awb_bot' } });
  return json({ ok: false, description: 'unexpected path ' + req.url }, 404);
});

const HOST_MAP = [
  ['https://discord.com', discordOrigin],
  ['https://slack.com', slackOrigin],
  ['https://api.telegram.org', telegramOrigin],
];

// provider 가 fetch 에 넘긴 signal 을 모아둔다. 셋 다 상한을 달고 나가는지
// (누군가 나중에 상한 없는 raw fetch 를 다시 끼워넣지 않는지) 확인하는 용도.
const signalsSeen = [];

globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  const matched = HOST_MAP.find(([host]) => url.startsWith(host));
  signalsSeen.push(init?.signal ?? null);
  const target = matched ? matched[1].url + url.slice(matched[0].length) : url;
  return REAL_FETCH(target, init);
};

test.after(async () => {
  globalThis.fetch = REAL_FETCH;
  delete process.env[NOTIFY_HTTP_TIMEOUT_ENV];
  await Promise.all([discordOrigin.close(), slackOrigin.close(), telegramOrigin.close()]);
});

const TIMEOUT_MS = 700;
// 매달린 경로가 상한 안에 끝나는지 보는 여유 상한. 이 값을 넘기면 "끝나긴 하는데
// 상한이 안 걸렸다" 는 뜻이다. 고치기 전에는 무한 대기라 여기서 반드시 걸린다.
const SETTLE_CEILING_MS = 8000;

function providers() {
  return [
    { name: 'discord', provider: new DiscordUserProvider(noopLog), origin: discordOrigin, target: 'user-1' },
    { name: 'slack', provider: new SlackUserProvider(noopLog), origin: slackOrigin, target: 'U12345' },
    { name: 'telegram', provider: new TelegramUserProvider(noopLog), origin: telegramOrigin, target: '99001' },
  ];
}

const PAYLOAD = { title: '게이트 대기', body: '확인이 필요합니다', actor: 'Rolf/Programmer', url: 'https://awb.example/ws/1' };
const CREDS = { bot_token: 'test-token' };

function resetAll(mode = 'ok') {
  signalsSeen.length = 0;
  discordOrigin.reset(mode);
  slackOrigin.reset(mode);
  telegramOrigin.reset(mode);
}

test('응답하지 않는 엔드포인트를 향한 send() 가 상한 안에 ok:false 로 끝난다', { timeout: 60000 }, async () => {
  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = String(TIMEOUT_MS);
  for (const { name, provider } of providers()) {
    resetAll('hang');
    const started = Date.now();
    // send() 가 던지면 여기서 테스트가 실패한다 — 계약은 "throw 하지 말고 ok:false".
    const res = await provider.send('user-1', CREDS, PAYLOAD);
    const elapsed = Date.now() - started;

    assert.equal(res.ok, false, `${name}: 매달린 엔드포인트인데 ok:true 를 돌려줬다`);
    assert.match(
      res.error,
      new RegExp(`timed out after ${TIMEOUT_MS}ms`),
      `${name}: 오류 문구가 상한 초과로 정규화되지 않았다 — 받은 값: ${res.error}`,
    );
    assert.ok(
      elapsed < SETTLE_CEILING_MS,
      `${name}: send() 가 ${elapsed}ms 걸렸다 — 상한 ${TIMEOUT_MS}ms 가 실제로 걸리지 않았다`,
    );
    assert.ok(
      signalsSeen.length > 0 && signalsSeen.every((s) => s && typeof s.aborted === 'boolean'),
      `${name}: 상한 없는 raw fetch 호출이 남아 있다 (AbortSignal 없이 나간 요청)`,
    );
  }
});

test('헤더만 보내고 본문에서 멈추는 응답도 상한에 끊겨 ok:false 가 된다', { timeout: 60000 }, async () => {
  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = String(TIMEOUT_MS);
  for (const { name, provider } of providers()) {
    resetAll('hang-body');
    const started = Date.now();
    const res = await provider.send('user-1', CREDS, PAYLOAD);
    const elapsed = Date.now() - started;

    assert.equal(res.ok, false, `${name}: 본문이 끝나지 않았는데 ok:true 를 돌려줬다`);
    // 멈춘 본문을 "API 가 이상한 응답을 줬다" 로 오보하면 진단이 엉뚱한 곳을 향한다.
    assert.match(
      res.error,
      new RegExp(`timed out after ${TIMEOUT_MS}ms`),
      `${name}: 본문 읽기 상한 초과가 상한 초과로 보고되지 않았다 — 받은 값: ${res.error}`,
    );
    assert.ok(
      elapsed < SETTLE_CEILING_MS,
      `${name}: send() 가 ${elapsed}ms 걸렸다 — 본문 읽기에는 상한이 안 걸렸다`,
    );
  }
});

test('discord 는 매달린 호스트에 폴백 프로브를 다시 던지지 않는다 (상한이 두 배가 되지 않는다)', { timeout: 60000 }, async () => {
  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = String(TIMEOUT_MS);
  const provider = new DiscordUserProvider(noopLog);

  // 헤더조차 안 오는 경우: DM-open 하나만 나가고 채널 프로브는 나가지 않아야 한다.
  resetAll('hang');
  const first = await provider.send('user-1', CREDS, PAYLOAD);
  assert.equal(first.ok, false);
  assert.equal(
    discordOrigin.state.requests.length,
    1,
    `매달린 호스트에 ${discordOrigin.state.requests.length}번 요청했다 — 폴백 프로브가 상한을 두 배로 만든다`,
  );

  // 헤더는 오고 본문이 멈추는 경우도 마찬가지 — 본문 읽기 실패를 "이 target 은
  // 사용자가 아니다" 로 착각해 프로브를 한 번 더 던지면 안 된다.
  resetAll('hang-body');
  const second = await provider.send('user-1', CREDS, PAYLOAD);
  assert.equal(second.ok, false);
  assert.equal(
    discordOrigin.state.requests.length,
    1,
    `본문이 멈춘 응답에 폴백 프로브를 던졌다 (요청 ${discordOrigin.state.requests.length}건)`,
  );
});

test('정상 응답 경로의 동작과 요청 모양은 그대로다', { timeout: 60000 }, async () => {
  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = String(TIMEOUT_MS);
  resetAll('ok');

  const discord = await new DiscordUserProvider(noopLog).send('user-1', CREDS, PAYLOAD);
  assert.deepEqual(discord, { ok: true });
  assert.deepEqual(
    discordOrigin.state.requests.map((r) => `${r.method} ${r.path}`),
    ['POST /api/v10/users/@me/channels', 'POST /api/v10/channels/dm-channel-1/messages'],
    'discord 의 DM-open → 메시지 전송 2단 호출이 바뀌었다',
  );
  assert.equal(discordOrigin.state.requests[0].authorization, 'Bot test-token');
  assert.deepEqual(JSON.parse(discordOrigin.state.requests[0].body), { recipient_id: 'user-1' });
  assert.match(JSON.parse(discordOrigin.state.requests[1].body).content, /\*\*게이트 대기\*\*/);

  const slack = await new SlackUserProvider(noopLog).send('U12345', CREDS, PAYLOAD);
  assert.deepEqual(slack, { ok: true });
  assert.deepEqual(slackOrigin.state.requests.map((r) => `${r.method} ${r.path}`), ['POST /api/chat.postMessage']);
  assert.equal(slackOrigin.state.requests[0].authorization, 'Bearer test-token');
  const slackBody = JSON.parse(slackOrigin.state.requests[0].body);
  assert.equal(slackBody.channel, 'U12345');
  assert.equal(slackBody.mrkdwn, true);
  assert.match(slackBody.text, /\*게이트 대기\*/);

  const telegram = await new TelegramUserProvider(noopLog).send('99001', CREDS, PAYLOAD);
  assert.deepEqual(telegram, { ok: true });
  assert.deepEqual(
    telegramOrigin.state.requests.map((r) => `${r.method} ${r.path}`),
    ['POST /bottest-token/sendMessage'],
  );
  const telegramBody = JSON.parse(telegramOrigin.state.requests[0].body);
  assert.equal(telegramBody.chat_id, '99001');
  assert.equal(telegramBody.parse_mode, 'HTML');
  assert.equal(telegramBody.disable_web_page_preview, true);
  assert.match(telegramBody.text, /<b>게이트 대기<\/b>/);
});

test('test() probe 도 매달림에 던지지 않고 ok:false 로 끝난다', { timeout: 60000 }, async () => {
  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = String(TIMEOUT_MS);

  // 정상 경로: probe 가 선행 호출(auth.test / getMe) 뒤에 실제 발송까지 한다.
  resetAll('ok');
  assert.deepEqual(await new SlackUserProvider(noopLog).test('U12345', CREDS), { ok: true });
  assert.deepEqual(
    slackOrigin.state.requests.map((r) => r.path),
    ['/api/auth.test', '/api/chat.postMessage'],
  );
  assert.deepEqual(await new TelegramUserProvider(noopLog).test('99001', CREDS), { ok: true });
  assert.deepEqual(
    telegramOrigin.state.requests.map((r) => r.path),
    ['/bottest-token/getMe', '/bottest-token/sendMessage'],
  );

  // 매달림: REST 의 "채널 테스트" 버튼이 이 결과를 그대로 await 하므로 던지면 500 이 된다.
  for (const { name, provider, target } of providers()) {
    resetAll('hang');
    const started = Date.now();
    const res = await provider.test(target, CREDS);
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false, `${name}: test() 가 매달린 엔드포인트에 ok:true 를 돌려줬다`);
    assert.match(res.error, new RegExp(`timed out after ${TIMEOUT_MS}ms`), `${name}: ${res.error}`);
    assert.ok(elapsed < SETTLE_CEILING_MS, `${name}: test() 가 ${elapsed}ms 걸렸다`);
  }
});

test('상한은 env 로 조정된다 — 값이 크면 실제로 더 오래 버틴다', { timeout: 60000 }, async () => {
  const provider = new SlackUserProvider(noopLog);

  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = '400';
  assert.equal(notifyHttpTimeoutMs(), 400);
  resetAll('hang');
  const shortStart = Date.now();
  const shortRes = await provider.send('U12345', CREDS, PAYLOAD);
  const shortElapsed = Date.now() - shortStart;
  assert.match(shortRes.error, /timed out after 400ms/);

  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = '2000';
  assert.equal(notifyHttpTimeoutMs(), 2000);
  resetAll('hang');
  const longStart = Date.now();
  const longRes = await provider.send('U12345', CREDS, PAYLOAD);
  const longElapsed = Date.now() - longStart;
  assert.match(longRes.error, /timed out after 2000ms/);

  // 문구만 바뀌고 실제 대기는 그대로인 "설정만 있는 척" 을 배제한다.
  assert.ok(
    longElapsed > shortElapsed,
    `env 를 400ms→2000ms 로 올렸는데 대기 시간이 늘지 않았다 (${shortElapsed}ms → ${longElapsed}ms)`,
  );

  // 잘못 적힌 값은 조용히 기본값으로 되돌아간다 — 오타 하나가 모든 알림을 죽이면 안 된다.
  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = 'not-a-number';
  assert.equal(notifyHttpTimeoutMs(), 15000);
  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = '0';
  assert.equal(notifyHttpTimeoutMs(), 15000);
  // 오타로 사실상 무제한이 되는 것도 막는다.
  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = '999999999';
  assert.equal(notifyHttpTimeoutMs(), 120000);
  delete process.env[NOTIFY_HTTP_TIMEOUT_ENV];
  assert.equal(notifyHttpTimeoutMs(), 15000);
});

test('매달린 바인딩이 섞여 있어도 dispatcher 의 Promise.all 이 정상 종료한다', { timeout: 60000 }, async () => {
  process.env[NOTIFY_HTTP_TIMEOUT_ENV] = String(TIMEOUT_MS);

  const credentials = encrypt(JSON.stringify(CREDS));
  const bindings = [
    { id: 'b-discord', user_id: 'u1', provider: 'discord', target: 'user-1', credentials, is_active: 1, notify_mention: 1 },
    { id: 'b-slack', user_id: 'u1', provider: 'slack', target: 'U12345', credentials, is_active: 1, notify_mention: 1 },
    { id: 'b-telegram', user_id: 'u1', provider: 'telegram', target: '99001', credentials, is_active: 1, notify_mention: 1 },
  ];
  const registryProviders = {
    discord: new DiscordUserProvider(noopLog),
    slack: new SlackUserProvider(noopLog),
    telegram: new TelegramUserProvider(noopLog),
  };
  const service = new UserChannelDispatcherService(
    { async find() { return bindings; } },
    { async findOne() { return null; } },
    { async findOne() { return null; } },
    { async find() { return []; } },
    { get: (id) => registryProviders[id] || null },
    noopLog,
  );

  // slack 만 매달리게 두고 나머지는 정상 응답시킨다.
  resetAll('ok');
  slackOrigin.state.mode = 'hang';

  const started = Date.now();
  const result = await service.dispatchForUser('u1', 'notify_mention', PAYLOAD);
  const elapsed = Date.now() - started;

  assert.deepEqual(
    result,
    { sent: 2, failed: 1 },
    '매달린 바인딩 하나가 나머지 바인딩의 발송까지 끌고 내려갔다',
  );
  assert.ok(elapsed < SETTLE_CEILING_MS, `dispatchForUser 가 ${elapsed}ms 걸렸다 — 상한이 팬아웃에 전달되지 않았다`);

  // 상한 초과가 거부(rejection)로 새면 `Promise.all` 이 끊겨 sent 집계 자체가 안 된다.
  assert.equal(discordOrigin.state.requests.length, 2, 'discord 바인딩이 매달린 slack 때문에 진행되지 못했다');
  assert.equal(telegramOrigin.state.requests.length, 1, 'telegram 바인딩이 매달린 slack 때문에 진행되지 못했다');

  // 전부 매달린 경우에도 예외 없이 집계만 실패로 끝난다.
  resetAll('hang');
  const allHung = await service.dispatchForUser('u1', 'notify_mention', PAYLOAD);
  assert.deepEqual(allHung, { sent: 0, failed: 3 });
});
