// 실브라우저(jsdom) 스모크: 티켓 "모두 읽음" → 뱃지 실감소 + SSE 기반 다른
// 탭/기기 동기화 (티켓 628f4b39, 리뷰 지적사항 3).
//
// 기존 서버 통합 테스트(ticket-unread-badge.test.mjs)는 REST 응답만, 클라이언트
// 쪽은 sumUnread 순수 함수만 검증했다 — 실제 배선(AuthProvider →
// NotificationProvider → BoardStreamProvider)을 타고 "read-all 호출 → 로컬
// 카운트 0" 과 "다른 세션의 ticket_reads_cleared SSE 수신 → 로컬 카운트 수렴"
// 경로 자체는 아무것도 고정하지 않았다. 이 파일이 그 갭을 메운다.
//
// 여기서 고정하는 계약 (board-less: unread-counts 는 `{ total, perTicket }` 만 — docs/tickets.md):
//   1. 초기 unread 응답으로 티켓 카운트가 채워진다(perBoard 는 없다)
//   2. read-all(서버 호출 — 바디 없음 + markAllTicketsReadLocal) 후 로컬 카운트가 0
//   3. 다른 세션에서 emit 된 ticket_reads_cleared SSE 를 받으면 재조회 없이
//      로컬 카운트가 수렴한다
//   4. user_id 불일치(다른 사용자) 이벤트는 무시한다
//   5. account_id 불일치(다른 워크스페이스) 이벤트는 무시한다
//
// 실행: node --import tsx --test apps/client/test/ticket-unread-read-all-sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { MemoryRouter } from 'react-router-dom';
import { NotificationProvider, useNotifications } from '../src/contexts/NotificationContext.tsx';
import { api } from '../src/api.ts';

const h = React.createElement;

