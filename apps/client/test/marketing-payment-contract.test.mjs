// 직접 결제 어댑터(docs/marketing.md "직접 결제 어댑터")의 화면 규칙과 서버 정본(apps/server/src/common/marketing/payment-routes.ts)의
// 대조, 그리고 화면 쪽 순수 판정.
//
// 고정하는 것:
//   1. 공급자 목록 · ref 형식 문구 · credential 필드가 서버와 같다. Credentials 화면의 전용 입력 칸(meta_ads · google_ads)도 그
//      필드 그대로이고, 에이전트 노출을 고를 수 없다.
//   2. ref 형식 판정이 서버 파서와 같은 답을 낸다(같은 표본).
//   3. credential 후보는 그 공급자로 만든 이 계정의 것만(전역 · 다른 종류 · 에이전트 노출 제외).
//   4. 상한 공급자의 paid 는 "한도 반영됨", 환불 기록 불가. 승인 · 대조 안내는 공급자마다 다르다. 공급자 확인 한 줄.
//   5. 결과 불명의 실패 기록 유예(DIRECT_FAIL_GRACE_MS)가 서버와 같고, 대조 안내가 그 시각을 알린다. 다른 계정의 열린 요청은 id 없이 표시한다.
//   6. Stripe Issuing(카드): 공급자 명세 · 일회용 최대 · 업종 정규화가 서버와 같고, 카드 상태 · 승인 · 대조 · 확인 문장이 카드에 맞다.
//   7. credential 발급 안내가 모든 직접 공급자에 있고, 칸 목록이 credential 필드와 같고, 링크는 공식 문서(https)다.
//
// 실행: node --import tsx --test test/marketing-payment-contract.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DIRECT_FAIL_GRACE_MS, DIRECT_PAYMENT_PROVIDERS, DIRECT_PAYMENT_PROVIDER_LABELS, DIRECT_REF_FORMATS, DIRECT_PROVIDER_CREDENTIAL_FIELDS, PAYMENT_PROVIDER_LABELS,
  DIRECT_PROVIDER_SPECS, STRIPE_SINGLE_USE_MAX_MINOR, directCredentialFieldsHint,
  canRecordRefund, cardControlsLabel, cardLimitWarning, directPaymentCredentials, directRefProblem, directRouteOptionLabel, formatDateTime,
  inspectionCardRef, inspectionSummary, isDirectPaymentProvider, openRequestLabel, parseCardCategories,
  payeeRouteLabel, spendApproveHint, spendStatusViewFor, unknownReconcileHint,
} from '../src/components/marketing/marketing.logic.ts';
import { PAYMENT_CREDENTIAL_GUIDES } from '../src/components/marketing/paymentCredentialGuides.ts';
import { AGENT_ENV_PROVIDERS } from '../src/components/admin/credentialAgentEnv.logic.ts';

const SERVER_RULES = new URL('../../server/src/common/marketing/payment-routes.ts', import.meta.url);
const CREDENTIAL_MANAGER = new URL('../src/components/admin/CredentialManager.tsx', import.meta.url);

