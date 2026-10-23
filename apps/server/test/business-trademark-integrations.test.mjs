import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHmac, createHash } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createUser } from './helpers/fixtures.mjs';
import { encrypt, decryptStrict } from '../dist/services/encryption.service.js';
import { BusinessTrademarkIntegrationsService } from '../dist/modules/business/business-trademark-integrations.service.js';
import { decryptRowForExport, reencryptRowForImport } from '../dist/modules/migration/migration-crypto.js';
import { trademarkRequest, providerUrl } from '../dist/modules/business/connectors/trademark-http.js';

test('trademark integrations: authenticated connectors, durable mail/contracts and automatic read synchronization', { timeout: 120000 }, async t => {
  process.env.LOG_HTTP_BODIES = 'true';
  const { app, port, modules } = await bootApp(); t.after(() => closeTestApp(app));
  const ds = app.get(modules.getDataSourceToken()); const service = app.get(BusinessTrademarkIntegrationsService);
  const previousPublicUrl = process.env.AWB_PUBLIC_URL; process.env.AWB_PUBLIC_URL = `http://localhost:${port}`;
  t.after(() => { if (previousPublicUrl === undefined) delete process.env.AWB_PUBLIC_URL; else process.env.AWB_PUBLIC_URL = previousPublicUrl; });
  const owner = await createUser(app, modules.getDataSourceToken, { name: 'Trademark integrator', role: 'admin' });
  const other = await createUser(app, modules.getDataSourceToken, { name: 'Other owner', role: 'admin' });
  const mine = await createAccount(app, modules.getDataSourceToken, 'trademark-integrator', { ownerUserId: owner.id });
  const theirs = await createAccount(app, modules.getDataSourceToken, 'other-trademark-integrator', { ownerUserId: other.id });
  const tokens = new Map([owner, other].map(user => [user.id, app.get(modules.AuthService).createSession(user.id)]));
  const nativeFetch = globalThis.fetch; t.after(() => { globalThis.fetch = nativeFetch; });
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST', user = owner, account = mine.id, extra = {}) => {
    const res = await nativeFetch(`http://127.0.0.1:${port}/api${path}`, { method, redirect: 'manual', headers: { Authorization: `Bearer ${tokens.get(user.id)}`, 'Content-Type': 'application/json', 'X-Account-Id': account, ...extra }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const raw = await res.text(); let result; try { result = JSON.parse(raw); } catch { result = raw; }
    return { status: res.status, body: result, headers: res.headers };
  };
  const company = (await call('/business/companies', { name: 'Trademark Integrations LLC' })).body;
  const caseRoot = `/business/companies/${company.id}/trademarks`;
  const trademark = (await call(caseRoot, { mark: 'Orbit', owner_name: company.name, attorney_email: 'lawyer@law.example', domicile_country: 'KR', serial_number: '78787878' })).body;
  const root = `${caseRoot}/${trademark.id}/integrations`;
  const snapshot = async () => (await call(root)).body;
  const mark = async () => (await call(caseRoot)).body.cases[0];
  const fresh = async id => (await snapshot()).connections.find(row => row.id === id);
  const secret = 'test-only-client-secret'; const svixKey = randomBytes(32).toString('base64'); const hmacKey = 'test-only-docusign-hmac';
  const credentials = {};
  for (const [provider, credentialProvider, data] of [
    ['gmail', 'google_oauth', { client_id: 'client-gmail', client_secret: secret }],
    ['microsoft_mail', 'microsoft_oauth', { client_id: 'client-microsoft', client_secret: secret }],
    ['docusign', 'docusign_oauth', { client_id: 'client-docusign', client_secret: secret, hmac_secret: hmacKey }],
    ['clio', 'clio_oauth', { client_id: 'client-clio', client_secret: secret }],
    ['resend_inbound', 'resend_inbound', { api_key: 're-inbound-test', webhook_secret: `whsec_${svixKey}` }],
    ['uspto_tsdr', 'uspto_tsdr', { api_key: 'uspto-test' }],
  ]) credentials[provider] = await ds.getRepository('Credential').save({ account_id: mine.id, provider: credentialProvider, name: provider, agent_env: false, encrypted_data: encrypt(JSON.stringify(data)) });
  const docAccount = randomUUID(); const docTemplate = randomUUID(); let docModified = '2026-10-24T00:00:00Z'; let hiddenRecipient = false; let docName = 'Legal';
  const envelopes = new Map(); const gmail = new Map(); const graph = new Map(); const inbound = new Map();
  const mutations = []; const reads = []; const refreshes = []; const lost = new Set(); let hold; let entered; let wrongMatter = false; let unsafeXml = false;
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const email = provider => `${provider}@owner.example`;
  globalThis.fetch = async (raw, init = {}) => {
    const url = new URL(String(raw)); if (url.hostname === '127.0.0.1') return nativeFetch(raw, init);
    assert.equal(init.redirect, 'error'); const method = init.method || 'GET'; const body = init.body && init.headers['Content-Type'] === 'application/json' ? JSON.parse(init.body) : undefined;
    if (url.pathname.endsWith('/token')) {
      const form = new URLSearchParams(init.body); const client = form.get('client_id') || Buffer.from(init.headers.Authorization.slice(6), 'base64').toString().split(':')[0];
      assert.ok(client.startsWith('client-')); if (form.get('grant_type') === 'refresh_token') refreshes.push(client);
      return json({ access_token: `access-${client.slice(7)}`, refresh_token: `refresh-${client.slice(7)}-rotated`, expires_in: 3600 });
    }
    if (method === 'GET') reads.push(url.toString());
    if (url.hostname === 'gmail.googleapis.com') {
      assert.equal(init.headers.Authorization, 'Bearer access-gmail');
      if (url.pathname.endsWith('/profile')) return json({ emailAddress: email('gmail') });
      if (url.pathname.endsWith('/messages/send')) {
        mutations.push({ provider: 'gmail', body });
        const raw = Buffer.from(body.raw, 'base64url').toString(); const [headers, content] = raw.split('\r\n\r\n');
        const parsed = headers.split('\r\n').map(line => { const at = line.indexOf(':'); return { name: line.slice(0, at), value: line.slice(at + 1).trim() }; });
        const subject = parsed.find(h => h.name === 'Subject'); subject.value = Buffer.from(subject.value.slice(10, -2), 'base64').toString();
        const id = `gmail-${gmail.size + 1}`; const threadId = `thread-${gmail.size + 1}`;
        gmail.set(id, { id, threadId, labelIds: ['SENT'], internalDate: String(Date.now()), payload: { headers: parsed, mimeType: 'text/plain', body: { data: Buffer.from(content, 'base64').toString('base64url') } } });
        entered?.(); if (hold) await hold; if (lost.has('gmail')) throw new Error('provider-secret-failure');
        return json({ id, threadId });
      }
      if (url.pathname.endsWith('/messages')) { const q = url.searchParams.get('q'); const rows = [...gmail.values()].filter(row => q.endsWith(row.payload.headers.find(h => h.name === 'Message-ID').value)); return json({ messages: rows.map(row => ({ id: row.id })), resultSizeEstimate: rows.length }); }
      if (url.pathname.includes('/threads/')) { const threadId = url.pathname.split('/').at(-1); return json({ id: threadId, messages: [...gmail.values()].filter(row => row.threadId === threadId) }); }
      return json(gmail.get(url.pathname.split('/').at(-1)));
    }
    if (url.hostname === 'graph.microsoft.com') {
      assert.equal(init.headers.Authorization, 'Bearer access-microsoft'); assert.match(init.headers.Prefer, /ImmutableId/);
      if (url.pathname === '/v1.0/me') return json({ id: 'ms-user', mail: email('microsoft') });
      if (url.pathname.endsWith('/messages') && method === 'POST') {
        mutations.push({ provider: 'microsoft-draft', body }); const id = `graph-${graph.size + 1}`;
        graph.set(id, { ...body, id, isDraft: true, from: { emailAddress: { address: email('microsoft') } }, conversationId: `conversation-${id}` }); return json(graph.get(id));
      }
      if (url.pathname.endsWith('/send')) {
        const row = graph.get(url.pathname.split('/').at(-2)); assert.ok(row); row.isDraft = false; mutations.push({ provider: 'microsoft-send', id: row.id });
        if (lost.has('microsoft')) throw new Error('provider-secret-failure'); return new Response(null, { status: 202 });
      }
      if (url.pathname.endsWith('/messages')) return json({ value: [...graph.values()].filter(row => url.searchParams.get('$filter').includes(row.conversationId)) });
      return json(graph.get(url.pathname.split('/').at(-1)));
    }
    if (url.hostname === 'account-d.docusign.com') return json({ email: 'signer@owner.example', accounts: [{ account_id: docAccount, is_default: true, base_uri: 'https://demo.docusign.net', account_name: docName }] });
    if (url.hostname === 'demo.docusign.net') {
      assert.equal(init.headers.Authorization, 'Bearer access-docusign');
      if (url.pathname.includes('/templates/')) {
        if (url.pathname.endsWith('/recipients')) return json({ signers: [{ roleName: 'Client', routingOrder: '1' }], carbonCopies: [], ...(hiddenRecipient ? { agents: [{ email: 'hidden@example.invalid' }] } : {}) });
        if (url.pathname.endsWith('/documents')) return json({ templateId: docTemplate, templateDocuments: [{ documentId: '1', name: 'Engagement.pdf' }] });
        if (url.pathname.endsWith('/documents/1')) return new Response('%PDF-1.4\nReviewed agreement\n%%EOF', { headers: { 'Content-Type': 'application/pdf' } });
        return json({ templateId: docTemplate, name: 'Engagement', lastModifiedDateTime: docModified });
      }
      if (url.pathname.endsWith('/envelopes') && method === 'POST') {
        mutations.push({ provider: 'docusign', body }); const envelopeId = randomUUID(); envelopes.set(envelopeId, { envelopeId, ...body, status: 'sent' });
        if (lost.has('docusign')) throw new Error('provider-secret-failure'); return json(envelopes.get(envelopeId));
      }
      if (url.pathname.endsWith('/envelopes')) {
        const rows = [...envelopes.values()].filter(row => url.searchParams.has('transaction_ids') ? row.transactionId === url.searchParams.get('transaction_ids') : url.searchParams.get('envelope_ids').split(',').includes(row.envelopeId));
        return json({ envelopes: rows });
      }
      if (url.pathname.endsWith('/documents/combined')) return new Response('%PDF-1.4\nSigned agreement\n%%EOF');
      return json(envelopes.get(url.pathname.split('/').at(-1)));
    }
    if (url.hostname === 'app.clio.com') {
      assert.equal(init.headers.Authorization, 'Bearer access-clio');
      if (url.pathname.endsWith('/who_am_i.json')) return json({ data: { id: 17, name: 'Counsel', email: 'counsel@law.example' } });
      if (url.pathname.includes('/matters/')) return json({ data: { id: '42', display_number: 'TM-42', description: 'Private legal matter', status: 'Open' } });
      assert.equal(url.searchParams.get('matter_id'), '42');
      return json({ data: [{ id: 1, matter: { id: wrongMatter ? 99 : 42 }, name: 'Draft.pdf', summary: 'Counsel deadline', subject: 'Counsel reply', description: 'Review needed', body: 'Private reply', start_at: '2026-12-01T10:00:00Z' }], meta: { paging: {} } });
    }
    if (url.hostname === 'tsdrapi.uspto.gov') {
      assert.equal(init.headers['USPTO-API-KEY'], 'uspto-test');
      if (url.pathname.endsWith('info.json')) return json({ caseUpdateInfo: [{ serialNumber: '78787878', caseData: { lastModifiedDate: '2026-10-23' } }] });
      if (unsafeXml) return new Response('<!DOCTYPE x [<!ENTITY a "expansion">]><Trademark>&a;</Trademark>');
      return new Response(url.pathname.includes('casestatus') ? '<Trademark><ApplicationNumberText>78787878</ApplicationNumberText><MarkVerbalElementText>Orbit</MarkVerbalElementText><MarkCurrentStatusCode>630</MarkCurrentStatusCode><MarkCurrentStatusText>New Application</MarkCurrentStatusText></Trademark>' : '<CaseDocuments><Document><DocumentID>1</DocumentID><DocumentDescription>Application</DocumentDescription><MailRoomDate>2026-10-23</MailRoomDate></Document></CaseDocuments>');
    }
    if (url.hostname === 'api.resend.com') {
      assert.equal(init.headers.Authorization, 'Bearer re-inbound-test');
      if (url.pathname === '/emails/receiving') return json({ data: [...inbound.values()].map(({ text, ...rest }) => rest), has_more: false });
      return json(inbound.get(url.pathname.split('/').at(-1)));
    }
    throw new Error(`Unexpected provider request: ${url.hostname} ${url.pathname}`);
  };
  const configure = async (provider, config = {}, overrides = {}) => {
    const res = await call(root, { provider, credential_id: credentials[provider].id, config, auto_sync: false, interval_minutes: 15, ...overrides });
    assert.equal(res.status, 201, JSON.stringify(res.body)); return res.body;
  };
  const authorize = async (connection, checkCookie = false) => {
    const start = await call(`${root}/${connection.id}/authorize`, {}); assert.equal(start.status, 201, JSON.stringify(start.body));
    const url = new URL(start.body.url); const state = url.searchParams.get('state'); const cookie = start.headers.get('set-cookie').split(';')[0];
    assert.match(start.headers.get('set-cookie'), /HttpOnly/); assert.doesNotMatch(JSON.stringify(start.body), new RegExp(secret));
    if (checkCookie) { assert.equal((await call(`/business-integrations/oauth/callback?state=${state}&code=fixture`, undefined, 'GET')).status, 400); assert.ok(url.searchParams.get('code_challenge')); }
    const result = await call(`/business-integrations/oauth/callback?state=${state}&code=fixture`, undefined, 'GET', owner, mine.id, { Cookie: cookie });
    assert.equal(result.status, 303, String(result.body));
    assert.equal((await call(`/business-integrations/oauth/callback?state=${state}&code=fixture`, undefined, 'GET', owner, mine.id, { Cookie: cookie })).status, 400, 'state is single use');
    return fresh(connection.id);
  };
  const payload = provider => ({ from: email(provider), to: trademark.attorney_email, reply_to: email(provider), subject: 'Engagement inquiry', text: 'Please review the proposed engagement terms.' });
  const prepare = async (connection, value) => { const res = await call(`${root}/${connection.id}/actions`, { trademark_revision: (await mark()).revision, payload: value }); assert.equal(res.status, 201, JSON.stringify(res.body)); return res.body; };
  const approve = action => ({ confirm: true, payload_digest: action.payload_digest, revision: action.revision });
  const send = (action, overrides = {}) => call(`${root}/actions/${action.id}/send`, { ...approve(action), ...overrides });
  const reconcile = (action, external_id = '') => call(`${root}/actions/${action.id}/reconcile`, { ...approve(action), external_id });
  let google; let microsoft; let docusign; let clio; let resend; let tsdr; let signedAction;

  await t.test('catalog and account boundaries; credentials never escape', async () => {
    const view = await snapshot(); assert.equal(view.connectors.length, 6);
    assert.equal((await call(root, undefined, 'GET', other, theirs.id)).status, 403);
    const foreign = await ds.getRepository('Credential').save({ ...credentials.gmail, id: randomUUID(), account_id: theirs.id });
    assert.equal((await call(root, { provider: 'gmail', credential_id: foreign.id, config: {}, auto_sync: false, interval_minutes: 15 })).status, 400);
    google = await configure('gmail');
    assert.equal((await call(`/credentials/${credentials.gmail.id}`, { agent_env: true }, 'PATCH')).status, 409);
    assert.equal((await call(`/credentials/${credentials.gmail.id}`, undefined, 'DELETE')).status, 409);
    assert.doesNotMatch(JSON.stringify(await snapshot()), /test-only-client-secret|encrypted_data|access-gmail/);
  });
  await t.test('OAuth binds browser and owner, consumes state once, and renews tokens automatically', async () => {
    google = await authorize(google, true); assert.equal(google.identity.email, email('gmail'));
    const repo = ds.getRepository('BusinessTrademarkIntegration'); const stored = await repo.findOneByOrFail({ id: google.id });
    assert.doesNotMatch(stored.encrypted_data, /access-gmail/);
    const data = JSON.parse(decryptStrict(stored.encrypted_data)); data.tokens.expires_at = 0;
    await repo.update(google.id, { encrypted_data: encrypt(JSON.stringify(data)), auto_sync: true, next_sync_at: new Date(0).toISOString() });
    await service.tick(); assert.ok(refreshes.includes('client-gmail')); assert.equal((await fresh(google.id)).status, 'connected');
    const updated = JSON.parse(decryptStrict((await repo.findOneByOrFail({ id: google.id })).encrypted_data)); assert.equal(updated.tokens.refresh_token, 'refresh-gmail-rotated');
  });
  await t.test('Gmail sends exactly once under concurrency and keeps network outside DB transactions', async () => {
    const action = await prepare(google, payload('gmail'));
    assert.equal((await send(action, { confirm: false })).status, 400); assert.equal((await send(action, { payload_digest: 'x'.repeat(64) })).status, 409); assert.equal(mutations.length, 0);
    let release; hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
    const first = send(action); await started; assert.equal((await send(action)).status, 409);
    assert.equal((await call('/business/companies', { name: 'Independent write' })).status, 201);
    release(); hold = null; entered = null; const sent = await first; assert.equal(sent.body.status, 'sent');
    assert.equal(mutations.filter(row => row.provider === 'gmail').length, 1); assert.equal((await mark()).phase, 'preparing');
    assert.equal((await call(`${root}/${google.id}/sync`, {})).status, 201); assert.ok((await snapshot()).records.some(row => row.kind === 'email' && row.title === 'Engagement inquiry'));
  });
  await t.test('an edited case invalidates a draft, while an ambiguous Gmail send is reconciled without retry', async () => {
    const stale = await prepare(google, payload('gmail')); const current = await mark();
    await call(`${caseRoot}/${trademark.id}`, { ...current, notes: 'Changed after review' }, 'PATCH');
    assert.equal((await send(stale)).status, 409); assert.equal((await call(`${root}/actions/${stale.id}`, approve(stale), 'DELETE')).status, 200);
    const action = await prepare(google, payload('gmail')); lost.add('gmail'); const uncertain = (await send(action)).body; lost.delete('gmail');
    assert.equal(uncertain.status, 'uncertain'); const count = mutations.length;
    assert.equal((await send(uncertain)).status, 409); assert.equal((await call(`${root}/${google.id}/actions`, { trademark_revision: (await mark()).revision, payload: payload('gmail') })).status, 409);
    assert.equal((await reconcile(uncertain)).body.status, 'sent'); assert.equal(mutations.length, count);
  });
  await t.test('Microsoft draft checkpoints survive a lost send response and correlate replies', async () => {
    microsoft = await authorize(await configure('microsoft_mail'));
    const action = await prepare(microsoft, payload('microsoft')); lost.add('microsoft'); const uncertain = (await send(action)).body; lost.delete('microsoft');
    assert.equal(uncertain.status, 'uncertain'); assert.ok(uncertain.external_id); const count = mutations.length;
    assert.equal((await reconcile(uncertain)).body.status, 'sent'); assert.equal(mutations.length, count);
    assert.equal((await call(`${root}/${microsoft.id}/sync`, {})).status, 201); assert.ok((await snapshot()).records.some(row => row.integration_id === microsoft.id));
  });
  await t.test('a failed local receipt rolls back its conversation cursor and recovers without another send', async () => {
    const action = await prepare(google, payload('gmail'));
    const repo = ds.getRepository('BusinessTrademarkIntegration');
    const before = JSON.parse(decryptStrict((await repo.findOneByOrFail({ id: google.id })).encrypted_data));
    // Inject a persistence failure after the provider accepted the mail.
    await ds.query(`CREATE TRIGGER fail_trademark_receipt BEFORE UPDATE OF encrypted_data ON business_trademark_integrations WHEN NEW.id = '${google.id}' BEGIN SELECT RAISE(ABORT, 'receipt-write-failure'); END`);
    let failed;
    try { failed = await send(action); } finally { await ds.query('DROP TRIGGER fail_trademark_receipt'); }
    assert.equal(failed.status, 500);
    const pending = (await call(`${root}/actions/${action.id}`)).body; assert.equal(pending.status, 'sending');
    assert.deepEqual(JSON.parse(decryptStrict((await repo.findOneByOrFail({ id: google.id })).encrypted_data)).cursor, before.cursor);
    const count = mutations.length; assert.equal((await reconcile(pending)).body.status, 'sent'); assert.equal(mutations.length, count);
    const after = JSON.parse(decryptStrict((await repo.findOneByOrFail({ id: google.id })).encrypted_data));
    assert.equal(JSON.parse(after.cursor.conversations).length, JSON.parse(before.cursor.conversations).length + 1);
  });
  await t.test('DocuSign previews exact documents, blocks hidden recipients and changed templates, then reconciles a lost receipt', async () => {
    docusign = await authorize(await configure('docusign', { environment: 'sandbox', template_id: docTemplate, account_id: docAccount }));
    const input = { subject: 'Trademark engagement', roles: [{ role: 'Client', name: 'Owner', email: 'signer@owner.example' }] };
    hiddenRecipient = true; assert.equal((await call(`${root}/${docusign.id}/actions`, { trademark_revision: (await mark()).revision, payload: input })).status, 400); hiddenRecipient = false;
    const action = await prepare(docusign, input); assert.deepEqual(action.review.documents, ['Engagement.pdf']); assert.equal(action.documents, undefined);
    const preview = await call(`${root}/actions/${action.id}/document?preview=0`); assert.equal(preview.status, 200); assert.match(preview.body, /^%PDF-/); assert.equal(preview.headers.get('cache-control'), 'no-store');
    docModified = '2026-10-24T01:00:00Z'; assert.equal((await send(action)).status, 409); docModified = '2026-10-24T00:00:00Z';
    lost.add('docusign'); const uncertain = (await send(action)).body; lost.delete('docusign'); assert.equal(uncertain.status, 'uncertain');
    docName = 'Renamed legal team'; docusign = await authorize(docusign); assert.equal(docusign.identity.name, docName);
    const count = mutations.length; const result = await reconcile(uncertain); assert.equal(result.body.status, 'sent', JSON.stringify(result.body)); signedAction = result.body; assert.equal(mutations.length, count);
  });
  await t.test('DocuSign Connect verifies HMAC and fetches current status even with polling disabled', async () => {
    envelopes.get(signedAction.external_id).status = 'completed';
    const raw = JSON.stringify({ event: 'envelope-completed', data: { accountId: docAccount, envelopeId: signedAction.external_id } });
    const path = `/business-integrations/webhooks/${docusign.id}`; const headers = { 'x-docusign-signature-1': createHmac('sha256', hmacKey).update(raw).digest('base64') };
    assert.equal((await call(path, raw)).status, 401); assert.equal((await call(path, raw, 'POST', owner, mine.id, headers)).status, 201);
    const replay = JSON.stringify({ event: 'envelope-sent', data: { accountId: docAccount, envelopeId: signedAction.external_id } });
    assert.equal((await call(path, replay, 'POST', owner, mine.id, { 'x-docusign-signature-1': createHmac('sha256', hmacKey).update(replay).digest('base64') })).status, 201);
    const action = (await snapshot()).actions.find(row => row.id === signedAction.id); assert.equal(action.external_status, 'completed');
    assert.match((await call(`${root}/actions/${action.id}/document`)).body, /Signed agreement/);
  });
  await t.test('Resend receiving validates Svix before parsing and only imports this case address', async () => {
    resend = await configure('resend_inbound', { inbound_domain: 'reply.owner.example' });
    inbound.set('received-1', { id: 'received-1', to: [resend.reply_address], from: 'Counsel <lawyer@law.example>', subject: 'Terms for review', text: 'Private counsel response', created_at: '2026-10-24T00:00:00Z', attachments: [] });
    inbound.set('received-other', { id: 'received-other', to: ['another@reply.owner.example'], from: 'other@law.example', subject: 'Do not import', text: 'Unrelated' });
    assert.equal((await call(`${root}/${resend.id}/sync`, {})).status, 201);
    const raw = JSON.stringify({ type: 'email.received', data: { email_id: 'received-1', to: [resend.reply_address] } }); const timestamp = String(Math.floor(Date.now() / 1000)); const eventId = 'event-1';
    const headers = { 'svix-id': eventId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${createHmac('sha256', Buffer.from(svixKey, 'base64')).update(`${eventId}.${timestamp}.${raw}`).digest('base64')}` };
    const path = `/business-integrations/webhooks/${resend.id}`;
    assert.equal((await call(path, 'not json')).status, 401); assert.equal((await call(path, raw, 'POST', owner, mine.id, headers)).status, 201);
    assert.equal((await call(path, raw, 'POST', owner, mine.id, headers)).status, 201);
    const rows = (await snapshot()).records.filter(row => row.integration_id === resend.id); assert.equal(rows.length, 1); assert.equal(rows[0].text, 'Private counsel response');
  });
  await t.test('Clio reads only the approved matter; TSDR imports official status and rejects DTDs', async () => {
    clio = await authorize(await configure('clio', { region: 'us', matter_id: '42' }));
    assert.equal((await call(`${root}/${clio.id}/sync`, {})).status, 201); const original = (await snapshot()).records.filter(row => row.integration_id === clio.id); assert.equal(original.length, 4);
    wrongMatter = true; assert.equal((await call(`${root}/${clio.id}/sync`, {})).status, 400); wrongMatter = false;
    assert.deepEqual((await snapshot()).records.filter(row => row.integration_id === clio.id), original);
    tsdr = await configure('uspto_tsdr'); assert.equal((await call(`${root}/${tsdr.id}/sync`, {})).status, 201);
    assert.ok((await snapshot()).records.some(row => row.kind === 'status' && row.status === 'New Application'));
    unsafeXml = true; assert.equal((await call(`${root}/${tsdr.id}/sync`, {})).status, 400); unsafeXml = false;
    assert.equal((await mark()).phase, 'preparing');
  });
  await t.test('encrypted migrations, safe public data and disconnect stop further background work', async () => {
    for (const name of ['BusinessTrademarkIntegration', 'BusinessTrademarkRecord', 'BusinessTrademarkAction']) {
      const row = await ds.getRepository(name).findOneByOrFail({ account_id: mine.id }); assert.match(row.encrypted_data, /^enc:/);
      const exported = decryptRowForExport(name, row); assert.deepEqual(decryptRowForExport(name, reencryptRowForImport(name, exported)), exported);
    }
    assert.doesNotMatch(JSON.stringify(await snapshot()), /test-only-client-secret|access-gmail|provider-secret-failure|refresh-gmail/);
    const row = await fresh(google.id); assert.equal((await call(`${root}/${row.id}`, { revision: row.revision }, 'DELETE')).status, 200);
    const count = reads.length; await service.tick(); assert.equal(reads.length, count);
    const saved = JSON.parse(decryptStrict((await ds.getRepository('BusinessTrademarkIntegration').findOneByOrFail({ id: row.id })).encrypted_data)); assert.equal(saved.tokens, undefined);
    assert.equal((await call(`${root}/${row.id}/sync`, {})).status, 409);
  });
});

test('trademark transport rejects non-provider URLs and does not forward provider bodies', async t => {
  for (const url of ['http://api.resend.com/emails', 'https://api.resend.com.evil.invalid/', 'https://user:secret@api.resend.com/', 'https://127.0.0.1/', 'https://evil.docusign.net/']) assert.throws(() => providerUrl(url));
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, init) => { assert.equal(init.redirect, 'error'); return new Response('sensitive-provider-body', { status: 403 }); };
  await assert.rejects(trademarkRequest('https://api.resend.com/emails'), error => !error.message.includes('sensitive-provider-body'));
  globalThis.fetch = async () => new Response('x'.repeat(2_000_001));
  await assert.rejects(trademarkRequest('https://api.resend.com/emails'));
});
