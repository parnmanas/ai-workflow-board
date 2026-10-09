// 음성 지원 스위치(사이드바 OPERATORS 의 👂 on/off) → 세션 완료 보고 — docs/voice-operator.md "음성 지원 · 잠들기".
//
// 스위치는 단말마다 따로라 화면이 `PUT /api/voice/support { device_id, enabled }` 로 서버에 알린다. 사용자의 단말이
// 모두 꺼져 있으면 세션이 일을 끝내도 operator 에게 보고하지 않고, 켜면 다시 보고한다. 실제 앱과 가짜 Runtime Host 로:
//   1. 입력 검증(device_id · enabled).
//   2. OFF → 세션 턴이 끝나도 operator 에게 보고 프롬프트가 가지 않는다.
//   3. ON → 다음 턴의 완료가 operator 에게 보고된다.
//
// 실행: node --test --test-force-exit test/voice-support-switch.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createAccount, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('turning voice support off on the device stops session completion reports to the operator; on resumes them', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const base = `http://localhost:${port}`;
  const ws = await createAccount(app, getDataSourceToken, 'voice-support');
  const admin = await createUser(app, getDataSourceToken, { name: 'admin', role: 'admin' });
  const headers = { Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}`, 'X-Account-Id': ws.id, 'Content-Type': 'application/json' };
  const host = await createAgent(app, getDataSourceToken, ws.id, { name: 'rolf', type: 'manager' });
  const managerHeaders = { 'X-Agent-Key': runtimeHostKeyForAgent(host.id), 'Content-Type': 'application/json' };
  const hb = await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ instance_id: 'inst-rolf', agent_id: host.id, host_id: host.id, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude', 'codex'], acp_session_clis: ['claude', 'codex'], pid: 4242, started_at: new Date().toISOString() }),
  });
  assert.ok(hb.status < 300, hb.text);
  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));
  const relay = (cli, sessionId, events, state) => call(`${base}/api/agent/sessions/${host.id}/${cli}/${sessionId}/events`, {
    method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: host.id, events, ...(state ? { state } : {}) }),
  });
  const reportsToOperator = () => requests.filter((r) => r.op === 'prompt' && r.session_id === 'op-1');
  const workTurn = async (text) => {
    const sent = await call(`${base}/api/agent-sessions/hosts/${host.id}/codex/sessions/sess-work/prompt`, { method: 'POST', headers, body: JSON.stringify({ text }) });
    assert.equal(sent.status, 202, sent.text);
    const turnId = sent.body.turn_id;
    await relay('codex', 'sess-work', [{ type: 'turn', payload: { phase: 'started' }, turn_id: turnId }], { status: 'busy', reason: 'turn_started' });
    await relay('codex', 'sess-work', [
      { type: 'text', payload: { text: `${text} — 끝났어요.` }, turn_id: turnId },
      { type: 'turn', payload: { phase: 'finished', stop_reason: 'end_turn' }, turn_id: turnId },
    ], { status: 'ready', reason: 'turn_finished' });
    await pause(150);
  };
  const setSupport = (enabled, device = 'laptop-1') => call(`${base}/api/voice/support`, { method: 'PUT', headers, body: JSON.stringify({ device_id: device, enabled }) });

  const registered = await call(`${base}/api/voice/operators`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'Jarvis', manager_id: host.id, cli: 'claude', session_id: 'op-1', title: 'Jarvis' }),
  });
  assert.equal(registered.status, 201, registered.text);

  // 1. 입력 검증.
  assert.equal((await call(`${base}/api/voice/support`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) })).body.error, 'device_id_required');
  assert.equal((await call(`${base}/api/voice/support`, { method: 'PUT', headers, body: JSON.stringify({ device_id: 'x' }) })).body.error, 'enabled_required');

  // 2. OFF — 세션이 일을 끝내도 operator 에게 가지 않는다.
  const off = await setSupport(false);
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.operator_reports, false);
  await workTurn('꺼 둔 동안의 일');
  assert.equal(reportsToOperator().length, 0, 'OFF: no report prompt to the operator');

  // 3. ON — 다음 완료는 operator 에게 보고된다.
  const on = await setSupport(true);
  assert.equal(on.body.operator_reports, true);
  await workTurn('켠 뒤의 일');
  const reports = reportsToOperator();
  assert.equal(reports.length, 1, 'ON: the completion is reported');
  assert.match(reports[0].text, /^\[AWB 작업 보고\]/);
  assert.match(reports[0].text, /켠 뒤의 일 — 끝났어요/);
  assert.doesNotMatch(reports[0].text, /꺼 둔 동안의 일/, 'what finished while off is not replayed');
});
