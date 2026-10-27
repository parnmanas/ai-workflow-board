import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createUser } from './helpers/fixtures.mjs';
import { LogService } from '../dist/services/log.service.js';
import { decryptRowForExport, reencryptRowForImport } from '../dist/modules/migration/migration-crypto.js';
import { encrypt } from '../dist/services/encryption.service.js';

test('Business formation: reviewed partner requests, owner boundaries, prices and retry identity', { timeout: 120000 }, async t => {
  process.env.LOG_HTTP_BODIES = 'true';
  const { app, port, modules } = await bootApp();
  t.after(() => closeTestApp(app));
  const ds = app.get(modules.getDataSourceToken());
  const owner = await createUser(app, modules.getDataSourceToken, { name: 'Formation owner', role: 'admin' });
  const other = await createUser(app, modules.getDataSourceToken, { name: 'Other owner', role: 'admin' });
  const mine = await createAccount(app, modules.getDataSourceToken, 'formation-owner', { ownerUserId: owner.id });
  const theirs = await createAccount(app, modules.getDataSourceToken, 'formation-other', { ownerUserId: other.id });
  const nativeFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = nativeFetch; });
  const tokens = new Map([owner, other].map(u => [u.id, app.get(modules.AuthService).createSession(u.id)]));
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST', user = owner, account = mine.id) => {
    const res = await nativeFetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { Authorization: `Bearer ${tokens.get(user.id)}`, 'Content-Type': 'application/json', 'X-Account-Id': account }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const credential = await ds.getRepository('Credential').save({ name: 'Partner sandbox', account_id: mine.id, provider: 'doola', agent_env: false, encrypted_data: encrypt(JSON.stringify({ api_key: 'dk_test_fixture' })) });
  let fee = 10000; let failCompany = false; let hold; let entered;
  const writes = []; const commits = new Map();
  const response = payload => new Response(JSON.stringify({ payload, error: null }), { headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
    assert.equal(url.origin, 'https://api.test.doola.com', 'all provider requests are sandbox and pinned');
    assert.equal(init.headers.Authorization, 'dk_test_fixture');
    assert.equal(init.redirect, 'error');
    if (url.pathname.endsWith('/state-fees')) return response([{ state: 'WY', priceInCents: fee }, { state: 'DE', priceInCents: 11000 }]);
    if (url.pathname.endsWith('/naics-codes')) return response([{ industry: 'Custom Computer Programming Services' }]);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body); const key = init.headers['Idempotency-Key'];
    writes.push({ path: url.pathname, key, body });
    if (url.pathname.endsWith('/signatures')) return response({ url: 'https://sign.doola.com/fixture', expiresAt: '2026-11-01T00:00:00Z' });
    assert.match(key, /^awb-formation-[\da-f-]+-(customer|company)$/);
    if (commits.has(key)) { assert.deepEqual(body, commits.get(key).body); return response(commits.get(key).value); }
    const value = url.pathname.endsWith('/customers') ? { doolaCustomerId: 'cust_fixture' } : { doolaCompanyId: `company_${commits.size}`, formationSubmissionStatus: 'PENDING', secret: 'must_not_echo' };
    commits.set(key, { body, value });
    if (url.pathname.endsWith('/companies')) {
      entered?.(); if (hold) await hold;
      if (failCompany) throw new Error('private_provider_response');
    }
    return response(value);
  };
  const makeCompany = async name => {
    const result = await call('/business/companies', { name, entity_type: 'LLC', country: 'US' });
    assert.equal(result.status, 201); return `/business/companies/${result.body.id}`;
  };
  const url = await makeCompany('Native LLC');
  const detail = async () => (await call(url)).body;
  const application = { name: 'Native', state: 'WY', industry: 'Custom Computer Programming Services', description: 'Software tools', first_name: 'Min', last_name: 'Kim', email: 'private-founder@example.invalid', address: { line1: '123 Test Road', line2: '', city: 'Seoul', state: 'Seoul', postalCode: '06134', country: 'KOR', phone: '+821012345678' } };
  const prepare = async (path = url, overrides = {}) => call(`${path}/formation/doola/prepare`, { credential_id: credential.id, environment: 'sandbox', revision: (await call(path)).body.company.revision, application, ...overrides });
  const submit = (action, path = url, extra = {}) => call(`${path}/formations/${action.id}/submit`, { payload_digest: action.payload_digest, revision: action.revision, confirm: true, ...extra });
  const catalog = (await call('/business/connectors')).body;
  assert.equal(catalog.length, 26); assert.equal(catalog.filter(c => c.mode === 'api').length, 9);
  assert.equal(catalog.find(c => c.id === 'corpnet').offering.api_access, 'partner');
  assert.equal(catalog.find(c => c.id === 'corpnet').mode, 'handoff');
  assert.equal((await call(`${url}/services/banking`, { provider: 'doola', plan: 'starter', revision: 0 })).status, 400);
  assert.equal((await call(`${url}/services/formation`, { provider: 'doola', plan: 'invented', revision: 0 })).status, 400);
  assert.equal((await call(`${url}/services/formation`, { provider: 'doola', plan: 'tax', revision: 0 })).status, 201);
  assert.deepEqual((await detail()).company.service_choices.formation, { provider: 'doola', plan: 'tax' });
  assert.equal(writes.length, 0, 'choosing a service does not purchase or submit');
  assert.equal((await prepare(url, { application: { ...application, members: [{ ownershipPercent: 50 }] } })).status, 400, 'unsupported legal structures cannot be silently stripped');
  assert.equal((await prepare(url, { application: { ...application, state: 'IN' } })).status, 400);
  assert.equal((await call(`${url}/formation/corpnet/prepare`, { credential_id: credential.id, environment: 'sandbox', revision: 1, application })).status, 400);
  let draft = await prepare(); assert.equal(draft.status, 201, JSON.stringify(draft.body)); draft = draft.body;
  assert.equal(draft.state_fee_cents, 10000); assert.equal(writes.length, 0);
  assert.doesNotMatch(JSON.stringify(await detail()), /private-founder|123 Test Road|dk_test|encrypted_request|credential_digest|customer_id/);
  const storage = await ds.getRepository('BusinessFormation').createQueryBuilder('f').addSelect('f.encrypted_request').where('f.id = :id', { id: draft.id }).getOneOrFail();
  const exported = decryptRowForExport('BusinessFormation', storage);
  assert.match(exported.encrypted_request, /private-founder/);
  const imported = reencryptRowForImport('BusinessFormation', exported);
  assert.notEqual(imported.encrypted_request, storage.encrypted_request);
  assert.equal(imported.credential_digest, storage.credential_digest, 'migration retains key binding and idempotency identity');
  assert.deepEqual(decryptRowForExport('BusinessFormation', imported), exported);
  assert.match(storage.encrypted_request, /^enc:/); assert.doesNotMatch(storage.encrypted_request, /private-founder/);
  const review = await call(`${url}/formations/${draft.id}/review`);
  assert.equal(review.body.request.customer.email, application.email);
  assert.equal(review.headers.get('cache-control'), 'no-store');
  await t.test('debug HTTP body logging excludes formation input/review/signatures and credential writes', async () => {
    const { RequestLoggerInterceptor } = await import('../dist/common/interceptors/request-logger.interceptor.js');
    const { lastValueFrom, of } = await import('rxjs');
    const logs = new LogService(); const interceptor = new RequestLoggerInterceptor(logs);
    const invoke = async (path, method, requestBody, responseBody) => {
      const req = { path, method, originalUrl: path, url: path, headers: {}, body: requestBody };
      const res = { statusCode: 200, getHeaders: () => ({}) };
      await lastValueFrom(interceptor.intercept({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) }, { handle: () => of(responseBody) }));
    };
    await invoke('/api/business/companies', 'GET', undefined, { visible: 'control' });
    for (const path of [`/api${url}/tasks`, `/api${url}/tasks/task-private`, `/api${url}/tasks/task-private/entries`, `/api${url}`, `/api${url}/cashbook/entries`, `/api${url}/cashbook/months/2020-01`, `/api${url}/self-service/assess`, `/api${url}/services/accounting`]) {
      await invoke(path, 'POST', { description: 'private-founder' }, { evidence: '123 Test Road' });
    }
    for (const [path, method] of [[`/api${url}/formation/doola/prepare`, 'POST'], [`/api${url}/formations/${draft.id}/review`, 'GET'], [`/api${url}/formations/${draft.id}/signature`, 'POST'], ['/api/credentials', 'POST'], [`/api/credentials/${credential.id}`, 'PATCH']]) {
      await invoke(path, method, { application, credentials: { api_key: 'dk_test_fixture' } }, review.body);
    }
    const httpLogs = logs.query({ category: 'HTTP' });
    assert.ok(httpLogs.some(l => l.meta?.resBody?.includes('control')), 'body capture is enabled for ordinary routes');
    assert.ok(httpLogs.filter(l => !l.message.includes('/api/business/companies →')).every(l => l.meta.reqBody === undefined && l.meta.resBody === undefined));
    assert.doesNotMatch(JSON.stringify(httpLogs), /private-founder|123 Test Road|dk_test_fixture/);
  });
  assert.equal((await call(`${url}/formations/${draft.id}/review`, undefined, 'GET', other, theirs.id)).status, 403);
  assert.equal((await call(`/credentials/${credential.id}`, { agent_env: true }, 'PATCH')).status, 409);
  assert.equal((await call(`/credentials/${credential.id}`, undefined, 'DELETE')).status, 409);
  assert.equal((await submit(draft, url, { confirm: false })).status, 400);
  assert.equal((await submit(draft, url, { payload_digest: 'not-reviewed' })).status, 409);
  fee = 11000; assert.equal((await submit(draft)).status, 409); fee = 10000;
  assert.equal(writes.length, 0, 'price drift blocks provider writes');
  await ds.getRepository('Credential').update(credential.id, { encrypted_data: encrypt(JSON.stringify({ api_key: 'dk_test_changed' })) });
  assert.equal((await submit(draft)).status, 409, 'review is bound to the original key');
  await ds.getRepository('Credential').update(credential.id, { encrypted_data: encrypt(JSON.stringify({ api_key: 'dk_test_fixture' })) });
  // A new draft changes the reviewed digest, while keeping the one logical action record.
  const old = draft; draft = (await prepare(url, { application: { ...application, description: 'Updated software tools' } })).body;
  assert.equal(draft.id, old.id); assert.equal((await submit(old)).status, 409);
  let release; hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const pending = submit(draft); await started;
  const inFlight = (await detail()).formations[0];
  assert.equal((await submit(inFlight)).status, 409);
  assert.equal((await call(`${url}/formations/${draft.id}`, { payload_digest: draft.payload_digest }, 'DELETE')).status, 409);
  assert.equal((await prepare()).status, 409);
  // DB writes finish while the remote filing is pending (no network inside the SQL transaction).
  assert.equal((await call(url, { revision: (await detail()).company.revision, description: 'Independent edit' }, 'PATCH')).status, 200);
  release(); hold = null; entered = null;
  const submitted = await pending;
  assert.equal(submitted.status, 201); assert.equal(submitted.body.status, 'submitted');
  assert.equal(writes.length, 2); assert.equal(writes[1].body.members[0].ownershipPercent, 100);
  assert.equal(writes[1].body.description, 'Updated software tools');
  assert.equal(writes[1].body.addresses[1].provider, 'registeredAgent');
  assert.equal((await submit(draft)).body.status, 'submitted'); assert.equal(writes.length, 2, 'repeated successful submission is local');
  const state = await detail(); assert.equal(state.connections[0].config.company_id, submitted.body.external_company_id);
  assert.equal(state.tasks.filter(t => t.status === 'done').length, 0, 'submission does not mean formation complete');
  assert.equal((await call(`${url}/formations/${draft.id}/review`)).body.request, null, 'sensitive input is removed after successful completion');
  assert.doesNotMatch(JSON.stringify(state), /private-founder|must_not_echo|dk_test/);
  assert.equal((await call(`${url}/formations/${draft.id}/signature`, { document_type: 'SS4' })).body.url, 'https://sign.doola.com/fixture');
  assert.equal(writes.at(-1).key, undefined, 'signature endpoint does not accept an idempotency header');

  await t.test('ambiguous response keeps exact payload and keys for explicit retry', async () => {
    const path = await makeCompany('Retry LLC'); const action = (await prepare(path)).body; failCompany = true;
    const uncertain = await submit(action, path); failCompany = false;
    assert.equal(uncertain.body.status, 'uncertain'); assert.equal((await prepare(path)).status, 409);
    assert.doesNotMatch(JSON.stringify(uncertain.body), /private_provider_response|private-founder/);
    assert.equal((await call(`${path}/formations/${action.id}`, { payload_digest: action.payload_digest }, 'DELETE')).status, 409);
    const firstWrite = writes.at(-1);
    const recovered = await submit(uncertain.body, path);
    assert.equal(recovered.body.status, 'submitted'); assert.deepEqual(writes.at(-1), firstWrite, 'same provider request and idempotency key');
    assert.equal((await call(path)).body.formations.length, 1);
  });
  await t.test('stale quotes and cross-account credentials never submit; drafts can be removed', async () => {
    const path = await makeCompany('Draft LLC'); const action = (await prepare(path)).body;
    await ds.getRepository('BusinessFormation').update(action.id, { quoted_at: '2000-01-01T00:00:00Z' });
    const before = writes.length; assert.equal((await submit(action, path)).status, 409); assert.equal(writes.length, before);
    assert.equal((await call(`${path}/formations/${action.id}`, { payload_digest: action.payload_digest }, 'DELETE')).status, 200);
    assert.equal((await call(path)).body.formations.length, 0);
    const foreign = await ds.getRepository('Credential').save({ name: 'Foreign', account_id: theirs.id, provider: 'doola', agent_env: false, encrypted_data: encrypt(JSON.stringify({ api_key: 'dk_test_fixture' })) });
    assert.equal((await prepare(path, { credential_id: foreign.id })).status, 400);
  });
});
