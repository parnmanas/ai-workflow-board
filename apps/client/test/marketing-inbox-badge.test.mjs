import { ui, uiPattern } from './helpers/i18n.mjs';
import { setLocale } from '../src/i18n/core.ts';
await setLocale('ko', false);
// 사이드바 "Marketing" 배지(docs/marketing.md) — GET /api/marketing/inbox 의 total 을 그대로 쓴다.
//
// 진짜 Sidebar 를 프로덕션과 같은 provider 스택(Router > Toast > Auth > BoardStream > Notification) 위에 띄우고
// fetch 를 URL 로 스텁한다(sidebar-work-hierarchy.test.mjs 와 같은 방식).
//
// 고정하는 계약:
//   1. 마케팅 권한이 있으면 Marketing 행에 승인 대기 수 배지가 붙고, 읽는 이에게 "승인 대기 N건" 이라고 말한다.
//   2. 서버의 total(이 사용자가 처리할 수 있는 것만)을 그대로 쓴다 — 화면이 캠페인마다 다시 세지 않는다.
//   3. `marketing_update` 가 몰려 오면 잠시 모았다가 한 번만 다시 읽는다.
//   4. 0 이면 배지가 없고, 권한이 없으면 행도 요청도 없다.
//
// 실행: node --import tsx --test --test-force-exit test/marketing-inbox-badge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { NotificationProvider } from '../src/contexts/NotificationContext.tsx';
import { ArtifactPanelProvider } from '../src/contexts/ArtifactPanelContext.tsx';
import Sidebar from '../src/components/Sidebar.tsx';
import { MARKETING_INBOX_REFRESH_DEBOUNCE_MS } from '../src/hooks/useMarketingInbox.ts';

const h = React.createElement;

async function flush(times = 6, ms = 0) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  }
}

function installFetchStub(state) {
  const previous = globalThis.fetch;
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  globalThis.fetch = (url) => {
    const path = String(url);
    state.requests.push(path);
    if (path.includes('/marketing/inbox')) return json(state.inbox);
    if (path.includes('/auth/me')) {
      return json({
        id: 'u1', name: 'Approver', email: 'a@example.com', role: 'user', status: 'active', permissions: [],
        resolved_permissions: state.permissions,
        accounts: [{ id: 'acc-1', name: 'Account', slug: null, relations: ['member'] }],
      });
    }
    if (path.includes('/teams') || path.includes('/orchestration/missions')) return json([]);
    if (path.includes('/tickets/unread-counts')) return json({ total: 0, perTicket: {} });
    if (path.includes('/chat/unread-counts')) return json({ total: 0, perRoom: {} });
    return json({ count: 0, items: [] });
  };
  return () => { globalThis.fetch = previous; };
}

