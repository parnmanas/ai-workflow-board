// Marketing 목록 · 새 캠페인 · 메일 연락처 화면 렌더 회귀(docs/marketing.md).
//
// 고정하는 계약:
//   1. 목록은 공통 업무의 캠페인 전체를 보여 주고(상태 · 기능 · 주기), 소유 선택기가 없다(docs/ownership.md).
//   2. 새 캠페인 본문에 account_id 를 싣지 않는다(실행 키는 서버가 정한다).
//   3. 돈 설정(통화 등)은 marketing.approve_spend 가 있는 사람만 그리고 보낸다 — 운영 권한만 있으면 통화 칸이
//      없고 본문에도 없다(서버가 403 으로 거부하는 키).
//   4. 지출 승인 권한만 있어도 목록을 본다 — 만들기 · 연락처(운영 권한의 일)는 없고, 그 권한으로 부를 수 없는 경로는
//      부르지 않는다. 캠페인마다 "승인 대기 N" 은 /marketing/inbox 의 actionable 이다.
//   5. 연락처 화면은 ?account= 로 받은 캠페인의 실행 키를 모든 연락처 호출에 account_id 로 싣는다.
//   6. CSV 가져오기는 검증을 통과한 행만, 그 실행 키로 보낸다.
//
// 실행: node --import tsx --test --test-force-exit test/marketing-pages.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
// helpers/jsdom.mjs 를 react-router-dom(→ react-dom) 보다 먼저 import 해야 한다(그 파일 상단 주석).
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../src/api.ts';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import MarketingPage from '../src/components/marketing/MarketingPage.tsx';
import MarketingContactsPage from '../src/components/marketing/MarketingContactsPage.tsx';

const h = React.createElement;
const flush = async (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

function campaign(overrides = {}) {
  return {
    id: 'c-1', account_id: 'acc-1', project_id: null, name: 'AWB 런칭', slug: 'awb-launch-ab12', status: 'active',
    product_brief: '', goal: '가입 300명', target_audience: '', capabilities: ['channel_discovery', 'paid_spend'],
    agent_runtime: null, agent_key: '', cycle_cron: null, cycle_interval_ms: 86_400_000,
    next_cycle_at: '2026-10-23T01:00:00.000Z', last_cycle_at: null, cycle_count: 4, currency: 'KRW', budget_total_minor: 0,
    budget_period: 'month', budget_period_minor: 0, max_transaction_minor: 0, dual_approval_threshold_minor: 0,
    payment_provider: 'manual', payment_credential_id: null, payees: [], allowed_domains: [], disclosure: '',
    limits: {}, limit_overrides: {}, feedback_ticket_status: 'backlog', improvement_assignee: null, created_by: 'u-1',
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

function consentOverview({ settings = {}, counts = {} } = {}) {
  return {
    settings: {
      enabled: false, subject: '[{{sender}}] 수신 동의 확인 안내', body: '{{name}}님, {{sender}}입니다.', lead_days: 30,
      on_no_response: 'keep', version: 0, updated_by_name: '', updated_at: null, ...settings,
    },
    counts: {
      in_window: 0, not_yet_queued: 0, waiting: 0, waiting_no_sender: 0, sent_30d: 0, failed_30d: 0, failed_retryable: 0, skipped_30d: 0,
      kept_30d: 0, expired: 0,
      ...counts,
    },
  };
}

async function render(t, { entry, permissions, stubs = {} }) {
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
      id: 'u-1', name: 'Tester', status: 'active', resolved_permissions: permissions,
      accounts: [{ id: 'acc-1', name: 'Personal', slug: null, relations: ['owner'] }, { id: 'acc-2', name: 'Org', slug: null, relations: ['member'] }],
    }),
    listMarketingCampaigns: async () => [campaign(), campaign({ id: 'c-2', account_id: 'acc-2', name: 'Org 캠페인', status: 'draft', capabilities: [], cycle_interval_ms: null })],
    listProjects: async () => [{ id: 'p-org', account_id: 'acc-2', name: 'Org product', host_folders: [] }],
    listTemplateHosts: async () => [],
    getMarketingInbox: async () => ({
      total: 2,
      campaigns: [{
        campaign_id: 'c-1', account_id: 'acc-1', name: 'AWB 런칭', channels_proposed: 1, posts_draft: 1, allocations_proposed: 0,
        spend_pending: 0, spend_unknown: 0, manual_awaiting_payment: 0, actionable: 2,
      }],
    }),
    getMarketingConsentNoticeSettings: async () => consentOverview(),
    listMarketingConsentNotices: async () => [],
    listMarketingContactReplies: async () => ({ total: 0, replies: [] }),
    listMarketingBrands: async () => [{ id: 'brand-1', account_id: 'acc-2', name: 'AWB Team' }],
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
            h(Routes, null,
              h(Route, { path: '/marketing', element: h(MarketingPage) }),
              h(Route, { path: '/marketing/contacts', element: h(MarketingContactsPage) }),
              h(Route, { path: '/marketing/:campaignId', element: h('div', { 'data-testid': 'campaign-detail-route' }) })))))),
  );
  await flush();
  await flush();
  await flush();
  t.after(() => { view.unmount(); Object.assign(api, originals); uninstall(); dom.cleanup(); });
  return { container: view.container, calls };
}

