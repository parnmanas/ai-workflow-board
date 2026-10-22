// Marketing 직접 결제 어댑터(Meta Ads · Google Ads) — docs/marketing.md "직접 결제 어댑터".
//
// 공급자 API 는 MarketingSpendService.fetchImpl 로 가로챈 가짜(상태를 가진 Graph API · Google Ads REST · OAuth)다.
// 실제 계정 · 실제 돈은 쓰지 않는다.
//
// 고정하는 것:
//   1. 결제 경로는 수취인마다: 직접 공급자 수취인은 이 계정의 그 공급자 전용 credential 만(전역 · 다른 종류 · 에이전트 노출 거부).
//   2. 요청: 에이전트 payload 거부, 서버가 대상을 읽어(쓰기 없음) 계획(from → to)을 만들어 해시한다. 한도 없는 캠페인 · 일 예산
//      캠페인은 저장하지 않고 거부하고(감사), 같은 대상은 잠시 다시 묻지 않는다. 대상마다 열린 요청은 하나.
//   3. 실행: 다시 읽어 from 일 때만 to 를 쓴다(쓰기 1번). 그 사이 바뀌었으면 보내지 않고 failed, 이미 to 면 unknown.
//      토큰은 Authorization 헤더로만(주소에 없음). Google 은 MUTABLE_RESOURCE 로 돌아온 값으로 확정한다.
//   4. 모호하면 unknown — 시간 초과 · 5xx · 보낸 뒤의 예외. sweep 은 다시 보내지 않는다. 거절(failed)이라도 다시 읽어 이미 to 면
//      unknown. 보내기 전의 실패(credential · 토큰)는 failed 이고 쓰기가 없다.
//   5. 사람이 바꾼 결정이 이긴다: 수취인을 다른 대상으로 돌렸거나 credential 을 바꿨으면 승인 · 실행하지 않는다. 한 시간 넘은 승인은
//      실행하지 않는다. 다른 서버가 unknown 으로 돌린 실행의 확정 결과는 그 unknown 을 닫는다.
//   6. 상한 공급자의 환불은 막는다. 연결 확인 · 요청별 확인은 읽기만 한다(쓰기 0).
//   7. 비밀 값(토큰 · 키 · refresh token · access token)은 요청 행 · 감사 · MCP · REST 응답 어디에도 없다. 오류 문장(error)에는
//      상태 · 오류 코드만, 공급자 글은 응답 요약의 message_untrusted 에만.
//   8. 결과 불명은 실행 뒤 15분이 지나야 실패로 기록할 수 있다(결제 완료는 바로). credential 을 같은 내용으로 다시 저장한 것은
//      지문이 그대로라 실행된다. 다른 계정의 열린 요청은 그 대상을 읽을 수 있을 때만, id · 상태 없이 알린다. 같은 순간의 유일
//      인덱스 충돌은 DB 문구 대신 설명으로. Google 은 401 을 받은 access token 을 캐시에서 지운다.
//
// 실행: node --test --test-force-exit test/marketing-spend-direct.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { MarketingSpendService } from '../dist/modules/marketing/marketing-spend.service.js';
import { DIRECT_PAYMENT_ADAPTERS } from '../dist/modules/marketing/marketing-payment-adapters.js';
import { PaymentNotSentError } from '../dist/modules/marketing/marketing-payments.js';
import { resetGoogleTokenCache } from '../dist/modules/marketing/marketing-payment-google.js';
import { lockCampaign } from '../dist/modules/marketing/marketing-ledger.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';
process.env.MARKETING_SCHEDULER_ENABLED = 'false';
process.env.OUTREACH_SCHEDULER_ENABLED = 'false';
delete process.env.MARKETING_META_API_VERSION;
delete process.env.MARKETING_GOOGLE_ADS_API_VERSION;

const META_TOKEN = 'EAAB-meta-token-marker-0123456789';
const META_TOKEN_ROTATED = 'EAAB-meta-rotated-marker-9876543210';
const META_TOKEN_OTHER = 'EAAB-meta-other-account-marker-555';
const META_APP_SECRET = 'meta-app-secret-marker-abcdef';
const GOOGLE_CLIENT_SECRET = 'GOCSPX-google-client-secret-marker';
const GOOGLE_REFRESH = '1//google-refresh-token-marker';
const GOOGLE_ACCESS = 'ya29.google-access-token-marker';
const MARKERS = [META_TOKEN, META_TOKEN_ROTATED, META_TOKEN_OTHER, META_APP_SECRET, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH, GOOGLE_ACCESS];

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

