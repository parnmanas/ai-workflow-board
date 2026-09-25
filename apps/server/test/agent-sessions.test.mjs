// Agent Session(CLI 직접 세션) 서버 contract — docs/agent-sessions.md.
//
// 서버는 상태 없는 중계자다. 이 테스트는 가짜 Runtime Host(매니저 키 + 하트비트)를 세우고
//   1. GET hosts 가 살아 있는 매니저와 그 장비의 세션 CLI 를 보여주고,
//   2. list / history / open 이 `agent_session_request{request_id}` reverse RPC 로 매니저에
//      가서 `POST /api/agent/sessions/rpc/:id` 응답으로 풀리고(타임아웃·소유권 포함),
//   3. prompt 가 driver 를 잡고 `op:'prompt'` 를 내보내며, 매니저가 중계한 이벤트/상태가
//      driver 의 SSE 로만 흐르고(저장 없음),
//   4. permission / cancel / set_mode / close / restart 가 올바른 op 으로 나가고,
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
    result: {
      session_id: 'codex-thread-9', cwd: '/home/parn/repo', title: 'Review PR', status: 'ready', resume_supported: false,
      available_modes: [{ id: 'default', name: 'Default' }], current_mode: 'default',
      config_options: [{ config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: 'gpt-a', options: [{ value: 'gpt-a', name: 'A' }, { value: 'gpt-b', name: 'B' }] }],
      available_commands: [{ name: 'review', description: 'Review' }],
    },
  });
  const opened = await openCall;
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.body.session_id, 'codex-thread-9');
  assert.equal(opened.body.status, 'ready');
  assert.equal(opened.body.driver_user_id, owner.id);
  assert.deepEqual(opened.body.available_modes.map((m) => m.id), ['default']);
  assert.deepEqual(opened.body.config_options.map((o) => [o.config_id, o.current_value]), [['model', 'gpt-a']], 'open result carries the adapter settings so the header renders immediately');
  assert.deepEqual(opened.body.available_commands.map((c) => c.name), ['review']);
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

  // 5b. restart → 프로세스만 다시 띄운다. close 와 달리 다음 프롬프트를 기다리지 않고
  //     바로 starting 으로 간다 — 운영자가 재시작을 누르는 이유는 보통 "방금 CLI 를
  //     올렸으니 새 바이너리로 다시 띄워라" 이고, 그때 원하는 건 지금 살아 있는 새
  //     프로세스다. starting 은 그 사이 프롬프트가 끼어들지 못하게도 한다.
  const restart = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-aaaa/restart`, { method: 'POST', headers: ownerHeaders });
  assert.equal(restart.status, 202);
  assert.equal(restart.body.status, 'starting');
  assert.ok(
    requests.some((r) => r.op === 'restart' && r.session_id === 'sess-aaaa'),
    'restart 는 같은 세션 id 로 나간다 — 새 세션을 만드는 것이 아니다',
  );

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
  // restart 도 세션을 **다시 여는** 요청이다 — 개설 컨텍스트를 빠뜨리면 운영자 로그인으로
  // 열리고, 다음 op 가 바인딩된 credential 을 싣고 오는 순간 매니저가 계정을 바꿔 다시
  // 연다. 그러면 모델 목록이 통째로 달라져서 방금 고른 모델이 사라지고 설정이 실패한다
  // (실측: restart 직후 Fable 5.1 이 보였다가 고르면 Internal error).
  const restartCred = await call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions/sess-cred/restart`, { method: 'POST', headers });
  assert.equal(restartCred.status, 202);
  const restartReq = requests.find((r) => r.op === 'restart');
  assert.ok(restartReq, 'restart 요청이 나가야 한다');
  assert.equal(restartReq.credential_id, claudeToken.id, 'restart 는 세션이 쓰던 계정 그대로 다시 열어야 한다');
  assert.equal(restartReq.workspace_id, ws.id);
  assert.equal(restartReq.cwd, '/home/parn/repo', '다시 열 때 cwd 도 함께 실어야 한다');

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

