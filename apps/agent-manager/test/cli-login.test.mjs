// 티켓 b2e79108 — Codex device-auth 자동 로그인. 실제 codex 바이너리는 쓰지
// 않는다(네트워크 호출 + 실제 OAuth 세션 생성 위험) — 대신 CliLoginManager가
// 받을 실제 stdout 포맷(라이브 호스트에서 캡처)을 그대로 흉내 내는 가짜 codex
// 스크립트를 매 테스트마다 만들어 spawn 대상으로 override한다.
//
// AWB_AGENT_MANAGER_HOME을 임포트 전에 격리된 임시 디렉터리로 돌려놓는다 —
// CLI_LOGINS_DIR(격리 CODEX_HOME들이 사는 곳)은 그 값을 모듈 로드 시점에 한 번
// 계산하므로, 이 테스트가 실제 호스트의 ~/.codex 근처에는 절대 발을 들이지
// 않음을 이 시점에 보장한다.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const managerHome = mkdtempSync(join(tmpdir(), 'awb-cli-login-test-'));
process.env.AWB_AGENT_MANAGER_HOME = managerHome;

const { CliLoginManager } = await import('../dist/lib/cli-login.js');
const { CLI_LOGINS_DIR, LOG_PATH } = await import('../dist/lib/constants.js');
const { setRestOutbox, postCliLoginProgress, _setSucceededRetryDelaysMsForTests } = await import(
  '../dist/lib/rest.js'
);
const { MessageOutbox } = await import('../dist/lib/outbox.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitUntil: condition not met within timeout');
    await delay(intervalMs);
  }
}

const scratchDir = mkdtempSync(join(tmpdir(), 'awb-cli-login-fakebin-'));

/** 실제 라이브 호스트(codex-cli 0.147.0, 격리 CODEX_HOME)에서 캡처한 정확한
 *  줄 포맷을 그대로 재현한다 — CliLoginManager의 파서가 실제 문구에 기대는
 *  "Open this link"/"Enter this one-time code" 앵커를 검증한다. */
const REAL_PROMPT_LINES = [
  '',
  'Welcome to Codex [v0.147.0]',
  "OpenAI's command-line coding agent",
  '',
  'Follow these steps to sign in with ChatGPT using device code authorization:',
  '',
  '1. Open this link in your browser and sign in to your account',
  '   https://auth.openai.com/codex/device',
  '',
  '2. Enter this one-time code (expires in 15 minutes)',
  '   TEST-CODE1',
  '',
];

function makeFakeCodex(bodyJs) {
  const path = join(scratchDir, `fake-codex-${randomUUID()}.js`);
  writeFileSync(path, `#!/usr/bin/env node\n${bodyJs}\n`, { mode: 0o755 });
  return path;
}

function fakeCodexSuccess() {
  const printLines = REAL_PROMPT_LINES.map((l) => `console.log(${JSON.stringify(l)});`).join('\n');
  return makeFakeCodex(`
    const fs = require('fs');
    const path = require('path');
    ${printLines}
    setTimeout(() => {
      fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { access_token: 'SECRET-TOKEN-VALUE' } }));
      fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "gpt-5"\\n');
      process.exit(0);
    }, 30);
  `);
}

function fakeCodexFailure() {
  const printLines = REAL_PROMPT_LINES.map((l) => `console.log(${JSON.stringify(l)});`).join('\n');
  return makeFakeCodex(`
    ${printLines}
    setTimeout(() => { console.error('device code expired'); process.exit(1); }, 30);
  `);
}

function fakeCodexExitZeroNoAuthFile() {
  return makeFakeCodex(`setTimeout(() => process.exit(0), 20);`);
}

function fakeCodexHangs() {
  const printLines = REAL_PROMPT_LINES.map((l) => `console.log(${JSON.stringify(l)});`).join('\n');
  return makeFakeCodex(`
    ${printLines}
    setInterval(() => {}, 1000000);
  `);
}

// 리뷰 지적(round 1) 회귀 — stderr에 토큰 형태 문자열을 그대로 찍는 가짜 CLI.
function fakeCodexLeakySecretOnStderr(secret) {
  return makeFakeCodex(`
    console.error(${JSON.stringify(`access_token: ${secret}`)});
    setInterval(() => {}, 1000000);
  `);
}

// 리뷰 지적(round 1) 회귀 — url/코드 안내 문구가 전혀 매치되지 않는(파싱
// 실패) 출력만 내고 조용해지는 가짜 CLI. URL을 아예 안 찍으므로
// urlCaptured는 절대 true가 되지 않는다.
function fakeCodexUnparseableThenHangs() {
  return makeFakeCodex(`
    console.log('Please continue in your browser to finish signing in.');
    console.log('(this build prints a different prompt than the parser expects)');
    setInterval(() => {}, 1000000);
  `);
}

