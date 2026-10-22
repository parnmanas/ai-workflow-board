// Marketing 직접 결제 — Stripe Issuing(카드) 어댑터. docs/marketing.md "직접 결제 어댑터" → "카드(Stripe Issuing)".
//
// Stripe API 는 MarketingSpendService.fetchImpl 로 가로챈 가짜(카드 소지자 · 카드 목록 · 카드 만들기/고치기, 멱등 키)다. 실제 계정 ·
// 실제 돈은 쓰지 않는다. 가짜 카드 응답에는 실제 Stripe 처럼 카드 소지자 정보(이름 · 이메일 · 주소 · 전화)가 박혀 온다.
//
// 고정하는 것:
//   1. 수취인: Stripe Issuing 전용 credential(운영 키는 rk_live 만 — sk_live 거부), 카드 소지자 ref, 카드 통제(일회용 기본 · 업종 · 카드당 최대).
//   2. 요청: 에이전트 payload 거부, 카드 소지자를 읽어(쓰기 없음) 카드 계획(한도 = 금액 · 통제 · 모드)을 만든다 — 카드 소지자 이름은 없다.
//      금액 문제(일회용 최대 · 카드당 최대)는 Stripe 를 부르기 전에 거부한다. 키와 카드 소지자의 모드가 다르면 거부한다.
//   3. 실행: 카드 소지자를 다시 보고 → 비활성 카드를 만들고(멱등 키 고정 · Stripe-Version 고정 · 번호를 펼치지 않음) → 계획과 대조하고 → 활성화.
//      만든 카드가 다르거나 활성화가 거절되면 해지하고 failed. 모호하면 unknown.
//   4. 결과 불명: 카드가 해지되지 않은 채 있으면 실패로 기록하지 않는다. 해지된 카드만 있으면 "쓴 돈 없음 확인" 을 받아야 한다. 카드가 없으면
//      (유예 뒤) 기록한다. 요청별 확인이 카드를 찾아 주고, 결제 기록은 카드 id 를 미리 채운다.
//   5. 요청 뒤에 수취인의 카드 통제가 바뀌면 승인하지 않는다. 카드 소지자가 실행 전에 막히면 보내지 않는다. 환불은 막는다.
//   6. 비밀 키와 카드 소지자 개인정보는 요청 행 · 감사 · MCP 어디에도 없다(카드 소지자 이름은 사람만 보는 연결 확인에만).
//   7. 모호한 생성 답(409 · 멱등 오류 · Stripe 오류 객체가 아닌 4xx)은 unknown. 해지가 실패하거나 해지 답이 그 카드의 canceled 카드
//      객체가 아니면 unknown. 활성화된 카드가 계획과 다르면
//      해지하고 failed, 다른 카드로 답하면 이 요청의 카드만 해지하고 unknown. 실행 시작 5분이 지난 실행은 카드를 만들거나 살리지 않는다.
//   8. 카드 찾기의 "없음" 은 같은 키로 모든 쪽 · 항목을 읽었을 때만 — 빈 쪽인데 더 있음 · 목록이 아닌 답 · 읽지 못한 항목 · 바뀐 키 ·
//      10쪽 초과는 "쓴 돈 없음 확인" 을 받아야 실패로 기록한다. 실행이 받아 둔 카드 id 는 목록과 따로 직접 읽는다 — 목록을 못 읽어도
//      그 카드가 살아 있으면 확인이 있어도 거부한다. 다른 서버의 부팅이 먼저 결과 불명으로 돌린 요청도 늦게 온 결과의 카드 id 를 남긴다.
//
// 실행: node --test --test-force-exit test/marketing-spend-stripe.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { MarketingSpendService } from '../dist/modules/marketing/marketing-spend.service.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';
process.env.MARKETING_SCHEDULER_ENABLED = 'false';
process.env.OUTREACH_SCHEDULER_ENABLED = 'false';
delete process.env.MARKETING_STRIPE_API_VERSION;

const STRIPE_KEY = 'rk_test_stripeKeyMarker0123456789';
const PII = ['Jane Doe', 'jane.doe@example.com', '1 Secret Street', '+15555550123'];

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

function json(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_fake123', ...headers } });
}

const stripeError = (status, type, code, message) => json(status, { error: { type, code, message } });

