// 직접 결제 어댑터(docs/marketing.md "직접 결제 어댑터")의 화면 회귀. jsdom 위에 실제 캠페인 페이지를 띄워 클릭 · 입력을 태운다.
//
// 고정하는 계약:
//   1. 직접 공급자 지출 카드는 서버가 쓴 계획 문장(plan_text)을 보여 주고, 승인 확인 창도 그 문장과 공급자 안내를 보여 준 뒤
//      화면이 본 해시 그대로 승인한다.
//   2. 결과 불명이면 어디를 볼지 안내하고, "공급자에서 확인" 이 지금 상한을 읽어 보여 준다. 결제 기록은 서버가 준 기록용 ref 로
//      미리 채운다.
//   3. 상한 공급자의 paid 는 "한도 반영됨" 이고 환불 기록 버튼이 없다.
//   4. 예산 설정의 수취인 편집: 결제 경로(Meta Ads · Google Ads)를 고르면 그 공급자로 만든 이 계정의 credential 만 고를 수 있고,
//      ref 형식이 틀리면 보내지 않으며, 맞으면 provider · credential_id 를 실어 보낸다.
//   5. 수취인 목록에 결제 경로가 보이고, "연결 확인" 이 공급자를 읽은 결과(정상 · 문제 · 지금 상한)를 보여 준다.
//   6. Stripe Issuing(카드): 결과 불명이면 "공급자에서 확인" 이 이 요청의 카드를 찾고, 결제 기록은 활성 카드의 id 로만 미리 채우며(AWB 가
//      활성화하지 않은 카드는 채우지 않는다), 실패 기록은 쓴 돈 없음 확인을 실어 보낸다. 발급된 카드는 "카드 발급됨" 과 대시보드 링크.
//      수취인 편집은 카드 통제 · 발급 안내를 보여 주고 저장하며, 통화를 바꾸면 카드당 최대도 새 통화로 다시 적게 한다.
//
// 실행: node --import tsx --test --test-force-exit test/marketing-direct-payment-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
// helpers/jsdom.mjs 를 react-router-dom(→ react-dom) 보다 먼저 import 해야 한다(그 파일 상단 주석).
import { setupDom, mount, click, typeInto, run, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../src/api.ts';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import MarketingCampaignPage from '../src/components/marketing/MarketingCampaignPage.tsx';

const h = React.createElement;
const flush = async (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

const HASH = 'f'.repeat(16) + 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667788990';
const NOW = Date.now();
const iso = (offsetMin) => new Date(NOW + offsetMin * 60_000).toISOString();
const PLAN_TEXT = 'Meta 광고 계정 act_9 의 캠페인 77 지출 한도(spend_cap)를 1,000.00 USD → 1,300.00 USD 로 올립니다(+300.00 USD).';

function campaign(overrides = {}) {
  return {
    id: 'c-1', account_id: 'acc-1', project_id: null, name: 'Paid launch', slug: 'paid-launch-ab12', status: 'active',
    product_brief: 'AWB', goal: 'signups', target_audience: 'self-hosters', capabilities: ['paid_spend'],
    agent_runtime: { manager_agent_id: 'host-1', cli: 'claude', model: null, working_dir: '/srv/awb', label: 'marketer' },
    agent_key: 'rt-1', cycle_cron: null, cycle_interval_ms: 86_400_000, next_cycle_at: iso(60), last_cycle_at: null, cycle_count: 1,
    currency: 'USD', budget_total_minor: 1_000_000, budget_period: 'month', budget_period_minor: 500_000, max_transaction_minor: 0,
    dual_approval_threshold_minor: 0, payment_provider: 'manual', payment_credential_id: null,
    payees: [
      { name: 'Meta fall', ref: 'act_9/77', provider: 'meta_ads', credential_id: 'cred-meta' },
      { name: 'Newsletter', ref: 'inv-1' },
    ],
    allowed_domains: ['awb.dev'], disclosure: '— 제품 제작자가 작성했습니다',
    limits: {}, limit_overrides: {}, feedback_ticket_status: 'backlog', improvement_assignee: null,
    created_by: 'u-1', created_at: iso(-600), updated_at: iso(-10),
    ...overrides,
  };
}

const channel = {
  id: 'ch-ads', account_id: 'acc-1', campaign_id: 'c-1', platform: 'other', kind: 'manual', name: 'Paid ads', target: 'Paid ads',
  status: 'active', rationale: '', audience_fit: '', audience_size: null, audience_observed_at: null, evidence_urls: [], rules_summary: '',
  rules_url: '', guidelines: '', outreach_channel_id: null, email: null, proposed_by_type: 'user', proposed_by_id: 'u-1',
  proposed_by_name: 'Owner', decided_by: 'u-1', decided_by_name: 'Owner', decided_at: iso(-300), decision_note: '', created_at: iso(-400), updated_at: iso(-300),
};

const plan = {
  plan: 'raise_ceiling', provider: 'meta_ads', target: { ad_account_id: '9', campaign_id: '77' }, target_name_untrusted: 'Fall promo',
  field: 'spend_cap', currency: 'USD', from: '100000', to: '130000', from_minor: 100000, to_minor: 130000, credential_fingerprint: '0123456789abcdef',
};

function spend(id, overrides = {}) {
  return {
    id, account_id: 'acc-1', campaign_id: 'c-1', channel_id: 'ch-ads', amount_minor: 30_000, amount_text: '300.00 USD', currency: 'USD',
    payee: 'Meta fall', payee_ref: 'act_9/77', purpose: 'Raise the fall cap', expected_outcome: '50 signups',
    provider: 'meta_ads', payload: plan, payload_sha256: HASH, plan_text: PLAN_TEXT, suggested_provider_ref: 'meta_ads:act_9/77:spend_cap=130000',
    dual_required: false, status: 'pending', requested_by_type: 'agent', requested_by_name: 'marketer', cycle_id: null, approvals: [],
    decided_by_name: null, decided_at: null, decision_note: '', expires_at: iso(60 * 24), period_key: '2026-10', executing_at: null,
    paid_at: null, provider_ref: '', receipt_url: '', provider_response: {}, error: '', created_at: iso(-15), updated_at: iso(-15),
    ...overrides,
  };
}

const budget = {
  currency: 'USD', payment_provider: 'manual',
  caps: { budget_total_minor: 1_000_000, budget_period: 'month', budget_period_minor: 500_000, max_transaction_minor: 0, dual_approval_threshold_minor: 0 },
  period: { key: '2026-10', start: iso(-30000), end: iso(30000) },
  total: { held: 0, spent: 0, cap: 1_000_000, available: 1_000_000 },
  period_usage: { held: 0, spent: 0, cap: 500_000, available: 500_000 },
  allocated_total_minor: 200_000, pending_allocations: 0, spend_counts: { pending: 1, unknown: 1, paid: 1 },
  channels: [{ channel_id: 'ch-ads', name: 'Paid ads', platform: 'other', status: 'active', allocation_minor: 200_000, allocation_id: 'al-1',
    period_held_minor: 0, period_spent_minor: 0, period_available_minor: 200_000, spent_all_time_minor: 0 }],
  text: { total: '', period: '' },
};

const SPEND_BY_STATUS = {
  pending: [spend('sp-pending')],
  unknown: [spend('sp-unknown', { status: 'unknown', error: 'Meta did not answer in time after the spend_cap change was sent' })],
  paid: [spend('sp-paid', { status: 'paid', provider_ref: 'meta_ads:act_9/77:spend_cap=130000', receipt_url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=9&selected_campaign_ids=77' })],
};

const credentials = [
  { id: 'cred-stripe', account_id: 'acc-1', name: 'Stripe restricted key', provider: 'stripe_issuing', agent_env: false, credential_fields: {} },
  { id: 'cred-meta', account_id: 'acc-1', name: 'Meta system user', provider: 'meta_ads', agent_env: false, credential_fields: {} },
  { id: 'cred-meta-2', account_id: 'acc-1', name: 'Meta backup', provider: 'meta_ads', agent_env: false, credential_fields: {} },
  { id: 'cred-google', account_id: 'acc-1', name: 'Google Ads OAuth', provider: 'google_ads', agent_env: false, credential_fields: {} },
  { id: 'cred-global', account_id: null, name: 'Meta global', provider: 'meta_ads', agent_env: false, credential_fields: {} },
  { id: 'cred-custom', account_id: 'acc-1', name: 'Custom token', provider: 'custom', agent_env: false, credential_fields: {} },
];

async function renderPage(t, { stubs = {}, entry = '/marketing/c-1?tab=inbox' } = {}) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} };
  localStorage.setItem('auth_token', 'test-token');
  const { uninstall } = installFakeEventSource();
  const calls = [];
  const originals = {};
  const all = {
    getMe: async () => ({
      id: 'u-approver', name: 'Approver', status: 'active', resolved_permissions: ['marketing.manage', 'marketing.approve_spend'],
      accounts: [{ id: 'acc-1', name: 'Owner', slug: null, relations: ['owner'] }],
    }),
    getMarketingCampaign: async () => campaign(),
    listMarketingChannels: async () => [channel],
    listMarketingPosts: async () => [],
    listMarketingAllocations: async () => [],
    listMarketingSpendRequests: async (_id, opts = {}) => (opts.status ? SPEND_BY_STATUS[opts.status] || [] : Object.values(SPEND_BY_STATUS).flat()),
    getMarketingBudget: async () => budget,
    listMarketingLedger: async () => [],
    listCredentials: async () => credentials,
    listProjects: async () => [],
    listTemplateHosts: async () => [{ id: 'host-1', name: 'rolf' }],
    ...stubs,
  };
  for (const [key, fn] of Object.entries(all)) {
    originals[key] = api[key];
    api[key] = async (...args) => { calls.push([key, ...args]); return fn(...args); };
  }
  const view = mount(
    h(MemoryRouter, { initialEntries: [entry] },
      h(ToastProvider, null,
        h(AuthProvider, null,
          h(BoardStreamProvider, null,
            h(Routes, null, h(Route, { path: '/marketing/:campaignId', element: h(MarketingCampaignPage) })))))),
  );
  await flush();
  await flush();
  await flush();
  t.after(() => { view.unmount(); Object.assign(api, originals); uninstall(); dom.cleanup(); });
  return { container: view.container, calls };
}

function within(root, testId) {
  const el = root.querySelector(`[data-testid="${testId}"]`);
  assert.ok(el, `[data-testid="${testId}"] 가 없습니다`);
  return el;
}

function buttonIn(root, label) {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(found, `"${label}" 버튼이 없습니다`);
  return found;
}

const hasButton = (root, label) => [...root.querySelectorAll('button')].some((b) => b.textContent?.trim() === label);
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];

function fieldIn(root, labelText, tag = 'input') {
  const label = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === labelText);
  assert.ok(label, `"${labelText}" 라벨이 없습니다`);
  const field = label.parentElement?.querySelector(tag);
  assert.ok(field, `"${labelText}" 의 <${tag}> 가 없습니다`);
  return field;
}

