// 재시작으로 끊긴 작업 — docs/voice-operator.md "재시작으로 끊긴 작업", docs/agent-manager.md "Self-update policy".
//
// agent-manager 업데이트는 돌고 있는 작업을 기다리지 않는다. 매니저가 재시작 직전에 끊길 작업을 저장했다가
// 새 프로세스가 연결되면 `POST /api/agent-manager/restart-resume` 으로 넘긴다. 실제 앱과 가짜 Runtime Host 로:
//   1. 이 호스트의 티켓만 다시 보낸다(manager_restart) — 다른 호스트의 티켓·없는 티켓은 건너뛴다.
//   2. 끊긴 Agent Session 은 그 호스트의 operator 에게 "중단됨" 으로 보고된다(재개 도구 안내 포함).
//   3. operator 가 resume_interrupted_session 을 부르면 고정된 재개 문구가 그 세션의 계정·사용자로 간다.
//   4. 한 번만 · 기록된 세션만 · operator 연결만 · 자기 세션은 아니다.
//   5. restart_agent 의 resume-triggers 도 다시 동작한다(P4c-4 에서 지워져 404 였다).
//
// 실행: node --test --test-force-exit test/manager-restart-resume.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createAccount, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { runtimeIdentityKey } from '../dist/common/runtime-spec.js';
import { SESSION_RESUME_PREFIX } from '../dist/modules/voice/interrupted-sessions.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';

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
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('a planned restart hands its interrupted work to AWB: tickets re-sent, sessions continued by the operator', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const base = `http://localhost:${port}`;

  const ws = await createAccount(app, getDataSourceToken, 'restart-resume');
  const admin = await createUser(app, getDataSourceToken, { name: 'admin', role: 'admin' });
  const userHeaders = {
    Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}`, 'X-Account-Id': ws.id, 'Content-Type': 'application/json',
  };
  const host = await createAgent(app, getDataSourceToken, ws.id, { name: 'rolf', type: 'manager' });
  const hostKey = runtimeHostKeyForAgent(host.id);
  const managerHeaders = { 'X-Agent-Key': hostKey, 'Content-Type': 'application/json' };
  const spec = { manager_agent_id: host.id, cli: 'claude', model: null, working_dir: '/srv/game', credential_id: null, runtime_config: { strategy: 'single', permission_mode: 'strict' }, label: 'game/claude' };
  const key = runtimeIdentityKey(spec);
  const heartbeat = await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-rolf', agent_id: host.id, host_id: host.id, mode: 'manager', hostname: 'rolf', plugin_version: '1.6.95',
      cli: 'claude', cli_adapters: ['claude', 'codex'], acp_session_clis: ['claude', 'codex'], pid: 4242, started_at: new Date().toISOString(),
      // The assignee runtime is already prepared on this host — dispatch does not wait for a spawn_agent ack.
      agent_credentials: [{ agent_id: key, cli: 'claude', kind: 'operator_home', expires_at_ms: null, refresh_token_present: false }],
    }),
  });
  assert.ok(heartbeat.status < 300, heartbeat.text);

  const requests = [];
  const triggers = [];
  const onRequest = (payload) => requests.push(payload);
  const onTrigger = (payload) => triggers.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  activityEvents.on('agent_trigger', onTrigger);
  t.after(() => {
    activityEvents.removeListener('agent_session_request', onRequest);
    activityEvents.removeListener('agent_trigger', onTrigger);
  });
  const relay = (cli, sessionId, events, state) => call(`${base}/api/agent/sessions/${host.id}/${cli}/${sessionId}/events`, {
    method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: host.id, events, ...(state ? { state } : {}) }),
  });
  const promptsTo = (sessionId) => requests.filter((r) => r.op === 'prompt' && r.session_id === sessionId);

  const registered = await call(`${base}/api/voice/operators`, {
    method: 'POST', headers: userHeaders,
    body: JSON.stringify({ name: 'Jarvis', manager_id: host.id, cli: 'claude', session_id: 'op-1', title: 'Jarvis' }),
  });
  assert.equal(registered.status, 201, registered.text);
  const mcp = (sessionId) => new McpClient({
    baseUrl: base, apiKey: hostKey, clientInfo: { name: 'claude-agent-acp', version: 'test' },
    extraHeaders: { 'X-AWB-Client-Type': 'agent-session', 'X-AWB-Session-Id': sessionId },
  });
  const operator = mcp('op-1');

  // The user had a Codex session working when the manager updated itself. The old process closed it
  // (status idle, reason self_update_restart) on the way out.
  const work = await call(`${base}/api/agent-sessions/hosts/${host.id}/codex/sessions/sess-work/prompt`, {
    method: 'POST', headers: userHeaders, body: JSON.stringify({ text: '빌드 고쳐 줘' }),
  });
  assert.equal(work.status, 202, work.text);
  await relay('codex', 'sess-work', [{ type: 'turn', payload: { phase: 'started' }, turn_id: work.body.turn_id }], { status: 'busy', reason: 'turn_started' });
  await relay('codex', 'sess-work', [{ type: 'system', payload: { text: 'Agent process stopped (self_update_restart).' } }], { status: 'idle', reason: 'self_update_restart' });

  // A ticket this host was working, and one assigned to another host.
  const mine = await call(`${base}/api/accounts/${ws.id}/tickets`, { method: 'POST', headers: userHeaders, body: JSON.stringify({ title: 'terrain', assignee: spec }) });
  assert.equal(mine.status, 201, mine.text);
  await waitFor(() => triggers.find((x) => x.ticket_id === mine.body.id && x.trigger_source === 'start'), 'the ticket started on this host');
  const theirs = await call(`${base}/api/accounts/${ws.id}/tickets`, {
    method: 'POST', headers: userHeaders, body: JSON.stringify({ title: 'other host', assignee: { ...spec, manager_agent_id: 'other-host' } }),
  });
  assert.equal(theirs.status, 201, theirs.text);

  // 1. The new manager process hands over what the restart interrupted.
  const startedAt = new Date(Date.now() - 12 * 60_000).toISOString();
  const resumed = await call(`${base}/api/agent-manager/restart-resume`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      // host_id is only read when no key was validated (test boot runs AGENT_DEV_MODE).
      host_id: host.id, version: 1, reason: 'self_update_restart', from_version: '1.6.94', to_version: '1.6.95', saved_at: new Date().toISOString(),
      sessions: [{ cli: 'codex', session_id: 'sess-work', cwd: '/srv/work', title: 'Fix build', state: 'turn', turn_started_at: startedAt }],
      tickets: [
        { ticket_id: mine.body.id, role: 'assignee', agent_id: key },
        { ticket_id: theirs.body.id, role: 'assignee', agent_id: key },
        { ticket_id: 'no-such-ticket', role: 'assignee', agent_id: key },
      ],
    }),
  });
  assert.equal(resumed.status, 200, resumed.text);
  assert.deepEqual(resumed.body.tickets.resumed, [mine.body.id]);
  assert.deepEqual(resumed.body.tickets.skipped.map((s) => s.reason).sort(), ['not_found', 'not_this_host']);
  await waitFor(() => triggers.find((x) => x.ticket_id === mine.body.id && x.trigger_source === 'manager_restart'), 'the interrupted ticket is re-sent');
  assert.equal(triggers.filter((x) => x.ticket_id === theirs.body.id).length, 0, 'another host\'s ticket is not this manager\'s to resume');

  // 2. The operator on that host hears about the interrupted session, with the way to continue it.
  const report = await waitFor(() => promptsTo('op-1')[0], 'interrupted report to the operator');
  assert.match(report.text, /^\[AWB 작업 보고\]/);
  assert.ok(report.text.includes(`1. 중단됨 — ${host.name} / Codex · 'Fix build'`), report.text);
  assert.match(report.text, /Agent Manager 업데이트 \(v1\.6\.94 → v1\.6\.95\)로 끊겼습니다 — 끊길 때: 턴 실행 중, 턴 시작 후 12분/);
  assert.match(report.text, /resume_interrupted_session\(manager_id, cli, session_id\) 으로 재개하세요/);
  assert.ok(report.text.includes(`세션: manager_id="${host.id}", cli="codex", session_id="sess-work"`), report.text);
  await relay('claude', 'op-1', [{ type: 'turn', payload: { phase: 'started' }, turn_id: report.turn_id }], { status: 'busy', reason: 'turn_started' });

  // 3. The operator continues it — a fixed text, in the session's own account, for the user who drove it.
  const target = { manager_id: host.id, cli: 'codex', session_id: 'sess-work' };
  assert.equal((await mcp('sess-other').callTool('resume_interrupted_session', target)).error.code, 'not_an_operator');
  assert.equal((await operator.callTool('resume_interrupted_session', { ...target, session_id: 'never-cut' })).error.code, 'not_interrupted');
  assert.equal((await operator.callTool('resume_interrupted_session', { manager_id: host.id, cli: 'claude', session_id: 'op-1' })).error.code, 'own_session');
  const done = await operator.callTool('resume_interrupted_session', target);
  assert.equal(done.isError, undefined, JSON.stringify(done));
  assert.equal(done.resumed, true);
  const sent = await waitFor(() => promptsTo('sess-work').find((r) => r.turn_id === done.turn_id), 'the resume prompt reaches the session');
  assert.ok(sent.text.startsWith(`${SESSION_RESUME_PREFIX} Agent Manager 가 재시작(업데이트)되면서`), sent.text);
  assert.equal(sent.account_id, ws.id, 'it opens with the session\'s own pinned account');
  assert.equal(sent.driver_user_id, admin.id, 'for the user who was driving it');

  // 4. Once per interruption.
  assert.equal((await operator.callTool('resume_interrupted_session', target)).error.code, 'already_resumed');

  // 5. restart_agent's re-push works again — only for tickets of that runtime on this host.
  const repush = await call(`${base}/api/agent-manager/managed-agents/${key}/resume-triggers`, {
    method: 'POST', headers: managerHeaders, body: JSON.stringify({ host_id: host.id, items: [{ ticket_id: mine.body.id, role: 'assignee' }, { ticket_id: theirs.body.id, role: 'assignee' }] }),
  });
  assert.equal(repush.status, 200, repush.text);
  assert.deepEqual([repush.body.emitted, repush.body.skipped], [1, 1]);
});
