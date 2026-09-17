// Agent Session(CLI 직접 세션) 서버 contract — docs/agent-sessions.md.
//
// 서버는 상태 없는 중계자다. 이 테스트는 가짜 Runtime Host(매니저 키 + 하트비트)를 세우고
//   1. GET hosts 가 살아 있는 매니저와 그 장비의 세션 CLI 를 보여주고,
//   2. list / history / open 이 `agent_session_request{request_id}` reverse RPC 로 매니저에
//      가서 `POST /api/agent/sessions/rpc/:id` 응답으로 풀리고(타임아웃·소유권 포함),
//   3. prompt 가 driver 를 잡고 `op:'prompt'` 를 내보내며, 매니저가 중계한 이벤트/상태가
//      driver 의 SSE 로만 흐르고(저장 없음),
//   4. permission / cancel / set_mode / close 가 올바른 op 으로 나가고,
//   5. 다른 매니저 키는 RPC/이벤트를 풀 수 없다
// 를 고정한다.
//
// 실행: node --test --test-force-exit test/agent-sessions.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createWorkspace, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('agent sessions relay: hosts → RPC list/history/open → prompt stream → permission → close', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'agent-sessions');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const plainUser = await createUser(app, getDataSourceToken, { name: 'plain', role: 'user' });
  const ownerToken = app.get(AuthService).createSession(owner.id);
  const plainToken = app.get(AuthService).createSession(plainUser.id);
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };

  // 가짜 Runtime Host — createAgent 가 만든 manager identity + 그 키로 하트비트를 친다.
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  await ds.getRepository('Agent').update({ id: managerId }, { name: 'rolf' });
  const managerHeaders = { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' };
  const heartbeat = await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-rolf-1', agent_id: managerId, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude', 'codex', 'pi'], acp_session_clis: ['claude', 'codex'], pid: 4242,
      started_at: new Date().toISOString(),
    }),
  });
  assert.ok(heartbeat.status < 300, `heartbeat accepted: ${heartbeat.status} ${heartbeat.text}`);

  // 다른 매니저(무관한 장비)
  const other = await createAgent(app, getDataSourceToken, ws.id, { name: 'other', type: 'claude' });
  const otherKey = runtimeHostKeyForAgent(other.id);

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));
  const rpcRespond = (predicate, body) => waitFor(() => requests.some(predicate), 'rpc request').then(() => {
    const req = requests.find(predicate);
    return call(`${base}/api/agent/sessions/rpc/${req.request_id}`, { method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, ...body }) });
  });

  const stream = await openSseStream(port, ownerToken, {});
  t.after(() => stream.close());

  // 1. hosts — 권한 없는 user 롤은 403, admin 은 장비와 세션 CLI 를 본다
  const forbidden = await call(`${base}/api/agent-sessions/hosts`, { headers: { ...ownerHeaders, Authorization: `Bearer ${plainToken}` } });
  assert.equal(forbidden.status, 403, 'agent_sessions.use is admin-only by default');
  const hosts = await call(`${base}/api/agent-sessions/hosts`, { headers: ownerHeaders });
  assert.equal(hosts.status, 200, hosts.text);
  const host = hosts.body.find((h) => h.manager_id === managerId);
  assert.ok(host, 'heartbeating manager is listed as a session host');
  assert.equal(host.name, 'rolf');
  assert.deepEqual(host.clis, ['claude', 'codex'], 'only ACP-capable CLIs reported by the manager');
  assert.equal(hosts.body.some((h) => h.manager_id === other.manager_agent_id), false, 'a manager without a heartbeat is not a host');

  // 2a. list — RPC 왕복
  const listCall = call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions`, { headers: ownerHeaders });
  await rpcRespond((r) => r.op === 'list' && r.cli === 'claude', {
    ok: true,
    result: { sessions: [
      { session_id: 'sess-aaaa', cwd: '/home/parn/repo', title: 'Fix login', created_at: null, updated_at: '2026-09-17T00:00:00.000Z', source: 'cli', size_bytes: 12 },
      { session_id: 'bad id with spaces', cwd: '/x', title: 'x', updated_at: '2026-09-17T00:00:00.000Z' },
    ] },
  });
  const list = await listCall;
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.map((s) => s.session_id), ['sess-aaaa'], 'malformed ids are dropped');
  assert.equal(list.body[0].cli, 'claude');
  const listReq = requests.find((r) => r.op === 'list');
  assert.equal(listReq.manager_id, managerId);
  assert.equal(listReq.driver_user_id, owner.id);

  // 2b. unsupported cli → 409 without an RPC
  const unsupported = await call(`${base}/api/agent-sessions/hosts/${managerId}/pi/sessions`, { headers: ownerHeaders });
  assert.equal(unsupported.status, 409);
  assert.equal(unsupported.body.error, 'cli_unsupported');

  // 2c. rpc ownership — the other manager's key cannot resolve our request
  const historyCall = call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-aaaa`, { headers: ownerHeaders });
  await waitFor(() => requests.some((r) => r.op === 'history'), 'history rpc');
  const historyReq = requests.find((r) => r.op === 'history');
  assert.equal(historyReq.session_id, 'sess-aaaa');
  const spoof = await call(`${base}/api/agent/sessions/rpc/${historyReq.request_id}`, {
    method: 'POST', headers: { 'X-Agent-Key': otherKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manager_id: other.manager_agent_id, ok: true, result: { session: null, events: [] } }),
  });
  assert.equal(spoof.status, 404, 'foreign manager cannot resolve the rpc');
  const historyResp = await call(`${base}/api/agent/sessions/rpc/${historyReq.request_id}`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ manager_id: managerId, ok: true, result: {
      session: { session_id: 'sess-aaaa', cwd: '/home/parn/repo', title: 'Fix login', updated_at: '2026-09-17T00:00:00.000Z', source: 'cli' },
      events: [
        { id: 'sess-aaaa:1', seq: 1, turn_id: 't0', type: 'user_prompt', payload: { text: 'fix the login test' }, created_at: '2026-09-17T00:00:00.000Z' },
        { id: 'sess-aaaa:2', seq: 2, turn_id: 't0', type: 'text', payload: { text: 'On it.' }, created_at: '2026-09-17T00:00:01.000Z' },
        { id: 'sess-aaaa:3', seq: 3, turn_id: 't0', type: 'bogus', payload: {}, created_at: '2026-09-17T00:00:01.000Z' },
      ],
    } }),
  });
  assert.equal(historyResp.status, 200, historyResp.text);
  const history = await historyCall;
  assert.equal(history.status, 200, history.text);
  assert.equal(history.body.session.title, 'Fix login');
  assert.deepEqual(history.body.events.map((e) => e.type), ['user_prompt', 'text'], 'unknown event types are dropped from history');
  assert.equal(history.body.live.status, 'idle', 'no live process yet');
  assert.equal(history.body.live.manager_name, 'rolf');

  // 2d. open (new session) — RPC returns the native id
  const openCall = call(`${base}/api/agent-sessions/hosts/${managerId}/codex/sessions`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ cwd: '/home/parn/repo', title: 'Review PR' }) });
  await rpcRespond((r) => r.op === 'open' && r.cli === 'codex', {
    ok: true,
    result: { session_id: 'codex-thread-9', cwd: '/home/parn/repo', title: 'Review PR', status: 'ready', resume_supported: false, available_modes: [{ id: 'default', name: 'Default' }], current_mode: 'default' },
  });
  const opened = await openCall;
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.body.session_id, 'codex-thread-9');
  assert.equal(opened.body.status, 'ready');
  assert.equal(opened.body.driver_user_id, owner.id);
  assert.deepEqual(opened.body.available_modes.map((m) => m.id), ['default']);
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === 'codex-thread-9' && d.reason === 'opened', 4000);
  const openReq = requests.find((r) => r.op === 'open');
  assert.equal(openReq.session_id, null);
  assert.equal(openReq.cwd, '/home/parn/repo');

  // 2e. missing cwd for a new session → 400, no rpc
  const noCwd = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({}) });
  assert.equal(noCwd.status, 400);
  assert.equal(noCwd.body.error, 'cwd_required');

  // 3. prompt on the existing claude session (idle → starting, driver = owner)
  const prompt = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-aaaa/prompt`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'run the suite' }) });
  assert.equal(prompt.status, 202, prompt.text);
  assert.equal(prompt.body.live.status, 'starting');
  assert.equal(prompt.body.live.driver_user_id, owner.id);
  const promptReq = requests.find((r) => r.op === 'prompt');
  assert.equal(promptReq.session_id, 'sess-aaaa');
  assert.equal(promptReq.text, 'run the suite');
  assert.equal(promptReq.turn_id, prompt.body.turn_id);
  assert.equal(promptReq.cwd, '/home/parn/repo', 'cwd from the history summary is forwarded');
  const busy = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-aaaa/prompt`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'again' }) });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'session_busy');

  // manager relays the stream — frames reach the driver's SSE, nothing is stored
  const turnId = prompt.body.turn_id;
  const relay = await call(`${base}/api/agent/sessions/${managerId}/claude/sess-aaaa/events`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      manager_id: managerId,
      events: [
        { id: 'sess-aaaa:live:1', seq: 1, turn_id: turnId, type: 'turn', payload: { phase: 'started' }, created_at: new Date().toISOString() },
        { id: 'sess-aaaa:live:2', seq: 2, turn_id: turnId, type: 'text', payload: { text: 'Running' }, created_at: new Date().toISOString() },
        { id: 'sess-aaaa:live:3', seq: 3, turn_id: turnId, type: 'permission_request', payload: { request_id: 'perm-1', tool_call_id: 't1', title: 'Run npm test', options: [{ option_id: 'allow', name: 'Allow', kind: 'allow_once' }] }, created_at: new Date().toISOString() },
      ],
      state: { status: 'awaiting_permission', reason: 'permission' },
    }),
  });
  assert.equal(relay.status, 200, relay.text);
  assert.equal(relay.body.relayed, 3);
  assert.equal(relay.body.live.status, 'awaiting_permission');
  await stream.waitFor('agent_session_event', (d) => d?.session_id === 'sess-aaaa' && d.event?.type === 'permission_request', 4000);
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === 'sess-aaaa' && d.session.status === 'awaiting_permission', 4000);
  const foreignRelay = await call(`${base}/api/agent/sessions/${managerId}/claude/sess-aaaa/events`, {
    method: 'POST', headers: { 'X-Agent-Key': otherKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manager_id: managerId, events: [] }),
  });
  assert.equal(foreignRelay.status, 403, 'another manager cannot relay into this host');
  const badType = await call(`${base}/api/agent/sessions/${managerId}/claude/sess-aaaa/events`, {
    method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, events: [{ type: 'bogus', payload: {} }] }),
  });
  assert.equal(badType.status, 400);

  // 4. permission → op, then manager finishes the turn
  const decide = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-aaaa/permission`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ request_id: 'perm-1', option_id: 'allow' }) });
  assert.equal(decide.status, 200, decide.text);
  assert.equal(decide.body.status, 'busy');
  const permReq = requests.find((r) => r.op === 'permission');
  assert.equal(permReq.permission_request_id, 'perm-1');
  assert.equal(permReq.option_id, 'allow');
  const finish = await call(`${base}/api/agent/sessions/${managerId}/claude/sess-aaaa`, {
    method: 'PATCH', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, status: 'ready', reason: 'turn_finished' }),
  });
  assert.equal(finish.status, 200, finish.text);
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === 'sess-aaaa' && d.session.status === 'ready', 4000);

  const mode = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-aaaa/mode`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ mode_id: 'plan' }) });
  assert.equal(mode.status, 202);
  assert.equal(requests.find((r) => r.op === 'set_mode')?.mode_id, 'plan');
  const cancel = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-aaaa/cancel`, { method: 'POST', headers: ownerHeaders });
  assert.equal(cancel.status, 202);
  assert.ok(requests.some((r) => r.op === 'cancel' && r.session_id === 'sess-aaaa'));

  // 5. close → status closed + op close; prompting again reopens (starting)
  const close = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-aaaa/close`, { method: 'POST', headers: ownerHeaders });
  assert.equal(close.status, 200);
  assert.equal(close.body.status, 'closed');
  assert.ok(requests.some((r) => r.op === 'close' && r.session_id === 'sess-aaaa'));
  const reopen = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-aaaa/prompt`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'one more' }) });
  assert.equal(reopen.status, 202);
  assert.equal(reopen.body.live.status, 'starting');

  // 6. rpc timeout surfaces as 504 (nobody answers)
  const orig = requests.length;
  const slow = call(`${base}/api/agent-sessions/hosts/${managerId}/codex/sessions/never-answered`, { headers: ownerHeaders });
  await waitFor(() => requests.length > orig, 'history rpc emitted');
  // 응답 없이 두면 서비스 타임아웃(40s)이 걸린다 — 테스트에서는 오프라인 호스트 404 로 대체 확인
  const offline = await call(`${base}/api/agent-sessions/hosts/${other.manager_agent_id}/claude/sessions`, { headers: ownerHeaders });
  assert.equal(offline.status, 404);
  assert.equal(offline.body.error, 'host_offline');
  // 미응답 RPC 는 매니저가 not_found 로 닫는다
  const pendingReq = requests[requests.length - 1];
  await call(`${base}/api/agent/sessions/rpc/${pendingReq.request_id}`, { method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, ok: false, error: 'Session not found on this Runtime Host.', code: 'not_found' }) });
  const slowRes = await slow;
  assert.equal(slowRes.status, 404);
  assert.equal(slowRes.body.error, 'not_found');

  stream.close();
});

// ─── CLI 설정: Runtime Host × CLI 에 워크스페이스 Credential 바인딩 ──────────
test('cli settings: candidates by provider prefix, validation, host listing, request payload, and manager-only credential fetch', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const { encrypt } = await import('../dist/services/encryption.service.js');
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'cli-settings');
  const otherWs = await createWorkspace(app, getDataSourceToken, 'cli-settings-other');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const ownerToken = app.get(AuthService).createSession(owner.id);
  const headers = { Authorization: `Bearer ${ownerToken}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  await ds.getRepository('Agent').update({ id: managerId }, { name: 'rolf' });
  await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instance_id: 'inst-rolf-2', agent_id: managerId, mode: 'manager', hostname: 'rolf', plugin_version: 'test', cli: 'claude', cli_adapters: ['claude', 'codex'], acp_session_clis: ['claude', 'codex'], pid: 1, started_at: new Date().toISOString() }),
  });
  const stranger = await createAgent(app, getDataSourceToken, ws.id, { name: 'stranger', type: 'claude' });
  const strangerKey = runtimeHostKeyForAgent(stranger.id);

  const credRepo = ds.getRepository('Credential');
  const mkCred = (workspace_id, name, provider, fields) => credRepo.save(credRepo.create({ workspace_id, name, description: '', provider, encrypted_data: encrypt(JSON.stringify(fields)) }));
  // 줄바꿈이 섞인 채 저장된 토큰(정규화 이전 row) — 서버가 정리해 보낸다
  const claudeToken = await mkCred(ws.id, 'rolf oauth token', 'claude_oauth_token', { oauth_token: 'sk-ant-oat-sec\n ret' });
  const globalClaude = await mkCred(null, 'shared claude key', 'claude_api_key', { api_key: 'sk-global' });
  const codexCred = await mkCred(ws.id, 'codex login', 'codex_subscription', { auth_json: '{}' });
  const foreignCred = await mkCred(otherWs.id, 'other ws claude', 'claude_api_key', { api_key: 'sk-other' });

  // GET: candidates = workspace + global credentials whose provider matches the CLI
  const initial = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/settings`, { headers });
  assert.equal(initial.status, 200, initial.text);
  assert.equal(initial.body.supports_credential, true);
  assert.equal(initial.body.credential, null);
  assert.deepEqual(initial.body.candidates.map((c) => c.id).sort(), [claudeToken.id, globalClaude.id].sort(), 'codex and other-workspace credentials are not offered');
  assert.equal(initial.body.candidates.find((c) => c.id === globalClaude.id).scope, 'global');
  const hermes = await call(`${base}/api/agent-sessions/hosts/${managerId}/hermes/settings`, { headers });
  assert.equal(hermes.body.supports_credential, false);
  assert.deepEqual(hermes.body.candidates, []);

  // PUT validation
  const mismatch = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/settings`, { method: 'PUT', headers, body: JSON.stringify({ credential_id: codexCred.id }) });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error, 'credential_provider_mismatch');
  const foreign = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/settings`, { method: 'PUT', headers, body: JSON.stringify({ credential_id: foreignCred.id }) });
  assert.equal(foreign.status, 404);
  const unknownHost = await call(`${base}/api/agent-sessions/hosts/${agent.id}/claude/settings`, { method: 'PUT', headers, body: JSON.stringify({ credential_id: claudeToken.id }) });
  assert.equal(unknownHost.status, 404, 'a non-manager agent id is not a host');
  const hermesPut = await call(`${base}/api/agent-sessions/hosts/${managerId}/hermes/settings`, { method: 'PUT', headers, body: JSON.stringify({ credential_id: claudeToken.id }) });
  assert.equal(hermesPut.status, 409);

  const saved = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/settings`, { method: 'PUT', headers, body: JSON.stringify({ credential_id: claudeToken.id }) });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.credential.id, claudeToken.id);
  assert.equal(saved.body.credential.provider, 'claude_oauth_token');
  assert.ok(saved.body.updated_at);

  // hosts list carries the binding per CLI
  const hosts = await call(`${base}/api/agent-sessions/hosts`, { headers });
  const host = hosts.body.find((h) => h.manager_id === managerId);
  assert.equal(host.cli_settings.claude.name, 'rolf oauth token');
  assert.equal(host.cli_settings.codex, undefined);

  // open / prompt requests carry workspace_id + credential_id; list/history carry workspace_id only
  const requests = [];
  const onRequest = (p) => requests.push(p);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));
  const openCall = call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions`, { method: 'POST', headers, body: JSON.stringify({ cwd: '/home/parn/repo' }) });
  await waitFor(() => requests.some((r) => r.op === 'open'), 'open rpc');
  const openReq = requests.find((r) => r.op === 'open');
  assert.equal(openReq.credential_id, claudeToken.id);
  assert.equal(openReq.workspace_id, ws.id);
  await call(`${base}/api/agent/sessions/rpc/${openReq.request_id}`, { method: 'POST', headers: { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ manager_id: managerId, ok: true, result: { session_id: 'sess-cred', cwd: '/home/parn/repo', status: 'ready' } }) });
  assert.equal((await openCall).status, 201);
  const prompt = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-cred/prompt`, { method: 'POST', headers, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(prompt.status, 202);
  assert.equal(requests.find((r) => r.op === 'prompt').credential_id, claudeToken.id);

  // manager fetches the decrypted material — only for a bound credential, only as the bound manager
  const fetched = await call(`${base}/api/agent/sessions/credential/${claudeToken.id}?workspace_id=${ws.id}`, { headers: { 'X-Agent-Key': managerKey } });
  assert.equal(fetched.status, 200, fetched.text);
  assert.equal(fetched.body.provider, 'claude_oauth_token');
  assert.deepEqual(fetched.body.fields, { oauth_token: 'sk-ant-oat-secret' }, 'interior whitespace is stripped before the token reaches the manager');
  assert.equal(fetched.body.fields.oauth_token.includes('\n'), false);
  const unbound = await call(`${base}/api/agent/sessions/credential/${globalClaude.id}?workspace_id=${ws.id}`, { headers: { 'X-Agent-Key': managerKey } });
  assert.equal(unbound.status, 403, 'a credential that is not bound in CLI settings is not served');
  const otherManager = await call(`${base}/api/agent/sessions/credential/${claudeToken.id}?workspace_id=${ws.id}`, { headers: { 'X-Agent-Key': strangerKey } });
  assert.equal(otherManager.status, 403, 'another Runtime Host cannot read this binding');
  const noWs = await call(`${base}/api/agent/sessions/credential/${claudeToken.id}`, { headers: { 'X-Agent-Key': managerKey } });
  assert.equal(noWs.status, 400);

  // clearing the binding
  const cleared = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/settings`, { method: 'PUT', headers, body: JSON.stringify({ credential_id: null }) });
  assert.equal(cleared.body.credential, null);
  const afterClear = await call(`${base}/api/agent/sessions/credential/${claudeToken.id}?workspace_id=${ws.id}`, { headers: { 'X-Agent-Key': managerKey } });
  assert.equal(afterClear.status, 403);
});
