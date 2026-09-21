// Agent Session(CLI 직접 세션) 러너 — fake-acp-server.mjs 로 실제 ACP 왕복을 돌리며
// 서버 contract(rpc 응답 · events 중계 · state patch)를 고정한다(docs/agent-sessions.md).
//   1. list / history RPC 는 저장소(CLI 홈 파일)에서 읽어 응답한다.
//   2. open(신규) 은 session/new 로 네이티브 id 를 받아 인덱스에 기록하고 상태 ready.
//   3. prompt 는 스트림을 순서대로 중계하고, permission 은 사용자 결정으로 풀린다.
//   4. open(기존 id) 는 session/load 로 복원한다(cwd 는 기록에서).
//   5. 없는 cwd / 알 수 없는 CLI 는 RPC 오류로 응답한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

/** `root` 아래를 cwd 로 물고 있는 살아 있는 프로세스의 pid. Linux 에서만 답할 수
 *  있다(/proc). Windows 에서는 그런 프로세스가 있으면 rmdir 이 EBUSY 로 실패하므로
 *  rm 자체가 검출기다 — 이 함수는 그 **Windows 전용 결함을 ubuntu 축에서도 빨갛게**
 *  만들려고 있다(ticket 445453a7). 러너를 어떻게 만들었든 상관없이 OS 에 직접 묻기
 *  때문에, 하네스가 정리 등록을 빠뜨려도 그대로 잡힌다.
 *  (죽은 직후 zombie 는 cwd 링크를 읽을 수 없어 자연히 제외된다.) */
async function pidsHoldingCwd(root) {
  let entries;
  try {
    entries = await readdir('/proc');
  } catch {
    return []; // /proc 이 없는 축 — 여기서는 검출할 수 없다.
  }
  const holders = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cwd = await readlink(`/proc/${entry}/cwd`);
      if (cwd === root || cwd.startsWith(`${root}/`)) holders.push(entry);
    } catch {
      /* 이미 사라졌거나 읽을 권한이 없는 프로세스 */
    }
  }
  return holders;
}

async function harness(t, runnerOptions = {}, adapterEnv = {}) {
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
      // 어댑터 프로세스의 env — 픽스처가 MCP handshake 결과 같은 시나리오를 바꾸는 스위치로 읽는다.
      ...(Object.keys(adapterEnv).length ? { baseEnv: { ...process.env, ...adapterEnv } } : {}),
      flushIntervalMs: 10,
      idleMinutes: 0,
      permissionTimeoutMs: 5000,
      requestTimeoutMs: 10_000,
      promptTimeoutMs: 20_000,
      ...runnerOptions,
    },
  );
  // root 를 cwd 로 물고 있는 러너를 모두 여기 모은다. node:test 의 t.after 는
  // 등록 순서(FIFO)로 돌기 때문에, 중첩 하네스가 자기 러너를 별도 t.after 로 걸면
  // **여기 있는 rm(root) 이 먼저** 돌아 자식이 cwd 를 문 채로 삭제된다. Windows 는
  // 프로세스의 cwd 가 디렉터리 핸들을 잡으므로 그 rmdir 이 EBUSY 로 실패한다
  // (POSIX 는 열린 cwd 여도 unlink 가 성공해 조용히 지나간다 — ticket 445453a7).
  const rootHolders = [runner];
  t.after(async () => {
    for (const holder of [...rootHolders].reverse()) await holder.stopAll('test').catch(() => undefined);
    // 진단은 rm 전에 걷고, **단언은 정리를 다 끝낸 뒤에** 한다. 훅 도중에 던지면
    // 남은 정리(server.restore · rm · 아직 안 멈춘 러너)가 통째로 건너뛰어져,
    // 살아남은 자식 때문에 테스트 러너가 종료하지 못하고 hang 처럼 보인다.
    const leaked = rootHolders.flatMap((holder) => holder._snapshot());
    const holding = await pidsHoldingCwd(root);
    // 진단만 하고 두면 그 프로세스가 러너의 이벤트 루프를 붙잡아, 실패가 읽을 수
    // 있는 단언이 아니라 hang 으로 나타난다(실측: 149s 뒤 timeout). 정리까지 여기서
    // 끝내고 단언은 그 뒤에 한다 — root 는 이 하네스만 쓰는 mkdtemp 라 이 pid 들은
    // 정의상 우리가 띄운 자식이다.
    for (const pid of holding) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* 이미 사라졌다 */ }
    }
    server.restore();
    const rmError = await rm(root, { recursive: true, force: true }).then(() => null, (err) => err);

    // 좁은 진단부터 넓은 진단 순으로 단언한다.
    assert.deepEqual(leaked, [], `rm(root) 전에 살아 있는 세션이 남았다: ${JSON.stringify(leaked)}`);
    // 위 단언은 **등록된** 러너만 본다 — 등록을 빠뜨린 하네스는 그냥 통과한다.
    // 그래서 등록과 무관하게 OS 에 직접 묻는 이 검사가 실제 게이트다.
    assert.deepEqual(holding, [], `rm(root) 전에 root 를 cwd 로 쥔 프로세스가 남았다 (pid ${holding.join(', ')})`);
    // Windows 는 위 두 단언이 못 보는 잠금까지 여기서 드러난다(EBUSY).
    assert.equal(rmError, null, `임시 root 를 지우지 못했다: ${rmError?.message ?? ''}`);
  });
  // 이 root 를 공유하는 러너를 추가로 등록한다 — 자기 t.after 를 따로 걸지 말 것.
  const holdsRoot = (extra) => { rootHolders.push(extra); };
  return { root, cwd, store, server, runner, holdsRoot };
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
import { lstat, readFile, stat as statFile } from 'node:fs/promises';

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
  base.holdsRoot(runner);
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
  // 세션 홈의 config.toml 은 awb MCP 서버를 `bearer_token_env_var = "AWB_API_KEY"` + `required = true`
  // 로 적는다 — 이 값이 없으면 codex 가 세션 초기화를 중단하고 재개가 통째로 실패한다(실측: ralf).
  assert.equal(cap.AWB_API_KEY, 'manager-key', 'the manager key the config references is in the session env');
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

