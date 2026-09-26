// GET /api/agents/dashboard — 목록 화면이 **카테고리로 묶는 데 쓰는 사실**을 싣는다.
//
// 고치는 증상: 이 응답은 id·이름·온라인 여부·진행 중 작업만 돌려줬다. 그래서 AI Agents
// 화면은 Agent 를 Runtime Host 별로도, CLI 별로도, 상태별로도 묶을 수 없었고 —
// 실제로 그룹도 필터도 없는 평면 목록 하나가 전부였다. `lifecycle_state` 도 없어서
// 첫 렌더는 모든 Agent 를 online/offline 두 값으로만 칠하고, SSE 가 한 번 올 때까지
// "시작 중"·"오류" 가 보이지 않았다.
//
// 여기서 고정하는 것: 그 사실들이 실린다는 것, 그리고 이미 있던 워크스페이스 스코프가
// 그대로라는 것.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createUser, createWorkspace } from './helpers/fixtures.mjs';

process.env.PORT = process.env.AGENT_DASHBOARD_FLEET_PORT || '0';

test('dashboard carries the identity facts the fleet view groups by', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await app.close(); });
  const { AuthService, getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const ws = await createWorkspace(app, getDataSourceToken, 'fleet-fields');
  const viewer = await createUser(app, getDataSourceToken, { name: 'viewer', role: 'admin' });
  const token = app.get(AuthService).createSession(viewer.id);

  const coder = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude' });
  // 그룹·검색이 읽는 값들을 실제 행에 채워 둔다.
  await ds.getRepository('Agent').update(
    { id: coder.id },
    { working_dir: '/srv/checkout', model: 'opus', description: 'builds things' },
  );

  const resp = await fetch(`http://127.0.0.1:${port}/api/agents/dashboard?workspace_id=${ws.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  const rows = JSON.parse(text);
  const row = rows.find((r) => r.id === coder.id);
  assert.ok(row, 'the workspace agent is listed');

  // CLI 축
  assert.equal(row.type, 'claude');
  // Runtime Host 축 — id 로 묶고 이름으로 보여 준다(둘 다 필요하다).
  assert.ok(row.manager_agent_id, 'manager id rides along so the host group key is stable');
  assert.equal(typeof row.manager_name, 'string');
  assert.ok(row.manager_name.length > 0, 'host name rides along so the group header is readable');
  // 상태 축 — 첫 렌더부터 5-state 를 안다(SSE 를 기다리지 않는다).
  assert.ok(
    ['online', 'starting', 'never_started', 'offline', 'error'].includes(row.lifecycle_state),
    `lifecycle_state is one of the five states, got ${row.lifecycle_state}`,
  );
  // 검색 축
  assert.equal(row.working_dir, '/srv/checkout');
  assert.equal(row.model, 'opus');
  assert.equal(row.description, 'builds things');
  assert.equal(row.origin, '', 'operator-authored agents carry the empty origin');

  // 기존 계약은 그대로 — 진행 중 작업과 워크스페이스 스코프.
  assert.ok(Array.isArray(row.active_tasks));
  const otherWs = await createWorkspace(app, getDataSourceToken, 'fleet-other');
  const otherResp = await fetch(`http://127.0.0.1:${port}/api/agents/dashboard?workspace_id=${otherWs.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const otherRows = JSON.parse(await otherResp.text());
  assert.equal(otherRows.some((r) => r.id === coder.id), false, 'still workspace-scoped');
});

exitAfterTests();
