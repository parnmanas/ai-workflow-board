// 세션 연결 실패의 **사유가 화면에 남는다**.
//
// 고치는 증상(실측, ralf/codex): 터미널이나 Codex 앱에서 이미 열려 있는 스레드를 AWB 에서
// Connect 하면 codex 가 `thread … already has an active writer` 로 거절한다. 매니저는 그
// 사유를 정확히 돌려주고 서버도 그것을 HTTP 오류 본문에 실었지만, 세션 상태에는 아무것도
// 적지 않았다. 화면은 토스트를 한 번 띄우고 끝이라 그게 사라지면 "Connect 눌렀는데 실패"
// 말고는 근거가 남지 않았다 — 사용자는 왜 실패했는지 알 방법이 없었다.
//
// 그래서 고정하는 것: open RPC 가 실패하면 그 세션의 라이브 상태가 `error` 가 되고
// `last_error` 에 매니저가 말한 사유가 그대로 들어가며, driver 에게 SSE 로도 나간다.
// (화면의 빨간 배너는 그 두 값을 읽는다.)

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createWorkspace, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

process.env.PORT = process.env.AGENT_SESSION_OPEN_FAILURE_PORT || '0';

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

test('open 이 실패하면 그 사유가 세션 상태에 남고 driver 에게 전달된다', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'open-failure');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const token = app.get(AuthService).createSession(owner.id);
  const headers = { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'codex' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  await ds.getRepository('Agent').update({ id: managerId }, { name: 'ralf' });
  const managerHeaders = { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' };
  await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-ralf-1', agent_id: managerId, mode: 'manager', hostname: 'ralf', plugin_version: 'test',
      cli: 'codex', cli_adapters: ['codex'], acp_session_clis: ['codex'], pid: 99,
      started_at: new Date().toISOString(),
    }),
  });

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));

  const stream = await openSseStream(port, token, {});
  t.after(() => stream.close());

  const SESSION_ID = '01a0e005-ccaa-7512-b4fb-b7278d260e33';
  // 매니저가 실제로 돌려주는 문구 그대로.
  const REASON = 'codex could not resume this session: thread 01a0e005-ccaa-7512-b4fb-b7278d260e33 already has an active writer.'
    + ' 이 세션이 그 장비의 다른 곳(터미널 또는 Codex 앱)에서 아직 열려 있습니다. 거기서 닫은 뒤 다시 Connect 하세요.';

  const openCall = call(`${base}/api/agent-sessions/hosts/${managerId}/codex/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ session_id: SESSION_ID }),
  });
  await waitFor(() => requests.some((r) => r.op === 'open'), 'open rpc');
  const req = requests.find((r) => r.op === 'open');
  await call(`${base}/api/agent/sessions/rpc/${req.request_id}`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ manager_id: managerId, ok: false, error: REASON, code: 'resume_locked' }),
  });

  // 1. HTTP 응답이 사유를 그대로 싣는다 — 화면 토스트가 읽는 값.
  const failed = await openCall;
  assert.equal(failed.status, 502, failed.text);
  assert.equal(failed.body.error, 'resume_locked', '기계가 분기할 코드는 보존된다');
  assert.equal(failed.body.message, REASON, '사람이 읽을 사유가 그대로 온다');

  // 2. driver 에게 SSE 로도 나간다 — 토스트를 놓쳐도 화면이 상태로 안다.
  const update = await stream.waitFor(
    'agent_session_update',
    (d) => d?.session?.session_id === SESSION_ID && d.reason === 'open_failed',
    4000,
  );
  assert.equal(update.data.session.status, 'error');
  assert.equal(update.data.session.last_error, REASON);
  // 기계용 코드도 함께 남는다 — 화면은 이 코드로 "강제로 열기" 를 낼지 정한다.
  assert.equal(update.data.session.last_error_code, 'resume_locked');

  // 3. 그리고 그 상태가 **남는다** — 다시 조회해도 같은 사유를 돌려준다.
  //    (배너가 토스트와 달리 계속 보이는 근거.) 조회는 기록 RPC 를 한 번 더 태우므로
  //    그것도 답해 준다 — 여기서 보려는 것은 기록이 아니라 살아남은 last_error 다.
  const afterCall = call(`${base}/api/agent-sessions/hosts/${managerId}/codex/sessions/${SESSION_ID}`, { headers });
  await waitFor(() => requests.some((r) => r.op === 'history'), 'history rpc');
  const historyReq = requests.find((r) => r.op === 'history');
  await call(`${base}/api/agent/sessions/rpc/${historyReq.request_id}`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ manager_id: managerId, ok: true, result: { session: null, events: [], truncated: false } }),
  });
  const after = await afterCall;
  assert.equal(after.status, 200, after.text);
  assert.equal(after.body.live.status, 'error');
  assert.equal(after.body.live.last_error, REASON);
  // 다시 조회해도 코드가 남는다. 예전엔 버튼이 그 페이지의 Connect 실패 순간에만 켜져서, 세션을 다시
  // 열면 문구만 보이고 "강제로 열기" 는 사라졌다(실측: ralf 의 ChatGPT 앱이 codex 스레드를 쥔 경우).
  assert.equal(after.body.live.last_error_code, 'resume_locked');
});

test('세션 id 없이 새로 여는 경우는 붙일 곳이 없으므로 상태를 만들지 않는다', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'open-failure-new');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner2', role: 'admin' });
  const token = app.get(AuthService).createSession(owner.id);
  const headers = { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder2', type: 'codex' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  const managerHeaders = { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' };
  await ds.getRepository('Agent').update({ id: managerId }, { name: 'ralf2' });
  await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-ralf-2', agent_id: managerId, mode: 'manager', hostname: 'ralf2', plugin_version: 'test',
      cli: 'codex', cli_adapters: ['codex'], acp_session_clis: ['codex'], pid: 98,
      started_at: new Date().toISOString(),
    }),
  });

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));

  const openCall = call(`${base}/api/agent-sessions/hosts/${managerId}/codex/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ cwd: '/srv/work' }),
  });
  await waitFor(() => requests.some((r) => r.op === 'open'), 'open rpc');
  const req = requests.find((r) => r.op === 'open');
  await call(`${base}/api/agent/sessions/rpc/${req.request_id}`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ manager_id: managerId, ok: false, error: 'codex is not installed on this host', code: 'spawn_failed' }),
  });

  const failed = await openCall;
  assert.equal(failed.status, 502, failed.text);
  // 사유는 여전히 응답으로 간다(토스트가 읽는다). 다만 붙일 세션 id 가 없으니
  // 유령 세션 행을 만들어 목록을 더럽히지는 않는다.
  assert.equal(failed.body.message, 'codex is not installed on this host');
});