// ─── 유령 상태: 매니저 답(list live_status / history live)과 매니저 재시작이 진행 중 상태를 되돌린다 ──
//
// 증상: 목록·사이드바에 "Needs your approval" 가 떠 있는데 세션에 들어가면 권한 카드가 없고
// prompt 는 409 session_busy. 서버는 세션 상태를 메모리에만 두고 매니저의 마지막 상태 패치에
// 의존하는데, 매니저가 self-update/SIGTERM 으로 재시작하면(systemd 가 cgroup 전체에 신호를
// 보내 세션 프로세스가 먼저 죽는다) 그 패치가 오지 않아 24시간 TTL 동안 유령이 남았다.
test('ghost in-flight state is reconciled with the manager answer and cleared when the manager instance goes away', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'agent-sessions-ghost');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner-ghost', role: 'admin' });
  const ownerToken = app.get(AuthService).createSession(owner.id);
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder-ghost', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  await ds.getRepository('Agent').update({ id: managerId }, { name: 'rolf' });
  const managerHeaders = { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' };
  const heartbeat = (instanceId) => call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: instanceId, agent_id: managerId, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude'], acp_session_clis: ['claude'], pid: 4242, started_at: new Date().toISOString(),
    }),
  });
  assert.ok((await heartbeat('inst-ghost-1')).status < 300, 'first manager instance registered');

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));
  const answered = new Set();
  // 같은 op 의 RPC 가 여러 번 나가므로 아직 답하지 않은 가장 오래된 요청에 답한다.
  const answerNext = async (op, body) => {
    await waitFor(() => requests.some((r) => r.op === op && !answered.has(r.request_id)), `${op} rpc`);
    const req = requests.find((r) => r.op === op && !answered.has(r.request_id));
    answered.add(req.request_id);
    const res = await call(`${base}/api/agent/sessions/rpc/${req.request_id}`, { method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, ...body }) });
    assert.equal(res.status, 200, res.text);
    return req;
  };
  const stream = await openSseStream(port, ownerToken, {});
  t.after(() => stream.close());

  const sid = 'sess-ghost';
  const sessionsUrl = `${base}/api/agent-sessions/hosts/${managerId}/claude/sessions`;
  const row = (liveStatus) => ({
    session_id: sid, cwd: '/home/parn/repo', title: 'Ghost', created_at: null, updated_at: '2026-09-19T00:00:00.000Z', source: 'cli',
    ...(liveStatus ? { live_status: liveStatus } : {}),
  });
  const permissionRow = { id: `${sid}:live:1`, seq: 1, turn_id: 't0', type: 'permission_request', payload: { request_id: 'perm-9', tool_call_id: 't', title: 'Run rm -rf build', options: [{ option_id: 'allow', name: 'Allow', kind: 'allow_once' }] }, created_at: '2026-09-19T00:00:01.000Z' };
  const relayState = async (state, events = []) => {
    const res = await call(`${base}/api/agent/sessions/${managerId}/claude/${sid}/events`, { method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, events, state }) });
    assert.equal(res.status, 200, res.text);
    return res.body.live;
  };

  // 0. prompt → starting, 매니저가 permission 요청을 중계 → awaiting_permission (driver = owner)
  const prompt = await call(`${sessionsUrl}/${sid}/prompt`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'do it' }) });
  assert.equal(prompt.status, 202, prompt.text);
  assert.equal((await relayState({ status: 'awaiting_permission', reason: 'permission' }, [{ ...permissionRow, turn_id: prompt.body.turn_id }])).status, 'awaiting_permission');

  // 1a. list — 매니저도 awaiting_permission 이라고 답하면 그대로
  let listCall = call(sessionsUrl, { headers: ownerHeaders });
  await answerNext('list', { ok: true, result: { sessions: [row('awaiting_permission')] } });
  let list = await listCall;
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body[0].live_status, 'awaiting_permission', 'manager and server agree');

  // 1b. list — 매니저에 그 세션의 프로세스가 없다(재시작됐다) → idle 로 되돌리고 driver 화면에 알린다
  listCall = call(sessionsUrl, { headers: ownerHeaders });
  await answerNext('list', { ok: true, result: { sessions: [row(null)] } });
  list = await listCall;
  assert.equal(list.body[0].live_status, 'idle', 'ghost awaiting_permission is reset when the manager reports no live process');
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === sid && d.session.status === 'idle' && d.reason === 'list', 4000);
  // 그리고 prompt 가 409 session_busy 대신 다시 받아들여진다
  const again = await call(`${sessionsUrl}/${sid}/prompt`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'retry' }) });
  assert.equal(again.status, 202, again.text);
  assert.equal(again.body.live.status, 'starting');

  // 1c. starting 은 open 이 아직 진행 중일 수 있으므로 list 가 "없다" 고 해도 grace 동안 지킨다
  listCall = call(sessionsUrl, { headers: ownerHeaders });
  await answerNext('list', { ok: true, result: { sessions: [row(null)] } });
  list = await listCall;
  assert.equal(list.body[0].live_status, 'starting', 'starting survives a list answer inside the open grace window');

  // 2a. history — 매니저 live 가 진실: awaiting_permission + 기록 끝에 재전송된 permission_request 가 그대로 통과한다
  let detailCall = call(`${sessionsUrl}/${sid}`, { headers: ownerHeaders });
  await answerNext('history', {
    ok: true,
    result: {
      session: row(null),
      events: [{ id: `${sid}:1`, seq: 1, turn_id: 't0', type: 'user_prompt', payload: { text: 'do it' }, created_at: '2026-09-19T00:00:00.000Z' }, { ...permissionRow, seq: 2 }],
      truncated: false,
      live: { session_id: sid, cwd: '/home/parn/repo', title: 'Ghost', status: 'awaiting_permission', resume_supported: true },
    },
  });
  let detail = await detailCall;
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.live.status, 'awaiting_permission', 'manager-reported status replaces starting');
  assert.deepEqual(detail.body.events.map((e) => e.type), ['user_prompt', 'permission_request'], 'a replayed pending permission_request passes through history');
  assert.equal(detail.body.events[1].payload.request_id, 'perm-9');

  // 2b. history — live: null (프로세스 없음) 이면 유령 awaiting_permission 을 idle 로
  detailCall = call(`${sessionsUrl}/${sid}`, { headers: ownerHeaders });
  await answerNext('history', { ok: true, result: { session: row(null), events: [], truncated: false, live: null } });
  detail = await detailCall;
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.live.status, 'idle');
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === sid && d.session.status === 'idle' && d.reason === 'history', 4000);

  // 3. 매니저 재시작: 같은 identity·hostname 의 새 instance_id 가 옛 인스턴스를 대체하면 그 장비의 진행 중 세션은 idle 로
  assert.equal((await relayState({ status: 'busy', reason: 'turn_started' })).status, 'busy');
  assert.ok((await heartbeat('inst-ghost-2')).status < 300, 'restarted manager instance registered');
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === sid && d.session.status === 'idle' && d.reason === 'host_offline', 4000);
  const afterRestart = await call(`${sessionsUrl}/${sid}/prompt`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'after restart' }) });
  assert.equal(afterRestart.status, 202, `no 409 session_busy after the host restarted: ${afterRestart.text}`);
  assert.ok(requests.filter((r) => r.op === 'prompt').length >= 3, 'each accepted prompt reached the manager');

  stream.close();
});

