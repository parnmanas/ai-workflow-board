// GET/POST /api/agent-manager/hosts/:managerAgentId/models[/refresh] — 모델이 보이는
// 모든 화면(Agent 다이얼로그 · 팀 슬롯 · 세션 설정 · 새 세션 · Runtime Hosts)이 쓰는 단일 경로.
//
//   - 로그인한 사용자면 누구나(admin 불필요). 비로그인은 401.
//   - GET 은 최신 하트비트의 available_models 와 재열거 시각(available_models_at)을 준다.
//   - POST refresh 는 그 호스트에 refresh_available_models 를 발급하고 **서버가** ack 를
//     기다린 뒤 갱신된 목록을 돌려준다(브라우저 폴링 없음). 오프라인 호스트는 409.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createApiKey, createUser, createWorkspace } from './helpers/fixtures.mjs';

process.env.PORT = process.env.HOST_MODELS_PORT || '0';

const INSTANCE_ID = 'host-models-instance';

test('host models: read from heartbeat, refresh waits for the command ack, auth required, offline → 409', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await app.close(); });
  const base = `http://127.0.0.1:${port}`;
  const { AuthService, getDataSourceToken, activityEvents } = modules;

  const workspace = await createWorkspace(app, getDataSourceToken, 'host-models');
  const manager = await createAgent(app, getDataSourceToken, null, { name: 'ralf', type: 'manager' });
  const managerKey = await createApiKey(app, getDataSourceToken, manager.id, { workspaceId: workspace.id, label: 'ralf-key' });
  const viewer = await createUser(app, getDataSourceToken, { name: 'viewer', role: 'user' });
  const token = app.get(AuthService).createSession(viewer.id);
  const userHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const managerHeaders = { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' };

  const heartbeat = (available_models, available_models_at) =>
    fetch(`${base}/api/agent/instance-heartbeat`, {
      method: 'POST',
      headers: managerHeaders,
      body: JSON.stringify({
        instance_id: INSTANCE_ID, agent_id: manager.id, mode: 'manager', hostname: 'ralf', plugin_version: 'test',
        cli: 'mixed', cli_adapters: ['claude', 'opencode'], pid: 1, started_at: new Date().toISOString(),
        available_models, available_models_at,
      }),
    });
  const readJson = async (resp, expected) => {
    const text = await resp.text();
    assert.equal(resp.status, expected, text);
    return text ? JSON.parse(text) : null;
  };

  await readJson(await heartbeat({ claude: ['opus'], opencode: ['opencode/big-pickle'] }, '2026-09-26T00:00:00.000Z'), 201);

  // 1. auth + snapshot
  assert.equal((await fetch(`${base}/api/agent-manager/hosts/${manager.id}/models`)).status, 401, 'no session → 401');
  const snap = await readJson(await fetch(`${base}/api/agent-manager/hosts/${manager.id}/models`, { headers: userHeaders }), 200);
  assert.equal(snap.manager_agent_id, manager.id);
  assert.equal(snap.manager_name, manager.name);
  assert.equal(snap.is_online, true);
  assert.equal(snap.instance_id, INSTANCE_ID);
  assert.equal(snap.refreshed_at, '2026-09-26T00:00:00.000Z');
  assert.deepEqual(snap.models, { claude: ['opus'], opencode: ['opencode/big-pickle'] });
  assert.equal((await fetch(`${base}/api/agent-manager/hosts/does-not-exist/models`, { headers: userHeaders })).status, 404);

  // 2. refresh: command issued to this instance; the response waits for the ack
  const issued = new Promise((resolve) => {
    activityEvents.once('agent_manager_command', (payload) => resolve(payload));
  });
  const refreshP = fetch(`${base}/api/agent-manager/hosts/${manager.id}/models/refresh`, { method: 'POST', headers: userHeaders });
  const command = await issued;
  assert.equal(command.command, 'refresh_available_models');
  assert.equal(command.instance_id, INSTANCE_ID, '그 호스트의 라이브 인스턴스로 간다');
  assert.equal(command.issued_by, `user:${viewer.id}`);

  // the host re-enumerates (new heartbeat), then acks the same command_id
  await readJson(await heartbeat({ claude: ['opus'], opencode: ['opencode/big-pickle', 'opencode-go/glm-5.3'] }, '2026-09-26T00:05:00.000Z'), 201);
  const ack = await fetch(`${base}/api/agent-manager/command/ack`, {
    method: 'POST',
    headers: managerHeaders,
    body: JSON.stringify({ command_id: command.command_id, status: 'ok', detail: 'refreshed 2 CLI(s)' }),
  });
  assert.ok(ack.status < 300, `ack accepted: ${ack.status}`);

  const fresh = await readJson(await refreshP, 200);
  assert.deepEqual(fresh.models.opencode, ['opencode/big-pickle', 'opencode-go/glm-5.3'], 'ack 이후의 목록을 돌려준다');
  assert.equal(fresh.refreshed_at, '2026-09-26T00:05:00.000Z');

  // 3. offline host → 409
  const ghost = await createAgent(app, getDataSourceToken, null, { name: 'ghost', type: 'manager' });
  const offline = await fetch(`${base}/api/agent-manager/hosts/${ghost.id}/models/refresh`, { method: 'POST', headers: userHeaders });
  assert.equal(offline.status, 409);
});

exitAfterTests();