/** 가짜 Stripe Issuing — 카드 소지자 읽기, 카드 목록(최신순 · 쪽 넘김), 카드 만들기 · 고치기(멱등 키). `overrides` 는 (조건, 응답) 큐. */
function fakeStripe() {
  const holder = (id, over = {}) => ({
    id, object: 'issuing.cardholder', status: 'active', type: 'individual', livemode: false,
    name: 'Jane Doe', email: 'jane.doe@example.com', phone_number: '+15555550123',
    billing: { address: { line1: '1 Secret Street', city: 'Springfield', country: 'US', postal_code: '12345' } },
    requirements: { disabled_reason: null, past_due: [] },
    ...over,
  });
  const state = {
    cardholders: { ich_sandbox1: holder('ich_sandbox1'), ich_live1: holder('ich_live1', { livemode: true }) },
    cards: [],
    idem: new Map(),
    calls: [],
    overrides: [],
    seq: 0,
    /** 만들 카드를 마지막에 고칠 수 있다(계획과 다른 카드를 흉내 낸다). */
    mangle: null,
  };

  const parseForm = (body) => {
    const out = { metadata: {}, spending_limits: [], allowed_categories: [] };
    for (const [k, v] of new URLSearchParams(body || '')) {
      let m;
      if ((m = k.match(/^metadata\[(.+)\]$/))) out.metadata[m[1]] = v;
      else if ((m = k.match(/^spending_controls\[spending_limits\]\[(\d+)\]\[(amount|interval)\]$/))) {
        out.spending_limits[m[1]] = { ...(out.spending_limits[m[1]] || {}), [m[2]]: m[2] === 'amount' ? Number(v) : v };
      } else if ((m = k.match(/^spending_controls\[allowed_categories\]\[(\d+)\]$/))) out.allowed_categories[Number(m[1])] = v;
      else if (k === 'lifecycle_controls[cancel_after][payment_count]') out.payment_count = Number(v);
      else out[k] = v;
    }
    return out;
  };

  const cardJson = (card) => ({
    ...card,
    // 실제 Stripe 처럼 카드 소지자 전체가 박혀 온다(AWB 는 id 만 읽어야 한다).
    cardholder: { ...state.cardholders[card.cardholder_id] },
  });

  const createCard = (body) => {
    const f = parseForm(body);
    state.seq += 1;
    let card = {
      id: `ic_fake${state.seq}`, object: 'issuing.card', cardholder_id: f.cardholder, currency: f.currency, type: f.type, status: f.status || 'inactive',
      livemode: state.cardholders[f.cardholder]?.livemode ?? false, created: Math.floor(Date.now() / 1000), last4: '4242', exp_month: 12, exp_year: 2029,
      metadata: f.metadata,
      spending_controls: {
        spending_limits: f.spending_limits.map((l) => ({ ...l, categories: null })),
        spending_limits_currency: f.currency,
        allowed_categories: f.allowed_categories.length ? f.allowed_categories : null,
        blocked_categories: null,
      },
      lifecycle_controls: f.payment_count ? { cancel_after: { payment_count: f.payment_count } } : null,
    };
    if (state.mangle) { card = state.mangle(card); state.mangle = null; }
    state.cards.push(card);
    return card;
  };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const headers = { ...(init.headers || {}) };
    const entry = { method: init.method || 'GET', path: u.pathname, search: u.search, query: Object.fromEntries(u.searchParams), headers, body: init.body || '' };
    state.calls.push(entry);
    const i = state.overrides.findIndex((o) => o.match(entry));
    if (i >= 0) {
      const o = state.overrides.splice(i, 1)[0];
      if (o.reply === 'timeout') { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
      const r = typeof o.reply === 'function' ? await o.reply(entry, { createCard, cardJson }) : o.reply;
      if (r instanceof Response) return r;
    }
    if (u.host !== 'api.stripe.com') return json(404, { error: 'unexpected host' });
    const idem = headers['idempotency-key'];
    if (entry.method === 'POST' && idem && state.idem.has(idem)) {
      const saved = state.idem.get(idem);
      return json(saved.status, saved.body, { 'idempotent-replayed': 'true' });
    }
    let m;
    if (entry.method === 'GET' && (m = u.pathname.match(/^\/v1\/issuing\/cardholders\/(.+)$/))) {
      const h = state.cardholders[decodeURIComponent(m[1])];
      return h ? json(200, h) : stripeError(404, 'invalid_request_error', 'resource_missing', 'No such cardholder');
    }
    if (entry.method === 'GET' && (m = u.pathname.match(/^\/v1\/issuing\/cards\/(.+)$/))) {
      const card = state.cards.find((c) => c.id === decodeURIComponent(m[1]));
      return card ? json(200, cardJson(card)) : stripeError(404, 'invalid_request_error', 'resource_missing', 'No such card');
    }
    if (entry.method === 'GET' && u.pathname === '/v1/issuing/cards') {
      const q = entry.query;
      let list = state.cards.filter((c) => (!q.cardholder || c.cardholder_id === q.cardholder) && (!q.type || c.type === q.type)
        && (!q['created[gte]'] || c.created >= Number(q['created[gte]'])) && (!q['created[lte]'] || c.created <= Number(q['created[lte]'])));
      list = [...list].reverse();
      if (q.starting_after) list = list.slice(list.findIndex((c) => c.id === q.starting_after) + 1);
      const limit = Number(q.limit || 10);
      return json(200, { object: 'list', data: list.slice(0, limit).map(cardJson), has_more: list.length > limit });
    }
    let reply;
    if (entry.method === 'POST' && u.pathname === '/v1/issuing/cards') {
      reply = { status: 200, body: cardJson(createCard(entry.body)) };
    } else if (entry.method === 'POST' && (m = u.pathname.match(/^\/v1\/issuing\/cards\/(.+)$/))) {
      const card = state.cards.find((c) => c.id === decodeURIComponent(m[1]));
      if (!card) return stripeError(404, 'invalid_request_error', 'resource_missing', 'No such card');
      const f = parseForm(entry.body);
      if (f.status) card.status = f.status;
      reply = { status: 200, body: cardJson(card) };
    } else {
      return stripeError(404, 'invalid_request_error', 'unknown', 'Unrecognized request URL');
    }
    if (idem) state.idem.set(idem, reply);
    return json(reply.status, reply.body);
  };
  return { state, fetchImpl, createCard, cardJson };
}

