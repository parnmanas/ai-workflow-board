// Tickets 페이지 실마운트 스모크 (board-less, docs/tickets.md).
//
// 순수 로직(필터 ⇄ URL, lane 위치 계산, 정렬)은 ticket-filters / ticket-kanban /
// ticket-list-view-logic 테스트가 고정한다. 여기서는 그 조각들이 실제 페이지에서
// 배선되는지를 프로덕션과 같은 provider 스택 위에서 확인한다:
//   1. URL 필터가 GET /accounts/:wsId/tickets 쿼리로 나가고, 상태 필터에 맞는 lane 만 그린다
//   2. 상태 칩을 누르면 URL 이 바뀌고 새 쿼리로 다시 불러온다
//   3. `?ticket=<id>` 가 상세 패널을 열고(GET /tickets/:id), 닫으면 파라미터가 사라진다
//   4. 워크스페이스 dispatch_paused_at 이면 일시정지 배너가 보인다
//   5. List 보기 전환이 localStorage 에 남고 표로 그린다
//   6. 예전 /boards/* 딥링크는 쿼리를 유지한 채 /tickets 로 리다이렉트된다
//
// 실행: node --import tsx --test --test-force-exit test/tickets-page.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { LoadingProvider } from '../src/contexts/LoadingContext.tsx';
import { ConfirmProvider } from '../src/contexts/ConfirmContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { NotificationProvider } from '../src/contexts/NotificationContext.tsx';
import { TICKET_VIEW_STORAGE_KEY } from '../src/tickets/ticketList.ts';

// @hello-pangea/dnd reads `Element.prototype` at module load — expose the
// bootstrap jsdom window's DOM constructors before importing the page.
globalThis.Element ??= window.Element;
globalThis.HTMLElement ??= window.HTMLElement;
const { default: TicketsPage } = await import('../src/components/tickets/TicketsPage.tsx');
const { LegacyBoardsRedirect } = await import('../src/App.tsx');

const h = React.createElement;
const WS_ID = 'ws-1';
const BASE = ``;

function card(id, status, position, extra = {}) {
  return {
    id, account_id: WS_ID, parent_id: null, title: `Ticket ${id}`, status, priority: 'medium',
    tags: [], project_id: null, base_branch: '', assignee: null, assignee_key: '', position,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
    comments: [], prerequisite_count: 0, children: [], ...extra,
  };
}

const TICKETS = [
  card('t1', 'todo', 0, { tags: ['ui'], project_id: 'p1', assignee_key: 'rt-1', assignee: { manager_agent_id: 'h1', cli: 'claude', working_dir: '/w/awb', label: 'awb' } }),
  card('t2', 'in_progress', 0, { tags: ['ui', 'api'] }),
  card('t3', 'done', 0),
];

function fullTicket(id) {
  const row = TICKETS.find((t) => t.id === id) || TICKETS[0];
  return {
    ...row, description: 'desc', depth: 0, channel_ids: [], comments: [], children: [], attachments: [],
    prerequisites: [], on_done_action_ids: [], next_ticket_id: null, created_by: 'Tester',
    created_by_type: 'user', created_by_id: 'u1', project: null,
  };
}

