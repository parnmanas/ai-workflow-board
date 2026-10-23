import test from 'node:test';
import assert from 'node:assert/strict';
import { businessConnector, BUSINESS_CONNECTORS } from '../dist/modules/business/connectors/registry.js';

test('doola reads the partner envelope, raw-key auth and compliance dates without retaining personal fields', async () => {
  const calls = [];
  const snapshot = await businessConnector('doola').sync({ environment: 'sandbox', config: { company_id: 'company_123' }, secrets: { api_key: 'dk_test_example' }, get: async (url, headers) => {
    calls.push({ url, headers });
    return url.endsWith('/calendar') ? { payload: { events: [{ type: 'ANNUAL_REPORT', status: 'UPCOMING', nextDueDate: '2027-04-15' }] }, error: null }
      : { payload: { formationSubmissionStatus: 'COMPLETED', ein: '99-0000000', members: [{ ssn: 'private' }] }, error: null };
  } });
  assert.equal(calls[0].url, 'https://api.test.doola.com/v1/partner/companies/company_123');
  assert.equal(calls[0].headers.Authorization, 'dk_test_example');
  assert.equal(snapshot.records[0].date, '2027-04-15');
  assert.doesNotMatch(JSON.stringify(snapshot), /99-0000000|ssn|private/);
  await assert.rejects(() => businessConnector('doola').sync({ environment: 'live', config: {}, secrets: { api_key: 'dk_test_example' }, get: async () => assert.fail('wrong environment must not send a key') }), /환경/);
});

test('Mercury reports bounded signed USD transactions and does not fabricate absent amounts', async () => {
  const run = transaction => businessConnector('mercury').sync({ environment: 'sandbox', config: {}, secrets: { api_token: 'private' }, get: async (url, headers) => {
    assert.ok(url.startsWith('https://api-sandbox.mercury.com/api/v1/'));
    assert.equal(headers.Authorization, 'Bearer private');
    return url.includes('/accounts?') ? { accounts: [{ id: 'a' }] } : { transactions: [transaction] };
  } });
  const snapshot = await run({ id: 't', counterpartyName: 'Vendor', status: 'pending', amount: -12.34, createdAt: '2026-10-01' });
  assert.equal(snapshot.records[0].amount_minor, -1234);
  assert.equal(snapshot.records[0].status, 'pending');
  await assert.rejects(() => run({ amount: null }), /수치/);
});

test('Stripe keeps currencies separate and rejects a live response in sandbox', async () => {
  const run = livemode => businessConnector('stripe').sync({ environment: 'sandbox', config: {}, secrets: { secret_key: 'test' }, get: async url => url.endsWith('/balance')
    ? { livemode, available: [{ currency: 'usd', amount: 100 }, { currency: 'jpy', amount: 100 }], pending: [] }
    : { data: [] } });
  const snapshot = await run(false);
  assert.deepEqual(snapshot.metrics.map(m => m.currency), ['USD', 'JPY']);
  await assert.rejects(() => run(true), /환경/);
});

test('Chatwoot accepts real zero counts and requires its own numeric account ID', async () => {
  const run = account_id => businessConnector('chatwoot').sync({ environment: 'live', config: { account_id }, secrets: { api_token: 'secret' }, get: async (url, headers) => {
    assert.equal(headers.Authorization, 'Bearer secret');
    return url.includes('/meta?') ? { meta: { all_count: 0, unassigned_count: 0 } } : { payload: [{ id: 12, name: 'Support', channel_type: 'Channel::WebWidget' }] };
  } });
  assert.equal((await run('123')).metrics[0].value, 0);
  await assert.rejects(() => run('../admin'), /양의 정수/);
});