/** controlled <select> 를 고른다 — 네이티브 setter 로 값만 바꾸고 change 를 보낸다(typeInto 와 같은 이유). */
function choose(select, value) {
  run(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')?.set;
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('직접 공급자 지출 — 계획 문장을 보여 주고, 승인 확인 창의 안내와 해시 그대로 승인한다', async (t) => {
  const approvals = [];
  const { container } = await renderPage(t, {
    stubs: {
      approveMarketingSpend: async (id, sha, note) => {
        approvals.push([id, sha, note]);
        return { ...spend(id), status: 'paid', provider_ref: 'meta_ads:act_9/77:spend_cap=130000', final: true };
      },
    },
  });
  const card = within(container, 'marketing-spend-sp-pending');
  assert.equal(within(container, 'marketing-spend-plan-sp-pending').textContent, PLAN_TEXT);
  assert.match(card.textContent, /Meta Ads — 승인하면 서버가 광고 캠페인 지출 한도\(spend_cap\)를 올림/, '결제 방식');
  assert.match(card.textContent, /실행 계획 — 서버가 공급자를 읽어 만들었고/);

  click(buttonIn(card, '승인…'));
  await flush();
  const dialog = within(document, 'marketing-spend-approve-dialog');
  assert.equal(within(dialog, 'marketing-spend-approve-plan').textContent, PLAN_TEXT);
  assert.match(dialog.textContent, /Meta 광고 캠페인의 지출 한도\(spend_cap\)를 위 계획대로 바꿉니다/);
  click(within(document, 'marketing-spend-approve-check'));
  click(within(document, 'marketing-spend-approve-confirm'));
  await flush();
  await flush();
  assert.deepEqual(approvals, [['sp-pending', HASH, '']]);
  assert.ok(document.body.textContent.includes('승인했고 광고 플랫폼에 상한을 반영했습니다'));
});

test('결과 불명 — 어디를 볼지 알려 주고, 공급자에서 지금 상한을 읽어 오며, 결제 기록은 기록용 ref 로 채운다', async (t) => {
  const paid = [];
  const { container, calls } = await renderPage(t, {
    stubs: {
      inspectMarketingSpend: async (id) => ({
        spend_request_id: id, status: 'unknown', from: '100000', to: '130000', from_minor: 100000, to_minor: 130000,
        observed: '130000', observed_minor: 130000, position: 'at_target', report: {}, checked_at: iso(0),
      }),
      markMarketingSpendPaid: async (id, body) => { paid.push([id, body]); return spend(id, { status: 'paid' }); },
    },
  });
  const card = within(container, 'marketing-spend-sp-unknown');
  const alert = within(container, 'marketing-spend-unknown-sp-unknown');
  assert.match(alert.textContent, /Ads Manager 에서 캠페인 77 의 지출 한도가 1,300\.00 USD\(목표\)인지 1,000\.00 USD\(이전\)인지/);
  assert.equal(hasButton(card, '환불 기록…'), false);
  click(buttonIn(card, '공급자에서 확인'));
  await flush();
  await flush();
  assert.ok(calls.some((c) => c[0] === 'inspectMarketingSpend' && c[1] === 'sp-unknown'));
  assert.equal(
    within(container, 'marketing-spend-inspection-sp-unknown').textContent,
    '지금 상한 1,300.00 USD: 목표값입니다 — 반영된 것으로 보입니다. (1,000.00 USD → 1,300.00 USD 계획)',
  );

  click(buttonIn(card, '결제 완료 기록…'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('결제 완료 기록'));
  assert.ok(dialog, '결제 기록 창');
  assert.equal(fieldIn(dialog, '거래 id (필수)').value, 'meta_ads:act_9/77:spend_cap=130000', '서버가 준 기록용 ref');
  click(buttonIn(dialog, '기록'));
  await flush();
  await flush();
  assert.deepEqual(paid, [['sp-unknown', { provider_ref: 'meta_ads:act_9/77:spend_cap=130000' }]]);
});

test('상한 공급자의 결제 완료는 "한도 반영됨" 이고 환불 기록이 없다', async (t) => {
  const { container } = await renderPage(t, { entry: '/marketing/c-1?tab=budget' });
  const card = within(container, 'marketing-spend-sp-paid');
  assert.match(card.textContent, /한도 반영됨/);
  assert.equal(hasButton(card, '환불 기록…'), false);
  assert.match(card.textContent, /덜 쓰인 금액을 환불로 기록하는 것은 상한을 실제로/);
});

test('수취인 편집 — 직접 결제 경로는 그 공급자의 이 계정 credential 만, ref 형식이 맞아야 보낸다', async (t) => {
  const patches = [];
  const { container } = await renderPage(t, {
    entry: '/marketing/c-1?tab=budget',
    stubs: { updateMarketingCampaign: async (id, patch) => { patches.push([id, patch]); return { ...campaign(), ...patch }; } },
  });
  assert.match(within(container, 'marketing-payee-Meta fall').textContent, /직접 결제: Meta Ads · act_9\/77/);

  click(buttonIn(container, '예산 설정…'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('예산 설정'));
  assert.ok(dialog, '예산 설정 창');
  const metaRow = within(dialog, 'marketing-payee-row-0');
  const credSelect = metaRow.querySelector('select[aria-label="수취인 1 credential"]');
  assert.ok(credSelect, '직접 결제 수취인은 credential 을 고른다');
  const offered = [...credSelect.querySelectorAll('option')].map((o) => o.value).filter(Boolean);
  assert.deepEqual(offered, ['cred-meta', 'cred-meta-2'], '이 계정의 Meta Ads credential 만(전역 · 다른 종류 제외)');

  // Newsletter 를 Google Ads 경로로 — 형식이 틀린 ref 는 보내지 않는다.
  const row = within(dialog, 'marketing-payee-row-1');
  choose(row.querySelector('select[aria-label="수취인 2 결제 경로"]'), 'google_ads');
  await flush();
  const googleCred = row.querySelector('select[aria-label="수취인 2 credential"]');
  assert.ok(googleCred);
  assert.deepEqual([...googleCred.querySelectorAll('option')].map((o) => o.value).filter(Boolean), ['cred-google']);
  choose(googleCred, 'cred-google');
  click(buttonIn(dialog, '저장'));
  await flush();
  assert.equal(patches.length, 0, 'ref 가 Google 형식이 아니면 보내지 않는다');
  assert.match(dialog.textContent, /수취인 "Newsletter": Google Ads 대상은 <고객 id>\/<캠페인 id>/);

  typeInto(row.querySelector('input[aria-label="수취인 2 참조"]'), '111-222-3333/5');
  click(buttonIn(dialog, '저장'));
  await flush();
  await flush();
  assert.deepEqual(patches, [['c-1', {
    payees: [
      { name: 'Meta fall', ref: 'act_9/77', provider: 'meta_ads', credential_id: 'cred-meta' },
      { name: 'Newsletter', ref: '111-222-3333/5', provider: 'google_ads', credential_id: 'cred-google' },
    ],
  }]], '바뀐 수취인 목록만 — 그대로인 Meta 수취인은 같은 모양으로');
});

test('연결 확인 — 공급자를 읽은 결과를 수취인마다 보여 준다', async (t) => {
  const { container, calls } = await renderPage(t, {
    entry: '/marketing/c-1?tab=budget',
    stubs: {
      checkMarketingPayments: async () => ({
        checked_at: iso(0),
        payees: [{
          payee: 'Meta fall', provider: 'meta_ads', ref: 'act_9/77', credential_id: 'cred-meta', ok: false,
          problems: ['the Meta campaign has no spend cap — a person sets the first cap in Ads Manager'],
          ceiling_minor: null, ceiling_text: '', ceiling_units: null, target_name_untrusted: 'Fall promo', facts: {}, api_version: 'v26.0', open_request: null,
        }, {
          payee: 'Meta denied', provider: 'meta_ads', ref: 'act_9/80', credential_id: 'cred-meta', ok: false,
          problems: ['could not read Meta 80 (HTTP 400, code 100/33)'], ceiling_minor: null, ceiling_text: '', ceiling_units: null,
          target_name_untrusted: '', facts: {}, api_version: '', open_request: null,
          provider_message_untrusted: 'Unsupported get request. Object with ID 80 does not exist or missing permissions',
        }, {
          payee: 'Google total', provider: 'google_ads', ref: '1112223333/5', credential_id: 'cred-google', ok: true, problems: [],
          ceiling_minor: 100000, ceiling_text: '1,000.00 USD', ceiling_units: '1000000000', target_name_untrusted: '', facts: {}, api_version: 'v26',
          open_request: { id: '', status: 'other_account' },
        }],
      }),
    },
  });
  const panel = within(container, 'marketing-payment-check');
  click(buttonIn(panel, '연결 확인'));
  await flush();
  await flush();
  assert.ok(calls.some((c) => c[0] === 'checkMarketingPayments' && c[1] === 'c-1'));
  const line = within(container, 'marketing-payment-check-Meta fall');
  assert.match(line.textContent, /^문제 · Meta fall \(Meta Ads act_9\/77\)/);
  assert.match(line.textContent, /공급자 이름 “Fall promo”/);
  assert.match(line.textContent, /API v26\.0/);
  assert.match(line.textContent, /no spend cap/);
  const denied = within(container, 'marketing-payment-check-Meta denied');
  assert.match(denied.textContent, /could not read Meta 80 \(HTTP 400, code 100\/33\)/);
  assert.match(denied.textContent, /공급자 메시지 “Unsupported get request\. Object with ID 80 does not exist or missing permissions”/, 'the person sees why');
  const google = within(container, 'marketing-payment-check-Google total');
  assert.match(google.textContent, /^정상 · Google total \(Google Ads 1112223333\/5\) · 지금 상한 1,000\.00 USD/);
  assert.match(google.textContent, /다른 계정에 열린 요청 있음/, 'another account\'s request shows without its id or state');
  assert.doesNotMatch(google.textContent, /other_account/);
});

const CARD_PLAN = {
  plan: 'issue_card', provider: 'stripe_issuing', target: { cardholder: 'ich_1' }, currency: 'USD', limit_minor: 30000, interval: 'all_time',
  single_use: true, allowed_categories: ['advertising_services'], livemode: false, credential_fingerprint: '0123456789abcdef',
};
const CARD_PLAN_TEXT = 'Stripe Issuing 카드 소지자 ich_1 에게 누적 한도 300.00 USD 의 일회용(첫 결제 뒤 자동 해지) 가상 카드를 발급합니다(허용 업종: advertising_services).';
const cardSpend = (id, over = {}) => spend(id, {
  payee: 'Sponsor card', payee_ref: 'ich_1', provider: 'stripe_issuing', payload: CARD_PLAN, plan_text: CARD_PLAN_TEXT, suggested_provider_ref: '', ...over,
});

test('Stripe 카드 결과 불명 — 공급자에서 이 요청의 카드를 찾고, 결제 기록은 활성 카드 id 로만 채우고, 실패 기록은 쓴 돈 없음 확인을 싣는다', async (t) => {
  // 실행이 받아 둔 카드 id(suggested_provider_ref)는 비활성 카드일 수 있어 채우지 않는다.
  const unknownCard = cardSpend('sp-card', { status: 'unknown', executing_at: iso(-30), suggested_provider_ref: 'ic_77', error: 'Stripe answered HTTP 500 api_error when the card was requested — a card may exist' });
  const paid = [];
  const failed = [];
  let cardStatus = 'inactive';
  const { container } = await renderPage(t, {
    stubs: {
      listMarketingSpendRequests: async (_id, opts = {}) => (opts.status === 'unknown' || !opts.status ? [unknownCard] : []),
      inspectMarketingSpend: async () => ({
        kind: 'card', spend_request_id: 'sp-card', status: 'unknown', limit_minor: 30000, result: 'found', api_version: '2026-09-30.endive', checked_at: iso(0),
        cards: [{ id: 'ic_77', status: cardStatus, currency: 'USD', limit_minor: 30000, single_use: true, livemode: false, created: 0 }],
      }),
      markMarketingSpendPaid: async (id, data) => { paid.push([id, data]); return { ...unknownCard, status: 'paid' }; },
      markMarketingSpendFailed: async (id, note, confirm) => { failed.push([id, note, confirm]); return { ...unknownCard, status: 'failed' }; },
    },
  });
  const card = within(container, 'marketing-spend-sp-card');
  assert.match(within(container, 'marketing-spend-unknown-sp-card').textContent, /"공급자에서 확인" 이 카드 소지자 ich_1 의 카드 중 이 요청의 카드를 찾습니다/);
  click(buttonIn(card, '공급자에서 확인'));
  await flush();
  await flush();
  assert.match(within(container, 'marketing-spend-inspection-sp-card').textContent, /이 요청의 카드: ic_77\(inactive, 한도 300.00 USD\) — AWB 가 활성화하지 않은 카드입니다/);

  const paidRef = async () => {
    click(buttonIn(card, '결제 완료 기록…'));
    await flush();
    const paidDialog = dialogs().find((d) => d.textContent.includes('결제 완료 기록'));
    assert.ok(paidDialog);
    const value = paidDialog.querySelector('input').value;
    click(buttonIn(paidDialog, '취소'));
    await flush();
    return value;
  };
  assert.equal(await paidRef(), '', 'a card AWB never activated is not offered as paid');
  cardStatus = 'active';
  click(buttonIn(card, '공급자에서 확인'));
  await flush();
  await flush();
  assert.match(within(container, 'marketing-spend-inspection-sp-card').textContent, /ic_77\(active, 한도 300.00 USD\) — 활성 카드의 id 로 결제 완료를 기록하세요/);
  assert.equal(await paidRef(), 'ic_77', 'the active card the inspection found');

  click(buttonIn(card, '실패로 기록…'));
  await flush();
  const failDialog = dialogs().find((d) => d.textContent.includes('결제 실패로 기록'));
  assert.match(failDialog.textContent, /이 요청의 카드가 Stripe 에 없음을 확인했을 때만/);
  typeInto(failDialog.querySelector('textarea'), 'canceled in the dashboard, nothing spent');
  const confirmBox = failDialog.querySelector('input[type="checkbox"]');
  assert.ok(confirmBox, 'a card request asks for the no-spend confirmation');
  click(confirmBox);
  click(buttonIn(failDialog, '실패로 기록'));
  await flush();
  assert.deepEqual(failed, [['sp-card', 'canceled in the dashboard, nothing spent', true]]);
});

test('Stripe 카드 발급됨 — 상태 표시와 대시보드 링크, 승인 창의 카드 한도 주의', async (t) => {
  const issued = cardSpend('sp-issued', { status: 'paid', provider_ref: 'ic_9', receipt_url: 'https://dashboard.stripe.com/test/issuing/cards/ic_9' });
  const pendingBig = cardSpend('sp-big', { amount_minor: 80000, payload: { ...CARD_PLAN, limit_minor: 80000 } });
  const { container } = await renderPage(t, {
    entry: '/marketing/c-1?tab=budget',
    stubs: { listMarketingSpendRequests: async (_id, opts = {}) => (opts.status === 'paid' ? [issued] : opts.status === 'pending' ? [pendingBig] : !opts.status ? [issued, pendingBig] : []) },
  });
  const card = within(container, 'marketing-spend-sp-issued');
  assert.match(card.textContent, /카드 발급됨/);
  assert.match(card.textContent, /AWB 는 카드 번호를\s*보여 주지 않습니다/);
  const link = [...card.querySelectorAll('a')].find((a) => a.textContent === 'Stripe 에서 카드 보기');
  assert.ok(link, 'a link to the card in the Stripe Dashboard');
  assert.equal(link.getAttribute('href'), 'https://dashboard.stripe.com/test/issuing/cards/ic_9');
  assert.equal(hasButton(card, '환불 기록…'), false);

  const big = within(container, 'marketing-spend-sp-big');
  click(buttonIn(big, '승인…'));
  await flush();
  const dialog = within(document, 'marketing-spend-approve-dialog');
  assert.match(dialog.textContent, /가상 카드를 만듭니다\(비활성으로 만들어 계획과 대조한 뒤 활성화\)/);
  assert.match(dialog.textContent, /일회용 카드의 한도가 500.00 USD 를 넘습니다/);
});

test('수취인 편집 — Stripe Issuing 경로는 카드 통제와 발급 안내를 보여 주고, 서버 순서대로 저장한다', async (t) => {
  const patches = [];
  const { container } = await renderPage(t, {
    entry: '/marketing/c-1?tab=budget',
    stubs: { updateMarketingCampaign: async (id, patch) => { patches.push([id, patch]); return { ...campaign(), ...patch }; } },
  });
  click(buttonIn(container, '예산 설정…'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('예산 설정'));
  const row = within(dialog, 'marketing-payee-row-1');
  const route = row.querySelector('select[aria-label="수취인 2 결제 경로"]');
  assert.ok([...route.querySelectorAll('option')].some((o) => o.textContent === 'Stripe Issuing — 승인 금액 한도의 가상 카드 발급'));
  choose(route, 'stripe_issuing');
  await flush();
  const controls = within(row, 'marketing-payee-card-1');
  assert.equal(controls.querySelector('input[type="checkbox"]').checked, true, 'single-use by default');
  const guide = within(row, 'payment-credential-guide-stripe_issuing');
  assert.match(guide.textContent, /credential 발급 방법 — Stripe Issuing/);
  assert.match(guide.textContent, /Create restricted key/);
  const credSelect = row.querySelector('select[aria-label="수취인 2 credential"]');
  assert.deepEqual([...credSelect.querySelectorAll('option')].map((o) => o.value).filter(Boolean), ['cred-stripe']);
  choose(credSelect, 'cred-stripe');
  typeInto(row.querySelector('input[aria-label="수취인 2 참조"]'), 'ich_9');
  typeInto(row.querySelector('input[aria-label="수취인 2 허용 업종"]'), 'software, Advertising_Services');
  typeInto(row.querySelector('input[aria-label="수취인 2 카드당 최대"]'), '500');
  click(buttonIn(dialog, '저장'));
  await flush();
  await flush();
  assert.deepEqual(patches, [['c-1', {
    payees: [
      { name: 'Meta fall', ref: 'act_9/77', provider: 'meta_ads', credential_id: 'cred-meta' },
      { name: 'Newsletter', ref: 'ich_9', note: undefined, provider: 'stripe_issuing', credential_id: 'cred-stripe', card_single_use: true, card_categories: ['advertising_services', 'software'], card_max_minor: 50000 },
    ].map((p) => JSON.parse(JSON.stringify(p))),
  }]]);
});

test('예산 설정 — 통화를 바꾸면 카드당 최대도 비우고, 새 통화로 다시 적어야 저장한다', async (t) => {
  const patches = [];
  const stripePayee = { name: 'Sponsor card', ref: 'ich_9', provider: 'stripe_issuing', credential_id: 'cred-stripe', card_single_use: true, card_categories: [], card_max_minor: 50000 };
  const { container } = await renderPage(t, {
    entry: '/marketing/c-1?tab=budget',
    stubs: {
      getMarketingCampaign: async () => campaign({ payees: [stripePayee] }),
      updateMarketingCampaign: async (id, patch) => { patches.push(patch); return { ...campaign(), ...patch }; },
    },
  });
  click(buttonIn(container, '예산 설정…'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('예산 설정'));
  const cardMax = () => dialog.querySelector('input[aria-label="수취인 1 카드당 최대"]');
  assert.equal(cardMax().value, '500.00');
  typeInto(fieldIn(dialog, '통화'), 'eur');
  assert.equal(cardMax().value, '', '500 USD 가 500 EUR 로 읽히지 않게 비운다');
  assert.match(cardMax().getAttribute('placeholder'), /새 통화\(EUR\)로 다시 적으세요/);
  for (const [label, value] of [['총 예산 (0 = 지출 불가)', '1000'], ['기간 상한 (0 = 없음)', '500'], ['건당 상한 (0 = 없음)', '0'], ['2인 승인 기준 (0 = 끔)', '0']]) {
    typeInto(fieldIn(dialog, label), value);
  }
  click(buttonIn(dialog, '저장'));
  await flush();
  assert.equal(patches.length, 0, '카드당 최대를 다시 적기 전에는 보내지 않는다(지운 채로 두면 한도가 사라진다)');
  assert.match(dialog.textContent, /통화를 바꿨으니 수취인 "Sponsor card" 의 카드당 최대를 새 통화\(EUR\)로 다시 적으세요/);
  typeInto(cardMax(), '450');
  click(buttonIn(dialog, '저장'));
  await flush();
  await flush();
  assert.equal(patches.length, 1, JSON.stringify(patches));
  assert.equal(patches[0].currency, 'EUR');
  assert.equal(patches[0].payees[0].card_max_minor, 45000);
});


test('재사용 Stripe 카드 — 기존 카드 id 를 고쳐 저장하고 잘못된 id 는 막는다', async (t) => {
  const patches = [];
  const stripePayee = { name: 'Recurring', ref: 'ich_9', provider: 'stripe_issuing', credential_id: 'cred-stripe', card_single_use: false, card_id: 'ic_old', card_categories: [] };
  const { container } = await renderPage(t, {
    entry: '/marketing/c-1?tab=budget',
    stubs: {
      getMarketingCampaign: async () => campaign({ payees: [stripePayee] }),
      updateMarketingCampaign: async (id, patch) => { patches.push(patch); return campaign({ ...patch }); },
    },
  });
  click(buttonIn(container, '예산 설정…'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('예산 설정'));
  const input = dialog.querySelector('input[aria-label="수취인 1 재사용 카드 id"]');
  assert.equal(input.value, 'ic_old');
  typeInto(input, 'ich_wrong');
  click(buttonIn(dialog, '저장'));
  await flush();
  assert.equal(patches.length, 0);
  assert.match(dialog.textContent, /카드 id 는 ic_… 형식/);
  typeInto(input, 'ic_replacement');
  click(buttonIn(dialog, '저장'));
  await flush();
  assert.equal(patches[0].payees[0].card_id, 'ic_replacement');
  assert.equal(patches[0].payees[0].card_single_use, false);
});
