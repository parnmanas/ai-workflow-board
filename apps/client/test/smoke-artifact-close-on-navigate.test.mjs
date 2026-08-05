// 실브라우저(jsdom) 스모크: 아티팩트 → 실제 화면 이동 시 Artifact 패널이 닫힌다.
//
// 아티팩트에서 "보드에서 열기"(TicketArtifact) 같은 링크를 누르면 목적지가 그
// 아티팩트를 대체하므로 패널은 접혀야 한다 — 열린 채로 두면 방금 떠나온 내용이
// 본문을 덮은 채 남는다. 세 컨테이너(Ticket/Board/Agent) 모두 같은 규약을 따르므로
// 각각 실마운트해 (a) 실제로 navigate 하고 (b) 패널이 닫히는지 함께 고정한다.
//
// 실행:  node --import tsx --test apps/client/test/smoke-artifact-close-on-navigate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ArtifactPanelProvider, useArtifactPanel } from '../src/contexts/ArtifactPanelContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import ArtifactPanel from '../src/components/ArtifactPanel.tsx';
import TicketArtifact from '../src/components/TicketArtifact.tsx';
import BoardArtifact from '../src/components/BoardArtifact.tsx';
import AgentArtifact from '../src/components/AgentArtifact.tsx';
import { api } from '../src/api.ts';

const h = React.createElement;

// BoardStreamProvider 의 pub/sub 는 Node 전역 EventTarget 이라 jsdom Event 를 거부한다
// (smoke-ticket-artifact-realtime 과 동일 처리).
const NodeEvent = globalThis.Event;
const NodeCustomEvent =
  globalThis.CustomEvent ||
  class CustomEvent extends NodeEvent {
    constructor(type, opts = {}) {
      super(type, opts);
      this.detail = opts.detail ?? null;
    }
  };

class FakeEventSource {
  static CLOSED = 2;
  constructor() {
    this.readyState = 1;
    this.onopen = null;
    this.onerror = null;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = 2;
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 현재 경로를 DOM 에 노출해 navigate 발생을 어서션할 수 있게 하는 프로브. */
function LocationProbe() {
  const loc = useLocation();
  return h('div', { 'data-testid': 'loc' }, `${loc.pathname}${loc.search}`);
}

/**
 * 아티팩트 본문을 패널에 실어 여는 하네스. 패널이 열린 상태로 시작하고, 본문의
 * 이동 버튼을 누른 뒤 패널이 닫혔는지(=본문이 사라졌는지) 본다.
 */
function Harness({ node, title }) {
  const { openArtifact, open } = useArtifactPanel();
  React.useEffect(() => {
    openArtifact({ key: 'k', title, node });
  }, [openArtifact, node, title]);
  return h(
    React.Fragment,
    null,
    h('div', { 'data-testid': 'open-state' }, open ? 'OPEN' : 'CLOSED'),
    h(LocationProbe),
    h(ArtifactPanel, { isMobile: false }),
  );
}

function renderArtifact(node, title = '아티팩트') {
  return mount(
    h(
      MemoryRouter,
      { initialEntries: ['/ws/w1/chat'] },
      h(BoardStreamProvider, null, h(ArtifactPanelProvider, null, h(Harness, { node, title }))),
    ),
  );
}

function setupEnv() {
  const dom = setupDom({ width: 1280 });
  globalThis.Event = NodeEvent;
  globalThis.CustomEvent = NodeCustomEvent;
  globalThis.EventSource = FakeEventSource;
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');
  return dom;
}

/** 라벨로 버튼을 찾아 클릭. 없으면 무엇이 렌더됐는지 함께 실패시킨다. */
function clickButton(view, label) {
  const btn = [...view.container.querySelectorAll('button')].find((b) =>
    (b.textContent || '').includes(label),
  );
  assert.ok(btn, `"${label}" 버튼이 렌더돼야 한다 — 실제: ${view.container.textContent}`);
  click(btn);
  return btn;
}

test('TicketArtifact "보드에서 열기" — 보드로 이동하고 패널이 닫힌다', async () => {
  const dom = setupEnv();
  const orig = api.getTicket;
  api.getTicket = async () => ({
    id: 't1', title: '샘플 티켓', board_id: 'b1', workspace_id: 'w1', comments: [],
  });
  try {
    const view = renderArtifact(h(TicketArtifact, { ticketId: 't1' }), '샘플 티켓');
    await flush();
    assert.match(view.container.textContent, /OPEN/, '초기엔 패널이 열려 있다');

    await act(async () => { clickButton(view, '보드에서 열기'); });
    await flush();

    assert.match(
      view.container.querySelector('[data-testid="loc"]').textContent,
      /^\/ws\/w1\/boards\/b1\?ticket=t1$/,
      '보드 딥링크로 이동한다',
    );
    assert.match(view.container.textContent, /CLOSED/, '이동 후 패널이 닫힌다');
    view.unmount();
  } finally {
    api.getTicket = orig;
    dom.cleanup();
  }
});

test('BoardArtifact 티켓 링크 — 그 티켓으로 이동하고 패널이 닫힌다', async () => {
  const dom = setupEnv();
  const orig = api.getBoard;
  api.getBoard = async () => ({
    id: 'b1',
    name: '샘플 보드',
    workspace_id: 'w1',
    columns: [
      { id: 'c1', name: 'Todo', tickets: [{ id: 't9', title: '보드 안 티켓', comments: [] }] },
    ],
  });
  try {
    const view = renderArtifact(h(BoardArtifact, { boardId: 'b1' }), '샘플 보드');
    await flush();
    assert.match(view.container.textContent, /OPEN/);

    await act(async () => { clickButton(view, '보드 안 티켓'); });
    await flush();

    assert.match(
      view.container.querySelector('[data-testid="loc"]').textContent,
      /^\/ws\/w1\/boards\/b1\?ticket=t9$/,
      '해당 티켓 딥링크로 이동한다',
    );
    assert.match(view.container.textContent, /CLOSED/, '이동 후 패널이 닫힌다');
    view.unmount();
  } finally {
    api.getBoard = orig;
    dom.cleanup();
  }
});

test('AgentArtifact 상세 보기 — 에이전트 상세로 이동하고 패널이 닫힌다', async () => {
  const dom = setupEnv();
  const orig = api.getAgent;
  api.getAgent = async () => ({ id: 'a1', name: '샘플 에이전트', workspace_id: 'w1' });
  try {
    const view = renderArtifact(h(AgentArtifact, { agentId: 'a1' }), '샘플 에이전트');
    await flush();
    assert.match(view.container.textContent, /OPEN/);

    await act(async () => { clickButton(view, '상세 보기'); });
    await flush();

    assert.match(
      view.container.querySelector('[data-testid="loc"]').textContent,
      /^\/ws\/w1\/agents\/a1$/,
      '에이전트 상세로 이동한다',
    );
    assert.match(view.container.textContent, /CLOSED/, '이동 후 패널이 닫힌다');
    view.unmount();
  } finally {
    api.getAgent = orig;
    dom.cleanup();
  }
});