// ─── 미결 permission 의 재전송과 취소 중계 ─────────────────────────────────────
//
// permission_request 는 CLI 홈 파일에 남지 않고 SSE 로만 흘렀다. 다른 화면에 있다가 들어온
// 사용자는 history 만 받으므로 상태는 "승인 대기" 인데 카드가 없었고, 프로세스가 죽거나
// close 되면 결정 행이 없어 카드가 영원히 대기 중으로 남았다.
test('history RPC replays pending permission requests with live status; a process dying mid-turn relays a system-cancelled decision and idle', async (t) => {
  const { cwd, server, runner } = await harness(t);
  await runner.handle(request('open', { request_id: 'rpc-open-p', session_id: null, cwd, title: 'Pending' }));
  const sid = server.rpc('rpc-open-p').result.session_id;
  const turn = runner.handle(request('prompt', { session_id: sid, turn_id: 't-p', text: 'hello' }));
  await waitFor(() => server.events(sid).some((e) => e.type === 'permission_request'), 'permission_request row');
  const asked = server.events(sid).find((e) => e.type === 'permission_request');

  // 화면을 새로 연 사용자가 history 로 다시 읽으면 미결 요청이 기록 끝에 **같은 id** 로 실려 온다
  await runner.handle(request('history', { request_id: 'rpc-history-p', session_id: sid }));
  const history = server.rpc('rpc-history-p');
  assert.equal(history.ok, true, JSON.stringify(history));
  const replayed = history.result.events.filter((e) => e.type === 'permission_request');
  assert.equal(replayed.length, 1, 'the pending permission is replayed exactly once');
  assert.equal(replayed[0].id, asked.id, 'same id as the live row so the UI dedupes it');
  assert.equal(replayed[0].payload.request_id, asked.payload.request_id);
  assert.equal(history.result.live.status, 'awaiting_permission');
  assert.ok(history.result.events.every((e, i) => e.seq === i + 1), 'history seq stays contiguous after the replay');

  // 프로세스가 턴 중에 죽으면(systemd 는 SIGTERM 을 cgroup 전체에 보낸다) 미결 요청은 system 취소로, 상태는 idle 로 중계된다
  const pid = runner._snapshot()[0].pid;
  process.kill(pid, 'SIGTERM');
  await turn;
  await waitFor(() => server.states(sid).some((s) => s.status === 'idle' && s.reason === 'process_exit'), 'idle after exit');
  const decision = server.events(sid).find((e) => e.type === 'permission_decision');
  assert.ok(decision, 'a decision row is relayed for the orphaned request');
  assert.equal(decision.payload.request_id, asked.payload.request_id);
  assert.equal(decision.payload.outcome, 'cancelled');
  assert.equal(decision.payload.decided_by, 'system');
  assert.equal(runner._snapshot().length, 0);
  assert.equal(server.states(sid).at(-1).status, 'idle', 'the last state the server hears is idle, never busy/awaiting_permission');

  // 기록에는 더 이상 미결 요청이 없고 live 는 null — stopAll 은 이미 죽은 세션의 마지막 전송을 기다려 준다
  await runner.stopAll('test');
  await runner.handle(request('history', { request_id: 'rpc-history-p2', session_id: sid }));
  const after = server.rpc('rpc-history-p2');
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(after.result.events.some((e) => e.type === 'permission_request'), false);
  assert.equal(after.result.live, null);
});

