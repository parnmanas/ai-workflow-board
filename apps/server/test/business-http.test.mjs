import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createUser } from './helpers/fixtures.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { BusinessService } from '../dist/modules/business/business.service.js';
import { activityEvents } from '../dist/services/activity.service.js';

test('Business: owned workflows, dependency transitions, credential protection and read races', { timeout: 120000 }, async t => {
  const { app, port, modules } = await bootApp();
  t.after(() => closeTestApp(app));
  const ds = app.get(modules.getDataSourceToken());
  const owner = await createUser(app, modules.getDataSourceToken, { name: 'Business owner', role: 'admin' });
  const other = await createUser(app, modules.getDataSourceToken, { name: 'Other admin', role: 'admin' });
  const plain = await createUser(app, modules.getDataSourceToken, { name: 'No business permission', role: 'user' });
  const mine = await createAccount(app, modules.getDataSourceToken, 'business-owner', { ownerUserId: owner.id });
  const theirs = await createAccount(app, modules.getDataSourceToken, 'business-other', { ownerUserId: other.id });
  const nativeFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = nativeFetch; });
  const tokens = new Map([owner, other, plain].map(u => [u.id, app.get(modules.AuthService).createSession(u.id)]));
  const call = async (path, { method = 'GET', body, user = owner, account = mine.id } = {}) => {
    const response = await nativeFetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { Authorization: `Bearer ${tokens.get(user.id)}`, 'Content-Type': 'application/json', 'X-Account-Id': account },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const post = (path, body) => call(path, { method: 'POST', body });
  const patch = (path, body) => call(path, { method: 'PATCH', body });

  assert.equal((await call('/business/companies', { user: plain, account: undefined })).status, 403);
  assert.equal((await post('/business/companies', { name: '' })).status, 400);
  const created = await post('/business/companies', { name: 'Example Co', entity_type: 'CCorp', jurisdiction: 'DE', description: 'An operating company' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  const url = `/business/companies/${id}`;
  const detail = async () => (await call(url)).body;
  let state = await detail();
  assert.equal(state.company.account_id, mine.id);
  assert.equal(state.tasks.length, 21);
  assert.equal(new Set(state.tasks.map(task => task.stage)).size, 7);
  assert.equal((await call(url, { user: other, account: theirs.id })).status, 403, 'administrators cannot cross company owners');
  assert.equal((await call('/business/companies', { user: other, account: theirs.id })).body.length, 0);
  assert.equal((await post('/business/companies', { name: 'Forged owner', account_id: theirs.id })).status, 403);

  const updated = await patch(url, { name: 'Example Corporation', revision: 0 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.entity_type, 'CCorp', 'partial PATCH does not reapply creation defaults');
  assert.equal(updated.body.description, 'An operating company');
  assert.equal((await patch(url, { name: 'Stale', revision: 0 })).status, 409);
  state = await detail();
  const first = state.tasks[0]; const second = state.tasks[1];
  assert.deepEqual(second.blocked_by, [first.id]);
  assert.equal((await patch(`${url}/tasks/${second.id}`, { status: 'in_progress', revision: state.company.revision })).status, 409);
  assert.equal((await patch(`${url}/tasks/${first.id}`, { status: 'done', revision: state.company.revision })).status, 200);
  state = await detail();
  assert.deepEqual(state.tasks[1].blocked_by, []);
  assert.equal((await patch(`${url}/tasks/${second.id}`, { status: 'in_progress', revision: state.company.revision })).status, 200);
  state = await detail();
  assert.equal((await patch(`${url}/tasks/${first.id}`, { status: 'todo', revision: state.company.revision })).status, 409, 'active dependents prevent reopening their prerequisite');
  assert.equal((await patch(`${url}/tasks/${first.id}`, { depends_on: [second.id], revision: state.company.revision })).status, 400, 'dependency cycles are rejected');
  assert.equal((await patch(`${url}/tasks/${second.id}`, { due_on: '2026-02-30', revision: state.company.revision })).status, 400);
  assert.equal((await patch(`${url}/tasks/${second.id}`, { ticket_id: randomUUID(), revision: state.company.revision })).status, 400);
  assert.equal((await patch(url, { campaign_ids: [randomUUID()], revision: state.company.revision })).status, 400);
  const concurrent = await Promise.all([
    patch(`${url}/tasks/${second.id}`, { owner: 'Finance', revision: state.company.revision }),
    patch(`${url}/tasks/${second.id}`, { owner: 'Operations', revision: state.company.revision }),
  ]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  state = await detail();
  const custom = await post(`${url}/tasks`, { title: 'Reconcile monthly', stage: 'accounting', due_on: '2026-11-01', revision: state.company.revision });
  assert.equal(custom.status, 201);
  state = await detail();
  assert.equal((await call(`${url}/tasks/${custom.body.id}`, { method: 'DELETE', body: { revision: state.company.revision } })).status, 200);
  state = await detail();
  assert.equal((await call(`${url}/tasks/${first.id}`, { method: 'DELETE', body: { revision: state.company.revision } })).status, 409);
  const otherCompany = await call('/business/companies', { method: 'POST', user: other, account: theirs.id, body: { name: 'Other company' } });
  const otherTask = (await call(`/business/companies/${otherCompany.body.id}`, { user: other, account: theirs.id })).body.tasks[0];
  assert.equal((await patch(`${url}/tasks/${otherTask.id}`, { title: 'Cross-company edit', revision: state.company.revision })).status, 404);

  await t.test('task tickets commit with their link, roll back on failure and are retry safe', async () => {
    const ticketRepo = ds.getRepository('Ticket');
    const activityRepo = ds.getRepository('ActivityLog');
    const business = app.get(BusinessService);
    const ticketUrl = `${url}/tasks/${second.id}/ticket`;
    const createdEvents = [];
    const listener = event => { if (event.entity_type === 'ticket' && event.action === 'created' && event.account_id === mine.id) createdEvents.push(event); };
    activityEvents.on('activity', listener);
    t.after(() => activityEvents.off('activity', listener));
    const count = await ticketRepo.countBy({ account_id: mine.id });
    const activities = await activityRepo.countBy({ account_id: mine.id, entity_type: 'ticket' });
    const revision = state.company.revision;
    assert.equal((await post(`${url}/tasks/${first.id}/ticket`, { revision })).status, 409, 'completed work cannot create a ticket');
    const blocked = state.tasks.find(task => task.blocked_by.length > 0);
    assert.ok(blocked);
    assert.equal((await post(`${url}/tasks/${blocked.id}/ticket`, { revision })).status, 409);
    assert.equal((await post(`${url}/tasks/${otherTask.id}/ticket`, { revision })).status, 404);
    assert.equal((await call(ticketUrl, { method: 'POST', user: other, account: theirs.id, body: { revision } })).status, 403);
    assert.equal((await post(ticketUrl, { revision: revision - 1 })).status, 409);

    const failAudit = t.mock.method(business, 'event', async () => { throw new Error('fixture: audit write failed after task link'); });
    try { assert.equal((await post(ticketUrl, { revision })).status, 500); }
    finally { failAudit.mock.restore(); }
    assert.equal(await ticketRepo.countBy({ account_id: mine.id }), count, 'failed link/audit leaves no orphan ticket');
    assert.equal(await activityRepo.countBy({ account_id: mine.id, entity_type: 'ticket' }), activities);
    assert.equal((await detail()).company.revision, revision);
    assert.equal((await detail()).tasks.find(task => task.id === second.id).ticket_id, null);
    assert.equal(createdEvents.length, 0, 'rolled-back tickets emit no creation event');

    const results = await Promise.all([post(ticketUrl, { revision }), post(ticketUrl, { revision })]);
    assert.ok(results.some(result => result.status === 201), JSON.stringify(results));
    assert.ok(results.every(result => [201, 409].includes(result.status)), JSON.stringify(results));
    const ticket = results.find(result => result.status === 201).body.ticket;
    assert.equal(await ticketRepo.countBy({ account_id: mine.id }), count + 1);
    assert.equal(createdEvents.length, 1);
    const persisted = await ticketRepo.findOneByOrFail({ id: ticket.id });
    assert.equal(persisted.account_id, mine.id);
    assert.equal(persisted.status, 'backlog');
    assert.equal(persisted.assignee, null);
    assert.match(persisted.title, /Example Corporation/);
    assert.match(persisted.description, new RegExp(second.title));
    assert.equal(persisted.created_by_id, owner.id);
    assert.equal((await post(ticketUrl, { revision })).body.ticket.id, ticket.id, 'retry returns the existing ticket');
    state = await detail();
    assert.equal(state.tasks.find(task => task.id === second.id).ticket.id, ticket.id);
    assert.equal(state.tasks.find(task => task.id === second.id).status, 'in_progress', 'creating a ticket does not change workflow status');
    assert.equal(state.company.revision, revision + 1);
  });

  await t.test('business permission alone cannot create execution tickets', async () => {
    const operator = await createUser(app, modules.getDataSourceToken, { name: 'Business only', role: 'custom' });
    await ds.getRepository('User').update(operator.id, { permissions: JSON.stringify(['business.manage']) });
    const operatorAccount = await createAccount(app, modules.getDataSourceToken, 'business-only', { ownerUserId: operator.id });
    tokens.set(operator.id, app.get(modules.AuthService).createSession(operator.id));
    const options = { user: operator, account: operatorAccount.id };
    const ownCompany = await call('/business/companies', { ...options, method: 'POST', body: { name: 'Own company' } });
    assert.equal(ownCompany.status, 201);
    const ownUrl = `/business/companies/${ownCompany.body.id}`;
    const ownDetail = (await call(ownUrl, options)).body;
    assert.equal((await call(`${ownUrl}/tasks/${ownDetail.tasks[0].id}/ticket`, { ...options, method: 'POST', body: { revision: ownDetail.company.revision } })).status, 403);
    assert.equal(await ds.getRepository('Ticket').countBy({ account_id: operatorAccount.id }), 0);
  });

  const credential = async (overrides = {}) => ds.getRepository('Credential').save({
    name: 'Stripe read key', provider: 'stripe', account_id: mine.id,
    encrypted_data: encrypt(JSON.stringify({ secret_key: 'sk_test_fake_server_only' })), ...overrides,
  });
  const key = await credential();
  const connect = async (credentialId, overrides = {}) => post(`${url}/connections/stripe`, {
    credential_id: credentialId, environment: 'sandbox', config: {}, revision: (await detail()).company.revision, ...overrides,
  });
  for (const bad of [await credential({ account_id: theirs.id }), await credential({ account_id: null }), await credential({ agent_env: true }), await credential({ provider: 'custom' })]) {
    assert.equal((await connect(bad.id)).status, 400, 'credentials must be private, server-only and provider matched');
  }
  assert.equal((await connect(key.id, { config: { url: 'https://attacker.invalid' } })).status, 400, 'config cannot inject an API destination');
  assert.equal((await connect(key.id)).status, 201);
  state = await detail();
  assert.equal(state.connections[0].status, 'configured');
  assert.equal(state.connections[0].snapshot, null);
  assert.doesNotMatch(JSON.stringify(state), /sk_test_fake|encrypted_data/);
  const picker = await call('/business/credentials');
  assert.ok(picker.body.some(c => c.id === key.id));
  assert.ok(picker.body.every(c => Object.keys(c).sort().join(',') === 'id,name,provider'));
  assert.equal((await call(`/credentials/${key.id}`, { method: 'PATCH', body: { agent_env: true } })).status, 409);
  assert.equal((await call(`/credentials/${key.id}`, { method: 'DELETE' })).status, 409);

  let failure = false;
  let waitForRead;
  let enteredRead;
  const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const externalCalls = [];
  globalThis.fetch = async (input, init) => {
    const target = String(input);
    if (!target.startsWith('https://api.stripe.com/')) return nativeFetch(input, init);
    externalCalls.push({ target, init });
    assert.equal(init.method, 'GET', 'business connectors must not mutate provider state');
    assert.equal(init.redirect, 'error');
    if (failure) return new Response('secret_sk_test_do_not_echo', { status: 401 });
    if (target.endsWith('/balance')) {
      enteredRead?.();
      if (waitForRead) await waitForRead;
      return response({ livemode: false, available: [{ amount: 12345, currency: 'usd' }], pending: [] });
    }
    return response({ data: [{ id: 'txn_1', description: 'Payment', type: 'charge', status: 'available', net: 12345, currency: 'usd', created: 1700000000 }] });
  };
  const syncUrl = `${url}/connections/stripe/sync`;
  let synced = await post(syncUrl, {});
  assert.equal(synced.status, 201);
  assert.equal(synced.body.status, 'connected');
  assert.equal(synced.body.snapshot.metrics[0].amount_minor, 12345);
  assert.equal(externalCalls.length, 2);
  assert.equal((await post(syncUrl, {})).status, 409, 'debounces repeated reads');
  const clearAttempt = () => ds.getRepository('BusinessConnection').update({ company_id: id, provider: 'stripe' }, { attempted_at: null });
  await clearAttempt(); failure = true;
  synced = await post(syncUrl, {});
  assert.equal(synced.body.status, 'error');
  assert.equal(synced.body.snapshot.metrics[0].amount_minor, 12345, 'read errors retain the last successful snapshot');
  assert.doesNotMatch(JSON.stringify(synced.body), /secret_sk_test_do_not_echo|sk_test_fake/);
  failure = false; await clearAttempt();

  let releaseRead;
  waitForRead = new Promise(resolve => { releaseRead = resolve; });
  const readStarted = new Promise(resolve => { enteredRead = resolve; });
  const pendingSync = post(syncUrl, {});
  await readStarted;
  assert.equal((await post(syncUrl, {})).status, 409, 'only one in-flight read for this configuration');
  // This must finish while the external read waits: network I/O cannot hold sql.js's write queue.
  const replacement = await connect(key.id);
  assert.equal(replacement.status, 201);
  releaseRead(); waitForRead = undefined; enteredRead = undefined;
  assert.equal((await pendingSync).status, 409, 'old read cannot overwrite a newer connection');
  state = await detail();
  assert.equal(state.connections[0].status, 'configured');
  assert.equal(state.connections[0].snapshot, null);
  assert.ok(state.events.length > 0);
  assert.ok(state.events.every(e => e.account_id === mine.id));
  assert.equal((await call(`${url}/connections/stripe`, { method: 'DELETE', body: { revision: state.company.revision } })).status, 200);
  assert.equal((await call(`/credentials/${key.id}`, { method: 'DELETE' })).status, 200, 'disconnect releases credential reference');
});
