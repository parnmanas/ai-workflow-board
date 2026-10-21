import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createUser } from './helpers/fixtures.mjs';
import { INSTANCE_CONTEXT_ID } from '../dist/common/instance-context.js';

test('work defaults require an administrator; ownership creation and membership APIs are gone', async t => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken, AuthService } = modules;
  const member = await createUser(app, getDataSourceToken, { name: 'regular-user', role: 'user' });
  const admin = await createUser(app, getDataSourceToken, { name: 'administrator', role: 'admin' });
  const request = (user, path, method, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${app.get(AuthService).createSession(user.id)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await request(member, `/api/accounts/${INSTANCE_CONTEXT_ID}`, 'PATCH', { max_concurrent_tickets_per_agent: 3 })).status, 403);
  assert.equal((await request(admin, `/api/accounts/${INSTANCE_CONTEXT_ID}`, 'PATCH', { max_concurrent_tickets_per_agent: 3 })).status, 200);
  for (const [path, method] of [
    ['/api/accounts', 'POST'],
    [`/api/accounts/${INSTANCE_CONTEXT_ID}`, 'DELETE'],
    [`/api/accounts/${INSTANCE_CONTEXT_ID}/members`, 'POST'],
    [`/api/accounts/${INSTANCE_CONTEXT_ID}/members/${member.id}`, 'PATCH'],
    [`/api/admin/pending-users/${member.id}/assign`, 'POST'],
  ]) assert.equal((await request(admin, path, method, { name: 'obsolete', user_id: member.id, relation: 'owner' })).status, 404, `${method} ${path}`);
  const ds = app.get(getDataSourceToken());
  assert.equal(await ds.createQueryRunner().hasTable('relation_tuples'), false);
  assert.equal(await ds.getRepository('Account').count(), 1);
});