test('close while a permission is pending relays a system-cancelled decision and ends in the closed state', async (t) => {
  const { cwd, server, runner } = await harness(t);
  await runner.handle(request('open', { request_id: 'rpc-open-c', session_id: null, cwd }));
  const sid = server.rpc('rpc-open-c').result.session_id;
  const turn = runner.handle(request('prompt', { session_id: sid, turn_id: 't-c', text: 'hello' }));
  await waitFor(() => server.events(sid).some((e) => e.type === 'permission_request'), 'permission_request row');
  const asked = server.events(sid).find((e) => e.type === 'permission_request');
  await runner.handle(request('close', { session_id: sid }));
  await turn;
  const types = server.events(sid).map((e) => e.type);
  const decisionIdx = types.indexOf('permission_decision');
  assert.ok(decisionIdx > types.indexOf('permission_request'), 'the decision follows the request');
  const decision = server.events(sid)[decisionIdx];
  assert.equal(decision.payload.request_id, asked.payload.request_id);
  assert.equal(decision.payload.outcome, 'cancelled');
  assert.equal(decision.payload.decided_by, 'system');
  assert.equal(server.states(sid).at(-1).status, 'closed');
  assert.equal(runner._snapshot().length, 0);
});

// Windows 회귀 가드 (ralf): 어댑터가 npm 배치 shim 이거나 `npx` 폴백이면 node 의 spawn() 은
// `spawn npx ENOENT` / `spawn EINVAL` 로 죽는다. ACP 어댑터는 반드시 cross-spawn 으로 띄운다.
test('ACP adapters are spawned through cross-spawn so Windows .cmd shims and the npx fallback resolve', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/lib/runtime/acp/acp-client.ts', import.meta.url), 'utf8');
  assert.match(source, /from 'cross-spawn'/, 'acp-client imports cross-spawn');
  assert.doesNotMatch(source, /import \{[^}]*\bspawn\b[^}]*\} from 'node:child_process'/, 'acp-client no longer spawns with node:child_process directly');
});

