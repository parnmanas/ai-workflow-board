// Agent 상태 참조 카드 렌더 계약 테스트 (F-3 · ticket 3ca88253).
//
// message.metadata.agent_refs 를 MessageList 가 AgentRefCard 로 렌더한다.
// TicketRefCard 와 동일하게 프로바이더 없이도 throw 없이 안전히 렌더돼야 한다
// (useOpenArtifactPanel 의 no-op 기본값 — ArtifactPanelProvider 밖에서도 SSR 계약
// 테스트 등 어느 표면에서나 안전). react-dom/server 로 jsdom 없이 고정한다.
//
// 실행:  node --import tsx --test apps/client/test/agent-ref-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import AgentRefCard from '../src/components/chat/AgentRefCard.tsx';

const render = (props) => renderToStaticMarkup(React.createElement(AgentRefCard, props));

test('ArtifactPanelProvider 밖에서도 throw 없이 렌더된다(SSR 안전)', () => {
  assert.doesNotThrow(() => render({ id: 'A-1', name: 'Rolf' }));
});

test('id + name → 인터랙티브 카드(라벨·클릭 대상·aria)', () => {
  const html = render({ id: 'A-1', name: 'Rolf' });
  assert.match(html, /data-agent-ref="A-1"/); // 클릭 대상 식별
  assert.match(html, /<button/); // 포커스 가능한 인터랙티브 요소
  assert.match(html, /aria-label="Agent 상세 열기: Rolf"/);
  assert.match(html, /Rolf/); // 표시 라벨
  assert.match(html, /🤖/); // agent 아이콘
});

test('name 없으면 "Agent" 로 폴백(id 는 그대로 데이터 속성에 유지)', () => {
  const html = render({ id: 'A-2' });
  assert.match(html, /data-agent-ref="A-2"/);
  assert.match(html, /aria-label="Agent 상세 열기: Agent"/);
  assert.match(html, />Agent</);
});
