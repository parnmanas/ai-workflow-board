// A native CLI session keeps its original execution account and settings even
// when the page's account or the defaults for future sessions change — with one
// explicit exception: Restart rebinds the credential (only) to the owning
// account's current CLI settings, so a login that hit its usage limit can be
// swapped from the Host settings (docs/agent-sessions.md "실행 고정").
// Runs through the real HTTP/DB stack on either sql.js or PostgreSQL; only the
// manager's native CLI adapter is mocked with its normal reverse-RPC protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createUser, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';

process.env.AGENT_DEV_MODE = 'false';
process.env.ENCRYPTION_KEY ||= 'isolated-agent-session-execution-test-key';

async function call(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* preserve non-JSON failure text */ }
  return { status: response.status, body, text, headers: response.headers };
}

const configOptions = [{
  config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: 'model-original',
  options: ['model-original', 'model-explicit'].map(value => ({ value, name: value })),
}];

test('native execution pins ownership, credential and runtime settings across ambient accounts and reboot', async (t) => {
  let boot = await bootApp({ port: 0 });
  let removeManagerMock = () => {};
  t.after(async () => {
    removeManagerMock();
    if (boot) await closeTestApp(boot.app);
  });
  const { getDataSourceToken, AuthService, activityEvents } = boot.modules;
  let ds = boot.app.get(getDataSourceToken());
  let base = `http://127.0.0.1:${boot.port}`;
  const accountA = await createAccount(boot.app, getDataSourceToken, 'execution-A');
  const accountB = await createAccount(boot.app, getDataSourceToken, 'execution-B');
  const owner = await createUser(boot.app, getDataSourceToken, { name: 'execution-owner', role: 'user' });
  const otherUser = await createUser(boot.app, getDataSourceToken, { name: 'execution-other', role: 'user' });
  for (const user of [owner, otherUser]) {
    await ds.getRepository('User').update(user.id, { permissions: JSON.stringify(['agent_sessions.use']) });
  }
  const tupleRepo = ds.getRepository('RelationTuple');
  await tupleRepo.save([
    tupleRepo.create({ subject_type: 'user', subject_id: owner.id, relation: 'owner', object_type: 'account', object_id: accountA.id }),
    tupleRepo.create({ subject_type: 'user', subject_id: owner.id, relation: 'member', object_type: 'account', object_id: accountB.id }),
    tupleRepo.create({ subject_type: 'user', subject_id: otherUser.id, relation: 'member', object_type: 'account', object_id: accountB.id }),
  ]);
  let ownerToken = boot.app.get(AuthService).createSession(owner.id);
  let otherToken = boot.app.get(AuthService).createSession(otherUser.id);
  const headers = (accountId, token = ownerToken) => ({
    Authorization: `Bearer ${token}`, 'X-Account-Id': accountId, 'Content-Type': 'application/json',
  });
  const manager = await createAgent(boot.app, getDataSourceToken, accountA.id, { name: 'execution-host', type: 'claude' });
  const foreignManager = await createAgent(boot.app, getDataSourceToken, accountB.id, { name: 'foreign-host', type: 'claude' });
  const managerId = manager.manager_agent_id;
  const managerHeaders = { 'X-Agent-Key': runtimeHostKeyForAgent(manager.id), 'Content-Type': 'application/json' };
  const cliPath = `/api/agent-sessions/hosts/${managerId}/claude`;
  // ':' is a valid native ID character and is percent-encoded by the client.
  // Account lookup must use the decoded ID before any read or control request.
  const nativeId = `native:pinned:${randomUUID()}`;
  const sessionPath = `${cliPath}/sessions/${encodeURIComponent(nativeId)}`;
  const requests = [];
  const rpcFailures = [];
  let nextNewSessionId = null;
  let listedSessions = [];

  function installManagerMock() {
    const listener = payload => {
      if (payload.manager_id !== managerId) return;
      requests.push(structuredClone(payload));
      if (!payload.request_id) return;
      const returnedId = payload.session_id || nextNewSessionId;
      const result = payload.op === 'open'
        ? { session_id: returnedId, cwd: '/tmp/execution-fixture', title: 'Pinned native session', status: 'ready', config_options: configOptions }
        : payload.op === 'history'
          ? { session: { session_id: returnedId, cwd: '/tmp/execution-fixture', title: 'Pinned native session', source: 'cli' }, events: [] }
          : { sessions: listedSessions };
      void call(`${base}/api/agent/sessions/rpc/${payload.request_id}`, {
        method: 'POST', headers: managerHeaders,
        body: JSON.stringify({ manager_id: managerId, ok: true, result }),
      }).then(response => {
        if (response.status !== 200) rpcFailures.push(response.text);
      }).catch(error => rpcFailures.push(String(error)));
    };
    activityEvents.on('agent_session_request', listener);
    removeManagerMock = () => activityEvents.removeListener('agent_session_request', listener);
  }
  async function heartbeat() {
    const response = await call(`${base}/api/agent/instance-heartbeat`, {
      method: 'POST', headers: managerHeaders,
      body: JSON.stringify({
        instance_id: `execution-test-${managerId}`, agent_id: managerId, host_id: managerId,
        mode: 'manager', hostname: 'execution-host', plugin_version: 'test', cli: 'claude',
        cli_adapters: ['claude'], acp_session_clis: ['claude'], pid: 4242, started_at: new Date().toISOString(),
      }),
    });
    assert.ok(response.status < 300, response.text);
  }
  async function ready() {
    const response = await call(`${base}/api/agent/sessions/${managerId}/claude/${nativeId}`, {
      method: 'PATCH', headers: managerHeaders,
      body: JSON.stringify({ manager_id: managerId, status: 'ready', config_options: configOptions }),
    });
    assert.equal(response.status, 200, response.text);
  }
  async function setDefaults(accountId, credential, profile, defaultConfig) {
    const response = await call(`${base}${cliPath}/settings`, {
      method: 'PUT', headers: headers(accountId),
      body: JSON.stringify({ credential_id: credential.id, backend_profile_id: profile.id, default_config: defaultConfig }),
    });
    assert.equal(response.status, 200, response.text);
    return response.body;
  }
  async function send(op, body = {}, ambientAccount = accountB.id) {
    const before = requests.length;
    const response = await call(`${base}${sessionPath}/${op}`, {
      method: 'POST', headers: headers(ambientAccount), body: JSON.stringify(body),
    });
    assert.equal(response.status, 202, response.text);
    const expectedOp = op === 'config-option' ? 'set_config_option' : op === 'mode' ? 'set_mode' : op;
    const request = requests.slice(before).find(item => item.op === expectedOp);
    assert.ok(request, `${op} reaches the native manager`);
    return request;
  }
  const { encrypt } = await import('../dist/services/encryption.service.js');
  async function credential(accountId, name) {
    const repo = ds.getRepository('Credential');
    return repo.save(repo.create({
      account_id: accountId, name, description: '', provider: 'claude_api_key',
      encrypted_data: encrypt(JSON.stringify({ api_key: `sk-fixture-${name}` })),
    }));
  }
  async function profile(name) {
    const repo = ds.getRepository('ClaudeBackendProfile');
    return repo.save(repo.create({
      id: `execution-${name}-${randomUUID()}`, name: `execution-${name}-${randomUUID()}`,
      protocol: 'anthropic-compatible', base_url: `https://${name}.fixture.invalid`, model: `backend-${name}`, config: '{}',
    }));
  }
  const originalCredential = await credential(accountA.id, 'original-A');
  const replacementCredential = await credential(accountA.id, 'replacement-A');
  const ambientCredential = await credential(accountB.id, 'ambient-B');
  const originalProfile = await profile('original');
  const replacementProfile = await profile('replacement');
  const ambientProfile = await profile('ambient');
  const originalConfig = { model: 'model-original', reasoning: 'high', approvals: true };
  let originalRuntime;
  // The credential the snapshot currently holds — it changes only when a restart rebinds it.
  let pinnedCredential = originalCredential;
  function assertPinned(request, expectedConfig = originalConfig) {
    assert.equal(request.account_id, accountA.id, 'native execution resolves its owning account');
    assert.equal(request.credential_id, pinnedCredential.id, 'existing session keeps its snapshot credential');
    assert.deepEqual(request.config_defaults, expectedConfig, 'defaults for future sessions cannot silently reconfigure this session');
    assert.deepEqual(request.runtime_profile, originalRuntime, 'runtime endpoint is a snapshot rather than a mutable profile reference');
  }
  installManagerMock();
  await heartbeat();

  await t.test('opening a known native session persists its original execution snapshot', async () => {
    await setDefaults(accountA.id, originalCredential, originalProfile, originalConfig);
    await setDefaults(accountB.id, ambientCredential, ambientProfile, { model: 'model-ambient', reasoning: 'low', approvals: false });
    const before = requests.length;
    const response = await call(`${base}${cliPath}/sessions`, {
      method: 'POST', headers: headers(accountA.id), body: JSON.stringify({ session_id: nativeId, cwd: '/tmp/execution-fixture' }),
    });
    assert.equal(response.status, 201, response.text);
    const request = requests.slice(before).find(item => item.op === 'open');
    assert.ok(request);
    originalRuntime = request.runtime_profile;
    assert.equal(originalRuntime.id, originalProfile.id);
    assert.equal(originalRuntime.base_url, originalProfile.base_url);
    assertPinned(request);
    const stored = await ds.getRepository('AgentSessionExecution').findOneBy({ manager_id: managerId, cli: 'claude', session_id: nativeId });
    assert.equal(stored.account_id, accountA.id);
    assert.equal(stored.credential_id, originalCredential.id);
    assert.deepEqual(JSON.parse(stored.config_defaults), originalConfig);
    assert.deepEqual(JSON.parse(stored.runtime_profile), originalRuntime);
  });

  await t.test('changed account defaults and an ambient account do not alter prompt; restart rebinds only the credential', async () => {
    await setDefaults(accountA.id, replacementCredential, replacementProfile, { model: 'model-replacement', reasoning: 'low', approvals: false });
    // Editing the catalog entry itself must also leave the execution unchanged.
    await ds.getRepository('ClaudeBackendProfile').update(originalProfile.id, { base_url: 'https://edited.fixture.invalid', model: 'backend-edited' });
    assertPinned(await send('prompt', { text: 'Continue with the original execution' }));
    // Until a restart, the manager can still fetch the credential referenced only by the snapshot.
    const pinnedSecret = await call(`${base}/api/agent/sessions/credential/${originalCredential.id}?account_id=${accountA.id}`, { headers: managerHeaders });
    assert.equal(pinnedSecret.status, 200, pinnedSecret.text);
    assert.equal(pinnedSecret.body.fields.api_key, 'sk-fixture-original-A');
    await ready();
    // Restart takes the owner's current CLI login — from the owning account (A), not the ambient one (B) —
    // while model/mode choices and the backend endpoint stay as they were.
    pinnedCredential = replacementCredential;
    assertPinned(await send('restart'));
    const stored = await ds.getRepository('AgentSessionExecution').findOneBy({ manager_id: managerId, cli: 'claude', session_id: nativeId });
    assert.equal(stored.credential_id, replacementCredential.id, 'the snapshot follows, so later prompts reopen on the same login');
    await ready();
    const defaults = await call(`${base}${cliPath}/settings`, { headers: headers(accountA.id) });
    assert.equal(defaults.status, 200, defaults.text);
    assert.equal(defaults.body.credential.id, replacementCredential.id);
    assert.equal(defaults.body.backend.id, replacementProfile.id);
    assert.equal(defaults.body.default_config.model, 'model-replacement');
  });

  await t.test('reopening an existing native ID from another ambient account resolves the original owner', async () => {
    const before = requests.length;
    const response = await call(`${base}${cliPath}/sessions`, {
      method: 'POST', headers: headers(accountB.id), body: JSON.stringify({ session_id: nativeId }),
    });
    assert.equal(response.status, 201, response.text);
    assertPinned(requests.slice(before).find(item => item.op === 'open'));
  });

  await t.test('a native manager obtains the bound secret, and not the one a restart released', async () => {
    const released = await call(`${base}/api/agent/sessions/credential/${originalCredential.id}?account_id=${accountA.id}`, { headers: managerHeaders });
    assert.equal(released.status, 403, 'nothing references the old credential after the rebind');
    const path = `/api/agent/sessions/credential/${pinnedCredential.id}`;
    const own = await call(`${base}${path}?account_id=${accountA.id}`, { headers: managerHeaders });
    assert.equal(own.status, 200, own.text);
    assert.equal(own.body.fields.api_key, 'sk-fixture-replacement-A');
    assert.equal(own.headers.get('cache-control'), 'no-store');
    const wrongAccount = await call(`${base}${path}?account_id=${accountB.id}`, { headers: managerHeaders });
    assert.equal(wrongAccount.status, 403, wrongAccount.text);
    const wrongHost = await call(`${base}${path}?account_id=${accountA.id}`, {
      headers: { 'X-Agent-Key': runtimeHostKeyForAgent(foreignManager.id) },
    });
    assert.equal(wrongHost.status, 403, wrongHost.text);
    const stored = await ds.getRepository('AgentSessionExecution').findOneBy({ manager_id: managerId, cli: 'claude', session_id: nativeId });
    assert.ok(!JSON.stringify(stored).includes('sk-fixture-'), 'execution rows contain secret references, never decrypted secret material');
  });

  await t.test('explicit session configuration changes its snapshot while preserving credential and endpoint', async () => {
    const config = { ...originalConfig, model: 'model-explicit' };
    const request = await send('config-option', { config_id: 'model', value: 'model-explicit' });
    assertPinned(request, config);
    assert.equal(request.config_value, 'model-explicit');
    assertPinned(await send('mode', { mode_id: 'agent' }), { ...config, __mode: 'agent' });
    await ready();
    assertPinned(await send('prompt', { text: 'Use the model explicitly selected for this native session' }), { ...config, __mode: 'agent' });
    assertPinned(await send('restart'), { ...config, __mode: 'agent' });
    await ready();
    const settingsA = await call(`${base}${cliPath}/settings`, { headers: headers(accountA.id) });
    const settingsB = await call(`${base}${cliPath}/settings`, { headers: headers(accountB.id) });
    assert.equal(settingsA.body.credential.id, replacementCredential.id);
    assert.equal(settingsA.body.default_config.model, 'model-explicit');
    assert.equal(settingsA.body.default_config.reasoning, 'low', 'explicit model update preserves other future-session defaults');
    assert.equal(settingsB.body.credential.id, ambientCredential.id);
    assert.equal(settingsB.body.default_config.model, 'model-ambient', 'ambient account settings remain independent');
  });

  await t.test('permission to use the ambient account cannot grant access to the native execution owner', async () => {
    const allowed = await call(`${base}${cliPath}/settings`, { headers: headers(accountB.id, otherToken) });
    assert.equal(allowed.status, 200, 'actor has the session feature permission and access to account B');
    const before = requests.length;
    const deniedOpen = await call(`${base}${cliPath}/sessions`, {
      method: 'POST', headers: headers(accountB.id, otherToken), body: JSON.stringify({ session_id: nativeId }),
    });
    assert.equal(deniedOpen.status, 403, deniedOpen.text);
    for (const [suffix, method, body] of [
      ['', 'GET', undefined],
      ['/prompt', 'POST', { text: 'Unauthorized prompt' }],
      ['/restart', 'POST', {}],
      ['/config-option', 'POST', { config_id: 'model', value: 'model-original' }],
      ['/mode', 'POST', { mode_id: 'default' }],
      ['/cancel', 'POST', {}],
      ['/close', 'POST', {}],
    ]) {
      const response = await call(`${base}${sessionPath}${suffix}`, {
        method, headers: headers(accountB.id, otherToken), ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 403, `${method} ${suffix || 'history'}: ${response.text}`);
    }
    assert.equal(requests.length, before, 'denied access never reaches the native manager');
    const snapshot = await ds.getRepository('AgentSessionExecution').findOneBy({ manager_id: managerId, cli: 'claude', session_id: nativeId });
    assert.equal(snapshot.account_id, accountA.id);
    assert.equal(JSON.parse(snapshot.config_defaults).model, 'model-explicit');
  });

  await t.test('native listings hide inaccessible execution metadata and preserve authorized and unbound sessions', async () => {
    const privateTitle = 'Private account A execution title';
    const privateFolder = '/private/account-a/execution-folder';
    const unboundId = `native:unbound:${randomUUID()}`;
    listedSessions = [
      { session_id: nativeId, title: privateTitle, cwd: privateFolder, source: 'cli' },
      { session_id: unboundId, title: 'Unbound native session', cwd: '/tmp/unbound-native', source: 'cli' },
    ];
    const restricted = await call(`${base}${cliPath}/sessions`, { headers: headers(accountB.id, otherToken) });
    assert.equal(restricted.status, 200, restricted.text);
    assert.deepEqual(restricted.body.map(session => session.session_id), [unboundId]);
    for (const secretMetadata of [nativeId, privateTitle, privateFolder]) {
      assert.ok(!restricted.text.includes(secretMetadata), 'inaccessible native IDs, titles and folders are omitted');
    }
    const bothMember = await call(`${base}${cliPath}/sessions`, { headers: headers(accountB.id) });
    assert.equal(bothMember.status, 200, bothMember.text);
    assert.deepEqual(bothMember.body.map(session => session.session_id), [nativeId, unboundId]);
    assert.equal(bothMember.body[0].title, privateTitle);
    assert.equal(bothMember.body[0].cwd, privateFolder);
    const admin = await createUser(boot.app, getDataSourceToken, { name: 'execution-list-admin', role: 'admin' });
    const adminToken = boot.app.get(AuthService).createSession(admin.id);
    const unrestricted = await call(`${base}${cliPath}/sessions`, { headers: headers(accountB.id, adminToken) });
    assert.equal(unrestricted.status, 200, unrestricted.text);
    assert.deepEqual(unrestricted.body.map(session => session.session_id), [nativeId, unboundId]);
    listedSessions = [];
  });

  await t.test('a newly created native session uses current defaults without changing older sessions', async () => {
    nextNewSessionId = `native-new-${randomUUID()}`;
    const before = requests.length;
    const response = await call(`${base}${cliPath}/sessions`, {
      method: 'POST', headers: headers(accountA.id), body: JSON.stringify({ cwd: '/tmp/execution-fixture' }),
    });
    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.session_id, nextNewSessionId);
    const request = requests.slice(before).find(item => item.op === 'open');
    assert.equal(request.credential_id, replacementCredential.id);
    assert.equal(request.runtime_profile.id, replacementProfile.id);
    assert.equal(request.config_defaults.model, 'model-explicit');
    assert.equal(request.config_defaults.reasoning, 'low');
    const newSnapshot = await ds.getRepository('AgentSessionExecution').findOneBy({ manager_id: managerId, cli: 'claude', session_id: nextNewSessionId });
    assert.equal(newSnapshot.account_id, accountA.id);
    assert.equal(newSnapshot.credential_id, replacementCredential.id);
    assertPinned(await send('restart'), { ...originalConfig, model: 'model-explicit', __mode: 'agent' });
  });

  await t.test('database snapshot survives a complete server reboot with no live session cache', async () => {
    removeManagerMock();
    await closeTestApp(boot.app);
    boot = null;
    boot = await bootApp({ port: 0 });
    ds = boot.app.get(getDataSourceToken());
    base = `http://127.0.0.1:${boot.port}`;
    ownerToken = boot.app.get(AuthService).createSession(owner.id);
    otherToken = boot.app.get(AuthService).createSession(otherUser.id);
    installManagerMock();
    await heartbeat();
    assertPinned(await send('prompt', { text: 'Continue after server restart' }), { ...originalConfig, model: 'model-explicit', __mode: 'agent' });
    assertPinned(await send('restart'), { ...originalConfig, model: 'model-explicit', __mode: 'agent' });
    const response = await call(`${base}/api/agent/sessions/credential/${pinnedCredential.id}?account_id=${accountA.id}`, { headers: managerHeaders });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.fields.api_key, 'sk-fixture-replacement-A');
    const denied = await call(`${base}${sessionPath}/restart`, {
      method: 'POST', headers: headers(accountB.id, otherToken), body: '{}',
    });
    assert.equal(denied.status, 403, denied.text);
  });
  assert.deepEqual(rpcFailures, [], 'all mocked manager RPC responses were accepted');
});
