import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';
import { AgentSessionsService } from '../dist/modules/agent-sessions/agent-sessions.service.js';

// docs/agent-sessions.md "MCP에서 세션 찾기" — list_session_hosts · list_session_folders · list_sessions · get_session_info.
test('MCP session directory finds remote native sessions by Host, folder and settings within one account', async (t) => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const sessions = app.get(AgentSessionsService);
  const base = `http://localhost:${port}`;
  const account = await createAccount(app, getDataSourceToken, 'session-directory');
  const foreign = await createAccount(app, getDataSourceToken, 'directory-foreign');
  const owner = await createUser(app, getDataSourceToken, { name: 'dir-owner', role: 'admin' });
  const other = await createUser(app, getDataSourceToken, { name: 'dir-other', role: 'admin' });
  await ds.getRepository('Account').update(account.id, { owner_user_id: owner.id });
  await ds.getRepository('Account').update(foreign.id, { owner_user_id: other.id });
  const hosts = new Map();
  async function host(accountId, name, clis, connected = true) {
    const row = await createAgent(app, getDataSourceToken, accountId, { name, type: 'manager' });
    const key = runtimeHostKeyForAgent(row.id);
    hosts.set(row.id, { ...row, key });
    if (connected) {
      const response = await fetch(`${base}/api/agent/instance-heartbeat`, {
        method: 'POST', headers: { 'X-Agent-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: `inst-${row.id}`, agent_id: row.id, host_id: row.id, mode: 'manager',
          hostname: `${name}.local`, plugin_version: 'test', cli: clis[0], cli_adapters: clis, acp_session_clis: clis,
          pid: 4242, started_at: new Date().toISOString() }),
      });
      assert.ok(response.ok, await response.text());
      const stream = await openSseStream(port, key);
      t.after(() => stream.close());
    }
    return { ...row, key };
  }
  const first = await host(account.id, 'first', ['codex', 'claude']);
  const second = await host(account.id, 'second', ['codex']);
  const outsider = await host(foreign.id, 'outsider', ['codex']);
  const offline = await host(account.id, 'offline', ['codex'], false);

  const repo = await ds.getRepository('Project').save({ account_id: account.id, name: 'Repo' });
  const empty = await ds.getRepository('Project').save({ account_id: account.id, name: 'Empty' });
  const foreignProject = await ds.getRepository('Project').save({ account_id: foreign.id, name: 'Foreign' });
  await ds.getRepository('ProjectHostFolder').save([
    { project_id: repo.id, host_id: first.id, path: '/repo' },
    { project_id: empty.id, host_id: first.id, path: '/empty' },
    { project_id: foreignProject.id, host_id: first.id, path: '/foreign' },
  ]);

  const now = Date.now();
  const ago = (hours) => new Date(now - hours * 3_600_000).toISOString();
  const native = {
    [first.id]: {
      codex: [
        { session_id: 'cx-repo-1', cwd: '/repo', title: 'Fix login throttle', created_at: ago(50), updated_at: ago(1), source: 'cli', live_status: 'busy', size_bytes: 1234 },
        { session_id: 'cx-wt-2', cwd: '/repo/.awb/wt/abcd1234', title: 'Worktree task', created_at: ago(30), updated_at: ago(5), source: 'awb' },
        { session_id: 'shared-id', cwd: '/other', title: 'Same id on first', created_at: ago(80), updated_at: ago(70), source: 'cli' },
        { session_id: 'foreign-owned', cwd: '/repo', title: 'Opened by another account', created_at: ago(9), updated_at: ago(0.5), source: 'awb' },
      ],
      claude: [
        { session_id: 'cl-repo-3', cwd: '/repo/', title: 'Claude review', created_at: ago(10), updated_at: ago(2), source: 'cli' },
      ],
    },
    [second.id]: {
      codex: [
        { session_id: 'shared-id', cwd: 'E:\\Work\\Game', title: 'Same id on second', created_at: ago(20), updated_at: ago(3), source: 'cli' },
      ],
    },
  };
  const records = {
    'cx-repo-1': { model: 'gpt-record', effort: 'max', mode: 'never', sandbox: 'danger-full-access', cli_version: '0.165.0', git_branch: 'main', client: 'codex_cli_rs', last_record_at: ago(1) },
    'cx-wt-2': { model: 'gpt-record-wt', last_record_at: ago(5) },
  };
  const liveAdapters = {
    'cx-repo-1': { status: 'busy', current_mode: 'agent', available_modes: [{ id: 'agent', name: 'Agent' }],
      config_options: [{ config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: 'gpt-live', options: [{ value: 'gpt-live', name: 'GPT Live' }] }] },
  };
  const requests = [];
  const rpcErrors = [];
  const flags = { outdatedInfo: false, failSecond: false };
  const respond = (p) => {
    if (!hosts.has(p.manager_id) || !p.request_id) return;
    requests.push(p);
    let reply;
    const list = native[p.manager_id]?.[p.cli] ?? [];
    if (p.op === 'list') {
      reply = flags.failSecond && p.manager_id === second.id
        ? { ok: false, code: 'manager_error', error: 'scan failed' }
        : { ok: true, result: { sessions: list } };
    } else if (p.op === 'info') {
      const found = list.find((s) => s.session_id === p.session_id);
      if (flags.outdatedInfo) reply = { ok: false, code: 'bad_request', error: 'Unknown RPC op info' };
      else if (!found) reply = { ok: false, code: 'not_found', error: 'Session not found on this Runtime Host.' };
      else {
        const { live_status: _ignored, ...session } = found;
        reply = { ok: true, result: { session, settings: records[found.session_id] ?? null, live: liveAdapters[found.session_id] ?? null } };
      }
    } else return;
    void fetch(`${base}/api/agent/sessions/rpc/${p.request_id}`, {
      method: 'POST', headers: { 'X-Agent-Key': hosts.get(p.manager_id).key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ manager_id: p.manager_id, ...reply }),
    }).then(async (r) => { if (!r.ok) throw new Error(await r.text()); }).catch((e) => rpcErrors.push(e));
  };
  activityEvents.on('agent_session_request', respond);
  t.after(() => activityEvents.removeListener('agent_session_request', respond));

  // AWB 가 연 세션 — 실행 snapshot 이 열 때 거는 값과 소유 Account 를 고정한다.
  await sessions.setCliSettings(account.id, owner.id, first.id, 'codex', null);
  await ds.getRepository('AgentSessionCliSetting').update({ account_id: account.id, manager_id: first.id, cli: 'codex' }, {
    known_config_options: JSON.stringify([
      { config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: null, options: [{ value: 'gpt-launch', name: 'GPT Launch' }] },
      { config_id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', current_value: null, options: [{ value: 'high', name: 'High' }] },
    ]),
  });
  const executions = ds.getRepository('AgentSessionExecution');
  await executions.insert([
    { account_id: account.id, manager_id: first.id, cli: 'codex', session_id: 'cx-wt-2',
      config_defaults: JSON.stringify({ model: 'gpt-launch', reasoning_effort: 'high', __permission_mode: 'agent' }) },
    { account_id: foreign.id, manager_id: first.id, cli: 'codex', session_id: 'foreign-owned', config_defaults: '{}' },
    { account_id: account.id, manager_id: offline.id, cli: 'codex', session_id: 'off-1',
      config_defaults: JSON.stringify({ __permission_mode: 'read-only' }) },
  ]);

  function mcp(h, options = {}) {
    const client = new McpClient({ baseUrl: base, apiKey: options.key || h.key,
      clientInfo: { name: 'claude-agent-acp', version: 'test' }, extraHeaders: {
        ...(options.session ? { 'X-AWB-Client-Type': 'agent-session', 'X-AWB-Session-Id': options.session } : {}),
      } });
    t.after(() => client.close());
    return client;
  }
  const client = mcp(first, { session: 'cl-repo-3' });
  const denied = (result, code) => {
    assert.equal(result.isError, true, JSON.stringify(result));
    if (code) assert.equal(result.error?.code, code, JSON.stringify(result));
  };
  const ids = (result) => result.sessions.map((s) => `${s.manager_id === second.id ? 'second' : 'first'}:${s.session_id}`);

  await t.test('list_session_hosts shows only this account\'s Hosts with online state, CLIs and project folders', async () => {
    const { hosts: listed } = await client.callTool('list_session_hosts', {});
    assert.deepEqual(listed.map((h) => h.name), [first.name, second.name, offline.name]);
    const mine = listed[0];
    assert.equal(mine.manager_id, first.id);
    assert.equal(mine.is_you, true);
    assert.equal(mine.online, true);
    assert.deepEqual([...mine.session_clis].sort(), ['claude', 'codex']);
    assert.deepEqual(mine.project_folders.map((f) => `${f.project}:${f.path}`), ['Empty:/empty', 'Repo:/repo'], 'other accounts\' projects stay hidden');
    assert.equal(listed[2].online, false);
    assert.ok(!listed.some((h) => h.manager_id === outsider.id));
  });

  await t.test('list_session_folders groups sessions per Host folder and keeps empty project folders', async () => {
    const { folders } = await client.callTool('list_session_folders', {});
    const byPath = new Map(folders.map((f) => [`${f.manager_id === second.id ? 'second' : 'first'}:${f.path}`, f]));
    const repoFolder = byPath.get('first:/repo');
    assert.equal(repoFolder.sessions, 2, 'a trailing slash is the same folder; the other account\'s session is hidden');
    assert.equal(repoFolder.running, 1);
    assert.deepEqual(repoFolder.clis, ['claude', 'codex']);
    assert.deepEqual(repoFolder.project, { id: repo.id, name: 'Repo' });
    assert.equal(byPath.get('first:/repo/.awb/wt/abcd1234').project.name, 'Repo', 'a worktree belongs to its project');
    assert.equal(byPath.get('first:/empty').sessions, 0);
    assert.equal(byPath.get('second:E:\\Work\\Game').sessions, 1);
    assert.ok(!byPath.has('first:/foreign'));
    const only = await client.callTool('list_session_folders', { manager_id: second.id });
    assert.deepEqual(only.folders.map((f) => f.path), ['E:\\Work\\Game']);
  });

  await t.test('list_sessions filters by Host, CLI, folder, text, recency and running state', async () => {
    const all = await client.callTool('list_sessions', {});
    assert.deepEqual(ids(all), ['first:cx-repo-1', 'first:cl-repo-3', 'second:shared-id', 'first:cx-wt-2', 'first:shared-id']);
    assert.equal(all.total, 5);
    const busy = all.sessions[0];
    assert.equal(busy.status, 'busy');
    assert.equal(busy.opened_in_awb, false);
    assert.equal(busy.created_at, native[first.id].codex[0].created_at);
    assert.equal(busy.last_used_at, native[first.id].codex[0].updated_at);
    const launched = all.sessions.find((s) => s.session_id === 'cx-wt-2');
    assert.equal(launched.opened_in_awb, true);
    assert.equal(launched.status, 'not_running');
    assert.deepEqual([launched.model, launched.effort, launched.mode], ['gpt-launch', 'high', 'agent'], 'AWB launch settings are read through the option categories');
    assert.equal(all.sessions.find((s) => s.session_id === 'cl-repo-3').is_you, true);

    assert.deepEqual(ids(await client.callTool('list_sessions', { cwd: '/repo' })), ['first:cx-repo-1', 'first:cl-repo-3', 'first:cx-wt-2']);
    assert.deepEqual(ids(await client.callTool('list_sessions', { cwd: 'e:/work/game/' })), ['second:shared-id'], 'Windows folders ignore case and separators');
    assert.deepEqual(ids(await client.callTool('list_sessions', { query: 'LOGIN' })), ['first:cx-repo-1']);
    assert.deepEqual(ids(await client.callTool('list_sessions', { running_only: true })), ['first:cx-repo-1']);
    assert.deepEqual(ids(await client.callTool('list_sessions', { active_within_hours: 4 })), ['first:cx-repo-1', 'first:cl-repo-3', 'second:shared-id']);
    assert.deepEqual(ids(await client.callTool('list_sessions', { cli: 'claude' })), ['first:cl-repo-3']);
    assert.deepEqual(ids(await client.callTool('list_sessions', { manager_id: second.id })), ['second:shared-id']);
    const limited = await client.callTool('list_sessions', { limit: 2 });
    assert.equal(limited.total, 5);
    assert.equal(limited.returned, 2);
  });

  await t.test('details reads each session\'s native record; the running adapter wins over the record', async () => {
    const before = requests.filter((r) => r.op === 'info').length;
    const result = await client.callTool('list_sessions', { cwd: '/repo', details: true });
    assert.equal(requests.filter((r) => r.op === 'info').length - before, 3);
    const busy = result.sessions.find((s) => s.session_id === 'cx-repo-1');
    assert.deepEqual([busy.model, busy.effort, busy.mode], ['gpt-live', 'max', 'agent']);
    const launched = result.sessions.find((s) => s.session_id === 'cx-wt-2');
    assert.deepEqual([launched.model, launched.effort], ['gpt-record-wt', 'high'], 'the record wins over launch values, field by field');
  });

  await t.test('one failing Host does not hide the others', async () => {
    flags.failSecond = true;
    try {
      const result = await client.callTool('list_sessions', {});
      assert.ok(!ids(result).includes('second:shared-id'));
      assert.deepEqual(result.unreachable.map((u) => [u.manager_id, u.cli]), [[second.id, 'codex']]);
    } finally {
      flags.failSecond = false;
    }
  });

  await t.test('get_session_info resolves a bare session ID and reports settings with their sources', async () => {
    const info = await client.callTool('get_session_info', { session_id: 'cx-repo-1' });
    assert.equal(info.manager_id, first.id);
    assert.equal(info.cli, 'codex');
    assert.equal(info.cli_label, 'Codex');
    assert.deepEqual(info.host, { name: first.name, online: true });
    assert.equal(info.status, 'busy');
    assert.equal(info.title, 'Fix login throttle');
    assert.equal(info.size_bytes, 1234);
    assert.deepEqual(info.settings.model, { value: 'gpt-live', label: 'GPT Live', source: 'live' });
    assert.deepEqual(info.settings.effort, { value: 'max', source: 'record' });
    assert.equal(info.record.sandbox, 'danger-full-access');
    assert.equal(info.record.cli_version, '0.165.0');
    assert.deepEqual(info.awb, { opened: false });
    assert.equal(info.path, `/sessions/${first.id}/codex/cx-repo-1`);

    const opened = await client.callTool('get_session_info', { session_id: 'cx-wt-2' });
    assert.deepEqual(opened.settings.model, { value: 'gpt-record-wt', source: 'record' });
    assert.deepEqual(opened.settings.effort, { value: 'high', label: 'High', source: 'awb_launch' });
    assert.deepEqual(opened.settings.mode, { value: 'agent', source: 'awb_launch' });
    assert.equal(opened.awb.opened, true);
    assert.equal(opened.awb.launch_config.__permission_mode, 'agent');
    assert.ok(opened.awb.first_opened_at);

    assert.equal((await client.callTool('get_session_info', { session_id: 'cl-repo-3' })).is_you, true);
  });

  await t.test('ambiguous, foreign, unknown and offline sessions', async () => {
    denied(await client.callTool('get_session_info', { session_id: 'shared-id' }), 'session_ambiguous');
    const chosen = await client.callTool('get_session_info', { session_id: 'shared-id', manager_id: second.id });
    assert.equal(chosen.cwd, 'E:\\Work\\Game');
    denied(await client.callTool('get_session_info', { session_id: 'foreign-owned' }), 'session_not_found');
    denied(await client.callTool('get_session_info', { session_id: 'foreign-owned', manager_id: first.id, cli: 'codex' }), 'session_not_found');
    assert.ok(!requests.some((r) => r.op === 'info' && r.session_id === 'foreign-owned'), 'another account\'s session record is never read');
    denied(await client.callTool('get_session_info', { session_id: 'nope' }), 'session_not_found');
    denied(await client.callTool('get_session_info', { session_id: 'cx-repo-1', manager_id: outsider.id }), 'account_access_denied');

    const parked = await client.callTool('get_session_info', { session_id: 'off-1' });
    assert.deepEqual(parked.host, { name: offline.name, online: false });
    assert.equal(parked.status, 'not_running');
    assert.deepEqual(parked.settings.mode, { value: 'read-only', source: 'awb_launch' });
    assert.match(parked.notes[0], /offline/);
  });

  await t.test('an outdated manager still answers from the listing, with a note', async () => {
    flags.outdatedInfo = true;
    try {
      const info = await client.callTool('get_session_info', { session_id: 'cl-repo-3' });
      assert.equal(info.title, 'Claude review');
      assert.equal(info.record, null);
      assert.match(info.notes[0], /manager_outdated/);
    } finally {
      flags.outdatedInfo = false;
    }
  });

  await t.test('lookups never claim the driver of a session someone is watching', async () => {
    await sessions.prompt(account.id, other.id, first.id, 'codex', 'cx-wt-2', 'watching');
    assert.equal(sessions.liveSnapshot(first.id, 'codex', 'cx-wt-2')?.driver_user_id, other.id);
    await client.callTool('get_session_info', { session_id: 'cx-wt-2' });
    await client.callTool('list_sessions', { details: true });
    assert.equal(sessions.liveSnapshot(first.id, 'codex', 'cx-wt-2')?.driver_user_id, other.id);
  });

  await t.test('read-only and runtime keys, and owners without the session permission, are refused', async () => {
    const read = await createApiKey(app, getDataSourceToken, first.id, { accountId: account.id, scope: 'read' });
    denied(await mcp(first, { key: read.raw_key }).callTool('list_sessions', {}));
    const runtime = await createApiKey(app, getDataSourceToken, first.id, { accountId: account.id });
    await ds.getRepository('ApiKey').update(runtime.id, { name: 'runtime:worker:rt-1234567890123456' });
    denied(await mcp(first, { key: runtime.raw_key }).callTool('list_session_hosts', {}), 'host_key_required');
    denied(await client.callTool('list_session_folders', { manager_id: outsider.id }), 'account_access_denied');
    await ds.getRepository('User').update(owner.id, { role: 'user', permissions: '[]' });
    try {
      denied(await client.callTool('get_session_info', { session_id: 'cx-repo-1' }), 'session_permission_required');
    } finally {
      await ds.getRepository('User').update(owner.id, { role: 'admin' });
    }
  });
  assert.deepEqual(rpcErrors, []);
});