function buttonByText(root, label) {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(found, `"${label}" 버튼이 없습니다`);
  return found;
}

function fieldByLabel(root, labelText, tag = 'input') {
  const label = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === labelText);
  assert.ok(label, `"${labelText}" 라벨이 없습니다`);
  const field = label.parentElement?.querySelector(tag);
  assert.ok(field, `"${labelText}" 의 <${tag}> 가 없습니다`);
  return field;
}

function selectValue(select, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')?.set;
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

const hasLabel = (root, text) => [...root.querySelectorAll('label')].some((l) => l.textContent?.trim() === text);

test('목록 — 접근 가능한 계정의 캠페인을 합쳐 보여 주고, 계정 선택기가 없다', async (t) => {
  const { container } = await render(t, { entry: '/marketing', permissions: ['marketing.manage'] });
  const list = container.querySelector('[data-testid="marketing-campaign-list"]');
  assert.ok(list, '캠페인 목록 표');
  const first = container.querySelector('[data-testid="marketing-campaign-row-c-1"]');
  const second = container.querySelector('[data-testid="marketing-campaign-row-c-2"]');
  assert.ok(first && second, '두 계정의 캠페인이 같이 보인다');
  assert.match(first.textContent, /진행 중/);
  assert.match(first.textContent, /채널 탐색/);
  assert.match(first.textContent, /예산 집행 · 결제/);
  assert.match(first.textContent, /24시간마다/);
  assert.match(second.textContent, /초안/);
  assert.match(second.textContent, /수동 실행만/);
  assert.equal(container.querySelector('[data-testid="marketing-campaign-pending-c-1"]').textContent, '승인 대기 2', '/marketing/inbox 의 actionable');
  assert.equal(container.querySelector('[data-testid="marketing-campaign-pending-c-2"]').textContent, '—');
  const headerText = container.querySelector('header')?.textContent || '';
  assert.equal(/계정|Account/.test(headerText), false, '헤더에 계정 선택기가 없다');
  assert.equal(container.querySelectorAll('select').length, 0, '목록 화면에 선택기가 없다');
});

test('새 캠페인(운영 권한만) — 돈 설정 칸이 없고, 본문에 account_id · 통화를 싣지 않는다', async (t) => {
  const bodies = [];
  const { container } = await render(t, {
    entry: '/marketing',
    permissions: ['marketing.manage'],
    stubs: { createMarketingCampaign: async (body) => { bodies.push(body); return campaign({ id: 'c-new', name: body.name, status: 'draft' }); } },
  });
  click(buttonByText(container, '+ 새 캠페인'));
  await flush();
  const form = container.querySelector('[data-testid="marketing-campaign-form"]');
  assert.ok(form, '새 캠페인 창');
  assert.equal(hasLabel(form, '통화 (ISO 4217)'), false, '운영 권한만으로는 통화를 정하지 않는다');
  assert.match(form.textContent, /marketing\.approve_spend/);

  typeInto(fieldByLabel(form, '이름'), '가을 런칭');
  selectValue(fieldByLabel(form, '제품 Project (선택)', 'select'), 'p-org');
  typeInto(fieldByLabel(form, '제품 브리프 — 무엇을 알리는가', 'textarea'), '셀프호스팅 에이전트 보드');
  click(form.querySelector('input[aria-label="메일 발송"]'));
  click([...form.querySelectorAll('input[type="radio"]')].find((r) => r.parentElement?.textContent?.includes('시간 간격')));
  await flush();
  typeInto(fieldByLabel(form, '몇 시간마다'), '12');
  click(buttonByText(document, '캠페인 만들기'));
  await flush();
  await flush();

  assert.equal(bodies.length, 1, '생성 요청이 나간다');
  const body = bodies[0];
  assert.equal(body.name, '가을 런칭');
  assert.equal(body.project_id, 'p-org', '고른 Project — 소유 계정은 서버가 그 Project 로 정한다');
  assert.equal('account_id' in body, false, '본문에 소유 계정을 싣지 않는다');
  for (const key of ['currency', 'budget_total_minor', 'payees', 'payment_provider', 'dual_approval_threshold_minor']) {
    assert.equal(key in body, false, `운영 권한만으로는 ${key} 를 보내지 않는다`);
  }
  assert.deepEqual(body.capabilities, ['channel_discovery', 'community_post', 'email', 'analytics'], '기능 순서는 정의 순서');
  assert.equal(body.cycle_interval_ms, 12 * 3_600_000);
  assert.equal(body.cycle_cron, null);
  assert.ok(container.querySelector('[data-testid="campaign-detail-route"]'), '만든 캠페인으로 간다');
});

test('새 캠페인(지출 승인 권한) — 통화를 정하고 보낸다', async (t) => {
  const bodies = [];
  const { container } = await render(t, {
    entry: '/marketing',
    permissions: ['marketing.manage', 'marketing.approve_spend'],
    stubs: { createMarketingCampaign: async (body) => { bodies.push(body); return campaign({ id: 'c-usd', name: body.name }); } },
  });
  click(buttonByText(container, '+ 새 캠페인'));
  await flush();
  const form = container.querySelector('[data-testid="marketing-campaign-form"]');
  typeInto(fieldByLabel(form, '이름'), 'US launch');
  const currency = fieldByLabel(form, '통화 (ISO 4217)');
  assert.equal(currency.value, 'KRW', '기본 통화');
  typeInto(currency, 'usd');
  click(buttonByText(document, '캠페인 만들기'));
  await flush();
  await flush();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].currency, 'USD');
  assert.equal(bodies[0].cycle_interval_ms, null, '기본은 수동 실행만');
  assert.equal('project_id' in bodies[0], false, 'Project 를 고르지 않으면 싣지 않는다(기본 계정)');
});

