import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalSpendMinor, safeReportInteger, reconcileDirect, returnDirect } from '../dist/modules/marketing/marketing-payment-returns.js';
import { buildCardPlan } from '../dist/common/marketing/payment-routes.js';

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function stripeInput({ status = 'active', amount = 1000, tx = [], auth = [], failedAfterCancel = false, paginate = false } = {}) {
  const plan = buildCardPlan({ target: { cardholder: 'ich_holder' }, currency: 'USD', amountMinor: amount, singleUse: false, categories: [], livemode: false, credentialFingerprint: '1234567890123456' });
  const calls = [];
  let canceled = status === 'canceled';
  const card = () => ({ object: 'issuing.card', id: 'ic_card', cardholder: 'ich_holder', currency: 'usd', type: 'virtual', status: canceled ? 'canceled' : status, livemode: false, metadata: { awb_spend_request_id: 'request' }, spending_controls: { spending_limits: [{ interval: 'all_time', amount }], allowed_categories: [] } });
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method });
    if (String(url).includes('/cards/')) {
      if (opts.method === 'POST') canceled = true;
      return json(card());
    }
    if (failedAfterCancel && canceled) return new Response('{}', { status: 503 });
    if (String(url).includes('/authorizations')) return json({ data: auth, has_more: false });
    if (String(url).includes('/transactions')) {
      if (paginate && !String(url).includes('starting_after')) return json({ data: tx.slice(0, 1), has_more: true });
      return json({ data: paginate ? tx.slice(1) : tx, has_more: false });
    }
    throw Error('unexpected URL');
  };
  return { input: { plan, ref: 'ich_holder', fields: { secret_key: 'rk_test_fixtureOnly' }, fingerprint: plan.credential_fingerprint, currency: 'USD', requestId: 'request', response: { card_id: 'ic_card' }, ctx: { fetchImpl } }, calls };
}
const tx = (id, amount, type = 'capture') => ({ id, card: 'ic_card', currency: 'usd', livemode: false, amount, type });
const auth = (status, amount) => ({ id: 'iauth_auth', card: 'ic_card', currency: 'usd', livemode: false, amount, status, approved: true });

test('decimal reports use exact upward rounding for each currency exponent', () => {
  assert.equal(decimalSpendMinor('12.34001', 'USD'), 1235);
  assert.equal(decimalSpendMinor('12.0001', 'KRW'), 13);
  assert.equal(decimalSpendMinor('0.0001', 'BHD'), 1);
  assert.equal(decimalSpendMinor('0', 'USD'), 0);
  for (const bad of ['1e3', '-1', '', 'NaN', 1.2]) assert.throws(() => decimalSpendMinor(bad, 'USD'));
  assert.throws(() => safeReportInteger(9007199254740992n));
});
test('Stripe paginates net captures/refunds/reversals and retains expired authorization exposure', async () => {
  const { input, calls } = stripeInput({ tx: [tx('ipi_1', -700), tx('ipi_2', 200, 'refund'), tx('ipi_3', -50, 'refund')], auth: [auth('expired', 100)], paginate: true });
  const report = await reconcileDirect(input);
  assert.equal(report.spend_minor, 550);
  assert.equal(report.pending_minor, 100);
  assert.equal(report.stopped, false);
  assert.ok(calls.some(c => c.url.includes('starting_after=ipi_1')));
});
test('Stripe cancels before rereading spend and returns only approved unused amount', async () => {
  const { input, calls } = stripeInput({ tx: [tx('ipi_1', -400)] });
  const outcome = await returnDirect({ ...input, expectedCeiling: '1000', amountMinor: 600, operationId: 'return1' });
  assert.equal(outcome.outcome, 'paid');
  assert.equal(outcome.response.refund_minor, 600);
  assert.equal(outcome.response.report.stopped, true);
  const write = calls.findIndex(c => c.method === 'POST');
  assert.ok(write >= 0);
  assert.ok(calls.slice(write + 1).some(c => c.url.includes('/transactions')));
});
test('Stripe never refunds when post-cancellation report fails', async () => {
  const { input } = stripeInput({ failedAfterCancel: true });
  const outcome = await returnDirect({ ...input, expectedCeiling: '1000', amountMinor: 500, operationId: 'return2' });
  assert.equal(outcome.outcome, 'unknown');
  assert.equal(outcome.response.refund_minor, undefined);
});
test('overspend is reported unclamped and prevents returns; stale ceiling never cancels', async () => {
  const { input, calls } = stripeInput({ tx: [tx('ipi_1', -1200)] });
  assert.equal((await reconcileDirect(input)).spend_minor, 1200);
  await assert.rejects(returnDirect({ ...input, expectedCeiling: '1000', amountMinor: 1, operationId: 'return3' }));
  await assert.rejects(returnDirect({ ...input, expectedCeiling: '2000', amountMinor: 1, operationId: 'return3' }));
  assert.equal(calls.some(c => c.method === 'POST'), false);
});
test('Stripe rejects foreign currency/card rows, duplicates and unsafe transaction values', async () => {
  for (const rows of [[{ ...tx('ipi_1', -50), currency: 'eur' }], [tx('ipi_1', -50), tx('ipi_1', -50)], [tx('ipi_1', Number.MAX_SAFE_INTEGER + 1)]]) {
    const { input } = stripeInput({ tx: rows });
    await assert.rejects(reconcileDirect(input));
  }
});