// ─── 세션 설정(모델 등) · slash command · plan · 질문/폼(elicitation) ────────────────
//
// ACP 가 이미 제공하는 상호작용을 러너가 서버 contract 로 옮긴다: `session/new` 의 configOptions 와
// `config_option_update` → 상태 config_options, `available_commands_update` → available_commands,
// `plan` → plan 행, `elicitation/create` → elicitation_request 행 + awaiting_input, 답은 `elicitation` op.
test('config options / slash commands / plan / elicitation flow through the runner and history carries the live state', async (t) => {
  const { cwd, server, runner } = await harness(t);
  await runner.handle(request('open', { request_id: 'rpc-open-x', session_id: null, cwd, title: 'Interactive' }));
  const opened = server.rpc('rpc-open-x');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const sid = opened.result.session_id;
  assert.deepEqual(opened.result.config_options.map((o) => [o.config_id, o.type, o.current_value]), [['model', 'select', 'fake-fast'], ['fast_mode', 'boolean', false], ['mode', 'select', 'agent']], 'session/new configOptions (SDK 1.x `id` key) land in the open result');
  assert.deepEqual(opened.result.config_options[0].options.map((o) => o.value), ['fake-fast', 'fake-smart']);
  await waitFor(() => server.states(sid).some((s) => Array.isArray(s.available_commands) && s.available_commands.length === 2), 'available_commands patch');
  assert.equal(server.events(sid).some((e) => e.payload?.tool_call_id === 'mcp_startup.awb'), false, "the adapter's MCP handshake is not agent work — a successful one leaves no card");
  const commands = server.states(sid).find((s) => Array.isArray(s.available_commands) && s.available_commands.length === 2).available_commands;
  assert.deepEqual(commands, [{ name: 'review', description: 'Review the working tree', input_hint: 'optional focus' }, { name: 'compact', description: 'Compact the context' }]);

  // 모델 변경 — session/set_config_option 왕복, 전체 목록으로 갱신, system 행
  await runner.handle(request('set_config_option', { session_id: sid, config_id: 'model', config_value: 'fake-smart' }));
  await waitFor(() => server.states(sid).some((s) => s.reason === 'config_option'), 'config_option patch');
  const patched = server.states(sid).filter((s) => s.reason === 'config_option').at(-1);
  assert.equal(patched.config_options.find((o) => o.config_id === 'model').current_value, 'fake-smart');
  assert.ok(server.events(sid).some((e) => e.type === 'system' && e.payload.text === 'Model set to Fake Smart.'), 'system row names the chosen option');
  await runner.handle(request('set_config_option', { session_id: sid, config_id: 'fast_mode', config_value: true }));
  await waitFor(() => server.events(sid).some((e) => e.type === 'system' && e.payload.text === 'Fast mode set to on.'), 'boolean option row');
  // approval 모드가 config option(category mode) 이면 legacy current_mode 도 같이 맞춘다
  await runner.handle(request('set_config_option', { session_id: sid, config_id: 'mode', config_value: 'read-only' }));
  await waitFor(() => server.states(sid).some((s) => s.current_mode === 'read-only'), 'current_mode follows the mode config option');

  // history 의 live 가 설정·명령·모드를 실어 보낸다(서버 재시작 뒤에도 화면이 복원된다)
  await runner.handle(request('history', { request_id: 'rpc-history-x', session_id: sid }));
  const history = server.rpc('rpc-history-x');
  assert.equal(history.ok, true, JSON.stringify(history));
  assert.equal(history.result.live.config_options.find((o) => o.config_id === 'model').current_value, 'fake-smart');
  assert.equal(history.result.live.config_options.find((o) => o.config_id === 'fast_mode').current_value, true);
  assert.deepEqual(history.result.live.available_commands.map((c) => c.name), ['review', 'compact']);

  // 질문/폼: plan 행 → elicitation_request 행 + awaiting_input → history 재전송 → 답 → 턴 종료
  const turn = runner.handle(request('prompt', { session_id: sid, turn_id: 't-x', text: 'ELICIT_TEST deploy please' }));
  await waitFor(() => server.events(sid).some((e) => e.type === 'elicitation_request'), 'elicitation_request row');
  const asked = server.events(sid).find((e) => e.type === 'elicitation_request');
  assert.equal(asked.state?.status, 'awaiting_input');
  assert.equal(asked.payload.mode, 'form');
  assert.equal(asked.payload.message, 'Which environment should I deploy to?');
  assert.deepEqual(asked.payload.schema.required, ['env']);
  assert.deepEqual(asked.payload.schema.properties.env.enum, ['dev', 'prod']);
  const plan = server.events(sid).find((e) => e.type === 'plan');
  assert.ok(plan, 'plan row relayed before the question');
  assert.deepEqual(plan.payload.entries.map((e) => e.status), ['in_progress', 'pending']);
  await runner.handle(request('history', { request_id: 'rpc-history-x2', session_id: sid }));
  const replay = server.rpc('rpc-history-x2');
  assert.equal(replay.result.live.status, 'awaiting_input');
  assert.equal(replay.result.events.filter((e) => e.type === 'elicitation_request').length, 1, 'the pending question is replayed for a reloaded screen');
  assert.equal(replay.result.events.find((e) => e.type === 'elicitation_request').id, asked.id);

  await runner.handle(request('elicitation', { session_id: sid, elicitation_id: asked.payload.elicitation_id, elicitation_action: 'accept', elicitation_content: { env: 'prod' } }));
  await turn;
  await waitFor(() => server.events(sid).some((e) => e.type === 'turn' && e.payload.phase === 'finished'), 'turn finished');
  const decision = server.events(sid).find((e) => e.type === 'elicitation_decision');
  assert.equal(decision.payload.action, 'accept');
  assert.equal(decision.payload.decided_by, 'user');
  assert.deepEqual(decision.payload.content, { env: 'prod' });
  assert.equal(decision.state?.status, 'busy', 'answering puts the session back to busy until the turn ends');
  assert.ok(server.events(sid).some((e) => e.type === 'text' && e.payload.text.includes('Deploying to prod')), 'the agent received the answer');
  const plans = server.events(sid).filter((e) => e.type === 'plan');
  assert.equal(plans.at(-1).payload.entries[0].status, 'completed', 'the updated plan is relayed as another plan row (UI folds it)');
  assert.equal(server.events(sid).filter((e) => e.type === 'turn').at(-1).payload.stop_reason, 'end_turn');
  assert.equal(server.states(sid).at(-1).status, 'ready');
});