test('지출 승인 권한만 있어도 목록 · 승인 대기 수를 본다 — 만들기 · 연락처는 없다', async (t) => {
  const { container, calls } = await render(t, {
    entry: '/marketing',
    permissions: ['marketing.approve_spend'],
    stubs: {
      getMarketingInbox: async () => ({
        total: 3,
        campaigns: [{
          campaign_id: 'c-2', account_id: 'acc-2', name: 'Org 캠페인', channels_proposed: 4, posts_draft: 2, allocations_proposed: 1,
          spend_pending: 1, spend_unknown: 1, manual_awaiting_payment: 0, actionable: 3,
        }],
      }),
    },
  });
  assert.ok(container.querySelector('[data-testid="marketing-campaign-row-c-1"]'), '목록이 보인다');
  assert.equal(container.querySelector('[data-testid="marketing-campaign-pending-c-2"]').textContent, '승인 대기 3', '이 사람이 처리할 수 있는 돈 항목만');
  assert.equal(container.querySelector('[data-testid="marketing-campaign-pending-c-1"]').textContent, '—');
  assert.equal([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === '+ 새 캠페인'), false, '캠페인은 운영 권한이 만든다');
  assert.equal(/메일 연락처/.test(container.textContent), false, '연락처는 운영 권한의 일이다');
  assert.equal(/권한이 필요합니다|권한으로 열립니다/.test(container.textContent), false, '막혔다는 안내가 없다');
  assert.deepEqual([...new Set(calls.map((c) => c[0]))].sort(), ['getMarketingInbox', 'getMe', 'listMarketingCampaigns'], '부를 수 있는 경로만 부른다');
});