// `force` 는 파괴적 플래그다 — 켜지면 그 장비의 남의 프로세스가 죽는다. 그래서 두 가지를
// 서로 다른 곳에서 본다:
//
//   - **켜는 조건**(정확히 `true` 일 때만, 자동 연결은 절대 안 켠다) → 이 테스트.
//     서버 이벤트 이미터에서 읽으므로 빠르고 결정적이다.
//   - **wire 까지 살아서 가는가** → `test/event-registry-payload-parity-guard.test.mjs`.
//     event-registry 의 `map()` 이 선언된 payload 필드를 전부 실어 보내는지 전 이벤트에
//     대해 기계적으로 검사한다. 실제로 이 필드를 처음 넣을 때 registry 에 빠뜨렸고 그
//     가드가 잡았다 — 여기서 필드별로 흉내 내지 않고 그 가드에 맡긴다.
test('force 는 요청한 때만 매니저에게 실린다 — 자동 연결이 남의 프로세스를 죽이지 않는다', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'open-force');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner3', role: 'admin' });
  const token = app.get(AuthService).createSession(owner.id);
  const headers = { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder3', type: 'codex' });
  const managerId = agent.manager_agent_id;
  const managerHeaders = { 'X-Agent-Key': runtimeHostKeyForAgent(agent.id), 'Content-Type': 'application/json' };
  await ds.getRepository('Agent').update({ id: managerId }, { name: 'ralf3' });
  await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-ralf-3', agent_id: managerId, mode: 'manager', hostname: 'ralf3', plugin_version: 'test',
      cli: 'codex', cli_adapters: ['codex'], acp_session_clis: ['codex'], pid: 97,
      started_at: new Date().toISOString(),
    }),
  });

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));

  const SESSION_ID = '01a0e005-ccaa-7512-b4fb-b7278d260e34';
  /** 아직 답하지 않은 open 요청 하나를 집어 실패로 답한다. */
  const takeOpen = async (label) => {
    await waitFor(() => requests.some((r) => r.op === 'open' && !r.answered), `open rpc (${label})`);
    const req = requests.find((r) => r.op === 'open' && !r.answered);
    req.answered = true;
    await call(`${base}/api/agent/sessions/rpc/${req.request_id}`, {
      method: 'POST', headers: managerHeaders,
      body: JSON.stringify({ manager_id: managerId, ok: false, error: `locked (${label})`, code: 'resume_locked_external' }),
    });
    return req;
  };

  // 1. 평범한 Connect(그리고 화면의 자동 연결)는 force 를 켜지 않는다. 여기서 켜지면
  //    페이지를 여는 것만으로 남의 Codex 앱이 죽는다.
  const plain = call(`${base}/api/agent-sessions/hosts/${managerId}/codex/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ session_id: SESSION_ID }),
  });
  assert.equal((await takeOpen('plain')).force, false);
  const plainRes = await plain;
  assert.equal(plainRes.body.error, 'resume_locked_external', '주인을 특정했다는 코드가 화면까지 보존된다');

  // 2. 확인을 거친 재요청만 force 를 싣는다.
  const forced = call(`${base}/api/agent-sessions/hosts/${managerId}/codex/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ session_id: SESSION_ID, force: true }),
  });
  assert.equal((await takeOpen('forced')).force, true);
  await forced;

  // 3. 문자열 'true' 같은 느슨한 값은 켜지지 않는다 — 파괴적 플래그는 정확히 true 만.
  const sloppy = call(`${base}/api/agent-sessions/hosts/${managerId}/codex/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ session_id: SESSION_ID, force: 'true' }),
  });
  assert.equal((await takeOpen('sloppy')).force, false);
  await sloppy;
});
