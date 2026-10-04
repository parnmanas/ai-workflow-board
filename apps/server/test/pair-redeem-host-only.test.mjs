import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp } from './helpers/boot.mjs';
import { createWorkspace } from './helpers/fixtures.mjs';
import { PairingService } from '../dist/modules/agent-manager/pairing.service.js';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';

// AgentAuthGuard dev bypass 를 끄고 DB 키 검증을 탄다 (host 바인딩 키가
// 실제로 통과하는지 확인 — runtime-host-heartbeat.test.mjs 와 같은 이유).
process.env.AGENT_API_KEY = 'test-static-key-unused';

// P4 redeem cutover: pair/redeem 은 RuntimeHost 행만 만든다. 응답 agent_id
// 자리에는 Host id 가 들어가고, 그 키로 하트비트가 host-first 로 통과한다.
test('pair/redeem mints a host-only identity with no Agent row', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const workspace = await createWorkspace(app, getDataSourceToken, 'redeem-cutover');

  const pairing = app.get(PairingService);
  const rec = pairing.mint({
    workspace_id: workspace.id,
    created_by_user_id: 'test-admin',
    agent_name: 'cutover-host',
  });

  const redeemRes = await fetch(
    `http://127.0.0.1:${port}/api/agent-manager/pair/redeem`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: rec.token,
        instance_id: `redeem-cutover-${Date.now()}`,
        hostname: 'cutover-host',
      }),
    },
  );
  const redeemed = await redeemRes.json();
  assert.equal(redeemRes.status, 201, JSON.stringify(redeemed));
  assert.ok(redeemed?.api_key, 'redeem returns an api key');
  assert.ok(redeemed?.host_id, 'redeem returns a host id');
  assert.equal(redeemed.agent_id, redeemed.host_id, 'wire agent_id is the Host id');

  const hostRow = await ds.getRepository('RuntimeHost').findOne({ where: { id: redeemed.host_id } });
  assert.ok(hostRow, 'RuntimeHost row exists');
  // P4c-4: Agent 엔티티 자체가 삭제됐다 — 테이블 부재를 직접 확인한다.
  assert.equal(await ds.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`).then((r) => r.length), 0, 'agents table is gone');
  const keyRow = await ds.getRepository('ApiKey').findOne({ where: { host_id: redeemed.host_id } });
  assert.ok(keyRow, 'api key row exists');
  assert.equal('agent_id' in keyRow, false, 'key has no legacy Agent field');
  assert.equal(await ds.createQueryRunner().hasColumn('api_keys', 'agent_id'), false);

  // 그 키 + Host id 로 하트비트가 통과하고 registry 에 host_id 가 찍힌다.
  const hbRes = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: {
        'X-Agent-Key': redeemed.api_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instance_id: `redeem-cutover-hb-${Date.now()}`,
        agent_id: redeemed.host_id,
        host_id: redeemed.host_id,
        mode: 'manager',
        hostname: 'cutover-host',
        plugin_version: 'test',
        cli: 'mixed',
        cli_adapters: [],
        pid: 123,
        started_at: new Date().toISOString(),
      }),
    },
  );
  const hb = await hbRes.json();
  assert.equal(hbRes.status, 201, JSON.stringify(hb));
  assert.equal(hb?.ok, true);
  const record = app.get(InstanceRegistryService).get(hb.instance_id);
  assert.equal(record.host_id, redeemed.host_id);

  // runtime-hosts 카탈로그에 Host 키로 나온다.
  const { OrchestrationHostsService } = await import(
    '../dist/modules/orchestration/orchestration-hosts.service.js'
  );
  const hosts = await app.get(OrchestrationHostsService).listRuntimeHosts(workspace.id);
  const row = hosts.find((h) => h.manager_agent_id === redeemed.host_id);
  assert.ok(row, `redeemed host missing from catalogue: ${JSON.stringify(hosts.map((h) => h.manager_agent_id))}`);
  assert.equal(row.legacy_agent_id, null);
});
