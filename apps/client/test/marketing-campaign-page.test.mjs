// Marketing 캠페인 화면의 승인 흐름 렌더 회귀(docs/marketing.md "원칙"). jsdom 위에 실제 페이지를
// 띄워 클릭 · 입력을 태우고, 나가는 REST 호출과 화면 상태를 단언한다.
//
// 고정하는 계약:
//   1. 승인함이 사람을 기다리는 것을 다 보여 준다 — 결과 불명 결제(경보 문구), 2인 승인 상태, 채널 제안의
//      홍보 규칙 인용과 근거 링크(http(s) 만 · noopener), 실제로 나갈 본문, 편성 제안.
//   2. 지출 승인은 확인 단계("이 금액의 결제를 승인합니다")를 거쳐야만 나가고, 화면이 보여 준 요청의
//      payload_sha256 을 그대로 보낸다. final:false(2인 규칙의 첫 승인)는 그렇게 알린다.
//   3. 이미 승인한 사람에게는 같은 요청의 승인 버튼이 없다(두 번째 승인은 다른 사람).
//   4. 게시 초안 거부는 사유를 받아야 나가고, 그 사유를 그대로 보낸다.
//   5. 승인된(보내기 전) 지출은 "취소(보내기 전)" 로 닫을 수 있다.
//   6. `marketing_update` 가 이 캠페인 것이면(디바운스 뒤) 다시 읽고, 다른 캠페인 것이면 읽지 않는다.
//   7. 지출 승인 권한이 없으면 돈 버튼이 없다(읽기 전용).
//   8. 서버가 읽은 참여(docs/marketing.md "참여 지표 자동 수집") — 게시물 카드의 읽은 값 · 다음 읽기 · 끝 · 실패, 지표 표의
//      자동 수집 행(부호 붙은 변화량), 서버가 읽는 채널의 참여 · 답글 기록은 화면이 먼저 막는다.
//
// 실행: node --import tsx --test --test-force-exit test/marketing-campaign-page.test.mjs
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
import { MARKETING_REFRESH_DEBOUNCE_MS, SECOND_APPROVAL_MESSAGE, UNKNOWN_SPEND_MESSAGE } from '../src/components/marketing/marketing.logic.ts';

