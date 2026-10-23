import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createUser } from './helpers/fixtures.mjs';
import { encrypt, decryptStrict } from '../dist/services/encryption.service.js';
import { decryptRowForExport, reencryptRowForImport } from '../dist/modules/migration/migration-crypto.js';

test('trademarks: owned records, existing-company checklist, reviewed mail, concurrency and bounded retries', { timeout: 120000 }, async t => {
  process.env.LOG_HTTP_BODIES = 'true';
  const { app, port, modules } = await bootApp();
  t.after(() => closeTestApp(app));
  const ds = app.get(modules.getDataSourceToken());
  const owner = await createUser(app, modules.getDataSourceToken, { name: 'Trademark owner', role: 'admin' });
  const other = await createUser(app, modules.getDataSourceToken, { name: 'Other trademark owner', role: 'admin' });
  const plain = await createUser(app, modules.getDataSourceToken, { name: 'No trademark permission', role: 'user' });
  const mine = await createAccount(app, modules.getDataSourceToken, 'trademark-owner', { ownerUserId: owner.id });
  const theirs = await createAccount(app, modules.getDataSourceToken, 'trademark-other', { ownerUserId: other.id });
  const tokens = new Map([owner, other, plain].map(user => [user.id, app.get(modules.AuthService).createSession(user.id)]));
  const nativeFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = nativeFetch; });
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST', user = owner, account = mine.id) => {
    const response = await nativeFetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { Authorization: `Bearer ${tokens.get(user.id)}`, 'Content-Type': 'application/json', 'X-Account-Id': account }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const company = (await call('/business/companies', { name: 'Brand Owner LLC' })).body;
  const base = `/business/companies/${company.id}`;
  const root = `${base}/trademarks`;
  const key = await ds.getRepository('Credential').save({ account_id: mine.id, provider: 'resend', agent_env: false, name: 'Legal mail', encrypted_data: encrypt(JSON.stringify({ api_key: 're_fixture_private' })) });
  const foreignKey = await ds.getRepository('Credential').save({ account_id: theirs.id, provider: 'resend', agent_env: false, name: 'Foreign key', encrypted_data: encrypt(JSON.stringify({ api_key: 're_fixture_foreign' })) });
  const payload = { from: 'legal@owner.example', to: 'lawyer@law.example', reply_to: 'owner@owner.example', subject: 'Engagement review', text: 'Private trademark information. Please provide a proposed agreement for review.' };
  const input = { mark: 'Orbit', owner_name: 'Brand Owner LLC', domicile_country: 'KR', goods_services: 'Software for project planning', classes: [42, 9], attorney_email: payload.to, attorney_name: 'Counsel', notes: 'Private legal notes' };
  let item = (await call(root, input)).body;
  assert.equal(item.mark, 'Orbit'); assert.deepEqual(item.classes, [9, 42]);
  assert.equal(item.encrypted_details, undefined);
  const current = async () => (await call(root)).body.cases.find(row => row.id === item.id);
  const listMail = async () => (await call(root)).body.mail;
  const prepare = async (override = {}) => call(`${root}/${item.id}/mail`, { provider: 'resend', credential_id: key.id, trademark_revision: (await current()).revision, payload, ...override });
  const approve = row => ({ revision: row.revision, payload_digest: row.payload_digest, confirm: true });
  const send = (row, extra = {}) => call(`${root}/${item.id}/mail/${row.id}/send`, { ...approve(row), ...extra });
  const discard = row => call(`${root}/${item.id}/mail/${row.id}`, { payload_digest: row.payload_digest }, 'DELETE');
  const providerWrites = []; const receipts = new Map(); const keys = new Map();
  let loseResponse = false; let hold; let entered;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === '127.0.0.1') return nativeFetch(url, init);
    assert.equal(parsed.origin, 'https://api.resend.com');
    assert.equal(init.headers.Authorization, 'Bearer re_fixture_private'); assert.equal(init.redirect, 'error');
    if (init.method === 'GET') {
      const receipt = receipts.get(parsed.pathname.split('/').at(-1));
      assert.ok(receipt, 'only known receipts can be read');
      return new Response(JSON.stringify(receipt));
    }
    assert.equal(parsed.pathname, '/emails'); assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body); const idempotency = init.headers['Idempotency-Key'];
    assert.match(idempotency, /^awb-trademark-mail-[a-f0-9-]+$/);
    providerWrites.push({ body, key: idempotency });
    if (!keys.has(idempotency)) {
      const id = randomUUID(); keys.set(idempotency, id); receipts.set(id, { ...body, id, last_event: 'delivered' });
    } else assert.deepEqual(body, (({ id, last_event, ...same }) => same)(receipts.get(keys.get(idempotency))));
    entered?.(); if (hold) await hold;
    if (loseResponse) throw new Error('must-not-leak-private-provider-error');
    return new Response(JSON.stringify({ id: keys.get(idempotency) }));
  };

  await t.test('account boundaries, encryption/migration and validation', async () => {
    assert.equal((await call(root, undefined, 'GET', other, theirs.id)).status, 403);
    assert.equal((await call(root, undefined, 'GET', plain)).status, 403);
    assert.equal((await call(`${root}/${randomUUID()}/draft`, { kind: 'quote' })).status, 404);
    const secondCompany = (await call('/business/companies', { name: 'Second company' })).body;
    assert.equal((await call(`/business/companies/${secondCompany.id}/trademarks/${item.id}/draft`, { kind: 'quote' })).status, 404);
    const read = await call(root); assert.equal(read.headers.get('cache-control'), 'no-store');
    const stored = await ds.getRepository('BusinessTrademark').findOneByOrFail({ id: item.id });
    assert.match(stored.encrypted_details, /^enc:/); assert.doesNotMatch(stored.encrypted_details, /Private legal|lawyer@/);
    const exported = decryptRowForExport('BusinessTrademark', stored);
    assert.match(exported.encrypted_details, /Private legal notes/);
    assert.deepEqual(decryptRowForExport('BusinessTrademark', reencryptRowForImport('BusinessTrademark', exported)), exported);
    for (const change of [{ next_due_on: '2026-99-99' }, { next_due_on: '2026-11-01' }, { engagement_url: 'javascript:alert(1)' }, { phase: 'examination' }, { classes: [46] }]) {
      assert.equal((await call(`${root}/${item.id}`, { ...item, ...change }, 'PATCH')).status, 400, JSON.stringify(change));
    }
    assert.equal((await call(`${root}/${item.id}`, { ...item, revision: 99 }, 'PATCH')).status, 409);
    const draft = await call(`${root}/${item.id}/draft`, { kind: 'engagement' });
    assert.match(draft.body.text, /does not accept terms or authorize payment or filing/);
    assert.match(draft.body.text, /Actual domicile country: KR/); assert.equal(providerWrites.length, 0);
  });

  await t.test('old companies add the trademark task graph once without rewriting other tasks', async () => {
    await ds.getRepository('BusinessTask').delete({ company_id: company.id, stage: 'trademark' });
    const old = (await call(base)).body;
    const untouched = old.tasks.map(task => ({ id: task.id, title: task.title, status: task.status }));
    const created = await call(`${base}/stages/trademark`, { revision: old.company.revision }); assert.equal(created.body.created, 8);
    const fresh = (await call(base)).body;
    assert.deepEqual(fresh.tasks.filter(task => task.stage !== 'trademark').map(task => ({ id: task.id, title: task.title, status: task.status })), untouched);
    assert.equal(fresh.tasks.filter(task => task.stage === 'trademark').length, 8);
    assert.equal((await call(`${base}/stages/trademark`, { revision: fresh.company.revision })).body.created, 0);
    assert.equal((await call(base)).body.tasks.length, 21);
  });

  let review;
  await t.test('mail preparation cannot send and is tied to the case, credential and immutable review', async () => {
    assert.equal((await prepare({ credential_id: foreignKey.id })).status, 400);
    assert.equal((await prepare({ payload: { ...payload, to: 'other@law.example' } })).status, 400);
    assert.equal((await prepare({ payload: { ...payload, subject: 'Subject\r\nBcc: attacker@bad.example' } })).status, 400);
    const saved = await prepare(); assert.equal(saved.status, 201); review = saved.body;
    assert.equal(providerWrites.length, 0); assert.equal(review.encrypted_payload, undefined); assert.equal(review.credential_digest, undefined);
    assert.equal((await prepare()).status, 409);
    const stored = await ds.getRepository('BusinessTrademarkMail').findOneByOrFail({ id: review.id });
    assert.doesNotMatch(stored.encrypted_payload, /Private trademark/); assert.deepEqual(JSON.parse(decryptStrict(stored.encrypted_payload)), payload);
    const exported = decryptRowForExport('BusinessTrademarkMail', stored);
    assert.deepEqual(decryptRowForExport('BusinessTrademarkMail', reencryptRowForImport('BusinessTrademarkMail', exported)), exported);
    assert.equal((await call(`/credentials/${key.id}`, { agent_env: true }, 'PATCH')).status, 409);
    assert.equal((await call(`/credentials/${key.id}`, undefined, 'DELETE')).status, 409);
    const response = await call(`${root}/${item.id}/mail/${review.id}`); assert.deepEqual(response.body.payload, payload); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await send(review, { confirm: false })).status, 400);
    assert.equal((await send(review, { payload_digest: 'a'.repeat(64) })).status, 409);
    await ds.getRepository('Credential').update(key.id, { encrypted_data: encrypt(JSON.stringify({ api_key: 're_changed' })) });
    assert.equal((await send(review)).status, 409);
    await ds.getRepository('Credential').update(key.id, { encrypted_data: encrypt(JSON.stringify({ api_key: 're_fixture_private' })) });
    item = (await call(`${root}/${item.id}`, { ...await current(), attorney_name: 'Updated counsel' }, 'PATCH')).body;
    assert.equal((await send(review)).status, 409, 'a case edit invalidates an unsent review');
    assert.equal(providerWrites.length, 0); assert.equal((await discard(review)).status, 200);
    review = (await prepare()).body;
  });

  await t.test('concurrent approvals create one external send and leave DB writes unblocked', async () => {
    let release; hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
    const first = send(review); await started;
    assert.equal((await send(review)).status, 409); assert.equal((await discard(review)).status, 409); assert.equal((await prepare()).status, 409);
    const inFlight = (await listMail()).find(row => row.id === review.id); assert.equal(inFlight.status, 'sending');
    assert.equal((await send(inFlight)).status, 409);
    assert.equal((await call(`${root}/${item.id}`, { ...await current(), notes: 'Independent edit while provider is waiting' }, 'PATCH')).status, 200);
    release(); hold = null; entered = null;
    const sent = await first; assert.equal(sent.status, 201); assert.equal(sent.body.status, 'sent'); assert.equal(providerWrites.length, 1);
    assert.equal((await send(review)).body.status, 'sent'); assert.equal(providerWrites.length, 1);
    assert.equal((await call(`${root}/${item.id}/mail/${review.id}/delivery`, {})).body.delivery_status, 'delivered');
    assert.equal((await current()).phase, 'preparing', 'provider delivery never means a contract, filing or registration happened');
  });

  await t.test('ambiguous sends retry the same payload/key only within the provider retention window', async () => {
    review = (await prepare()).body; loseResponse = true;
    let result = await send(review); loseResponse = false;
    assert.equal(result.body.status, 'uncertain'); assert.doesNotMatch(JSON.stringify(result.body), /must-not-leak/);
    assert.equal((await prepare()).status, 409); assert.equal((await discard(result.body)).status, 409);
    const previous = providerWrites.at(-1); result = await send(result.body);
    assert.equal(result.body.status, 'sent'); assert.deepEqual(providerWrites.at(-1), previous);
    review = (await prepare()).body; loseResponse = true; result = await send(review); loseResponse = false;
    const receiptId = keys.get(providerWrites.at(-1).key);
    await ds.getRepository('BusinessTrademarkMail').update(review.id, { first_attempted_at: new Date(Date.now() - 24 * 60 * 60_000).toISOString() });
    const writes = providerWrites.length; assert.equal((await send(result.body)).status, 409); assert.equal(providerWrites.length, writes);
    const mismatchId = [...receipts.keys()].find(id => id !== receiptId);
    receipts.get(mismatchId).subject = 'Different email';
    assert.equal((await call(`${root}/${item.id}/mail/${review.id}/reconcile`, { ...approve(result.body), provider_message_id: mismatchId })).status, 400);
    const reconciled = await call(`${root}/${item.id}/mail/${review.id}/reconcile`, { ...approve(result.body), provider_message_id: receiptId });
    assert.equal(reconciled.body.status, 'sent'); assert.equal(reconciled.body.provider_message_id, receiptId); assert.equal(providerWrites.length, writes);
  });

  await t.test('unresolved correspondence remains reachable beyond the recent history limit', async () => {
    const pending = (await prepare()).body;
    const repo = ds.getRepository('BusinessTrademarkMail');
    await repo.update(pending.id, { created_at: new Date('2026-01-01T00:00:00Z') });
    const template = await repo.findOneByOrFail({ id: pending.id });
    await repo.save(Array.from({ length: 201 }, (_, index) => ({ ...template, id: randomUUID(), status: 'sent',
      created_at: new Date(Date.now() + index), provider_message_id: `fixture-${index}` })));
    const rows = await listMail();
    assert.equal(rows.filter(row => row.status === 'sent').length, 200);
    assert.equal(rows.filter(row => row.id === pending.id).length, 1);
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
    assert.equal((await call(`${root}/${item.id}/mail/${pending.id}`)).body.mail.status, 'draft');
    assert.equal((await discard(pending)).status, 200);
  });

  await t.test('debug body logging never captures trademark cases, mail reviews or draft bodies', async () => {
    const { RequestLoggerInterceptor } = await import('../dist/common/interceptors/request-logger.interceptor.js');
    const { LogService } = await import('../dist/services/log.service.js');
    const { lastValueFrom, of } = await import('rxjs');
    const logs = new LogService(); const interceptor = new RequestLoggerInterceptor(logs);
    for (const path of [`/api${root}`, `/api${root}/${item.id}`, `/api${root}/${item.id}/draft`, `/api${root}/${item.id}/mail/${review.id}`]) {
      const req = { path, method: 'POST', originalUrl: path, url: path, headers: {}, body: { private: 'lawyer-secret' } };
      const res = { statusCode: 200, getHeaders: () => ({}) };
      await lastValueFrom(interceptor.intercept({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) }, { handle: () => of({ private: 'lawyer-secret' }) }));
    }
    assert.doesNotMatch(JSON.stringify(logs.query({ category: 'HTTP' })), /lawyer-secret/);
  });
});