async function setup(t) {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;
  const spend = app.get(MarketingSpendService);
  const fake = fakeStripe();
  spend.fetchImpl = fake.fetchImpl;

  const account = await createAccount(app, getDataSourceToken, 'mkt-stripe');
  const owner = await createUser(app, getDataSourceToken, { name: 'mkt-stripe-owner', role: 'admin' });
  await ds.getRepository('Account').update(account.id, { owner_user_id: owner.id });
  const headers = { Authorization: `Bearer ${app.get(AuthService).createSession(owner.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  const responses = [];
  const api = async (path, init = {}) => {
    const r = await call(`${base}/api/marketing${path}`, { headers, ...init });
    responses.push({ path, text: r.text });
    return r;
  };
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
  const credRepo = ds.getRepository('Credential');
  const makeCred = (name, provider, fields) => credRepo.save(credRepo.create({
    account_id: account.id, name, description: '', provider, encrypted_data: encrypt(JSON.stringify(fields)),
  }));
  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'mkt-stripe-agent', type: 'claude', runtime: true });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: 'mkt-stripe' });
  const mcp = new McpClient({ baseUrl: base, apiKey: key.raw_key });
  t.after(() => mcp.close().catch(() => {}));
  return { ds, spend, fake, account, api, post, patch, makeCred, agent, mcp, responses };
}

const errText = (r) => JSON.stringify(r?.error ?? r);

async function pastFailGrace(ctx, id) {
  await ctx.ds.getRepository('MarketingSpendRequest').update({ id }, { executing_at: new Date(Date.now() - 16 * 60_000) });
}

test('Stripe Issuing: one inactive card per approval, checked against the plan, then activated; never failed while a card stands', async (t) => {
  const ctx = await setup(t);
  const { fake, ds, spend } = ctx;
  const stripeCred = await ctx.makeCred('stripe-sandbox', 'stripe_issuing', { secret_key: STRIPE_KEY });
  const fullLive = await ctx.makeCred('stripe-full-live', 'stripe_issuing', { secret_key: 'sk_live_fullSecretKey0123456789' });
  const cardPayee = (over = {}) => ({ name: 'Sponsor card', provider: 'stripe_issuing', credential_id: stripeCred.id, ref: 'ich_sandbox1', card_categories: ['advertising_services'], ...over });

  // 1. 수취인 — 운영 전체 키는 거부, 카드 통제는 정규 형태로 저장
  const refused = await ctx.post('/campaigns', { name: 'bad', currency: 'USD', payees: [cardPayee({ credential_id: fullLive.id })] });
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.body.error, /restricted key \(rk_live_…\) in live mode/);
  const created = await ctx.post('/campaigns', {
    name: 'Stripe direct', agent_runtime: ctx.agent.runtime_spec, capabilities: ['paid_spend'], currency: 'USD',
    budget_total_minor: 5_000_000, budget_period: 'month', budget_period_minor: 5_000_000, max_transaction_minor: 2_000_000, dual_approval_threshold_minor: 0,
    payees: [
      cardPayee({ card_max_minor: 500_000 }),
      { name: 'Recurring card', provider: 'stripe_issuing', credential_id: stripeCred.id, ref: 'ich_sandbox1', card_single_use: false },
      { name: 'Live holder', provider: 'stripe_issuing', credential_id: stripeCred.id, ref: 'ich_live1' },
    ],
    limits: { spend_requests_per_day: 100 },
  });
  assert.equal(created.status, 201, created.text);
  const campaign = created.body;
  assert.deepEqual(campaign.payees[0], { name: 'Sponsor card', ref: 'ich_sandbox1', provider: 'stripe_issuing', credential_id: stripeCred.id, card_single_use: true, card_categories: ['advertising_services'], card_max_minor: 500_000 });
  assert.equal((await ctx.post(`/campaigns/${campaign.id}/status`, { status: 'active' })).status, 200);
  const channel = (await ctx.post(`/campaigns/${campaign.id}/channels`, { platform: 'other', target: 'Sponsorships', name: 'Sponsorships' })).body;
  assert.equal((await ctx.post(`/channels/${channel.id}/approve`, { mode: 'manual' })).body.status, 'active');
  assert.equal((await ctx.post(`/campaigns/${campaign.id}/allocations`, { allocations: [{ channel_id: channel.id, amount_minor: 5_000_000 }], rationale: 'cards', approve: true })).status, 201);
  const ask = async (fields) => {
    try {
      return await ctx.mcp.callTool('request_marketing_spend', { campaign_id: campaign.id, channel_id: channel.id, currency: 'USD', purpose: 'Newsletter sponsorship', expected_outcome: '30 signups', ...fields });
    } catch (e) {
      return { isError: true, error: String(e?.message || e) };
    }
  };
  const approve = (req) => ctx.post(`/spend-requests/${req.id}/approve`, { payload_sha256: req.payload_sha256 });
  const posts = () => fake.state.calls.filter((c) => c.method === 'POST');

  // 2. 요청 — payload 거부, 금액 문제는 Stripe 를 부르지 않고 거부, 모드가 다른 카드 소지자는 거부
  assert.match(errText(await ask({ amount_minor: 30000, payee: 'Sponsor card', payload: { card: 'x' } })), /omit payload/);
  const callsBefore = fake.state.calls.length;
  assert.match(errText(await ask({ amount_minor: 600_000, payee: 'Sponsor card' })), /per-card maximum is 5,000.00 USD — ask for at most that/);
  assert.match(errText(await ask({ amount_minor: 1_000_001, payee: 'Sponsor card' })), /single-use card can carry at most 10,000.00 USD/);
  assert.equal(fake.state.calls.length, callsBefore, 'amount problems are refused before Stripe is asked');
  const recurring = await ask({ amount_minor: 1_000_001, payee: 'Recurring card' });
  assert.equal(recurring.isError, undefined, `a card that is not single-use can carry more: ${errText(recurring)}`);
  assert.equal(recurring.spend_request.payload.single_use, false);
  await ctx.post(`/spend-requests/${recurring.spend_request.id}/deny`, { note: 'limit check' });
  const liveHolder = await ask({ amount_minor: 30000, payee: 'Live holder' });
  assert.match(errText(liveHolder), /sandbox key but the cardholder is a live cardholder/);
  assert.match(errText(liveHolder), /do not retry/);

  const r1 = await ask({ amount_minor: 30000, payee: 'Sponsor card' });
  assert.equal(r1.isError, undefined, errText(r1));
  const req1 = r1.spend_request;
  assert.deepEqual(req1.payload, {
    plan: 'issue_card', provider: 'stripe_issuing', target: { cardholder: 'ich_sandbox1' }, currency: 'USD', limit_minor: 30000, interval: 'all_time',
    single_use: true, allowed_categories: ['advertising_services'], livemode: false, credential_fingerprint: req1.payload.credential_fingerprint,
  });
  assert.equal((await ds.getRepository('MarketingSpendRequest').findOneBy({ id: req1.id })).target_key, '', 'cards keep no target key');
  assert.match(req1.plan_text, /카드 소지자 ich_sandbox1 에게 누적 한도 300.00 USD 의 일회용\(첫 결제 뒤 자동 해지\) 가상 카드를 발급합니다\(허용 업종: advertising_services\)\. \[샌드박스 카드/);
  assert.equal(posts().length, 0, 'planning only reads');
  const r1b = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
  assert.equal(r1b.isError, undefined, 'cards do not exclude each other — no one-open-request rule');
  await ctx.post(`/spend-requests/${r1b.spend_request.id}/deny`, { note: 'parallel request check' });

  // 3. 승인 → 비활성 카드 → 대조 → 활성화
  const approved = await approve(req1);
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.status, 'paid', approved.text);
  const [create, activate] = posts();
  assert.equal(create.path, '/v1/issuing/cards');
  assert.equal(create.headers['idempotency-key'], `awb-spend-${req1.id}`);
  assert.equal(create.headers['stripe-version'], '2026-09-30.endive');
  assert.equal(create.headers.authorization, `Bearer ${STRIPE_KEY}`);
  const form = Object.fromEntries(new URLSearchParams(create.body));
  assert.deepEqual(form, {
    cardholder: 'ich_sandbox1', currency: 'usd', type: 'virtual', status: 'inactive',
    'spending_controls[spending_limits][0][amount]': '30000', 'spending_controls[spending_limits][0][interval]': 'all_time',
    'spending_controls[allowed_categories][0]': 'advertising_services', 'lifecycle_controls[cancel_after][payment_count]': '1',
    'metadata[awb_spend_request_id]': req1.id,
  });
  const cardId = fake.state.cards[0].id;
  assert.equal(activate.path, `/v1/issuing/cards/${cardId}`);
  assert.equal(activate.headers['idempotency-key'], `awb-spend-${req1.id}-activate`);
  assert.equal(new URLSearchParams(activate.body).get('status'), 'active');
  assert.ok(fake.state.calls.every((c) => !/expand/.test(c.search) && !/expand/.test(String(c.body))), 'card numbers are never expanded');
  assert.ok(fake.state.calls.every((c) => !c.search.includes(STRIPE_KEY)), 'the key never rides the URL');
  assert.equal(approved.body.provider_ref, cardId);
  assert.equal(approved.body.receipt_url, `https://dashboard.stripe.com/test/issuing/cards/${cardId}`);
  assert.equal(approved.body.provider_response.card_id, cardId);
  assert.equal(fake.state.cards[0].status, 'active');
  const detail1 = (await ctx.api(`/spend-requests/${req1.id}`)).body;
  assert.deepEqual(detail1.ledger.map((e) => `${e.kind}:${e.amount_minor}`), ['reserve:30000', 'release:30000', 'capture:30000']);

  // 4. 만든 카드가 계획과 다르다(일회용이 빠짐) → 쓰이기 전에 해지하고 failed
  const req2 = (await ask({ amount_minor: 20000, payee: 'Sponsor card' })).spend_request;
  fake.state.mangle = (card) => ({ ...card, lifecycle_controls: null });
  const mangled = await approve(req2);
  assert.equal(mangled.body.status, 'failed', mangled.text);
  assert.match(mangled.body.error, /did not match the plan \(lifecycle_controls\) and was canceled before it could be used/);
  assert.equal(fake.state.cards.at(-1).status, 'canceled');
  assert.deepEqual(mangled.body.provider_response.mismatched, ['lifecycle_controls']);

  // 5. 분명한 거절(Stripe 오류 객체) → failed, 활성화하지 않는다
  const req3 = (await ask({ amount_minor: 20000, payee: 'Sponsor card' })).spend_request;
  fake.state.overrides.push({ match: (c) => c.method === 'POST' && c.path === '/v1/issuing/cards', reply: stripeError(400, 'invalid_request_error', 'parameter_invalid_string', `Invalid category; key ${STRIPE_KEY}`) });
  const postsBefore3 = posts().length;
  const refusedCreate = await approve(req3);
  assert.equal(refusedCreate.body.status, 'failed', refusedCreate.text);
  assert.equal(refusedCreate.body.error, 'Stripe refused to create the card (HTTP 400 invalid_request_error (parameter_invalid_string))');
  assert.equal(refusedCreate.body.provider_response.message_untrusted, 'Invalid category; key [redacted]');
  assert.equal(posts().length, postsBefore3 + 1, 'no activation after a refused create');

  // 6. 모호한 생성(카드는 생겼고 500) → unknown. 카드가 해지되지 않은 채 있으면 실패로 기록하지 않는다
  const req4 = (await ask({ amount_minor: 20000, payee: 'Sponsor card' })).spend_request;
  fake.state.overrides.push({
    match: (c) => c.method === 'POST' && c.path === '/v1/issuing/cards',
    reply: (entry, { createCard }) => { createCard(entry.body); return stripeError(500, 'api_error', '', 'An unknown error occurred'); },
  });
  const ambiguous = await approve(req4);
  assert.equal(ambiguous.body.status, 'unknown', ambiguous.text);
  assert.match(ambiguous.body.error, /a card may exist \(inactive, so it cannot be used\)/);
  const early = await ctx.post(`/spend-requests/${req4.id}/mark-failed`, { note: 'too early' });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /card request without a clear answer can still show up at Stripe Issuing/);
  await pastFailGrace(ctx, req4.id);
  const strayCard = fake.state.cards.at(-1);
  assert.equal(strayCard.status, 'inactive');
  const inspected = await ctx.post(`/spend-requests/${req4.id}/inspect`);
  assert.equal(inspected.status, 200, inspected.text);
  assert.equal(inspected.body.kind, 'card');
  assert.equal(inspected.body.result, 'found');
  assert.deepEqual(inspected.body.cards.map((c) => [c.id, c.status, c.limit_minor]), [[strayCard.id, 'inactive', 20000]]);
  const blocked = await ctx.post(`/spend-requests/${req4.id}/mark-failed`, { note: 'no card?' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, new RegExp(`a card for this request exists but was never activated \\(${strayCard.id}, inactive\\) — cancel it in the Stripe Dashboard and record the failure with confirm_no_spend, or activate it there`));
  strayCard.status = 'canceled';
  const needConfirm = await ctx.post(`/spend-requests/${req4.id}/mark-failed`, { note: 'canceled it' });
  assert.equal(needConfirm.status, 409);
  assert.match(needConfirm.body.error, /only canceled cards were found for this request .* confirm_no_spend/);
  const confirmed = await ctx.post(`/spend-requests/${req4.id}/mark-failed`, { note: 'canceled, nothing spent', confirm_no_spend: true });
  assert.equal(confirmed.body.status, 'failed', confirmed.text);
  const audit = (await ctx.api(`/campaigns/${campaign.id}/audit?limit=500`)).body;
  const failedEvent = audit.find((e) => e.entity_id === req4.id && e.action === 'spend.failed');
  assert.deepEqual(failedEvent.detail.card_check, { result: 'found', cards: [strayCard.id], confirmed_no_spend: true });

  // 7. 생성이 시간 초과(카드 없음) → unknown, 유예 뒤 카드가 없으면 확인 없이 실패로 기록
  const req5 = (await ask({ amount_minor: 20000, payee: 'Sponsor card' })).spend_request;
  fake.state.overrides.push({ match: (c) => c.method === 'POST' && c.path === '/v1/issuing/cards', reply: 'timeout' });
  assert.equal((await approve(req5)).body.status, 'unknown');
  await pastFailGrace(ctx, req5.id);
  assert.equal((await ctx.post(`/spend-requests/${req5.id}/inspect`)).body.result, 'none');
  const none = await ctx.post(`/spend-requests/${req5.id}/mark-failed`, { note: 'no card' });
  assert.equal(none.body.status, 'failed', none.text);

  // 8. 활성화가 시간 초과 → unknown(카드 id 를 안다) — 기록용 ref 가 카드 id, 요청별 확인이 카드를 찾는다
  const req6 = (await ask({ amount_minor: 20000, payee: 'Sponsor card' })).spend_request;
  fake.state.overrides.push({ match: (c) => c.method === 'POST' && /^\/v1\/issuing\/cards\/./.test(c.path), reply: 'timeout' });
  const activationLost = await approve(req6);
  assert.equal(activationLost.body.status, 'unknown', activationLost.text);
  const card6 = fake.state.cards.at(-1).id;
  assert.equal(activationLost.body.suggested_provider_ref, card6);
  assert.equal(activationLost.body.provider_response.card_id, card6);
  assert.equal((await ctx.post(`/spend-requests/${req6.id}/inspect`)).body.cards[0].id, card6);
  assert.equal((await ctx.post(`/spend-requests/${req6.id}/mark-paid`, { provider_ref: card6 })).body.status, 'paid');

  // 9. 활성화가 분명히 거절됨 → 비활성 카드를 해지하고 failed
  const req7 = (await ask({ amount_minor: 20000, payee: 'Sponsor card' })).spend_request;
  fake.state.overrides.push({ match: (c) => c.method === 'POST' && /^\/v1\/issuing\/cards\/./.test(c.path) && /status=active/.test(c.body), reply: stripeError(402, 'invalid_request_error', 'insufficient_funds', 'Issuing balance too low') });
  const activationRefused = await approve(req7);
  assert.equal(activationRefused.body.status, 'failed', activationRefused.text);
  assert.match(activationRefused.body.error, /Stripe refused to activate the card \(HTTP 402 invalid_request_error \(insufficient_funds\)\); the inactive card was canceled/);
  assert.equal(fake.state.cards.at(-1).status, 'canceled');

  // 10. 요청 뒤에 수취인의 카드 통제가 바뀌면 승인하지 않는다
  const req8 = (await ask({ amount_minor: 20000, payee: 'Sponsor card' })).spend_request;
  const changed = campaign.payees.map((p) => (p.name === 'Sponsor card' ? { ...p, card_categories: ['software'] } : p));
  assert.equal((await ctx.patch(`/campaigns/${campaign.id}`, { payees: changed })).status, 200);
  const drift = await approve(req8);
  assert.equal(drift.status, 409);
  assert.match(drift.body.error, /card controls \(single-use or categories\) changed since this request/);
  await ctx.post(`/spend-requests/${req8.id}/deny`, { note: 'controls changed' });
  assert.equal((await ctx.patch(`/campaigns/${campaign.id}`, { payees: campaign.payees })).status, 200);

  // 11. 실행 전에 카드 소지자가 막혔다 → 보내지 않고 failed
  const req9 = (await ask({ amount_minor: 20000, payee: 'Sponsor card' })).spend_request;
  fake.state.cardholders.ich_sandbox1.requirements = { disabled_reason: 'requirements.past_due', past_due: ['individual.dob.day'] };
  const postsBefore9 = posts().length;
  const blockedHolder = await approve(req9);
  assert.equal(blockedHolder.body.status, 'failed', blockedHolder.text);
  assert.match(blockedHolder.body.error, /^not sent: the cardholder changed since the request: .*disabled \(requirements\.past_due\)/);
  assert.equal(posts().length, postsBefore9, 'nothing was sent');
  fake.state.cardholders.ich_sandbox1.requirements = { disabled_reason: null, past_due: [] };

  // 12. 환불은 막는다(카드 문장)
  const refund = await ctx.post(`/spend-requests/${req1.id}/refund`, { amount_minor: 1000, note: 'unused' });
  assert.equal(refund.status, 409);
  assert.match(refund.body.error, /issued a card with that limit — returning unused budget needs the card to be canceled and its spending reconciled/);

  // 13. 연결 확인 — 읽기만, 카드 소지자 이름은 사람만 보는 여기에만, 열린 요청 규칙 없음
  const postsBeforeCheck = posts().length;
  const check = await ctx.post(`/campaigns/${campaign.id}/payment/check`);
  assert.equal(check.status, 200, check.text);
  const byName = Object.fromEntries(check.body.payees.map((p) => [p.payee, p]));
  assert.equal(byName['Sponsor card'].ok, true, JSON.stringify(byName['Sponsor card']));
  assert.equal(byName['Sponsor card'].target_name_untrusted, 'Jane Doe');
  assert.equal(byName['Sponsor card'].open_request, null);
  assert.equal(byName['Sponsor card'].facts.kind, 'card');
  assert.equal(byName['Live holder'].ok, false);
  assert.equal(posts().length, postsBeforeCheck, 'the check never writes');

  // 14. 비밀 키 · 카드 소지자 개인정보는 요청 행 · 감사 · MCP 어디에도 없다
  const mcpView = await ctx.mcp.callTool('get_marketing_spend_request', { spend_request_id: req1.id });
  assert.equal(mcpView.status, 'paid');
  const rows = await ds.getRepository('MarketingSpendRequest').findBy({ campaign_id: campaign.id });
  const events = await ds.getRepository('MarketingAuditEvent').findBy({ campaign_id: campaign.id });
  const agentFacing = JSON.stringify([rows, events, mcpView, r1, ctx.responses.filter((r) => !r.path.endsWith('/payment/check'))]);
  for (const marker of [STRIPE_KEY, ...PII]) assert.equal(agentFacing.includes(marker), false, `${marker.slice(0, 12)}… leaked`);
  assert.equal(JSON.stringify(ctx.responses).includes(STRIPE_KEY), false, 'the key is in no response at all');
  void spend;
});