test('closing a session while a question is pending cancels it with a system decision', async (t) => {
  const { cwd, server, runner } = await harness(t);
  await runner.handle(request('open', { request_id: 'rpc-open-y', session_id: null, cwd }));
  const sid = server.rpc('rpc-open-y').result.session_id;
  const turn = runner.handle(request('prompt', { session_id: sid, turn_id: 't-y', text: 'ELICIT_TEST' }));
  await waitFor(() => server.events(sid).some((e) => e.type === 'elicitation_request'), 'elicitation_request row');
  await runner.handle(request('close', { session_id: sid }));
  await turn;
  const decision = server.events(sid).find((e) => e.type === 'elicitation_decision');
  assert.ok(decision, 'decision row relayed');
  assert.equal(decision.payload.action, 'cancel');
  assert.equal(decision.payload.decided_by, 'system');
  assert.equal(server.states(sid).at(-1).status, 'closed');
  assert.equal(runner._snapshot().length, 0);
});

// codex-acp 는 MCP 서버 연결을 `mcp_startup.<server>` 라는 update 없는 한 번짜리 tool_call 로 알리고,
// 그것도 session/new 응답보다 먼저 보낸다. 예전엔 (1) 상태를 버리고 중계해 카드가 영원히 "running" 으로
// 남거나, (2) 세션 id 를 모르는 시점이라 조용히 버려지면서 seq 만 올려 이후 행이 한 칸씩 어긋났다.
test('the adapter MCP handshake never becomes a running card, and it never eats a seq number', async (t) => {
  const { cwd, server, runner } = await harness(t);
  await runner.handle(request('open', { request_id: 'rpc-open-mcp', session_id: null, cwd }));
  const sid = server.rpc('rpc-open-mcp').result.session_id;
  const events = server.events(sid);
  assert.equal(events.some((e) => e.payload?.tool_call_id === 'mcp_startup.awb'), false, 'a successful handshake is silent');
  assert.equal(events[0].seq, 1, 'the first relayed row still starts at seq 1 — the dropped notification consumed nothing');
  assert.ok(events.every((e, i) => e.seq === i + 1), 'seq stays contiguous');
});

test('a FAILED MCP handshake is surfaced as a system note, not as a stuck tool card', async (t) => {
  const { cwd, server, runner } = await harness(t, {}, { FAKE_ACP_MCP_STARTUP_STATUS: 'failed' });
  await runner.handle(request('open', { request_id: 'rpc-open-mcp-fail', session_id: null, cwd }));
  const sid = server.rpc('rpc-open-mcp-fail').result.session_id;
  const note = server.events(sid).find((e) => e.type === 'system' && /MCP server/.test(e.payload.text));
  assert.ok(note, 'the operator is told which server failed');
  assert.match(note.payload.text, /"awb" did not connect/);
  assert.equal(server.events(sid).some((e) => e.payload?.tool_call_id === 'mcp_startup.awb'), false, 'still no tool card');
});

