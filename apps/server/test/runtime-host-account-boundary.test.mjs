import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createUser } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';
import { ApiKeyService } from '../dist/services/api-key.service.js';
import { activityEvents } from '../dist/services/activity.service.js';
import { callerCanAccessAccount } from '../dist/modules/mcp/shared/authz.js';
import { sessionStore } from '../dist/modules/mcp/internal/session-store.js';
import { registerDeploymentTools } from '../dist/modules/mcp/tools/deployment-tools.js';
import { DeploymentService } from '../dist/modules/deployments/deployment.service.js';
import { registerUserTools } from '../dist/modules/mcp/tools/user-tools.js';

test('host keys, host surfaces and SSE respect the authenticated account boundary', async t => {
  const previousDevMode = process.env.AGENT_DEV_MODE;
  process.env.AGENT_DEV_MODE = 'false';
  t.after(() => {
    if (previousDevMode === undefined) delete process.env.AGENT_DEV_MODE;
    else process.env.AGENT_DEV_MODE = previousDevMode;
  });
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const ds = app.get(modules.getDataSourceToken());
  const keys = app.get(ApiKeyService);
  const user = await createUser(app, modules.getDataSourceToken, { name: 'host-owner', role: 'admin' });
  const other = await createUser(app, modules.getDataSourceToken, { name: 'other-owner', role: 'user' });
  const a = await createAccount(app, modules.getDataSourceToken, 'a', { ownerUserId: user.id });
  const b = await createAccount(app, modules.getDataSourceToken, 'b', { ownerUserId: other.id });
  const token = app.get(modules.AuthService).createSession(user.id);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Account-Id': a.id };
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, options = {}) => {
    const res = await fetch(base + path, { headers, ...options });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const host = async account => ds.getRepository('RuntimeHost').save({ name: `Host ${account.name}`, account_id: account.id, is_active: 1 });
  const ha = await host(a);
  const hb = await host(b);
  const ka = await keys.createApiKey({ name: 'manager-a', host_id: ha.id, account_id: a.id });
  const kb = await keys.createApiKey({ name: 'manager-b', host_id: hb.id, account_id: b.id });
  const mismatched = await keys.createApiKey({ name: 'wrong-account', host_id: hb.id, account_id: a.id });
  assert.equal((await keys.validateApiKey(ka.raw_key)).valid, true);
  assert.equal((await keys.validateApiKey(mismatched.raw_key)).valid, false);
  const unowned = await keys.createApiKey({ name: 'unowned' });
  assert.equal((await keys.validateApiKey(unowned.raw_key)).valid, false);

  const heartbeat = async (h, key, instance) => {
    const result = await request('/api/agent/instance-heartbeat', {
      method: 'POST', headers: { 'X-Agent-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: instance, agent_id: h.id, host_id: h.id, mode: 'manager', hostname: h.name,
        account_id: b.id, cli_adapters: ['codex'], acp_session_clis: ['codex'], manager_capabilities: ['cli_memory'],
        terminal_shells: [{ id: 'bash', label: 'Bash', path: '/bin/bash', default: true }] }),
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
  };
  await heartbeat(ha, ka.raw_key, 'instance-a');
  await heartbeat(hb, kb.raw_key, 'instance-b');
  const spoof = async (key, payload) => request('/api/agent/instance-heartbeat', {
    method: 'POST', headers: { 'X-Agent-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instance_id: 'instance-a', mode: 'manager', ...payload }),
  });
  assert.equal((await spoof(ka.raw_key, { host_id: ha.id, agent_id: hb.id })).status, 403);
  assert.equal((await spoof(kb.raw_key, { host_id: hb.id, agent_id: hb.id })).status, 403,
    'another host cannot take over an already registered instance');
  const accountKey = await keys.createApiKey({ name: 'account-only', account_id: a.id });
  assert.equal((await spoof(accountKey.raw_key, { host_id: hb.id, agent_id: hb.id })).status, 403);
  assert.equal((await request(`/api/admin/agent-manager/hosts/${ha.id}`, {
    method: 'PATCH', body: JSON.stringify({ name: 'Renamed own host' }),
  })).status, 200);
  assert.equal((await request(`/api/admin/agent-manager/hosts/${hb.id}`, {
    method: 'PATCH', body: JSON.stringify({ name: 'Foreign host' }),
  })).status, 403);
  const instances = await request('/api/admin/agent-manager/instances');
  assert.deepEqual(instances.body.map(row => [row.instance_id, row.account_id]), [['instance-a', a.id]]);
  for (const path of ['/api/agent-sessions/hosts', '/api/terminals/hosts', '/api/cli-memory/hosts']) {
    const result = await request(path);
    assert.equal(result.status, 200, path);
    assert.deepEqual(result.body.map(row => row.manager_id), [ha.id], path);
  }
  assert.deepEqual((await request('/api/agent-templates/hosts')).body.map(row => row.id), [ha.id]);
  assert.deepEqual((await request('/api/credentials/cli-login/instances')).body.map(row => row.instance_id), ['instance-a']);
  for (const path of [
    `/api/agent-sessions/hosts/${hb.id}/codex/settings`,
    `/api/terminals/hosts/${hb.id}/terminals`, `/api/cli-memory/hosts/${hb.id}/snapshot`,
    `/api/agent-manager/hosts/${hb.id}/models`, '/api/admin/agent-manager/instances/instance-b/logs',
    `/api/agents/${hb.id}/fs/roots`,
  ]) assert.equal((await request(path)).status, 403, path);
  assert.equal((await request('/api/admin/agent-manager/instances/instance-b/restart', { method: 'POST' })).status, 403);
  assert.equal((await request('/api/credentials/cli-login/start', {
    method: 'POST', body: JSON.stringify({ scope: 'global', cli: 'codex', credential_name: 'Shared login', instance_id: 'instance-b' }),
  })).status, 403, 'Global credential authoring does not grant access to another account’s host');
  assert.equal((await request('/api/agent-manager/runtime-keys/provision', {
    method: 'POST', headers: { 'X-Agent-Key': ka.raw_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'rt-0123456789abcdef', account_id: b.id }),
  })).status, 403);
  const agentHeaders = { 'X-Agent-Key': ka.raw_key };
  assert.equal((await request(`/api/agent-manager/agent-env?account_id=${b.id}`, { headers: agentHeaders })).status, 403);
  const ownEnv = await request('/api/agent-manager/agent-env', { headers: agentHeaders });
  assert.equal(ownEnv.status, 200, JSON.stringify(ownEnv.body));
  assert.equal(ownEnv.body.account_id, a.id);
  const caller = { source: 'db', scope: 'full', agentId: ha.id, accountId: a.id };
  assert.equal(await callerCanAccessAccount(ds, caller, a.id), true);
  assert.equal(await callerCanAccessAccount(ds, caller, b.id), false);
  assert.equal(await callerCanAccessAccount(ds, caller, null), false);

  const makeTicket = (account, host) => ds.getRepository('Ticket').save({
    account_id: account.id, title: 'Runtime account boundary', assignee: { manager_agent_id: host.id }, assignee_key: host.id,
  });
  const ownTicket = await makeTicket(a, ha);
  const foreignTicket = await makeTicket(b, hb);
  const agentPost = (path, body) => request(path, {
    method: 'POST', headers: { ...agentHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await agentPost('/api/agent-manager/dispatch/ack', {
    ticket_id: foreignTicket.id, role: 'assignee', outcome: 'processed',
  })).status, 403);
  assert.equal((await agentPost('/api/agent-manager/output-liveness', { items: [
    { ticket_id: ownTicket.id, agent_id: ha.id }, { ticket_id: foreignTicket.id, agent_id: hb.id },
  ] })).body.recorded, 1);
  assert.equal((await agentPost('/api/agent-manager/tool-call-telemetry', {
    ticket_id: foreignTicket.id, agent_id: hb.id, graph_calls: 1,
  })).status, 403);

  await ds.getRepository('AgentErrorLog').save([
    { agent_id: ha.id, account_id: a.id, level: 'error', category: 'test', message: 'own error', occurred_at: new Date() },
    { agent_id: hb.id, account_id: b.id, level: 'error', category: 'test', message: 'foreign error', occurred_at: new Date() },
  ]);
  for (const [path, options] of [
    ['/api/admin/agent-logs', {}], ['/api/agent/error-logs', { headers: agentHeaders }],
  ]) assert.deepEqual((await request(path, options)).body.map(row => row.message), ['own error']);
  assert.deepEqual((await request('/api/admin/agent-logs/agents')).body.map(row => row.agent_id), [ha.id]);
  assert.equal((await request('/api/admin/agent-logs/unseen-count')).body.count, 1);
  const upload = body => request('/api/agent/error-logs', {
    method: 'POST', headers: { ...agentHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await upload({ agent_id: hb.id, entries: [] })).status, 403);
  assert.equal((await upload({ agent_id: ha.id, account_id: b.id, entries: [] })).status, 403);
  const logged = await upload({ agent_id: ha.id, entries: [{ level: 'error', category: 'test', message: 'uploaded own error', occurred_at: new Date().toISOString() }] });
  assert.equal(logged.body.accepted, 1);
  assert.equal((await ds.getRepository('AgentErrorLog').findOneByOrFail({ message: 'uploaded own error' })).account_id, a.id);

  const report = body => request('/api/deployments/report', {
    method: 'POST', body: JSON.stringify({ environment: 'account-boundary', deployed_commit_sha: 'a'.repeat(40), ...body }),
  });
  assert.equal((await report({})).body.account_id, a.id, 'omitted deployment scope defaults to the caller');
  assert.equal((await report({ account_id: b.id })).status, 403);
  assert.equal((await report({ scope: 'global' })).body.account_id, null, 'Global must be requested explicitly');
  let reportTool;
  registerDeploymentTools({ tool: (_name, ...args) => { reportTool = args.at(-1); } }, {
    dataSource: ds, deploymentService: app.get(DeploymentService),
  });
  const sessionId = 'boundary-deployment-session';
  sessionStore.register(sessionId, {}, {}, caller);
  t.after(() => sessionStore.remove(sessionId));
  const userTools = {};
  registerUserTools({ tool: (name, ...args) => { userTools[name] = args.at(-1); } }, { dataSource: ds });
  assert.deepEqual(JSON.parse((await userTools.list_users({}, { sessionId })).content[0].text).map(row => row.id), [user.id]);
  assert.equal((await userTools.get_user({ user_id: other.id }, { sessionId })).isError, true);
  for (const name of ['create_user', 'update_user', 'delete_user']) {
    assert.equal((await userTools[name]({ user_id: other.id, name: 'Hijacked' }, { sessionId })).isError, true);
  }
  assert.equal((await ds.getRepository('User').findOneByOrFail({ id: other.id })).name, other.name);
  const toolArgs = { environment: 'mcp-account-boundary', deployed_commit_sha: 'b'.repeat(40) };
  assert.equal((await reportTool(toolArgs, { sessionId })).isError, undefined);
  assert.equal((await ds.getRepository('Deployment').findOneByOrFail({ environment: toolArgs.environment })).account_id, a.id);
  assert.equal((await reportTool({ ...toolArgs, account_id: b.id }, { sessionId })).isError, true);

  const userStream = await openSseStream(port, token);
  const managerStream = await openSseStream(port, ka.raw_key);
  t.after(() => { userStream.close(); managerStream.close(); });
  await heartbeat(hb, kb.raw_key, 'instance-b');
  await heartbeat(ha, ka.raw_key, 'instance-a');
  await userStream.waitFor('agent_instance_update', event => (event.payload?.instance || event.instance)?.instance_id === 'instance-a');
  assert.equal(userStream.snapshot().some(frame => (frame.data.payload?.instance || frame.data.instance)?.instance_id === 'instance-b'), false);
  const command = (id, accountId) => activityEvents.emit('agent_manager_command', {
    command_id: id, instance_id: 'instance-a', agent_id: ha.id, account_id: accountId,
    command: 'reload_config', args: {}, issued_by: user.id, issued_at: new Date().toISOString(),
  });
  command('foreign', b.id);
  command('own', a.id);
  const own = await managerStream.waitFor('agent_manager_command', event => event.payload?.command_id === 'own' || event.command_id === 'own');
  assert.equal(own.data.account_id, a.id);
  assert.equal(managerStream.snapshot().some(frame => (frame.data.payload?.command_id || frame.data.command_id) === 'foreign'), false);
});
