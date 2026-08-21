// 실브라우저(jsdom) 스모크: 티켓 "모두 읽음" → 뱃지 실감소 + SSE 기반 다른
// 탭/기기 동기화 (티켓 628f4b39, 리뷰 지적사항 3).
//
// 기존 서버 통합 테스트(ticket-unread-badge.test.mjs)는 REST 응답만, 클라이언트
// 쪽은 sumUnread 순수 함수만 검증했다 — 실제 배선(AuthProvider →
// NotificationProvider → BoardStreamProvider)을 타고 "read-all 호출 → 로컬
// 카운트 0" 과 "다른 세션의 ticket_reads_cleared SSE 수신 → 로컬 카운트 수렴"
// 경로 자체는 아무것도 고정하지 않았다. 이 파일이 그 갭을 메운다.
//
// 여기서 고정하는 계약:
//   1. 초기 unread 응답으로 보드/티켓 카운트가 채워진다
//   2. 보드 read-all(서버 호출 + markTicketsReadForBoard) 후 로컬 카운트가 0
//   3. 다른 세션에서 emit 된 ticket_reads_cleared SSE 를 받으면 재조회 없이
//      로컬 카운트가 수렴한다(보드 스코프 / 워크스페이스 전체 둘 다)
//   4. user_id 불일치(다른 사용자) 이벤트는 무시한다
//   5. workspace_id 불일치(다른 워크스페이스) 이벤트는 무시한다
//
// 실행: node --import tsx --test apps/client/test/ticket-unread-read-all-sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { NotificationProvider, useNotifications } from '../src/contexts/NotificationContext.tsx';
import { api } from '../src/api.ts';

const h = React.createElement;

// smoke-ticket-artifact-realtime.test.mjs 와 동일한 이유로 필요: BoardStreamProvider
// 내부 pub/sub 버스는 Node 전역 EventTarget 이고 CustomEvent 로 디스패치하는데,
// setupDom 이 전역 Event/CustomEvent 를 jsdom 것으로 덮어쓰면 Node EventTarget
// 이 이를 거부한다(ERR_INVALID_ARG_TYPE). 마운트 전 pristine Node 생성자를
// 붙잡아 setupDom 이후 복원한다(이 파일은 DOM 이벤트를 디스패치하지 않아 안전).
const NodeEvent = globalThis.Event;
const NodeCustomEvent =
  globalThis.CustomEvent ||
  class CustomEvent extends NodeEvent {
    constructor(type, opts = {}) {
      super(type, opts);
      this.detail = opts.detail ?? null;
    }
  };
function useNodeEventGlobals() {
  globalThis.Event = NodeEvent;
  globalThis.CustomEvent = NodeCustomEvent;
}

class FakeEventSource {
  static instances = [];
  static CLOSED = 2;
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.onopen = null;
    this.onerror = null;
    this._listeners = {};
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  close() {
    this.readyState = 2;
  }
  emit(type, dataObj) {
    for (const fn of this._listeners[type] || []) fn({ data: JSON.stringify(dataObj) });
  }
}

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
    perBoard: { 'board-a': 5 },
    ticketBoard: { 't1': 'board-a' },
  };
}

async function mountHarness(t, { ticketCounts } = {}) {
  const dom = setupDom({ width: 1280 });
  useNodeEventGlobals();
  globalThis.EventSource = FakeEventSource;
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');
  FakeEventSource.instances.length = 0;

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
    workspaces: [{ id: WS_ID, name: 'Workspace', slug: null, relations: [] }],
  });
  api.getSetupStatus = async () => ({ needs_setup: false });
  api.getUnreadMentions = async () => ({ count: 0, items: [] });
  api.getChatUnreadCounts = async () => ({ total: 0, perRoom: {} });
  api.getTicketUnreadCounts = async () => ticketCounts ?? makeInitialTicketCounts();
  api.markAllTicketsRead = async (boardId) => {
    markAllTicketsReadCalls.push(boardId);
    return { updated: 5 };
  };

  const capture = { current: null };
  const view = mount(
    h(
      MemoryRouter,
      null,
      h(
        AuthProvider,
        null,
        h(BoardStreamProvider, null, h(NotificationProvider, null, h(Harness, { capture }))),
      ),
    ),
  );

  await flush();
  assert.ok(capture.current, 'NotificationProvider 컨텍스트가 마운트돼야 한다');
  assert.equal(capture.current.countsLoaded, true, '초기 unread 응답을 받아야 한다');

  t.after(() => {
    view.unmount();
    Object.assign(api, originals);
    dom.cleanup();
  });

  return { capture, markAllTicketsReadCalls };
}

