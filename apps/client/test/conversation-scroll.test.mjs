// 대화창 스크롤 동작의 공유 회귀 테스트 (운영 보고 2026-09-26: "mission 은 스크롤도
// 최상단으로 가있고... 공유하기 힘든거야?").
//
// 고치기 전: chat 방 · mission 대화 · mission step 세션 · Agent Session 전사가 스크롤
// 추종을 **각자** 구현했고, 각자 다른 부분집합만 구현해 증상이 갈렸다. mission 대화는
// "바닥 근처일 때만 따라간다" 규칙만 있고 첫 진입 고정이 없어서, 미션을 열면 언제나
// 가장 오래된 메시지(맨 위)가 보였다 — 이 파일 ⑤ 가 그 회귀다.
//
// 지금은 네 화면이 useConversationScroll 하나를 쓴다. 규칙은 네 가지고, 여기서 규칙
// 자체를 훅 단위로 고정한 뒤(①~④·⑥) 실제 미션 패널로 한 번 더 확인한다(⑤).
//
// jsdom 은 레이아웃이 없어 scrollHeight/clientHeight 가 0 이다 — 행 수로 높이를
// 계산하는 프로토타입 스텁을 깔아 "내용이 뷰포트보다 길다"를 만든다. scrollTop 은
// jsdom 이 값을 실제로 보관하므로 그대로 단언할 수 있다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, React, act, click } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { api } from '../src/api.ts';
import MissionConversationPanel from '../src/components/orchestration/MissionConversationPanel.tsx';
import { useConversationScroll } from '../src/hooks/useConversationScroll.ts';

const h = React.createElement;
const ROW_PX = 100;
const VIEWPORT_PX = 300;

/** 행 수로 높이를 흉내내는 레이아웃 스텁. 첫 커밋 시점부터 유효해야 하므로 프로토타입에 건다. */
function installLayout(dom) {
  const proto = dom.window.HTMLElement.prototype;
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get() {
      return this.querySelectorAll('[data-row]').length * ROW_PX;
    },
  });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => VIEWPORT_PX });
}