// ─── 상호작용 contract: 세션 설정(모델 등) · slash command · 질문/폼(elicitation) ────────
//
// 매니저가 상태 패치로 config_options / available_commands 를 보내면 스냅샷에 실리고,
// 사용자는 POST config-option / POST elicitation 으로 set_config_option / elicitation op 을 낸다.
// awaiting_input 은 awaiting_permission 과 같은 대기 상태(409 session_busy, 유령 되돌림 대상)다.
test('interactive contract: config options + commands in the snapshot, set_config_option and elicitation ops, awaiting_input semantics', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'agent-sessions-interactive');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner-interactive', role: 'admin' });
  const ownerToken = app.get(AuthService).createSession(owner.id);
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder-interactive', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  await ds.getRepository('Agent').update({ id: managerId }, { name: 'rolf' });
  const managerHeaders = { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' };
  const heartbeat = (instanceId) => call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: instanceId, agent_id: managerId, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'codex', cli_adapters: ['codex', 'claude'], acp_session_clis: ['codex', 'claude'], pid: 4242, started_at: new Date().toISOString(),
    }),
  });
  assert.ok((await heartbeat('inst-interactive-1')).status < 300);

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));
  const stream = await openSseStream(port, ownerToken, {});
  t.after(() => stream.close());

  const sid = 'codex-thread-77';
  const sessionsUrl = `${base}/api/agent-sessions/hosts/${managerId}/codex/sessions`;
  const relay = async (body) => {
    const res = await call(`${base}/api/agent/sessions/${managerId}/codex/${sid}/events`, { method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, events: [], ...body }) });
    assert.equal(res.status, 200, res.text);
    return res.body;
  };
  const configOptions = [
    { config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: 'gpt-fast', options: [{ value: 'gpt-fast', name: 'Fast' }, { value: 'gpt-smart', name: 'Smart', description: 'slower', group: 'Premium' }] },
    { config_id: 'fast_mode', name: 'Fast mode', category: 'model_config', type: 'boolean', current_value: false, options: [] },
    { config_id: '', name: 'dropped', category: 'x', type: 'select', current_value: null, options: [] },
  ];

  // 0. prompt(driver) → 매니저가 opened 상태로 설정·명령을 보낸다
  const prompt = await call(`${sessionsUrl}/${sid}/prompt`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(prompt.status, 202, prompt.text);
  const opened = await relay({ state: { status: 'ready', reason: 'opened', config_options: configOptions, available_commands: [{ name: 'review', description: 'Review', input_hint: 'focus' }, { name: 'compact', description: 'Compact' }, { name: '', description: 'dropped' }] } });
  assert.deepEqual(opened.live.config_options.map((o) => o.config_id), ['model', 'fast_mode'], 'options without an id are dropped');
  assert.deepEqual(opened.live.config_options[0].options[1], { value: 'gpt-smart', name: 'Smart', description: 'slower', group: 'Premium' });
  assert.deepEqual(opened.live.available_commands, [{ name: 'review', description: 'Review', input_hint: 'focus' }, { name: 'compact', description: 'Compact' }]);
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === sid && d.session.config_options?.length === 2, 4000);

  // 1. set_config_option — 선택지 검증 + op payload
  const bad = await call(`${sessionsUrl}/${sid}/config-option`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ config_id: 'model', value: 'nope' }) });
  assert.equal(bad.status, 400, bad.text);
  assert.equal(bad.body.error, 'config_value_invalid');
  const setModel = await call(`${sessionsUrl}/${sid}/config-option`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ config_id: 'model', value: 'gpt-smart' }) });
  assert.equal(setModel.status, 202, setModel.text);
  const setBool = await call(`${sessionsUrl}/${sid}/config-option`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ config_id: 'fast_mode', value: true }) });
  assert.equal(setBool.status, 202, setBool.text);
  const ops = requests.filter((r) => r.op === 'set_config_option');
  assert.deepEqual(ops.map((r) => [r.config_id, r.config_value]), [['model', 'gpt-smart'], ['fast_mode', true]]);
  assert.equal(ops[0].session_id, sid);
  const noValue = await call(`${sessionsUrl}/${sid}/config-option`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ config_id: 'model' }) });
  assert.equal(noValue.status, 400);

  // 2. 질문/폼: awaiting_input 은 prompt 를 막고, 답은 elicitation op 으로 나간다
  const asked = await relay({
    events: [{ id: `${sid}:live:9`, seq: 9, turn_id: prompt.body.turn_id, type: 'elicitation_request', payload: { elicitation_id: 'elic-1', mode: 'form', message: 'Env?', schema: { type: 'object', properties: { env: { type: 'string', enum: ['dev', 'prod'] } }, required: ['env'] } }, created_at: new Date().toISOString() }],
    state: { status: 'awaiting_input', reason: 'elicitation' },
  });
  assert.equal(asked.relayed, 1, 'elicitation_request is an accepted event type');
  assert.equal(asked.live.status, 'awaiting_input');
  await stream.waitFor('agent_session_event', (d) => d?.session_id === sid && d.event?.type === 'elicitation_request', 4000);
  const blocked = await call(`${sessionsUrl}/${sid}/prompt`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'again' }) });
  assert.equal(blocked.status, 409, 'a pending question blocks prompting like a pending permission');
  const badAction = await call(`${sessionsUrl}/${sid}/elicitation`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ elicitation_id: 'elic-1', action: 'maybe' }) });
  assert.equal(badAction.status, 400);
  const badContent = await call(`${sessionsUrl}/${sid}/elicitation`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ elicitation_id: 'elic-1', action: 'accept', content: ['not', 'an', 'object'] }) });
  assert.equal(badContent.status, 400);
  const answered = await call(`${sessionsUrl}/${sid}/elicitation`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ elicitation_id: 'elic-1', action: 'accept', content: { env: 'prod' } }) });
  assert.equal(answered.status, 200, answered.text);
  assert.equal(answered.body.status, 'busy', 'answering hands the turn back to the agent');
  const elicitOp = requests.find((r) => r.op === 'elicitation');
  assert.equal(elicitOp.elicitation_id, 'elic-1');
  assert.equal(elicitOp.elicitation_action, 'accept');
  assert.deepEqual(elicitOp.elicitation_content, { env: 'prod' });
  const declined = await call(`${sessionsUrl}/${sid}/elicitation`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ elicitation_id: 'elic-2', action: 'decline' }) });
  assert.equal(declined.status, 200);
  assert.equal(requests.filter((r) => r.op === 'elicitation').at(-1).elicitation_content, null);

  // 3. plan / elicitation_decision 도 중계되는 타입이고, history 답의 live 가 설정·명령을 되살린다
  const more = await relay({ events: [
    { id: `${sid}:live:10`, seq: 10, turn_id: prompt.body.turn_id, type: 'plan', payload: { entries: [{ content: 'Deploy', priority: 'high', status: 'in_progress' }] }, created_at: new Date().toISOString() },
    { id: `${sid}:live:11`, seq: 11, turn_id: prompt.body.turn_id, type: 'elicitation_decision', payload: { elicitation_id: 'elic-1', action: 'accept', content: { env: 'prod' }, decided_by: 'user' }, created_at: new Date().toISOString() },
  ] });
  assert.equal(more.relayed, 2);
  const answeredHistory = new Set();
  const detailCall = call(`${sessionsUrl}/${sid}`, { headers: ownerHeaders });
  await waitFor(() => requests.some((r) => r.op === 'history' && !answeredHistory.has(r.request_id)), 'history rpc');
  const historyReq = requests.find((r) => r.op === 'history' && !answeredHistory.has(r.request_id));
  answeredHistory.add(historyReq.request_id);
  await call(`${base}/api/agent/sessions/rpc/${historyReq.request_id}`, { method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, ok: true, result: {
    session: { session_id: sid, cwd: '/home/parn/repo', title: 'Interactive', updated_at: '2026-09-19T00:00:00.000Z', source: 'awb' },
    events: [], truncated: false,
    live: { session_id: sid, status: 'ready', cwd: '/home/parn/repo', title: 'Interactive', resume_supported: true, current_mode: 'agent', available_modes: [{ id: 'agent', name: 'Agent' }, { id: 'read-only', name: 'Read only' }], config_options: [{ ...configOptions[0], current_value: 'gpt-smart' }, { ...configOptions[1], current_value: true }], available_commands: [{ name: 'status', description: 'Status' }] },
  } }) });
  const detail = await detailCall;
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.live.status, 'ready');
  assert.equal(detail.body.live.current_mode, 'agent');
  assert.deepEqual(detail.body.live.available_modes.map((m) => m.id), ['agent', 'read-only']);
  assert.equal(detail.body.live.config_options[0].current_value, 'gpt-smart', 'history live carries the manager-side config state');
  assert.deepEqual(detail.body.live.available_commands.map((c) => c.name), ['status']);

  // 3a2. 계정 정보 — 매니저가 보고한 대로 스냅샷에 실린다(모양이 어긋나면 통째로 null = "모른다")
  const withAuth = await relay({ state: { auth: { source: 'operator', kind: 'account', label: 'Codex Pro', detail: '', account: { email: 'parn@example.com', organization: 'KakaoVX', plan: 'pro' } }, reason: 'auth' } });
  assert.deepEqual(withAuth.live.auth, { source: 'operator', kind: 'account', label: 'Codex Pro', account: { email: 'parn@example.com', organization: 'KakaoVX', plan: 'pro' } }, 'empty detail is dropped, the rest is projected');
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === sid && d.session.auth?.label === 'Codex Pro', 4000);
  assert.equal((await relay({ state: { auth: { kind: 'account', label: 'no source' }, reason: 'auth' } })).live.auth, null, 'a payload without a source is not trustworthy — treat it as unknown');
  assert.equal((await relay({ state: { auth: { source: 'credential', kind: 'api_key', label: 'Anthropic API key' }, reason: 'auth' } })).live.auth.source, 'credential');

  // 3b. 프로세스가 없는 세션의 설정 변경은 409 가 아니라 매니저가 열게 한다(starting) — 첫 프롬프트 전에 모델을 고른다
  const idleSid = 'codex-thread-idle';
  const idleSet = await call(`${sessionsUrl}/${idleSid}/config-option`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ config_id: 'model', value: 'gpt-smart' }) });
  assert.equal(idleSet.status, 202, idleSet.text);
  assert.equal(idleSet.body.status, 'starting', 'an idle session is opened for the settings change');
  const idleOp = requests.filter((r) => r.op === 'set_config_option').at(-1);
  assert.equal(idleOp.session_id, idleSid);
  assert.equal(idleOp.config_value, 'gpt-smart');
  const idleMode = await call(`${sessionsUrl}/${idleSid}/mode`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ mode_id: 'read-only' }) });
  assert.equal(idleMode.status, 202, idleMode.text);
  assert.equal(requests.filter((r) => r.op === 'set_mode').at(-1).session_id, idleSid);
  // 턴 중에도 설정을 바꿀 수 있다 — 어댑터가 받아들이고(codex-acp 실측), 계속 묻는 게 번거로워
  // "Approve for me" 로 옮기고 싶은 순간이 바로 그때다. 승인 대기 중에도 마찬가지.
  assert.equal((await relay({ state: { status: 'busy', reason: 'turn_started' } })).live.status, 'busy');
  const busyMode = await call(`${sessionsUrl}/${sid}/mode`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ mode_id: 'read-only' }) });
  assert.equal(busyMode.status, 202, `mid-turn mode change is accepted: ${busyMode.text}`);
  assert.equal(busyMode.body.status, 'busy', 'and it does not disturb the running turn');
  assert.equal(requests.filter((r) => r.op === 'set_mode').at(-1).mode_id, 'read-only');
  assert.equal((await relay({ state: { status: 'awaiting_permission', reason: 'permission' } })).live.status, 'awaiting_permission');
  const waitingModel = await call(`${sessionsUrl}/${sid}/config-option`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ config_id: 'model', value: 'gpt-fast' }) });
  assert.equal(waitingModel.status, 202, `a change while a permission is pending is accepted: ${waitingModel.text}`);
  assert.equal(waitingModel.body.status, 'awaiting_permission', 'the pending approval is untouched');
  assert.equal((await relay({ state: { status: 'ready', reason: 'turn_finished' } })).live.status, 'ready');

  // 4. awaiting_input 도 유령 되돌림 대상이다 — 매니저 재시작이면 idle 로
  assert.equal((await relay({ state: { status: 'awaiting_input', reason: 'elicitation' } })).live.status, 'awaiting_input');
  assert.ok((await heartbeat('inst-interactive-2')).status < 300);
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === sid && d.session.status === 'idle' && d.reason === 'host_offline', 4000);

  // 5. 하트비트의 agent_sessions 가 진실이다 — 매 하트비트(30초)마다 서버 메모리를 맞춘다
  const heartbeatWith = (agentSessions) => call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-interactive-2', agent_id: managerId, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'codex', cli_adapters: ['codex', 'claude'], acp_session_clis: ['codex', 'claude'], pid: 4242, started_at: new Date().toISOString(),
      ...(agentSessions !== undefined ? { agent_sessions: agentSessions } : {}),
    }),
  });
  assert.equal((await relay({ state: { status: 'busy', reason: 'turn_started' } })).live.status, 'busy');
  assert.ok((await heartbeatWith(undefined)).status < 300);
  // 구버전 매니저는 이 필드를 안 보낸다 — 그 하트비트는 상태를 건드리지 않아야 한다(스냅샷으로 확인).
  const stillBusy = await call(`${sessionsUrl}/${sid}/mode`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ mode_id: 'agent' }) });
  assert.equal(stillBusy.status, 202, stillBusy.text);
  assert.equal(stillBusy.body.status, 'busy', 'an old manager that does not report agent_sessions changes nothing');
  assert.ok((await heartbeatWith([])).status < 300, 'heartbeat: no live sessions');
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === sid && d.session.status === 'idle' && d.reason === 'heartbeat', 4000);
  assert.ok((await heartbeatWith([{ cli: 'codex', session_id: sid, status: 'awaiting_permission' }])).status < 300, 'heartbeat: waiting for approval');
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === sid && d.session.status === 'awaiting_permission' && d.reason === 'heartbeat', 4000);
  const blockedByHeartbeat = await call(`${sessionsUrl}/${sid}/prompt`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'x' }) });
  assert.equal(blockedByHeartbeat.status, 409, 'a heartbeat-reported waiting state blocks prompting');
  assert.ok((await heartbeatWith([{ cli: 'codex', session_id: sid, status: 'ready' }])).status < 300);
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === sid && d.session.status === 'ready' && d.reason === 'heartbeat', 4000);

  // 5b. 고른 설정은 호스트×CLI 에 기억되고, 이후 open/prompt payload 에 실려 매니저가 다시 건다.
  //     이게 없으면 어댑터 프로세스가 회수될 때마다(유휴/다른 세션 왕복) 사용자의 선택이 사라진다.
  const settingsUrl = `${base}/api/agent-sessions/hosts/${managerId}/codex/settings`;
  // credential 을 한 번도 묶지 않은 호스트에도 선택지 캐시가 남아야 한다 — row 가 없다고 비워 두면
  // 새 세션 모달에 아무 선택기도 뜨지 않는다(그 호스트는 row 자체가 없다).
  const freshWs = await createWorkspace(app, getDataSourceToken, 'agent-sessions-fresh');
  const freshHeaders = { ...ownerHeaders, 'X-Workspace-Id': freshWs.id };
  const freshSettings = await call(`${base}/api/agent-sessions/hosts/${managerId}/codex/settings`, { headers: freshHeaders });
  assert.equal(freshSettings.status, 200, freshSettings.text);
  assert.deepEqual(freshSettings.body.known_config_options.map((o) => o.config_id), ['model', 'fast_mode'], 'a workspace with no settings row still sees what the live session offers');
  assert.deepEqual(freshSettings.body.default_config, {}, 'but nothing is remembered for it yet');

  const beforeRemember = await call(settingsUrl, { headers: ownerHeaders });
  assert.equal(beforeRemember.status, 200, beforeRemember.text);
  // `__mode` 는 레거시 set_mode 의 예약 키다 — 위 3b 의 mode 변경이 여기 기억됐다(턴 중 409 는 기억되지 않는다).
  // 위에서 고른 값들이 그대로 남아 있다(키마다 마지막 값). `__mode` 는 레거시 set_mode 의 예약 키다.
  assert.deepEqual(beforeRemember.body.default_config, { model: 'gpt-fast', fast_mode: true, __mode: 'agent' }, 'every config-option and mode call was remembered');
  // 캐시는 "마지막으로 어댑터가 말한 전체 목록" 이다(ACP 의 config_option_update 는 항상 전량을 보낸다).
  assert.deepEqual(beforeRemember.body.known_config_options.map((o) => o.config_id), ['model', 'fast_mode'], 'the adapter option list is cached for the new-session modal');
  assert.deepEqual(beforeRemember.body.known_config_options.find((o) => o.config_id === 'model').options.map((o) => o.value), ['gpt-fast', 'gpt-smart'], 'with its choices, so the modal can render a picker before any session exists');
  assert.equal(requests.filter((r) => r.op === 'set_config_option').at(-1).config_defaults.model, 'gpt-fast', 'the op carries the full remembered set');

  // backend(Claude backend profile) — 인스턴스 전역 목록에서 고르고, open payload 에 실린다.
  const backendRow = { id: 'gw', name: 'Gateway', protocol: 'anthropic-compatible', base_url: 'http://gw.local:9000', model: 'claude-gw', credential_ref: null, config: '{}' };
  await ds.getRepository('ClaudeBackendProfile').save(backendRow);
  const withBackends = await call(settingsUrl, { headers: ownerHeaders });
  assert.equal(withBackends.body.supports_backend, false, 'codex 는 Claude backend profile 을 받지 않는다');
  const claudeSettingsUrl = `${base}/api/agent-sessions/hosts/${managerId}/claude/settings`;
  const claudeSettings = await call(claudeSettingsUrl, { headers: ownerHeaders });
  assert.equal(claudeSettings.status, 200, claudeSettings.text);
  assert.equal(claudeSettings.body.supports_backend, true);
  assert.deepEqual(claudeSettings.body.backend_candidates.map((b) => [b.id, b.name, b.model]), [['gw', 'Gateway', 'claude-gw']]);
  assert.equal(claudeSettings.body.backend, null, '고르기 전에는 CLI 기본 엔드포인트');

  const badBackend = await call(claudeSettingsUrl, { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ credential_id: null, backend_profile_id: 'nope' }) });
  assert.equal(badBackend.status, 404, '없는 프로필은 거부한다');
  const codexBackend = await call(settingsUrl, { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ credential_id: null, backend_profile_id: 'gw' }) });
  assert.equal(codexBackend.status, 409, 'codex 에는 붙일 수 없다');
  const pinned = await call(claudeSettingsUrl, { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ credential_id: null, backend_profile_id: 'gw' }) });
  assert.equal(pinned.status, 200, pinned.text);
  assert.deepEqual([pinned.body.backend.id, pinned.body.backend.base_url], ['gw', 'http://gw.local:9000']);

  // 모달이 세션을 열기 전에 고르는 경로 — PUT 은 부분 갱신이고 null 은 키를 지운다
  const putDefaults = await call(settingsUrl, {
    method: 'PUT', headers: ownerHeaders,
    body: JSON.stringify({ credential_id: null, default_config: { mode: 'read-only' } }),
  });
  assert.equal(putDefaults.status, 200, putDefaults.text);
  assert.deepEqual(putDefaults.body.default_config, { model: 'gpt-fast', fast_mode: true, __mode: 'agent', mode: 'read-only' }, 'a partial patch keeps the other remembered values');
  const cleared = await call(settingsUrl, {
    method: 'PUT', headers: ownerHeaders,
    body: JSON.stringify({ credential_id: null, default_config: { fast_mode: null } }),
  });
  assert.equal(cleared.body.default_config.fast_mode, undefined, 'null clears a key (back to the adapter default)');
  const badDefault = await call(settingsUrl, {
    method: 'PUT', headers: ownerHeaders,
    body: JSON.stringify({ credential_id: null, default_config: { mode: { nested: true } } }),
  });
  assert.equal(badDefault.status, 400, 'only strings, booleans and null are storable');

  // 새로 여는 세션의 open payload 에 실린다
  const openWithDefaults = call(`${sessionsUrl}`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ cwd: '/home/parn/repo' }) });
  await waitFor(() => requests.some((r) => r.op === 'open' && r.cwd === '/home/parn/repo'), 'open rpc');
  const openReq = requests.find((r) => r.op === 'open' && r.cwd === '/home/parn/repo');
  assert.deepEqual(openReq.config_defaults, { model: 'gpt-fast', __mode: 'agent', mode: 'read-only' }, 'the manager is told what to restore');
  assert.equal(openReq.runtime_profile, null, 'codex sessions carry no Claude backend profile');

  // claude 세션을 열면 핀한 backend 가 payload 에 실린다 — 고르지 않았으면 null(전역 기본값으로 떨어지지 않는다).
  const claudeOpen = call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ cwd: '/home/parn/repo' }) });
  await waitFor(() => requests.some((r) => r.op === 'open' && r.cli === 'claude'), 'claude open rpc');
  const claudeOpenReq = requests.find((r) => r.op === 'open' && r.cli === 'claude');
  assert.equal(claudeOpenReq.runtime_profile?.id, 'gw');
  assert.equal(claudeOpenReq.runtime_profile?.base_url, 'http://gw.local:9000');
  assert.equal(claudeOpenReq.runtime_profile?.model, 'claude-gw');
  await call(`${base}/api/agent/sessions/rpc/${claudeOpenReq.request_id}`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ manager_id: managerId, ok: true, result: { session_id: 'claude-backend-1', cwd: '/home/parn/repo', status: 'ready' } }),
  });
  assert.equal((await claudeOpen).status, 201);
  await call(`${base}/api/agent/sessions/rpc/${openReq.request_id}`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ manager_id: managerId, ok: true, result: { session_id: 'codex-thread-defaults', cwd: '/home/parn/repo', status: 'ready' } }),
  });
  assert.equal((await openWithDefaults).status, 201);

  // 6. 서버가 처음 보는 세션에 매니저가 먼저 말을 걸면 상태는 배치에서 읽는다 — system 행 하나로 busy 유령을 만들지 않는다
  const { AgentSessionsService } = await import(new URL('../dist/modules/agent-sessions/agent-sessions.service.js', import.meta.url));
  const svc = app.get(AgentSessionsService);
  const seed = (sessionId, events, state) => call(`${base}/api/agent/sessions/${managerId}/codex/${sessionId}/events`, {
    method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, events, ...(state ? { state } : {}) }),
  });
  assert.equal((await seed('seed-system', [{ id: 'seed-system:1', seq: 1, turn_id: '', type: 'system', payload: { text: 'Model set to Smart.' }, created_at: new Date().toISOString() }], { config_options: [], reason: 'config_option' })).status, 200);
  assert.equal((await seed('seed-text', [{ id: 'seed-text:1', seq: 1, turn_id: 't9', type: 'text', payload: { text: 'working…' }, created_at: new Date().toISOString() }])).status, 200);
  assert.equal((await seed('seed-done', [{ id: 'seed-done:1', seq: 1, turn_id: 't9', type: 'turn', payload: { phase: 'finished', stop_reason: 'end_turn' }, created_at: new Date().toISOString() }])).status, 200);
  assert.equal(svc['live'].get(`${managerId}/codex/seed-system`).status, 'idle', 'a lone system row (settings change) does not seed a busy ghost');
  assert.equal(svc['live'].get(`${managerId}/codex/seed-text`).status, 'busy', 'turn-only rows (text) seed busy');
  assert.equal(svc['live'].get(`${managerId}/codex/seed-done`).status, 'ready', 'a finished turn seeds ready');

  stream.close();
});