// 리뷰 지적(round 1) 회귀 — 처음엔 안 맞는 문구만 찍다가(파싱 실패 폴백 유도),
// 잠시 후 실제 url/코드를 찍는다 — 나중에 진짜 파싱이 성공하면 raw fallback을
// 대체해야 한다.
function fakeCodexUnparseableThenRecovers(recoverAfterMs) {
  const printLines = REAL_PROMPT_LINES.map((l) => `console.log(${JSON.stringify(l)});`).join('\n');
  return makeFakeCodex(`
    console.log('Please continue in your browser to finish signing in.');
    setTimeout(() => {
      ${printLines}
    }, ${recoverAfterMs});
    setInterval(() => {}, 1000000);
  `);
}

let originalFetch;
let requests;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRestOutbox(null);
  _setSucceededRetryDelaysMsForTests(null);
});

function progressBodies(sessionId) {
  return requests
    .filter((r) => r.url.includes(`/cli-login/${sessionId}/progress`))
    .map((r) => r.body);
}

test('success: awaiting_user then succeeded, credential_fields carries the harvested auth.json/config.toml', async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { codexBin: fakeCodexSuccess() });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-1', cli: 'codex' });

  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'succeeded'));

  const bodies = progressBodies(sessionId);
  const awaiting = bodies.find((b) => b.status === 'awaiting_user');
  assert.ok(awaiting, 'expected an awaiting_user progress report');
  assert.equal(awaiting.verification_url, 'https://auth.openai.com/codex/device');
  assert.equal(awaiting.user_code, 'TEST-CODE1');

  const succeeded = bodies.find((b) => b.status === 'succeeded');
  assert.deepEqual(JSON.parse(succeeded.credential_fields.auth_json), { tokens: { access_token: 'SECRET-TOKEN-VALUE' } });
  assert.equal(succeeded.credential_fields.config_toml, 'model = "gpt-5"\n');
  assert.equal(succeeded.command_id, 'cmd-1');

  // 임시 홈은 성공 후에도 삭제되어야 한다(완료 기준 4) — 민감 파일을 디스크에
  // 남기지 않음.
  const homeDir = join(CLI_LOGINS_DIR, sessionId);
  await waitUntil(() => !existsSync(homeDir));
  assert.equal(manager.isBusy(), false);
});

test('failure: non-zero exit is reported as failed and the isolated home is removed', async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { codexBin: fakeCodexFailure() });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-2', cli: 'codex' });

  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'failed'));
  const failed = progressBodies(sessionId).find((b) => b.status === 'failed');
  assert.match(failed.error_detail, /exited with code 1/);

  const homeDir = join(CLI_LOGINS_DIR, sessionId);
  await waitUntil(() => !existsSync(homeDir));
});

test('exit 0 without an auth.json is reported as failed, not succeeded', async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { codexBin: fakeCodexExitZeroNoAuthFile() });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-3', cli: 'codex' });

  await waitUntil(() => progressBodies(sessionId).length > 0);
  const [report] = progressBodies(sessionId);
  assert.equal(report.status, 'failed');
  assert.match(report.error_detail, /auth\.json was not found/);
});

test('timeout: a hung login is killed and reported timed_out within the injected timeout', async () => {
  const manager = new CliLoginManager(
    { url: 'https://awb.example', apiKey: 'k' },
    { codexBin: fakeCodexHangs(), timeoutMs: 150 },
  );
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-4', cli: 'codex' });

  // awaiting_user should still surface before the timeout fires — the fake
  // script prints the prompt immediately, well under 150ms.
  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'awaiting_user'));

  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'timed_out'), { timeoutMs: 3000 });
  const homeDir = join(CLI_LOGINS_DIR, sessionId);
  await waitUntil(() => !existsSync(homeDir), { timeoutMs: 3000 });
  assert.equal(manager.isBusy(), false);
});

test('cancel: an in-flight session is killed, reported cancelled, and its home is removed', async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { codexBin: fakeCodexHangs() });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-5', cli: 'codex' });
  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'awaiting_user'));

  const cancelled = await manager.cancel(sessionId);
  assert.equal(cancelled, true);

  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'cancelled'), { timeoutMs: 3000 });
  const homeDir = join(CLI_LOGINS_DIR, sessionId);
  await waitUntil(() => !existsSync(homeDir), { timeoutMs: 3000 });

  // Cancelling a session that already finished (or was never this manager's)
  // is a harmless no-op, not an error.
  assert.equal(await manager.cancel(sessionId), false);
  assert.equal(await manager.cancel('some-other-session'), false);
});

