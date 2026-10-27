import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { encrypt, decryptStrict } from '../dist/services/encryption.service.js';
import { LogService } from '../dist/services/log.service.js';
import { BusinessWorkflowService } from '../dist/modules/business/business-workflow.service.js';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';
import { BusinessFormationService } from '../dist/modules/business/business-formation.service.js';
import { TOOL_AUTHZ_TABLE } from '../dist/modules/mcp/shared/tool-authz-gate.js';
import { mcpRequestPreview } from '../dist/modules/mcp/shared/request-preview.js';
import { createStandaloneContext } from '../dist/modules/mcp/tools/context.js';
import { registerBusinessTools } from '../dist/modules/mcp/tools/business-tools.js';
import { registerBusinessTrademarkTools } from '../dist/modules/mcp/tools/business-trademark-tools.js';
import { registerBusinessCashbookTools } from '../dist/modules/mcp/tools/business-cashbook-tools.js';
import { registerBusinessMailTools } from '../dist/modules/mcp/tools/business-mail-tools.js';
import { MAIL_CONNECTORS } from '../dist/modules/business/mail/mail-registry.js';
import { sessionStore } from '../dist/modules/mcp/internal/session-store.js';

// Every business REST operation must have an MCP counterpart. Browser OAuth callbacks
// and signed provider webhooks are transports, not agent-callable operations.
const REST_TO_MCP = {
  BusinessMailController: { connections: 'list_business_mail_connections', configure: 'configure_business_mail_connection', sync: 'sync_business_mail', list: 'list_business_mail', detail: 'get_business_mail', confirm: 'confirm_business_mail', send: 'send_business_mail', reply: 'get_business_mail_reply', startReply: 'start_business_mail_reply', replies: 'list_business_mail_replies', editReply: 'submit_business_mail_reply' },
  BusinessController: {
    catalog: 'list_business_connectors', credentials: 'list_business_credentials', list: 'list_business_companies',
    create: 'create_business_company', detail: 'get_business_company', update: 'update_business_company',
    chooseService: 'choose_business_service', addTask: 'save_business_task', task: 'save_business_task',
    taskDetail: 'get_business_task', addTaskEntry: 'add_business_task_entry', startTask: 'start_business_work', startFormationWork: 'start_business_work',
    assessSelfService: 'assess_business_self_service',
    removeTask: 'delete_business_task', initializeTrademark: 'initialize_business_trademark_tasks', createTaskTicket: 'create_business_task_ticket',
    formationReferences: 'get_business_formation_references', prepareFormation: 'prepare_business_formation',
    reviewFormation: 'review_business_formation', submitFormation: 'submit_business_formation',
    discardFormation: 'discard_business_formation', formationSignature: 'get_business_formation_signature',
    connect: 'configure_business_connector', disconnect: 'disconnect_business_connector', sync: 'sync_business_connector',
  },
  BusinessCashbookController: {
    read: 'get_business_cashbook', add: 'add_business_cashbook_entry', reconcile: 'reconcile_business_cashbook_entry',
    void: 'void_business_cashbook_entry', close: 'close_business_cashbook_month', reopen: 'reopen_business_cashbook_month',
  },
  BusinessTrademarkController: {
    list: 'list_business_trademarks', create: 'save_business_trademark', update: 'save_business_trademark',
    draft: 'draft_business_trademark_mail', prepare: 'prepare_business_trademark_mail', review: 'review_business_trademark_mail',
    discard: 'discard_business_trademark_mail', send: 'send_business_trademark_mail', delivery: 'refresh_business_trademark_mail_delivery', reconcile: 'reconcile_business_trademark_mail',
  },
  BusinessTrademarkIntegrationsController: {
    list: 'list_business_trademark_integrations', configure: 'configure_business_trademark_integration', disconnect: 'disconnect_business_trademark_integration',
    authorize: 'authorize_business_trademark_integration', sync: 'sync_business_trademark_integration', options: 'get_business_trademark_integration_options',
    prepare: 'prepare_business_trademark_action', review: 'review_business_trademark_action', discard: 'discard_business_trademark_action',
    send: 'send_business_trademark_action', reconcile: 'reconcile_business_trademark_action', document: 'get_business_trademark_document',
  },
};
// Review approval is intentionally human-only: MCP sessions cannot authenticate a human decision.
const TRANSPORT_ONLY = ['BusinessMailController.decideReply', 'BusinessTrademarkIntegrationCallbacksController.callback', 'BusinessTrademarkIntegrationCallbacksController.webhook'];
const approval = row => ({ payload_digest: row.payload_digest, revision: row.revision, confirm: true });

