// 실브라우저(jsdom) 스모크: 티켓 카드 클릭 → Artifact 패널 오픈 + 포커스 관리.
// 티켓 98d0936e · F2-1 · §회귀 안전망 ①(카드 클릭→패널) + ④(포커스트랩·복귀).
//
// Phase 1 의 SSR/순수 계약 테스트가 커버하지 못한 "실제 클릭이 패널을 연다",
// "열리면 닫기버튼으로 포커스가 가고, 닫으면 오프너로 복귀한다", "모바일 모달에서
// Tab 이 배경으로 새지 않는다" 를 react-dom/client 실마운트로 고정한다.
//
// 실행:  node --import tsx --test apps/client/test/smoke-artifact-panel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, click, keydown, React } from './helpers/jsdom.mjs';
import { ArtifactPanelProvider, useArtifactPanel } from '../src/contexts/ArtifactPanelContext.tsx';
import { TicketArtifactOpenerProvider } from '../src/contexts/ticketArtifactOpener.tsx';
import ArtifactPanel from '../src/components/ArtifactPanel.tsx';
import TicketRefCard from '../src/components/chat/TicketRefCard.tsx';

const h = React.createElement;

// 오프너를 실제로 배선하되 TicketArtifact(네트워크 fetch) 대신 결정적 노드를 연다 —
// 카드→오프너→패널 오픈이라는 상호작용 경로 자체를 검증하는 데 집중한다.
function Harness({ isMobile }) {
  const { openArtifact } = useArtifactPanel();
  const opener = (id, title) =>
    openArtifact({ key: `ticket:${id}`, title: title || '티켓', node: h('div', null, '상세 본문 XYZ') });
  return h(
    React.Fragment,
    null,
    h(TicketArtifactOpenerProvider, { value: opener }, h(TicketRefCard, { id: 'T1', title: '샘플 티켓' })),
    h(ArtifactPanel, { isMobile }),
  );
}

const App = ({ isMobile }) => h(ArtifactPanelProvider, null, h(Harness, { isMobile }));

test('① 데스크톱: 티켓 카드 클릭 → 패널(role=complementary) 오픈 + 내용 렌더 + 닫기버튼 포커스', () => {
  const dom = setupDom({ width: 1280 });
  try {
    const { container } = mount(h(App, { isMobile: false }));

    // 초기: 패널 닫힘
    assert.equal(document.querySelector('[role="complementary"]'), null);

    const card = container.querySelector('[data-ticket-ref="T1"]');
    assert.ok(card, '티켓 카드 버튼이 렌더돼야 함');
    card.focus(); // 오프너(복귀 대상)로 기억되도록 포커스 선점
    click(card);

    const panel = document.querySelector('[role="complementary"]');
    assert.ok(panel, '클릭 후 패널이 열려야 함');
    assert.match(panel.textContent, /상세 본문 XYZ/);

    // 열리면 닫기 버튼으로 포커스 이동(기본 a11y)
    const closeBtn = document.querySelector('[aria-label="Artifact 패널 닫기"]');
    assert.ok(closeBtn, '닫기 버튼 존재');
    assert.equal(document.activeElement, closeBtn, '열리면 닫기 버튼에 포커스');
  } finally {
    dom.cleanup();
  }
});

test('④ 데스크톱: 닫기 버튼 클릭 → 패널 닫힘 + 오프너(카드)로 포커스 복귀', () => {
  const dom = setupDom({ width: 1280 });
  try {
    const { container } = mount(h(App, { isMobile: false }));
    const card = container.querySelector('[data-ticket-ref="T1"]');
    card.focus();
    click(card);

    const closeBtn = document.querySelector('[aria-label="Artifact 패널 닫기"]');
    click(closeBtn);

    assert.equal(document.querySelector('[role="complementary"]'), null, '닫기 후 패널 사라짐');
    assert.equal(document.activeElement, card, '닫으면 오프너 카드로 포커스 복귀');
  } finally {
    dom.cleanup();
  }
});

test('③④ 모바일: 패널이 role=dialog+aria-modal 로 열리고 Tab 이 시트 내부에 트랩된다', () => {
  const dom = setupDom({ width: 400 }); // 모바일 브레이크포인트
  try {
    const { container } = mount(h(App, { isMobile: true }));
    const card = container.querySelector('[data-ticket-ref="T1"]');
    card.focus();
    click(card);

    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, '모바일은 오버레이 시트(role=dialog)로 열림');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');

    const closeBtn = document.querySelector('[aria-label="Artifact 패널 닫기"]');
    assert.equal(document.activeElement, closeBtn, '열리면 닫기 버튼 포커스');

    // Tab: 시트 내부 포커스 가능 요소는 닫기 버튼뿐 → 랩되어 배경으로 새지 않고 유지
    keydown('Tab', { target: closeBtn });
    assert.equal(document.activeElement, closeBtn, 'Tab 이 배경으로 새지 않고 시트 안에 갇힘');

    // Esc 로 닫힘 + 오프너 복귀
    keydown('Escape');
    assert.equal(document.querySelector('[role="dialog"]'), null, 'Esc 로 모바일 시트 닫힘');
    assert.equal(document.activeElement, card, 'Esc 닫힘 후 오프너 카드로 복귀');
  } finally {
    dom.cleanup();
  }
});