test('set_config_option / set_mode on a session that is not live open it first (choose the model before the first prompt)', async (t) => {
  const { cwd, server, runner } = await harness(t);
  assert.equal(runner._snapshot().length, 0, 'nothing live yet');
  await runner.handle(request('set_config_option', { session_id: CLAUDE_ID, config_id: 'model', config_value: 'fake-smart' }));
  assert.equal(runner._snapshot().length, 1, 'the existing CLI session was opened via session/load');
  await waitFor(() => server.states(CLAUDE_ID).some((s) => s.reason === 'config_option'), 'config_option patch');
  assert.ok(server.events(CLAUDE_ID).some((e) => /Session resumed/.test(e.payload.text)), 'opened with the cwd recorded in the CLI home');
  assert.equal(server.states(CLAUDE_ID).filter((s) => s.reason === 'config_option').at(-1).config_options.find((o) => o.config_id === 'model').current_value, 'fake-smart');
  await runner.handle(request('set_mode', { session_id: CLAUDE_ID, mode_id: 'plan' }));
  await waitFor(() => server.states(CLAUDE_ID).some((s) => s.reason === 'mode' && s.current_mode === 'plan'), 'mode patch');
  assert.equal(runner._snapshot().length, 1, 'same process reused for set_mode');
  await runner.handle(request('close', { session_id: CLAUDE_ID }));
  assert.equal(runner._snapshot().length, 0);
});

// 거대한 한 줄이 세션을 죽이던 사고: "ACP stdout line exceeds the configured byte limit" 뒤
// 프로세스가 SIGTERM 으로 내려가 턴이 error 로 끝났다. 개행이 재동기화 지점이므로 그 줄만
// 버리면 나머지 스트림과 턴은 그대로 살아 있어야 한다.
test('an oversized adapter message drops that message only — the turn finishes and the session stays live', async (t) => {
  const { cwd, server, runner } = await harness(t, { maxLineBytes: 2048 });
  await runner.handle(request('open', { request_id: 'rpc-open-big', session_id: null, cwd }));
  const sid = server.rpc('rpc-open-big').result.session_id;
  await runner.handle(request('prompt', { session_id: sid, turn_id: 't-big', text: 'OVERSIZED_TEST please' }));

  const events = server.events(sid);
  const note = events.find((e) => e.type === 'system' && /larger than this session can relay/.test(e.payload.text));
  assert.ok(note, 'the user is told one message was dropped');
  assert.match(note.payload.text, /still running/);
  assert.ok(events.some((e) => e.type === 'text' && e.payload.text === 'still here'), 'the stream resynchronizes — the next message is relayed');
  const finished = events.filter((e) => e.type === 'turn').at(-1);
  assert.equal(finished.payload.phase, 'finished');
  assert.equal(finished.payload.stop_reason, 'end_turn', 'the turn ends normally instead of dying');
  assert.equal(finished.state.status, 'ready');
  assert.deepEqual(runner.liveStates().map((s) => s.status), ['ready'], 'the session process survives');
  assert.equal(events.some((e) => e.type === 'error'), false, 'no protocol error is surfaced');
});

