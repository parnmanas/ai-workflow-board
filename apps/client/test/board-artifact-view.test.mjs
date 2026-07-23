// Board Artifact 상세 뷰 렌더 계약 테스트 (F-3 · ticket 3ca88253).
//
// BoardRefCard 클릭 → 우측 패널에 주입되는 read-only 보드 요약의 상태별(로딩·오류·로드)
// 마크업을 react-dom/server 로 jsdom 없이 고정한다. 순수 <BoardArtifactView>(state
// props)라 fetch·부수효과 없이 계약을 검증한다. 컬럼/티켓 구조, 대량 컬럼 축약(건수 +
// 최근 일부), 우선순위 배지, 담당자 폴백, "보드에서 열기" 버튼까지 고정한다.
//
// 실행:  node --import tsx --test apps/client/test/board-artifact-view.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BoardArtifactView } from '../src/components/BoardArtifact.tsx';

const noop = () => {};
const render = (state, extra) =>
  renderToStaticMarkup(
    React.createElement(BoardArtifactView, { state, onOpenTicket: noop, onOpenBoard: noop, ...extra }),
  );

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

test('로드 상태 + disconnected: SSE 단절 배너 노출, 연결 시 미노출', () => {
  const state = { status: 'loaded', board: { id: 'b1', workspace_id: 'ws-1', name: 'AWB', description: '', columns: [] } };
  const off = render(state, { disconnected: true });
  assert.match(off, /role="status"/);
  assert.match(off, /실시간 갱신이 일시중단/);
  const on = render(state, { disconnected: false });
  assert.doesNotMatch(on, /실시간 갱신이 일시중단/);
});

test('보드 이름·설명 + 빈 컬럼은 "비어 있음" + "보드에서 열기" 버튼', () => {
  const state = {
    status: 'loaded',
    board: {
      id: 'b1',
      workspace_id: 'ws-1',
      name: 'AWB',
      description: 'AI Workflow Board',
      columns: [{ id: 'c1', name: 'Backlog', color: '#888', tickets: [] }],
    },
  };
  const html = render(state);
  assert.match(html, /AWB/); // 보드 이름
  assert.match(html, /AI Workflow Board/); // 설명
  assert.match(html, /Backlog/); // 컬럼 이름
  assert.match(html, /비어 있음/); // 빈 컬럼
  assert.match(html, /보드에서 열기/); // 이동 버튼(티켓 7815a958 과 동일 카피)
});

test('컬럼 티켓: 우선순위 배지·제목·담당자(role_holders 우선) + 클릭 대상 데이터 속성', () => {
  const state = {
    status: 'loaded',
    board: {
      id: 'b1',
      workspace_id: 'ws-1',
      name: 'AWB',
      description: '',
      columns: [
        {
          id: 'c1',
          name: 'To Do',
          color: '#888',
          tickets: [
            {
              id: 't1',
              title: '로그인 버그 수정',
              priority: 'high',
              updated_at: '2026-07-01T00:00:00.000Z',
              role_holders: [{ role_slug: 'assignee', role_name: 'Assignee', holders: [{ type: 'agent', id: 'a1', name: 'Rolf' }] }],
            },
          ],
        },
      ],
    },
  };
  const html = render(state);
  assert.match(html, /data-board-artifact-ticket="t1"/); // 클릭 대상 식별
  assert.match(html, /HIGH/); // 우선순위 배지 라벨
  assert.match(html, /로그인 버그 수정/); // 제목
  assert.match(html, /Rolf/); // role_holders 담당자
  assert.match(html, /aria-label="티켓 열기: 로그인 버그 수정"/);
});

test('role_holders 없으면 레거시 assignee 문자열로 폴백', () => {
  const state = {
    status: 'loaded',
    board: {
      id: 'b1', workspace_id: 'ws-1', name: 'AWB', description: '',
      columns: [{ id: 'c1', name: 'To Do', color: '#888', tickets: [
        { id: 't1', title: 'T', priority: 'low', updated_at: '', assignee: 'LegacyBot' },
      ] }],
    },
  };
  const html = render(state);
  assert.match(html, /LegacyBot/);
  assert.match(html, /LOW/);
});

test('대량 컬럼(6건)은 최근 5건만 표시 + 건수 배지/축약 안내(가장 오래된 항목은 제외)', () => {
  const tickets = Array.from({ length: 6 }, (_, i) => ({
    id: `t${i}`,
    title: `티켓 ${i}`,
    priority: 'medium',
    // t0 이 가장 오래되고 t5 가 가장 최근.
    updated_at: `2026-07-0${i + 1}T00:00:00.000Z`,
  }));
  const state = {
    status: 'loaded',
    board: {
      id: 'b1', workspace_id: 'ws-1', name: 'AWB', description: '',
      columns: [{ id: 'done', name: 'Done', color: '#22c55e', tickets }],
    },
  };
  const html = render(state);
  assert.match(html, /최근 5건 표시 · 총 6건/);
  assert.match(html, /data-board-artifact-ticket="t5"/); // 가장 최근
  assert.match(html, /data-board-artifact-ticket="t1"/);
  assert.doesNotMatch(html, /data-board-artifact-ticket="t0"/); // 가장 오래된 건 축약으로 제외
  // 컬럼 헤더 건수 배지는 축약과 무관하게 총계(6)를 보여준다.
  assert.match(html, />6</);
});

test('5건 이하 컬럼은 축약 안내 없이 전부 표시(보드와 동일 순서)', () => {
  const tickets = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`, title: `티켓 ${i}`, priority: 'medium', updated_at: '',
  }));
  const state = {
    status: 'loaded',
    board: { id: 'b1', workspace_id: 'ws-1', name: 'AWB', description: '', columns: [{ id: 'c1', name: 'Doing', color: '#888', tickets }] },
  };
  const html = render(state);
  assert.doesNotMatch(html, /최근 \d+건 표시/);
  for (let i = 0; i < 5; i++) assert.match(html, new RegExp(`data-board-artifact-ticket="t${i}"`));
});
