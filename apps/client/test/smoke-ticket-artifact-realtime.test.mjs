// 실브라우저(jsdom) 스모크: TicketArtifact 컨테이너의 SSE 실시간 갱신 + 단절 배너
// (종합 상태 설계 · F2-3 · 98d0936e).
//
// 순수 View 계약(ticket-artifact-view.test)과 별개로, 컨테이너가 실제 SSE 배선
// (BoardStreamProvider → EventSource → board_update 디스패치 → 재조회)을 타는지
// 실마운트로 고정한다. board_update 를 실제 wire payload({ ticket_id, ... } JSON 문자열)로
// 주입해 producer→dispatcher→consumer 종단을 검증하고(board lesson: 실 wire payload),
// onopen/onerror 로 isConnected 를 흔들어 단절 배너 토글까지 확인한다.
//
// 실행:  node --import tsx --test apps/client/test/smoke-ticket-artifact-realtime.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { MemoryRouter } from 'react-router-dom';
import TicketArtifact from '../src/components/TicketArtifact.tsx';
import { api } from '../src/api.ts';

const h = React.createElement;

// getTicket 이 마이크로태스크로 resolve 하므로 effect+상태전이를 flush 하는 헬퍼.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

test('board_update(대상 티켓) 도착 시 조용히 재조회하고 새 내용으로 교체', async () => {
  const dom = setupDom({ width: 1280 });
  const { FakeEventSource, uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');

  const origGetTicket = api.getTicket;
  let calls = 0;
  api.getTicket = async () => {
    calls += 1;
    return { title: calls === 1 ? '초기 제목' : '갱신된 제목' };
  };

  try {
    // "보드에서 열기" 버튼(티켓 7815a958)이 컨테이너에서 useNavigate 를 쓰므로
    // MemoryRouter 로 감싼다(smoke-deeplink 의 라우팅 스모크와 동일 관례).
    const view = mountWithBoardStream(h(TicketArtifact, { ticketId: 't1' }), {
      withAuth: false,
      wrap: (tree) => h(MemoryRouter, null, tree),
    });
    await flush();

    assert.equal(calls, 1, '마운트 시 1회 조회');
    assert.match(view.container.textContent, /초기 제목/);

    // 대상 티켓의 board_update 주입 → load(false) 재조회.
    const es = FakeEventSource.instances[0];
    assert.ok(es, 'BoardStreamProvider 가 EventSource 를 연다');
    await act(async () => {
      es.emit('board_update', { ticket_id: 't1', field_changed: 'status' });
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(calls, 2, 'board_update 로 재조회');
    assert.match(view.container.textContent, /갱신된 제목/);

    // 다른 티켓 이벤트는 무시.
    await act(async () => {
      es.emit('board_update', { ticket_id: 'other', field_changed: 'status' });
      await Promise.resolve();
    });
    assert.equal(calls, 2, '무관 티켓 이벤트는 재조회 안 함');

    view.unmount();
  } finally {
    api.getTicket = origGetTicket;
    uninstall();
    dom.cleanup();
  }
});

test('SSE 단절 배너: 미연결이면 노출, onopen 후 사라짐', async () => {
  const dom = setupDom({ width: 1280 });
  const { FakeEventSource, uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');

  const origGetTicket = api.getTicket;
  api.getTicket = async () => ({ title: '제목' });

  try {
    const view = mountWithBoardStream(h(TicketArtifact, { ticketId: 't1' }), {
      withAuth: false,
      wrap: (tree) => h(MemoryRouter, null, tree),
    });
    await flush();

    // onopen 전 → isConnected=false → 단절 배너 노출.
    assert.match(view.container.textContent, /실시간 갱신이 일시중단/);

    const es = FakeEventSource.instances[0];
    await act(async () => {
      es.open();
      await Promise.resolve();
    });

    assert.doesNotMatch(view.container.textContent, /실시간 갱신이 일시중단/, 'onopen 후 배너 사라짐');

    view.unmount();
  } finally {
    api.getTicket = origGetTicket;
    uninstall();
    dom.cleanup();
  }
});