async function mountSidebar(t, { permissions, inbox }) {
  const dom = setupDom({ width: 1280 });
  const previousAudio = globalThis.Audio;
  globalThis.Audio = class { constructor() { this.volume = 0; this.currentTime = 0; } play() { return Promise.resolve(); } pause() {} };
  const { FakeEventSource, uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');
  const state = { permissions, inbox, requests: [] };
  const restoreFetch = installFetchStub(state);
  const view = mount(
    h(MemoryRouter, { initialEntries: ['/tickets'] },
      h(ToastProvider, null,
        h(AuthProvider, null,
          h(BoardStreamProvider, null,
            h(NotificationProvider, null,
              h(ArtifactPanelProvider, null,
                h(Sidebar, { overlay: false, isOpen: false, onClose() {}, accountId: 'acc-1', rooms: [], roomsLoading: false }))))))),
  );
  await flush();
  t.after(() => { view.unmount(); restoreFetch(); uninstall(); globalThis.Audio = previousAudio; dom.cleanup(); });
  return { view, state, FakeEventSource };
}

/** Business 섹션의 Marketing 행 — 기존 승인 배지 계약은 그대로 유지한다. */
function marketingRow(view) {
  const section = view.container.querySelector('section[aria-labelledby="sidebar-business"]');
  if (!section) return null;
  return [...section.querySelectorAll('button')].find((b) => {
    const span = [...b.querySelectorAll('span')].find((s) => s.getAttribute('aria-hidden') !== 'true');
    return span?.textContent?.trim() === ui('Marketing');
  }) || null;
}

const inboxOf = (total) => ({
  total,
  campaigns: total ? [{
    campaign_id: 'c-1', account_id: 'acc-1', name: '런칭', channels_proposed: 9, posts_draft: 9, allocations_proposed: 1,
    spend_pending: total - 1, spend_unknown: 0, manual_awaiting_payment: 0, actionable: total,
  }] : [],
});

test('Marketing 행에 서버가 센 승인 대기 수 배지가 붙고, "승인 대기 N건" 이라고 읽힌다', async (t) => {
  const { view, state } = await mountSidebar(t, { permissions: ['marketing.approve_spend'], inbox: inboxOf(3) });
  const row = marketingRow(view);
  assert.ok(row, '지출 승인 권한만으로도 Marketing 행이 보인다');
  const badge = row.querySelector('[aria-label="승인 대기 3건"]');
  assert.ok(badge, '배지의 접근성 라벨');
  assert.equal(badge.textContent, '3', '서버 total 그대로(채널 · 초안 수는 이 사람이 처리할 수 없어 빠져 있다)');
  assert.equal(badge.getAttribute('title'), '승인 대기 3건');
  assert.equal(state.requests.filter((p) => p.includes('/marketing/inbox')).length, 1, '처음 한 번 읽는다');
});

test('marketing_update 가 몰려 오면 잠시 모았다가 한 번만 다시 읽고, 0 이 되면 배지가 사라진다', async (t) => {
  const { view, state, FakeEventSource } = await mountSidebar(t, { permissions: ['marketing.manage', 'marketing.approve_spend'], inbox: inboxOf(2) });
  assert.equal(marketingRow(view).querySelector('[aria-label="승인 대기 2건"]')?.textContent, '2');
  const source = FakeEventSource.instances.at(-1);
  assert.ok(source, 'SSE 스트림이 열렸다');
  const inboxReads = () => state.requests.filter((p) => p.includes('/marketing/inbox')).length;

  state.inbox = inboxOf(5);
  act(() => {
    for (let i = 0; i < 3; i += 1) {
      source.emit('marketing_update', { account_id: 'acc-1', campaign_id: 'c-1', kind: 'post', entity_id: `p${i}`, action: 'drafted' });
    }
  });
  await flush(1, MARKETING_INBOX_REFRESH_DEBOUNCE_MS / 2);
  assert.equal(inboxReads(), 1, '모으는 동안에는 다시 읽지 않는다');
  await flush(1, MARKETING_INBOX_REFRESH_DEBOUNCE_MS / 2 + 100);
  await flush();
  assert.equal(inboxReads(), 2, '몰려 온 이벤트는 한 번만 다시 읽는다');
  assert.equal(marketingRow(view).querySelector('[aria-label="승인 대기 5건"]')?.textContent, '5');

  state.inbox = inboxOf(0);
  act(() => source.emit('marketing_update', { account_id: 'acc-1', campaign_id: 'c-1', kind: 'spend_request', entity_id: 's', action: 'approved' }));
  await flush(1, MARKETING_INBOX_REFRESH_DEBOUNCE_MS + 100);
  await flush();
  const row = marketingRow(view);
  assert.ok(row, '행은 남는다');
  assert.equal(row.querySelectorAll('[aria-label^="승인 대기"]').length, 0, '0 이면 배지가 없다');
});

test('마케팅 권한이 없으면 행도 승인 대기 요청도 없다', async (t) => {
  const { view, state } = await mountSidebar(t, { permissions: [], inbox: inboxOf(4) });
  assert.equal(Boolean(marketingRow(view)), false);
  assert.equal(state.requests.some((p) => p.includes('/marketing/inbox')), false, '부를 수 없는 경로를 부르지 않는다');
});

test('목록 중지와 해제 이벤트가 관리자의 승인함 배지를 갱신한다', async (t) => {
  const { view, state, FakeEventSource } = await mountSidebar(t, { permissions: ['marketing.manage'], inbox: inboxOf(0) });
  const source = FakeEventSource.instances.at(-1);
  state.inbox = { total: 1, campaigns: [{
    campaign_id: 'c-1', account_id: 'acc-1', name: '런칭', lists_held: 1,
    channels_proposed: 0, posts_draft: 0, allocations_proposed: 0,
    spend_pending: 0, spend_unknown: 0, manual_awaiting_payment: 0, actionable: 1,
  }] };
  act(() => source.emit('marketing_update', { account_id: 'acc-1', campaign_id: 'c-1', kind: 'list', entity_id: 'hold', action: 'held' }));
  await flush(1, MARKETING_INBOX_REFRESH_DEBOUNCE_MS + 100);
  await flush();
  assert.equal(marketingRow(view).querySelector('[aria-label="승인 대기 1건"]')?.textContent, '1');
  state.inbox = inboxOf(0);
  act(() => source.emit('marketing_update', { account_id: 'acc-1', campaign_id: 'c-1', kind: 'list', entity_id: 'hold', action: 'released' }));
  await flush(1, MARKETING_INBOX_REFRESH_DEBOUNCE_MS + 100);
  await flush();
  assert.equal(marketingRow(view).querySelectorAll('[aria-label^="승인 대기"]').length, 0);
});
