// Artifact 패널 표현 계약 렌더 테스트 (에픽 bf65ca00 · Phase 1 · S1 공통 셸).
//
// react-dom/server(renderToStaticMarkup)로 jsdom 없이 상태별 렌더를 고정한다.
// 순수 뷰 ArtifactPanelView 는 open/artifact/isMobile props 만으로 렌더되므로
// 부수효과(포커스·Esc) 없이 마크업 계약을 검증할 수 있다. S3 가 node 로 티켓
// 상세를 주입해도 이 프레임 계약(빈 상태·role·닫기 버튼·반응형)은 유지되어야 한다.
//
// 실행:  node --import tsx --test apps/client/test/artifact-panel-view.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ArtifactPanelView } from '../src/components/ArtifactPanel.tsx';

const render = (props) => renderToStaticMarkup(React.createElement(ArtifactPanelView, props));

test('닫힘: 아무것도 렌더하지 않는다(레이아웃 영향 0)', () => {
  const html = render({ open: false, artifact: null, isMobile: false, onClose() {} });
  assert.equal(html, '');
});

test('데스크톱·열림·대상 없음: role=complementary + 빈 상태 + 닫기 버튼', () => {
  const html = render({ open: true, artifact: null, isMobile: false, onClose() {} });
  assert.match(html, /role="complementary"/);
  assert.match(html, /선택된 항목이 없습니다/);
  assert.match(html, /Artifact 패널 닫기/); // 닫기 버튼 aria-label
  assert.doesNotMatch(html, /role="dialog"/); // 데스크톱은 비모달
});

test('모바일·열림: role=dialog + aria-modal (오버레이 시트)', () => {
  const html = render({ open: true, artifact: null, isMobile: true, onClose() {} });
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.doesNotMatch(html, /role="complementary"/);
});

test('열림·node 주입(S3 경로): 빈 상태 대신 주입된 내용을 렌더', () => {
  const node = React.createElement('div', null, '티켓 상세 본문 XYZ');
  const html = render({
    open: true,
    artifact: { key: 'ticket:1', title: '카드 제목', node },
    isMobile: false,
    onClose() {},
  });
  assert.match(html, /티켓 상세 본문 XYZ/);
  assert.doesNotMatch(html, /선택된 항목이 없습니다/); // node 가 있으면 빈 상태 미표시
  assert.match(html, /카드 제목/); // 헤더 제목 표시
});

test('열림·제목 없는 대상: aria-label 이 기본값으로 폴백', () => {
  const html = render({ open: true, artifact: { key: 'x', title: '' }, isMobile: false, onClose() {} });
  assert.match(html, /aria-label="Artifact 패널"/);
});