function Probe({ items, resetKey, ready = true, onLoadOlder, followPaused = false }) {
  const scrollRef = React.useRef(null);
  const contentRef = React.useRef(null);
  const { atBottom, scrollToBottom } = useConversationScroll({
    scrollRef,
    contentRef,
    resetKey,
    tailKey: items.length === 0 ? null : items[items.length - 1],
    contentKey: items.length,
    ready: ready && items.length > 0,
    onLoadOlder,
    followPaused,
  });
  return h(
    'div',
    null,
    h(
      'div',
      { ref: scrollRef, 'data-testid': 'scroller' },
      h(
        'div',
        { ref: contentRef },
        items.map((id) => h('div', { key: id, 'data-row': id }, id)),
      ),
    ),
    atBottom ? null : h('button', { 'data-testid': 'jump', onClick: () => scrollToBottom('auto') }, '↓ 최신으로'),
  );
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const rows = (n, prefix = 'm') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

function withProbe(t, initial) {
  const dom = setupDom({ width: 1280 });
  installLayout(dom);
  const view = mount(h(Probe, initial));
  t.after(() => {
    view.unmount();
    dom.cleanup();
  });
  const scroller = () => view.container.querySelector('[data-testid="scroller"]');
  const render = async (props) => {
    await act(async () => {
      view.rerender(h(Probe, props));
    });
    await settle();
  };
  return { view, dom, scroller, render };
}

test('① 첫 진입은 애니메이션 없이 바닥에 고정된다 — 대화는 최신부터 읽는다', async (t) => {
  const { scroller } = withProbe(t, { items: rows(20), resetKey: 'room-1' });
  assert.equal(scroller().scrollTop, 20 * ROW_PX, '열자마자 맨 아래여야 한다');
});

test('② 바닥에 있으면 새 항목을 따라가고, 위에서 이력을 읽는 중이면 끌어내리지 않는다', async (t) => {
  const { scroller, render } = withProbe(t, { items: rows(20), resetKey: 'room-1' });

  await render({ items: rows(21), resetKey: 'room-1' });
  assert.equal(scroller().scrollTop, 21 * ROW_PX, '바닥에 붙어 있었으므로 새 항목을 따라간다');

  // 사용자가 위로 올라가 이력을 읽는다.
  await act(async () => {
    scroller().scrollTop = 200;
    scroller().dispatchEvent(new window.Event('scroll', { bubbles: true }));
  });
  await render({ items: rows(22), resetKey: 'room-1' });
  assert.equal(scroller().scrollTop, 200, '이력을 읽는 중에는 자리를 빼앗지 않는다');
});

test('③ 과거를 앞에 붙이면 늘어난 높이만큼 보정해 읽던 자리를 지킨다', async (t) => {
  const loadCalls = [];
  const { scroller, render } = withProbe(t, {
    items: rows(20),
    resetKey: 'room-1',
    onLoadOlder: () => loadCalls.push('call'),
  });

  // 맨 위까지 올리면 과거를 부른다.
  await act(async () => {
    scroller().scrollTop = 0;
    scroller().dispatchEvent(new window.Event('scroll', { bubbles: true }));
  });
  assert.equal(loadCalls.length, 1, '위쪽 영역에 닿으면 과거를 부른다');

  // 과거 10건이 앞에 붙는다 → 늘어난 1000px 만큼 내려 같은 내용을 보고 있어야 한다.
  await render({ items: [...rows(10, 'old'), ...rows(20)], resetKey: 'room-1', onLoadOlder: () => loadCalls.push('call') });
  assert.equal(scroller().scrollTop, 10 * ROW_PX, '앞에 붙은 높이만큼만 내려간다 — 바닥으로 튀지 않는다');
});

test('④ 대화가 바뀌면 다시 첫 진입처럼 바닥에서 열린다', async (t) => {
  const { scroller, render } = withProbe(t, { items: rows(20), resetKey: 'room-1' });
  await act(async () => {
    scroller().scrollTop = 0;
    scroller().dispatchEvent(new window.Event('scroll', { bubbles: true }));
  });
  await render({ items: rows(30, 'b'), resetKey: 'room-2' });
  assert.equal(scroller().scrollTop, 30 * ROW_PX, '이전 대화의 래치가 새 대화의 첫 고정을 삼키면 안 된다');
});

test('⑤ followPaused 는 바닥 근접과 별개로 추종을 멈춘다 (미션의 과거 이벤트 열람)', async (t) => {
  const { scroller, render } = withProbe(t, { items: rows(20), resetKey: 'room-1' });
  assert.equal(scroller().scrollTop, 20 * ROW_PX);
  await render({ items: rows(21), resetKey: 'room-1', followPaused: true });
  assert.equal(scroller().scrollTop, 20 * ROW_PX, '과거를 파는 중이면 새 항목이 와도 내려가지 않는다');
});

test('⑥ 이력을 읽는 중에만 "최신으로" 버튼이 뜨고, 누르면 바닥으로 돌아온다', async (t) => {
  const { view, scroller } = withProbe(t, { items: rows(20), resetKey: 'room-1' });
  const jump = () => view.container.querySelector('[data-testid="jump"]');
  assert.equal(Boolean(jump()), false, '바닥에 있으면 버튼이 없다');

  await act(async () => {
    scroller().scrollTop = 0;
    scroller().dispatchEvent(new window.Event('scroll', { bubbles: true }));
  });
  assert.equal(Boolean(jump()), true, '위로 올리면 버튼이 뜬다');
  await act(async () => {
    click(jump());
  });
  assert.equal(scroller().scrollTop, 20 * ROW_PX);
  assert.equal(Boolean(jump()), false, '돌아오면 버튼이 사라진다');
});

test('⑦ 로딩이 끝나기 전에는 고정하지 않고, 첫 내용이 커밋될 때 고정한다', async (t) => {
  const { scroller, render } = withProbe(t, { items: [], resetKey: 'room-1', ready: false });
  assert.equal(scroller().scrollTop, 0, '내용이 없으면 아무것도 하지 않는다');
  await render({ items: rows(20), resetKey: 'room-1', ready: true });
  assert.equal(scroller().scrollTop, 20 * ROW_PX, '첫 내용이 도착한 그 커밋에서 바닥으로 간다');
});

// ── 실제 미션 대화창 — 보고된 증상 그 자체 ────────────────────────────────────

test('⑧ 미션 대화를 열면 맨 위가 아니라 최신 메시지에서 시작한다 (보고된 증상)', async (t) => {
  const dom = setupDom({ width: 1280 });
  // 미션 패널의 행은 `[data-row]` 가 아니라 자기 마크업이다 — 높이는 렌더된 요소 수로 센다.
  const proto = dom.window.HTMLElement.prototype;
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get() {
      return this.querySelectorAll('*').length * 40;
    },
  });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => VIEWPORT_PX });

  const { uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');
  const originals = {
    getMe: api.getMe,
    getChatRoomMessages: api.getChatRoomMessages,
    getChatRoom: api.getChatRoom,
    markChatRoomRead: api.markChatRoomRead,
    listOrchestrationMissionEvents: api.listOrchestrationMissionEvents,
  };
  const ROOM = 'room-mission-scroll';
  api.getMe = async () => ({ id: 'u1', name: 'Operator', email: 'o@x', role: 'admin', status: 'active', permissions: [], resolved_permissions: [], workspaces: [] });
  api.getChatRoomMessages = async () =>
    Array.from({ length: 30 }, (_, i) => ({
      id: `m${i + 1}`,
      room_id: ROOM,
      content: `메시지 ${i + 1}`,
      sender_type: 'user',
      sender_id: 'u1',
      sender_name: 'Operator',
      type: 'text',
      attachments: [],
      created_at: new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString(),
    }));
  api.getChatRoom = async () => ({ participants: [{ id: 'p1', participant_type: 'user', participant_id: 'u1', participant_name: 'Operator', joined_at: '2026-06-01T00:00:00.000Z' }] });
  api.markChatRoomRead = async () => {};
  api.listOrchestrationMissionEvents = async () => ({ events: [], has_more: false, next_cursor: null });

  t.after(() => {
    Object.assign(api, originals);
    uninstall();
    dom.cleanup();
  });

  const view = mountWithBoardStream(
    h(MissionConversationPanel, { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: true, events: [] }),
    { withAuth: true },
  );
  await settle();
  await settle();

  const scroller = view.container.querySelector('[data-testid="mission-conversation-scroll"]');
  assert.equal(Boolean(scroller), true, '스크롤 컨테이너가 있어야 한다');
  assert.ok(scroller.scrollHeight > VIEWPORT_PX, '내용이 뷰포트보다 길어야 이 테스트가 의미를 갖는다');
  assert.equal(
    scroller.scrollTop,
    scroller.scrollHeight,
    '미션을 열면 최신 메시지가 보여야 한다 — 예전엔 항상 scrollTop 0(가장 오래된 메시지)이었다',
  );
  assert.equal(
    Boolean(view.container.querySelector('[data-testid="mission-conversation-jump-latest"]')),
    false,
    '바닥에 있으므로 "최신으로" 버튼은 없다',
  );
  view.unmount();
});
