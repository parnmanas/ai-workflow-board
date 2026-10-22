// Media RPCs must carry the host account in both the SSE envelope and payload.
// An empty payload account used to pass server routing but be dropped by the
// manager's ownership guard, leaving every file preview waiting for a timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createUser, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

process.env.AGENT_DEV_MODE = 'false';

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for manager connectivity');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

test('session media reaches only its owning host with account-scoped RPCs', async t => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const { AgentConnectivityRegistry } = await import('../dist/services/agent-connectivity.registry.js');
  const connectivity = app.get(AgentConnectivityRegistry);
  const owner = await createUser(app, getDataSourceToken, { name: 'media-owner', role: 'admin' });
  const stranger = await createUser(app, getDataSourceToken, { name: 'media-stranger', role: 'admin' });
  const account = await createAccount(app, getDataSourceToken, 'media-owner', { ownerUserId: owner.id });
  const foreign = await createAccount(app, getDataSourceToken, 'media-stranger', { ownerUserId: stranger.id });
  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'media-host', type: 'codex' });
  const other = await createAgent(app, getDataSourceToken, foreign.id, { name: 'other-host', type: 'codex' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  const otherKey = runtimeHostKeyForAgent(other.id);
  const headers = {
    Authorization: `Bearer ${app.get(AuthService).createSession(owner.id)}`,
    // An ambient header must not replace the host's verified owner.
    'X-Account-Id': foreign.id,
  };
  const strangerHeaders = {
    Authorization: `Bearer ${app.get(AuthService).createSession(stranger.id)}`,
    'X-Account-Id': account.id,
  };
  const base = `http://127.0.0.1:${port}`;
  const sessionPath = `/api/agent-sessions/hosts/${managerId}/codex/sessions/native%3Amedia-test`;
  const post = (path, key, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'X-Agent-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const heartbeat = await post('/api/agent/instance-heartbeat', managerKey, {
    instance_id: 'media-host-instance', agent_id: managerId, host_id: managerId,
    mode: 'manager', hostname: 'media-host', plugin_version: 'test', cli: 'codex',
    cli_adapters: ['codex'], acp_session_clis: ['codex'], pid: 1, started_at: new Date().toISOString(),
  });
  assert.equal(heartbeat.status, 201, await heartbeat.text());

  let stream = await openSseStream(port, managerKey);
  const otherStream = await openSseStream(port, otherKey);
  t.after(() => { stream.close(); otherStream.close(); });
  const requests = [];
  const onRequest = request => requests.push(request);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const samples = [
    { name: 'stored image', op: 'image', suffix: '/image/image-ref', bytes: png },
    // Stored media is opaque here: its MIME belongs to the transcript event.
    { name: 'stored video', op: 'image', suffix: '/image/video-ref', bytes: Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex') },
    { name: 'local image', op: 'local_image', path: './shots/result.png', mime: 'image/png', bytes: png },
    { name: 'HTML report', op: 'local_image', path: './report.html', mime: 'text/html', bytes: Buffer.from('<h1>Result</h1>') },
    { name: 'Markdown report', op: 'local_image', path: './notes.md', mime: 'text/markdown', bytes: Buffer.from('# Result\n') },
  ];
  const urlFor = sample => `${base}${sessionPath}${sample.suffix || `/local-image?${new URLSearchParams({ path: sample.path, cwd: '/srv/work' })}`}`;

  for (const sample of samples) {
    await t.test(sample.name, async () => {
      const pending = fetch(urlFor(sample), { headers });
      const { data: frame } = await stream.waitFor('agent_session_request', event => event.payload.op === sample.op);
      const request = frame.payload;
      const spoof = await post(`/api/agent/sessions/rpc/${request.request_id}`, otherKey, {
        manager_id: other.manager_agent_id, ok: true, result: { base64: 'c3Bvb2Y=' },
      });
      assert.equal(spoof.status, 404, 'another host cannot answer the file request');
      const reply = await post(`/api/agent/sessions/rpc/${request.request_id}`, managerKey, {
        manager_id: managerId, ok: true, result: { base64: sample.bytes.toString('base64'), mime_type: sample.mime },
      });
      assert.equal(reply.status, 200, await reply.text());
      const response = await pending;
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), sample.bytes);
      assert.equal(response.headers.get('content-type'), sample.mime || 'application/octet-stream');
      if (sample.mime === 'text/html') assert.equal(response.headers.get('content-security-policy'), 'sandbox');
      assert.equal(frame.account_id, account.id, 'wire account matches the authenticated host');
      assert.equal(frame.scope.account_id, account.id, 'routing scope matches the authenticated host');
      assert.equal(request.account_id, account.id, 'the manager rejects missing/empty payload ownership');
      assert.equal(request.session_id, 'native:media-test');
      if (sample.path) {
        assert.equal(request.image_path, sample.path);
        assert.equal(request.cwd, '/srv/work');
      }
    });
  }

  await t.test('another account cannot read either media endpoint', async () => {
    const before = requests.length;
    for (const sample of [samples[0], samples[2]]) {
      const denied = await fetch(urlFor(sample), { headers: strangerHeaders });
      assert.equal(denied.status, 403, await denied.text());
    }
    assert.equal(requests.length, before, 'forbidden reads never reach a host');
    assert.equal(otherStream.snapshot().some(frame => frame.event === 'agent_session_request'), false);
  });

  for (const sample of [samples[0], samples[2]]) {
    await t.test(`${sample.op} keeps ownership when redelivered after reconnect`, async () => {
      stream.close();
      await waitFor(() => !connectivity.isReachable(managerId));
      const before = requests.length;
      const pending = fetch(urlFor(sample), { headers });
      await waitFor(() => requests.length > before);
      const first = requests[before];
      stream = await openSseStream(port, managerKey);
      const { data: frame } = await stream.waitFor('agent_session_request', event => event.payload.request_id === first.request_id);
      const reply = await post(`/api/agent/sessions/rpc/${first.request_id}`, managerKey, {
        manager_id: managerId, ok: true, result: { base64: sample.bytes.toString('base64'), mime_type: sample.mime },
      });
      assert.equal(reply.status, 200, await reply.text());
      const response = await pending;
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), sample.bytes);
      assert.equal(first.account_id, account.id);
      assert.equal(frame.payload.account_id, account.id);
      assert.equal(frame.scope.account_id, account.id);
      assert.equal(frame.account_id, account.id);
    });
  }
});
