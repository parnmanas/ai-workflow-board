// Agent Session(CLI 직접 세션) 러너 — fake-acp-server.mjs 로 실제 ACP 왕복을 돌리며
// 서버 contract(rpc 응답 · events 중계 · state patch)를 고정한다(docs/agent-sessions.md).
//   1. list / history RPC 는 저장소(CLI 홈 파일)에서 읽어 응답한다.
//   2. open(신규) 은 session/new 로 네이티브 id 를 받아 인덱스에 기록하고 상태 ready.
//   3. prompt 는 스트림을 순서대로 중계하고, permission 은 사용자 결정으로 풀린다.
//   4. open(기존 id) 는 session/load 로 복원한다(cwd 는 기록에서).
//   5. 없는 cwd / 알 수 없는 CLI 는 RPC 오류로 응답한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentSessionRunner, detectAcpSessionClis, redactSecrets, resolveAcpCommandForCli } from '../dist/lib/agent-session-runner.js';
import { AgentSessionStore } from '../dist/lib/agent-session-store.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));
const MANAGER = 'manager-1';
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';

function installFakeServer() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: target, method, body, apiKey: init?.headers?.['X-Agent-Key'] });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
    rpc: (requestId) => calls.find((c) => c.url.endsWith(`/api/agent/sessions/rpc/${requestId}`))?.body ?? null,
    events: (sessionId) => calls
      .filter((c) => c.method === 'POST' && c.url.includes(`/api/agent/sessions/${MANAGER}/`) && c.url.endsWith(`/${sessionId}/events`))
      .flatMap((c) => c.body.events.map((e) => ({ ...e, state: c.body.state ?? null }))),
    states: (sessionId) => calls
      .filter((c) => c.url.includes(`/api/agent/sessions/${MANAGER}/`) && (c.url.endsWith(`/${sessionId}/events`) || c.url.endsWith(`/${sessionId}`)))
      .map((c) => (c.method === 'PATCH' ? c.body : c.body.state)).filter(Boolean),
  };
}

async function waitFor(predicate, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function request(op, extra = {}) {
  return { manager_id: MANAGER, cli: 'claude', op, driver_user_id: 'user-1', issued_at: new Date().toISOString(), ...extra };
}

async function harness(t, runnerOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'awb-agent-session-'));
  const cwd = join(root, 'work');
  await mkdir(cwd, { recursive: true });
  const claudeHome = join(root, 'claude');
  const projectDir = join(claudeHome, 'projects', '-work');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, `${CLAUDE_ID}.jsonl`), [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId: CLAUDE_ID, cwd, timestamp: '2026-09-17T00:00:00.000Z', message: { role: 'user', content: 'existing prompt' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: CLAUDE_ID, cwd, timestamp: '2026-09-17T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'existing answer' }] } }),
  ].join('\n') + '\n');
  const store = new AgentSessionStore({ claudeHome, codexHome: join(root, 'codex'), indexPath: join(root, 'index.json') });
  const server = installFakeServer();
  const runner = new AgentSessionRunner(
    { url: 'http://127.0.0.1:0', apiKey: 'manager-key' },
    {
      getManagerId: () => MANAGER,
      store,
      commandResolver: async () => ({ command: process.execPath, args: [fixture] }),
      flushIntervalMs: 10,
      idleMinutes: 0,
      permissionTimeoutMs: 5000,
      requestTimeoutMs: 10_000,
      promptTimeoutMs: 20_000,
      ...runnerOptions,
    },
  );
  t.after(async () => {
    await runner.stopAll('test');
    server.restore();
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, store, server, runner };
}

