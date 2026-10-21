// 채팅 전용 작업 폴더 루트 — 매니저 하트비트 `chat_workdir_root` → `GET /api/agent-templates/hosts`.
//
// 새 채팅에서 Agent 폴더를 비우면 화면이 그 Host 의 `chat_workdir_root` 아래 경로를 채운다
// (agent-manager chat-workdirs.ts). 서버는 그 값을 하트비트에서 받아(절대 경로만) Host 목록에 싣는다.
// 매니저가 꺼져 있거나 구버전이면 null — 화면은 그때 폴더를 요구한다.
//
// 실행: node --test --test-force-exit test/chat-workdir-root.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createAccount, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';

test('hosts carry the chat workdir root a live manager advertised; relative paths and offline hosts are null', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const base = `http://localhost:${port}`;
  const ws = await createAccount(app, getDataSourceToken, 'chatroot');
  const user = await createUser(app, getDataSourceToken, { name: 'u', role: 'admin' });
  const headers = { Authorization: `Bearer ${app.get(AuthService).createSession(user.id)}`, 'X-Account-Id': ws.id };

  const heartbeat = async (agent, hostname, root) => {
    const res = await fetch(`${base}/api/agent/instance-heartbeat`, {
      method: 'POST',
      headers: { 'X-Agent-Key': runtimeHostKeyForAgent(agent.id), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: `inst-${hostname}`, agent_id: agent.manager_agent_id, host_id: agent.manager_agent_id, mode: 'manager',
        hostname, plugin_version: 'test', cli: 'claude', cli_adapters: ['claude'], pid: 1, started_at: new Date().toISOString(),
        ...(root !== undefined ? { chat_workdir_root: root } : {}),
      }),
    });
    assert.ok(res.status < 300, `heartbeat ${hostname}: ${res.status}`);
  };

  const live = await createAgent(app, getDataSourceToken, ws.id, { name: 'a', type: 'claude' });
  const win = await createAgent(app, getDataSourceToken, ws.id, { name: 'b', type: 'claude' });
  const bad = await createAgent(app, getDataSourceToken, ws.id, { name: 'c', type: 'claude' });
  const old = await createAgent(app, getDataSourceToken, ws.id, { name: 'd', type: 'claude' });
  const offline = await createAgent(app, getDataSourceToken, ws.id, { name: 'e', type: 'claude' });
  await heartbeat(live, 'rolf', '/home/u/.config/awb-agent-manager/chat-workdirs');
  await heartbeat(win, 'ralf', 'C:\\Users\\u\\.config\\awb-agent-manager\\chat-workdirs');
  await heartbeat(bad, 'evil', 'relative/chat');
  await heartbeat(old, 'old', undefined);

  const res = await fetch(`${base}/api/agent-templates/hosts`, { headers });
  assert.equal(res.status, 200);
  const rows = await res.json();
  const rootOf = (agent) => rows.find((h) => h.id === agent.manager_agent_id)?.chat_workdir_root;
  assert.equal(rootOf(live), '/home/u/.config/awb-agent-manager/chat-workdirs');
  assert.equal(rootOf(win), 'C:\\Users\\u\\.config\\awb-agent-manager\\chat-workdirs');
  assert.equal(rootOf(bad), null, 'a relative path is not accepted as a folder root');
  assert.equal(rootOf(old), null, 'an old manager does not advertise it');
  assert.equal(rootOf(offline), null, 'an offline host has no live root');
  assert.ok(rows.every((h) => typeof h.id === 'string' && 'name' in h), 'the existing id/name shape is unchanged');
});
