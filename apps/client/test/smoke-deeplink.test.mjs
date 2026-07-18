// 실브라우저(jsdom) 스모크: `?ticket=` 딥링크 → Artifact 패널 오픈 + 파라미터 제거,
// 그리고 루트/워크스페이스 리다이렉트가 쿼리스트링을 보존하는지(에픽 리뷰 MINOR-1).
// 티켓 98d0936e · F2-1 · §회귀 안전망 ②(딥링크).
//
// - TicketArtifactController 가 `?ticket=<id>` 를 관찰해 패널을 열고 파라미터를 제거.
// - App 의 WorkspaceSectionRedirect 가 `/ws/:wsId?ticket=..` → `assistant?ticket=..` 로
//   쿼리를 실어 나른다(수정 전: search 유실로 딥링크가 셸에 도달 못함).
//
// 실행:  node --import tsx --test apps/client/test/smoke-deeplink.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, React } from './helpers/jsdom.mjs';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ArtifactPanelProvider } from '../src/contexts/ArtifactPanelContext.tsx';
import TicketArtifactController from '../src/components/TicketArtifactController.tsx';
import ArtifactPanel from '../src/components/ArtifactPanel.tsx';
import { ViewModeProvider } from '../src/contexts/ViewModeContext.tsx';
import { WorkspaceSectionRedirect } from '../src/App.tsx';

const h = React.createElement;

// 현재 라우트의 search 를 기록하는 프로브(리다이렉트/스트립 결과 관찰용).
const probe = { search: null };
function LocationProbe() {
  const loc = useLocation();
  probe.search = loc.search;
  return h('div', { 'data-probe': loc.search || '(none)' });
}

test('② `?ticket=<id>` 딥링크 → 패널 오픈 + URL 에서 ticket 파라미터 제거', () => {
  const dom = setupDom({ width: 1280 });
  // TicketArtifact 의 api.getTicket 이 네트워크로 새지 않도록 fetch 를 미해결로 스텁 —
  // 패널은 로딩 상태로 열리고, 우리는 "열렸는지 + 파라미터 제거" 계약만 본다.
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  probe.search = null;
  try {
    mount(
      h(
        MemoryRouter,
        { initialEntries: ['/ws/w1/assistant?ticket=T1'] },
        h(
          Routes,
          null,
          h(Route, {
            path: '/ws/:wsId/assistant',
            element: h(
              ArtifactPanelProvider,
              null,
              h(
                TicketArtifactController,
                null,
                h(LocationProbe),
                h(ArtifactPanel, { isMobile: false }),
              ),
            ),
          }),
        ),
      ),
    );

    // 딥링크가 패널을 열었다
    assert.ok(document.querySelector('[role="complementary"]'), '딥링크로 패널이 열려야 함');
    // 파라미터가 제거됐다(뒤로가기 재발화 방지)
    assert.doesNotMatch(probe.search || '', /ticket=/, '패널 오픈 후 ticket 파라미터 제거');
  } finally {
    globalThis.fetch = prevFetch;
    dom.cleanup();
  }
});

test('MINOR-1: /ws/:wsId?ticket= 리다이렉트가 쿼리스트링을 보존한다', () => {
  const dom = setupDom({ width: 1280 });
  probe.search = null;
  try {
    mount(
      h(
        MemoryRouter,
        { initialEntries: ['/ws/w1?ticket=T1&comment=C9'] },
        h(
          ViewModeProvider,
          null,
          h(
            Routes,
            null,
            // chat 기본 모드 → assistant 로 리다이렉트하며 search 를 실어 나른다
            h(Route, { path: '/ws/:wsId', element: h(WorkspaceSectionRedirect) }),
            h(Route, { path: '/ws/:wsId/assistant', element: h(LocationProbe) }),
          ),
        ),
      ),
    );

    assert.match(probe.search || '', /ticket=T1/, '리다이렉트 후 ticket 쿼리 보존');
    assert.match(probe.search || '', /comment=C9/, '리다이렉트 후 comment 쿼리 보존');
  } finally {
    dom.cleanup();
  }
});