function Harness({ capture }) {
  const notifications = useNotifications();
  capture.current = notifications;
  return null;
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const WS_ID = 'workspace-1';
const USER_ID = 'user-1';

function makeInitialTicketCounts() {
  return {
    total: 5,
    perTicket: { 't1': 5 },
  };
}

async function mountHarness(t, { ticketCounts } = {}) {
  const dom = setupDom({ width: 1280 });
  const { FakeEventSource, uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');

  const originals = {
    getMe: api.getMe,
    getSetupStatus: api.getSetupStatus,
    getUnreadMentions: api.getUnreadMentions,
    getChatUnreadCounts: api.getChatUnreadCounts,
    getTicketUnreadCounts: api.getTicketUnreadCounts,
    markAllTicketsRead: api.markAllTicketsRead,
  };
  const markAllTicketsReadCalls = [];

  api.getMe = async () => ({
    id: USER_ID,
    name: 'Viewer',
    email: 'viewer@example.test',
    role: 'user',
    status: 'active',
    permissions: [],
    accounts: [{ id: WS_ID, name: 'Account', slug: null, relations: [] }],
  });
  api.getSetupStatus = async () => ({ needs_setup: false });
  api.getUnreadMentions = async () => ({ count: 0, items: [] });
  api.getChatUnreadCounts = async () => ({ total: 0, perRoom: {} });
  api.getTicketUnreadCounts = async () => ticketCounts ?? makeInitialTicketCounts();
  api.markAllTicketsRead = async (...args) => {
    markAllTicketsReadCalls.push(args);
    return { updated: 5 };
  };

  const capture = { current: null };
  const view = mountWithBoardStream(h(NotificationProvider, null, h(Harness, { capture })), {
    wrap: (tree) => h(MemoryRouter, null, tree),
  });

  await flush();
  assert.ok(capture.current, 'NotificationProvider 컨텍스트가 마운트돼야 한다');
  assert.equal(capture.current.countsLoaded, true, '초기 unread 응답을 받아야 한다');

  t.after(() => {
    view.unmount();
    uninstall();
    Object.assign(api, originals);
    dom.cleanup();
  });

  return { capture, markAllTicketsReadCalls, FakeEventSource };
}

test('초기 unread 응답 → 티켓 카운트가 존재하고 보드 롤업은 없다', async (t) => {
  const { capture } = await mountHarness(t);
  assert.equal(capture.current.counts.tickets.total, 5);
  assert.deepEqual(capture.current.counts.tickets.perTicket, { t1: 5 });
  assert.equal('perBoard' in capture.current.counts.tickets, false);
  assert.equal(typeof capture.current.markTicketsReadForBoard, 'undefined', '보드 스코프 read-all 은 없어졌다');
});

test('read-all(서버 호출 + markAllTicketsReadLocal) 후 로컬 카운트가 0이 된다', async (t) => {
  const { capture, markAllTicketsReadCalls } = await mountHarness(t);
  assert.equal(capture.current.counts.tickets.total, 5);

  // Tickets 페이지/사이드바의 "모두 읽음" 과 동일한 순서: 서버 upsert 먼저, 그 다음
  // 로컬 상태 클리어.
  await act(async () => {
    await api.markAllTicketsRead();
    capture.current.markAllTicketsReadLocal();
  });

  assert.deepEqual(markAllTicketsReadCalls, [[]], 'read-all 은 board 인자 없이 호출된다');
  assert.equal(capture.current.counts.tickets.total, 0, 'read-all 후 로컬 총합이 0이어야 한다');
  assert.deepEqual(capture.current.counts.tickets.perTicket, {});
});

test('다른 세션에서 emit 된 ticket_reads_cleared 수신 시 재조회 없이 로컬 카운트가 수렴한다', async (t) => {
  const { capture, FakeEventSource } = await mountHarness(t);
  assert.equal(capture.current.counts.tickets.total, 5);

  const es = FakeEventSource.instances[0];
  assert.ok(es, 'BoardStreamProvider 가 EventSource 를 열어야 한다');

  await act(async () => {
    es.emit('ticket_reads_cleared', {
      user_id: USER_ID,
      account_id: WS_ID,
      updated: 5,
      read_at: new Date().toISOString(),
    });
    await Promise.resolve();
  });

  assert.equal(capture.current.counts.tickets.total, 0, '다른 기기에서의 read-all 도 이 세션 뱃지를 0으로 수렴시켜야 한다');
  assert.deepEqual(capture.current.counts.tickets.perTicket, {});
});

test('예전 서버가 보내던 board_id 가 실려 와도 워크스페이스 전체가 0이 된다', async (t) => {
  const { capture, FakeEventSource } = await mountHarness(t, {
    ticketCounts: { total: 8, perTicket: { t1: 5, t2: 3 } },
  });
  assert.equal(capture.current.counts.tickets.total, 8);

  const es = FakeEventSource.instances[0];
  await act(async () => {
    es.emit('ticket_reads_cleared', {
      user_id: USER_ID,
      account_id: WS_ID,
      board_id: 'board-a',
      updated: 8,
      read_at: new Date().toISOString(),
    });
    await Promise.resolve();
  });

  assert.equal(capture.current.counts.tickets.total, 0);
  assert.deepEqual(capture.current.counts.tickets.perTicket, {});
});

test('다른 사용자(user_id 불일치)의 ticket_reads_cleared 는 무시한다', async (t) => {
  const { capture, FakeEventSource } = await mountHarness(t);
  assert.equal(capture.current.counts.tickets.total, 5);

  const es = FakeEventSource.instances[0];
  await act(async () => {
    es.emit('ticket_reads_cleared', {
      user_id: 'someone-else',
      account_id: WS_ID,
      updated: 5,
      read_at: new Date().toISOString(),
    });
    await Promise.resolve();
  });

  assert.equal(capture.current.counts.tickets.total, 5, '다른 사용자의 read-all 이 내 뱃지를 지우면 안 된다');
});

test('read-all from another ownership account clears the integrated user badge', async (t) => {
  const { capture, FakeEventSource } = await mountHarness(t);
  assert.equal(capture.current.counts.tickets.total, 5);

  const es = FakeEventSource.instances[0];
  await act(async () => {
    es.emit('ticket_reads_cleared', {
      user_id: USER_ID,
      account_id: 'other-workspace',
      updated: 5,
      read_at: new Date().toISOString(),
    });
    await Promise.resolve();
  });

  assert.equal(capture.current.counts.tickets.total, 0, 'the user inbox is independent of default creation ownership');
});