test('the screen mirrors the server: providers, ref formats, credential fields', async () => {
  const server = await import(SERVER_RULES.href);
  assert.deepEqual([...DIRECT_PAYMENT_PROVIDERS], [...server.DIRECT_PAYMENT_PROVIDERS]);
  assert.deepEqual(DIRECT_PAYMENT_PROVIDER_LABELS, server.DIRECT_PAYMENT_PROVIDER_LABELS);
  assert.deepEqual(DIRECT_REF_FORMATS, server.DIRECT_REF_FORMATS);
  assert.deepEqual(JSON.parse(JSON.stringify(DIRECT_PROVIDER_CREDENTIAL_FIELDS)), JSON.parse(JSON.stringify(server.DIRECT_PROVIDER_CREDENTIAL_FIELDS)));
  assert.equal(DIRECT_FAIL_GRACE_MS, server.DIRECT_FAIL_GRACE_MS, 'the reconcile hint tells the same wait the server enforces');
  assert.deepEqual(JSON.parse(JSON.stringify(DIRECT_PROVIDER_SPECS)), JSON.parse(JSON.stringify(server.DIRECT_PROVIDER_SPECS)));
  assert.equal(STRIPE_SINGLE_USE_MAX_MINOR, server.STRIPE_SINGLE_USE_MAX_MINOR);
  for (const input of ['', 'advertising_services', ' Software , advertising_services,software', 'a b', 'x', 'ok_1,bad-name']) {
    let serverOut;
    try { serverOut = server.normalizeCardCategories(input); } catch { serverOut = null; }
    const client = parseCardCategories(input);
    assert.deepEqual(client.problem ? null : client.categories, serverOut, `categories ${JSON.stringify(input)}`);
  }
  for (const p of DIRECT_PAYMENT_PROVIDERS) assert.ok(PAYMENT_PROVIDER_LABELS[p], `label for ${p}`);

  // 같은 표본에 서버 파서와 같은 답
  const samples = {
    meta_ads: ['act_123/456', ' act_123 / 456 ', '123/456', 'act_12a/4', 'act_1', 'act_1/2/3', ''],
    google_ads: ['123-456-7890/99', '1234567890/99', '123456789/9', '12345678901/9', 'abc/9', '1234567890'],
    stripe_issuing: ['ich_1MsKAB2eZvKYlo2C', ' ich_abc ', 'ic_123', 'ich_', 'ich_1-2', 'cus_1', ''],
  };
  for (const [provider, refs] of Object.entries(samples)) {
    for (const ref of refs) {
      let serverOk = true;
      try { server.canonicalDirectRef(provider, ref); } catch { serverOk = false; }
      assert.equal(directRefProblem(provider, ref) === '', serverOk, `${provider} ${JSON.stringify(ref)}`);
    }
  }
});

