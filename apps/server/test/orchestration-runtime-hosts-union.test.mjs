import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp } from './helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createWorkspace,
} from './helpers/fixtures.mjs';
import { OrchestrationHostsService } from '../dist/modules/orchestration/orchestration-hosts.service.js';

// P4 (manager identity → RuntimeHost): runtime-hosts 카탈로그는 runtime_hosts
// 원천 + manager Agent 행 legacy 별칭의 합집합이다. dual-write 쌍은 하나로
// 합쳐지고 (키는 Host id), Agent 행 없는 Host 도 목록에 나온다.
async function listHosts(app) {
  return app.get(OrchestrationHostsService).listRuntimeHosts('any-workspace');
}

test('Linked dual-write pair collapses to one host-keyed row with legacy alias', async (t) => {
  const { app, modules } = await bootApp({ port: 0 });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const workspace = await createWorkspace(app, getDataSourceToken, 'hosts-union');

  // P4c-4: createAgent(type manager)는 Host 행을 직접 만든다 — dual-write
  // 쌍을 흉내내려면 키에 구 agent uuid 바인딩을 얹는다 (평문 컬럼, FK 없음).
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'union-manager',
    type: 'manager',
  });
  const host = manager;
  const legacyAgentId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  await createApiKey(app, getDataSourceToken, legacyAgentId, {
    workspaceId: workspace.id,
    label: 'hosts-union',
    hostId: host.id,
  });

  const hosts = await listHosts(app);
  assert.equal(hosts.length, 1, JSON.stringify(hosts.map((h) => h.manager_name)));
  assert.equal(hosts[0].manager_agent_id, host.id);
  assert.equal(hosts[0].legacy_agent_id, legacyAgentId);
  assert.ok(hosts[0].manager_name.startsWith('union-manager'), hosts[0].manager_name);
});

test('Host without an Agent row still appears, keyed by host id', async (t) => {
  const { app, modules } = await bootApp({ port: 0 });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const workspace = await createWorkspace(app, getDataSourceToken, 'hosts-orphan');

  const host = await ds.getRepository('RuntimeHost').save(
    ds.getRepository('RuntimeHost').create({
      name: 'orphan-host',
      hostname: 'orphan',
      workspace_id: workspace.id,
      is_active: 1,
    }),
  );

  const hosts = await listHosts(app);
  const row = hosts.find((h) => h.manager_agent_id === host.id);
  assert.ok(row, `host-only row missing: ${JSON.stringify(hosts.map((h) => h.manager_agent_id))}`);
  assert.equal(row.legacy_agent_id, null);
  assert.equal(row.is_online, false);
});

test('Host rows created by pairing appear keyed by host id', async (t) => {
  const { app, modules } = await bootApp({ port: 0 });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  await createWorkspace(app, getDataSourceToken, 'hosts-legacy');

  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'legacy-only-manager',
    type: 'manager',
  });

  const hosts = await listHosts(app);
  const row = hosts.find((h) => h.manager_agent_id === manager.id);
  assert.ok(row, `host row missing: ${JSON.stringify(hosts.map((h) => h.manager_agent_id))}`);
  assert.equal(row.legacy_agent_id, null);
});
