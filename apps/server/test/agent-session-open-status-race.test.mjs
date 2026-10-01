// `open` RPC 응답이 **그 사이 앞서 나간 상태를 과거로 되돌리지 않는다**.
//
// 고치는 증상(실측 2026-10-01): 세션이 "돌고 있는데 ready" 로 영구히 고착됐다.
//
// 메커니즘: `open` RPC 는 최대 2분까지 걸린다. 페이지에 들어오면 idle 세션마다 자동
// 연결이 걸리므로 그 창이 늘 열려 있고, 그 사이 프롬프트가 들어오면 매니저가 밀어 주는
// 이벤트 패치로 상태는 busy 가 된다. 그런데 RPC 가 돌아온 뒤 서버가 open 결과의
// status(없으면 'ready')를 **무조건** 덮어써서 busy 를 ready 로 되돌렸다. 서버의 재조정은
// edge-triggered 라("보고된 상태 == 내 상태면 그냥 반환") 교정 SSE 도 오지 않아 그대로
// 고착됐다. 클라이언트가 busy 를 못 보면 컴포저는 입력한 프롬프트를 전송하지 않고 조용히
// 큐에 쌓으므로, 상태 버그가 "안 보내진다" 로 번졌다.
//
// 고정하는 것: RPC 전 세대를 기억해 두고, 그 사이 상태가 앞서 나갔으면 open 결과의
// status 는 버린다(구조 정보는 그대로 반영한다 — 그건 세션의 정적 성질이다).
// 반대로 앞서 나가지 않았으면 예전처럼 open 결과를 그대로 쓴다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createWorkspace, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';

process.env.PORT = process.env.AGENT_SESSION_OPEN_RACE_PORT || '0';

async function call(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, text, body };
}

function waitFor(predicate, label, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const SESSION_ID = '01a0e005-ccaa-7512-b4fb-b7278d260e34';

/** 공통 준비: 워크스페이스·관리자·매니저 하트비트까지. */
async function setup(t) {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const base = `http://localhost:${port}`;
  const ws = await createWorkspace(app, getDataSourceToken, 'open-status-race');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const token = app.get(AuthService).createSession(owner.id);
  const headers = { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerHeaders = { 'X-Agent-Key': runtimeHostKeyForAgent(agent.id), 'Content-Type': 'application/json' };
  await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-race-1', agent_id: managerId, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude'], acp_session_clis: ['claude'], pid: 99,
      started_at: new Date().toISOString(),
    }),
  });
  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));
  return { base, headers, managerHeaders, managerId, requests };
}

test('open RPC 중에 busy 로 앞서 나간 상태를 open 결과가 ready 로 되돌리지 않는다', async (t) => {
  const { base, headers, managerHeaders, managerId, requests } = await setup(t);

  // 1. 연결 시작 — RPC 는 아직 답하지 않는다(실제로 최대 2분 걸리는 구간).
  const openCall = call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ session_id: SESSION_ID }),
  });
  await waitFor(() => requests.some((r) => r.op === 'open'), 'open rpc');

  // 2. 그 사이 프롬프트가 돌기 시작해 매니저가 busy 를 밀어 넣는다.
  const relayed = await call(`${base}/api/agent/sessions/${managerId}/claude/${SESSION_ID}/events`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ manager_id: managerId, events: [], state: { status: 'busy' } }),
  });
  assert.equal(relayed.status, 200, relayed.text);
  assert.equal(relayed.body.live.status, 'busy', '매니저가 밀어 넣은 busy 가 반영돼야 한다');

  // 3. 이제야 open RPC 가 답한다 — status 를 싣지 않으므로 예전 코드는 'ready' 로 덮었다.
  const req = requests.find((r) => r.op === 'open');
  await call(`${base}/api/agent/sessions/rpc/${req.request_id}`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      manager_id: managerId, ok: true,
      result: { session_id: SESSION_ID, cwd: '/srv/app', resume_supported: true, config_options: [] },
    }),
  });

  const opened = await openCall;
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.body.status, 'busy', 'open 응답이 더 최신인 busy 를 과거로 되돌리면 안 된다');
  // 구조 정보는 반영된다 — 그건 시간에 민감한 값이 아니다.
  assert.equal(opened.body.resume_supported, true);
});

test('앞서 나가지 않았으면 open 결과의 status 를 그대로 쓴다 — 가드가 정상 경로를 막지 않는다', async (t) => {
  const { base, headers, managerHeaders, managerId, requests } = await setup(t);

  const openCall = call(`${base}/api/agent-sessions/hosts/${managerId}/claude/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ session_id: SESSION_ID }),
  });
  await waitFor(() => requests.some((r) => r.op === 'open'), 'open rpc');
  const req = requests.find((r) => r.op === 'open');
  await call(`${base}/api/agent/sessions/rpc/${req.request_id}`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      manager_id: managerId, ok: true,
      result: { session_id: SESSION_ID, cwd: '/srv/app', status: 'ready', resume_supported: true },
    }),
  });
  const opened = await openCall;
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.body.status, 'ready');
});
