// 보드 현황 참조 카드 렌더 계약 테스트 (F-3 · ticket 3ca88253).
//
// message.metadata.board_refs 를 MessageList 가 BoardRefCard 로 렌더한다.
// AgentRefCard 와 동일한 안전 계약(useOpenArtifactPanel no-op 기본값) — 프로바이더
// 없이도 throw 없이 렌더된다. react-dom/server 로 jsdom 없이 고정한다.
//
// 실행:  node --import tsx --test apps/client/test/board-ref-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import BoardRefCard from '../src/components/chat/BoardRefCard.tsx';

const render = (props) => renderToStaticMarkup(React.createElement(BoardRefCard, props));

test('ArtifactPanelProvider 밖에서도 throw 없이 렌더된다(SSR 안전)', () => {
  assert.doesNotThrow(() => render({ id: 'B-1', title: 'AWB' }));
});

test('id + title → 인터랙티브 카드(라벨·클릭 대상·aria)', () => {
  const html = render({ id: 'B-1', title: 'AWB' });
  assert.match(html, /data-board-ref="B-1"/); // 클릭 대상 식별
  assert.match(html, /<button/); // 포커스 가능한 인터랙티브 요소
  assert.match(html, /aria-label="보드 현황 열기: AWB"/);
  assert.match(html, /AWB/); // 표시 라벨
  assert.match(html, /📊/); // board 아이콘
});

test('title 없으면 "보드" 로 폴백(id 는 그대로 데이터 속성에 유지)', () => {
  const html = render({ id: 'B-2' });
  assert.match(html, /data-board-ref="B-2"/);
  assert.match(html, /aria-label="보드 현황 열기: 보드"/);
  assert.match(html, />보드</);
});