function installFetchStub(state) {
  const previous = globalThis.fetch;
  const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  globalThis.fetch = (url, init = {}) => {
    const u = new URL(String(url), 'http://localhost');
    const path = u.pathname.replace(/^\/api/, '');
    const method = (init.method || 'GET').toUpperCase();
    state.calls.push({ method, path, search: u.search, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === '/auth/me') {
      return ok({
        id: 'u1', name: 'Tester', email: 't@example.com', role: 'admin', status: 'active',
        permissions: ['admin.access'], resolved_permissions: ['admin.access'],
        accounts: [{ id: WS_ID, name: 'Account', slug: null, relations: [] }],
      });
    }
    if (path === '/auth/setup-status') return ok({ needs_setup: false });
    if (path === '/tickets' && method === 'GET') {
      return ok({ tickets: state.tickets, tags: [{ tag: 'ui', count: 2 }, { tag: 'api', count: 1 }] });
    }
    if (path === '/projects') {
      return ok([{ id: 'p1', account_id: WS_ID, name: 'awb-web', description: '', repo_url: 'x', default_branch: 'main', credential_id: null, clone_policy: null, use_pr: false, instructions: '', default_assignee: null, host_folders: [] }]);
    }
    if (path === '/agent-templates/hosts') return ok([{ id: 'h1', name: 'rolf' }]);
    if (path === `/accounts/${WS_ID}`) return ok({ id: WS_ID, name: 'Account', description: '', dispatch_paused_at: state.pausedAt, created_at: '', updated_at: '' });
    if (path === '/tickets/unread-counts') return ok({ total: 0, perTicket: {} });
    if (path === '/chat-rooms/unread-counts') return ok({ total: 0, perRoom: {} });
    if (path.endsWith('/mentions/unread')) return ok({ count: 0, items: [] });
    const ticketMatch = path.match(/^\/tickets\/([^/]+)$/);
    if (ticketMatch && method === 'GET') return ok(fullTicket(ticketMatch[1]));
    if (path.endsWith('/read-state')) return ok({ ticket_id: 'x', last_read_at: null });
    if (path.includes('/presence')) return ok({ viewers: [] });
    if (path.includes('/mention-candidates')) return ok({ users: [], agents: [] });
    if (path === '/ticket-tags') return ok({ tags: [{ tag: 'ui', count: 2 }, { tag: 'infra', count: 7 }] });
    if (path.includes('/unread-by-source')) return ok({ items: [] });
    return ok([]);
  };
  return () => { globalThis.fetch = previous; };
}

const probe = { pathname: null, search: null };
function LocationProbe() {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.search = location.search;
  return null;
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mountPage(t, { entry = `${BASE}/tickets`, pausedAt = null, view = null } = {}) {
  const dom = setupDom({ width: 1400 });
  // react-resizable-panels (the panel split) observes sizes; jsdom has no ResizeObserver.
  const previousRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  dom.window.ResizeObserver = globalThis.ResizeObserver;
  const previousDOMRect = globalThis.DOMRect;
  globalThis.DOMRect = dom.window.DOMRect || class DOMRect {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      Object.assign(this, { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height });
    }
  };
  const previousAudio = globalThis.Audio;
  globalThis.Audio = class { constructor() { this.volume = 0; this.currentTime = 0; } play() { return Promise.resolve(); } pause() {} };
  const { uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');
  if (view) localStorage.setItem(TICKET_VIEW_STORAGE_KEY, view);
  const state = { tickets: TICKETS, pausedAt, calls: [] };
  const restoreFetch = installFetchStub(state);

  const viewHandle = mount(
    h(MemoryRouter, { initialEntries: [entry] },
      h(ToastProvider, null,
        h(AuthProvider, null,
          h(LoadingProvider, null,
            h(ConfirmProvider, null,
              h(BoardStreamProvider, null,
                h(NotificationProvider, null,
                  h(LocationProbe),
                  h(Routes, null,
                    h(Route, { path: '/tickets', element: h(TicketsPage) }),
                    h(Route, { path: '/boards/*', element: h(LegacyBoardsRedirect) }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await flush();
  t.after(() => {
    viewHandle.unmount();
    restoreFetch();
    uninstall();
    globalThis.Audio = previousAudio;
    globalThis.ResizeObserver = previousRO;
    globalThis.DOMRect = previousDOMRect;
    dom.cleanup();
  });
  return { view: viewHandle, state };
}

const ticketListCalls = (state) => state.calls.filter((c) => c.method === 'GET' && c.path === '/tickets');
const laneStatuses = (view) => [...view.container.querySelectorAll('[data-status-lane]')].map((el) => el.getAttribute('data-status-lane'));

test('① URL 필터가 목록 쿼리로 나가고 상태 필터의 lane 만 그린다', async (t) => {
  const { view, state } = await mountPage(t, { entry: `${BASE}/tickets?status=in_progress,todo&tags=ui` });
  const last = ticketListCalls(state).at(-1);
  assert.ok(last, '목록을 불러와야 한다');
  const qs = new URLSearchParams(last.search);
  assert.equal(qs.get('status'), 'todo,in_progress');
  assert.equal(qs.get('tags'), 'ui');
  assert.deepEqual(laneStatuses(view), ['todo', 'in_progress']);
  const todoLane = view.container.querySelector('[data-status-lane="todo"]');
  assert.match(todoLane.textContent, /Ticket t1/);
  assert.match(todoLane.textContent, /rolf\/awb/, '담당자는 <Host>/<label>');
  assert.match(todoLane.textContent, /awb-web/, '프로젝트 이름');
});

test('② 필터 없으면 5 lane 전부, 상태 칩을 누르면 URL 과 쿼리가 바뀐다', async (t) => {
  const { view, state } = await mountPage(t);
  assert.deepEqual(laneStatuses(view), ['backlog', 'todo', 'in_progress', 'review', 'done']);
  const before = ticketListCalls(state).length;
  const reviewChip = [...view.container.querySelectorAll('[aria-label="상태 필터"] button')].find((b) => b.textContent.includes('Review'));
  assert.ok(reviewChip, 'Review 상태 칩');
  click(reviewChip);
  await flush();
  assert.equal(new URLSearchParams(probe.search).get('status'), 'review');
  const calls = ticketListCalls(state);
  assert.ok(calls.length > before, '필터 변경 후 다시 불러온다');
  assert.equal(new URLSearchParams(calls.at(-1).search).get('status'), 'review');
  assert.deepEqual(laneStatuses(view), ['review']);
});

test('③ ?ticket= 은 상세 패널을 열고, 카드 클릭은 파라미터를 싣고, 닫으면 지운다', async (t) => {
  const { view, state } = await mountPage(t, { entry: `${BASE}/tickets?ticket=t2&status=in_progress` });
  assert.ok(state.calls.some((c) => c.method === 'GET' && c.path === '/tickets/t2'), 'GET /tickets/t2');
  assert.ok(view.container.querySelector('[aria-label="Close ticket panel"], [aria-label="Close"], button[title="Close"]') || /Ticket t2/.test(view.container.textContent));
  assert.equal(new URLSearchParams(probe.search).get('ticket'), 't2');
  assert.equal(new URLSearchParams(probe.search).get('status'), 'in_progress', '필터는 그대로');
});

test('③-b 카드를 누르면 ?ticket= 이 붙는다', async (t) => {
  const { view } = await mountPage(t);
  const cardEl = [...view.container.querySelectorAll('[data-status-lane="done"] [data-rfd-draggable-id], [data-status-lane="done"] [data-rbd-draggable-id]')][0]
    || [...view.container.querySelectorAll('[data-status-lane="done"] h4')][0];
  assert.ok(cardEl, 'done lane 의 카드');
  click(cardEl);
  await flush();
  assert.equal(new URLSearchParams(probe.search).get('ticket'), 't3');
});

test('④ dispatch_paused_at 이면 일시정지 배너', async (t) => {
  const { view } = await mountPage(t, { pausedAt: '2026-10-05T01:00:00Z' });
  const banner = view.container.querySelector('[data-testid="dispatch-paused-banner"]');
  assert.ok(banner, '배너가 보여야 한다');
  assert.match(banner.textContent, /일시정지/);
});

test('④-b 일시정지가 아니면 배너 없음', async (t) => {
  const { view } = await mountPage(t);
  assert.equal(Boolean(view.container.querySelector('[data-testid="dispatch-paused-banner"]')), false);
});

test('⑤ List 보기는 저장되고 표로 그린다', async (t) => {
  const { view } = await mountPage(t);
  const listBtn = [...view.container.querySelectorAll('[aria-label="보기"] button')].find((b) => b.textContent === 'List');
  assert.ok(listBtn);
  click(listBtn);
  await flush(2);
  assert.equal(localStorage.getItem(TICKET_VIEW_STORAGE_KEY), 'list');
  const rows = view.container.querySelectorAll('tr[data-ticket-row]');
  assert.equal(rows.length, 3);
  assert.equal(view.container.querySelectorAll('[data-status-lane]').length, 0);
});

test('⑥ 예전 /boards/* 딥링크는 쿼리를 유지한 채 /tickets 로 간다', () => {
  const dom = setupDom({ width: 1280 });
  probe.pathname = null;
  probe.search = null;
  try {
    const view = mount(
      h(MemoryRouter, { initialEntries: [`${BASE}/boards/b-old?ticket=t1&comment=c9`] },
        h(Routes, null,
          h(Route, { path: '/boards/*', element: h(LegacyBoardsRedirect) }),
          h(Route, { path: '/tickets', element: h(LocationProbe) }),
        ),
      ),
    );
    assert.equal(probe.pathname, `${BASE}/tickets`);
    const qs = new URLSearchParams(probe.search);
    assert.equal(qs.get('ticket'), 't1');
    assert.equal(qs.get('comment'), 'c9');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('⑥-b /boards 인덱스도 /tickets 로 간다', () => {
  const dom = setupDom({ width: 1280 });
  probe.pathname = null;
  try {
    const view = mount(
      h(MemoryRouter, { initialEntries: [`${BASE}/boards`] },
        h(Routes, null,
          h(Route, { path: '/boards/*', element: h(LegacyBoardsRedirect) }),
          h(Route, { path: '/tickets', element: h(LocationProbe) }),
        ),
      ),
    );
    assert.equal(probe.pathname, `${BASE}/tickets`);
    view.unmount();
  } finally {
    dom.cleanup();
  }
});
