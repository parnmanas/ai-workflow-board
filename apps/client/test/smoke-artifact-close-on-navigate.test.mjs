// 실브라우저(jsdom) 스모크: 아티팩트 → 실제 화면 이동 시 Artifact 패널이 닫힌다.
//
// 아티팩트에서 "티켓 열기"(TicketArtifact) 같은 링크를 누르면 목적지가 그
// 아티팩트를 대체하므로 패널은 접혀야 한다 — 열린 채로 두면 방금 떠나온 내용이
// 본문을 덮은 채 남는다. 컨테이너를 실마운트해 (a) 실제로 navigate 하고 (b) 패널이
// 닫히는지 함께 고정한다. (P4c-4: Agent 컨테이너 삭제, board-less: Board 컨테이너 삭제.)
//
// 실행:  node --import tsx --test apps/client/test/smoke-artifact-close-on-navigate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, click, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ArtifactPanelProvider, useArtifactPanel } from '../src/contexts/ArtifactPanelContext.tsx';
import ArtifactPanel from '../src/components/ArtifactPanel.tsx';
import TicketArtifact from '../src/components/TicketArtifact.tsx';
import { api } from '../src/api.ts';

const h = React.createElement;

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
  return mountWithBoardStream(h(ArtifactPanelProvider, null, h(Harness, { node, title })), {
    withAuth: false,
    wrap: (tree) => h(MemoryRouter, { initialEntries: ['/ws/w1/chat'] }, tree),
  });
}

function setupEnv() {
  const dom = setupDom({ width: 1280 });
  const { uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');
  return { dom, uninstall };
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

test('TicketArtifact "티켓 열기" — Tickets 페이지의 그 티켓으로 이동하고 패널이 닫힌다', async () => {
  const { dom, uninstall } = setupEnv();
  const orig = api.getTicket;
  const origHosts = api.listTemplateHosts;
  api.getTicket = async () => ({
    id: 't1', title: '샘플 티켓', workspace_id: 'w1', status: 'todo', tags: [], comments: [],
  });
  api.listTemplateHosts = async () => [];
  try {
    const view = renderArtifact(h(TicketArtifact, { ticketId: 't1' }), '샘플 티켓');
    await flush();
    assert.match(view.container.textContent, /OPEN/, '초기엔 패널이 열려 있다');

    await act(async () => { clickButton(view, '티켓 열기'); });
    await flush();

    assert.match(
      view.container.querySelector('[data-testid="loc"]').textContent,
      /^\/ws\/w1\/tickets\?ticket=t1$/,
      'Tickets 페이지 딥링크로 이동한다',
    );
    assert.match(view.container.textContent, /CLOSED/, '이동 후 패널이 닫힌다');
    view.unmount();
  } finally {
    api.getTicket = orig;
    api.listTemplateHosts = origHosts;
    uninstall();
    dom.cleanup();
  }
});
