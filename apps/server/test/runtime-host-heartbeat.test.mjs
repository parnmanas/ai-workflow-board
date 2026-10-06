import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { bootApp } from './helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createAccount,
  createUser,
} from './helpers/fixtures.mjs';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';

// AgentAuthGuard 의 dev bypass (AGENT_DEV_MODE + 키 없음) 를 끄고 DB 키 검증을
// 타게 한다 — host 바인딩 검사가 실제로 동작하는지 확인하려면 req.apiKey 가
// 채워져 있어야 한다. qa 키는 DB 에 있으므로 검증에 그대로 통과한다.
process.env.AGENT_API_KEY = 'test-static-key-unused';

// P4 (manager identity → RuntimeHost): heartbeat 정체성을 host-first 로
// 해소한다. Host 바인딩 키 + host_id 동봉이면 Agent 행 없이 통과하고,
// registry 에 host_id 가 찍히며, 구버전 경로 (agent 행만) 도 그대로 돈다.
async function postHeartbeat(port, rawKey, body) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: {
        'X-Agent-Key': rawKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed, text };
}

function baseBody(overrides = {}) {
  return {
    instance_id: `host-first-${randomUUID().slice(0, 8)}`,
    mode: 'manager',
    hostname: 'host-first-test',
    plugin_version: 'test',
    cli: 'mixed',
    cli_adapters: [],
    pid: 123,
    started_at: new Date().toISOString(),
    ...overrides,
  };
}

test('Heartbeat with host binding passes without an Agent row and stamps registry host_id', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const workspace = await createAccount(app, getDataSourceToken, 'host-first');

  const host = await ds.getRepository('RuntimeHost').save(
    ds.getRepository('RuntimeHost').create({
      name: 'host-first',
      hostname: 'host-first-test',
      account_id: workspace.id,
      is_active: 1,
    }),
  );

  // P4c-4: Agent 행 없이 Host 바인딩 키로 하트비트한다.
  const phantomAgentId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const key = await createApiKey(app, getDataSourceToken, phantomAgentId, {
    accountId: workspace.id,
    label: 'host-first',
    hostId: host.id,
  });

  const { status, body } = await postHeartbeat(port, key.raw_key, baseBody({
    agent_id: phantomAgentId,
    host_id: host.id,
  }));
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body?.ok, true);

  const record = app.get(InstanceRegistryService).get(body.instance_id);
  assert.equal(record.host_id, host.id);
  assert.equal(record.agent_id, phantomAgentId);

  const reloaded = await ds.getRepository('RuntimeHost').findOne({ where: { id: host.id } });
  assert.ok(reloaded?.last_seen_at, 'RuntimeHost.last_seen_at advances on host-first heartbeat');
});

test('Heartbeat rejects host_id mismatch between body and key binding', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const workspace = await createAccount(app, getDataSourceToken, 'host-mismatch');

  const mkHost = (name) => ds.getRepository('RuntimeHost').save(
    ds.getRepository('RuntimeHost').create({
      name, hostname: 'mismatch-test', account_id: workspace.id, is_active: 1,
    }),
  );
  const hostA = await mkHost('host-a');
  const hostB = await mkHost('host-b');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'mismatch-manager',
    type: 'manager',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    accountId: workspace.id,
    label: 'host-mismatch',
    hostId: hostA.id,
  });

  const { status } = await postHeartbeat(port, key.raw_key, baseBody({
    agent_id: manager.id,
    host_id: hostB.id,
  }));
  assert.equal(status, 403);
});

test('Hostless heartbeat is rejected (P4c-4: host identity required)', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const workspace = await createAccount(app, getDataSourceToken, 'host-legacy');
  const key = await createApiKey(app, getDataSourceToken, 'cccccccc-3333-4333-8333-cccccccccccc', {
    accountId: workspace.id,
    label: 'host-legacy',
  });

  const { status } = await postHeartbeat(port, key.raw_key, baseBody({
    agent_id: 'cccccccc-3333-4333-8333-cccccccccccc',
  }));
  assert.equal(status, 403);
});

test('Host rename is admin-only, validates names, and preserves pairing through later heartbeats', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(async () => { await app.close(); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const account = await createAccount(app, getDataSourceToken, 'host-rename');
  const hosts = ds.getRepository('RuntimeHost');
  const host = await hosts.save(hosts.create({ name: 'Original host', hostname: 'physical-machine', account_id: account.id }));
  const runtimeId = randomUUID();
  const key = await createApiKey(app, getDataSourceToken, runtimeId, { accountId: account.id, hostId: host.id, label: 'host-rename' });
  const heartbeat = () => postHeartbeat(port, key.raw_key, baseBody({
    instance_id: 'rename-instance', agent_id: runtimeId, host_id: host.id, hostname: host.hostname,
  }));
  assert.equal((await heartbeat()).status, 201);
  const admin = await createUser(app, getDataSourceToken, { name: 'rename-admin' });
  const member = await createUser(app, getDataSourceToken, { name: 'rename-member', role: 'member' });
  const token = app.get(AuthService).createSession(admin.id);
  const memberToken = app.get(AuthService).createSession(member.id);
  const rename = (body, auth = token, id = host.id) => fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/hosts/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal((await rename({ name: 'Denied' }, null)).status, 401);
  assert.equal((await rename({ name: 'Denied' }, memberToken)).status, 403);
  for (const body of [{ name: '   ' }, { name: 'x'.repeat(201) }, { name: 42 }, { name: 'No', hostname: 'new-machine' }]) {
    assert.equal((await rename(body)).status, 400);
  }
  assert.equal((await rename({ name: 'Missing' }, token, randomUUID())).status, 404);
  const response = await rename({ name: '  Ralf  ' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: host.id, name: 'Ralf' });
  assert.equal((await heartbeat()).status, 201, 'existing paired key still authenticates');
  const saved = await hosts.findOneBy({ id: host.id });
  assert.equal(saved.name, 'Ralf', 'heartbeat never replaces the configured name');
  assert.equal(saved.hostname, host.hostname);
  assert.equal(saved.account_id, account.id);
  const pairedKey = await ds.getRepository('ApiKey').findOneBy({ id: key.id });
  assert.equal(pairedKey.host_id, host.id);
  const listed = await fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/instances`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(listed.status, 200);
  const instance = (await listed.json()).find((row) => row.instance_id === 'rename-instance');
  assert.equal(instance.agent_name, 'Ralf', 'names resolve from host_id even when agent_id is a runtime key');
});
