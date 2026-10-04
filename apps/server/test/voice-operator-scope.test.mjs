// Operator 의 사이트 전체 권한 — docs/voice-operator.md "권한".
//
// 매니저 키는 페어링 때 한 워크스페이스에 묶인다. operator 로 등록된 Agent Session 의 MCP 연결만 그
// 묶음을 푼다. 고정하는 것:
//   1. 등록 전에는 그 키로 다른 워크스페이스를 다룰 수 없다(워크스페이스 검사 도구가 거부한다).
//   2. 등록되면 **이미 열려 있던 MCP 세션도** 다음 요청부터 다른 워크스페이스를 다룬다.
//   3. 같은 키라도 다른 세션 id 의 연결은 여전히 묶여 있다 — 그 세션이 operator 로 따로 등록되기 전까지.
//   4. operator 가 여럿이면 각자 풀리고, 하나를 해제하면 그 하나만 곧바로 다시 묶인다(캐시를 기다리지 않는다).
//
// 실행: node --test --test-force-exit test/voice-operator-scope.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createWorkspace, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';

test('registered operator sessions manage other workspaces; nothing else on the host does', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const base = `http://localhost:${port}`;

  const home = await createWorkspace(app, getDataSourceToken, 'pairing-home');
  const other = await createWorkspace(app, getDataSourceToken, 'other');
  const admin = await createUser(app, getDataSourceToken, { name: 'admin', role: 'admin' });
  const adminHeaders = { Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}`, 'Content-Type': 'application/json' };
  const manager = await createAgent(app, getDataSourceToken, home.id, { name: 'rolf', type: 'manager' });
  const hostKey = runtimeHostKeyForAgent(manager.id);

  const sessionClient = (sessionId) => new McpClient({
    baseUrl: base,
    apiKey: hostKey,
    clientInfo: { name: 'claude-agent-acp', version: 'test' },
    extraHeaders: { 'X-AWB-Client-Type': 'agent-session', 'X-AWB-Session-Id': sessionId },
  });
  const operator = sessionClient('s-operator');
  const bystander = sessionClient('s-other');
  const touchOther = (client, description) => client.callTool('update_workspace', { workspace_id: other.id, description });
  const denied = (r) => JSON.stringify(r).includes('does not belong to this workspace');

  // 1. 지정 전: 페어링 워크스페이스 밖은 못 다룬다.
  assert.ok(denied(await touchOther(operator, 'before')), 'bound to the pairing workspace before pinning');

  // 2. 등록 → 이미 열린 MCP 세션도 다음 요청부터 풀린다.
  const register = (name, sessionId) => fetch(`${base}/api/voice/operators`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name, manager_id: manager.id, cli: 'claude', session_id: sessionId, title: name }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const jarvis = await register('Jarvis', 's-operator');
  assert.equal(jarvis.status, 201);
  const lifted = await touchOther(operator, 'set by the operator');
  assert.ok(!denied(lifted), `operator may manage another workspace: ${JSON.stringify(lifted)}`);
  const ws = await app.get(getDataSourceToken()).getRepository('Workspace').findOneBy({ id: other.id });
  assert.equal(ws.description, 'set by the operator');

  // 3. 같은 키, 다른 세션 — 여전히 묶여 있다.
  assert.ok(denied(await touchOther(bystander, 'bystander')), 'another session on the same host stays bound');

  // 4. 두 번째 operator — 각자 풀리고, 하나를 해제하면 그 하나만 다시 묶인다.
  const friday = await register('Friday', 's-other');
  assert.equal(friday.status, 201);
  assert.ok(!denied(await touchOther(bystander, 'friday')), 'a second operator is lifted too');
  const unpin = await fetch(`${base}/api/voice/operators/${jarvis.body.operator.id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(unpin.status, 200);
  assert.ok(denied(await touchOther(operator, 'after')), 'unregistering binds the connection again');
  assert.ok(!denied(await touchOther(bystander, 'still friday')), 'the other operator stays lifted');

  // 5. 새로 만든 세션의 연결은 세션 id 대신 매니저가 정한 참조값으로 붙는다 — 하트비트가 대응을 알려 주면 그
  //    세션(여기서는 friday)의 연결로 알아보고 묶음을 푼다.
  const freshFriday = sessionClient('pending-11111111-2222-4333-8444-555555555555');
  assert.ok(denied(await touchOther(freshFriday, 'unknown ref')), 'an unmapped ref is no session at all');
  const hb = await fetch(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: { 'X-Agent-Key': hostKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: 'inst-scope', agent_id: manager.id, host_id: manager.id, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude'], acp_session_clis: ['claude'], pid: 1, started_at: new Date().toISOString(),
      agent_sessions: [{ cli: 'claude', session_id: 's-other', status: 'ready', mcp_session_ref: 'pending-11111111-2222-4333-8444-555555555555' }],
    }),
  });
  assert.ok(hb.status < 300, await hb.text());
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!denied(await touchOther(freshFriday, 'mapped ref')), 'once the host maps the ref, the operator is recognised');
});