test('연락처 — 캠페인 계정(?account=)을 모든 호출에 account_id 로 싣고, CSV 는 검증한 행만 그 계정으로 가져온다', async (t) => {
  const imports = [];
  const erased = [];
  const contact = {
    id: 'ct-1', account_id: 'acc-2', email: 'old@example.com', name: 'Old', lists: ['newsletter'], status: 'subscribed',
    consent_method: 'signup_form', consent_source: 'https://ex.com/signup', consent_at: '2025-01-01T00:00:00.000Z',
    consent_text_version: 'v1', night_consent: false, country: 'KR', timezone: 'Asia/Seoul', unsubscribed_at: null,
    unsubscribe_source: '', created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
  };
  const { container, calls } = await render(t, {
    entry: '/marketing/contacts?account=acc-2&campaign=c-2&list=newsletter',
    permissions: ['marketing.manage'],
    stubs: {
      getMarketingCampaign: async () => campaign({ id: 'c-2', account_id: 'acc-2', name: 'Org 캠페인' }),
      listMarketingContacts: async () => ({ total: 1, contacts: [contact] }),
      importMarketingContacts: async (accountId, body) => { imports.push([accountId, body]); return { created: 1, updated: 0, suppressed: 0, invalid: [] }; },
      eraseMarketingContact: async (id, accountId) => { erased.push([id, accountId]); return { ...contact, email: null, status: 'erased' }; },
    },
  });

  const listCall = calls.find((c) => c[0] === 'listMarketingContacts');
  assert.ok(listCall, '연락처 목록을 묻는다');
  assert.equal(listCall[1], 'acc-2', '캠페인의 계정을 명시한다');
  assert.equal(listCall[2].list, 'newsletter', '메일 채널의 수신 목록으로 거른다');
  assert.match(container.textContent, /← Org 캠페인/, '열어 온 캠페인으로 돌아가는 길');
  assert.match(container.querySelector('[data-testid="marketing-contacts"]').textContent, /old@example\.com/);

  click(buttonByText(container, '삭제'));
  await flush();
  click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === '삭제'));
  await flush();
  await flush();
  assert.deepEqual(erased, [['ct-1', 'acc-2']]);

  click(buttonByText(container, 'CSV 가져오기'));
  await flush();
  const modal = container.querySelector('[data-testid="marketing-contacts-import"]');
  assert.ok(modal, '가져오기 창');
  assert.match(modal.textContent, /동의 방법 · 동의 시각 · 동의 출처/, '동의 증거가 법적으로 필요하다는 설명');
  assert.match(modal.textContent, /다시 가져와도 억제/);
  assert.equal(buttonByText(document, '0명 가져오기').disabled, true, '브랜드를 먼저 고른다');
  selectValue(fieldByLabel(modal, '동의를 받은 발신자(브랜드)', 'select'), 'brand-1');
  assert.equal(fieldByLabel(modal, '모든 행에 더할 수신 목록 (쉼표로 여러 개)').value, 'newsletter');

  typeInto(modal.querySelector('textarea[aria-label="CSV 내용"]'), [
    'Email,Name,Consent Method,Consent Source,Consent At',
    'kim@example.com,"Kim, Minji",signup_form,https://ex.com/signup,2026-09-01T10:00:00Z',
    'broken-address,Lee,signup_form,https://ex.com/signup,2026-09-01T10:00:00Z',
  ].join('\n'));
  await flush();
  assert.match(modal.querySelector('[data-testid="marketing-contacts-import-summary"]').textContent, /가져올 수 있음 1 · 오류 1/);
  assert.match(modal.textContent, /이메일 주소가 아닙니다: broken-address/);

  click(buttonByText(document, '1명 가져오기'));
  await flush();
  await flush();
  assert.equal(imports.length, 1);
  const [accountId, body] = imports[0];
  assert.equal(accountId, 'acc-2', '가져오기도 캠페인의 계정으로');
  assert.deepEqual(body, {
    brand_id: 'brand-1',
    lists: ['newsletter'],
    contacts: [{
      email: 'kim@example.com', name: 'Kim, Minji', consent_method: 'signup_form',
      consent_source: 'https://ex.com/signup', consent_at: '2026-09-01T10:00:00.000Z',
    }],
  });
  assert.match(container.querySelector('[data-testid="marketing-contacts-import-result"]').textContent, /새로 1 · 갱신 0 · 억제 0 · 거부 0/);
});