// 세션 모달의 모델 선택지가 "되는 조합 / 안 되는 조합" 으로 갈리던 문제.
//
// 선택지의 출처는 세 단계다: (1) 이 호스트×CLI 로 세션을 열었을 때 캐시한 ACP configOptions,
// (2) 지금 살아 있는 세션의 선택지, (3) 하트비트의 available_models 로 합성한 model 옵션.
// 3번이 없던 동안에는 **한 번도 세션을 연 적 없는 조합**이면 모델을 아예 못 골랐다.
// 여기서 보는 것은 그 마지막 단계와, 그것이 앞 단계를 덮지 않는다는 것이다.
test('세션 CLI 설정: 세션을 연 적 없는 호스트×CLI 도 하트비트가 보고한 모델로 고를 수 있다', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'model-fallback');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const token = app.get(AuthService).createSession(owner.id);
  const headers = { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  await ds.getRepository('Agent').update({ id: managerId }, { name: 'rolf' });

  // 매니저가 CLI별 모델 목록을 보고한다. 세션은 아직 한 번도 연 적이 없다.
  await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST',
    headers: { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: 'inst-models', agent_id: managerId, mode: 'manager', hostname: 'rolf',
      plugin_version: 'test', cli: 'mixed', cli_adapters: ['claude', 'opencode'],
      acp_session_clis: ['claude', 'opencode'], pid: 1, started_at: new Date().toISOString(),
      available_models: { claude: ['opus', 'sonnet'], opencode: ['opencode/big-pickle'] },
    }),
  });

  const settings = async (cli) => {
    const resp = await call(`${base}/api/agent-sessions/hosts/${managerId}/${cli}/settings`, { headers });
    assert.equal(resp.status, 200, resp.text);
    return resp.body;
  };

  const opencode = await settings('opencode');
  const modelOption = opencode.known_config_options.find((o) => o.category === 'model');
  assert.ok(modelOption, '세션을 연 적 없어도 모델 선택지가 있어야 한다');
  assert.equal(modelOption.config_id, 'model');
  assert.equal(modelOption.type, 'select');
  assert.deepEqual(modelOption.options.map((o) => o.value), ['opencode/big-pickle']);
  // 합성한 값은 "지금 고른 것" 이 아니다 — 세션이 열리면 어댑터가 실제 현재값을 알려준다.
  assert.equal(modelOption.current_value, null);

  const claude = await settings('claude');
  assert.deepEqual(
    claude.known_config_options.find((o) => o.category === 'model').options.map((o) => o.value),
    ['opus', 'sonnet'],
  );

  // 보고된 모델이 없는 CLI 는 빈 선택지 그대로다 — 없는 목록을 지어내지 않는다.
  const unknown = await settings('codex');
  assert.equal(unknown.known_config_options.some((o) => o.category === 'model'), false);
});

