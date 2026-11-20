import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createUser, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

process.env.AGENT_DEV_MODE = 'false';
process.env.AWB_PREVIEW_DOMAIN = 'preview.example.net';
process.env.AWB_PUBLIC_URL = 'https://awb.example.org';

// Exercise the exact Host and path a TLS terminator sends to AWB.
function view(port, host, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a session hands one browser read access to one approved host port', async t => {
  const { app, port, modules: { AuthService, getDataSourceToken } } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const owner = await createUser(app, getDataSourceToken, { name: 'preview-owner' });
  const stranger = await createUser(app, getDataSourceToken, { name: 'other-admin', role: 'admin' });
  const account = await createAccount(app, getDataSourceToken, 'preview', { ownerUserId: owner.id });
  const host = await createAgent(app, getDataSourceToken, account.id, { type: 'manager' });
  const managerKey = runtimeHostKeyForAgent(host.id);
  const base = 'http://127.0.0.1:' + port;
  const endpoint = base + '/api/agent-sessions/hosts/' + host.id + '/codex/sessions/session-1/web-preview';
  const auth = app.get(AuthService);
  const login = auth.createSession(owner.id);
  const headers = { Authorization: 'Bearer ' + login, 'Content-Type': 'application/json' };
  const post = (path, body) => fetch(base + path, {
    method: 'POST', headers: { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const heartbeat = await post('/api/agent/instance-heartbeat', {
    agent_id: host.id, host_id: host.id, instance_id: 'preview-instance', mode: 'manager', hostname: 'preview',
    acp_session_clis: ['codex'], web_preview_ports: [5173, 5173, 0, 'all'], pid: 1, started_at: new Date().toISOString(),
  });
  assert.equal(heartbeat.status, 201, await heartbeat.text());
  const stream = await openSseStream(port, managerKey);
  t.after(() => stream.close());
  const { AgentSessionsService } = await import('../dist/modules/agent-sessions/agent-sessions.service.js');
  const sessions = app.get(AgentSessionsService);
  const rpc = async (op, result) => {
    const { data } = await stream.waitFor('agent_session_request', f => f.payload.op === op);
    assert.equal(data.scope.account_id, account.id);
    assert.equal(data.payload.account_id, account.id);
    assert.equal(data.payload.manager_id, host.id);
    if (op === 'web_preview') {
      const reply = { ok: true, result };
      assert.equal(sessions.resolveRpc(data.payload.request_id, host.id, reply).ok, false);
      assert.equal(sessions.resolveRpc(data.payload.request_id, host.id, reply, 'different-account').ok, false);
    }
    const response = await post('/api/agent/sessions/rpc/' + data.payload.request_id, { manager_id: host.id, ok: true, result });
    assert.equal(response.status, 200, await response.text());
    return data.payload;
  };

  assert.equal((await fetch(endpoint)).status, 401);
  const foreign = { Authorization: 'Bearer ' + auth.createSession(stranger.id), 'X-Account-Id': account.id };
  assert.equal((await fetch(endpoint, { headers: foreign })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: foreign })).status, 403);
  assert.deepEqual(await (await fetch(endpoint, { headers })).json(), { configured: true, active: 0, ports: [5173] });
  const ask = url => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ url }) });
  assert.equal((await ask('http://localhost:3000')).status, 403);
  assert.equal((await ask('https://example.org/a')).status, 400);
  assert.equal((await ask('http://user:pass@localhost:5173')).status, 400);
  assert.equal((await view(port, 'unknown.preview.example.net', '/api/health')).status, 404);

  async function issue() {
    const pending = ask('http://localhost:5173/demo?q=1#section');
    await rpc('info', { session: { session_id: 'session-1' } });
    const response = await pending;
    assert.equal(response.status, 201, response.statusText);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { action, ticket } = await response.json();
    const url = new URL(action);
    assert.equal(url.protocol, 'https:');
    assert.match(url.hostname, /^awb-preview-[a-f0-9]{32}\.preview\.example\.net$/);
    assert.ok(!action.includes(ticket));
    const activate = () => view(port, url.hostname, url.pathname, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket }).toString() });
    const ready = await activate();
    assert.equal(ready.status, 303);
    assert.equal(ready.headers.location, url.origin + '/demo?q=1#section');
    const [setCookie] = ready.headers['set-cookie'];
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(setCookie.includes(attr));
    assert.ok(!setCookie.includes('Domain='));
    assert.equal((await activate()).status, 403, 'handoff is single use');
    return { host: url.hostname, cookie: setCookie.split(';')[0] };
  }

  const first = await issue();
  assert.equal((await view(port, first.host, '/demo')).status, 403, 'the URL alone cannot open the site');
  const asset = view(port, first.host, '/assets/main.js?v=2', { headers: { Cookie: first.cookie, Authorization: headers.Authorization } });
  const payload = await rpc('web_preview', { status: 200, mime_type: 'text/javascript', base64: Buffer.from('window.ready=true').toString('base64') });
  assert.deepEqual(payload.web_preview, { protocol: 'http:', host: 'localhost', port: 5173, path: '/assets/main.js?v=2', method: 'GET' });
  const resource = await asset;
  assert.equal(resource.status, 200);
  assert.equal(resource.body, 'window.ready=true');
  assert.equal(resource.headers['content-type'], 'text/javascript');
  assert.match(resource.headers['content-security-policy'], /worker-src 'none'/);
  assert.match(resource.headers['cache-control'], /no-store/);
  assert.equal(resource.headers['set-cookie'], undefined);
  assert.equal((await view(port, first.host, '/', { headers: { Cookie: first.cookie, 'Service-Worker': 'script' } })).status, 403);
  assert.equal((await view(port, first.host, '/api/item', { method: 'POST', headers: { Cookie: first.cookie } })).status, 405);

  const second = await issue();
  assert.equal((await view(port, second.host, '/', { headers: { Cookie: first.cookie } })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'DELETE', headers: foreign })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'DELETE', headers })).status, 200);
  assert.equal((await view(port, first.host, '/', { headers: { Cookie: first.cookie } })).status, 403);
  const third = await issue();
  const users = app.get(getDataSourceToken()).getRepository('User');
  await users.update(owner.id, { role: 'user', permissions: '[]' });
  assert.equal((await view(port, third.host, '/', { headers: { Cookie: third.cookie } })).status, 403);
  await users.update(owner.id, { role: 'admin' });
  const fourth = await issue();
  auth.destroySession(login);
  assert.equal((await view(port, fourth.host, '/', { headers: { Cookie: fourth.cookie } })).status, 403);
});

