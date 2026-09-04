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
  assert.match(html, /Execution/);
  assert.match(html, /Runtime Host/);
  assert.match(html, /Fleet/); // manager_name
  assert.match(html, /Runtime/);
  assert.match(html, /claude/); // type
  assert.match(html, /Working dir/);
  assert.match(html, /\/repo\/worktree/);
});

test('historical unhosted agent shows fail-closed Runtime Host status', () => {
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
  assert.match(html, /Runtime Host/);
  assert.match(html, /Required/);
});

// ── trust 설정값 vs 실효 권한 등급 (ticket 6705d39b) ────────────────────────
//
// 예전 라벨은 그냥 "Permission" 이었다. 이 패널이 보여주는 값은 운영자가 에이전트에
// 설정한 trust 일 뿐인데, 그 이름이면 "이 에이전트가 실제로 갖는 권한"으로 읽힌다 —
// 실효 등급은 매니저의 resolveEffectivePermissionPolicy() 가 디스패치 시점에 정하고
// (trust 가 유효하지 않으면 strict 강등, trust 가 없으면 harness 가 결정), 이 화면은
// 그 판정 입력을 하나도 갖고 있지 않다.

test('trust 설정: 값의 출처가 라벨과 값 옆 주석 양쪽에서 드러난다', () => {
  const agent = {
    id: 'a-4',
    name: 'Trusted',
    is_online: true,
    last_seen_at: null,
    connected_at: null,
    workspace_id: 'ws-1',
    pending_trigger_count: 0,
    manager_agent_id: 'mgr-1',
    manager_name: 'Fleet',
    type: 'claude',
    runtime_config: { strategy: 'single', permission_mode: 'trusted' },
  };
  const html = render({ status: 'loaded', agent });

  // 설정된 값 자체는 그대로 보여야 한다 — 숨기는 게 목적이 아니다.
  assert.match(html, /trusted/);
  // 라벨이 설정값임을 밝힌다.
  assert.match(html, /Trust 설정/);
  // 실효 등급과 갈릴 수 있다는 사실이 hover 없이도 보인다.
  assert.match(html, /설정값 — 실효 등급과 다를 수 있음/);
  // 판정 주체와 갈리는 경로를 툴팁이 설명한다.
  assert.match(html, /디스패치 시점에 매니저가 판정/);
  assert.match(html, /strict 로 강등/);
  assert.match(html, /harness/);
});

test('trust 설정: 실효 권한으로 오독되던 맨 "Permission" 라벨이 사라졌다', () => {
  const agent = {
    id: 'a-5',
    name: 'Strict',
    is_online: false,
    last_seen_at: null,
    connected_at: null,
    workspace_id: 'ws-1',
    pending_trigger_count: 0,
    manager_agent_id: 'mgr-1',
    manager_name: 'Fleet',
    runtime_config: { strategy: 'single', permission_mode: 'strict' },
  };
  const html = render({ status: 'loaded', agent });

  assert.match(html, /strict/);
  // 라벨 span 이 정확히 "Permission" 이던 마크업이 남아 있으면 회귀다. 값 옆 주석의
  // "권한 등급" 류 문구까지 싸잡아 막지 않도록 라벨 셀 형태로만 좁혀 단언한다.
  assert.doesNotMatch(html, />Permission</);
});

test('trust 설정: runtime_config 없는 에이전트는 이 행 자체가 없다', () => {
  const agent = {
    id: 'a-6',
    name: 'Identity',
    is_online: false,
    last_seen_at: null,
    connected_at: null,
    workspace_id: 'ws-1',
    pending_trigger_count: 0,
  };
  const html = render({ status: 'loaded', agent });

  // spawn 되지 않는 identity 에이전트에는 적용될 권한 등급 자체가 없다 —
  // 없는 값을 설명하는 주석만 덩그러니 남으면 그것도 오표시다.
  assert.doesNotMatch(html, /Trust 설정/);
  assert.doesNotMatch(html, /설정값 — 실효 등급과 다를 수 있음/);
});