const h = React.createElement;
const flush = async (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667788990aabbccddeeff';
const NOW = Date.now();
const iso = (offsetMin) => new Date(NOW + offsetMin * 60_000).toISOString();

function campaign(overrides = {}) {
  return {
    id: 'c-1', account_id: 'acc-1', project_id: null, name: 'AWB 런칭', slug: 'awb-launch-ab12', status: 'active',
    product_brief: '셀프호스팅 에이전트 보드', goal: '가입 300명', target_audience: '셀프호스터',
    capabilities: ['channel_discovery', 'community_post', 'paid_spend'],
    agent_runtime: { manager_agent_id: 'host-1', cli: 'claude', model: null, working_dir: '/srv/awb', label: 'marketer' },
    agent_key: 'rt-1', cycle_cron: null, cycle_interval_ms: 86_400_000, next_cycle_at: iso(60), last_cycle_at: null, cycle_count: 2,
    currency: 'KRW', budget_total_minor: 1_000_000, budget_period: 'month', budget_period_minor: 500_000, max_transaction_minor: 0,
    dual_approval_threshold_minor: 100_000, payment_provider: 'manual', payment_credential_id: null,
    payees: [{ name: 'Reddit Ads' }], allowed_domains: ['awb.dev'], disclosure: '— 제품 제작자가 작성했습니다',
    limits: {}, limit_overrides: {}, feedback_ticket_status: 'backlog', improvement_assignee: null,
    created_by: 'u-1', created_at: iso(-600), updated_at: iso(-10),
    ...overrides,
  };
}

const channels = [
  {
    id: 'ch-proposed', account_id: 'acc-1', campaign_id: 'c-1', platform: 'reddit', kind: 'outreach', name: 'r/selfhosted',
    target: 'selfhosted', status: 'proposed', rationale: '셀프호스팅 도구 소개가 활발하다', audience_fit: '', audience_size: 450000,
    audience_observed_at: iso(-1440), evidence_urls: ['https://reddit.com/r/selfhosted/about', 'javascript:alert(1)'],
    rules_summary: '자기 홍보는 글 10개 중 1개까지', rules_url: 'https://reddit.com/r/selfhosted/wiki/rules', guidelines: '',
    outreach_channel_id: null, email: null, proposed_by_type: 'agent', proposed_by_id: 'rt-1', proposed_by_name: 'marketer',
    decided_by: null, decided_by_name: null, decided_at: null, decision_note: '', created_at: iso(-120), updated_at: iso(-120),
  },
  {
    id: 'ch-forum', account_id: 'acc-1', campaign_id: 'c-1', platform: 'forum', kind: 'manual', name: 'Dev forum', target: 'https://forum.example',
    status: 'active', rationale: '', audience_fit: '', audience_size: null, audience_observed_at: null, evidence_urls: [], rules_summary: '',
    rules_url: '', guidelines: '링크는 글 끝에 하나만', outreach_channel_id: null, email: null, proposed_by_type: 'user', proposed_by_id: 'u-1',
    proposed_by_name: 'Owner', decided_by: 'u-1', decided_by_name: 'Owner', decided_at: iso(-300), decision_note: '', created_at: iso(-400), updated_at: iso(-300),
  },
];

const draftPost = {
  id: 'post-1', account_id: 'acc-1', campaign_id: 'c-1', channel_id: 'ch-forum', kind: 'post', title: 'AWB 를 소개합니다',
  body: '에이전트가 티켓을 끝까지 처리합니다.', preview_body: '에이전트가 티켓을 끝까지 처리합니다.\n\n— 제품 제작자가 작성했습니다',
  final_body: '', reply_to: '', target: '', status: 'draft', rationale: '포럼의 도구 소개 주간', created_by_type: 'agent', created_by_name: 'marketer',
  cycle_id: 'cy-2', decided_by_name: null, decided_at: null, decision_note: '', edited: false, permalink: '', published_at: null, error: '',
  link_codes: [], created_at: iso(-30), updated_at: iso(-30),
};

const allocation = {
  id: 'al-1', campaign_id: 'c-1', channel_id: 'ch-forum', batch_id: 'b-1', amount_minor: 200_000, amount_text: '200,000 KRW', currency: 'KRW',
  status: 'proposed', rationale: '지난달 클릭 대비 가입이 가장 좋았다', proposed_by_type: 'agent', proposed_by_name: 'marketer',
  decided_by_name: null, decided_at: null, decision_note: '', supersedes_id: null, created_at: iso(-20),
};

function spend(id, overrides = {}) {
  return {
    id, account_id: 'acc-1', campaign_id: 'c-1', channel_id: 'ch-forum', amount_minor: 150_000, amount_text: '150,000 KRW', currency: 'KRW',
    payee: 'Reddit Ads', payee_ref: 'acct-77', purpose: '포럼 배너 1주', expected_outcome: '가입 30명, 추적 링크로 측정',
    provider: 'manual', payload: { placement: 'sidebar', weeks: 1 }, payload_sha256: HASH, dual_required: true, status: 'pending',
    requested_by_type: 'agent', requested_by_name: 'marketer', cycle_id: 'cy-2', approvals: [], decided_by_name: null, decided_at: null,
    decision_note: '', expires_at: iso(60 * 24), period_key: '2026-10', executing_at: null, paid_at: null, provider_ref: '', receipt_url: '',
    provider_response: {}, error: '', created_at: iso(-15), updated_at: iso(-15),
    ...overrides,
  };
}

const budget = {
  currency: 'KRW', payment_provider: 'manual',
  caps: { budget_total_minor: 1_000_000, budget_period: 'month', budget_period_minor: 500_000, max_transaction_minor: 0, dual_approval_threshold_minor: 100_000 },
  period: { key: '2026-10', start: iso(-30000), end: iso(30000) },
  total: { held: 0, spent: 0, cap: 1_000_000, available: 1_000_000 },
  period_usage: { held: 0, spent: 0, cap: 500_000, available: 500_000 },
  allocated_total_minor: 0, pending_allocations: 1, spend_counts: { pending: 3, unknown: 1, approved: 1 },
  channels: [{ channel_id: 'ch-forum', name: 'Dev forum', platform: 'forum', status: 'active', allocation_minor: null, allocation_id: null,
    period_held_minor: 0, period_spent_minor: 0, period_available_minor: null, spent_all_time_minor: 0 }],
  text: { total: '', period: '' },
};

const SPEND_BY_STATUS = {
  pending: [
    spend('sp-1'),
    spend('sp-mine', { amount_minor: 300_000, approvals: [{ user_id: 'u-approver', name: 'Approver', at: iso(-5) }] }),
    spend('sp-other', { amount_minor: 120_000, approvals: [{ user_id: 'u-someone', name: 'Someone', at: iso(-5) }] }),
  ],
  unknown: [spend('sp-unknown', { provider: 'webhook', status: 'unknown', amount_minor: 90_000, dual_required: false, error: 'timeout after 20s' })],
  approved: [spend('sp-approved', { status: 'approved', amount_minor: 40_000, dual_required: false, decided_by_name: 'Approver', decided_at: iso(-3) })],
};

async function renderPage(t, { permissions = ['marketing.manage', 'marketing.approve_spend'], stubs = {}, entry = '/marketing/c-1?tab=inbox' } = {}) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  // ToastProvider 가 알림음을 만들지만 jsdom 에는 Audio 가 없다 — 무해한 스텁.
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} };
  localStorage.setItem('auth_token', 'test-token');
  const { FakeEventSource, uninstall } = installFakeEventSource();
  const calls = [];
  const originals = {};
  const all = {
    getMe: async () => ({
      id: 'u-approver', name: 'Approver', status: 'active', resolved_permissions: permissions,
      accounts: [{ id: 'acc-1', name: 'Owner', slug: null, relations: ['owner'] }],
    }),
    getMarketingCampaign: async () => campaign(),
    listMarketingChannels: async () => channels,
    listMarketingPosts: async (_id, opts = {}) => (opts.status === 'draft' ? [draftPost] : []),
    listMarketingAllocations: async () => [allocation],
    listMarketingSpendRequests: async (_id, opts = {}) => SPEND_BY_STATUS[opts.status] || [],
    getMarketingBudget: async () => budget,
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
  return { container: view.container, calls, FakeEventSource };
}