test('busy guard: a second start() while one is in flight throws and never spawns a second process', async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { codexBin: fakeCodexHangs() });
  const firstId = randomUUID();
  await manager.start({ sessionId: firstId, commandId: 'cmd-6a', cli: 'codex' });
  await waitUntil(() => progressBodies(firstId).some((b) => b.status === 'awaiting_user'));

  await assert.rejects(
    () => manager.start({ sessionId: randomUUID(), commandId: 'cmd-6b', cli: 'codex' }),
    /already in flight/,
  );

  await manager.cancel(firstId);
});

test('only codex is accepted — claude is rejected without spawning anything (follow-up ticket)', async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' });
  await assert.rejects(
    () => manager.start({ sessionId: randomUUID(), commandId: 'cmd-7', cli: 'claude' }),
    /unsupported cli "claude"/,
  );
  assert.equal(manager.isBusy(), false);
});

test('isolation: CODEX_HOME handed to the child is never the real ~/.codex, and lives under this test\'s AWB_AGENT_MANAGER_HOME', async () => {
  let capturedHome = '';
  const path = makeFakeCodex(`
    const fs = require('fs');
    fs.writeFileSync(process.env.AWB_TEST_CAPTURE_FILE, process.env.CODEX_HOME || '');
    process.exit(1);
  `);
  const captureFile = join(scratchDir, `captured-home-${randomUUID()}.txt`);
  process.env.AWB_TEST_CAPTURE_FILE = captureFile;

  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { codexBin: path });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-8', cli: 'codex' });
  await waitUntil(() => progressBodies(sessionId).length > 0);
  delete process.env.AWB_TEST_CAPTURE_FILE;

  const { readFileSync } = await import('node:fs');
  capturedHome = readFileSync(captureFile, 'utf8');
  assert.equal(capturedHome, join(CLI_LOGINS_DIR, sessionId));
  assert.notEqual(capturedHome, join(homedir(), '.codex'));
  assert.ok(capturedHome.startsWith(managerHome), 'isolated home must live under this manager instance\'s own home, not a shared/global location');
});

test('redaction: the harvested secret never appears in the durable agent-manager.log file', async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { codexBin: fakeCodexSuccess() });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-9', cli: 'codex' });
  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'succeeded'));

  // log() (logging.js) writes every line here (LOG_DIR = AWB_AGENT_MANAGER_HOME,
  // overridden above to this test's own scratch dir — never the real one).
  const logContent = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : '';
  assert.doesNotMatch(logContent, /SECRET-TOKEN-VALUE/, 'agent-manager.log leaked the raw credential');
});

test('postCliLoginProgress: a retryable transport failure buffers into the outbox under kind cli_login_progress', async () => {
  globalThis.fetch = async () => new Response('server error', { status: 500 });
  const enqueued = [];
  setRestOutbox({ enqueue: (kind, payload) => enqueued.push({ kind, payload }) });

  await postCliLoginProgress(
    { url: 'https://awb.example', apiKey: 'k' },
    { session_id: 's1', command_id: 'c1', status: 'awaiting_user', verification_url: 'https://x', user_code: 'ABC' },
  );

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].kind, 'cli_login_progress');
  assert.equal(enqueued[0].payload.body.session_id, 's1');
});

test('postCliLoginProgress: a 4xx response is permanent and does not enqueue', async () => {
  globalThis.fetch = async () => new Response('bad request', { status: 400 });
  const enqueued = [];
  setRestOutbox({ enqueue: (kind, payload) => enqueued.push({ kind, payload }) });

  await postCliLoginProgress(
    { url: 'https://awb.example', apiKey: 'k' },
    { session_id: 's2', command_id: 'c2', status: 'failed', error_detail: 'x' },
  );

  assert.equal(enqueued.length, 0);
});

// ── 리뷰 반려(round 1) 회귀 테스트 ───────────────────────────────────────