test('Xero pins host and tenant, reads only invoice metadata, and marks handoff-only providers explicitly', async () => {
  const snapshot = await businessConnector('xero').sync({ environment: 'live', config: { tenant_id: 'tenant-123' }, secrets: { access_token: 'token' }, get: async (url, headers) => {
    assert.equal(headers['Xero-tenant-id'], 'tenant-123');
    assert.ok(url.startsWith('https://api.xero.com/api.xro/2.0/'));
    return url.endsWith('/Organisation') ? { Organisations: [{ Name: 'My company' }] } : { Invoices: [{ InvoiceID: 'inv1', InvoiceNumber: '001', Status: 'AUTHORISED', Contact: { EmailAddress: 'private@example.invalid' } }] };
  } });
  assert.doesNotMatch(JSON.stringify(snapshot), /private@example/);
  for (const connector of BUSINESS_CONNECTORS) assert.equal(connector.descriptor.mode === 'api', typeof connector.sync === 'function');
  assert.equal(businessConnector('atlas').sync, undefined);
  assert.equal(typeof businessConnector('quickbooks').sync, 'function');
});

test('QuickBooks queries only the selected realm and bounds invoice metadata; a missing envelope fails', async () => {
  const run = body => businessConnector('quickbooks').sync({ environment: 'sandbox', config: { realm_id: '12345' }, secrets: { access_token: 'oauth' }, get: async (url, headers) => {
    const target = new URL(url); assert.equal(target.origin, 'https://sandbox-quickbooks.api.intuit.com');
    assert.match(target.pathname, /12345\/query$/); assert.match(target.searchParams.get('query'), /MAXRESULTS 50$/);
    assert.equal(headers.Authorization, 'Bearer oauth'); return body;
  } });
  assert.equal((await run({ QueryResponse: {} })).records.length, 0);
  const result = await run({ QueryResponse: { Invoice: [{ Id: 'i1', DocNumber: '100', Balance: 12, DueDate: '2026-12-01', BillEmail: { Address: 'private@example.invalid' } }] } });
  assert.equal(result.records[0].status, '미수 잔액 있음'); assert.doesNotMatch(JSON.stringify(result), /private@example/);
  await assert.rejects(() => run({ Fault: {} }), /QuickBooks/);
  await assert.rejects(() => businessConnector('quickbooks').sync({ config: { realm_id: '../escape' }, get: () => assert.fail('must not send') }), /realm/);
});

test('support adapters pin hosts, minimize customer data and report sample counts honestly', async () => {
  const intercom = await businessConnector('intercom').sync({ secrets: { access_token: 'token' }, get: async (url, headers) => {
    assert.equal(url, 'https://api.intercom.io/conversations?per_page=30'); assert.equal(headers['Intercom-Version'], '2.17');
    return { total_count: 300, conversations: [{ id: 'c1', state: 'open', updated_at: 1700000000, source: { body: 'private message' } }] };
  } });
  assert.equal(intercom.metrics[0].value, 300); assert.equal(intercom.metrics[1].value, 1); assert.doesNotMatch(JSON.stringify(intercom), /private message/);
  for (const id of ['zendesk', 'freshdesk']) {
    const run = subdomain => businessConnector(id).sync({ config: { subdomain }, secrets: { access_token: 'oauth', api_key: 'key' }, get: async (url, headers) => {
      assert.equal(new URL(url).hostname, `acme.${id}.com`);
      const ticket = { id: 12, status: id === 'zendesk' ? 'pending' : 3, updated_at: '2026-10-01', description: 'private message', subject: 'private subject' };
      if (id === 'freshdesk') { assert.equal(headers.Authorization, `Basic ${Buffer.from('key:X').toString('base64')}`); return [ticket]; }
      assert.equal(headers.Authorization, 'Bearer oauth'); return { tickets: [ticket] };
    } });
    const result = await run('acme'); assert.equal(result.metrics[0].value, 1); assert.equal(result.metrics[1].value, 1);
    assert.doesNotMatch(JSON.stringify(result), /private message|private subject/);
    for (const host of ['acme.evil.invalid', 'acme@evil', '../secret', '-bad', 'bad-', 'a_b']) await assert.rejects(() => run(host), /subdomain/);
  }
});