function json(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * 가짜 공급자 — Graph API(캠페인 · 광고 계정 읽기, spend_cap 쓰기), Google OAuth, Google Ads(GAQL 읽기 · 예산 mutate).
 * `overrides` 는 (조건, 응답) 큐다: 응답이 'timeout' 이면 시간 초과, 함수면 그 결과(쓰기를 실제로 반영할지 정할 수 있다).
 */
function fakeProviders() {
  const state = {
    meta: {
      campaigns: {
        77: { id: '77', name: 'Fall promo', account_id: '9', status: 'ACTIVE', effective_status: 'ACTIVE', buying_type: 'AUCTION', spend_cap: '100000' },
        78: { id: '78', name: 'Uncapped', account_id: '9', status: 'ACTIVE', effective_status: 'ACTIVE', buying_type: 'AUCTION' },
        79: { id: '79', name: 'Second', account_id: '9', status: 'ACTIVE', effective_status: 'ACTIVE', buying_type: 'AUCTION', spend_cap: '50000' },
      },
      accounts: { 9: { id: 'act_9', currency: 'USD', account_status: 1, disable_reason: 0, min_campaign_group_spend_cap: '10000' } },
    },
    google: {
      customers: { 1112223333: { currencyCode: 'USD' } },
      campaigns: {
        5: { customer: '1112223333', id: '5', name: 'Search total', status: 'ENABLED', endDateTime: '2099-01-31 23:59:59', budget: 'customers/1112223333/campaignBudgets/8' },
        6: { customer: '1112223333', id: '6', name: 'Search daily', status: 'ENABLED', endDateTime: '', budget: 'customers/1112223333/campaignBudgets/9' },
      },
      budgets: {
        'customers/1112223333/campaignBudgets/8': { resourceName: 'customers/1112223333/campaignBudgets/8', period: 'CUSTOM_PERIOD', status: 'ENABLED', totalAmountMicros: '1000000000', referenceCount: '1' },
        'customers/1112223333/campaignBudgets/9': { resourceName: 'customers/1112223333/campaignBudgets/9', period: 'DAILY', status: 'ENABLED', amountMicros: '50000000', referenceCount: '1' },
      },
    },
    calls: [],
    writes: [],
    overrides: [],
    tokenRequests: 0,
  };

  const metaGet = (u) => {
    const id = u.pathname.split('/').pop();
    if (id.startsWith('act_')) {
      const acct = state.meta.accounts[id.slice(4)];
      return acct ? json(200, acct) : json(400, { error: { message: 'Unsupported get request', code: 100, error_subcode: 33 } });
    }
    const c = state.meta.campaigns[id];
    return c ? json(200, c) : json(400, { error: { message: 'Unsupported get request', code: 100, error_subcode: 33 } });
  };
  const metaPost = (u, body) => {
    const id = u.pathname.split('/').pop();
    const form = new URLSearchParams(body);
    const c = state.meta.campaigns[id];
    if (!c) return json(400, { error: { message: 'no such object', code: 100 } });
    c.spend_cap = form.get('spend_cap');
    state.writes.push({ provider: 'meta', id, spend_cap: form.get('spend_cap'), form: Object.fromEntries(form) });
    return json(200, { success: true });
  };
  const googleSearch = (u, body) => {
    const q = JSON.parse(body).query;
    const cid = u.pathname.split('/')[3];
    if (/FROM currency_constant/.test(q)) {
      return json(200, { results: [{ currencyConstant: { resourceName: 'currencyConstants/USD', code: 'USD', billableUnitMicros: '10000' } }] });
    }
    const m = q.match(/campaign\.id = (\d+)/);
    const c = m && state.google.campaigns[m[1]];
    if (!c || c.customer !== cid) return json(200, { results: [], fieldMask: '' });
    const b = state.google.budgets[c.budget];
    const customer = state.google.customers[cid];
    // proto3 JSON: 기본값(false · 0)은 빠진다 — testAccount · explicitlyShared 를 보내지 않는다.
    return json(200, {
      results: [{
        customer: { resourceName: `customers/${cid}`, currencyCode: customer.currencyCode, ...(customer.testAccount ? { testAccount: true } : {}) },
        campaign: { resourceName: `customers/${cid}/campaigns/${c.id}`, id: c.id, name: c.name, status: c.status, campaignBudget: c.budget, ...(c.endDateTime ? { endDateTime: c.endDateTime } : {}) },
        campaignBudget: { ...b },
      }],
      fieldMask: 'customer.currencyCode,...',
    });
  };
  const googleMutate = (u, body) => {
    const req = JSON.parse(body);
    const op = req.operations[0];
    const b = state.google.budgets[op.update.resourceName];
    if (!b) return json(404, { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } });
    b.totalAmountMicros = String(op.update.totalAmountMicros);
    state.writes.push({ provider: 'google', budget: op.update.resourceName, total: b.totalAmountMicros, request: req });
    const result = { resourceName: b.resourceName, ...(req.responseContentType === 'MUTABLE_RESOURCE' ? { campaignBudget: { ...b } } : {}) };
    return json(200, { results: [result] });
  };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const entry = { host: u.host, method: init.method || 'GET', path: u.pathname, search: u.search, headers: { ...(init.headers || {}) }, body: init.body };
    state.calls.push(entry);
    const i = state.overrides.findIndex((o) => o.match(entry));
    if (i >= 0) {
      const o = state.overrides.splice(i, 1)[0];
      if (o.reply === 'timeout') { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
      const r = typeof o.reply === 'function' ? await o.reply(entry, { u, metaPost, googleMutate }) : o.reply;
      if (r instanceof Response) return r;
      if (r) return json(r.status, r.body);
    }
    if (u.host === 'graph.facebook.com') return entry.method === 'GET' ? metaGet(u) : metaPost(u, init.body);
    if (u.host === 'oauth2.googleapis.com') {
      state.tokenRequests++;
      return json(200, { access_token: GOOGLE_ACCESS, expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/adwords' });
    }
    if (u.host === 'googleads.googleapis.com') {
      if (u.pathname.endsWith(':search')) return googleSearch(u, init.body);
      if (u.pathname.endsWith('campaignBudgets:mutate')) return googleMutate(u, init.body);
    }
    return json(404, { error: 'unexpected host' });
  };
  return { state, fetchImpl };
}

async function setup(t, label) {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;
  const spend = app.get(MarketingSpendService);
  const fake = fakeProviders();
  spend.fetchImpl = fake.fetchImpl;
  resetGoogleTokenCache();

  const responses = [];
  const credRepo = ds.getRepository('Credential');
  /** 한 계정(소유자 세션 · REST · 그 계정의 credential · 에이전트 MCP) — 같은 서버에 둘 이상 만들 수 있다. */
  const tenant = async (name) => {
    const account = await createAccount(app, getDataSourceToken, `mkt-direct-${name}`);
    const owner = await createUser(app, getDataSourceToken, { name: `mkt-direct-owner-${name}`, role: 'admin' });
    await ds.getRepository('Account').update(account.id, { owner_user_id: owner.id });
    const headers = { Authorization: `Bearer ${app.get(AuthService).createSession(owner.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
    const api = async (path, init = {}, perms = null) => {
      await ds.getRepository('User').update(owner.id, {
        role: perms ? 'user' : 'admin',
        permissions: JSON.stringify(perms || []),
      });
      const r = await call(`${base}/api/marketing${path}`, { headers, ...init });
      responses.push(r.text);
      return r;
    };
    const post = (path, body = {}, perms) => api(path, { method: 'POST', body: JSON.stringify(body) }, perms);
    const patch = (path, body, perms) => api(path, { method: 'PATCH', body: JSON.stringify(body) }, perms);
    const makeCred = (credName, provider, fields, extra = {}) => credRepo.save(credRepo.create({
      account_id: account.id, name: credName, description: '', provider, encrypted_data: encrypt(JSON.stringify(fields)), ...extra,
    }));
    const agent = await createAgent(app, getDataSourceToken, account.id, { name: `mkt-direct-agent-${name}`, type: 'claude', runtime: true });
    const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: `mkt-direct-${name}` });
    const mcp = new McpClient({ baseUrl: base, apiKey: key.raw_key });
    t.after(() => mcp.close().catch(() => {}));
    return { account, api, post, patch, makeCred, agent, mcp };
  };
  const main = await tenant(label);
  return { app, ds, spend, fake, credRepo, responses, tenant, ...main };
}

/** 결과 불명의 실패 기록 유예(15분)가 지난 것으로 — 실행 시각을 당긴다. */
async function pastFailGrace(ctx, id) {
  await ctx.ds.getRepository('MarketingSpendRequest').update({ id }, { executing_at: new Date(Date.now() - 16 * 60_000) });
}

/** 캠페인 · 승인된 채널 · 편성까지 — 수취인은 호출하는 쪽이 정한다. */
async function campaignWith(ctx, payees) {
  const created = await ctx.post('/campaigns', {
    name: `Direct ${Date.now()}`,
    agent_runtime: ctx.agent.runtime_spec,
    capabilities: ['paid_spend'],
    currency: 'USD',
    budget_total_minor: 2_000_000,
    budget_period: 'month',
    budget_period_minor: 1_500_000,
    max_transaction_minor: 500_000,
    dual_approval_threshold_minor: 0,
    payees,
    limits: { spend_requests_per_day: 100 },
  });
  assert.equal(created.status, 201, created.text);
  const campaign = created.body;
  assert.equal((await ctx.post(`/campaigns/${campaign.id}/status`, { status: 'active' })).status, 200);
  const channel = (await ctx.post(`/campaigns/${campaign.id}/channels`, { platform: 'other', target: 'Paid ads', name: 'Paid ads' })).body;
  assert.equal((await ctx.post(`/channels/${channel.id}/approve`, { mode: 'manual' })).body.status, 'active');
  const alloc = await ctx.post(`/campaigns/${campaign.id}/allocations`, {
    allocations: [{ channel_id: channel.id, amount_minor: 1_500_000 }], rationale: 'paid test', approve: true,
  });
  assert.equal(alloc.status, 201, alloc.text);
  const ask = async (fields) => {
    try {
      return await ctx.mcp.callTool('request_marketing_spend', {
        campaign_id: campaign.id, channel_id: channel.id, currency: 'USD', purpose: 'Raise the cap', expected_outcome: '50 signups', ...fields,
      });
    } catch (e) {
      return { isError: true, error: String(e?.message || e) };
    }
  };
  return { campaign, channel, ask };
}

const errText = (r) => JSON.stringify(r?.error ?? r);

test('Meta Ads: a payee pins one campaign; the server raises its spend_cap by compare-and-set', async (t) => {
  const ctx = await setup(t, 'meta');
  const { fake, ds, spend } = ctx;
  const meta = await ctx.makeCred('meta-ads', 'meta_ads', { access_token: META_TOKEN, app_secret: META_APP_SECRET });
  const custom = await ctx.makeCred('meta-as-custom', 'custom', { access_token: META_TOKEN });
  const exposed = await ctx.makeCred('meta-exposed', 'meta_ads', { access_token: META_TOKEN }, { agent_env: true });
  const globalCred = await ctx.credRepo.save(ctx.credRepo.create({ account_id: null, name: 'meta-global', description: '', provider: 'meta_ads', encrypted_data: encrypt(JSON.stringify({ access_token: META_TOKEN })) }));

  const metaPayee = (name, credential_id, ref) => ({ name, provider: 'meta_ads', credential_id, ref });
  // 1. 결제 경로의 credential
  for (const [cred, pattern] of [[custom, /created with the Meta Ads provider/], [exposed, /exposed to agents/], [globalCred, /global credential cannot pay/]]) {
    const r = await ctx.post('/campaigns', { name: 'bad', currency: 'USD', payees: [metaPayee('Meta', cred.id, 'act_9/77')] });
    assert.equal(r.status, 400, r.text);
    assert.match(r.body.error, pattern);
  }
  const { campaign, ask } = await campaignWith(ctx, [
    metaPayee('Meta fall', meta.id, 'act_9/77'),
    metaPayee('Meta uncapped', meta.id, 'act_9/78'),
    metaPayee('Meta second', meta.id, 'act_9 / 79'),
    { name: 'Newsletter', ref: 'inv-1' },
  ]);
  assert.equal(campaign.payees[2].ref, 'act_9/79', 'payee refs are stored canonical');
  assert.equal((await ctx.patch(`/campaigns/${campaign.id}`, { payees: [] }, ['marketing.manage'])).status, 403, 'payees are a money setting');

  // 2. 요청 — 에이전트 payload 거부, 서버가 계획을 만든다(쓰기 없음)
  const withPayload = await ask({ amount_minor: 30000, payee: 'Meta fall', payload: { daily_budget: 99999 } });
  assert.equal(withPayload.isError, true);
  assert.match(errText(withPayload), /omit payload/);
  const r1 = await ask({ amount_minor: 30000, payee: 'Meta fall' });
  assert.equal(r1.isError, undefined, errText(r1));
  const req1 = r1.spend_request;
  assert.equal(req1.status, 'pending');
  assert.equal(req1.provider, 'meta_ads');
  assert.equal(req1.payee_ref, 'act_9/77');
  assert.deepEqual([req1.payload.plan, req1.payload.field, req1.payload.from, req1.payload.to], ['raise_ceiling', 'spend_cap', '100000', '130000']);
  assert.equal(req1.payload.target_name_untrusted, 'Fall promo');
  assert.match(req1.plan_text, /spend_cap\)를 1,000\.00 USD → 1,300\.00 USD 로 올립니다\(\+300\.00 USD\)/);
  assert.equal(fake.state.writes.length, 0, 'planning reads only');
  const dup = await ask({ amount_minor: 10000, payee: 'Meta fall' });
  assert.match(errText(dup), /another spend request for this target is still open \(pending/);

  // 3. 승인 → 다시 읽고 spend_cap 하나만 쓴다
  const approved = await ctx.post(`/spend-requests/${req1.id}/approve`, { payload_sha256: req1.payload_sha256 });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.status, 'paid', approved.text);
  assert.equal(approved.body.provider_ref, 'meta_ads:act_9/77:spend_cap=130000');
  assert.match(approved.body.receipt_url, /^https:\/\/adsmanager\.facebook\.com\/adsmanager\/manage\/campaigns\?act=9&selected_campaign_ids=77$/);
  assert.equal(fake.state.meta.campaigns[77].spend_cap, '130000');
  assert.equal(fake.state.writes.length, 1);
  const write = fake.state.calls.find((c) => c.method === 'POST' && c.host === 'graph.facebook.com');
  assert.equal(write.path, '/v26.0/77');
  assert.equal(write.headers.authorization, `Bearer ${META_TOKEN}`);
  assert.ok(fake.state.calls.every((c) => !c.search.includes(META_TOKEN) && !String(c.body || '').includes(META_TOKEN)), 'the token never rides the URL or the body');
  assert.match(fake.state.writes[0].form.appsecret_proof, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(fake.state.writes[0].form).sort(), ['appsecret_proof', 'spend_cap'], 'one field per write');
  const detail1 = (await ctx.api(`/spend-requests/${req1.id}`)).body;
  assert.deepEqual(detail1.ledger.map((e) => `${e.kind}:${e.amount_minor}`), ['reserve:30000', 'release:30000', 'capture:30000']);

  // 4. 그 사이 사람이 Ads Manager 에서 바꿨다 → 보내지 않고 failed(쓰기 0, 예산 해제)
  const req2 = (await ask({ amount_minor: 20000, payee: 'Meta fall' })).spend_request;
  assert.deepEqual([req2.payload.from, req2.payload.to], ['130000', '150000'], 'the next plan starts from the new cap');
  fake.state.meta.campaigns[77].spend_cap = '140000';
  const changed = await ctx.post(`/spend-requests/${req2.id}/approve`, { payload_sha256: req2.payload_sha256 });
  assert.equal(changed.body.status, 'failed', changed.text);
  assert.match(changed.body.error, /not sent: spend_cap changed since the request \(expected 130000, found 140000\)/);
  assert.equal(fake.state.writes.length, 1, 'nothing was written');

  // 5. 이미 목표값 → unknown(쓰기 0, 보류 유지), 대조 전에는 같은 대상의 새 요청 거부
  const req3 = (await ask({ amount_minor: 10000, payee: 'Meta fall' })).spend_request;
  fake.state.meta.campaigns[77].spend_cap = req3.payload.to;
  const atTarget = await ctx.post(`/spend-requests/${req3.id}/approve`, { payload_sha256: req3.payload_sha256 });
  assert.equal(atTarget.body.status, 'unknown', atTarget.text);
  assert.match(atTarget.body.error, /already 150000 \(the target\)/);
  assert.equal(fake.state.writes.length, 1);
  assert.match(errText(await ask({ amount_minor: 10000, payee: 'Meta fall' })), /still open \(unknown/);
  const inspected = await ctx.post(`/spend-requests/${req3.id}/inspect`);
  assert.equal(inspected.status, 200, inspected.text);
  assert.equal(inspected.body.position, 'at_target');
  assert.equal(inspected.body.observed, '150000');
  assert.equal(fake.state.writes.length, 1, 'inspection reads only');
  assert.equal((await ctx.post(`/spend-requests/${req3.id}/refund`, { amount_minor: 1, note: 'x' })).status, 409, 'not paid');
  assert.equal((await ctx.post(`/spend-requests/${req3.id}/mark-paid`, { provider_ref: atTarget.body.suggested_provider_ref })).body.status, 'paid');
  assert.equal(atTarget.body.suggested_provider_ref, `meta_ads:act_9/77:spend_cap=${req3.payload.to}`);

  // 6. 시간 초과 → unknown, sweep 은 다시 보내지 않는다
  const req4 = (await ask({ amount_minor: 10000, payee: 'Meta fall' })).spend_request;
  fake.state.overrides.push({ match: (c) => c.method === 'POST' && c.host === 'graph.facebook.com', reply: 'timeout' });
  const timedOut = await ctx.post(`/spend-requests/${req4.id}/approve`, { payload_sha256: req4.payload_sha256 });
  assert.equal(timedOut.body.status, 'unknown', timedOut.text);
  assert.match(timedOut.body.error, /did not answer in time after the spend_cap change was sent/);
  const postsBefore = fake.state.calls.filter((c) => c.method === 'POST').length;
  await spend.sweep(new Date(Date.now() + 60 * 60_000));
  assert.equal(fake.state.calls.filter((c) => c.method === 'POST').length, postsBefore, 'unknown is never re-sent');
  const early = await ctx.post(`/spend-requests/${req4.id}/mark-failed`, { note: 'Ads Manager shows the old cap' });
  assert.equal(early.status, 409, 'a ceiling change can still show up — no failure within 15 minutes of executing');
  assert.match(early.body.error, /can take up to 15 minutes to show on Meta Ads — record a failure after \d{4}-/);
  assert.equal((await ctx.api(`/spend-requests/${req4.id}`)).body.status, 'unknown');
  await pastFailGrace(ctx, req4.id);
  assert.equal((await ctx.post(`/spend-requests/${req4.id}/mark-failed`, { note: 'Ads Manager shows the old cap' })).body.status, 'failed');

  // 7. 거절 → failed. 거절이라던 쓰기가 실제로는 반영됐으면 unknown(안전망)
  const req5 = (await ask({ amount_minor: 10000, payee: 'Meta fall' })).spend_request;
  fake.state.overrides.push({ match: (c) => c.method === 'POST', reply: { status: 400, body: { error: { message: `Invalid parameter (token ${META_TOKEN})`, code: 100, error_subcode: 1885272, fbtrace_id: 'Abc' } } } });
  const refused = await ctx.post(`/spend-requests/${req5.id}/approve`, { payload_sha256: req5.payload_sha256 });
  assert.equal(refused.body.status, 'failed', refused.text);
  assert.equal(refused.body.error, 'Meta refused the spend_cap change (HTTP 400, code 100/1885272)', 'status and codes only — this reaches the agent');
  assert.equal(refused.body.provider_response.message_untrusted, 'Invalid parameter (token [redacted])', 'provider text is kept apart, scrubbed');
  assert.equal(refused.body.provider_response.fbtrace_id, 'Abc');
  const refusedForAgent = await ctx.mcp.callTool('get_marketing_spend_request', { spend_request_id: req5.id });
  assert.equal(refusedForAgent.error, 'Meta refused the spend_cap change (HTTP 400, code 100/1885272)');
  const req6 = (await ask({ amount_minor: 10000, payee: 'Meta fall' })).spend_request;
  fake.state.overrides.push({
    match: (c) => c.method === 'POST',
    reply: (entry, { u, metaPost }) => { metaPost(u, entry.body); return json(400, { error: { message: 'Invalid parameter', code: 100 } }); },
  });
  const halfApplied = await ctx.post(`/spend-requests/${req6.id}/approve`, { payload_sha256: req6.payload_sha256 });
  assert.equal(halfApplied.body.status, 'unknown', halfApplied.text);
  assert.match(halfApplied.body.error, /refused the change .* but the spend_cap now reads/);
  await ctx.post(`/spend-requests/${req6.id}/mark-paid`, { provider_ref: halfApplied.body.suggested_provider_ref });

  // 8. 한도 없는 캠페인 → 저장하지 않고 거부(감사), 그 대상은 잠시 다시 묻지 않는다
  const readsBefore = fake.state.calls.length;
  const uncapped = await ask({ amount_minor: 20000, payee: 'Meta uncapped' });
  assert.match(errText(uncapped), /no spend cap — a person sets the first cap/);
  assert.match(errText(uncapped), /do not retry/);
  const afterFirst = fake.state.calls.length;
  assert.ok(afterFirst > readsBefore);
  const again = await ask({ amount_minor: 20000, payee: 'Meta uncapped' });
  assert.match(errText(again), /not asking Meta Ads again before/);
  assert.equal(fake.state.calls.length, afterFirst, 'backoff: no provider call');
  assert.equal(await ds.getRepository('MarketingSpendRequest').countBy({ campaign_id: campaign.id, payee: 'Meta uncapped' }), 0);
  const audit = (await ctx.api(`/campaigns/${campaign.id}/audit?limit=500`)).body;
  assert.ok(audit.some((e) => e.action === 'spend.refused' && /Meta Ads 확인/.test(e.summary)), 'refusal is audited');

  // 9. 수취인을 다른 대상으로 돌렸으면 예전 요청은 승인되지 않는다
  const req7 = (await ask({ amount_minor: 10000, payee: 'Meta second' })).spend_request;
  const payees = campaign.payees.map((p) => (p.name === 'Meta second' ? { ...p, ref: 'act_9/80' } : p));
  const repoint = await ctx.patch(`/campaigns/${campaign.id}`, { payees });
  assert.equal(repoint.status, 200, repoint.text);
  const stale = await ctx.post(`/spend-requests/${req7.id}/approve`, { payload_sha256: req7.payload_sha256 });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /different payment method, credential or target/);
  await ctx.post(`/spend-requests/${req7.id}/deny`, { note: 'repointed' });
  assert.equal((await ctx.patch(`/campaigns/${campaign.id}`, { payees: campaign.payees })).status, 200);

  // 10. credential 내용이 바뀌었으면(지문) 승인 · 실행하지 않는다. 같은 내용으로 다시 저장한 것(새 IV)은 그대로 실행된다.
  const req8 = (await ask({ amount_minor: 10000, payee: 'Meta second' })).spend_request;
  await ctx.credRepo.update(meta.id, { encrypted_data: encrypt(JSON.stringify({ app_secret: META_APP_SECRET, access_token: META_TOKEN })) });
  const resaved = await ctx.post(`/spend-requests/${req8.id}/approve`, { payload_sha256: req8.payload_sha256 });
  assert.equal(resaved.status, 200, resaved.text);
  assert.equal(resaved.body.status, 'paid', 'same content re-encrypted — same fingerprint');
  const req8b = (await ask({ amount_minor: 10000, payee: 'Meta second' })).spend_request;
  await ctx.credRepo.update(meta.id, { encrypted_data: encrypt(JSON.stringify({ access_token: META_TOKEN_ROTATED, app_secret: META_APP_SECRET })) });
  const swapped = await ctx.post(`/spend-requests/${req8b.id}/approve`, { payload_sha256: req8b.payload_sha256 });
  assert.equal(swapped.status, 409);
  assert.match(swapped.body.error, /credential changed since this request/);
  await ctx.post(`/spend-requests/${req8b.id}/deny`, { note: 'credential rotated' });

  // 11. 한 시간 넘은 승인은 실행하지 않는다(승인 직후 죽어 approved 로 남은 것)
  const req9 = (await ask({ amount_minor: 10000, payee: 'Meta second' })).spend_request;
  const realExecute = spend.execute;
  spend.execute = async (id) => spend.get(id, ctx.account.id);
  assert.equal((await ctx.post(`/spend-requests/${req9.id}/approve`, { payload_sha256: req9.payload_sha256 })).body.status, 'approved');
  spend.execute = realExecute;
  await ds.getRepository('MarketingSpendRequest').update({ id: req9.id }, { decided_at: new Date(Date.now() - 2 * 60 * 60_000) });
  const writesBefore = fake.state.writes.length;
  await spend.sweep(new Date());
  const old = (await ctx.api(`/spend-requests/${req9.id}`)).body;
  assert.equal(old.status, 'failed');
  assert.match(old.error, /approved more than an hour ago/);
  assert.equal(fake.state.writes.length, writesBefore);

  // 12. 보낸 뒤의 예외 → unknown, 보내기 전의 실패 → failed
  const adapter = DIRECT_PAYMENT_ADAPTERS.meta_ads;
  const realAdapterExecute = adapter.execute;
  try {
    adapter.execute = async () => { throw new TypeError("Cannot read properties of undefined (reading 'success')"); };
    const req10 = (await ask({ amount_minor: 10000, payee: 'Meta second' })).spend_request;
    const crashed = await ctx.post(`/spend-requests/${req10.id}/approve`, { payload_sha256: req10.payload_sha256 });
    assert.equal(crashed.body.status, 'unknown', 'an exception after sending keeps the money held');
    assert.match(crashed.body.error, /may already have been sent/);
    await pastFailGrace(ctx, req10.id);
    assert.equal((await ctx.post(`/spend-requests/${req10.id}/mark-failed`, { note: 'checked' })).body.status, 'failed');
    adapter.execute = async () => { throw new PaymentNotSentError('token expired before sending'); };
    const req11 = (await ask({ amount_minor: 10000, payee: 'Meta second' })).spend_request;
    const notSent = await ctx.post(`/spend-requests/${req11.id}/approve`, { payload_sha256: req11.payload_sha256 });
    assert.equal(notSent.body.status, 'failed');
    assert.match(notSent.body.error, /not sent: token expired before sending/);
  } finally {
    adapter.execute = realAdapterExecute;
  }

  // 13. 다른 서버가 실행 중에 unknown 으로 돌렸다 → 확정 결과가 그 unknown 을 닫는다
  const req12 = (await ask({ amount_minor: 10000, payee: 'Meta second' })).spend_request;
  fake.state.overrides.push({
    match: (c) => c.method === 'POST',
    reply: async (entry, { u, metaPost }) => {
      await ds.getRepository('MarketingSpendRequest').update({ id: req12.id }, { status: 'unknown', error: 'the server restarted while this payment was being sent' });
      return metaPost(u, entry.body);
    },
  });
  const late = await ctx.post(`/spend-requests/${req12.id}/approve`, { payload_sha256: req12.payload_sha256 });
  assert.equal(late.body.status, 'paid', late.text);
  const lateDetail = (await ctx.api(`/spend-requests/${req12.id}`)).body;
  assert.deepEqual(lateDetail.ledger.map((e) => e.kind), ['reserve', 'release', 'capture']);

  // 14. 상한 공급자의 환불은 막는다
  const refund = await ctx.post(`/spend-requests/${req1.id}/refund`, { amount_minor: 1000, note: 'unused' });
  assert.equal(refund.status, 409);
  assert.match(refund.body.error, /ceiling to be lowered first/);

  // 15. 연결 확인 — 읽기만, approve_spend 만, 감사
  assert.equal((await ctx.post(`/campaigns/${campaign.id}/payment/check`, {}, ['marketing.manage'])).status, 403);
  const writesBeforeCheck = fake.state.writes.length;
  const check = await ctx.post(`/campaigns/${campaign.id}/payment/check`);
  assert.equal(check.status, 200, check.text);
  const byName = Object.fromEntries(check.body.payees.map((p) => [p.payee, p]));
  assert.deepEqual(Object.keys(byName).sort(), ['Meta fall', 'Meta second', 'Meta uncapped'], 'only direct-route payees');
  assert.equal(byName['Meta fall'].ok, true);
  assert.equal(byName['Meta fall'].ceiling_units, fake.state.meta.campaigns[77].spend_cap);
  assert.equal(byName['Meta fall'].api_version, 'v26.0');
  assert.equal(byName['Meta uncapped'].ok, false);
  assert.match(byName['Meta uncapped'].problems.join(' '), /no spend cap/);
  assert.equal(fake.state.writes.length, writesBeforeCheck, 'the check never writes');
  assert.ok((await ctx.api(`/campaigns/${campaign.id}/audit?limit=500`)).body.some((e) => e.action === 'payment.checked'));

  // 17. 같은 순간에 같은 대상의 요청이 열려 유일 인덱스에 걸리면(다시 볼 때는 이미 닫혔다) — DB 문구가 아니라 설명으로 거부한다
  const spendRows = spend.spendRepo;
  spendRows.save = async () => {
    delete spendRows.save;
    throw Object.assign(new Error('UNIQUE constraint failed: marketing_spend_requests.target_key'), { code: 'SQLITE_CONSTRAINT' });
  };
  try {
    const raced = await ask({ amount_minor: 10000, payee: 'Meta fall' });
    assert.equal(raced.isError, true);
    assert.match(errText(raced), /another spend request for this ad campaign was opened at the same moment/);
    assert.doesNotMatch(errText(raced), /UNIQUE constraint/);
  } finally {
    delete spendRows.save;
  }

  // 18. 다른 계정의 열린 요청 — 이 계정의 credential 로 그 대상을 읽을 수 있을 때만, id · 상태 없이 알린다
  const openHere = (await ask({ amount_minor: 10000, payee: 'Meta fall' })).spend_request;
  assert.equal(openHere.status, 'pending');
  const other = await ctx.tenant('meta-other');
  const otherCred = await other.makeCred('meta-other', 'meta_ads', { access_token: META_TOKEN_OTHER });
  const { campaign: otherCampaign, ask: otherAsk } = await campaignWith({ ...ctx, ...other }, [
    { name: 'Same ad campaign', provider: 'meta_ads', credential_id: otherCred.id, ref: 'act_9/77' },
  ]);
  const blocked = await otherAsk({ amount_minor: 10000, payee: 'Same ad campaign' });
  assert.equal(blocked.isError, true);
  assert.match(errText(blocked), /this ad campaign already has an open spend request in another account/);
  assert.equal(errText(blocked).includes(openHere.id), false, 'no id from another account');
  assert.doesNotMatch(errText(blocked), /pending/, 'no state from another account');
  const otherCheck = await other.post(`/campaigns/${otherCampaign.id}/payment/check`);
  assert.equal(otherCheck.status, 200, otherCheck.text);
  assert.deepEqual(otherCheck.body.payees[0].open_request, { id: '', status: 'other_account' });
  fake.state.overrides.push({
    match: (c) => c.host === 'graph.facebook.com' && c.headers.authorization === `Bearer ${META_TOKEN_OTHER}`,
    reply: { status: 400, body: { error: { message: 'Unsupported get request', code: 100, error_subcode: 33 } } },
  });
  const unreadable = await otherAsk({ amount_minor: 20000, payee: 'Same ad campaign' });
  assert.match(errText(unreadable), /could not read Meta 77 \(HTTP 400, code 100\/33\)/);
  assert.doesNotMatch(errText(unreadable), /another account/, 'a credential that cannot read the target learns nothing about it');
  assert.equal((await ctx.post(`/spend-requests/${openHere.id}/deny`, { note: 'cross-account check done' })).body.status, 'denied');

  // 19. 재시작 정리(executing → unknown)는 캠페인 잠금 뒤에 선다 — 다른 서버가 잠금 안에서 기록하던 결과를 덮어쓰지 않는다
  const req13 = (await ask({ amount_minor: 10000, payee: 'Meta second' })).spend_request;
  const executeNow = spend.execute;
  spend.execute = async (id) => spend.get(id, ctx.account.id);
  assert.equal((await ctx.post(`/spend-requests/${req13.id}/approve`, { payload_sha256: req13.payload_sha256 })).body.status, 'approved');
  spend.execute = executeNow;
  const spendRepo = ds.getRepository('MarketingSpendRequest');
  await spendRepo.update({ id: req13.id }, { status: 'executing', executing_at: new Date(Date.now() - 60_000) });
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const settling = ds.transaction(async (manager) => {
    await lockCampaign(manager, campaign.id);
    entered();
    await gate;
    const won = await manager.getRepository('MarketingSpendRequest').createQueryBuilder().update()
      .set({ status: 'failed', error: 'recorded by the executing server' })
      .where('id = :id AND status = :s', { id: req13.id, s: 'executing' })
      .execute();
    return won.affected;
  });
  await inside;
  const interrupted = spend.recoverInterrupted(new Date());
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  assert.equal(await settling, 1, 'the result recorded under the campaign lock is not overwritten');
  assert.equal(await interrupted, 0, 'the restart sweep waited for the lock and found the request settled');
  assert.equal((await spendRepo.findOneBy({ id: req13.id })).status, 'failed');

  // 16. MCP 읽기에도 계획 문장 · 직접 수취인 규칙이 실린다. 비밀 값은 어디에도 없다.
  const overview = await ctx.mcp.callTool('get_marketing_campaign', { campaign_id: campaign.id });
  assert.ok(overview.rules.some((r) => /Meta Ads · Google Ads 수취인은 그 광고 캠페인의 지출 상한/.test(r)), 'the agent is told what a direct payee does');
  assert.equal(overview.campaign.payees.find((p) => p.name === 'Meta fall').provider, 'meta_ads');
  const tools = await ctx.mcp.listTools();
  const spendTool = (Array.isArray(tools) ? tools : tools?.tools || []).find((x) => x.name === 'request_marketing_spend');
  assert.match(spendTool.description, /omit payload/);
  const mcpView = await ctx.mcp.callTool('get_marketing_spend_request', { spend_request_id: req1.id });
  assert.equal(mcpView.status, 'paid');
  assert.match(mcpView.plan_text, /Meta 광고 계정 act_9 의 캠페인 77/);
  const rows = await ds.getRepository('MarketingSpendRequest').findBy({ campaign_id: campaign.id });
  const events = await ds.getRepository('MarketingAuditEvent').findBy({ campaign_id: campaign.id });
  const haystack = JSON.stringify([rows, events, ctx.responses, mcpView, r1, overview]);
  for (const marker of MARKERS) assert.equal(haystack.includes(marker), false, `secret ${marker.slice(0, 8)}… leaked`);
});

test('Google Ads: only a non-shared total budget is raised; the value must come back from the mutate', async (t) => {
  const ctx = await setup(t, 'google');
  const { fake, ds } = ctx;
  const google = await ctx.makeCred('google-ads', 'google_ads', {
    client_id: '123.apps.googleusercontent.com', client_secret: GOOGLE_CLIENT_SECRET, refresh_token: GOOGLE_REFRESH, login_customer_id: '999-888-7777',
  });
  const incomplete = await ctx.makeCred('google-incomplete', 'google_ads', { client_id: 'x' });
  const bad = await ctx.post('/campaigns', { name: 'bad', currency: 'USD', payees: [{ name: 'G', provider: 'google_ads', credential_id: incomplete.id, ref: '111-222-3333/5' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /"client_secret", "refresh_token"/);
  const { campaign, ask } = await campaignWith(ctx, [
    { name: 'Google total', provider: 'google_ads', credential_id: google.id, ref: '111-222-3333/5' },
    { name: 'Google daily', provider: 'google_ads', credential_id: google.id, ref: '1112223333/6' },
  ]);

  // 일 예산 캠페인은 거부(저장 안 함)
  const daily = await ask({ amount_minor: 10000, payee: 'Google daily' });
  assert.match(errText(daily), /uses a daily budget — only a campaign total budget \(CUSTOM_PERIOD\) is a hard cap/);
  assert.equal(await ds.getRepository('MarketingSpendRequest').countBy({ campaign_id: campaign.id, payee: 'Google daily' }), 0);

  // 계획 → 승인 → MUTABLE_RESOURCE 로 쓰고 돌아온 값으로 확정
  const r1 = await ask({ amount_minor: 25000, payee: 'Google total' });
  assert.equal(r1.isError, undefined, errText(r1));
  const req1 = r1.spend_request;
  assert.deepEqual([req1.payload.field, req1.payload.from, req1.payload.to, req1.payload.test_account], ['total_amount_micros', '1000000000', '1250000000', false]);
  assert.equal(req1.payload.target.budget, 'customers/1112223333/campaignBudgets/8');
  assert.match(req1.plan_text, /Google Ads 고객 1112223333 의 캠페인 5 총예산을 1,000\.00 USD → 1,250\.00 USD 로 올립니다/);
  const paid = await ctx.post(`/spend-requests/${req1.id}/approve`, { payload_sha256: req1.payload_sha256 });
  assert.equal(paid.body.status, 'paid', paid.text);
  assert.match(paid.body.provider_ref, /^google_ads:customers\/1112223333\/campaignBudgets\/8:total_amount_micros=1250000000/);
  const mutate = fake.state.writes.at(-1).request;
  assert.deepEqual(mutate.operations, [{ update: { resourceName: 'customers/1112223333/campaignBudgets/8', totalAmountMicros: '1250000000' }, updateMask: 'totalAmountMicros' }]);
  assert.equal(mutate.partialFailure, false);
  assert.equal(mutate.responseContentType, 'MUTABLE_RESOURCE');
  const mutateCall = fake.state.calls.find((c) => c.path.endsWith('campaignBudgets:mutate'));
  assert.equal(mutateCall.path, '/v26/customers/1112223333/campaignBudgets:mutate');
  assert.equal(mutateCall.headers.authorization, `Bearer ${GOOGLE_ACCESS}`);
  assert.equal(mutateCall.headers['login-customer-id'], '9998887777');
  assert.equal('developer-token' in mutateCall.headers, false, 'developer tokens are retired — not sent unless configured');
  assert.equal(fake.state.tokenRequests, 1, 'the access token is cached across plan and execution');

  // 이름만 돌아오면(값 확인 불가) unknown
  const req2 = (await ask({ amount_minor: 10000, payee: 'Google total' })).spend_request;
  fake.state.overrides.push({
    match: (c) => c.path.endsWith('campaignBudgets:mutate'),
    reply: (entry, { u, googleMutate }) => { googleMutate(u, entry.body); return json(200, { results: [{ resourceName: 'customers/1112223333/campaignBudgets/8' }] }); },
  });
  const nameOnly = await ctx.post(`/spend-requests/${req2.id}/approve`, { payload_sha256: req2.payload_sha256 });
  assert.equal(nameOnly.body.status, 'unknown', nameOnly.text);
  const inspected = await ctx.post(`/spend-requests/${req2.id}/inspect`);
  assert.equal(inspected.body.position, 'at_target');
  // 사람만 부르는 확인은 공급자가 준 글도 보여 준다(에이전트에게 가는 오류 문장에는 없다)
  fake.state.overrides.push({
    match: (c) => c.path.endsWith('googleAds:search'),
    reply: { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } },
  });
  const forbidden = await ctx.post(`/spend-requests/${req2.id}/inspect`);
  assert.equal(forbidden.status, 409, forbidden.text);
  assert.equal(forbidden.body.error, 'could not read Google Ads customer 1112223333 (HTTP 403 PERMISSION_DENIED) — provider says (untrusted): The caller does not have permission');
  await ctx.post(`/spend-requests/${req2.id}/mark-paid`, { provider_ref: nameOnly.body.suggested_provider_ref });

  // 동시 수정(409 + GoogleAdsFailure) → failed, 503 → unknown
  const req3 = (await ask({ amount_minor: 10000, payee: 'Google total' })).spend_request;
  fake.state.overrides.push({
    match: (c) => c.path.endsWith('campaignBudgets:mutate'),
    reply: { status: 409, body: { error: { code: 409, status: 'ABORTED', message: 'Multiple requests were attempting to modify the same resource at once.', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure', errors: [{ errorCode: { databaseError: 'CONCURRENT_MODIFICATION' }, message: 'Retry the request.' }] }] } } },
  });
  const concurrent = await ctx.post(`/spend-requests/${req3.id}/approve`, { payload_sha256: req3.payload_sha256 });
  assert.equal(concurrent.body.status, 'failed', concurrent.text);
  assert.match(concurrent.body.error, /HTTP 409 ABORTED \(databaseError=CONCURRENT_MODIFICATION\)/);
  const req4 = (await ask({ amount_minor: 10000, payee: 'Google total' })).spend_request;
  fake.state.overrides.push({ match: (c) => c.path.endsWith('campaignBudgets:mutate'), reply: { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'try again' } } } });
  const unavailable = await ctx.post(`/spend-requests/${req4.id}/approve`, { payload_sha256: req4.payload_sha256 });
  assert.equal(unavailable.body.status, 'unknown');
  assert.equal(unavailable.body.error, 'Google Ads answered HTTP 503 UNAVAILABLE — the budget change may or may not have been applied');
  assert.equal(unavailable.body.provider_response.message_untrusted, 'try again');
  assert.equal((await ctx.post(`/spend-requests/${req4.id}/mark-failed`, { note: 'too early' })).status, 409);
  await pastFailGrace(ctx, req4.id);
  assert.equal((await ctx.post(`/spend-requests/${req4.id}/mark-failed`, { note: 'change history shows nothing' })).body.status, 'failed');

  // 토큰 갱신 실패(실행 때) → 보내지 않고 failed, 쓰기 없음
  const req5 = (await ask({ amount_minor: 10000, payee: 'Google total' })).spend_request;
  resetGoogleTokenCache();
  fake.state.overrides.push({ match: (c) => c.host === 'oauth2.googleapis.com', reply: { status: 400, body: { error: 'invalid_grant', error_description: `Token has been expired or revoked (${GOOGLE_REFRESH})` } } });
  const writesBefore = fake.state.writes.length;
  const tokenFail = await ctx.post(`/spend-requests/${req5.id}/approve`, { payload_sha256: req5.payload_sha256 });
  assert.equal(tokenFail.body.status, 'failed', tokenFail.text);
  assert.match(tokenFail.body.error, /^not sent: Google refused the OAuth refresh \(HTTP 400, invalid_grant\) — the refresh token was revoked or expired .*issue a new one$/);
  assert.match(tokenFail.body.provider_response.message_untrusted, /^Token has been expired or revoked \(\[redacted\]\)$/);
  assert.equal(tokenFail.body.provider_response.sent, false);
  assert.equal(fake.state.writes.length, writesBefore);

  // 테스트 계정 ↔ 운영 계정이 바뀌면 보내지 않는다
  const req6 = (await ask({ amount_minor: 10000, payee: 'Google total' })).spend_request;
  fake.state.google.customers[1112223333].testAccount = true;
  const switched = await ctx.post(`/spend-requests/${req6.id}/approve`, { payload_sha256: req6.payload_sha256 });
  assert.equal(switched.body.status, 'failed');
  assert.match(switched.body.error, /switched between test and production/);
  fake.state.google.customers[1112223333].testAccount = false;

  // 연결 확인 — 401 을 받은 access token 은 캐시에서 지운다(남겨 두면 만료까지 같은 401 이 이어진다)
  const tokensBefore = fake.state.tokenRequests;
  fake.state.overrides.push({
    match: (c) => c.path.endsWith('googleAds:search'),
    reply: { status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } } },
  });
  const denied = await ctx.post(`/campaigns/${campaign.id}/payment/check`);
  assert.equal(denied.status, 200, denied.text);
  const deniedTotal = denied.body.payees.find((p) => p.payee === 'Google total');
  assert.equal(deniedTotal.ok, false);
  assert.match(deniedTotal.problems.join(' '), /HTTP 401 UNAUTHENTICATED/);
  assert.doesNotMatch(deniedTotal.problems.join(' '), /invalid authentication credentials/, 'provider text stays out of the message');
  assert.equal(deniedTotal.provider_message_untrusted, 'Request had invalid authentication credentials.', 'the person checking sees why');
  assert.equal(fake.state.tokenRequests, tokensBefore + 1, 'the next read fetched a new token instead of reusing the rejected one');

  const check = await ctx.post(`/campaigns/${campaign.id}/payment/check`);
  assert.equal(check.status, 200, check.text);
  const byName = Object.fromEntries(check.body.payees.map((p) => [p.payee, p]));
  assert.equal(byName['Google total'].ok, true, JSON.stringify(byName['Google total']));
  assert.equal(byName['Google total'].ceiling_text, '1,350.00 USD');
  assert.equal(byName['Google daily'].ok, false);

  const rows = await ds.getRepository('MarketingSpendRequest').findBy({ campaign_id: campaign.id });
  const events = await ds.getRepository('MarketingAuditEvent').findBy({ campaign_id: campaign.id });
  const haystack = JSON.stringify([rows, events, ctx.responses]);
  for (const marker of MARKERS) assert.equal(haystack.includes(marker), false, `secret ${marker.slice(0, 8)}… leaked`);
});