test('초기 unread 응답 → 보드/티켓 카운트가 존재한다', async (t) => {
  const { capture } = await mountHarness(t);
  assert.equal(capture.current.counts.tickets.total, 5);
  assert.deepEqual(capture.current.counts.tickets.perBoard, { 'board-a': 5 });
  assert.deepEqual(capture.current.counts.tickets.perTicket, { t1: 5 });
});

test('보드 read-all(서버 호출 + markTicketsReadForBoard) 후 로컬 카운트가 0이 된다', async (t) => {
  const { capture, markAllTicketsReadCalls } = await mountHarness(t);
  assert.equal(capture.current.counts.tickets.total, 5);

  // Board.tsx의 handleMarkBoardRead 와 동일한 순서: 서버 upsert 먼저, 그 다음
  // 로컬 상태 클리어.
  await act(async () => {
    await api.markAllTicketsRead('board-a');
    capture.current.markTicketsReadForBoard('board-a');
  });

  assert.deepEqual(markAllTicketsReadCalls, ['board-a']);
  assert.equal(capture.current.counts.tickets.total, 0, 'read-all 후 로컬 총합이 0이어야 한다');
  assert.deepEqual(capture.current.counts.tickets.perBoard, {}, 'board-a 뱃지가 사라져야 한다');
  assert.deepEqual(capture.current.counts.tickets.perTicket, {});
});

test('다른 세션에서 emit 된 ticket_reads_cleared(보드 스코프) 수신 시 재조회 없이 로컬 카운트가 수렴한다', async (t) => {
  const { capture } = await mountHarness(t);
  assert.equal(capture.current.counts.tickets.total, 5);

  const es = FakeEventSource.instances[0];
  assert.ok(es, 'BoardStreamProvider 가 EventSource 를 열어야 한다');

  await act(async () => {
    es.emit('ticket_reads_cleared', {
      user_id: USER_ID,
      workspace_id: WS_ID,
      board_id: 'board-a',
      updated: 5,
      read_at: new Date().toISOString(),
    });
    await Promise.resolve();
  });

  assert.equal(capture.current.counts.tickets.total, 0, '다른 기기에서의 read-all 도 이 세션 뱃지를 0으로 수렴시켜야 한다');
  assert.deepEqual(capture.current.counts.tickets.perBoard, {});
});

test('ticket_reads_cleared(워크스페이스 전체, board_id=null) 수신 시 모든 보드가 함께 0이 된다', async (t) => {
  const { capture } = await mountHarness(t, {
    ticketCounts: {
      total: 8,
      perTicket: { t1: 5, t2: 3 },
      perBoard: { 'board-a': 5, 'board-b': 3 },
      ticketBoard: { t1: 'board-a', t2: 'board-b' },
    },
  });
  assert.equal(capture.current.counts.tickets.total, 8);

  const es = FakeEventSource.instances[0];
  await act(async () => {
    es.emit('ticket_reads_cleared', {
      user_id: USER_ID,
      workspace_id: WS_ID,
      board_id: null,
      updated: 8,
      read_at: new Date().toISOString(),
    });
    await Promise.resolve();
  });

  assert.equal(capture.current.counts.tickets.total, 0);
  assert.deepEqual(capture.current.counts.tickets.perBoard, {});
  assert.deepEqual(capture.current.counts.tickets.perTicket, {});
});

test('다른 사용자(user_id 불일치)의 ticket_reads_cleared 는 무시한다', async (t) => {
  const { capture } = await mountHarness(t);
  assert.equal(capture.current.counts.tickets.total, 5);

  const es = FakeEventSource.instances[0];
  await act(async () => {
    es.emit('ticket_reads_cleared', {
      user_id: 'someone-else',
      workspace_id: WS_ID,
      board_id: 'board-a',
      updated: 5,
      read_at: new Date().toISOString(),
    });
    await Promise.resolve();
  });

  assert.equal(capture.current.counts.tickets.total, 5, '다른 사용자의 read-all 이 내 뱃지를 지우면 안 된다');
});

test('다른 워크스페이스(workspace_id 불일치)의 ticket_reads_cleared 는 무시한다', async (t) => {
  const { capture } = await mountHarness(t);
  assert.equal(capture.current.counts.tickets.total, 5);

  const es = FakeEventSource.instances[0];
  await act(async () => {
    es.emit('ticket_reads_cleared', {
      user_id: USER_ID,
      workspace_id: 'other-workspace',
      board_id: 'board-a',
      updated: 5,
      read_at: new Date().toISOString(),
    });
    await Promise.resolve();
  });

  assert.equal(capture.current.counts.tickets.total, 5, '지금 보고 있는 워크스페이스가 아니면 무시해야 한다');
});