test('연락처 — 동의 재확인 안내: 요약 · 미리보기 · 저장, 연락처마다 동의 기한과 안내 상태', async (t) => {
  const contact = (overrides) => ({
    id: 'ct-1', account_id: 'acc-2', email: 'kim@example.com', name: 'Kim', lists: ['newsletter'], status: 'subscribed',
    consent_method: 'reconfirm', consent_source: 'consent-notice:n-1', consent_at: '2026-10-05T00:00:00.000Z',
    consent_due_at: '2028-10-04T00:00:00.000Z', consent_renewed_at: null, consent_text_version: 'consent-notice-v1', night_consent: false,
    country: 'KR', timezone: 'Asia/Seoul', unsubscribed_at: null, unsubscribe_source: '',
    consent_notice: { id: 'n-1', status: 'sent', due_at: '2026-10-30T00:00:00.000Z', policy: 'keep', sent_at: '2026-10-01T03:00:00.000Z', kept_at: '2026-10-05T00:00:00.000Z' },
    created_at: '2024-10-30T00:00:00.000Z', updated_at: '2026-10-05T00:00:00.000Z', ...overrides,
  });
  const previews = [];
  const saves = [];
  const retries = [];
  const { container, calls } = await render(t, {
    entry: '/marketing/contacts?account=acc-2&campaign=c-2',
    permissions: ['marketing.manage'],
    stubs: {
      getMarketingCampaign: async () => campaign({ id: 'c-2', account_id: 'acc-2', name: 'Org 캠페인' }),
      listMarketingContacts: async () => ({ total: 2, contacts: [
        contact(),
        contact({ id: 'ct-2', email: 'old@example.com', consent_method: 'signup_form', consent_due_at: '2026-01-01T00:00:00.000Z', consent_notice: null }),
      ].map((c) => ({ ...c, legacy_consent_migrated: true, consents: [{ ...c, id: `consent-${c.id}`, brand_id: 'brand-1' }] })) }),
      getMarketingConsentNoticeSettings: async () => consentOverview({ counts: { in_window: 3, expired: 1, waiting_no_sender: 1, failed_retryable: 2 } }),
      retryFailedMarketingConsentNotices: async (accountId) => {
        retries.push(accountId);
        return { requeued: 2, ...consentOverview({ counts: { in_window: 3, waiting: 2 } }) };
      },
      listMarketingConsentNotices: async () => [{
        id: 'n-1', contact_id: 'ct-1', contact_email: 'kim@example.com', contact_name: 'Kim', contact_status: 'subscribed',
        due_at: '2026-10-30T00:00:00.000Z', status: 'sent', policy: 'keep', settings_version: 1, attempts: 1,
        next_attempt_at: '2026-10-01T03:00:00.000Z', channel_id: 'ch-1', provider_message_id: 're_1', sent_at: '2026-10-01T03:00:00.000Z',
        kept_at: '2026-10-05T00:00:00.000Z', renewed_at: null, bounce_type: '', event_note: '', error: '', created_at: '2026-10-01T00:00:00.000Z',
      }, {
        id: 'n-2', contact_id: 'ct-3', contact_email: 'soft@example.com', contact_name: 'Soft', contact_status: 'subscribed',
        due_at: '2026-10-30T00:00:00.000Z', status: 'sent', policy: 'keep', settings_version: 1, attempts: 1,
        next_attempt_at: '2026-10-01T03:00:00.000Z', channel_id: 'ch-1', provider_message_id: 're_2', sent_at: '2026-10-01T03:00:00.000Z',
        kept_at: null, renewed_at: null, bounce_type: 'soft', event_note: 'Transient/General — mailbox full', error: '', created_at: '2026-10-01T00:00:00.000Z',
      }],
      previewMarketingConsentNotice: async (accountId, body) => {
        previews.push([accountId, body]);
        return { subject: '[AWB Team] 수신 동의 확인 안내', text: '홍길동님, AWB Team입니다.\n\n--\n[광고성 정보 수신 동의 확인]', sender: { channel_id: 'ch-1', campaign_id: 'c-2', channel_name: 'newsletter', from_name: 'AWB Team', from_address: 'hi@awb.example.com' }, warnings: [] };
      },
      saveMarketingConsentNoticeSettings: async (accountId, body) => {
        saves.push([accountId, body]);
        return consentOverview({ settings: { ...body, version: 1, updated_by_name: 'Tester' }, counts: { in_window: 3 } });
      },
    },
  });

  assert.equal(calls.find((c) => c[0] === 'getMarketingConsentNoticeSettings')?.[1], 'acc-2', '연락처와 같은 계정');
  const panel = container.querySelector('[data-testid="marketing-consent-notice"]');
  assert.match(panel.textContent, /꺼짐 — 동의 2년이 지난 연락처는 발송에서 빠지기만 합니다/);
  assert.match(panel.textContent, /1건은 같은 브랜드 · 목록의 메일 채널이 없어/);
  assert.match(panel.textContent, /기한이 지난 브랜드 동의 1건/);
  assert.match(panel.textContent, /기한 전에 실패한 안내 2통/);
  const kimLine = container.querySelector('[data-testid="marketing-contact-consent-ct-1-brand-1"]').textContent;
  assert.match(kimLine, /동의 기한 2028-10-0\d · 재확인 안내 2026-10-01 보냄 · 응답 없으면 유지 · 2026-10-05 유지함/);
  assert.match(container.querySelector('[data-testid="marketing-contacts"]').textContent, /재확인 안내 — 유지/, '유지 링크로 남은 동의의 방법');
  assert.match(container.querySelector('[data-testid="marketing-contact-consent-ct-2-brand-1"]').textContent, /지남 — 발송 제외/);

  click(buttonByText(panel, '설정'));
  await flush();
  const modal = document.querySelector('[data-testid="marketing-consent-notice-settings"]');
  assert.ok(modal, '설정 창');
  assert.match(modal.textContent, /동의일부터 2년마다, 2년이 되는 날 전까지/);
  assert.match(modal.textContent, /광고 표기를 붙이지 않습니다/);
  assert.equal(calls.find((c) => c[0] === 'listMarketingConsentNotices')?.[1], 'acc-2');
  const recentList = document.querySelector('[data-testid="marketing-consent-notice-list"]').textContent;
  assert.match(recentList, /kim@example\.com/);
  assert.match(recentList, /닿지 않음\(soft\)Transient\/General — mailbox full/, '미도달과 공급자 사유');

  click(buttonByText(document, '실패한 안내 다시 보내기 (2)'));
  await flush();
  await flush();
  assert.deepEqual(retries, ['acc-2']);
  assert.equal([...document.querySelectorAll('button')].some((b) => /실패한 안내 다시 보내기/.test(b.textContent || '')), false,
    '다시 보낼 것이 없으면 버튼이 사라진다');

  click(modal.querySelector('input[aria-label="재확인 안내 보내기"]'));
  await flush();
  assert.match(modal.textContent, /안내 기간에 든 브랜드 동의 3건에 대해 10분 안에 보내기 시작합니다/);
  const lead = fieldByLabel(modal, '기한 며칠 전에 보낼까요 (7–90일)');
  typeInto(lead, '3');
  await flush();
  assert.match(modal.textContent, /기한 7–90일 전 사이의 정수여야 합니다/);
  assert.equal(buttonByText(document, '저장').disabled, true, '서버가 거부할 값은 보내지 않는다');
  typeInto(lead, '14');
  click(modal.querySelector('[data-testid="marketing-consent-notice-policy-lapse"]'));
  await flush();
  assert.equal(buttonByText(document, '저장').disabled, false);

  click(buttonByText(document, '미리보기'));
  await flush();
  await flush();
  const expected = { enabled: true, subject: '[{{sender}}] 수신 동의 확인 안내', body: '{{name}}님, {{sender}}입니다.', lead_days: 14, on_no_response: 'lapse' };
  assert.deepEqual(previews, [['acc-2', expected]]);
  assert.match(document.querySelector('[data-testid="marketing-consent-notice-preview"]').textContent, /보내는 채널: newsletter · AWB Team/);

  click(buttonByText(document, '저장'));
  await flush();
  await flush();
  assert.deepEqual(saves, [['acc-2', expected]]);
  assert.match(container.querySelector('[data-testid="marketing-consent-notice-summary"]').textContent, /켜짐 · 기한 14일 전 · 응답이 없으면 동의 철회/);
});

