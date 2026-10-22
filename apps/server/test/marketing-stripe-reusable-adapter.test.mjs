import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECT_PAYMENT_ADAPTERS } from '../dist/modules/marketing/marketing-payment-adapters.js';
import { directPlanProblems, directPayeeProblem, describeDirectPlan } from '../dist/common/marketing/payment-routes.js';

const adapter = DIRECT_PAYMENT_ADAPTERS.stripe_issuing;
const fields = { secret_key: 'rk_test_example123456789' };
const fingerprint = '0123456789abcdef';
const payee = { name: 'Ads', card_id: 'ic_existing', card_single_use: false, card_categories: [] };
const holder = { id: 'ich_holder', status: 'active', type: 'individual', livemode: false, requirements: {} };
const card = () => ({ id: 'ic_existing', object: 'issuing.card', cardholder: 'ich_holder', type: 'virtual', status: 'active', currency: 'usd', livemode: false,
  metadata: { unrelated: 'keep' }, spending_controls: { allowed_categories: [], blocked_categories: [], allowed_merchant_countries: ['US'], spending_limits: [{ amount: 1000, interval: 'all_time' }, { amount: 500, interval: 'daily', categories: ['advertising_services'] }] } });
function fixture() {
  const state = { card: card(), calls: [], failure: null };
  state.fetchImpl = async (url, init = {}) => {
    const write = init.method === 'POST';
    state.calls.push({ url: String(url), ...init });
    let body;
    if (String(url).includes('/cardholders/')) body = holder;
    else if (write) {
      if (state.failure) return state.failure();
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('status'), null);
      assert.equal(form.get('spending_controls[allowed_categories]'), null);
      assert.equal(form.get('spending_controls[spending_limits][1][categories][0]'), 'advertising_services');
      assert.equal(form.get('spending_controls[spending_limits][1][amount]'), '500');
      state.card.spending_controls.spending_limits[0].amount = Number(form.get('spending_controls[spending_limits][0][amount]'));
      body = state.card;
    } else body = state.card;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return state;
}
async function planFor(state) { return adapter.plan({ ref: 'ich_holder', fields, fingerprint, amountMinor: 200, currency: 'USD', payee, ctx: { fetchImpl: state.fetchImpl } }); }
async function execute(state, plan) { return adapter.execute({ plan, fields, fingerprint, requestId: 'request1', startedAt: new Date(), ctx: { fetchImpl: state.fetchImpl } }); }

test('reuse plan, absolute update, fixed key, preserved controls and ceiling inspection', async () => {
  const state = fixture();
  const plan = await planFor(state);
  assert.equal(plan.card_id, payee.card_id);
  assert.equal(plan.from_minor, 1000);
  assert.equal(plan.limit_minor, 1200);
  assert.deepEqual(directPlanProblems({ provider: 'stripe_issuing', payee_ref: 'ich_holder', currency: 'USD', amount_minor: 200, payload: plan }), []);
  assert.match(describeDirectPlan({ provider: 'stripe_issuing', currency: 'USD', payload: plan }), /ic_existing/);
  const outcome = await execute(state, plan);
  assert.equal(outcome.outcome, 'paid');
  const writes = state.calls.filter((c) => c.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].headers['idempotency-key'], 'awb-spend-request1-raise-limit');
  assert.match(writes[0].url, /\/cards\/ic_existing$/);
  const inspected = await adapter.inspect({ plan, fields, fingerprint, ref: 'ich_holder', requestId: 'request1', around: new Date(), currency: 'USD', response: {}, ctx: { fetchImpl: state.fetchImpl } });
  assert.equal(inspected.kind, 'ceiling');
  assert.equal(inspected.position, 'at_target');
  assert.equal(inspected.observed_minor, 1200);
});

test('changed/canceled/replaced card and limit fail before writing', async () => {
  for (const mutate of [(c) => { c.status = 'canceled'; }, (c) => { c.replaced_by = 'ic_new'; }, (c) => { c.spending_controls.spending_limits[0].amount = 900; }]) {
    const state = fixture();
    const plan = await planFor(state);
    mutate(state.card);
    await assert.rejects(execute(state, plan), /changed since the request/);
    assert.equal(state.calls.filter((c) => c.method === 'POST').length, 0);
  }
});

test('ambiguous update is unknown and never cancels an existing card', async () => {
  for (const failure of [() => { throw new Error('connection lost'); }, () => new Response('{}', { status: 500 }), () => new Response(JSON.stringify({ ...card(), id: 'ic_other' }), { status: 200 }), () => { const changed = card(); changed.spending_controls.spending_limits = [{ amount: 1200, interval: 'all_time' }]; return new Response(JSON.stringify(changed), { status: 200 }); }]) {
    const state = fixture();
    const plan = await planFor(state);
    state.failure = failure;
    assert.equal((await execute(state, plan)).outcome, 'unknown');
    assert.equal(state.calls.filter((c) => c.method === 'POST').length, 1);
  }
});

test('planning refuses unsafe reuse and approval rejects rebinding', async () => {
  for (const mutate of [(c) => { c.spending_controls.spending_limits = []; }, (c) => { c.lifecycle_controls = { cancel_after: { payment_count: 1 } }; }, (c) => { c.currency = 'eur'; }, (c) => { c.cardholder = 'ich_other'; }, (c) => { c.livemode = true; }]) {
    const state = fixture(); mutate(state.card);
    await assert.rejects(planFor(state), /reusable card is unavailable/);
  }
  const state = fixture(); const plan = await planFor(state);
  assert.match(directPayeeProblem({ provider: 'stripe_issuing', payload: plan }, { ...payee, card_id: 'ic_new' }), /changed/);
  await assert.rejects(adapter.plan({ ref: 'ich_holder', fields, fingerprint, amountMinor: 200, currency: 'USD', payee: { ...payee, card_max_minor: 1100 }, ctx: { fetchImpl: state.fetchImpl } }), /maximum/);
});