test('Business MCP: full surface, real HTTP execution and live ownership', { timeout: 120000 }, async t => {
  const { app, port, modules } = await bootApp({ port: 0 }); t.after(() => closeTestApp(app));
  const token = modules.getDataSourceToken; const ds = app.get(token());
  const owner = await createUser(app, token, { name: 'Business MCP owner' });
  const other = await createUser(app, token, { name: 'Other business owner' });
  const mine = await createAccount(app, token, 'MCP business', { ownerUserId: owner.id });
  const theirs = await createAccount(app, token, 'Other business', { ownerUserId: other.id });
  const host = await createAgent(app, token, mine.id, { name: 'Business host', type: 'manager' });
  const foreignHost = await createAgent(app, token, theirs.id, { name: 'Other host', type: 'manager' });
  const clients = [];
  const clientFor = async (scope, account = mine, actor = host) => {
    const key = await createApiKey(app, token, actor.id, { scope, accountId: account.id, hostId: actor.manager_agent_id || actor.id });
    const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key }); clients.push(client);
    await client.initialize(); return client;
  };
  t.after(async () => { for (const client of clients) await client.close(); });
  const full = await clientFor('full'); const read = await clientFor('read'); const write = await clientFor('write');
  const foreign = await clientFor('full', theirs, foreignHost);
  const successful = new Set();
  const call = async (name, args = {}, client = full) => {
    const result = await client.callTool(name, args);
    assert.ok(result && !result.isError, `${name}: ${JSON.stringify(result)}`); successful.add(name); return result;
  };
  const denied = async (name, args, client = full, pattern) => {
    const result = await client.callTool(name, args);
    assert.equal(result?.isError, true, `${name}: ${JSON.stringify(result)}`);
    if (pattern) assert.match(JSON.stringify(result), pattern);
    return result;
  };
  const tools = (await full.listTools()).filter(tool => tool.name.includes('business'));

  await t.test('tools/list covers every decorated Business route and uses explicit auth tiers', async () => {
    const actual = [];
    const directory = new URL('../dist/modules/business/', import.meta.url);
    for (const file of readdirSync(directory).filter(name => name.endsWith('.controller.js'))) {
      for (const Controller of Object.values(await import(new URL(file, directory)))) {
        if (typeof Controller !== 'function' || !Controller.prototype) continue;
        for (const method of Object.getOwnPropertyNames(Controller.prototype)) {
          if (Reflect.getMetadata('method', Controller.prototype[method]) !== undefined) actual.push(`${Controller.name}.${method}`);
        }
      }
    }
    const mapped = Object.entries(REST_TO_MCP).flatMap(([controller, methods]) => Object.keys(methods).map(method => `${controller}.${method}`));
    assert.deepEqual(actual.sort(), [...mapped, ...TRANSPORT_ONLY].sort(), 'new REST operations require an MCP mapping');
    for (const name of Object.values(REST_TO_MCP).flatMap(Object.values)) assert.ok(tools.some(t => t.name === name), name);
    assert.equal(tools.length, 65);
    for (const tool of tools) assert.ok(['caller', 'full'].includes(TOOL_AUTHZ_TABLE[tool.name]), tool.name);
    assert.ok(tools.find(t => t.name === 'send_business_trademark_action').inputSchema.required.includes('confirm'));
    assert.ok(tools.find(t => t.name === 'prepare_business_formation').inputSchema.properties.application.properties.address);
    const guide = await call('get_business_workflow_guide', {}, read); assert.ok(guide.stages.includes('trademark'));
    const catalog = await call('list_business_connectors', {}, read); assert.equal(catalog.length, 26);
    const compare = await call('compare_business_services', { providers: ['doola', 'atlas'] }, read); assert.equal(compare.services.length, 2);
    await denied('compare_business_services', { providers: ['doola', 'mercury'] });
  });

  const company = await call('create_business_company', { name: 'Private Orbit LLC' }); const companyArgs = { company_id: company.id };
  const detail = () => call('get_business_company', companyArgs, read);
  const companyRevision = async () => (await detail()).company.revision;
  const privateCompany = await call('create_business_company', { name: 'Foreign LLC' }, foreign);
  await t.test('task journal is available to agents with scoped access and preserves revised results', async () => {
    const task = (await detail()).tasks[0];
    const args = { ...companyArgs, task_id: task.id };
    const entry = { request_id: randomUUID(), kind: 'result', content: 'Formation plan with supporting sources' };
    for (const client of [read, write, foreign]) await denied('add_business_task_entry', { ...args, entry }, client);
    await denied('get_business_task', args, foreign);
    const saved = await call('add_business_task_entry', { ...args, entry });
    const retry = await call('add_business_task_entry', { ...args, entry });
    assert.equal(saved.id, retry.id);
    const journal = await call('get_business_task', args, read);
    assert.equal(journal.result.content, entry.content);
    assert.equal(journal.result.author_type, 'agent');
    assert.equal(journal.task.ticket_id, null, 'recording a result does not create a ticket');
  });
  await t.test('DIY assessment and all cashbook operations are available through real MCP', async () => {
    const assessmentArgs = { ...companyArgs, provider: 'self_bookkeeping', plan: 'cashbook' };
    const assessment = await call('assess_business_self_service', assessmentArgs, read);
    assert.equal(assessment.eligible, false);
    const answers = Object.fromEntries(assessment.questions.map(q => [q.key, q.required_yes]));
    await denied('choose_business_service', { ...assessmentArgs, stage: 'accounting', revision: await companyRevision() });
    await call('choose_business_service', { ...assessmentArgs, stage: 'accounting', revision: await companyRevision(), self_service_answers: answers });
    const entryArgs = { ...companyArgs, request_id: randomUUID(), date: '2020-01-15', kind: 'income', amount_minor: 12345, currency: 'USD', description: 'Cashbook source record', evidence: 'receipt-1' };
    for (const client of [read, write, foreign]) await denied('add_business_cashbook_entry', { ...entryArgs, revision: await companyRevision() }, client);
    const row = await call('add_business_cashbook_entry', { ...entryArgs, revision: await companyRevision() });
    await denied('get_business_cashbook', { ...companyArgs, month: '2020-01' }, foreign);
    const book = await call('get_business_cashbook', { ...companyArgs, month: '2020-01' }, read);
    assert.equal(book.summary.net_minor, 12345);
    await call('reconcile_business_cashbook_entry', { ...companyArgs, entry_id: row.id, evidence: 'receipt-1 / bank-1', reconciled: true, revision: await companyRevision() });
    await call('close_business_cashbook_month', { ...companyArgs, month: '2020-01', opening_minor: 0, closing_minor: 12345, statement_reference: 'bank-1', confirm_complete: true, revision: await companyRevision() });
    await denied('void_business_cashbook_entry', { ...companyArgs, entry_id: row.id, reason: 'Wrong duplicate', revision: await companyRevision() });
    await call('reopen_business_cashbook_month', { ...companyArgs, month: '2020-01', reason: 'Review duplicate', revision: await companyRevision() });
    await call('void_business_cashbook_entry', { ...companyArgs, entry_id: row.id, reason: 'Wrong duplicate', revision: await companyRevision() });
    assert.equal((await call('get_business_cashbook', { ...companyArgs, month: '2020-01' })).summary.net_minor, 0);
  });
  const nativeFetch = globalThis.fetch; t.after(() => { globalThis.fetch = nativeFetch; });
  const publicUrl = process.env.AWB_PUBLIC_URL; process.env.AWB_PUBLIC_URL = `http://localhost:${port}`;
  t.after(() => { if (publicUrl === undefined) delete process.env.AWB_PUBLIC_URL; else process.env.AWB_PUBLIC_URL = publicUrl; });
  const credentials = {};
  for (const [provider, secrets] of [
    ['doola', { api_key: 'dk_test_mcp_secret' }], ['mercury', { api_token: 'mercury_mcp_secret' }], ['resend', { api_key: 'resend_mcp_secret' }],
    ['google_oauth', { client_id: 'test-gmail', client_secret: 'google_mcp_secret' }], ['docusign_oauth', { client_id: 'test-doc', client_secret: 'doc_mcp_secret' }],
  ]) credentials[provider] = await ds.getRepository('Credential').save({ provider, name: `Test ${provider}`, account_id: mine.id, agent_env: false, encrypted_data: encrypt(JSON.stringify(secrets)) });
  const foreignCredential = await ds.getRepository('Credential').save({ provider: 'doola', name: 'Private credential', account_id: theirs.id, agent_env: false, encrypted_data: encrypt('{}') });
  const writes = []; const unexpected = []; const resend = new Map(); const envelopes = new Map();
  const docTemplate = randomUUID(); const docAccount = randomUUID(); const pdf = '%PDF-1.4\nPrivate engagement terms\n%%EOF';
  let loseMail = false; let loseContract = false;
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const doola = payload => json({ payload, error: null });
  globalThis.fetch = async (raw, init = {}) => {
    const url = new URL(String(raw)); if (url.hostname === '127.0.0.1') return nativeFetch(raw, init);
    assert.equal(init.redirect, 'error');
    const method = init.method || 'GET'; const body = init.body ? JSON.parse(init.body) : null;
    if (method !== 'GET') writes.push({ host: url.hostname, path: url.pathname, body });
    if (url.hostname === 'api.test.doola.com') {
      if (url.pathname.endsWith('/naics-codes')) return doola([{ industry: 'Custom Computer Programming Services' }]);
      if (url.pathname.endsWith('/state-fees')) return doola([{ state: 'WY', priceInCents: 10000 }]);
      if (url.pathname.endsWith('/customers')) return doola({ doolaCustomerId: 'customer_mcp' });
      if (url.pathname.endsWith('/companies')) return doola({ doolaCompanyId: 'company_mcp', formationSubmissionStatus: 'PENDING' });
      if (url.pathname.endsWith('/signatures')) return doola({ url: 'https://sign.doola.com/test-mcp', expiresAt: '2026-11-01T00:00:00Z' });
    }
    if (url.hostname === 'api-sandbox.mercury.com') return json(url.pathname.endsWith('/accounts') ? { accounts: [{ id: 'bank-1' }] } : { transactions: [{ id: 'txn-1', amount: 12.34, status: 'sent', counterpartyName: 'Test customer' }] });
    if (url.hostname === 'api.resend.com') {
      if (method === 'POST') { const id = `resend-${resend.size + 1}`; resend.set(id, { ...body, id, last_event: 'delivered' }); if (loseMail) throw new Error('private provider error'); return json({ id }); }
      return json(resend.get(url.pathname.split('/').at(-1)));
    }
    if (url.hostname === 'demo.docusign.net') {
      if (url.pathname.endsWith(`/templates/${docTemplate}`)) return json({ templateId: docTemplate, name: 'Counsel terms', lastModifiedDateTime: '2026-10-24T00:00:00Z' });
      if (url.pathname.endsWith('/recipients')) return json({ signers: [{ roleName: 'Client', name: '', email: '', routingOrder: '1' }] });
      if (url.pathname.endsWith('/documents')) return json({ templateDocuments: [{ documentId: '1', name: 'engagement.pdf' }] });
      if (url.pathname.endsWith('/documents/1') || url.pathname.endsWith('/documents/combined')) return new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } });
      if (url.pathname.endsWith('/envelopes') && method === 'POST') { const id = randomUUID(); envelopes.set(id, { ...body, envelopeId: id, status: 'completed' }); if (loseContract) throw new Error('lost response'); return json(envelopes.get(id)); }
      if (url.pathname.endsWith('/envelopes')) return json({ envelopes: [...envelopes.values()] });
      if (envelopes.has(url.pathname.split('/').at(-1))) return json(envelopes.get(url.pathname.split('/').at(-1)));
    }
    unexpected.push(`${method} ${url}`); throw new Error('Unexpected fixture request');
  };

  await t.test('company/task mutations preserve revisions and require explicit ticket intent', async () => {
    assert.deepEqual((await call('list_business_companies', {}, read)).map(c => c.id), [company.id]);
    const changed = await call('update_business_company', { ...companyArgs, revision: await companyRevision(), changes: { description: 'Private owner instructions' } }); assert.equal(changed.name, company.name);
    await denied('update_business_company', { ...companyArgs, revision: 0, changes: { name: 'stale' } }, full, /409/);
    await call('choose_business_service', { ...companyArgs, stage: 'formation', provider: 'doola', plan: 'tax', revision: await companyRevision() });
    const task = await call('save_business_task', { ...companyArgs, revision: await companyRevision(), changes: { title: 'Explicit execution test', stage: 'formation' } });
    await call('save_business_task', { ...companyArgs, task_id: task.id, revision: await companyRevision(), changes: { notes: 'Preserve existing title' } });
    assert.equal((await detail()).tasks.find(row => row.id === task.id).title, task.title);
    assert.equal(await ds.getRepository('Ticket').countBy({ account_id: mine.id }), 0);
    await denied('create_business_task_ticket', { ...companyArgs, task_id: task.id, revision: await companyRevision() });
    const ticket = await call('create_business_task_ticket', { ...companyArgs, task_id: task.id, revision: await companyRevision(), user_requested_ticket: true }); assert.ok(ticket.id); assert.equal(ticket.status, 'backlog');
    const retry = await call('create_business_task_ticket', { ...companyArgs, task_id: task.id, revision: 0, user_requested_ticket: true }); assert.equal(retry.id, ticket.id);
    assert.equal(await ds.getRepository('Ticket').countBy({ account_id: mine.id }), 1);
    await denied('delete_business_task', { ...companyArgs, task_id: task.id, revision: await companyRevision() });
    const disposable = await call('save_business_task', { ...companyArgs, revision: await companyRevision(), changes: { title: 'Unstarted work', stage: 'formation' } });
    await call('delete_business_task', { ...companyArgs, task_id: disposable.id, revision: await companyRevision() });
    assert.ok(await ds.getRepository('Ticket').existsBy({ id: ticket.id }));
    assert.equal((await call('initialize_business_trademark_tasks', { ...companyArgs, revision: await companyRevision() })).created, 0);
    const metadata = await call('list_business_credentials', {}, read); assert.ok(metadata.some(c => c.id === credentials.doola.id));
    assert.doesNotMatch(JSON.stringify(metadata), /_secret|encrypted|Private credential/);
    const connection = { ...companyArgs, provider: 'mercury' };
    await call('configure_business_connector', { ...connection, revision: await companyRevision(), credential_id: credentials.mercury.id, environment: 'sandbox', config: {} });
    await call('sync_business_connector', connection);
    assert.equal((await detail()).connections[0].snapshot.records[0].amount_minor, 1234);
    await call('disconnect_business_connector', { ...connection, revision: await companyRevision() });
  });

  await t.test('formation prepare/review/submit/signature execute through the same durable service', async () => {
    const input = { ...companyArgs, provider: 'doola', credential_id: credentials.doola.id, environment: 'sandbox' };
    const references = await call('get_business_formation_references', input, read); assert.ok(references.industries.length);
    const application = { name: 'Private Orbit', state: 'WY', industry: references.industries[0], description: 'Software tools', first_name: 'Private', last_name: 'Founder', email: 'private-founder@example.invalid', address: { line1: 'Private home address', city: 'Seoul', state: 'Seoul', postalCode: '06134', country: 'KOR', phone: '+821012345678' } };
    // Use current revisions on every prepared request, never silently retry a stale draft.
    const draft = await call('prepare_business_formation', { ...input, revision: await companyRevision(), application });
    const args = { ...companyArgs, action_id: draft.id };
    const review = await call('review_business_formation', args, read); assert.equal(review.request.customer.email, application.email);
    await denied('submit_business_formation', { ...args, ...approval(draft), payload_digest: '0'.repeat(64) });
    await denied('submit_business_formation', { ...args, ...approval(draft), confirm: false });
    assert.equal(writes.filter(w => w.host === 'api.test.doola.com').length, 0);
    await call('discard_business_formation', { ...args, payload_digest: draft.payload_digest, confirm: true });
    const next = await call('prepare_business_formation', { ...input, revision: await companyRevision(), application });
    const submitted = await call('submit_business_formation', { ...companyArgs, action_id: next.id, ...approval(next) }); assert.equal(submitted.status, 'submitted');
    await call('get_business_formation_signature', { ...companyArgs, action_id: next.id, document_type: 'SS4', confirm: true });
    assert.equal(writes.filter(w => w.host === 'api.test.doola.com').length, 3);
    assert.doesNotMatch(JSON.stringify(await detail()), /Private home address|private-founder|_mcp_secret/);
  });

  let trademark; let trademarkArgs; let mailRow; let actionRow; let integration;
  await t.test('trademark replacement, draft, Resend send/delivery and uncertain reconciliation', async () => {
    trademark = await call('save_business_trademark', { ...companyArgs, details: { mark: 'Orbit', owner_name: company.name, attorney_email: 'lawyer@law.example', domicile_country: 'KR', classes: [42, 9, 42] } });
    trademarkArgs = { ...companyArgs, trademark_id: trademark.id };
    assert.deepEqual(trademark.classes, [9, 42]);
    trademark = await call('save_business_trademark', { ...trademarkArgs, revision: trademark.revision, details: { ...Object.fromEntries(Object.entries(trademark).filter(([key]) => !['id', 'company_id', 'account_id', 'revision', 'created_at', 'updated_at'].includes(key))), notes: 'Private counsel notes' } });
    assert.equal((await call('list_business_trademarks', companyArgs, read)).cases[0].revision, trademark.revision);
    const draft = await call('draft_business_trademark_mail', { ...trademarkArgs, kind: 'engagement' }, read);
    const payload = { ...draft, from: 'owner@owner.example', reply_to: 'owner@owner.example' };
    const prepare = () => call('prepare_business_trademark_mail', { ...trademarkArgs, provider: 'resend', credential_id: credentials.resend.id, trademark_revision: trademark.revision, payload });
    mailRow = await prepare();
    let args = { ...trademarkArgs, mail_id: mailRow.id };
    assert.equal((await call('review_business_trademark_mail', args, read)).payload.text, draft.text);
    await denied('send_business_trademark_mail', { ...args, ...approval(mailRow), confirm: false });
    await call('discard_business_trademark_mail', { ...args, payload_digest: mailRow.payload_digest, confirm: true });
    mailRow = await prepare(); args = { ...trademarkArgs, mail_id: mailRow.id };
    mailRow = await call('send_business_trademark_mail', { ...args, ...approval(mailRow) }); assert.equal(mailRow.status, 'sent');
    mailRow = await call('refresh_business_trademark_mail_delivery', args); assert.equal(mailRow.delivery_status, 'delivered');
    const lost = await prepare(); loseMail = true;
    const uncertain = await call('send_business_trademark_mail', { ...trademarkArgs, mail_id: lost.id, ...approval(lost) }); loseMail = false;
    assert.equal(uncertain.status, 'uncertain');
    const reconciled = await call('reconcile_business_trademark_mail', { ...trademarkArgs, mail_id: lost.id, ...approval(uncertain), provider_message_id: 'resend-2' }); assert.equal(reconciled.status, 'sent');
    assert.equal(writes.filter(w => w.host === 'api.resend.com').length, 2, 'reconciliation never resends');
  });

  await t.test('OAuth browser handoff, contract options, exact review PDFs, send and reconcile', async () => {
    const catalog = await call('list_business_trademark_integrations', trademarkArgs, read); assert.equal(catalog.connectors.length, 6);
    const gmail = await call('configure_business_trademark_integration', { ...trademarkArgs, provider: 'gmail', credential_id: credentials.google_oauth.id, config: {}, auto_sync: false, interval_minutes: 15 });
    const oauth = await call('authorize_business_trademark_integration', { ...trademarkArgs, integration_id: gmail.id });
    const link = new URL(oauth.url); assert.equal(link.pathname, '/business/operations'); assert.equal(link.searchParams.get('trademark'), trademark.id); assert.equal(link.searchParams.get('authorize'), gmail.id);
    assert.doesNotMatch(JSON.stringify(oauth), /cookie|code_verifier|access_token|client_secret|google_mcp_secret/);
    assert.equal((await ds.getRepository('BusinessTrademarkIntegration').findOneBy({ id: gmail.id })).oauth_state_hash, null, 'MCP does not start a cookie-less consent flow');
    await call('disconnect_business_trademark_integration', { ...trademarkArgs, integration_id: gmail.id, revision: gmail.revision });
    integration = await call('configure_business_trademark_integration', { ...trademarkArgs, provider: 'docusign', credential_id: credentials.docusign_oauth.id, config: { template_id: docTemplate, environment: 'sandbox' }, auto_sync: false, interval_minutes: 15 });
    // Existing browser/callback tests cover real OAuth. Here seed an already consented fixture.
    const repo = ds.getRepository('BusinessTrademarkIntegration'); const row = await repo.findOneBy({ id: integration.id });
    const data = JSON.parse(decryptStrict(row.encrypted_data));
    data.tokens = { access_token: 'doc-access-private', refresh_token: 'doc-refresh-private', expires_at: Date.now() + 3600000 };
    data.identity = { account_id: docAccount, base_uri: 'https://demo.docusign.net', email: 'owner@owner.example' };
    await repo.update({ id: row.id }, { status: 'connected', encrypted_data: encrypt(JSON.stringify(data)) });
    const connection = { ...trademarkArgs, integration_id: row.id };
    const options = await call('get_business_trademark_integration_options', connection); assert.equal(options.roles[0].role, 'Client');
    const prepare = () => call('prepare_business_trademark_action', { ...connection, trademark_revision: trademark.revision, payload: { subject: 'Private counsel agreement', roles: [{ role: 'Client', name: 'Private Owner', email: 'owner@owner.example' }] } });
    actionRow = await prepare();
    let args = { ...trademarkArgs, action_id: actionRow.id };
    assert.deepEqual((await call('review_business_trademark_action', args, read)).review.documents, ['engagement.pdf']);
    const document = await call('get_business_trademark_document', { ...args, preview: 0 }); assert.equal(document.content[0].type, 'resource');
    assert.equal(document.content[0].resource.mimeType, 'application/pdf'); assert.equal(Buffer.from(document.content[0].resource.blob, 'base64').toString(), pdf);
    await call('discard_business_trademark_action', { ...args, ...approval(actionRow) });
    actionRow = await prepare(); args = { ...trademarkArgs, action_id: actionRow.id };
    await denied('send_business_trademark_action', { ...args, ...approval(actionRow), revision: actionRow.revision + 1 });
    await denied('send_business_trademark_action', { ...args, ...approval(actionRow), confirm: false });
    loseContract = true; actionRow = await call('send_business_trademark_action', { ...args, ...approval(actionRow) }); loseContract = false;
    assert.equal(actionRow.status, 'uncertain');
    await denied('send_business_trademark_action', { ...args, ...approval(actionRow) }, full, /409/);
    actionRow = await call('reconcile_business_trademark_action', { ...args, ...approval(actionRow), external_id: [...envelopes.keys()][0] }); assert.equal(actionRow.status, 'sent');
    await call('sync_business_trademark_integration', connection);
    const completed = await call('get_business_trademark_document', args); assert.equal(Buffer.from(completed.content[0].resource.blob, 'base64').toString(), pdf);
    const view = await call('list_business_trademark_integrations', trademarkArgs); assert.equal(view.records[0].status, 'completed');
    assert.doesNotMatch(JSON.stringify(view), /doc-access-private|doc-refresh-private|_mcp_secret/);
    assert.equal(writes.filter(w => w.host === 'demo.docusign.net').length, 1, 'uncertain send is reconciled without duplicate invitation');
  });

  await t.test('foreign company/case/action/credential and non-full writes fail closed', async () => {
    await denied('get_business_company', { company_id: privateCompany.id }, full, /404/);
    for (const client of [read, write, foreign]) {
      await denied('update_business_company', { ...companyArgs, revision: await companyRevision(), changes: { name: 'stolen' } }, client);
      await denied('send_business_trademark_mail', { ...trademarkArgs, mail_id: mailRow.id, ...approval(mailRow) }, client);
      await denied('get_business_trademark_document', { ...trademarkArgs, action_id: actionRow.id }, client);
      await denied('sync_business_trademark_integration', { ...trademarkArgs, integration_id: integration.id }, client);
    }
    await denied('list_business_trademarks', companyArgs, foreign, /404/);
    await denied('review_business_trademark_action', { ...trademarkArgs, action_id: actionRow.id }, foreign, /404/);
    await denied('get_business_formation_references', { ...companyArgs, provider: 'doola', credential_id: foreignCredential.id, environment: 'sandbox' });
    const otherCase = await call('save_business_trademark', { ...companyArgs, details: { mark: 'Separate', owner_name: company.name } });
    await denied('review_business_trademark_action', { ...companyArgs, trademark_id: otherCase.id, action_id: actionRow.id }, full, /404/);
    const users = ds.getRepository('User');
    await users.update({ id: owner.id }, { role: 'user', permissions: '[]' });
    await denied('list_business_companies', {}, full, /403/);
    await users.update({ id: owner.id }, { permissions: '["business.manage"]' });
    assert.equal((await call('get_business_company', companyArgs)).company.id, company.id, 'business permission works without admin access');
    await users.update({ id: owner.id }, { role: 'admin', status: 'inactive' });
    await denied('get_business_company', companyArgs, full);
    await users.update({ id: owner.id }, { status: 'active' });
    const hosts = ds.getRepository('RuntimeHost'); await hosts.update({ id: host.id }, { account_id: theirs.id });
    const response = await full._post({ jsonrpc: '2.0', id: full._id(), method: 'tools/call', params: { name: 'list_business_companies', arguments: {} } });
    assert.ok(response.status >= 400 || response.data?.result?.isError || response.data?.error, 'stale MCP identity cannot follow a moved Host');
    await hosts.update({ id: host.id }, { account_id: mine.id });
  });

  await t.test('standard mail automation uses account-scoped tools and idempotent submission', async () => {
    const connector = MAIL_CONNECTORS.find(c => c.descriptor.id === 'smtp_imap');
    const originalSync = connector.sync; const originalSend = connector.send;
    let sends = 0;
    connector.sync = async () => ({ messages: [{ source_id: 'in-1', message_id: '<in-1@example.com>', from: 'vendor@example.com', to: ['ops@example.com'], subject: 'Automation input', text: 'Untrusted input', date: new Date().toISOString(), attachments: [] }], cursor: { seen: true } });
    connector.send = async () => { sends++; };
    try {
      const key = await ds.getRepository('Credential').save({ account_id: mine.id, name: 'Mail key', provider: 'mail', agent_env: false, encrypted_data: encrypt(JSON.stringify({ imap_password: 'private-mail-secret', smtp_password: 'private-mail-secret' })) });
      const catalog = await call('list_business_mail_connections', {}, read); assert.equal(catalog.connectors.length, 2);
      const input = { name: 'Operations', credential_id: key.id, company_id: company.id, provider: 'smtp_imap', config: { addresses: ['ops@example.com'], imap: { host: 'imap.example.com', port: 993, tls: 'implicit', username: 'ops' }, smtp: { host: 'smtp.example.com', port: 587, tls: 'starttls', username: 'ops' } } };
      await denied('configure_business_mail_connection', input, read);
      const connection = await call('configure_business_mail_connection', input);
      await denied('sync_business_mail', { connection_id: connection.id }, foreign);
      await call('sync_business_mail', { connection_id: connection.id });
      const mail = await call('list_business_mail', { confirmation: 'pending' }, read); assert.equal(mail.total, 1);
      const row = await call('get_business_mail', { message_id: mail.messages[0].id }, read); assert.equal(row.text, 'Untrusted input');
      await denied('get_business_mail', { message_id: row.id }, foreign);
      await call('confirm_business_mail', { message_id: row.id, revision: row.revision, confirmed: true, note: 'Processed by automation' });
      const send = { connection_id: connection.id, request_id: randomUUID(), from: 'ops@example.com', to: ['vendor@example.com'], subject: 'Re: Automation input', text: 'Authorized reply', reply_to_message_id: row.id, confirm: true };
      await denied('send_business_mail', send, read);
      const result = await call('send_business_mail', send); assert.equal(result.status, 'accepted');
      assert.equal((await call('send_business_mail', send)).id, result.id); assert.equal(sends, 1);
      const { BusinessMailService } = await import('../dist/modules/business/business-mail.service.js');
      const { BusinessMailWorkflowService } = await import('../dist/modules/business/business-mail-workflow.service.js');
      const runtime = await createAgent(app, token, mine.id, { name: 'Mail responder', runtime: true });
      const runtimeClient = await clientFor('full', mine, runtime);
      const current = (await call('list_business_mail_connections', {}, read)).connections.find(c => c.id === connection.id);
      await call('configure_business_mail_connection', { ...current, automation: { mode: 'review', agent_runtime: runtime.runtime_spec, objective: '제품 문의 답장 작성', max_replies_per_day: 20 } });
      const pending = await call('start_business_mail_reply', { message_id: row.id });
      const workflow = new BusinessMailWorkflowService(ds, app.get(BusinessMailService), { sendMessage: async () => {} });
      await workflow.tick();
      const drafted = await call('get_business_mail_reply', { task_id: pending.id }, read);
      assert.equal(drafted.status, 'drafting');
      const replies = await call('list_business_mail_replies', { status: 'drafting' }, read); assert.ok(replies.some(r => r.id === pending.id));
      await denied('get_business_mail_reply', { task_id: pending.id }, foreign);
      await denied('submit_business_mail_reply', { task_id: pending.id, revision: drafted.revision, text: 'unauthorized' }, full);
      await denied('send_business_mail', { ...send, request_id: randomUUID() }, runtimeClient);
      await denied('configure_business_mail_connection', { ...current, enabled: false }, runtimeClient);
      const reply = await call('submit_business_mail_reply', { task_id: pending.id, revision: drafted.revision, text: '확인했습니다.', decision: 'reply' }, runtimeClient);
      assert.equal(reply.status, 'review'); assert.equal(sends, 1, 'the assigned MCP agent cannot approve a review draft');

    } finally { connector.sync = originalSync; connector.send = originalSend; }
  });

  await t.test('a user-authorized Business request dispatches without a ticket and its runtime submits the result over MCP', async () => {
    const workflow = app.get(BusinessWorkflowService); workflow.onModuleDestroy();
    const runtime = await createAgent(app, token, mine.id, { name: 'Business execution', runtime: true });
    const worker = await clientFor('full', mine, runtime);
    const own = await call('create_business_company', { name: 'Execution company' });
    const args = { company_id: own.id, request_id: randomUUID(), content: 'Research formation and prepare the next decision.', agent_runtime: runtime.runtime_spec };
    await denied('start_business_work', args, read);
    await denied('start_business_work', args, foreign);
    const row = await call('start_business_work', args);
    const online = t.mock.method(app.get(InstanceRegistryService), 'listForAccount', id => id === mine.id ? [{ mode: 'manager', host_id: runtime.manager_agent_id, cli_adapters: [runtime.runtime_spec.cli] }] : []);
    try { await workflow.tick(); } finally { online.mock.restore(); }
    assert.equal((await ds.getRepository('BusinessTaskRun').findOneByOrFail({ id: row.id })).status, 'running');
    await denied('start_business_work', { ...args, request_id: randomUUID() }, worker, /새 실행/);
    const submission = { run_id: row.id, result: { status: 'needs_input', summary: 'Prepared a formation plan and cost comparison.', question: 'Please confirm the business purpose.' } };
    await denied('complete_business_task_run', submission, full);
    const finished = await call('complete_business_task_run', submission, worker);
    assert.equal(finished.status, 'needs_input');
    const journal = await call('get_business_task', { company_id: own.id, task_id: row.task_id });
    assert.equal(journal.result.content, submission.result.summary);
    assert.equal(journal.runs[0].question, submission.result.question);
    assert.equal(await ds.getRepository('Ticket').countBy({ account_id: mine.id, title: '[Execution company] 회사 설립' }), 0);
  });

  await t.test('standalone context wires all services and rechecks session/account ownership', async () => {
    const ctx = createStandaloneContext(ds); const handlers = new Map();
    const capture = { tool: (name, description, schema, handler) => handlers.set(name, handler) };
    registerBusinessTools(capture, ctx); registerBusinessTrademarkTools(capture, ctx); registerBusinessCashbookTools(capture, ctx); registerBusinessMailTools(capture, ctx);
    assert.equal(handlers.size, tools.length);
    const sid = randomUUID(); sessionStore.register(sid, { close: async () => {} }, {}, { source: 'db', agentId: host.id, accountId: mine.id, scope: 'full' });
    t.after(() => sessionStore.remove(sid));
    const invoke = (name, args = {}) => handlers.get(name)(args, { sessionId: sid });
    const created = JSON.parse((await invoke('create_business_company', { name: 'Standalone LLC' })).content[0].text); assert.equal(created.account_id, mine.id);
    const cashbook = JSON.parse((await invoke('get_business_cashbook', { ...companyArgs, month: '2020-01' })).content[0].text); assert.equal(cashbook.entries.length, 1);
    const listed = JSON.parse((await invoke('list_business_trademarks', companyArgs)).content[0].text); assert.ok(listed.cases.some(row => row.id === trademark.id));
    sessionStore.setAuth(sid, { source: 'env', agentId: host.id, accountId: mine.id, scope: 'full' }); assert.equal((await invoke('list_business_companies')).isError, true);
    sessionStore.setAuth(sid, { source: 'db', agentId: host.id, accountId: theirs.id, scope: 'full' }); assert.equal((await invoke('list_business_companies')).isError, true);
    assert.equal((await handlers.get('list_business_companies')({}, {})).isError, true);
  });

  await t.test('debug logs and internal failures do not expose applicant, mail or credential secrets', async () => {
    const preview = mcpRequestPreview([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_business_trademark', arguments: { details: { notes: 'private-hidden-body' } } } }]);
    assert.doesNotMatch(preview, /private-hidden-body/); assert.match(preview, /save_business_trademark/);
    const service = app.get(BusinessFormationService); const original = service.references;
    service.references = async () => { throw new Error('SQL error private-credential-dump'); };
    try {
      const error = await denied('get_business_formation_references', { ...companyArgs, provider: 'doola', credential_id: credentials.doola.id, environment: 'sandbox' }); assert.doesNotMatch(JSON.stringify(error), /private-credential-dump|SQL error/);
    } finally { service.references = original; }
    const logs = JSON.stringify(app.get(LogService).query({ category: 'MCP' }));
    assert.doesNotMatch(logs, /Private home address|private-founder@example|Private counsel notes|private-credential-dump|doc-access-private|_mcp_secret/);
    const events = await ds.getRepository('BusinessEvent').findBy({ company_id: company.id });
    assert.ok(events.some(event => event.actor_id === `mcp:${host.id}`));
    assert.ok(events.every(event => event.actor_id !== owner.id), 'agent writes never impersonate a human owner');
  });
  assert.deepEqual(unexpected, []);
  assert.deepEqual([...successful].sort(), tools.map(tool => tool.name).sort(), 'every registered Business tool has a successful real MCP call');
});
