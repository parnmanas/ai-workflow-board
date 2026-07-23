// Agent Artifact 상세 뷰 렌더 계약 테스트 (F-3 · ticket 3ca88253).
//
// AgentRefCard 클릭 → 우측 패널에 주입되는 read-only 상세의 상태별(로딩·오류·로드)
// 마크업을 react-dom/server 로 jsdom 없이 고정한다. 순수 <AgentArtifactView>(state
// props)라 fetch·부수효과 없이 계약을 검증한다. 요약 블록은 AI Agents 화면(AgentsPage)
// 이 쓰는 실제 <AgentCard> 를 그대로 재사용한다는 것이 이 뷰의 핵심 요구사항이라,
// AgentCard 가 렌더하는 이름/온라인 배지까지 함께 고정한다.
//
// 실행:  node --import tsx --test apps/client/test/agent-artifact-view.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentArtifactView } from '../src/components/AgentArtifact.tsx';

const render = (state, extra) =>
  renderToStaticMarkup(React.createElement(AgentArtifactView, { state, onOpenDetail: () => {}, ...extra }));

test('로딩 상태: 로딩 문구', () => {
  const html = render({ status: 'loading' });
  assert.match(html, /불러오는 중/);
});

test('오류 상태: role=alert + 메시지', () => {
  const html = render({ status: 'error', message: 'HTTP 404' });
  assert.match(html, /role="alert"/);
  assert.match(html, /불러오지 못했습니다/);
  assert.match(html, /HTTP 404/);
});

test('오류 상태: onRetry 주면 재시도 버튼 노출', () => {
  const html = render({ status: 'error', message: 'x' }, { onRetry: () => {} });
  assert.match(html, /다시 시도/);
});

test('로드 상태: AgentCard 재사용(이름·온라인 배지) + AI Agents 상세 보기 버튼', () => {
  const agent = {
    id: 'a-1',
    name: 'Rolf',
    is_online: true,
    last_seen_at: null,
    connected_at: '2026-07-01T00:00:00.000Z',
    workspace_id: 'ws-1',
    pending_trigger_count: 0,
  };
  const html = render({ status: 'loaded', agent });
  assert.match(html, /Rolf/); // AgentCard 이름
  assert.match(html, /ONLINE/); // AgentCard 온라인 배지
  assert.match(html, /AI Agents에서 상세 보기/); // 네비게이션 버튼
});

test('managed agent(manager_agent_id 있음) → 관리 정보 섹션(Manager/CLI/Working dir)', () => {
  const agent = {
    id: 'a-2',
    name: 'Worker',
    is_online: false,
    last_seen_at: null,
    connected_at: null,
    workspace_id: 'ws-1',
    pending_trigger_count: 0,
    manager_agent_id: 'mgr-1',
    manager_name: 'Fleet',
    type: 'claude',
    working_dir: '/repo/worktree',
  };
  const html = render({ status: 'loaded', agent });
  assert.match(html, /관리 정보/); // Section 제목
  assert.match(html, /Manager/);
  assert.match(html, /Fleet/); // manager_name
  assert.match(html, /CLI/);
  assert.match(html, /claude/); // type
  assert.match(html, /Working dir/);
  assert.match(html, /\/repo\/worktree/);
});

test('standalone agent(manager_agent_id·type·working_dir 없음) → 관리 정보 섹션 생략', () => {
  const agent = {
    id: 'a-3',
    name: 'Solo',
    is_online: true,
    last_seen_at: null,
    connected_at: null,
    workspace_id: 'ws-1',
    pending_trigger_count: 0,
  };
  const html = render({ status: 'loaded', agent });
  assert.doesNotMatch(html, /관리 정보/);
});