test('review-fix: a succeeded report that never gets delivered NEVER touches the outbox — the real persisted file never contains the secret, and the isolated home is preserved (not deleted)', async () => {
  _setSucceededRetryDelaysMsForTests([5, 5, 5]); // 실제 2s/5s/10s 대신 즉시 재시도
  globalThis.fetch = async () => new Response('server error', { status: 500 }); // 항상 실패

  const outboxPath = join(scratchDir, `outbox-${randomUUID()}.json`);
  const outbox = new MessageOutbox({ persistPath: outboxPath, log: () => {} });
  outbox.setSenders({ cli_login_progress: () => Promise.resolve('retryable') });
  setRestOutbox(outbox);

  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { codexBin: fakeCodexSuccess() });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-secret-1', cli: 'codex' });

  // 성공 보고가 재시도까지 전부 소진될 시간을 준다(재시도 3회 x 5ms + 여유).
  await delay(300);

  // awaiting_user 보고(URL/코드 — 시크릿 아님)는 outbox에 들어가는 게 정상
  // 동작이다. 이 테스트가 잠그는 것은 오직 'succeeded'(시크릿 포함) 상태가
  // 절대 outbox에 들어가지 않는다는 것.
  const succeededEntries = outbox.snapshot().filter((e) => e.payload?.body?.status === 'succeeded');
  assert.equal(succeededEntries.length, 0, 'a succeeded report must never be enqueued into the durable outbox');
  const fileContent = existsSync(outboxPath) ? readFileSync(outboxPath, 'utf8') : '';
  assert.doesNotMatch(fileContent, /SECRET-TOKEN-VALUE/, 'the persisted outbox file must never contain the raw credential');

  // 전달 실패 → 유일한 사본을 잃지 않도록 격리 홈을 지우지 않는다.
  const homeDir = join(CLI_LOGINS_DIR, sessionId);
  assert.equal(existsSync(join(homeDir, 'auth.json')), true, 'the harvested auth.json must be preserved when delivery never succeeds');
});

test('review-fix: stderr containing a labeled token is redacted before it ever reaches the log file', async () => {
  const secret = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
  const manager = new CliLoginManager(
    { url: 'https://awb.example', apiKey: 'k' },
    { codexBin: fakeCodexLeakySecretOnStderr(secret), timeoutMs: 150 },
  );
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-stderr-1', cli: 'codex' });
  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'timed_out'), { timeoutMs: 3000 });

  const logContent = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : '';
  assert.doesNotMatch(logContent, new RegExp(secret), 'stderr token leaked into agent-manager.log unredacted');
  assert.match(logContent, /\[REDACTED\]/, 'expected the redaction marker to appear in place of the token');
});

test('review-fix: unparseable output (no url ever found) surfaces a raw_output_fallback awaiting_user report instead of leaving the session silently stuck', async () => {
  const manager = new CliLoginManager(
    { url: 'https://awb.example', apiKey: 'k' },
    { codexBin: fakeCodexUnparseableThenHangs(), fallbackQuietMs: 30, timeoutMs: 5000 },
  );
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-fallback-1', cli: 'codex' });

  await waitUntil(() => progressBodies(sessionId).some((b) => b.raw_output_fallback), { timeoutMs: 2000 });
  const fallbackReport = progressBodies(sessionId).find((b) => b.raw_output_fallback);
  assert.equal(fallbackReport.status, 'awaiting_user');
  assert.equal(fallbackReport.verification_url, undefined);
  assert.match(fallbackReport.raw_output_fallback, /continue in your browser/);

  await manager.cancel(sessionId);
});

test('review-fix: a real url/code parse arriving after a fallback was already sent supersedes it', async () => {
  const manager = new CliLoginManager(
    { url: 'https://awb.example', apiKey: 'k' },
    { codexBin: fakeCodexUnparseableThenRecovers(200), fallbackQuietMs: 30, timeoutMs: 5000 },
  );
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-fallback-2', cli: 'codex' });

  await waitUntil(() => progressBodies(sessionId).some((b) => b.raw_output_fallback));
  await waitUntil(() => progressBodies(sessionId).some((b) => b.verification_url), { timeoutMs: 3000 });

  const bodies = progressBodies(sessionId);
  const fallbackReport = bodies.find((b) => b.raw_output_fallback);
  const properReport = bodies.find((b) => b.verification_url);
  assert.ok(fallbackReport, 'expected an early raw-output fallback report');
  assert.ok(properReport, 'expected a later proper url/code report to supersede it');
  assert.equal(properReport.verification_url, 'https://auth.openai.com/codex/device');
  assert.equal(properReport.user_code, 'TEST-CODE1');

  await manager.cancel(sessionId);
});

test('review-fix: applyProgress-equivalent — command_id is required on every progress report (rest.ts contract)', async () => {
  // agent-manager 쪽에서 항상 command_id를 채워 보내는지 확인 — 서버의
  // applyProgress가 빈 값을 요구-실패로 처리하도록 강화됐으므로, 매니저가
  // 실제로 매번 채워 보내는지가 이 계약의 절반이다(나머지 절반은 서버
  // 테스트에서 검증).
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { codexBin: fakeCodexSuccess() });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-nonempty', cli: 'codex' });
  await waitUntil(() => progressBodies(sessionId).length > 0);
  for (const body of progressBodies(sessionId)) {
    assert.ok(body.command_id, 'every progress report must carry a non-empty command_id');
  }
});