test('API — 경로 · 본문이 서버 컨트롤러와 맞고, 연락처는 account_id 를 쿼리로 싣는다', async (t) => {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  const previous = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  t.after(() => { globalThis.fetch = previous; dom.cleanup(); });

  await api.listMarketingCampaigns();
  await api.getMarketingInbox();
  await api.createMarketingCampaign({ name: 'n', project_id: 'p-1' });
  await api.setMarketingCampaignStatus('c 1', 'paused');
  await api.runMarketingCycle('c-1');
  await api.listMarketingAudit('c-1', { limit: 100, before: '2026-10-01T00:00:00.000Z' });
  await api.approveMarketingChannel('ch-1', { mode: 'manual', note: 'ok' });
  await api.listMarketingPosts('c-1', { status: 'draft', limit: 200 });
  await api.approveMarketingPost('p-1', { body: 'edited' });
  await api.rejectMarketingPost('p-1', 'why');
  await api.markMarketingPostPublished('p-1', 'https://forum.example/t/1');
  await api.setMarketingAllocations('c-1', { allocations: [{ channel_id: 'ch-1', amount_minor: 5000 }], rationale: 'r' });
  await api.approveMarketingSpend('sp-1', 'abc123', 'go');
  await api.cancelMarketingSpend('sp-1', 'not needed');
  await api.markMarketingSpendPaid('sp-1', { provider_ref: 'txn-1' });
  await api.refundMarketingSpend('sp-1', { amount_minor: 100, note: 'partial' });
  await api.getMarketingReport('c-1', { since: '2026-10-01T00:00:00.000Z' });
  await api.recordMarketingMetrics('c-1', [{ metric: 'signups', value: 3 }]);
  await api.fileMarketingFeedbackTicket('fb-1');
  await api.listMarketingContacts('acc-2', { list: 'newsletter', status: 'subscribed', q: 'kim', limit: 50, offset: 50 });
  await api.listMarketingContacts(null);
  await api.importMarketingContacts('acc-2', { lists: ['newsletter'], contacts: [] });
  await api.unsubscribeMarketingContact('ct-1', 'phone', 'acc-2');
  await api.eraseMarketingContact('ct-1', 'acc-2');
  await api.listMarketingListHolds('acc-2', { status: 'held' });
  await api.releaseMarketingListHold('h-1', 'removed a scraped batch', 'acc-2');
  await api.getMarketingConsentNoticeSettings('acc-2');
  await api.saveMarketingConsentNoticeSettings('acc-2', { enabled: true, lead_days: 30 });
  await api.previewMarketingConsentNotice(null, { subject: 's' });
  await api.listMarketingConsentNotices('acc-2', { status: 'failed', limit: 20 });
  await api.retryFailedMarketingConsentNotices('acc-2');
  await api.listOutreachChannels('acc-2');

  assert.deepEqual(sent.map((s) => `${s.method} ${s.url}`), [
    'GET /api/marketing/campaigns',
    'GET /api/marketing/inbox',
    'POST /api/marketing/campaigns',
    'POST /api/marketing/campaigns/c%201/status',
    'POST /api/marketing/campaigns/c-1/cycles/run',
    'GET /api/marketing/campaigns/c-1/audit?limit=100&before=2026-10-01T00%3A00%3A00.000Z',
    'POST /api/marketing/channels/ch-1/approve',
    'GET /api/marketing/campaigns/c-1/posts?status=draft&limit=200',
    'POST /api/marketing/posts/p-1/approve',
    'POST /api/marketing/posts/p-1/reject',
    'POST /api/marketing/posts/p-1/mark-published',
    'POST /api/marketing/campaigns/c-1/allocations',
    'POST /api/marketing/spend-requests/sp-1/approve',
    'POST /api/marketing/spend-requests/sp-1/cancel',
    'POST /api/marketing/spend-requests/sp-1/mark-paid',
    'POST /api/marketing/spend-requests/sp-1/refund',
    'GET /api/marketing/campaigns/c-1/report?since=2026-10-01T00%3A00%3A00.000Z',
    'POST /api/marketing/campaigns/c-1/metrics',
    'POST /api/marketing/feedback/fb-1/ticket',
    'GET /api/marketing/contacts?account_id=acc-2&list=newsletter&status=subscribed&q=kim&limit=50&offset=50',
    'GET /api/marketing/contacts',
    'POST /api/marketing/contacts/import?account_id=acc-2',
    'POST /api/marketing/contacts/ct-1/unsubscribe?account_id=acc-2',
    'POST /api/marketing/contacts/ct-1/erase?account_id=acc-2',
    'GET /api/marketing/list-holds?account_id=acc-2&status=held',
    'POST /api/marketing/list-holds/h-1/release?account_id=acc-2',
    'GET /api/marketing/consent-notices/settings?account_id=acc-2',
    'PUT /api/marketing/consent-notices/settings?account_id=acc-2',
    'POST /api/marketing/consent-notices/preview',
    'GET /api/marketing/consent-notices?account_id=acc-2&status=failed&limit=20',
    'POST /api/marketing/consent-notices/retry-failed?account_id=acc-2',
    'GET /api/outreach-channels?account_id=acc-2',
  ]);
  const body = (path, method = 'POST') => sent.find((x) => x.method === method && x.url === path)?.body;
  assert.deepEqual(body('/api/marketing/campaigns'), { name: 'n', project_id: 'p-1' }, '생성 본문에 account_id 가 없다');
  assert.deepEqual(body('/api/marketing/campaigns/c%201/status'), { status: 'paused' });
  assert.deepEqual(body('/api/marketing/campaigns/c-1/allocations'), { allocations: [{ channel_id: 'ch-1', amount_minor: 5000 }], rationale: 'r', approve: true }, '사람의 직접 편성은 곧바로 승인');
  assert.deepEqual(body('/api/marketing/spend-requests/sp-1/approve'), { payload_sha256: 'abc123', note: 'go' }, '지출 승인은 본 요청의 해시를 돌려보낸다');
  assert.deepEqual(body('/api/marketing/spend-requests/sp-1/cancel'), { note: 'not needed' });
  assert.deepEqual(body('/api/marketing/campaigns/c-1/metrics'), { observations: [{ metric: 'signups', value: 3 }] });
  assert.deepEqual(body('/api/marketing/contacts/ct-1/unsubscribe?account_id=acc-2'), { note: 'phone' });
  assert.deepEqual(body('/api/marketing/list-holds/h-1/release?account_id=acc-2'), { note: 'removed a scraped batch' }, '해제는 사유와 함께');
  assert.deepEqual(body('/api/marketing/consent-notices/settings?account_id=acc-2', 'PUT'), { enabled: true, lead_days: 30 });
  assert.deepEqual(body('/api/marketing/consent-notices/preview'), { subject: 's' });
});


