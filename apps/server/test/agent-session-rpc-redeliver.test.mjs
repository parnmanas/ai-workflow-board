// 매니저 스트림이 없는 동안 보낸 세션 읽기 요청은, 스트림이 다시 붙으면 **다시 보낸다**.
//
// 운영 보고(2026-10-02): 서버를 재시작하고 매니저가 다시 붙은 뒤에도 사이드바의 그 호스트 세션이
// 빈 채로 남았다. 서버 로그: 재시작 직후 rolf 에 보낸 `list` 4건이 전부 timeout. 매니저는
// 하트비트(HTTP)와 SSE 를 따로 다시 붙이는데, 하트비트가 먼저면 호스트가 "연결됨" 으로 보이고
// 화면이 곧바로 목록을 묻는다 — 그 요청은 SSE 로만 가므로 아직 스트림이 없는 매니저에게는
// 사라지고 20초 뒤 timeout 이었다.
//
// 고정하는 것:
//   1. 스트림이 없을 때 보낸 list 는, 스트림이 붙으면 **같은 request_id 로** 다시 나간다 — 응답하면 풀린다.
//   2. 스트림이 있을 때 보낸 요청은 다시 나가지 않는다(재연결이 일어나도 이미 풀린 요청은 건드리지 않는다).
// 실행: node --test --test-force-exit test/agent-session-rpc-redeliver.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createWorkspace, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('스트림이 없을 때 보낸 list 는 매니저 스트림이 붙으면 다시 나가고, 응답으로 풀린다', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const base = `http://localhost:${port}`;
  const { AgentConnectivityRegistry } = await import('../dist/services/agent-connectivity.registry.js');
  const connectivity = app.get(AgentConnectivityRegistry);

  const ws = await createWorkspace(app, getDataSourceToken, 'session-redeliver');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const ownerHeaders = { Authorization: `Bearer ${app.get(AuthService).createSession(owner.id)}`, 'X-Workspace-Id': ws.id };
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerHeaders = { 'X-Agent-Key': runtimeHostKeyForAgent(agent.id), 'Content-Type': 'application/json' };

  // 재시작 직후: 하트비트는 들어왔지만 매니저 SSE 는 아직 없다.
  const hb = await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-redeliver', agent_id: managerId, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude'], acp_session_clis: ['claude'], pid: 1, started_at: new Date().toISOString(),
    }),
  });
  assert.ok(hb.status < 300, hb.text);
  assert.equal(connectivity.isReachable(managerId), false, '전제: 매니저 스트림이 없다');

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));

  const listCall = call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions`, { headers: ownerHeaders });
  await waitFor(() => requests.some((r) => r.op === 'list'), 'first list emission');
  const requestId = requests.find((r) => r.op === 'list').request_id;
  // 스트림이 없으니 이 이벤트는 실제로는 아무에게도 가지 않았다. 매니저가 붙기 전엔 다시 보내지 않는다.
  await sleep(1300);
  assert.equal(requests.filter((r) => r.request_id === requestId).length, 1, '붙기 전에는 재전송하지 않는다');

  // 매니저 SSE 가 붙는다.
  connectivity.noteConnected('sse-redeliver-1', managerId);
  t.after(() => connectivity.noteDisconnected('sse-redeliver-1'));
  await waitFor(() => requests.filter((r) => r.request_id === requestId).length === 2, 'redelivered list', 4000);

  const answered = await call(`${base}/api/agent/sessions/rpc/${requestId}`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ manager_id: managerId, ok: true, result: { sessions: [
      { session_id: 'sess-after-reboot', cwd: '/srv/repo', title: 'still here', updated_at: '2026-10-02T12:00:00.000Z', source: 'cli' },
    ] } }),
  });
  assert.ok(answered.status < 300, answered.text);
  const list = await listCall;
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.map((s) => s.session_id), ['sess-after-reboot'], '재전송된 요청의 답이 화면에 간다 — timeout 이 아니다');

  // 2. 스트림이 있을 때 보낸 요청은 재연결이 와도 다시 나가지 않는다.
  const second = call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions`, { headers: ownerHeaders });
  await waitFor(() => requests.filter((r) => r.op === 'list').length === 3, 'second list emission');
  const secondId = requests.filter((r) => r.op === 'list')[2].request_id;
  connectivity.noteDisconnected('sse-redeliver-1');
  connectivity.noteConnected('sse-redeliver-2', managerId);
  t.after(() => connectivity.noteDisconnected('sse-redeliver-2'));
  await sleep(1300);
  assert.equal(requests.filter((r) => r.request_id === secondId).length, 1, '닿았던 요청은 다시 보내지 않는다');
  await call(`${base}/api/agent/sessions/rpc/${secondId}`, {
    method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, ok: true, result: { sessions: [] } }),
  });
  assert.equal((await second).status, 200);
});
