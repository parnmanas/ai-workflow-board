import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createUser } from './helpers/fixtures.mjs';
import { ensurePersonalAccount } from '../dist/common/personal-account.js';

test('work defaults require the owner; account creation and membership APIs are gone', async t => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken, AuthService } = modules;
  const member = await createUser(app, getDataSourceToken, { name: 'regular-user', role: 'user' });
  const admin = await createUser(app, getDataSourceToken, { name: 'administrator', role: 'admin' });
  const ds = app.get(getDataSourceToken());
  const own = await ensurePersonalAccount(ds.manager, member);
  await ensurePersonalAccount(ds.manager, admin);
  const request = (user, path, method, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${app.get(AuthService).createSession(user.id)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await request(member, `/api/accounts/${own.id}`, 'PATCH', { max_concurrent_tickets_per_agent: 3 })).status, 200);
  assert.equal((await request(admin, `/api/accounts/${own.id}`, 'PATCH', { max_concurrent_tickets_per_agent: 3 })).status, 403);
  for (const [path, method] of [
    ['/api/accounts', 'POST'],
    [`/api/accounts/${own.id}`, 'DELETE'],
    [`/api/accounts/${own.id}/members`, 'POST'],
    [`/api/accounts/${own.id}/members/${member.id}`, 'PATCH'],
    [`/api/admin/pending-users/${member.id}/assign`, 'POST'],
  ]) assert.equal((await request(member, path, method, { name: 'obsolete', user_id: member.id, relation: 'owner' })).status, 404, `${method} ${path}`);
  assert.equal(await ds.createQueryRunner().hasTable('relation_tuples'), false);
  assert.equal(await ds.getRepository('Account').count(), 2);
});