test('보관된 캠페인의 미결 결제 수가 목록에 보이고 상세로 이동한다', async (t) => {
  const { container } = await render(t, {
    entry: '/marketing', permissions: ['marketing.approve_spend'],
    stubs: {
      listMarketingCampaigns: async () => [campaign({ status: 'archived' })],
      getMarketingInbox: async () => ({ total: 2, campaigns: [{
        campaign_id: 'c-1', account_id: 'acc-1', name: 'AWB 런칭', channels_proposed: 0, posts_draft: 0,
        allocations_proposed: 0, spend_pending: 0, spend_unknown: 1, manual_awaiting_payment: 1, actionable: 2,
      }] }),
    },
  });
  assert.equal(container.querySelector('[data-testid="marketing-campaign-pending-c-1"]').textContent, '승인 대기 2');
  const link = container.querySelector('[data-testid="marketing-campaign-row-c-1"] a');
  assert.equal(link.getAttribute('href'), '/marketing/c-1');
  click(link);
  await flush();
  assert.ok(container.querySelector('[data-testid="campaign-detail-route"]'));
});

test('브랜드 동의 — 미이관 연락처를 명시적으로 선택하고 확인한 뒤 한 브랜드에 이관한다', async (t) => {
  const migrated = [];
  const unsubscribed = [];
  const contact = {
    id: 'ct-legacy', account_id: 'acc-2', email: 'legacy@example.com', name: 'Legacy', lists: ['newsletter'], status: 'subscribed',
    consent_method: 'signup_form', consent_source: 'signup', consent_at: '2026-01-01T00:00:00Z',
    legacy_consent_migrated: false, consents: [],
  };
  const { container } = await render(t, {
    entry: '/marketing/contacts?account=acc-2', permissions: ['marketing.manage'],
    stubs: {
      listMarketingContacts: async () => ({ total: 1, contacts: [contact] }),
      migrateMarketingLegacyConsent: async (...args) => {
        migrated.push(args);
        contact.legacy_consent_migrated = true;
        contact.consents = [{ id: 'consent-1', brand_id: 'brand-1', status: 'subscribed', consent_method: 'signup_form', consent_source: 'signup', consent_at: contact.consent_at }];
        return { migrated: 1 };
      },
      unsubscribeMarketingContact: async (...args) => { unsubscribed.push(args); return contact; },
    },
  });
  assert.match(container.textContent, /브랜드 동의 없음 — 발송 제외/);
  assert.equal(buttonByText(container, '선택 0명 기존 동의 이관').disabled, true);
  selectValue(fieldByLabel(container, '가져오기 · 기존 동의 이관 대상 브랜드', 'select'), 'brand-1');
  click(container.querySelector('input[type="checkbox"]'));
  click(buttonByText(container, '선택 1명 기존 동의 이관'));
  await flush();
  assert.equal(migrated.length, 0, '확인 전에는 이관하지 않는다');
  assert.match(document.querySelector('[role="dialog"]').textContent, /한 브랜드에만 이관/);
  click(buttonByText(document, '발신자 확인 · 이관'));
  await flush(); await flush();
  assert.deepEqual(migrated, [['acc-2', 'brand-1', ['ct-legacy']]]);
  assert.equal(Boolean(container.querySelector('input[type="checkbox"]')), false, '이미 이관한 증거는 다시 선택하지 못한다');
  click(buttonByText(container, '이 브랜드 수신거부'));
  await flush();
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /AWB Team 수신거부/);
  typeInto(dialog.querySelector('textarea'), '전화로 브랜드 수신거부 요청');
  click(buttonByText(dialog, '수신거부 기록'));
  await flush();
  assert.deepEqual(unsubscribed, [['ct-legacy', '전화로 브랜드 수신거부 요청', 'acc-2', 'brand-1']]);
});


