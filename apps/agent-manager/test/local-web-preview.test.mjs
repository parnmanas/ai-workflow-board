import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readLocalWebPage, webPreviewPorts } from '../dist/lib/local-web-preview.js';
import { AgentSessionRunner } from '../dist/lib/agent-session-runner.js';
import { drainEvents, recordEvent } from '../dist/lib/event-log-recorder.js';

test('web preview RPC reads only the selected loopback service with fresh headers', async t => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers, method: req.method });
    if (req.url === '/move') return res.writeHead(302, { location: '/page?q=yes#top' }).end();
    if (req.url === '/away') return res.writeHead(307, { location: 'https://example.org/' }).end();
    if (req.url === '/large') return res.end(Buffer.alloc(8 * 1024 * 1024 + 1));
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'local=value' }).end('<h1>hello</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const target = { protocol: 'http:', host: 'localhost', port, path: '/page?q=yes', method: 'GET' };
  assert.deepEqual(webPreviewPorts([port, port, 0, 65536, -1, 0.5, '80', '*']), [port]);
  const read = (change = {}) => readLocalWebPage({ ...target, ...change }, [port]);
  const result = await read({ headers: { Authorization: 'example', Cookie: 'example' } });
  assert.deepEqual(result, { status: 200, mime_type: 'text/html', base64: Buffer.from('<h1>hello</h1>').toString('base64') });
  assert.equal(seen[0].path, target.path);
  assert.equal(seen[0].headers.host, 'localhost:' + port);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal((await read({ method: 'HEAD' })).base64, '');
  assert.equal(seen.at(-1).method, 'HEAD');
  assert.deepEqual(await read({ path: '/move' }), { status: 302, location: '/page?q=yes#top' });
  await assert.rejects(read({ path: '/away' }), { code: 'preview_redirect' });
  await assert.rejects(read({ path: '/large' }), { code: 'too_large' });
  const before = seen.length;
  for (const change of [{ method: 'POST' }, { path: '//example.org/' }, { path: 'http://example.org/' }, { host: 'example.org' }, { protocol: 'file:' }]) {
    await assert.rejects(read(change), { code: 'preview_invalid' });
  }
  await assert.rejects(readLocalWebPage(target, []), { code: 'preview_port_denied' });

  const replies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    replies.push(JSON.parse(init.body));
    return new Response('{}');
  });
  const runner = new AgentSessionRunner({ apiKey: 'test', url: 'http://127.0.0.1', account_id: 'owner', web_preview_ports: [port] }, { getManagerId: () => 'host' });
  t.after(() => runner.stopAll());
  const rpc = { request_id: 'r', cli: 'codex', session_id: 's', op: 'web_preview', manager_id: 'host', account_id: 'owner', web_preview: target };
  recordEvent('agent_session_request', JSON.stringify({ payload: rpc }));
  assert.deepEqual(drainEvents(), [], 'preview paths do not enter the uploaded manager event log');
  await runner.handle({ ...rpc, account_id: 'other' });
  await runner.handle({ ...rpc, manager_id: 'other' });
  assert.deepEqual(replies.map(r => r.code), ['account_access_denied', 'account_access_denied']);
  assert.equal(seen.length, before);
  await runner.handle(rpc);
  assert.deepEqual(replies.at(-1).result, result);
});
