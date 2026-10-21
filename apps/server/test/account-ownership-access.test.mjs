import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { AccountAccessService } from '../dist/services/account-access.service.js';
import { openSseStream } from './helpers/sse-listener.mjs';

test('real login identities isolate account work, catalog defaults, operators, raw artifacts and SSE even for admins', async t => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const ds = app.get(modules.getDataSourceToken());
  const auth = app.get(modules.AuthService);
  const accounts = app.get(AccountAccessService);
  const save = (entity, data) => ds.getRepository(entity).save(ds.getRepository(entity).create(data));
  const a = await save('User', { name: 'Parn', email: 'parn@example.test', status: 'active', role: 'admin', password_hash: await auth.hashPassword('test-password') });
  const b = await save('User', { name: 'kent.k', email: 'kent@example.test', status: 'active', role: 'user', permissions: JSON.stringify(['voice.use', 'agent_sessions.use', 'admin.resources']) });
  const [aid] = await accounts.accessibleIds(a);
  const [bid] = await accounts.accessibleIds(b);
  assert.notEqual(aid, bid);
  const extra = await Promise.all(Array.from({ length: 8 }, () => accounts.accessibleIds(b)));
  assert.ok(extra.every(ids => ids.length === 1 && ids[0] === bid));
  assert.equal(await ds.getRepository('Account').count(), 2);
  const tokens = { [aid]: auth.createSession(a.id), [bid]: auth.createSession(b.id) };
  const base = `http://127.0.0.1:${port}`;
  const request = async (owner, path, init = {}) => {
    const response = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${tokens[owner]}`, 'Content-Type': 'application/json', ...init.headers } });
    const raw = await response.text();
    let body; try { body = JSON.parse(raw); } catch { body = raw; }
    return { status: response.status, body };
  };
  const login = await request(aid, '/api/auth/login', { method: 'POST', body: JSON.stringify({ email: a.email, password: 'test-password' }) });
  assert.equal(login.status, 201);
  assert.deepEqual(login.body.accounts.map(row => row.id), [aid]);
  for (const owner of [aid, bid]) {
    assert.deepEqual((await request(owner, '/api/auth/me')).body.accounts.map(row => row.id), [owner]);
    assert.deepEqual((await request(owner, '/api/accounts')).body.map(row => row.id), [owner]);
    const result = await request(owner, `/api/accounts/${owner}`, { method: 'PATCH', body: JSON.stringify({ language: 'Korean' }) });
    assert.equal(result.status, 200, JSON.stringify(result));
  }
  const host = await save('RuntimeHost', { name: 'Parn host', account_id: aid, is_active: 1 });
  const ticket = await save('Ticket', { title: 'Parn ticket', account_id: aid });
  const otherTicket = await save('Ticket', { title: 'Kent ticket', account_id: bid });
  const resource = await save('Resource', { name: 'Parn artifact', type: 'comment_attachment', account_id: aid, file_data: Buffer.from('private content').toString('base64'), file_mimetype: 'text/plain' });
  for (const [owner, target] of [[aid, otherTicket], [bid, ticket]]) {
    assert.equal((await request(owner, `/api/tickets/${target.id}`)).status, 403);
    assert.equal((await request(owner, `/api/tickets/${target.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'forged' }) })).status, 403);
  }
  assert.equal((await request(aid, `/api/tickets/${ticket.id}`)).status, 200);
  assert.equal((await request(bid, `/api/accounts/${aid}`)).status, 403);
  assert.equal((await request(bid, '/api/tickets', { headers: { 'X-Account-Id': aid } })).status, 403);
  assert.equal((await fetch(`${base}/api/resources/${resource.id}/raw?token=${tokens[bid]}`)).status, 403);
  const raw = await fetch(`${base}/api/resources/${resource.id}/raw?token=${tokens[aid]}`);
  assert.equal(raw.status, 200);
  assert.equal(await raw.text(), 'private content');
  assert.equal((await request(bid, `/api/resources/upload?account_id=${aid}`, { method: 'POST', body: JSON.stringify({ file: 'bytes' }) })).status, 403);
  await save('ActivityLog', { account_id: aid, ticket_id: ticket.id, entity_type: 'ticket', entity_id: ticket.id, action: 'created', actor_name: 'Parn' });
  await save('ActivityLog', { account_id: bid, ticket_id: otherTicket.id, entity_type: 'ticket', entity_id: otherTicket.id, action: 'created', actor_name: 'Kent' });
  for (const owner of [aid, bid]) {
    const recent = await request(owner, '/api/activity');
    assert.equal(recent.status, 200);
    assert.ok(recent.body.length > 0 && recent.body.every(row => row.account_id === owner));
  }
  const privateResource = await request(aid, '/api/resources', { method: 'POST', body: JSON.stringify({ name: 'Private by default', type: 'document', content: 'content' }) });
  assert.equal(privateResource.status, 201, JSON.stringify(privateResource));
  assert.equal(privateResource.body.account_id, aid);
  const globalResource = await request(aid, '/api/resources', { method: 'POST', body: JSON.stringify({ name: 'Explicit Global', type: 'document', scope: 'global', content: 'shared content' }) });
  assert.equal(globalResource.status, 201, JSON.stringify(globalResource));
  assert.equal(globalResource.body.account_id, null);
  assert.equal((await request(bid, `/api/resources/${globalResource.body.id}`)).status, 200);
  assert.equal((await request(bid, `/api/resources/${privateResource.body.id}`)).status, 403);
  const op = await request(aid, '/api/voice/operators', { method: 'POST', body: JSON.stringify({ name: 'Jarvis', manager_id: host.id, cli: 'codex', session_id: 'parn-session' }) });
  assert.equal(op.status, 201, JSON.stringify(op));
  assert.deepEqual((await request(bid, '/api/voice/operators')).body.operators, []);
  assert.equal((await request(bid, '/api/voice/operators', { method: 'POST', body: JSON.stringify({ name: 'Stolen', manager_id: host.id, cli: 'codex', session_id: 'parn-session' }) })).status, 403);
  assert.equal((await request(bid, `/api/voice/operators/${op.body.operator.id}`, { method: 'DELETE' })).status, 404);
  const streamA = await openSseStream(port, tokens[aid], {});
  const streamB = await openSseStream(port, tokens[bid], {});
  t.after(() => { streamA.close(); streamB.close(); });
  modules.activityEvents.emit('activity', { account_id: aid, ticket_id: ticket.id, entity_id: ticket.id, entity_type: 'ticket', action: 'updated' });
  await streamA.waitFor('board_update', e => e.ticket_id === ticket.id);
  await assert.rejects(streamB.waitFor('board_update', e => e.ticket_id === ticket.id, 200), /timeout/i);
  await ds.getRepository('User').update(b.id, { status: 'rejected' });
  assert.deepEqual(await accounts.accessibleIds(b), []);
  assert.equal((await request(bid, '/api/auth/me')).status, 401);
});