test('재확인 회신함: 계정 범위, 평문 표시, 연락처 찾기와 페이지 이동', async (t) => {
  const content = '<img src=x onerror=alert(1)> 그만 보내 주세요. [link](https://example.com)';
  const { container, calls } = await render(t, {
    entry: '/marketing/contacts?account=acc-2&list=newsletter',
    permissions: ['marketing.manage'],
    stubs: {
      listMarketingContacts: async () => ({ total: 0, contacts: [] }),
      listMarketingContactReplies: async (_account, offset) => ({ total: 51, replies: [{
        id: `reply-${offset}`, brand_id: 'brand-1', created_at: '2026-10-23T00:00:00Z', content,
        contact: { id: 'ct-1', email: 'reader@example.com', name: 'Reader' },
      }] }),
    },
  });
  const panel = container.querySelector('[data-testid="marketing-contact-replies"]');
  assert.ok(panel);
  assert.ok(panel.textContent.includes(content));
  assert.equal(Boolean(panel.querySelector('img, a')), false, 'external content stays plain text');
  assert.equal(calls.find((c) => c[0] === 'listMarketingContactReplies')[1], 'acc-2');
  click(buttonByText(panel, '연락처 찾기'));
  await flush();
  const search = calls.filter((c) => c[0] === 'listMarketingContacts').at(-1);
  assert.equal(search[2].q, 'reader@example.com');
  assert.equal(search[2].list, undefined, 'clear unrelated list filters so the reply author can be found');
  click(buttonByText(panel, '다음 회신'));
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'listMarketingContactReplies').at(-1).slice(1), ['acc-2', 50]);
});