test('list / history RPCs answer from the CLI home store', async (t) => {
  const { cwd, server, runner } = await harness(t);
  await runner.handle(request('list', { request_id: 'rpc-list' }));
  const list = server.rpc('rpc-list');
  assert.equal(list.ok, true);
  assert.equal(list.manager_id, MANAGER);
  assert.deepEqual(list.result.sessions.map((s) => s.session_id), [CLAUDE_ID]);
  assert.equal(list.result.sessions[0].cwd, cwd);
  assert.equal(list.result.sessions[0].live_status, undefined, 'no live process yet');

  await runner.handle(request('history', { request_id: 'rpc-history', session_id: CLAUDE_ID }));
  const history = server.rpc('rpc-history');
  assert.equal(history.ok, true);
  assert.deepEqual(history.result.events.map((e) => e.type), ['user_prompt', 'text']);
  assert.equal(history.result.live, null);

  await runner.handle(request('history', { request_id: 'rpc-missing', session_id: 'missing-1' }));
  assert.equal(server.rpc('rpc-missing').ok, false);
  assert.equal(server.rpc('rpc-missing').code, 'not_found');
});

test('open(new) → prompt stream → permission relay → turn finished, and the session lands in the AWB index', async (t) => {
  const { cwd, store, server, runner } = await harness(t);
  await runner.handle(request('open', { request_id: 'rpc-open', session_id: null, cwd, title: 'Try things' }));
  const opened = server.rpc('rpc-open');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.result.session_id, 'session-1');
  assert.equal(opened.result.status, 'ready');
  assert.equal(opened.result.resume_supported, true);
  const sid = opened.result.session_id;
  await waitFor(() => server.events(sid).some((e) => e.type === 'system' && /Session opened/.test(e.payload.text)), 'opened row');
  assert.equal(server.events(sid)[0].state.status, 'ready');
  assert.equal(server.events(sid)[0].state.title, 'Try things');
  assert.equal(server.calls[0].apiKey, 'manager-key', 'relay uses the manager key');
  assert.equal((await store.listSessions('claude')).find((s) => s.session_id === sid)?.source, 'awb');

  const turn = runner.handle(request('prompt', { session_id: sid, turn_id: 't-1', text: 'hello there' }));
  await waitFor(() => server.events(sid).some((e) => e.type === 'permission_request'), 'permission_request row');
  const permission = server.events(sid).find((e) => e.type === 'permission_request');
  assert.equal(permission.state?.status, 'awaiting_permission');
  assert.deepEqual(server.events(sid).map((e) => e.type), ['system', 'turn', 'reasoning', 'text', 'tool_call', 'tool_update', 'permission_request']);
  assert.equal(server.events(sid).find((e) => e.type === 'text').payload.text, 'hello');
  assert.equal(server.events(sid).find((e) => e.type === 'turn').state.status, 'busy');
  assert.ok(server.events(sid).every((e, i) => e.seq === i + 1), 'seq is contiguous per session');

  await runner.handle(request('permission', { session_id: sid, permission_request_id: permission.payload.request_id, option_id: 'allow-once' }));
  await turn;
  await waitFor(() => server.events(sid).some((e) => e.type === 'turn' && e.payload.phase === 'finished'), 'turn(finished) row');
  const types = server.events(sid).map((e) => e.type);
  assert.equal(types[types.indexOf('permission_request') + 1], 'permission_decision', 'the runner records the user decision right after the request');
  const decision = server.events(sid).find((e) => e.type === 'permission_decision');
  assert.equal(decision.payload.decided_by, 'user');
  assert.equal(decision.payload.option_id, 'allow-once');
  const finished = server.events(sid).filter((e) => e.type === 'turn').at(-1);
  assert.equal(finished.payload.stop_reason, 'end_turn');
  assert.equal(finished.state.status, 'ready');
  assert.ok(types.includes('usage'));

  await runner.handle(request('list', { request_id: 'rpc-list-2' }));
  assert.equal(server.rpc('rpc-list-2').result.sessions.find((s) => s.session_id === sid).live_status, 'ready');

  await runner.handle(request('close', { session_id: sid }));
  assert.equal(runner._snapshot().length, 0);
  assert.equal(server.events(sid).at(-1).state.status, 'closed');
});

