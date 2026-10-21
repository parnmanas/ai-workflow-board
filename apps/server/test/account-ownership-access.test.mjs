import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createUser } from './helpers/fixtures.mjs';
import { INSTANCE_CONTEXT_ID } from '../dist/common/instance-context.js';

test('active users access shared work without membership while authentication and administrative permissions remain', async t => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const user = await createUser(app, getDataSourceToken, { name: 'no-membership', role: 'user' });
  const token = app.get(AuthService).createSession(user.id);
  const ticket = await ds.getRepository('Ticket').save(ds.getRepository('Ticket').create({ account_id: INSTANCE_CONTEXT_ID, title: 'shared ticket' }));
  const resource = await ds.getRepository('Resource').save(ds.getRepository('Resource').create({ account_id: INSTANCE_CONTEXT_ID, name: 'shared attachment', type: 'comment_attachment', file_data: Buffer.from('content').toString('base64'), file_mimetype: 'text/plain' }));
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}` };
  const me = await fetch(`${base}/api/auth/me`, { headers });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).accounts.length, 1);
  assert.equal((await fetch(`${base}/api/tickets/${ticket.id}`, { headers })).status, 200);
  const raw = await fetch(`${base}/api/resources/${resource.id}/raw?token=${encodeURIComponent(token)}`);
  assert.equal(raw.status, 200);
  assert.equal(await raw.text(), 'content');
  for (const path of [`/api/tickets/${ticket.id}`, `/api/resources/${resource.id}/raw`]) {
    assert.equal((await fetch(base + path)).status, 401, path);
  }
  for (const path of ['/api/users', '/api/keys', '/api/channels']) {
    assert.equal((await fetch(base + path, { headers })).status, 403, path);
  }
});
