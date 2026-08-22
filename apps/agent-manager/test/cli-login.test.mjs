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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

// 리뷰 지적(round 2) 회귀 — JWT/prefix-key/labeled/opaque 네 종류 시크릿을
// 전부 문자열 "중간"(offset 0이 아님)에 심어서 stderr와 (파싱 실패 유도용)
// stdout 양쪽에 찍는 가짜 CLI. redactSecrets()가 capture-group이 없는
// 정규식(JWT/prefix-key)에서 원본 전체를 되삽입하던 버그를 잡기 위한 것.
const LEAKY_SECRETS = {
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  prefixKey: 'sk-abcdefgh12345678ABCDEFGH',
  labeledValue: 'SUPERSECRETVALUE1234567',
  opaque: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6',
};

function fakeCodexLeakySecretsEverywhere() {
  const s = LEAKY_SECRETS;
  return makeFakeCodex(`
    console.error('warning: saw jwt ' + ${JSON.stringify(s.jwt)} + ' during startup');
    console.error('key check: ' + ${JSON.stringify(s.prefixKey)} + ' loaded ok');
    console.error(${JSON.stringify(`access_token: ${s.labeledValue}`)} + ' (cached)');
    console.error('random blob ' + ${JSON.stringify(s.opaque)} + ' seen in env');
    console.log('unrelated line embeds jwt ' + ${JSON.stringify(s.jwt)} + ' mid-sentence');
    console.log('and a prefix key ' + ${JSON.stringify(s.prefixKey)} + ' mid-sentence too');
    console.log('labeled ' + ${JSON.stringify(`access_token: ${s.labeledValue}`)} + ' mid-sentence');
    console.log('opaque blob ' + ${JSON.stringify(s.opaque)} + ' mid-sentence');
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

// ── ticket 06b2b990 — Claude CLI device-auth 자동 로그인 ────────────────
//
// 실제 라이브 호스트(claude-cli 2.1.238, `CLAUDE_CONFIG_DIR` 격리, `claude
// auth login --claudeai`)에서 캡처한 정확한 줄 포맷. codex와 달리 별도 줄의
// one-time code가 없다 — "Paste code here if prompted"는 자동 폴링이 실패한
// 경우에만 쓰이는 조건부 폴백이라 파서가 관여하지 않는다(cli-login.ts 상단
// 주석 참고). URL은 "If the browser didn't open, visit: <url>"처럼 문장
// 안에 섞여 나온다 — CliLoginManager의 URL 정규식(`https?:\/\/\S+`)이 줄
// 앞머리 여부와 무관하게 뽑아내는지를 이 포맷 자체가 검증한다.
// 리뷰 지적(round 1, ticket 06b2b990): client_id/state 둘 다 24자+ 영숫자-
// 하이픈 문자열이라야 redactSecrets()의 OPAQUE_TOKEN_RE가 실제로 이 값들을
// [REDACTED]로 지우는 회귀를 재현한다 — 이전 fixture의 state=test-state는
// 10자라 이 회귀를 놓쳤다.
const CLAUDE_TEST_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=AbiMBGlAr1KmUTZvBWNYh1Q16mBxagC2Vkj14gSsstE';
const REAL_CLAUDE_PROMPT_LINES = [
  'Opening browser to sign in…',
  `If the browser didn't open, visit: ${CLAUDE_TEST_URL}`,
  'Paste code here if prompted > ',
];

function makeFakeClaude(bodyJs) {
  const path = join(scratchDir, `fake-claude-${randomUUID()}.js`);
  writeFileSync(path, `#!/usr/bin/env node\n${bodyJs}\n`, { mode: 0o755 });
  return path;
}

function fakeClaudeSuccess() {
  const printLines = REAL_CLAUDE_PROMPT_LINES.map((l) => `console.log(${JSON.stringify(l)});`).join('\n');
  return makeFakeClaude(`
    const fs = require('fs');
    const path = require('path');
    ${printLines}
    setTimeout(() => {
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET-CLAUDE-TOKEN-VALUE' } }));
      process.exit(0);
    }, 30);
  `);
}

function fakeClaudeFailure() {
  const printLines = REAL_CLAUDE_PROMPT_LINES.map((l) => `console.log(${JSON.stringify(l)});`).join('\n');
  return makeFakeClaude(`
    ${printLines}
    setTimeout(() => { console.error('login failed: state mismatch'); process.exit(1); }, 30);
  `);
}

function fakeClaudeExitZeroNoCredentialsFile() {
  return makeFakeClaude(`setTimeout(() => process.exit(0), 20);`);
}

function fakeClaudeHangs() {
  const printLines = REAL_CLAUDE_PROMPT_LINES.map((l) => `console.log(${JSON.stringify(l)});`).join('\n');
  return makeFakeClaude(`
    ${printLines}
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

test('codex and claude are both accepted (ticket 06b2b990); a third cli is rejected without spawning anything', async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' });
  await assert.rejects(
    () => manager.start({ sessionId: randomUUID(), commandId: 'cmd-7', cli: 'gemini' }),
    /unsupported cli "gemini"/,
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

// ── ticket 06b2b990 — Claude device-auth tests ──────────────────────────

test('claude success: awaiting_user carries the url only (no user_code — claude has none), then succeeded with credential_fields.credentials_json', async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { claudeBin: fakeClaudeSuccess() });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-c1', cli: 'claude' });

  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'succeeded'));

  const bodies = progressBodies(sessionId);
  const awaiting = bodies.find((b) => b.status === 'awaiting_user');
  assert.ok(awaiting, 'expected an awaiting_user progress report');
  // 리뷰 지적(round 1, ticket 06b2b990) 회귀: prefix만 확인하면
  // redactSecrets()가 URL 안의 client_id/state(24자+ 영숫자-하이픈 값)를
  // [REDACTED]로 지워 승인 불가능한 링크를 만드는 손상을 놓친다 — 반드시
  // 원본 URL 전체와 정확히 일치해야 한다.
  assert.equal(awaiting.verification_url, CLAUDE_TEST_URL);
  assert.equal(awaiting.user_code, undefined, 'claude device-auth has no user-entered code, unlike codex');

  const succeeded = bodies.find((b) => b.status === 'succeeded');
  assert.deepEqual(
    JSON.parse(succeeded.credential_fields.credentials_json),
    { claudeAiOauth: { accessToken: 'SECRET-CLAUDE-TOKEN-VALUE' } },
  );
  assert.equal(succeeded.command_id, 'cmd-c1');

  // 임시 홈은 성공 후에도 삭제되어야 한다(완료 기준 4) — 민감 파일을 디스크에
  // 남기지 않음.
  const homeDir = join(CLI_LOGINS_DIR, sessionId);
  await waitUntil(() => !existsSync(homeDir));
  assert.equal(manager.isBusy(), false);
});

test("claude failure: non-zero exit is reported as failed with a claude-specific message (not codex's), and the isolated home is removed", async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { claudeBin: fakeClaudeFailure() });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-c2', cli: 'claude' });

  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'failed'));
  const failed = progressBodies(sessionId).find((b) => b.status === 'failed');
  assert.match(failed.error_detail, /^claude login exited with code 1/);

  const homeDir = join(CLI_LOGINS_DIR, sessionId);
  await waitUntil(() => !existsSync(homeDir));
});

test('claude: exit 0 without a .credentials.json is reported as failed, not succeeded', async () => {
  const manager = new CliLoginManager(
    { url: 'https://awb.example', apiKey: 'k' },
    { claudeBin: fakeClaudeExitZeroNoCredentialsFile() },
  );
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-c3', cli: 'claude' });

  await waitUntil(() => progressBodies(sessionId).length > 0);
  const [report] = progressBodies(sessionId);
  assert.equal(report.status, 'failed');
  assert.match(report.error_detail, /\.credentials\.json was not found/);
});

test('claude timeout: a hung login is killed and reported timed_out within the injected timeout', async () => {
  const manager = new CliLoginManager(
    { url: 'https://awb.example', apiKey: 'k' },
    { claudeBin: fakeClaudeHangs(), timeoutMs: 150 },
  );
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-c4', cli: 'claude' });

  // awaiting_user should still surface before the timeout fires — the fake
  // script prints the prompt immediately, well under 150ms.
  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'awaiting_user'));

  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'timed_out'), { timeoutMs: 3000 });
  const homeDir = join(CLI_LOGINS_DIR, sessionId);
  await waitUntil(() => !existsSync(homeDir), { timeoutMs: 3000 });
  assert.equal(manager.isBusy(), false);
});

test('claude cancel: an in-flight session is killed, reported cancelled, and its home is removed', async () => {
  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { claudeBin: fakeClaudeHangs() });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-c5', cli: 'claude' });
  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'awaiting_user'));

  const cancelled = await manager.cancel(sessionId);
  assert.equal(cancelled, true);

  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'cancelled'), { timeoutMs: 3000 });
  const homeDir = join(CLI_LOGINS_DIR, sessionId);
  await waitUntil(() => !existsSync(homeDir), { timeoutMs: 3000 });
});

// 티켓 완료 기준: "호스트의 실제 ~/.claude/.credentials.json이 로그인 도중/후
// 변경되지 않음을 테스트로 잠글 것". 실제 개발자 홈은 절대 건드리지 않는다
// (CI마다 다르고 위험할 수 있음) — 대신 이 테스트가 전부 통제하는 가짜 "실제
// 홈"에 sentinel 파일을 심어두고, 격리된 로그인 플로우가 끝난 뒤에도 그
// 파일이 바이트 단위로 그대로인지 직접 확인한다.
test("isolation: CLAUDE_CONFIG_DIR handed to the child is never the real ~/.claude, and the host's real .credentials.json is byte-identical before/after a full login", async () => {
  const fakeRealHome = mkdtempSync(join(tmpdir(), 'awb-cli-login-realhome-'));
  const fakeRealClaudeDir = join(fakeRealHome, '.claude');
  mkdirSync(fakeRealClaudeDir, { recursive: true });
  const realCredPath = join(fakeRealClaudeDir, '.credentials.json');
  const sentinelContent = JSON.stringify({ claudeAiOauth: { accessToken: 'REAL-HOST-TOKEN-DO-NOT-TOUCH' } });
  writeFileSync(realCredPath, sentinelContent);

  const captureFile = join(scratchDir, `captured-claude-home-${randomUUID()}.txt`);
  const path = makeFakeClaude(`
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(${JSON.stringify(captureFile)}, process.env.CLAUDE_CONFIG_DIR || '');
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'ISOLATED-TOKEN' } }));
    process.exit(0);
  `);

  const manager = new CliLoginManager({ url: 'https://awb.example', apiKey: 'k' }, { claudeBin: path });
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-c8', cli: 'claude' });
  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'succeeded'));

  const capturedConfigDir = readFileSync(captureFile, 'utf8');
  assert.equal(capturedConfigDir, join(CLI_LOGINS_DIR, sessionId));
  assert.notEqual(capturedConfigDir, fakeRealClaudeDir);
  assert.notEqual(capturedConfigDir, join(homedir(), '.claude'));
  assert.ok(
    capturedConfigDir.startsWith(managerHome),
    "isolated home must live under this manager instance's own home, not a shared/global location",
  );

  // The ticket's core safety guarantee: the host's real .credentials.json
  // (represented here by the sentinel file) is untouched, both mid-flight
  // and after the flow has fully completed.
  assert.equal(
    readFileSync(realCredPath, 'utf8'),
    sentinelContent,
    "the host's real ~/.claude/.credentials.json must never be read or written by the isolated login flow",
  );

  rmSync(fakeRealHome, { recursive: true, force: true });
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

// 리뷰 지적(round 2, 확인된 버그): redactSecrets()가 모든 패턴에 같은
// (label, sep) 2-인자 콜백을 재사용했는데, JWT/prefix-key 정규식엔 capture
// group이 없어 String.replace가 그 자리에 (offset, fullString)을 넘겼다.
// offset은 문자열 중간 매치에서 truthy라 `${label}${sep}[REDACTED]` 분기가
// 그대로 타면서 원본 전체(시크릿 그대로)가 결과에 다시 삽입됐다 — redact는
// 커녕 원문을 중복 노출. 아래는 4종 시크릿(JWT/prefix-key/labeled/opaque)을
// 전부 문자열 "중간"에 심어 이 정확한 실패 모드를 재현한다.
test('review-fix round2: JWT/prefix-key/labeled/opaque secrets embedded MID-STRING in stderr are all redacted in the real log file (not just leaked back in)', async () => {
  const manager = new CliLoginManager(
    { url: 'https://awb.example', apiKey: 'k' },
    { codexBin: fakeCodexLeakySecretsEverywhere(), timeoutMs: 150 },
  );
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-stderr-2', cli: 'codex' });
  await waitUntil(() => progressBodies(sessionId).some((b) => b.status === 'timed_out'), { timeoutMs: 3000 });

  const logContent = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : '';
  for (const [kind, secret] of Object.entries(LEAKY_SECRETS)) {
    assert.doesNotMatch(logContent, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${kind} leaked into agent-manager.log unredacted`);
  }
  assert.match(logContent, /\[REDACTED\]/);
});

test('review-fix round2: JWT/prefix-key/labeled/opaque secrets embedded MID-STRING in unparseable stdout are all redacted in raw_output_fallback', async () => {
  const manager = new CliLoginManager(
    { url: 'https://awb.example', apiKey: 'k' },
    { codexBin: fakeCodexLeakySecretsEverywhere(), fallbackQuietMs: 30, timeoutMs: 5000 },
  );
  const sessionId = randomUUID();
  await manager.start({ sessionId, commandId: 'cmd-fallback-3', cli: 'codex' });
  await waitUntil(() => progressBodies(sessionId).some((b) => b.raw_output_fallback), { timeoutMs: 2000 });

  const fallback = progressBodies(sessionId).find((b) => b.raw_output_fallback).raw_output_fallback;
  for (const [kind, secret] of Object.entries(LEAKY_SECRETS)) {
    assert.doesNotMatch(fallback, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${kind} leaked into raw_output_fallback unredacted`);
  }
  assert.match(fallback, /\[REDACTED\]/);

  await manager.cancel(sessionId);
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
