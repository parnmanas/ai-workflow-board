// 하트비트 `installed_version` / `restart_required` (docs/agent-manager.md → Self-update policy,
// "실행본 ≠ 설치본"). 프로세스 밖에서 `npm i -g` 가 돌면 매니저는 실행 중 버전(plugin_version)과
// 디스크 설치본 버전이 갈렸다고 광고하고, 화면은 "Restart to apply" 로 바꿔 보여준다.
//   - 필드가 오면 레지스트리 레코드에 그대로 실린다(installed_version 은 64자 절단).
//   - 구버전 매니저(필드 없음)는 undefined 로 남아 화면이 "보고 안 함" 을 구분한다.
import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp } from './helpers/boot.mjs';
import { createAgent, createApiKey, createWorkspace } from './helpers/fixtures.mjs';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';

process.env.PORT = process.env.MANAGER_INSTALLED_VERSION_PORT || '0';

async function heartbeat(port, key, manager, workspace, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/agent/instance-heartbeat`, {
    method: 'POST',
    headers: { 'X-Agent-Key': key.raw_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: manager.id,
      workspace_id: workspace.id,
      mode: 'manager',
      hostname: 'installed-version-host',
      plugin_version: '1.6.246',
      cli: 'mixed',
      cli_adapters: [],
      pid: 4242,
      started_at: new Date().toISOString(),
      ...body,
    }),
  });
  assert.equal(response.status, 201, await response.text());
}

test('heartbeat installed_version/restart_required round-trip; absence stays undefined', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await app.close(); });
  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'installed-version');
  const manager = await createAgent(app, getDataSourceToken, null, { name: 'installed-version-host', type: 'manager' });
  const key = await createApiKey(app, getDataSourceToken, manager.id, { workspaceId: workspace.id, label: 'installed-version' });
  const registry = app.get(InstanceRegistryService);

  // 구버전 매니저: 필드 자체가 없다
  await heartbeat(port, key, manager, workspace, { instance_id: 'inst-old' });
  let rec = registry.get('inst-old');
  assert.equal(rec.installed_version, undefined);
  assert.equal(rec.restart_required, undefined);

  // 디스크만 새 버전
  await heartbeat(port, key, manager, workspace, {
    instance_id: 'inst-old',
    latest_version: '1.6.247',
    update_available: true,
    installed_version: '1.6.247',
    restart_required: true,
    install_mode: 'npm-global',
  });
  rec = registry.get('inst-old');
  assert.equal(rec.plugin_version, '1.6.246', 'running version stays what the process reports');
  assert.equal(rec.installed_version, '1.6.247');
  assert.equal(rec.restart_required, true);
  assert.equal(rec.update_available, true);

  // 재기동 뒤: 실행본 = 설치본
  await heartbeat(port, key, manager, workspace, {
    instance_id: 'inst-old',
    plugin_version: '1.6.247',
    latest_version: '1.6.247',
    update_available: false,
    installed_version: '1.6.247',
    restart_required: false,
  });
  rec = registry.get('inst-old');
  assert.equal(rec.plugin_version, '1.6.247');
  assert.equal(rec.restart_required, false);

  // 방어: 문자열이 아니면 null, 너무 길면 절단
  await heartbeat(port, key, manager, workspace, { instance_id: 'inst-old', installed_version: 12345, restart_required: 'yes' });
  rec = registry.get('inst-old');
  assert.equal(rec.installed_version, null);
  assert.equal(rec.restart_required, true, 'truthy coerces like update_available');
  await heartbeat(port, key, manager, workspace, { instance_id: 'inst-old', installed_version: 'x'.repeat(200) });
  assert.equal(registry.get('inst-old').installed_version.length, 64);

  // 관리자 목록 API 가 spread 로 그대로 내보낸다
  const { AuthService } = modules;
  const { createUser } = await import('./helpers/fixtures.mjs');
  const admin = await createUser(app, getDataSourceToken, { name: 'admin', role: 'admin' });
  const token = app.get(AuthService).createSession(admin.id);
  await heartbeat(port, key, manager, workspace, { instance_id: 'inst-old', installed_version: '1.6.248', restart_required: true });
  const list = await (await fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/instances`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const row = list.find((i) => i.instance_id === 'inst-old');
  assert.equal(row.installed_version, '1.6.248');
  assert.equal(row.restart_required, true);
});