// ─── 기억된 설정(approval 모드·모델)을 열 때마다 다시 건다 ─────────────────────
//
// 어댑터 프로세스는 매번 자기 기본값으로 시작한다 — 유휴로 회수되거나 다른 세션에 갔다 오면
// 사용자의 선택이 사라졌다. 서버가 호스트×CLI 로 기억해 둔 값을 open payload 에 실어 보내고,
// 러너가 세션을 연 직후 다시 건다.
test('config_defaults are re-applied when the session opens, and values that no longer exist are ignored', async (t) => {
  const { cwd, server, runner } = await harness(t);
  await runner.handle(request('open', {
    request_id: 'rpc-open-def', session_id: null, cwd,
    config_defaults: { model: 'fake-smart', mode: 'read-only', fast_mode: true, gone: 'nope', fake_fast: 'wrong-type' },
  }));
  const opened = server.rpc('rpc-open-def');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const sid = opened.result.session_id;
  await waitFor(() => server.states(sid).filter((s) => s.reason === 'config_option').length >= 3, 'defaults applied');
  const latest = server.states(sid).filter((s) => s.config_options).at(-1).config_options;
  assert.equal(latest.find((o) => o.config_id === 'model').current_value, 'fake-smart', 'the remembered model is restored');
  assert.equal(latest.find((o) => o.config_id === 'mode').current_value, 'read-only', 'the remembered approval mode is restored');
  assert.equal(latest.find((o) => o.config_id === 'fast_mode').current_value, true, 'boolean options too');
  assert.equal(latest.some((o) => o.config_id === 'gone'), false, 'an option the adapter no longer offers is skipped, not an error');
  await runner.handle(request('close', { session_id: sid }));
});

test('re-applying skips options already at the wanted value, and a resumed session gets them too', async (t) => {
  const { cwd, server, runner } = await harness(t);
  // fake 의 기본값은 model=fake-fast — 같은 값을 주면 왕복도 system 행도 없어야 한다
  await runner.handle(request('open', { request_id: 'rpc-open-same', session_id: null, cwd, config_defaults: { model: 'fake-fast' } }));
  const sid = server.rpc('rpc-open-same').result.session_id;
  assert.equal(server.events(sid).some((e) => e.type === 'system' && /Model set to/.test(e.payload.text)), false, 'no needless round trip when it already matches');
  await runner.handle(request('close', { session_id: sid }));

  // 기존 CLI 세션을 이어 열 때(session/load)도 같은 복원이 걸린다
  await runner.handle(request('open', { request_id: 'rpc-open-resume-def', session_id: CLAUDE_ID, config_defaults: { model: 'fake-smart' } }));
  assert.equal(server.rpc('rpc-open-resume-def').ok, true);
  await waitFor(() => server.events(CLAUDE_ID).some((e) => e.type === 'system' && e.payload.text === 'Model set to Fake Smart.'), 'restored on resume');
  await runner.handle(request('close', { session_id: CLAUDE_ID }));
});

// ─── 이 세션이 어떤 계정으로 도는가 ──────────────────────────────────────────────
//
// 어댑터가 `_auth/status_update` 로 자기 로그인 신원을 민다(claude-agent-acp · codex-acp 공통 확장).
// 매니저는 거기에 **출처**(워크스페이스 Credential 인지 장비 운영자 로그인인지 — 어댑터는 모르는 사실)를
// 더해 상태로 올리고, history 의 live 에도 실어 화면이 다시 들어와도 볼 수 있게 한다.
test('the adapter-reported account is relayed with the credential source the manager knows', async (t) => {
  const { cwd, server, runner } = await harness(t);
  await runner.handle(request('open', { request_id: 'rpc-open-auth', session_id: null, cwd }));
  const sid = server.rpc('rpc-open-auth').result.session_id;
  await waitFor(() => server.states(sid).some((s) => s.auth), 'auth patch');
  const auth = server.states(sid).filter((s) => s.auth).at(-1).auth;
  assert.deepEqual(auth, {
    source: 'operator',
    kind: 'account',
    label: 'Fake Max',
    account: { email: 'probe@example.com', organization: 'Fake Org', plan: 'max' },
  }, 'no credential bound → the host own login, with the identity the adapter reported');

  await runner.handle(request('history', { request_id: 'rpc-history-auth', session_id: sid }));
  assert.deepEqual(server.rpc('rpc-history-auth').result.live.auth, auth, 'history carries it so a reopened screen shows the account');
  await runner.handle(request('close', { session_id: sid }));
});