// ─── 서버 재시작: 세션을 읽는 것이 driver 를 되찾는다 ────────────────────────────────
//
// driver 는 메모리에만 있다. 서버가 재시작하면(배포 push 한 번이면 일어난다) 사라지고, 매니저가
// 계속 보내오는 이벤트는 "받을 사람이 없다" 는 이유로 조용히 버려진다 — 서버는 세션을 저장하지
// 않으므로 그 대화는 화면에서 통째로 빈다. 진행 중이던 세션은 busy 라 prompt 가 409 고 Connect 도
// 안 나와서, driver 를 쓰기 동작으로만 잡던 예전 규칙에서는 되찾을 길이 아예 없었다(실측: 끝난
// 작업이 "Working" 인 채로 남고 그 뒤 대화가 하나도 안 보였다). 이제 history 로 읽기만 해도 잡는다.
test('server restart: reading the session re-claims the driver so the live stream resumes', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'agent-sessions-redriver');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner-redriver', role: 'admin' });
  const ownerToken = app.get(AuthService).createSession(owner.id);
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder-redriver', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  await ds.getRepository('Agent').update({ id: managerId }, { name: 'rolf' });
  const managerHeaders = { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' };
  assert.ok((await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-redriver', agent_id: managerId, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude'], acp_session_clis: ['claude'], pid: 4243, started_at: new Date().toISOString(),
    }),
  })).status < 300, 'manager registered');

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));
  const answered = new Set();
  const answerNext = async (op, body) => {
    await waitFor(() => requests.some((r) => r.op === op && !answered.has(r.request_id)), `${op} rpc`);
    const req = requests.find((r) => r.op === op && !answered.has(r.request_id));
    answered.add(req.request_id);
    const res = await call(`${base}/api/agent/sessions/rpc/${req.request_id}`, { method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, ...body }) });
    assert.equal(res.status, 200, res.text);
    return req;
  };
  const stream = await openSseStream(port, ownerToken, {});
  t.after(() => stream.close());

  // 이 앱은 "막 재시작한 서버" 다 — 이 세션에 대해 아무 기억이 없는데 매니저는 턴 도중이다.
  const sid = 'sess-redriver';
  const sessionsUrl = `${base}/api/agent-sessions/hosts/${managerId}/claude/sessions`;
  const relay = async (events, state) => {
    const res = await call(`${base}/api/agent/sessions/${managerId}/claude/${sid}/events`, {
      method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, events, ...(state ? { state } : {}) }),
    });
    assert.equal(res.status, 200, res.text);
    return res.body;
  };
  const textRow = (seq, text) => ({ id: `${sid}:live:${seq}`, seq, turn_id: 't9', type: 'text', payload: { text }, created_at: new Date().toISOString() });

  const orphan = await relay([textRow(1, 'still working')]);
  assert.equal(orphan.relayed, 1, 'the manager can relay into a session the restarted server has never seen');

  // 1. 아직 아무도 driver 가 아니다 — 이 프레임은 갈 곳이 없다.
  assert.equal((await stream.drainOfType('agent_session_event', 300)).length, 0, 'no driver yet, so nothing is delivered');

  // 2. 사용자가 세션 화면에 (다시) 들어온다 = history 읽기. 매니저가 여전히 busy 라고 답한다.
  const detailCall = call(`${sessionsUrl}/${sid}`, { headers: ownerHeaders });
  await answerNext('history', {
    ok: true,
    result: {
      session: { session_id: sid, cwd: '/home/parn/repo', title: 'Long turn', updated_at: '2026-09-25T02:20:00.000Z', source: 'cli' },
      events: [textRow(1, 'still working')],
      truncated: false,
      live: { session_id: sid, cwd: '/home/parn/repo', title: 'Long turn', status: 'busy', resume_supported: true },
    },
  });
  const detail = await detailCall;
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.live.status, 'busy');
  assert.equal(detail.body.live.driver_user_id, owner.id, '세션을 읽은 사용자가 driver 가 된다');

  // 3. 이후 매니저가 중계하는 이벤트·상태가 그 사용자에게 흐른다 — 턴이 끝나면 화면도 따라 끝난다.
  await relay([textRow(2, 'done at last')]);
  await stream.waitFor('agent_session_event', (d) => d?.session_id === sid && d.event?.payload?.text === 'done at last', 4000);
  await relay([{ id: `${sid}:live:3`, seq: 3, turn_id: 't9', type: 'turn', payload: { phase: 'finished', stop_reason: 'end_turn' }, created_at: new Date().toISOString() }], { status: 'ready', reason: 'turn_finished' });
  await stream.waitFor('agent_session_update', (d) => d?.session?.session_id === sid && d.session.status === 'ready', 4000);

  stream.close();
});
