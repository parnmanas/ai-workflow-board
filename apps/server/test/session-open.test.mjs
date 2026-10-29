import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';
import { AgentSessionsService } from '../dist/modules/agent-sessions/agent-sessions.service.js';
import { SessionOpenService } from '../dist/modules/agent-sessions/session-open.service.js';

test('MCP open_session uses native open RPC, owner settings, and same-account execution boundaries', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken, activityEvents, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const sessions = app.get(AgentSessionsService);
  const base = `http://localhost:${port}`;
  const account = await createAccount(app, getDataSourceToken, 'session-open');
  const foreign = await createAccount(app, getDataSourceToken, 'foreign');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const other = await createUser(app, getDataSourceToken, { name: 'other', role: 'admin' });
  await ds.getRepository('Account').update(account.id, { owner_user_id: owner.id });
  await ds.getRepository('Account').update(foreign.id, { owner_user_id: other.id });
  const hosts = new Map();
  async function host(accountId, name, connected = true) {
    const row = await createAgent(app, getDataSourceToken, accountId, { name, type: 'manager' });
    const key = runtimeHostKeyForAgent(row.id);
    hosts.set(row.id, { ...row, key });
    if (connected) {
      const response = await fetch(`${base}/api/agent/instance-heartbeat`, {
        method: 'POST', headers: { 'X-Agent-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: `inst-${row.id}`, agent_id: row.id, host_id: row.id, mode: 'manager',
          hostname: name, plugin_version: 'test', cli: 'codex', cli_adapters: ['codex'], acp_session_clis: ['codex'],
          pid: 4242, started_at: new Date().toISOString() }),
      });
      assert.ok(response.ok, await response.text());
      const stream = await openSseStream(port, key);
      t.after(() => stream.close());
    }
    return { ...row, key };
  }
  const first = await host(account.id, 'first');
  const second = await host(account.id, 'second');
  const outsider = await host(foreign.id, 'outsider');
  const offline = await host(account.id, 'offline', false);
  function mcp(h, options = {}) {
    const client = new McpClient({ baseUrl: base, apiKey: options.key || h.key,
      clientInfo: { name: 'claude-agent-acp', version: 'test' }, extraHeaders: {
        ...(options.session ? { 'X-AWB-Client-Type': 'agent-session', 'X-AWB-Session-Id': options.session } : {}),
        ...(options.compact ? { 'X-AWB-Tool-Profile': 'compact' } : {}),
      } });
    t.after(() => client.close());
    return client;
  }
  const client = mcp(first);
  const events = [];
  const rpcErrors = [];
  let nextError = null;
  const respond = (p) => {
    if (!hosts.has(p.manager_id)) return;
    events.push(p);
    if (p.op !== 'open') return;
    const error = nextError;
    nextError = null;
    const reply = error ? { ok: false, error: error.message, code: error.code } : { ok: true, result: {
      session_id: p.session_id || `created-${events.length}`, cwd: p.cwd || '/repo', title: p.title || 'Native session', status: 'ready',
    } };
    void fetch(`${base}/api/agent/sessions/rpc/${p.request_id}`, {
      method: 'POST', headers: { 'X-Agent-Key': hosts.get(p.manager_id).key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ manager_id: p.manager_id, ...reply }),
    }).then(async r => { if (!r.ok) throw new Error(await r.text()); }).catch(e => rpcErrors.push(e));
  };
  activityEvents.on('agent_session_request', respond);
  t.after(() => activityEvents.removeListener('agent_session_request', respond));
  const open = (args, c = client) => c.callTool('open_session', { cli: 'codex', ...args });
  const denied = (result, code) => {
    assert.equal(result.isError, true, JSON.stringify(result));
    if (code) assert.equal(result.error?.code, code, JSON.stringify(result));
  };
  let source;
  let target;

  await t.test('new sessions inherit saved settings and emit the ordinary owner UI update', async () => {
    await sessions.setCliSettings(account.id, owner.id, first.id, 'codex', null, { model: 'saved-model' });
    const stream = await openSseStream(port, app.get(AuthService).createSession(owner.id));
    t.after(() => stream.close());
    source = await open({ cwd: '/repo', title: 'MCP created', force: true, config_overrides: { __permission_mode: 'bypassPermissions' } });
    assert.equal(source.status, 'ready', JSON.stringify(source));
    assert.equal(source.manager_id, first.id);
    assert.equal(source.title, 'MCP created');
    assert.equal(source.path, `/sessions/${first.id}/codex/${source.session_id}`);
    const request = events.at(-1);
    assert.equal(request.op, 'open');
    assert.equal(request.account_id, account.id);
    assert.equal(request.driver_user_id, owner.id);
    assert.equal(request.force, false);
    assert.deepEqual(request.config_defaults, { model: 'saved-model' });
    assert.equal(request.text, undefined, 'opening does not submit a prompt or assert user approval');
    const pinned = await ds.getRepository('AgentSessionExecution').findOneBy({ manager_id: first.id, cli: 'codex', session_id: source.session_id });
    assert.equal(pinned.account_id, account.id);
    const update = await stream.waitFor('agent_session_update', p => p.session?.session_id === source.session_id && p.reason === 'opened');
    assert.equal(update.data.session.driver_user_id, owner.id);
  });

  await t.test('compact MCP can open another same-account Host; native sender can message it', async () => {
    const native = mcp(first, { session: source.session_id, compact: true });
    target = await open({ manager_id: second.id, cwd: '/another', title: 'Recipient' }, native);
    assert.equal(target.manager_id, second.id, JSON.stringify(target));
    const sent = await native.callTool('send_session_message', { manager_id: target.manager_id, cli: target.cli,
      session_id: target.session_id, content: 'Please inspect this task.' });
    assert.equal(sent.status, 'submitted', JSON.stringify(sent));
    assert.equal(events.at(-1).op, 'prompt');
    assert.equal(events.at(-1).session_id, target.session_id);
  });

  await t.test('resume preserves pinned settings even after account defaults change', async () => {
    await sessions.setCliSettings(account.id, owner.id, first.id, 'codex', null, { model: 'new-default' });
    const resumed = await open({ session_id: source.session_id });
    assert.equal(resumed.session_id, source.session_id);
    assert.deepEqual(events.at(-1).config_defaults, { model: 'saved-model' });
  });

  await t.test('bad inputs, offline or unsupported Hosts and cross-account targets cannot dispatch', async () => {
    const before = events.length;
    denied(await open({}), 'cwd_required');
    denied(await open({ cwd: '/repo', manager_id: outsider.id }), 'account_access_denied');
    denied(await open({ cwd: '/repo', manager_id: offline.id }), 'host_offline');
    denied(await open({ cwd: '/repo', cli: 'claude' }), 'cli_unsupported');
    denied(await open({ session_id: '../bad' }));
    assert.equal(events.length, before);
  });

  await t.test('owner permissions/status and current Host ownership are rechecked', async () => {
    const before = events.length;
    await ds.getRepository('User').update(owner.id, { role: 'user', permissions: '[]' });
    denied(await open({ cwd: '/repo' }), 'session_permission_required');
    await ds.getRepository('User').update(owner.id, { permissions: '["agent_sessions.use"]' });
    assert.equal((await open({ session_id: source.session_id })).status, 'ready');
    await ds.getRepository('User').update(owner.id, { status: 'rejected' });
    denied(await open({ cwd: '/repo' }), 'account_owner_required');
    await ds.getRepository('User').update(owner.id, { role: 'admin', status: 'active' });
    await ds.getRepository('RuntimeHost').update(first.id, { account_id: foreign.id });
    try {
      await assert.rejects(open({ cwd: '/repo' }), /API key rejected/);
      await assert.rejects(app.get(SessionOpenService).open(
        { source: 'db', scope: 'full', agentId: first.id, accountId: account.id }, { cli: 'codex', cwd: '/repo' },
      ), e => e.code === 'account_access_denied');
    } finally {
      await ds.getRepository('RuntimeHost').update(first.id, { account_id: account.id });
    }
    await ds.getRepository('RuntimeHost').update(second.id, { account_id: foreign.id });
    denied(await open({ cwd: '/repo', manager_id: second.id }), 'account_access_denied');
    await ds.getRepository('RuntimeHost').update(second.id, { account_id: account.id });
    assert.equal(events.length, before + 1);
  });

  await t.test('read-only/runtime keys and missing caller cannot open', async () => {
    const before = events.length;
    const read = await createApiKey(app, getDataSourceToken, first.id, { accountId: account.id, scope: 'read' });
    denied(await open({ cwd: '/repo' }, mcp(first, { key: read.raw_key })));
    const runtime = await createApiKey(app, getDataSourceToken, first.id, { accountId: account.id });
    await ds.getRepository('ApiKey').update(runtime.id, { name: 'runtime:worker:rt-1234567890123456' });
    denied(await open({ cwd: '/repo' }, mcp(first, { key: runtime.raw_key })), 'host_key_required');
    await assert.rejects(app.get(SessionOpenService).open(undefined, { cli: 'codex', cwd: '/repo' }), e => e.code === 'unauthorized');
    assert.equal(events.length, before);
  });

  await t.test('foreign pinned sessions and another driver cannot be adopted', async () => {
    await ds.getRepository('AgentSessionExecution').update({ manager_id: first.id, session_id: source.session_id }, { account_id: foreign.id });
    denied(await open({ session_id: source.session_id }), 'account_access_denied');
    await ds.getRepository('AgentSessionExecution').update({ manager_id: first.id, session_id: source.session_id }, { account_id: account.id });
    await sessions.prompt(account.id, other.id, first.id, 'codex', source.session_id, 'another driver');
    const before = events.length;
    denied(await open({ session_id: source.session_id }), 'session_driver_mismatch');
    assert.equal(events.length, before);
  });

  await t.test('native lock errors propagate and never retry with force', async () => {
    nextError = { code: 'session_locked', message: 'Already open in another CLI' };
    const before = events.length;
    const result = await open({ cwd: '/locked' });
    denied(result, 'session_locked');
    assert.equal(events.length, before + 1);
    assert.equal(events.at(-1).force, false);
  });
  assert.deepEqual(rpcErrors, []);
});