test('handoffs and active views expire independently, even without a sweep', async t => {
  const { WebPreviewService } = await import('../dist/modules/agent-sessions/web-preview.service.js');
  const { isolatedPreviewDomain } = await import('../dist/common/web-preview-domain.js');
  assert.equal(isolatedPreviewDomain('https://login.example.net'), '');
  const s = { userId: 'u', accountId: 'a', managerId: 'm', cli: 'codex', sessionId: 's' };
  const service = new WebPreviewService({
    webPreviewPorts: async () => [5173], readSessionInfo: async () => ({ session: { session_id: 's' } }),
  }, { validateSession: () => ({ userId: 'u' }) }, {});
  t.after(() => service.onModuleDestroy());
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const issue = async () => {
    const result = await service.open(s, 'login', 'http://localhost:5173', 'https://awb.example.org');
    return { id: new URL(result.action).hostname.split('.')[0].slice('awb-preview-'.length), ticket: result.ticket };
  };
  const first = await issue();
  now += 60_001;
  assert.throws(() => service.redeem(first.id, first.ticket), { code: 'preview_closed' });
  const second = await issue();
  const { cookie } = service.redeem(second.id, second.ticket);
  now += 15 * 60_000 + 1;
  await assert.rejects(service.resource(second.id, cookie, '/', 'GET'), { code: 'preview_closed' });
});

test('parallel module loads queue and closing a preview also discards unfinished responses', async t => {
  const { WebPreviewService } = await import('../dist/modules/agent-sessions/web-preview.service.js');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let active = 0, maximum = 0, reads = 0;
  const session = { userId: 'u', accountId: 'a', managerId: 'm', cli: 'codex', sessionId: 's' };
  const service = new WebPreviewService({
    webPreviewPorts: async () => [443], readSessionInfo: async () => ({ session: { session_id: 's' } }),
    readWebPreview: async () => {
      reads++;
      maximum = Math.max(maximum, ++active);
      await blocked;
      active--;
      return { status: 200, mime_type: 'text/javascript', base64: '' };
    },
  }, { validateSession: () => ({ userId: 'u' }) }, { usersWithAccess: async () => [{ id: 'u', role: 'admin' }] });
  t.after(() => service.onModuleDestroy());
  const grant = await service.open(session, 'login', 'https://localhost/app', 'https://awb.example.org');
  const id = new URL(grant.action).hostname.split('.')[0].slice('awb-preview-'.length);
  const { cookie } = service.redeem(id, grant.ticket);
  const resources = Array.from({ length: 40 }, (_, i) => service.resource(id, cookie, '/module-' + i + '.js', 'GET'));
  const results = Promise.allSettled(resources);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(maximum > 0 && maximum < resources.length);
  service.close(session);
  release();
  assert.equal((await results).filter(r => r.status === 'rejected' && r.reason.code === 'preview_closed').length, resources.length);
  assert.equal(reads, maximum, 'queued work never reached the host after revocation');
});