test('a session opened with a workspace credential reports source=credential', async (t) => {
  const { cwd, server, runner } = await harness(t, {
    credentialFetcher: async () => ({ credential_id: 'cred-auth', provider: 'claude_oauth_token', fields: { oauth_token: 'sk-ant-oat-xxxxxxxxxxxx' } }),
  });
  await runner.handle(request('open', { request_id: 'rpc-open-cred-auth', session_id: null, cwd, credential_id: 'cred-auth', workspace_id: 'ws-1' }));
  const sid = server.rpc('rpc-open-cred-auth').result.session_id;
  await waitFor(() => server.states(sid).some((s) => s.auth), 'auth patch');
  assert.equal(server.states(sid).filter((s) => s.auth).at(-1).auth.source, 'credential');
  await runner.handle(request('close', { session_id: sid }));
});

// ─── 세션 전용 cli-home 의 기록 링크가 끊어졌을 때 ───────────────────────────────
//
// Windows junction 은 끊어져도 경로가 그대로 남아 빈 디렉터리처럼 보인다(실측: ralf 의 credential 홈에서
// `sessions` 는 있는데 그 아래가 통째로 비어, codex 가 `no rollout found for thread id` 로 재개를 거부했다).
// 예전에는 "경로가 있으면 성공" 으로 보고 넘어가서 한 번 끊어진 링크가 영영 고쳐지지 않았다 — 그 credential
// 로 여는 모든 세션의 재개가 실패했다. 이제 내용이 보이는지 확인하고 끊어졌으면 다시 만든다.
test('a broken session-store link is detected and rebuilt, and a real directory with content is left alone', async (t) => {
  // credentialHarness 는 세션 전용 cli-home 을 tmp 로 격리해 준다(기존 credential 테스트와 같은 배선).
  const h = await credentialHarness(t, 'claude_oauth_token', { oauth_token: 'sk-ant-oat-test' });
  const { cwd, server, runner, root } = h;
  const open = (requestId) => runner.handle(request('open', { request_id: requestId, session_id: null, cwd, credential_id: 'cred-1', workspace_id: 'ws-1' }));
  const linkPath = join(h.sessionHomesDir, 'claude', 'cred-1', 'projects');
  const operatorStore = join(root, 'claude', 'projects');

  // 1. 첫 open 이 링크를 만든다 — 운영자 홈의 기록이 그 링크를 통해 보여야 한다.
  await open('rpc-link-1');
  assert.equal(server.rpc('rpc-link-1').ok, true, JSON.stringify(server.rpc('rpc-link-1')));
  assert.ok((await lstat(linkPath)).isSymbolicLink(), 'the store is linked, not copied');
  assert.ok(existsSync(join(linkPath, '-work')), 'the operator history is visible through it');
  assert.ok(existsSync(join(operatorStore, '-work')), 'sanity: the operator store has the recorded session');
  await runner.handle(request('close', { session_id: server.rpc('rpc-link-1').result.session_id }));

  // 2. 링크를 끊는다(엉뚱한 곳을 가리키게) — 경로는 남아 있지만 기록은 보이지 않는다.
  await rm(linkPath, { recursive: true, force: true });
  await symlink(join(root, 'nowhere'), linkPath, 'dir');
  assert.equal(existsSync(join(linkPath, '-work')), false, 'the history is not visible through the broken link');

  // 3. 다음 open 이 고친다.
  await open('rpc-link-2');
  assert.equal(server.rpc('rpc-link-2').ok, true, JSON.stringify(server.rpc('rpc-link-2')));
  assert.ok(existsSync(join(linkPath, '-work')), 'the link was rebuilt, so sessions can resume again');
  await runner.handle(request('close', { session_id: server.rpc('rpc-link-2').result.session_id }));

  // 4. 링크가 아니라 내용이 있는 진짜 디렉터리면 지우지 않는다 — 운영자의 자료일 수 있다.
  await rm(linkPath, { recursive: true, force: true });
  await mkdir(join(linkPath, 'someone-elses'), { recursive: true });
  await writeFile(join(linkPath, 'someone-elses', 'keep.txt'), 'keep me');
  await open('rpc-link-3');
  assert.equal(server.rpc('rpc-link-3').ok, true, 'the session still opens');
  assert.ok(existsSync(join(linkPath, 'someone-elses', 'keep.txt')), 'the real directory and its content survive');
  await runner.handle(request('close', { session_id: server.rpc('rpc-link-3').result.session_id }));
});