test('the Credentials screen has typed, server-only entries for the payment providers', () => {
  const source = fs.readFileSync(CREDENTIAL_MANAGER, 'utf8');
  for (const provider of DIRECT_PAYMENT_PROVIDERS) {
    const start = source.indexOf(`value: '${provider}'`);
    assert.ok(start > 0, `CredentialManager offers ${provider}`);
    const block = source.slice(start, source.indexOf('},\n  },', start));
    const fields = [...block.matchAll(/^\s{6}([a-z_]+): \{ label:/gm)].map((m) => m[1]);
    const expected = [...DIRECT_PROVIDER_CREDENTIAL_FIELDS[provider].required, ...DIRECT_PROVIDER_CREDENTIAL_FIELDS[provider].optional];
    assert.deepEqual(fields, expected, `${provider} fields`);
    assert.equal(AGENT_ENV_PROVIDERS.has(provider), false, `${provider} can never be exposed to agents`);
  }
});

test('credential candidates: this account, this provider, never global or agent-exposed', () => {
  const cred = (id, over = {}) => ({ id, name: id, provider: 'meta_ads', account_id: 'acc-1', agent_env: false, ...over });
  const all = [
    cred('ok'),
    cred('global', { account_id: null }),
    cred('other-account', { account_id: 'acc-2' }),
    cred('exposed', { agent_env: true }),
    cred('custom', { provider: 'custom' }),
    cred('google', { provider: 'google_ads' }),
  ];
  assert.deepEqual(directPaymentCredentials(all, 'meta_ads', 'acc-1').map((c) => c.id), ['ok']);
  assert.deepEqual(directPaymentCredentials(all, 'google_ads', 'acc-1').map((c) => c.id), ['google']);
});

test('ceiling providers read differently: status, refund, approval and reconcile hints, inspection', () => {
  assert.equal(isDirectPaymentProvider('meta_ads'), true);
  assert.equal(isDirectPaymentProvider('webhook'), false);
  assert.equal(payeeRouteLabel({ name: 'M', provider: 'meta_ads', credential_id: 'c', ref: 'act_9/77' }), 'Meta Ads · act_9/77');
  assert.equal(payeeRouteLabel({ name: 'N', ref: 'inv' }), '');
  assert.equal(spendStatusViewFor({ status: 'paid', provider: 'meta_ads' }).label, '한도 반영됨');
  assert.equal(spendStatusViewFor({ status: 'paid', provider: 'manual' }).label, '결제 완료');
  assert.equal(spendStatusViewFor({ status: 'unknown', provider: 'google_ads' }).label, '결과 불명 — 확인 필요');
  assert.equal(canRecordRefund({ status: 'paid', provider: 'manual' }), true);
  assert.equal(canRecordRefund({ status: 'paid', provider: 'google_ads' }), false, 'lowering the ceiling comes first');
  assert.match(spendApproveHint({ provider: 'meta_ads' }), /spend_cap/);
  assert.match(spendApproveHint({ provider: 'google_ads' }), /총예산/);
  assert.match(spendApproveHint({ provider: 'webhook' }), /결제 엔드포인트/);
  assert.match(spendApproveHint({ provider: 'manual' }), /AWB 밖에서 결제한 뒤/);
  const metaHint = unknownReconcileHint({ provider: 'meta_ads', currency: 'USD', payload: { target: { campaign_id: '77' }, from: '100000', to: '130000', from_minor: 100000, to_minor: 130000 } });
  assert.match(metaHint, /캠페인 77 의 지출 한도가 1,300\.00 USD\(목표\)인지 1,000\.00 USD\(이전\)인지/, 'currency, not provider units');
  assert.match(metaHint, /실행 뒤 15분이 지나야 실패로 기록할 수 있습니다/);
  const executingAt = '2026-10-22T06:00:00.000Z';
  const timed = unknownReconcileHint({ provider: 'meta_ads', currency: 'USD', executing_at: executingAt, payload: { target: { campaign_id: '77' }, from_minor: 100000, to_minor: 130000 } });
  const failAt = formatDateTime(new Date(Date.parse(executingAt) + DIRECT_FAIL_GRACE_MS).toISOString());
  assert.ok(timed.includes(`실행 뒤 15분(${failAt})이 지나야 실패로 기록할 수 있습니다`), timed);
  assert.match(unknownReconcileHint({ provider: 'google_ads', currency: 'KRW', payload: { target: { campaign_id: '5' }, from_minor: 500000, to_minor: 700000 } }), /총예산이 700,000 KRW\(목표\)인지/);
  assert.match(unknownReconcileHint({ provider: 'webhook', currency: 'USD', payload: {} }), /결제 시스템에서/);
  assert.equal(openRequestLabel(null), '');
  assert.equal(openRequestLabel({ id: 'sp-1', status: 'pending' }), '열린 요청 pending');
  assert.equal(openRequestLabel({ id: '', status: 'other_account' }), '다른 계정에 열린 요청 있음', 'no id or state from another account');
  const insp = { from_minor: 100000, to_minor: 130000, observed: '130000', observed_minor: 130000, position: 'at_target' };
  assert.equal(inspectionSummary(insp, 'USD'), '지금 상한 1,300.00 USD: 목표값입니다 — 반영된 것으로 보입니다. (1,000.00 USD → 1,300.00 USD 계획)');
  assert.match(inspectionSummary({ ...insp, observed: '100000', observed_minor: 100000, position: 'at_from' }, 'USD'), /반영되지 않은 것으로/);
  assert.match(inspectionSummary({ ...insp, observed: null, observed_minor: null, position: 'no_ceiling' }, 'USD'), /^지금 상한 한도 없음: 한도가 없습니다/);
});

test('in-app credential guides cover every direct provider and every credential field', () => {
  const officialHosts = ['developers.facebook.com', 'developers.google.com', 'docs.stripe.com'];
  for (const provider of DIRECT_PAYMENT_PROVIDERS) {
    const guide = PAYMENT_CREDENTIAL_GUIDES[provider];
    assert.ok(guide, `guide for ${provider}`);
    const fields = DIRECT_PROVIDER_CREDENTIAL_FIELDS[provider];
    assert.deepEqual(guide.fields.map((f) => f.field), [...fields.required, ...fields.optional], `${provider}: one line per credential field, in form order`);
    assert.ok(guide.steps.length >= 8, `${provider}: a real step list`);
    assert.ok(guide.links.length >= 2);
    for (const link of guide.links) {
      const u = new URL(link.url);
      assert.equal(u.protocol, 'https:', link.url);
      assert.ok(officialHosts.includes(u.hostname), `${link.url} is an official doc host`);
    }
    assert.match(guide.target, /수취인 대상/);
  }
  assert.match(PAYMENT_CREDENTIAL_GUIDES.stripe_issuing.summary, /카드 번호를 가져오지 않습니다/);
  assert.match(PAYMENT_CREDENTIAL_GUIDES.stripe_issuing.summary, /미국 · 영국 · EEA/);
  assert.match(PAYMENT_CREDENTIAL_GUIDES.google_ads.summary, /developer token 은 2026-09-09 에 폐지/);
  // 서버 stripeKeyMode 와 같은 말 — 운영 전체 키는 거부, 샌드박스만 sk_test_.
  const stripeKeyLine = PAYMENT_CREDENTIAL_GUIDES.stripe_issuing.fields.find((f) => f.field === 'secret_key').value;
  assert.match(stripeKeyLine, /운영의 전체 비밀 키\(sk_live_…\)는 거부됩니다 — 샌드박스에서만 sk_test_… 를 받습니다/);
});

test('Stripe Issuing reads as a card: status, approval, reconcile, inspection, limits and payee controls', () => {
  assert.equal(directRouteOptionLabel('stripe_issuing'), 'Stripe Issuing — 승인 금액 한도의 가상 카드 발급');
  assert.equal(directRouteOptionLabel('meta_ads'), 'Meta Ads — 광고 캠페인 상한 올리기');
  assert.equal(spendStatusViewFor({ status: 'paid', provider: 'stripe_issuing' }).label, '카드 발급됨');
  assert.equal(spendStatusViewFor({ status: 'executing', provider: 'stripe_issuing' }).label, '카드 발급 중');
  assert.equal(canRecordRefund({ status: 'paid', provider: 'stripe_issuing' }), false);
  assert.match(spendApproveHint({ provider: 'stripe_issuing' }), /가상 카드를 만듭니다\(비활성으로 만들어 계획과 대조한 뒤 활성화\)/);
  const plan = { plan: 'issue_card', target: { cardholder: 'ich_1' }, limit_minor: 80000, single_use: true };
  const hint = unknownReconcileHint({ provider: 'stripe_issuing', currency: 'USD', payload: plan, executing_at: null });
  assert.match(hint, /카드 소지자 ich_1 의 카드 중 이 요청의 카드를 찾습니다/);
  assert.match(hint, /해지된 카드만 있으면 그 카드로 쓴 돈이 없음을 확인해야 합니다/);
  assert.match(hint, /비활성\(inactive\) 카드는 AWB 가 활성화하지 않은 카드입니다 — 쓰지 않으면 대시보드에서 해지한 뒤 실패로, 쓰려면 대시보드에서 활성화한 뒤 결제 완료로/);
  assert.match(cardLimitWarning({ provider: 'stripe_issuing', currency: 'USD', payload: plan }), /500.00 USD 를 넘습니다 — .*카드당 하루 500 USD 라 첫 결제가/);
  assert.equal(cardLimitWarning({ provider: 'stripe_issuing', currency: 'USD', payload: { ...plan, limit_minor: 50000 } }), '');
  assert.equal(cardLimitWarning({ provider: 'stripe_issuing', currency: 'USD', payload: { ...plan, single_use: false } }), '');
  assert.equal(cardLimitWarning({ provider: 'meta_ads', currency: 'USD', payload: plan }), '');
  assert.match(cardLimitWarning({ provider: 'stripe_issuing', currency: 'EUR', payload: plan }), /500.00 EUR 를 넘습니다 — .*카드당 하루 500 USD 상당이라 첫 결제가/);

  const base = { kind: 'card', spend_request_id: 's', status: 'unknown', limit_minor: 30000, api_version: 'v', checked_at: '' };
  const card = (id, status) => ({ id, status, currency: 'USD', limit_minor: 30000, single_use: true, livemode: false, created: 0 });
  assert.match(inspectionSummary({ ...base, result: 'none', cards: [] }, 'USD'), /이 요청의 카드가 없습니다/);
  assert.equal(inspectionSummary({ ...base, result: 'found', cards: [card('ic_1', 'active')] }, 'USD'),
    '이 요청의 카드: ic_1(active, 한도 300.00 USD) — 활성 카드의 id 로 결제 완료를 기록하세요(쓰지 않을 카드면 Stripe 대시보드에서 해지한 뒤 실패로).');
  assert.match(inspectionSummary({ ...base, result: 'found', cards: [card('ic_2', 'inactive')] }, 'USD'),
    /ic_2\(inactive, 한도 300.00 USD\) — AWB 가 활성화하지 않은 카드입니다\. 쓰지 않으면 Stripe 대시보드에서 해지한 뒤 실패로\(쓴 돈 없음 확인\), 쓰려면 대시보드에서 활성화한 뒤 결제 완료로/);
  assert.match(inspectionSummary({ ...base, result: 'found', cards: [card('ic_3', 'canceled')] }, 'USD'), /모두 해지됐습니다/);
  assert.match(inspectionSummary({ ...base, result: 'incomplete', cards: [] }, 'USD'), /다 보지 못했습니다/);
  // 결제 기록에 미리 채우는 것은 활성 카드뿐 — AWB 가 살리지 않은 비활성 카드를 "결제 완료" 로 이끌지 않는다.
  assert.equal(inspectionCardRef({ ...base, result: 'found', cards: [card('ic_old', 'canceled'), card('ic_idle', 'inactive')] }), '');
  assert.equal(inspectionCardRef({ ...base, result: 'found', cards: [card('ic_idle', 'inactive'), card('ic_live', 'active')] }), 'ic_live');
  assert.equal(inspectionCardRef({ ...base, result: 'found', cards: [card('ic_old', 'canceled')] }), '');
  assert.equal(inspectionCardRef(null), '');

  const payee = { name: 'Card', provider: 'stripe_issuing', credential_id: 'c', ref: 'ich_1', card_single_use: true, card_categories: ['advertising_services'], card_max_minor: 50000 };
  assert.equal(payeeRouteLabel(payee), 'Stripe Issuing · ich_1');
  assert.equal(cardControlsLabel(payee, 'USD'), '일회용 · 업종 advertising_services · 카드당 최대 500.00 USD');
  assert.equal(cardControlsLabel({ ...payee, card_single_use: false, card_categories: [], card_max_minor: undefined }, 'USD'), '여러 번 쓰는 카드 · 업종 제한 없음');
  assert.equal(cardControlsLabel({ name: 'Meta', provider: 'meta_ads', ref: 'act_1/2' }, 'USD'), '');
});


test('reusable Stripe approvals and status describe a limit increase', () => {
  const row = { provider: 'stripe_issuing', status: 'paid', payload: { plan: 'issue_card', card_id: 'ic_reuse', from_minor: 100, limit_minor: 200 } };
  assert.equal(spendStatusViewFor(row).label, '한도 반영됨');
  assert.equal(spendStatusViewFor({ ...row, status: 'executing' }).label, '한도 변경 중');
  assert.match(spendApproveHint(row), /같은 Stripe 카드의 누적 한도/);
  const hint = unknownReconcileHint({ ...row, currency: 'USD' });
  assert.match(hint, /ic_reuse.*누적 한도/);
  assert.doesNotMatch(hint, /해지/);
});


test('Google credentials offer two complete alternative authentication sets', () => {
  assert.deepEqual(DIRECT_PROVIDER_CREDENTIAL_FIELDS.google_ads.required_one_of, [
    ['client_id', 'client_secret', 'refresh_token'], ['client_email', 'private_key'],
  ]);
  const source = fs.readFileSync(CREDENTIAL_MANAGER, 'utf8');
  assert.match(source, /private_key: \{ label:.*multiline: true/);
  assert.equal(directCredentialFieldsHint('google_ads'), 'client_id + client_secret + refresh_token 또는 client_email + private_key(한 방식 필수), login_customer_id(선택), developer_token(선택)');
  const guide = PAYMENT_CREDENTIAL_GUIDES.google_ads.steps.join(' ');
  assert.match(guide, /20계정/);
  assert.match(guide, /도메인 전체 위임은 필요 없습니다/);
  assert.match(guide, /login_customer_id/);
});