function metaInput({ spend = '2.0001', cap = '1000', truncated = false, writeUnknown = false } = {}) {
  const calls = [];
  const plan = { plan: 'raise_ceiling', provider: 'meta_ads', target: { ad_account_id: '123', campaign_id: '456' }, target_name_untrusted: '', field: 'spend_cap', currency: 'USD', from: '500', to: '1000', from_minor: 500, to_minor: 1000, credential_fingerprint: '1234567890123456' };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url); calls.push({ url: String(url), method: opts.method, body: opts.body });
    if (opts.method === 'POST') return json(writeUnknown ? {} : { success: true });
    if (u.pathname.includes('/insights')) return json({ data: [{ spend, date_start: truncated ? '2025-01-01' : '2020-01-01', date_stop: '2026-01-01' }] });
    if (u.pathname.endsWith('/act_123')) return json({ currency: 'USD', account_status: 1, disable_reason: 0 });
    if (u.searchParams.get('fields')?.includes('created_time')) return json({ created_time: '2020-01-01T00:00:00+0000' });
    return json({ id: '456', account_id: '123', status: 'PAUSED', effective_status: 'PAUSED', buying_type: 'AUCTION', spend_cap: cap });
  };
  return { input: { plan, ref: 'act_123/456', fields: { access_token: 'token' }, fingerprint: plan.credential_fingerprint, currency: 'USD', requestId: 'request', response: {}, ctx: { fetchImpl } }, calls };
}
test('Meta estimated decimals round up and paused target may lower cap by exact approved amount', async () => {
  const { input, calls } = metaInput();
  const report = await reconcileDirect(input);
  assert.equal(report.spend_minor, 201);
  assert.equal(report.stopped, true);
  const outcome = await returnDirect({ ...input, expectedCeiling: '1000', amountMinor: 799, operationId: 'meta1' });
  assert.equal(outcome.outcome, 'paid');
  assert.equal(new URLSearchParams(calls.find(c => c.method === 'POST').body).get('spend_cap'), '201');
});
test('Meta truncated history, zero-cap removal, overspend and stale approval never write', async () => {
  for (const [settings, amount, expected] of [[{ truncated: true }, 1, '1000'], [{ spend: '0' }, 1000, '1000'], [{ spend: '10.01' }, 1, '1000'], [{}, 1, '999']]) {
    const { input, calls } = metaInput(settings);
    await assert.rejects(returnDirect({ ...input, expectedCeiling: expected, amountMinor: amount, operationId: 'meta2' }));
    assert.equal(calls.some(c => c.method === 'POST'), false);
  }
});
test('Meta ambiguous write remains unknown without refund amount', async () => {
  const { input } = metaInput({ writeUnknown: true });
  const outcome = await returnDirect({ ...input, expectedCeiling: '1000', amountMinor: 1, operationId: 'meta3' });
  assert.equal(outcome.outcome, 'unknown');
  assert.equal(outcome.response.refund_minor, undefined);
});

function googleInput({ cost = '2000001', paginated = false, changed = false } = {}) {
  const budget = 'customers/1234567890/campaignBudgets/789';
  const plan = { plan: 'raise_ceiling', provider: 'google_ads', target: { customer_id: '1234567890', campaign_id: '456', budget }, target_name_untrusted: '', field: 'total_amount_micros', currency: 'USD', from: '5000000', to: '10000000', from_minor: 500, to_minor: 1000, credential_fingerprint: 'google1234567890123456' };
  const calls = [];
  let reads = 0;
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), body: opts.body });
    if (String(url).includes('oauth2')) return json({ access_token: 'token', expires_in: 3600 });
    const body = JSON.parse(opts.body);
    if (String(url).endsWith('campaignBudgets:mutate')) return json({ results: [{ resourceName: budget, campaignBudget: { totalAmountMicros: body.operations[0].update.totalAmountMicros } }] });
    if (body.query.includes('currency_constant')) return json({ results: [{ currencyConstant: { billableUnitMicros: '10000' } }] });
    if (body.query.includes('metrics.cost_micros')) return json({ results: [{ campaign: { id: '456' }, metrics: { costMicros: cost } }], ...(paginated ? { nextPageToken: 'next' } : {}) });
    reads++;
    return json({ results: [{ customer: { currencyCode: 'USD' }, campaign: { id: '456', status: 'PAUSED', endDateTime: '2020-01-01 00:00:00', campaignBudget: budget }, campaignBudget: { resourceName: budget, period: 'CUSTOM_PERIOD', totalAmountMicros: changed && reads > 1 ? '8000000' : '10000000', referenceCount: '1', status: 'ENABLED' } }] });
  };
  return { input: { plan, ref: '1234567890/456', fields: { client_id: 'id', client_secret: 'secret', refresh_token: 'refresh' }, fingerprint: plan.credential_fingerprint, currency: 'USD', requestId: 'request', response: {}, ctx: { fetchImpl } }, calls };
}
test('Google rounds micros up and can lower ended total-budget campaign', async () => {
  const { input, calls } = googleInput();
  const outcome = await returnDirect({ ...input, expectedCeiling: '10000000', amountMinor: 799, operationId: 'google1' });
  assert.equal(outcome.outcome, 'paid');
  assert.equal(outcome.response.report.spend_minor, 201);
  assert.equal(outcome.response.report.stopped, true);
  const write = calls.find(c => c.url.endsWith('campaignBudgets:mutate'));
  assert.equal(JSON.parse(write.body).operations[0].update.totalAmountMicros, '2010000');
});
test('Google refuses truncated reports and rechecks ceiling immediately before write', async () => {
  for (const config of [{ paginated: true }, { changed: true }]) {
    const { input, calls } = googleInput(config);
    await assert.rejects(returnDirect({ ...input, expectedCeiling: '10000000', amountMinor: 100, operationId: 'google2' }));
    assert.equal(calls.some(c => c.url.endsWith('campaignBudgets:mutate')), false);
  }
});