/** 카드 수취인 하나로 쓸 수 있는 캠페인 · 채널 · 배분까지 만든다. */
async function stripeCampaign(ctx, payees) {
  const created = await ctx.post('/campaigns', {
    name: 'Stripe edge cases', agent_runtime: ctx.agent.runtime_spec, capabilities: ['paid_spend'], currency: 'USD',
    budget_total_minor: 5_000_000, budget_period: 'month', budget_period_minor: 5_000_000, max_transaction_minor: 2_000_000, dual_approval_threshold_minor: 0,
    payees, limits: { spend_requests_per_day: 100 },
  });
  assert.equal(created.status, 201, created.text);
  const campaign = created.body;
  assert.equal((await ctx.post(`/campaigns/${campaign.id}/status`, { status: 'active' })).status, 200);
  const channel = (await ctx.post(`/campaigns/${campaign.id}/channels`, { platform: 'other', target: 'Sponsorships', name: 'Sponsorships' })).body;
  assert.equal((await ctx.post(`/channels/${channel.id}/approve`, { mode: 'manual' })).body.status, 'active');
  assert.equal((await ctx.post(`/campaigns/${campaign.id}/allocations`, { allocations: [{ channel_id: channel.id, amount_minor: 5_000_000 }], rationale: 'cards', approve: true })).status, 201);
  const ask = async (fields) => {
    const r = await ctx.mcp.callTool('request_marketing_spend', { campaign_id: campaign.id, channel_id: channel.id, currency: 'USD', purpose: 'Newsletter sponsorship', expected_outcome: '30 signups', ...fields });
    assert.ok(r.spend_request, JSON.stringify(r));
    return r.spend_request;
  };
  const approve = (req) => ctx.post(`/spend-requests/${req.id}/approve`, { payload_sha256: req.payload_sha256 });
  return { campaign, channel, ask, approve };
}