test('open(existing id) resumes via session/load using the cwd recorded in the CLI home', async (t) => {
  const { cwd, server, runner } = await harness(t);
  await runner.handle(request('open', { request_id: 'rpc-resume', session_id: CLAUDE_ID }));
  const resumed = server.rpc('rpc-resume');
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.result.session_id, CLAUDE_ID);
  assert.equal(resumed.result.cwd, cwd);
  await waitFor(() => server.events(CLAUDE_ID).some((e) => /Session resumed/.test(e.payload.text)), 'resumed row');
  assert.equal(server.events(CLAUDE_ID)[0].state.reason, 'resumed');
  // prompt on the resumed session reuses the live process
  const before = runner._snapshot()[0]?.pid;
  const turn = runner.handle(request('prompt', { session_id: CLAUDE_ID, turn_id: 't-2', text: 'continue' }));
  await waitFor(() => server.events(CLAUDE_ID).some((e) => e.type === 'permission_request'), 'permission');
  const permission = server.events(CLAUDE_ID).find((e) => e.type === 'permission_request');
  await runner.handle(request('permission', { session_id: CLAUDE_ID, permission_request_id: permission.payload.request_id, option_id: null }));
  await turn;
  assert.equal(runner._snapshot()[0]?.pid, before, 'same process');
  await waitFor(() => server.events(CLAUDE_ID).some((e) => e.type === 'turn' && e.payload.phase === 'finished'), 'finished');
  assert.equal(server.events(CLAUDE_ID).filter((e) => e.type === 'turn').at(-1).payload.stop_reason, 'refusal');
});

test('errors: unknown cwd for a new session and a missing session file fail as RPC errors, nothing spawned', async (t) => {
  const { server, runner } = await harness(t);
  await runner.handle(request('open', { request_id: 'rpc-bad-cwd', session_id: null, cwd: '/definitely/not/here' }));
  assert.equal(server.rpc('rpc-bad-cwd').ok, false);
  assert.match(server.rpc('rpc-bad-cwd').error, /does not exist/);
  await runner.handle(request('open', { request_id: 'rpc-no-file', session_id: 'unknown-session' }));
  assert.equal(server.rpc('rpc-no-file').ok, false);
  assert.match(server.rpc('rpc-no-file').error, /No working directory/);
  assert.equal(runner._snapshot().length, 0);
  // fire-and-forget prompt on an unknown session → error row + state error
  await runner.handle(request('prompt', { session_id: 'unknown-session', turn_id: 't', text: 'x' }));
  const err = server.events('unknown-session').find((e) => e.type === 'error');
  assert.ok(err, 'error row relayed');
  assert.equal(err.state?.status, 'error');
});

