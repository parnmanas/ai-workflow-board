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
  assert.match(alert.textContent, /Ads Manager 에서 캠페인 77 의 지출 한도가 130000\(목표\)/);
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
});