const isCardCreate = (c) => c.method === 'POST' && c.path === '/v1/issuing/cards';
const isCardList = (c) => c.method === 'GET' && c.path === '/v1/issuing/cards';
const isStatusUpdate = (status) => (c) => c.method === 'POST' && /^\/v1\/issuing\/cards\/./.test(c.path) && new URLSearchParams(c.body).get('status') === status;

test('Stripe Issuing: unclear answers stay unknown, a card that does not match is canceled, and a failure is never recorded past a card that could still be used', async (t) => {
  const ctx = await setup(t);
  const { fake, ds, spend } = ctx;
  const cred = await ctx.makeCred('stripe-sandbox', 'stripe_issuing', { secret_key: STRIPE_KEY });
  const { campaign, ask, approve } = await stripeCampaign(ctx, [{ name: 'Sponsor card', provider: 'stripe_issuing', credential_id: cred.id, ref: 'ich_sandbox1' }]);
  const posts = () => fake.state.calls.filter((c) => c.method === 'POST');
  const markFailed = (req, body = {}) => ctx.post(`/spend-requests/${req.id}/mark-failed`, { note: 'checked', ...body });
  const failedDetail = async (req) => {
    const audit = (await ctx.api(`/campaigns/${campaign.id}/audit?limit=500`)).body;
    return audit.find((e) => e.entity_id === req.id && e.action === 'spend.failed')?.detail;
  };

  // 1. 생성의 모호한 답 — 같은 키 진행 중(409) · 멱등 오류 · Stripe 오류 객체가 아닌 4xx: 모두 unknown, 그 뒤로 아무것도 보내지 않는다
  for (const [label, reply] of [
    ['409 idempotency_key_in_use', stripeError(409, 'invalid_request_error', 'idempotency_key_in_use', 'There is currently another in-progress request using this key')],
    ['idempotency_error', stripeError(400, 'idempotency_error', '', 'Keys for idempotent requests can only be used with the same parameters')],
    ['403 from a proxy', new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } })],
  ]) {
    const req = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
    fake.state.overrides.push({ match: isCardCreate, reply });
    const before = posts().length;
    const r = await approve(req);
    assert.equal(r.body.status, 'unknown', `${label}: ${r.text}`);
    assert.match(r.body.error, /a card may exist \(inactive, so it cannot be used\)/, label);
    assert.equal(posts().length, before + 1, `${label}: nothing is sent after the create`);
  }

  // 2. 만든 카드가 계획과 다르고(metadata) 해지도 실패 → unknown(카드 id 기록). 목록의 metadata 로는 못 찾는 그 카드를 직접 읽어,
  //    해지되기 전에는 "쓴 돈 없음 확인" 이 있어도 실패로 기록하지 않는다
  const reqM = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
  fake.state.mangle = (card) => ({ ...card, metadata: {} });
  fake.state.overrides.push({ match: isStatusUpdate('canceled'), reply: stripeError(500, 'api_error', '', 'An unknown error occurred') });
  const noCancel = await approve(reqM);
  assert.equal(noCancel.body.status, 'unknown', noCancel.text);
  const cardM = fake.state.cards.at(-1);
  assert.match(noCancel.body.error, new RegExp(`did not match the plan \\(metadata\\) and could not be canceled — cancel card ${cardM.id} in the Stripe Dashboard`));
  assert.equal(noCancel.body.provider_response.card_id, cardM.id);
  assert.equal(cardM.status, 'inactive', 'never activated');
  await pastFailGrace(ctx, reqM.id);
  const inspectM = await ctx.post(`/spend-requests/${reqM.id}/inspect`);
  assert.equal(inspectM.body.result, 'found', inspectM.text);
  assert.deepEqual(inspectM.body.cards.map((c) => [c.id, c.status]), [[cardM.id, 'inactive']]);
  const blockedM = await markFailed(reqM, { confirm_no_spend: true });
  assert.equal(blockedM.status, 409, blockedM.text);
  assert.match(blockedM.body.error, new RegExp(`exists but was never activated \\(${cardM.id}, inactive\\)`));
  cardM.status = 'canceled';
  assert.equal((await markFailed(reqM)).status, 409, 'a canceled card still needs the no-spend confirmation');
  assert.equal((await markFailed(reqM, { confirm_no_spend: true })).body.status, 'failed');
  assert.deepEqual((await failedDetail(reqM)).card_check, { result: 'found', cards: [cardM.id], confirmed_no_spend: true });

  // 3. 활성화가 분명히 거절되고 해지도 실패 → unknown
  const reqA = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
  fake.state.overrides.push({ match: isStatusUpdate('active'), reply: stripeError(402, 'invalid_request_error', 'insufficient_funds', 'Issuing balance too low') });
  fake.state.overrides.push({ match: isStatusUpdate('canceled'), reply: 'timeout' });
  const refusedNoCancel = await approve(reqA);
  assert.equal(refusedNoCancel.body.status, 'unknown', refusedNoCancel.text);
  assert.match(refusedNoCancel.body.error, /refused to activate card ic_fake\d+ \(HTTP 402 invalid_request_error \(insufficient_funds\)\) and it could not be canceled/);
  assert.equal(fake.state.cards.at(-1).status, 'inactive');

  // 4. 활성화된 카드가 계획과 다르다(같은 카드, 한도가 다름) → 해지하고 failed. 해지도 같은 Stripe-Version 과 고정 멱등 키로
  const reqB = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
  fake.state.overrides.push({
    match: isStatusUpdate('active'),
    reply: (entry, { cardJson }) => {
      const card = fake.state.cards.at(-1);
      card.status = 'active';
      const body = cardJson(card);
      return json(200, { ...body, spending_controls: { ...body.spending_controls, spending_limits: [{ amount: 999_999, interval: 'all_time', categories: null }] } });
    },
  });
  const activeMismatch = await approve(reqB);
  assert.equal(activeMismatch.body.status, 'failed', activeMismatch.text);
  const cardB = fake.state.cards.at(-1);
  assert.equal(activeMismatch.body.error, `card ${cardB.id} did not match the plan after activation (spending_limits) and was canceled`);
  assert.equal(cardB.status, 'canceled');
  const cancelB = fake.state.calls.filter(isStatusUpdate('canceled')).at(-1);
  assert.equal(cancelB.path, `/v1/issuing/cards/${cardB.id}`);
  assert.equal(cancelB.headers['idempotency-key'], `awb-spend-${reqB.id}-cancel`);
  assert.equal(cancelB.headers['stripe-version'], '2026-09-30.endive');
  assert.equal(fake.state.calls.filter(isStatusUpdate('active')).at(-1).headers['stripe-version'], '2026-09-30.endive');

  // 5. 활성화에 다른 카드로 답함 → unknown. 그 카드는 건드리지 않고 이 요청의 카드만 해지한다
  const bystander = fake.createCard(new URLSearchParams({ cardholder: 'ich_sandbox1', currency: 'usd', type: 'virtual', status: 'active' }).toString());
  const reqO = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
  fake.state.overrides.push({ match: isStatusUpdate('active'), reply: (entry, { cardJson }) => json(200, cardJson(bystander)) });
  const otherCard = await approve(reqO);
  assert.equal(otherCard.body.status, 'unknown', otherCard.text);
  const cardO = fake.state.cards.at(-1);
  assert.equal(otherCard.body.error, `Stripe answered the activation of card ${cardO.id} with a different card (card ${cardO.id} was canceled) — check this request's cards in the Stripe Dashboard`);
  assert.equal(cardO.status, 'canceled');
  assert.equal(bystander.status, 'active', 'a card this request did not create is never touched');

  // 6. 카드를 끝까지 찾지 못하면 "쓴 돈 없음 확인" 없이는 실패로 기록하지 않는다 — 빈 쪽인데 더 있음 · 목록이 아닌 답 · 바뀐 키
  const reqC = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
  fake.state.overrides.push({ match: isCardCreate, reply: 'timeout' });
  assert.equal((await approve(reqC)).body.status, 'unknown');
  await pastFailGrace(ctx, reqC.id);
  fake.state.overrides.push({ match: isCardList, reply: json(200, { object: 'list', data: [], has_more: true }) });
  const halfway = await markFailed(reqC);
  assert.equal(halfway.status, 409, halfway.text);
  assert.match(halfway.body.error, /could not look through all of this cardholder's cards/);
  fake.state.overrides.push({ match: isCardList, reply: json(200, {}) });
  const notAList = await markFailed(reqC);
  assert.equal(notAList.status, 409, notAList.text);
  assert.match(notAList.body.error, /could not check Stripe for this request's card \(could not read Stripe cards of ich_sandbox1 \(the answer is not a card list\)\)/);
  fake.state.overrides.push({ match: isCardList, reply: json(200, { object: 'list', data: [{ id: 'ic_garbled' }], has_more: false }) });
  assert.match((await markFailed(reqC)).body.error, /could not look through all/, 'an unreadable card in the list is not "no card"');
  const credRepo = ds.getRepository('Credential');
  const original = (await credRepo.findOneBy({ id: cred.id })).encrypted_data;
  await credRepo.update({ id: cred.id }, { encrypted_data: encrypt(JSON.stringify({ secret_key: 'rk_test_anotherAccountKey0123456789' })) });
  const listsBefore = fake.state.calls.filter(isCardList).length;
  const otherKey = await ctx.post(`/spend-requests/${reqC.id}/inspect`);
  assert.equal(otherKey.status, 409, otherKey.text);
  assert.match(otherKey.body.error, /the Stripe key changed since this request/);
  const keyChanged = await markFailed(reqC);
  assert.equal(keyChanged.status, 409, keyChanged.text);
  assert.match(keyChanged.body.error, /could not check Stripe for this request's card \(the Stripe key changed since this request/);
  assert.equal(fake.state.calls.filter(isCardList).length, listsBefore, 'another key never answers for this request');
  const confirmedC = await markFailed(reqC, { confirm_no_spend: true });
  assert.equal(confirmedC.body.status, 'failed', confirmedC.text);
  const detailC = await failedDetail(reqC);
  assert.equal(detailC.card_check.result, 'unchecked');
  assert.equal(detailC.card_check.confirmed_no_spend, true);
  await credRepo.update({ id: cred.id }, { encrypted_data: original });

  // 7. 잠금 안에서 다시 본다 — 카드를 확인하지 않은 채(실행 중으로 보고 들어옴) 그 사이 결과 불명이 된 요청은 닫지 않는다
  const reqL = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
  fake.state.overrides.push({ match: isCardCreate, reply: 'timeout' });
  assert.equal((await approve(reqL)).body.status, 'unknown');
  await pastFailGrace(ctx, reqL.id);
  const realGet = spend.get;
  spend.get = async function staleOnce(...args) {
    spend.get = realGet;
    const row = await realGet.apply(this, args);
    return Object.assign(Object.create(Object.getPrototypeOf(row)), row, { status: 'executing' });
  };
  t.after(() => { spend.get = realGet; });
  const changedUnder = await markFailed(reqL);
  assert.equal(changedUnder.status, 409, changedUnder.text);
  assert.match(changedUnder.body.error, /the request changed while its card was being checked/);

  // 7b. 활성화 답을 잃었는데 카드는 살아 있다(시간 초과) — 그 사이 다른 서버의 부팅이 요청을 결과 불명으로 돌렸어도 늦게 온 결과의
  //     카드 id 가 행에 남고, 실패 기록 때 목록을 못 읽어도(500) 그 카드를 직접 읽어 "쓴 돈 없음 확인" 이 있어도 거부한다.
  const reqK = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
  fake.state.overrides.push({
    match: isStatusUpdate('active'),
    reply: async () => {
      fake.state.cards.at(-1).status = 'active';
      assert.equal(await spend.recoverInterrupted(new Date(Date.now() + 60_000)), 1, 'another server boots and marks the execution unknown');
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    },
  });
  await approve(reqK);
  const cardK = fake.state.cards.at(-1);
  const rowK = await ds.getRepository('MarketingSpendRequest').findOneBy({ id: reqK.id });
  assert.equal(rowK.status, 'unknown');
  assert.equal(rowK.provider_response.card_id, cardK.id, 'the late unknown result keeps the card id on the row');
  assert.match(rowK.error, new RegExp(`did not answer in time while card ${cardK.id} was being activated`));
  await pastFailGrace(ctx, reqK.id);
  fake.state.overrides.push({ match: isCardList, reply: stripeError(500, 'api_error', '', 'An unknown error occurred') });
  const listDown = await markFailed(reqK, { confirm_no_spend: true });
  assert.equal(listDown.status, 409, listDown.text);
  assert.match(listDown.body.error, new RegExp(`an active card for this request exists \\(${cardK.id}\\)`), 'the recorded card is read even when the list is not');
  cardK.status = 'canceled';
  fake.state.overrides.push({ match: isCardList, reply: stripeError(500, 'api_error', '', 'An unknown error occurred') });
  const canceledListDown = await markFailed(reqK);
  assert.equal(canceledListDown.status, 409, canceledListDown.text);
  assert.match(canceledListDown.body.error, new RegExp(`could not look through all of this cardholder's cards \\(found only canceled cards: ${cardK.id}\\)`));
  fake.state.overrides.push({ match: isCardList, reply: stripeError(500, 'api_error', '', 'An unknown error occurred') });
  assert.equal((await markFailed(reqK, { confirm_no_spend: true })).body.status, 'failed');
  assert.deepEqual((await failedDetail(reqK)).card_check, { result: 'incomplete', cards: [cardK.id], confirmed_no_spend: true });

  // 7c. 카드를 찾는 사이 늦게 온 결과가 실행의 카드 id 를 채우면, 그 카드를 보지 않은 확인으로 닫지 않는다(잠금 안에서 다시 본다)
  const reqR = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
  fake.state.overrides.push({ match: isCardCreate, reply: 'timeout' });
  assert.equal((await approve(reqR)).body.status, 'unknown');
  await pastFailGrace(ctx, reqR.id);
  fake.state.overrides.push({
    match: isCardList,
    reply: async () => {
      await ds.getRepository('MarketingSpendRequest').update({ id: reqR.id }, { provider_response: { sent: true, step: 'activate', card_id: 'ic_lateArrival' } });
      return json(200, { object: 'list', data: [], has_more: false });
    },
  });
  const raced = await markFailed(reqR);
  assert.equal(raced.status, 409, raced.text);
  assert.match(raced.body.error, /the request changed while its card was being checked/);
  assert.equal((await ds.getRepository('MarketingSpendRequest').findOneBy({ id: reqR.id })).status, 'unknown');

  // 8. 쪽 넘기기 — 이 요청의 카드가 둘째 쪽에 있어도 찾고, 1,000장을 넘게 봐야 하면 "다 보지 못함" 이다
  const reqP = await ask({ amount_minor: 10000, payee: 'Sponsor card' });
  fake.state.overrides.push({ match: isCardCreate, reply: (entry, { createCard }) => { createCard(entry.body); return stripeError(500, 'api_error', '', 'An unknown error occurred'); } });
  assert.equal((await approve(reqP)).body.status, 'unknown');
  const cardP = fake.state.cards.at(-1);
  await pastFailGrace(ctx, reqP.id);
  const filler = (n) => {
    for (let i = 0; i < n; i++) fake.createCard(new URLSearchParams({ cardholder: 'ich_sandbox1', currency: 'usd', type: 'virtual', 'metadata[awb_spend_request_id]': 'someone-else' }).toString());
  };
  filler(150);
  const pageTwo = await markFailed(reqP, { confirm_no_spend: true });
  assert.equal(pageTwo.status, 409, pageTwo.text);
  assert.match(pageTwo.body.error, new RegExp(`exists but was never activated \\(${cardP.id}, inactive\\)`));
  assert.ok(fake.state.calls.filter(isCardList).at(-1).query.starting_after, 'the second page was read');
  filler(900);
  const tooMany = await markFailed(reqP);
  assert.equal(tooMany.status, 409, tooMany.text);
  assert.match(tooMany.body.error, /could not look through all of this cardholder's cards/);
});

test('Stripe Issuing executor: a stalled execution never activates a card, and a card list is "empty" only when every page was read', async () => {
  const { executeStripePlan, findCardsForRequest, STRIPE_ACTIVATE_WITHIN_MS } = await import('../dist/modules/marketing/marketing-payment-stripe.js');
  const plan = {
    plan: 'issue_card', provider: 'stripe_issuing', target: { cardholder: 'ich_sandbox1' }, currency: 'USD', limit_minor: 10000, interval: 'all_time',
    single_use: true, allowed_categories: [], livemode: false, credential_fingerprint: 'fp',
  };
  const cred = { secret_key: STRIPE_KEY, mode: 'test' };
  const startedAt = new Date('2026-10-23T00:00:00Z');
  const late = startedAt.getTime() + STRIPE_ACTIVATE_WITHIN_MS + 1;

  // a. 카드를 만들기 전에 이미 늦었다 → 아무것도 보내지 않는다
  const fake = fakeStripe();
  await assert.rejects(
    executeStripePlan(plan, cred, 'req-late-1', { fetchImpl: fake.fetchImpl, env: {}, startedAt, now: () => new Date(late) }),
    (e) => e.name === 'PaymentNotSentError' && /no card is created for a stalled execution/.test(e.message),
  );
  assert.equal(fake.state.calls.filter((c) => c.method === 'POST').length, 0);

  // b. 만드는 사이 늦었다 → 활성화하지 않고 해지(failed), 해지가 안 되면 unknown
  let clock = startedAt.getTime();
  const slowCreate = { match: isCardCreate, reply: (entry, { createCard, cardJson }) => { clock = late; return json(200, cardJson(createCard(entry.body))); } };
  fake.state.overrides.push(slowCreate);
  const canceled = await executeStripePlan(plan, cred, 'req-late-2', { fetchImpl: fake.fetchImpl, env: {}, startedAt, now: () => new Date(clock) });
  assert.equal(canceled.outcome, 'failed', JSON.stringify(canceled));
  assert.match(canceled.error, /more than 5 minutes passed since the execution started, so card ic_fake\d+ was canceled instead of activated/);
  assert.equal(fake.state.cards.at(-1).status, 'canceled');
  clock = startedAt.getTime();
  fake.state.overrides.push({ ...slowCreate }, { match: isStatusUpdate('canceled'), reply: 'timeout' });
  const stuck = await executeStripePlan(plan, cred, 'req-late-3', { fetchImpl: fake.fetchImpl, env: {}, startedAt, now: () => new Date(clock) });
  assert.equal(stuck.outcome, 'unknown', JSON.stringify(stuck));
  assert.equal(fake.state.cards.at(-1).status, 'inactive');
  assert.equal(fake.state.calls.some(isStatusUpdate('active')), false, 'a late card is never activated');

  // b2. 해지 답은 그 카드(id)가 해지됐다는 카드 객체여야 한다 — 다른 카드 · 빈 본문이면 해지를 모르는 것이라 unknown
  for (const [label, reply] of [
    ['bare status', () => json(200, { status: 'canceled' })],
    ['another card', (entry, { cardJson }) => json(200, { ...cardJson(fake.state.cards[0]), status: 'canceled' })],
  ]) {
    fake.state.mangle = (card) => ({ ...card, metadata: {} });
    fake.state.overrides.push({ match: isStatusUpdate('canceled'), reply });
    const notCanceled = await executeStripePlan(plan, cred, `req-cancel-${label.replace(' ', '-')}`, { fetchImpl: fake.fetchImpl, env: {}, startedAt, now: () => new Date(startedAt.getTime() + 1000) });
    assert.equal(notCanceled.outcome, 'unknown', `${label}: ${JSON.stringify(notCanceled)}`);
    assert.match(notCanceled.error, /could not be canceled/, label);
  }

  // c. 늦지 않았으면 그대로 발급한다
  const onTime = await executeStripePlan(plan, cred, 'req-on-time', { fetchImpl: fake.fetchImpl, env: {}, startedAt, now: () => new Date(startedAt.getTime() + 1000) });
  assert.equal(onTime.outcome, 'paid', JSON.stringify(onTime));

  // d. 목록 읽기 — "없음" 은 모든 쪽 · 모든 항목을 읽었을 때만
  const list = (body) => async () => json(200, body);
  const scan = (body, opts = {}) => findCardsForRequest({ cardholder: 'ich_sandbox1' }, cred, 'req-x', startedAt, { fetchImpl: list(body), env: {}, ...opts });
  assert.equal((await scan({ object: 'list', data: [], has_more: false })).result, 'none');
  assert.equal((await scan({ object: 'list', data: [], has_more: true })).result, 'incomplete');
  assert.equal((await scan({ object: 'list', data: [{ id: 'ic_1' }], has_more: false })).result, 'incomplete');
  for (const body of [{}, { data: [] }, { object: 'list', data: 'x', has_more: false }, { object: 'list', data: [] }]) {
    await assert.rejects(scan(body), (e) => e.name === 'PaymentReadError' && /not a card list/.test(e.message), JSON.stringify(body));
  }
});