function within(container, testId) {
  const el = container.querySelector(`[data-testid="${testId}"]`);
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

test('승인함 — 결과 불명 결제 · 2인 승인 · 채널 근거와 규칙 · 나갈 본문 · 편성 제안을 보여 준다', async (t) => {
  const { container, calls } = await renderPage(t);

  const inboxTab = [...container.querySelectorAll('[role="tab"]')].find((el) => el.getAttribute('aria-selected') === 'true');
  assert.ok(inboxTab, '선택된 탭이 있다');
  assert.equal(inboxTab.textContent, '승인함 (8)', '결정 대기 7 + 마무리 1(승인된 수동 지출)');

  // 상태별 조회로 채운다 — 최근 목록만 보면 오래 기다린 건이 빠진다.
  const spendStatuses = calls.filter((c) => c[0] === 'listMarketingSpendRequests').map((c) => c[2]?.status).sort();
  assert.deepEqual(spendStatuses, ['approved', 'pending', 'unknown']);
  assert.deepEqual(calls.filter((c) => c[0] === 'listMarketingPosts').map((c) => c[2]?.status).sort(), ['approved', 'draft']);

  const unknown = within(container, 'marketing-spend-unknown-sp-unknown');
  assert.ok(unknown.textContent.includes(UNKNOWN_SPEND_MESSAGE), '결과 불명 경보 문구');
  assert.match(unknown.textContent, /timeout after 20s/);
  const unknownCard = within(container, 'marketing-spend-sp-unknown');
  assert.ok(hasButton(unknownCard, '결제 완료 기록…') && hasButton(unknownCard, '실패로 기록…'), '사람이 대조해 기록한다');
  assert.equal(hasButton(unknownCard, '승인…'), false);

  assert.equal(within(container, 'marketing-spend-dual-sp-1').textContent, '2인 승인 필요');
  assert.equal(within(container, 'marketing-spend-dual-sp-other').textContent, '1/2 승인');
  assert.equal(within(container, 'marketing-spend-amount-sp-1').textContent, '150,000 KRW');
  assert.equal(within(container, 'marketing-spend-hash-sp-1').textContent, HASH.slice(0, 12));
  assert.match(within(container, 'marketing-spend-payload-sp-1').textContent, /"placement": "sidebar"/, '실행 payload 전체');
  const sp1 = within(container, 'marketing-spend-sp-1');
  for (const text of ['Reddit Ads (acct-77)', 'Dev forum', '포럼 배너 1주', '가입 30명, 추적 링크로 측정']) {
    assert.ok(sp1.textContent.includes(text), `지출 카드에 "${text}" 가 없다`);
  }

  const proposed = within(container, 'marketing-channel-ch-proposed');
  assert.match(proposed.textContent, /자기 홍보는 글 10개 중 1개까지/, '홍보 규칙 인용');
  const links = [...proposed.querySelectorAll('a')];
  assert.ok(links.some((a) => a.getAttribute('href') === 'https://reddit.com/r/selfhosted/about'), '근거 URL 이 링크로');
  assert.equal(links.some((a) => (a.getAttribute('href') || '').startsWith('javascript:')), false, 'javascript: 는 링크가 되지 않는다');
  for (const a of links) {
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer', `${a.getAttribute('href')} 의 rel`);
    assert.equal(a.getAttribute('target'), '_blank');
  }

  const preview = within(container, 'marketing-post-preview-post-1');
  assert.equal(preview.textContent, draftPost.preview_body, '승인하면 실제로 나갈 본문(공개 문구 포함)');
  assert.match(within(container, 'marketing-post-post-1').textContent, /링크는 글 끝에 하나만/, '채널 가이드가 승인 화면에 같이 보인다');
  assert.match(within(container, 'marketing-allocation-al-1').textContent, /200,000 KRW/);
});

test('지출 승인 — 확인 단계를 거쳐야만 나가고, 화면이 보여 준 payload_sha256 을 보낸다', async (t) => {
  const approvals = [];
  const { container } = await renderPage(t, {
    stubs: {
      approveMarketingSpend: async (id, sha, note) => {
        approvals.push([id, sha, note]);
        return { ...spend(id), approvals: [{ user_id: 'u-approver', name: 'Approver', at: iso(0) }], final: false };
      },
    },
  });

  click(buttonIn(within(container, 'marketing-spend-sp-1'), '승인…'));
  await flush();
  const dialog = within(document, 'marketing-spend-approve-dialog');
  assert.match(dialog.textContent, /150,000 KRW/);
  assert.match(dialog.textContent, /Reddit Ads \(acct-77\)/);
  assert.ok(dialog.textContent.includes(HASH.slice(0, 12)), '해시 앞 12자');
  assert.match(dialog.textContent, /이 금액의 결제를 승인합니다/);

  const confirm = within(document, 'marketing-spend-approve-confirm');
  assert.equal(confirm.disabled, true, '확인을 체크하기 전에는 승인 버튼이 꺼져 있다');
  click(confirm);
  await flush();
  assert.equal(approvals.length, 0, '확인 없이 승인 요청이 나가지 않는다');

  click(within(document, 'marketing-spend-approve-check'));
  assert.equal(confirm.disabled, false, '확인을 체크하면 켜진다');
  click(confirm);
  await flush();
  await flush();

  assert.deepEqual(approvals, [['sp-1', HASH, '']], '보여 준 요청의 해시 그대로');
  assert.equal(Boolean(document.querySelector('[data-testid="marketing-spend-approve-dialog"]')), false, '승인 뒤 확인 창이 닫힌다');
  assert.ok(document.body.textContent.includes(SECOND_APPROVAL_MESSAGE), 'final:false 는 두 번째 승인을 기다린다고 알린다');
});

test('이미 첫 승인을 한 사람에게는 그 요청의 승인 버튼이 없다', async (t) => {
  const { container } = await renderPage(t);
  const mine = within(container, 'marketing-spend-sp-mine');
  assert.equal(hasButton(mine, '승인…'), false);
  assert.ok(mine.textContent.includes(SECOND_APPROVAL_MESSAGE));
  assert.equal(within(container, 'marketing-spend-dual-sp-mine').textContent, '1/2 승인');
  assert.ok(hasButton(within(container, 'marketing-spend-sp-other'), '승인…'), '다른 사람이 첫 승인한 요청은 두 번째로 승인할 수 있다');
});

test('게시 초안 거부 — 사유를 적어야 나가고, 그 사유를 그대로 보낸다', async (t) => {
  const rejects = [];
  const { container } = await renderPage(t, {
    stubs: {
      rejectMarketingPost: async (id, note) => { rejects.push([id, note]); return { ...draftPost, status: 'rejected', decision_note: note }; },
    },
  });
  click(buttonIn(within(container, 'marketing-post-post-1'), '거부'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('게시 초안 거부'));
  assert.ok(dialog, '거부 사유 창이 열린다');
  const confirm = buttonIn(dialog, '거부');
  assert.equal(confirm.disabled, true, '사유 없이 거부할 수 없다');

  typeInto(dialog.querySelector('textarea[aria-label="거부 사유"]'), '  톤이 너무 홍보성입니다 — 사용 사례부터 쓰세요  ');
  assert.equal(confirm.disabled, false);
  click(confirm);
  await flush();
  await flush();
  assert.deepEqual(rejects, [['post-1', '톤이 너무 홍보성입니다 — 사용 사례부터 쓰세요']]);
});

test('승인된(보내기 전) 지출은 취소할 수 있다 — 보류한 예산이 풀린다', async (t) => {
  const cancels = [];
  const { container } = await renderPage(t, {
    stubs: { cancelMarketingSpend: async (id, note) => { cancels.push([id, note]); return spend(id, { status: 'cancelled' }); } },
  });
  const approved = within(container, 'marketing-spend-sp-approved');
  assert.ok(hasButton(approved, '결제 완료 기록…'), '수동 결제는 결과를 기록한다');
  click(buttonIn(approved, '취소(보내기 전)'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('승인된 지출 취소(보내기 전)'));
  assert.ok(dialog, '취소 확인 창');
  assert.match(dialog.textContent, /보류한 예산을 풉니다/);
  typeInto(dialog.querySelector('textarea'), '배너 자리가 없어졌다');
  click(buttonIn(dialog, '요청 취소'));
  await flush();
  await flush();
  assert.deepEqual(cancels, [['sp-approved', '배너 자리가 없어졌다']]);
});

test('marketing_update — 이 캠페인 것이면 디바운스 뒤 다시 읽고, 다른 캠페인 것이면 읽지 않는다', async (t) => {
  const { calls, FakeEventSource } = await renderPage(t);
  const source = FakeEventSource.instances.at(-1);
  assert.ok(source, 'SSE 스트림이 열렸다');
  const loads = () => calls.filter((c) => c[0] === 'getMarketingCampaign').length;
  const before = loads();

  act(() => source.emit('marketing_update', { account_id: 'acc-1', campaign_id: 'c-other', kind: 'post', entity_id: 'x', action: 'drafted' }));
  await flush(MARKETING_REFRESH_DEBOUNCE_MS + 50);
  assert.equal(loads(), before, '다른 캠페인의 변경은 무시한다');

  act(() => {
    source.emit('marketing_update', { account_id: 'acc-1', campaign_id: 'c-1', kind: 'post', entity_id: 'p', action: 'drafted' });
    source.emit('marketing_update', { account_id: 'acc-1', campaign_id: 'c-1', kind: 'post', entity_id: 'q', action: 'drafted' });
  });
  await flush(MARKETING_REFRESH_DEBOUNCE_MS + 50);
  await flush();
  assert.equal(loads(), before + 1, '몰려 온 프레임은 한 번만 다시 읽는다');
});

test('지출 승인 권한이 없으면 돈 버튼이 없다 — 예산 · 지출은 읽기 전용', async (t) => {
  const { container } = await renderPage(t, { permissions: ['marketing.manage'] });
  const sp1 = within(container, 'marketing-spend-sp-1');
  assert.equal(hasButton(sp1, '승인…'), false);
  assert.equal(hasButton(sp1, '거부'), false);
  assert.match(sp1.textContent, /marketing\.approve_spend/);
  assert.equal(hasButton(within(container, 'marketing-allocation-al-1'), '승인…'), false);
  assert.ok(hasButton(within(container, 'marketing-post-post-1'), '거부'), '게시 · 채널 결정은 운영 권한으로 한다');
});

test('메일 채널 카드의 "연락처 관리" 는 캠페인의 실행 키 · 수신 목록을 실어 연다', async (t) => {
  const emailChannel = {
    ...channels[1], id: 'ch-mail', platform: 'email', kind: 'email', name: '뉴스레터', target: 'newsletter',
    email: {
      credential_id: 'cred-mail', from_name: 'AWB', from_address: 'news@awb.dev', reply_to: '', postal_address: 'Seoul',
      contact_email: 'help@awb.dev', ad_label: '(광고)', list_name: 'newsletter', provider: 'resend',
    },
  };
  const { container } = await renderPage(t, {
    entry: '/marketing/c-1?tab=channels',
    stubs: {
      getMarketingCampaign: async () => campaign({ account_id: 'acc-org' }),
      listMarketingChannels: async () => [...channels, emailChannel],
    },
  });
  const link = within(container, 'marketing-channel-contacts-ch-mail');
  assert.equal(link.textContent, '연락처 관리');
  const href = new URL(link.getAttribute('href'), 'http://localhost');
  assert.equal(href.pathname, '/marketing/contacts');
  assert.equal(href.searchParams.get('account'), 'acc-org', '캠페인의 실행 키');
  assert.equal(href.searchParams.get('campaign'), 'c-1');
  assert.equal(href.searchParams.get('list'), 'newsletter');
});

test('메일 채널 카드 — 스팸 신고율로 멈춘 목록을 알리고 사유와 함께 해제하며, webhook 주소 · 서명 키 설정 여부를 보여 준다', async (t) => {
  const hold = {
    id: 'hold-1', account_id: 'acc-org', list_name: 'newsletter', status: 'held', reason: 'complaint_rate',
    stats: { since: iso(-1000), sent: 400, bounced: 0, complained: 2, rate: 0.005 },
    held_at: iso(-10), released_by: '', released_by_name: '', released_at: null, release_note: '',
  };
  const emailChannel = {
    ...channels[1], id: 'ch-mail', platform: 'email', kind: 'email', status: 'active', name: '뉴스레터', target: 'newsletter',
    email: {
      credential_id: 'cred-mail', from_name: 'AWB', from_address: 'news@awb.dev', reply_to: '', postal_address: 'Seoul',
      contact_email: 'help@awb.dev', ad_label: '(광고)', list_name: 'newsletter', provider: 'resend',
    },
    email_hold: hold,
    email_webhooks: { provider: 'resend', events_url: 'https://awb.example.com/api/m/email/cred-mail/events', inbound_url: null, events_signing: false, inbound_signing: false },
  };
  const released = [];
  const { container } = await renderPage(t, {
    entry: '/marketing/c-1?tab=channels',
    stubs: {
      getMarketingCampaign: async () => campaign({ account_id: 'acc-org' }),
      listMarketingChannels: async () => [...channels, emailChannel],
      releaseMarketingListHold: async (id, note, accountId) => { released.push([id, note, accountId]); return { ...hold, status: 'released' }; },
    },
  });
  const card = within(container, 'marketing-channel-ch-mail');
  within(container, 'marketing-channel-hold-ch-mail');
  assert.match(within(container, 'marketing-list-hold-hold-1').textContent, /스팸 신고율 0\.50% — 신고 2 \/ 닿은 메일 400/);
  const setup = within(container, 'marketing-channel-webhooks-ch-mail');
  assert.equal(setup.hasAttribute('open'), true, '서명 키가 없으면 설정 안내를 펼쳐 둔다');
  assert.match(setup.textContent, /https:\/\/awb\.example\.com\/api\/m\/email\/cred-mail\/events/);
  assert.match(setup.textContent, /webhook_secret 칸을 넣기 전까지/);

  click(buttonIn(card, '발송 재개…'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('메일 발송 재개'));
  assert.ok(dialog, '해제 창이 열린다');
  const confirm = buttonIn(dialog, '발송 재개');
  assert.equal(confirm.disabled, true, '사유 없이 해제할 수 없다');
  typeInto(dialog.querySelector('textarea'), '  가입 폼 밖에서 가져온 묶음을 지웠다  ');
  click(confirm);
  await flush();
  await flush();
  assert.deepEqual(released, [['hold-1', '가입 폼 밖에서 가져온 묶음을 지웠다', 'acc-org']], '캠페인의 실행 키로 해제한다');
});

test('답글 승인 카드 — 서버가 확인한 스레드(r/<대상> — 제목)를 글자로 보여 주고, 확인 안 된 답글은 경고한다', async (t) => {
  const redditChannel = {
    ...channels[0], id: 'ch-reddit', status: 'active', kind: 'outreach', outreach_channel_id: 'oc-1', name: 'r/selfhosted',
  };
  const verified = {
    ...draftPost, id: 'reply-ok', channel_id: 'ch-reddit', kind: 'reply', title: '', reply_to: 't3_abc123',
    reply_context: { target: 'selfhosted', permalink: 'https://reddit.com/r/selfhosted/comments/abc123', title: '<img src=x onerror=alert(1)> Best self-hosted boards?' },
  };
  const unverified = { ...draftPost, id: 'reply-unverified', channel_id: 'ch-reddit', kind: 'reply', title: '', reply_to: 't3_zzz999', reply_context: {} };
  const { container } = await renderPage(t, {
    stubs: {
      listMarketingChannels: async () => [...channels, redditChannel],
      listMarketingPosts: async (_id, opts = {}) => (opts.status === 'draft' ? [verified, unverified] : []),
    },
  });
  const context = within(container, 'marketing-post-reply-context-reply-ok');
  assert.match(context.textContent, /답글 대상: r\/selfhosted — <img src=x onerror=alert\(1\)> Best self-hosted boards\?/, '외부인이 쓴 제목은 글자 그대로');
  assert.equal(context.querySelectorAll('img').length, 0, '제목이 마크업이 되지 않는다');
  const link = context.querySelector('a');
  assert.ok(link, '스레드 링크');
  assert.equal(link.getAttribute('href'), 'https://reddit.com/r/selfhosted/comments/abc123');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');

  const card = within(container, 'marketing-post-reply-unverified');
  assert.equal(Boolean(card.querySelector('[data-testid="marketing-post-reply-context-reply-unverified"]')), false, '빈 reply_context({})는 대상으로 그리지 않는다');
  assert.match(card.textContent, /확인되지 않았습니다 — 승인해도 서버가 게시하지 않습니다/);
});

function fieldIn(root, labelText, tag = 'input') {
  const label = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === labelText);
  assert.ok(label, `"${labelText}" 라벨이 없습니다`);
  const field = label.parentElement?.querySelector(tag);
  assert.ok(field, `"${labelText}" 의 <${tag}> 가 없습니다`);
  return field;
}

test('예산 설정 — 열려 있는 동안 다른 승인자가 바꾼 값을, 건드리지 않은 칸이 되돌리지 않는다', async (t) => {
  let current = campaign();
  const patches = [];
  const { container, FakeEventSource } = await renderPage(t, {
    entry: '/marketing/c-1?tab=budget',
    stubs: {
      getMarketingCampaign: async () => current,
      updateMarketingCampaign: async (id, patch) => { patches.push([id, patch]); return { ...current, ...patch }; },
      listMarketingLedger: async () => [],
      listCredentials: async () => [],
    },
  });
  click(buttonIn(container, '예산 설정…'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('예산 설정'));
  assert.ok(dialog, '예산 설정 창');
  assert.equal(fieldIn(dialog, '2인 승인 기준 (0 = 끔)').value, '100000');

  // 다른 승인자가 그사이 2인 승인 기준을 낮추고 수취인을 더했다 — marketing_update 로 화면이 다시 읽는다.
  current = campaign({ dual_approval_threshold_minor: 50_000, payees: [{ name: 'Reddit Ads' }, { name: 'Google Ads' }] });
  act(() => FakeEventSource.instances.at(-1).emit('marketing_update', { account_id: 'acc-1', campaign_id: 'c-1', kind: 'campaign', entity_id: 'c-1', action: 'updated' }));
  await flush(MARKETING_REFRESH_DEBOUNCE_MS + 50);
  await flush();

  typeInto(fieldIn(dialog, '총 예산 (0 = 지출 불가)'), '2000000');
  click(buttonIn(dialog, '저장'));
  await flush();
  await flush();
  assert.deepEqual(patches, [['c-1', { budget_total_minor: 2_000_000 }]], '바꾼 칸만 — 남이 바꾼 임계값 · 수취인을 예전 값으로 보내지 않는다');
});

test('예산 설정 — 통화를 바꾸면 금액 칸을 비우고, 새 통화로 다시 적어야 저장한다', async (t) => {
  const patches = [];
  const { container } = await renderPage(t, {
    entry: '/marketing/c-1?tab=budget',
    stubs: {
      updateMarketingCampaign: async (id, patch) => { patches.push(patch); return { ...campaign(), ...patch }; },
      listMarketingLedger: async () => [],
      listCredentials: async () => [],
    },
  });
  click(buttonIn(container, '예산 설정…'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('예산 설정'));
  typeInto(fieldIn(dialog, '통화'), 'usd');
  assert.equal(fieldIn(dialog, '총 예산 (0 = 지출 불가)').value, '', '500000 KRW 가 500000 USD 로 읽히지 않게 비운다');
  assert.match(dialog.textContent, /통화를 바꿔 금액 칸을 비웠습니다/);
  click(buttonIn(dialog, '저장'));
  await flush();
  assert.equal(patches.length, 0, '금액을 다시 적기 전에는 보내지 않는다');
  assert.match(dialog.textContent, /금액을 모두 새 통화\(USD\)로 다시 적으세요/);

  typeInto(fieldIn(dialog, '총 예산 (0 = 지출 불가)'), '1000.50');
  typeInto(fieldIn(dialog, '기간 상한 (0 = 없음)'), '500');
  typeInto(fieldIn(dialog, '건당 상한 (0 = 없음)'), '0');
  typeInto(fieldIn(dialog, '2인 승인 기준 (0 = 끔)'), '250');
  click(buttonIn(dialog, '저장'));
  await flush();
  await flush();
  // 건당 상한은 0 → 0(통화와 무관하게 "없음")이라 바뀐 것이 아니다 — 싣지 않는다.
  assert.deepEqual(patches, [{
    currency: 'USD', budget_total_minor: 100_050, budget_period_minor: 50_000, dual_approval_threshold_minor: 25_000,
  }]);
});

test('결제 완료 기록 — 검사한 영수증 주소를 정규화해서 보낸다(대문자 스킴 · 공백)', async (t) => {
  const paid = [];
  const { container } = await renderPage(t, {
    stubs: { markMarketingSpendPaid: async (id, body) => { paid.push([id, body]); return spend(id, { status: 'paid' }); } },
  });
  click(buttonIn(within(container, 'marketing-spend-sp-approved'), '결제 완료 기록…'));
  await flush();
  const dialog = dialogs().find((d) => d.textContent.includes('결제 완료 기록'));
  assert.ok(dialog, '결제 기록 창');
  const save = buttonIn(dialog, '기록');
  assert.equal(save.disabled, true, '거래 id 없이는 기록하지 않는다');
  typeInto(fieldIn(dialog, '거래 id (필수)'), ' txn-9 ');
  typeInto(fieldIn(dialog, '영수증 주소 (선택, http/https)'), 'HTTPS://Pay.example/receipts/r 1');
  click(save);
  await flush();
  await flush();
  assert.deepEqual(paid, [['sp-approved', { provider_ref: 'txn-9', receipt_url: 'https://pay.example/receipts/r%201' }]]);
});

test('지출 승인 권한만 — 캠페인 · 채널을 읽고, 돈 탭만 보이며, 부를 수 없는 경로는 부르지 않는다', async (t) => {
  const MANAGE_ONLY = ['listMarketingPosts', 'listMarketingFeedback', 'listMarketingLinks', 'listMarketingMetrics', 'getMarketingReport',
    'listMarketingContacts', 'listOutreachChannels', 'listMarketingPostSends', 'listCredentials'];
  const { container, calls } = await renderPage(t, {
    permissions: ['marketing.approve_spend'],
    stubs: {
      listMarketingCycles: async () => [],
      listMarketingAudit: async () => [{
        id: 'ev-1', campaign_id: 'c-1', entity_type: 'spend_request', entity_id: 'sp-1', action: 'spend.late_result', actor_type: 'system',
        actor_id: 'system', actor_name: 'Marketing', summary: '결제 응답이 늦게 도착함', detail: {}, created_at: iso(-1),
      }],
    },
  });
  assert.ok(calls.some((c) => c[0] === 'getMarketingCampaign'), '캠페인을 읽는다');
  assert.ok(calls.some((c) => c[0] === 'listMarketingChannels'), '채널을 읽는다(이름 · 상태)');

  const tabs = [...container.querySelectorAll('[role="tab"]')].map((el) => el.textContent);
  assert.deepEqual(tabs, ['개요', '승인함 (6)', '예산·결제', '감사 로그'], '편성 1 + 대기 지출 3 + 결과 불명 1 + 수동 결제 기록 1');

  const inbox = within(container, 'marketing-inbox');
  assert.equal(Boolean(inbox.querySelector('[data-testid="marketing-channel-ch-proposed"]')), false, '채널 제안은 지출 승인자의 일이 아니다');
  assert.equal(Boolean(inbox.querySelector('[data-testid="marketing-post-post-1"]')), false);
  assert.ok(hasButton(within(container, 'marketing-spend-sp-1'), '승인…'), '지출은 승인할 수 있다');
  assert.ok(hasButton(within(container, 'marketing-allocation-al-1'), '승인…'), '편성은 승인할 수 있다');
  assert.equal(hasButton(container, '지금 실행') || hasButton(container, '설정') || hasButton(container, '삭제'), false, '캠페인 운영 버튼이 없다');

  click([...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent === '개요'));
  await flush();
  await flush();
  assert.ok(calls.some((c) => c[0] === 'listMarketingCycles'), '개요는 읽기 전용으로 열린다');
  assert.equal(/시작하려면/.test(container.textContent), false, '고칠 수 없는 시작 조건은 말하지 않는다');

  click([...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent === '감사 로그'));
  await flush();
  await flush();
  assert.equal(within(container, 'marketing-audit-ev-1').getAttribute('data-tone'), 'warning', 'spend.late_result 는 경고로 칠한다');

  click([...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent === '예산·결제'));
  await flush();
  await flush();
  assert.equal(hasButton(container, '예산 설정…'), false, '예산 설정 저장은 운영 권한도 필요하다');
  assert.ok(hasButton(container, '예산 직접 편성…'));

  const forbidden = calls.filter((c) => MANAGE_ONLY.includes(c[0])).map((c) => c[0]);
  assert.deepEqual(forbidden, [], '운영 권한 전용 경로를 부르지 않는다(로드 중 403 이 없다)');
  assert.equal(Boolean(document.querySelector('[data-testid="marketing-partial-errors"]')), false);
});

test('운영 권한만 — 승인함 수는 처리할 수 있는 채널 · 게시물만 센다(돈 항목은 읽기 전용으로 보인다)', async (t) => {
  const { container } = await renderPage(t, { permissions: ['marketing.manage'] });
  const selected = [...container.querySelectorAll('[role="tab"]')].find((el) => el.getAttribute('aria-selected') === 'true');
  assert.equal(selected.textContent, '승인함 (2)', '채널 제안 1 + 초안 1 — 사이드바 배지와 같은 규칙');
  assert.ok(container.querySelector('[data-testid="marketing-spend-sp-1"]'), '지출은 읽기 전용으로 보인다');
});

const redditOutreach = { ...channels[0], id: 'ch-reddit', status: 'active', kind: 'outreach', outreach_channel_id: 'oc-1', name: 'r/selfhosted' };
const githubOutreach = {
  ...channels[0], id: 'ch-github', platform: 'github', target: 'acme/widget', status: 'active', kind: 'outreach', outreach_channel_id: 'oc-2', name: 'acme/widget',
};

function choose(select, value) {
  run(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('참여 자동 수집 — 게시물 카드가 읽은 값 · 다음 읽기 · 끝 · 실패를 보이고, manual 글에는 없다', async (t) => {
  const published = (id, channelId, extra) => ({
    ...draftPost, id, channel_id: channelId, status: 'published', permalink: 'https://www.reddit.com/r/selfhosted/comments/x', published_at: iso(-600), ...extra,
  });
  const posts = [
    published('pub-live', 'ch-reddit', { engagement: { engagements: 57, replies: 12, read_at: iso(-30) }, engagement_next_at: iso(30), engagement_error: '' }),
    published('pub-done', 'ch-github', { engagement: { engagements: 5, replies: null, read_at: iso(-60) }, engagement_next_at: null, engagement_error: '' }),
    published('pub-fail', 'ch-reddit', { engagement: null, engagement_next_at: iso(60), engagement_error: 'Reddit API GET /api/info failed (503)' }),
    published('pub-manual', 'ch-forum', { engagement: null, engagement_next_at: null, engagement_error: '' }),
    // 이 기능 전 · 기간 밖에 게시돼 수집기가 맡은 적 없는 글 — 읽은 적도 읽을 일도 없다.
    published('pub-untracked', 'ch-reddit', { engagement: null, engagement_next_at: null, engagement_error: '' }),
    published('pub-hidden', 'ch-reddit', { kind: 'reply', engagement: { engagements: null, replies: null, read_at: iso(-5) }, engagement_next_at: iso(55), engagement_error: '' }),
  ];
  const { container } = await renderPage(t, {
    entry: '/marketing/c-1?tab=content',
    stubs: {
      listMarketingChannels: async () => [...channels, redditOutreach, githubOutreach],
      listMarketingPosts: async () => posts,
    },
  });
  assert.match(within(container, 'marketing-post-engagement-pub-live').textContent, /^점수 57 · 댓글 12 · .+ 읽음 · 다음 .+$/);
  assert.match(within(container, 'marketing-post-engagement-pub-done').textContent, /^반응 5 · .+ 읽음 · 수집 끝$/, '답글(댓글 수 없음) · 기간이 끝난 글');
  assert.match(within(container, 'marketing-post-engagement-pub-fail').textContent, /^아직 읽지 않음 · 다음 .+ · Reddit API GET \/api\/info failed \(503\)$/);
  assert.equal(Boolean(container.querySelector('[data-testid="marketing-post-engagement-pub-manual"]')), false, '사람이 올린 manual 글은 서버가 읽지 않는다');
  assert.equal(Boolean(container.querySelector('[data-testid="marketing-post-engagement-pub-untracked"]')), false, '수집기가 맡은 적 없는 글에 "아직 읽지 않음" 을 영원히 띄우지 않는다');
  assert.match(within(container, 'marketing-post-engagement-pub-hidden').textContent, /^플랫폼이 값을 아직 감춤 · .+ 읽음 · 다음 .+$/);
});

test('지표 표 — 자동 수집 행은 부호 붙은 변화량으로 보이고, 서버가 읽는 채널의 참여 · 답글 기록은 화면이 막는다', async (t) => {
  const metric = (id, fields) => ({
    id, campaign_id: 'c-1', channel_id: 'ch-reddit', post_id: 'pub-live', link_id: '', observed_at: iso(-30), created_at: iso(-30),
    recorded_by_type: 'system', recorded_by_name: 'Marketing', ...fields,
  });
  const metrics = [
    metric('m-1', { metric: 'engagements', value: 12, source: 'connector', note: 'reddit score 45 → 57' }),
    metric('m-2', { metric: 'replies', value: -1, source: 'connector', note: 'reddit comments 13 → 12' }),
    metric('m-3', { channel_id: 'ch-forum', post_id: '', metric: 'impressions', value: 900, source: 'agent', recorded_by_type: 'agent', recorded_by_name: 'marketer', note: 'forum stats' }),
  ];
  const emptyRow = {
    posts_published: 0, metrics: { clicks: 0, impressions: 0, views: 0, engagements: 0, replies: 0, signups: 0, conversions: 0, revenue_minor: 0 },
    spent_minor: 0, feedback: 0, inbound_items: 0, feedback_tickets: 0,
    derived: { cpc_minor: null, cost_per_signup_minor: null, cost_per_conversion_minor: null, ctr: null, conversion_rate: null, roas: null },
  };
  const { container, calls } = await renderPage(t, {
    entry: '/marketing/c-1?tab=analytics',
    stubs: {
      listMarketingChannels: async () => [...channels, redditOutreach],
      getMarketingReport: async () => ({ since: iso(-43200), until: iso(0), currency: 'KRW', channels: [], totals: emptyRow, lines: [], caveats: [] }),
      listMarketingLinks: async () => [],
      listMarketingMetrics: async () => metrics,
      recordMarketingMetrics: async () => [],
    },
  });
  const rows = [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
  const byNote = (note) => rows.find((r) => r.includes(note));
  assert.deepEqual(byNote('reddit score 45 → 57').slice(2, 5), ['+12', 'r/selfhosted', '자동 수집']);
  assert.deepEqual(byNote('reddit comments 13 → 12').slice(2, 5), ['-1', 'r/selfhosted', '자동 수집']);
  assert.deepEqual(byNote('forum stats').slice(2, 5), ['900', 'Dev forum', 'marketer'], '사람 · 에이전트 관측치는 그대로');

  const recordCalls = () => calls.filter(([name]) => name === 'recordMarketingMetrics');
  choose(fieldIn(container, '지표', 'select'), 'engagements');
  choose(fieldIn(container, '채널 (선택)', 'select'), 'ch-reddit');
  typeInto(fieldIn(container, '값'), '5');
  await act(async () => { click(buttonIn(container, '기록')); });
  await flush();
  assert.equal(recordCalls().length, 0, '서버가 읽는 채널의 참여는 보내지 않는다');
  assert.match(container.querySelector('[role="alert"]')?.textContent || '', /서버가 게시물에서 직접 읽습니다/);

  choose(fieldIn(container, '채널 (선택)', 'select'), '');
  await act(async () => { click(buttonIn(container, '기록')); });
  await flush();
  assert.equal(recordCalls().length, 0, '그런 채널이 있는 캠페인의 캠페인 전체 참여도 보내지 않는다');
  assert.match(container.querySelector('[role="alert"]')?.textContent || '', /채널을 고르세요/);

  choose(fieldIn(container, '채널 (선택)', 'select'), 'ch-forum');
  await act(async () => { click(buttonIn(container, '기록')); });
  await flush();
  assert.equal(recordCalls().length, 1);
  assert.deepEqual(recordCalls()[0][2], [{ metric: 'engagements', value: 5, channel_id: 'ch-forum' }]);
});

test('지표 기록 — 제안 단계 reddit 채널뿐이면 캠페인 전체 참여를 막지 않는다(서버가 읽는 채널이 없다)', async (t) => {
  const { container, calls } = await renderPage(t, {
    entry: '/marketing/c-1?tab=analytics',
    stubs: {
      listMarketingChannels: async () => channels,
      getMarketingReport: async () => ({
        since: iso(-43200), until: iso(0), currency: 'KRW', channels: [], lines: [], caveats: [],
        totals: {
          posts_published: 0, metrics: { clicks: 0, impressions: 0, views: 0, engagements: 0, replies: 0, signups: 0, conversions: 0, revenue_minor: 0 },
          spent_minor: 0, feedback: 0, inbound_items: 0, feedback_tickets: 0,
          derived: { cpc_minor: null, cost_per_signup_minor: null, cost_per_conversion_minor: null, ctr: null, conversion_rate: null, roas: null },
        },
      }),
      listMarketingLinks: async () => [],
      listMarketingMetrics: async () => [],
      recordMarketingMetrics: async () => [],
    },
  });
  choose(fieldIn(container, '지표', 'select'), 'replies');
  typeInto(fieldIn(container, '값'), '2');
  await act(async () => { click(buttonIn(container, '기록')); });
  await flush();
  const sent = calls.filter(([name]) => name === 'recordMarketingMetrics');
  assert.equal(sent.length, 1, 'ch-proposed 는 제안 단계라 서버가 읽지 않는다');
  assert.deepEqual(sent[0][2], [{ metric: 'replies', value: 2 }]);
});


test('보관된 캠페인의 승인함에서도 수동 결제 기록과 결과 불명 대조를 할 수 있다', async (t) => {
  const { container, calls } = await renderPage(t, {
    permissions: ['marketing.approve_spend'],
    stubs: {
      getMarketingCampaign: async () => campaign({ status: 'archived' }),
      listMarketingAllocations: async () => [],
      listMarketingSpendRequests: async (_id, opts = {}) => opts.status === 'pending' ? [] : SPEND_BY_STATUS[opts.status] || [],
      markMarketingSpendPaid: async (id) => spend(id, { status: 'paid' }),
      markMarketingSpendFailed: async (id) => spend(id, { status: 'failed' }),
    },
  });
  click(buttonIn(within(container, 'marketing-spend-sp-approved'), '결제 완료 기록…'));
  await flush();
  const paid = dialogs().find((d) => d.textContent.includes('결제 완료 기록'));
  typeInto(fieldIn(paid, '거래 id (필수)'), 'archived-receipt');
  click(buttonIn(paid, '기록'));
  await flush();
  await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'markMarketingSpendPaid'), ['markMarketingSpendPaid', 'sp-approved', { provider_ref: 'archived-receipt' }]);
  click(buttonIn(within(container, 'marketing-spend-sp-unknown'), '실패로 기록…'));
  await flush();
  const failed = dialogs().find((d) => d.textContent.includes('결제 실패로 기록'));
  typeInto(failed.querySelector('textarea[aria-label="확인한 내용"]'), '결제 시스템에서 미결제 확인');
  click(buttonIn(failed, '실패로 기록'));
  await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'markMarketingSpendFailed'), ['markMarketingSpendFailed', 'sp-unknown', '결제 시스템에서 미결제 확인', false]);
});