test('command resolution: env override, npx fallback, unknown cli; detectAcpSessionClis reads PATH', async (t) => {
  process.env.AWB_ACP_COMMAND_CODEX = 'node /tmp/codex-acp.js --x';
  try {
    assert.deepEqual(await resolveAcpCommandForCli('codex'), { command: 'node', args: ['/tmp/codex-acp.js', '--x'] });
  } finally {
    delete process.env.AWB_ACP_COMMAND_CODEX;
  }
  await assert.rejects(() => resolveAcpCommandForCli('pi'), /No ACP adapter/);
  const claude = await resolveAcpCommandForCli('claude');
  assert.ok(claude.command === 'npx' || /claude-agent-acp/.test(claude.command));

  const binDir = await mkdtemp(join(tmpdir(), 'awb-acp-bin-'));
  t.after(() => rm(binDir, { recursive: true, force: true }));
  await writeFile(join(binDir, 'codex-acp'), '#!/bin/sh\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    const clis = await detectAcpSessionClis({});
    assert.deepEqual(clis, ['codex']);
    assert.deepEqual(await detectAcpSessionClis({ AWB_ACP_COMMAND_CLAUDE: 'x' }), ['claude', 'codex']);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ─── CLI 설정 credential 적용 ───────────────────────────────────────────────
// credential 이 묶이면 운영자 홈 대신 세션 전용 cli-home 을 쓰되, 기록 디렉터리는
// 운영자 홈으로 링크해 기존 세션이 그대로 보이고 이어진다. 운영자 홈 파일은 불변.
import { lstat, readFile, readlink, stat as statFile } from 'node:fs/promises';

async function credentialHarness(t, provider, fields, cli = 'claude') {
  const base = await harness(t);
  const captureFile = join(base.root, 'capture.json');
  const sessionHomesDir = join(base.root, 'session-homes');
  const codexHome = join(base.root, 'codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const store = new AgentSessionStore({ claudeHome: join(base.root, 'claude'), codexHome, indexPath: join(base.root, 'index.json') });
  const fetches = [];
  const runner = new AgentSessionRunner(
    { url: 'http://127.0.0.1:0', apiKey: 'manager-key' },
    {
      getManagerId: () => MANAGER,
      store,
      sessionHomesDir,
      commandResolver: async () => ({ command: process.execPath, args: [fixture] }),
      // 운영자 셸의 API 키가 credential 을 덮지 않아야 한다 + 운영자 홈은 env 로 고정.
      // 운영자 환경의 CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY 등이 테스트에
      // 흘러들어오면 "credential 없는 operator-login" 케이스가 오염된다 — 명시적으로 덮는다.
      baseEnv: { ...process.env, FAKE_ACP_CAPTURE_FILE: captureFile, ANTHROPIC_API_KEY: 'operator-shell-key', OPENAI_API_KEY: 'operator-openai-key', CLAUDE_CONFIG_DIR: join(base.root, 'claude'), CODEX_HOME: codexHome, CLAUDE_CODE_OAUTH_TOKEN: undefined },
      credentialFetcher: async (id, ws) => {
        fetches.push({ id, ws });
        return provider ? { credential_id: id, provider, fields } : null;
      },
      flushIntervalMs: 10, idleMinutes: 0, permissionTimeoutMs: 5000, requestTimeoutMs: 10_000, promptTimeoutMs: 20_000,
    },
  );
  t.after(() => runner.stopAll('test'));
  const capture = async () => JSON.parse(await readFile(captureFile, 'utf8'));
  return { ...base, runner, sessionHomesDir, captureFile, capture, fetches, cli, server: base.server };
}

test('credential (claude_oauth_token): session cli-home + CLAUDE_CODE_OAUTH_TOKEN, operator key stripped, projects linked back', async (t) => {
  const h = await credentialHarness(t, 'claude_oauth_token', { oauth_token: 'sk-ant-oat-test' });
  await h.runner.handle({ ...request('open', { request_id: 'rpc-cred', session_id: null, cwd: h.cwd, workspace_id: 'ws-1', credential_id: 'cred-1' }) });
  const opened = h.server.rpc('rpc-cred');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.deepEqual(h.fetches, [{ id: 'cred-1', ws: 'ws-1' }]);
  const cap = await h.capture();
  const home = join(h.sessionHomesDir, 'claude', 'cred-1');
  assert.equal(cap.CLAUDE_CONFIG_DIR, home, 'session-specific cli-home');
  assert.equal(cap.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-test');
  assert.equal(cap.ANTHROPIC_API_KEY, null, 'operator shell key is stripped so it cannot shadow the credential');
  const link = join(home, 'projects');
  assert.ok((await lstat(link)).isSymbolicLink(), 'projects is a symlink');
  assert.equal(await readlink(link), join(h.root, 'claude', 'projects'), 'linked to the operator home so existing sessions stay visible');
  const trust = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
  assert.equal(trust.projects[h.cwd].hasTrustDialogAccepted, true, 'workspace trust seeded for headless use');
  await assert.rejects(statFile(join(home, '.credentials.json')), 'oauth token mode writes no credentials file');
});

test('credential (claude_subscription): .credentials.json lands in the session home only; operator home untouched', async (t) => {
  const h = await credentialHarness(t, 'claude_subscription', { credentials_json: '{"claudeAiOauth":{"accessToken":"x"}}' });
  await h.runner.handle(request('open', { request_id: 'rpc-sub', session_id: null, cwd: h.cwd, workspace_id: 'ws-1', credential_id: 'cred-2' }));
  assert.equal(h.server.rpc('rpc-sub').ok, true, JSON.stringify(h.server.rpc('rpc-sub')));
  const home = join(h.sessionHomesDir, 'claude', 'cred-2');
  assert.equal(await readFile(join(home, '.credentials.json'), 'utf8'), '{"claudeAiOauth":{"accessToken":"x"}}');
  const cap = await h.capture();
  assert.equal(cap.CLAUDE_CONFIG_DIR, home);
  assert.equal(cap.CLAUDE_CODE_OAUTH_TOKEN, null);
  await assert.rejects(statFile(join(h.root, 'claude', '.credentials.json')), 'operator home never receives the file');
});

test('credential (codex_subscription): auth.json in the session home with sessions linked back', async (t) => {
  const h = await credentialHarness(t, 'codex_subscription', { auth_json: '{"tokens":{"access_token":"a"}}', config_toml: '' }, 'codex');
  await h.runner.handle({ ...request('open', { request_id: 'rpc-codex', session_id: null, cwd: h.cwd, workspace_id: 'ws-1', credential_id: 'cred-3' }), cli: 'codex' });
  const opened = h.server.rpc('rpc-codex');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const home = join(h.sessionHomesDir, 'codex', 'cred-3');
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), '{"tokens":{"access_token":"a"}}');
  const cap = await h.capture();
  assert.equal(cap.CODEX_HOME, home);
  assert.equal(cap.OPENAI_API_KEY, null, 'operator OPENAI_API_KEY stripped');
  assert.ok((await lstat(join(home, 'sessions'))).isSymbolicLink());
});

test('credential errors: provider mismatch, unsupported cli, and missing material fail the open RPC without spawning', async (t) => {
  const mismatch = await credentialHarness(t, 'codex_api_key', { api_key: 'k' });
  await mismatch.runner.handle(request('open', { request_id: 'rpc-mismatch', session_id: null, cwd: mismatch.cwd, workspace_id: 'ws-1', credential_id: 'cred-x' }));
  assert.equal(mismatch.server.rpc('rpc-mismatch').ok, false);
  assert.equal(mismatch.server.rpc('rpc-mismatch').code, 'credential_provider_mismatch');
  assert.equal(mismatch.runner._snapshot().length, 0);

  const hermes = await credentialHarness(t, 'claude_api_key', { api_key: 'k' });
  await hermes.runner.handle({ ...request('open', { request_id: 'rpc-hermes', session_id: null, cwd: hermes.cwd, workspace_id: 'ws-1', credential_id: 'cred-h' }), cli: 'hermes' });
  assert.equal(hermes.server.rpc('rpc-hermes').code, 'credential_unsupported');

  const missing = await credentialHarness(t, null, {});
  await missing.runner.handle(request('open', { request_id: 'rpc-missing-cred', session_id: null, cwd: missing.cwd, workspace_id: 'ws-1', credential_id: 'cred-gone' }));
  assert.equal(missing.server.rpc('rpc-missing-cred').code, 'credential_unavailable');
});

test('no credential bound → operator login: env untouched, no session home created', async (t) => {
  const h = await credentialHarness(t, 'claude_api_key', { api_key: 'unused' });
  await h.runner.handle(request('open', { request_id: 'rpc-plain', session_id: null, cwd: h.cwd, workspace_id: 'ws-1' }));
  assert.equal(h.server.rpc('rpc-plain').ok, true);
  assert.deepEqual(h.fetches, [], 'credential is never fetched without a binding');
  const cap = await h.capture();
  assert.equal(cap.CLAUDE_CONFIG_DIR, join(h.root, 'claude'), 'operator home stays the CLI home');
  assert.equal(cap.ANTHROPIC_API_KEY, 'operator-shell-key');
  await assert.rejects(statFile(join(h.sessionHomesDir, 'claude')), 'no session home');
});

test('binding a credential after the session is live reopens the process with the credential on the next prompt', async (t) => {
  const h = await credentialHarness(t, 'claude_oauth_token', { oauth_token: 'sk-ant-oat-late' });
  await h.runner.handle(request('open', { request_id: 'rpc-first', session_id: null, cwd: h.cwd, workspace_id: 'ws-1' }));
  const first = h.server.rpc('rpc-first');
  assert.equal(first.ok, true);
  const sid = first.result.session_id;
  assert.equal((await h.capture()).CLAUDE_CODE_OAUTH_TOKEN, null, 'opened with the operator login');
  const pidBefore = h.runner._snapshot()[0]?.pid;

  // the operator binds a credential in CLI settings, then prompts again
  const turn = h.runner.handle(request('prompt', { session_id: sid, turn_id: 't-late', text: 'hi', workspace_id: 'ws-1', credential_id: 'cred-late' }));
  await waitFor(() => h.server.events(sid).some((e) => e.type === 'permission_request'), 'permission after reopen');
  const permission = h.server.events(sid).find((e) => e.type === 'permission_request');
  await h.runner.handle(request('permission', { session_id: sid, permission_request_id: permission.payload.request_id, option_id: 'allow-once' }));
  await turn;
  assert.notEqual(h.runner._snapshot()[0]?.pid, pidBefore, 'a new adapter process was started');
  assert.equal((await h.capture()).CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-late', 'the new process carries the credential');
  assert.ok(h.server.events(sid).some((e) => e.type === 'system' && /CLI settings changed/.test(e.payload.text)), 'the transcript explains the reopen');
  assert.deepEqual(h.fetches, [{ id: 'cred-late', ws: 'ws-1' }]);
});

test('credential whitespace is repaired before use (a token pasted with a line wrap still works) and incomplete credentials are refused', async (t) => {
  const wrapped = await credentialHarness(t, 'claude_oauth_token', { oauth_token: 'sk-ant-oat-first-half\n second-half' });
  await wrapped.runner.handle(request('open', { request_id: 'rpc-wrap', session_id: null, cwd: wrapped.cwd, workspace_id: 'ws-1', credential_id: 'cred-wrap' }));
  assert.equal(wrapped.server.rpc('rpc-wrap').ok, true, JSON.stringify(wrapped.server.rpc('rpc-wrap')));
  assert.equal((await wrapped.capture()).CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-first-halfsecond-half', 'interior whitespace stripped');

  const empty = await credentialHarness(t, 'claude_oauth_token', { oauth_token: '   ' });
  await empty.runner.handle(request('open', { request_id: 'rpc-empty', session_id: null, cwd: empty.cwd, workspace_id: 'ws-1', credential_id: 'cred-empty' }));
  assert.equal(empty.server.rpc('rpc-empty').ok, false);
  assert.equal(empty.server.rpc('rpc-empty').code, 'credential_incomplete');
  assert.equal(empty.runner._snapshot().length, 0);
});

test('redactSecrets hides bearer tokens and API keys quoted by CLI error messages', () => {
  const msg = 'API Error: Headers.append: "Bearer sk-ant-oat01-AAAAbbbbCCCCdddd1234\n more" is an invalid header value; api_key="sk-live-abcdefghijklmnopqrstuvwxyz"';
  const out = redactSecrets(msg);
  assert.doesNotMatch(out, /oat01-AAAA/);
  assert.doesNotMatch(out, /sk-live-abcdefghijklmnop/);
  assert.match(out, /Bearer <redacted>/);
  assert.match(out, /api_key="<redacted>"/);
  assert.equal(redactSecrets('plain message'), 'plain message');
});
