// 티켓 Artifact 상세 뷰 렌더 계약 테스트 (에픽 bf65ca00 · Phase 1 · S3).
//
// 카드 클릭 → 우측 패널에 주입되는 read-only 상세의 상태별(로딩·오류·로드) 마크업을
// react-dom/server 로 jsdom 없이 고정한다. 순수 <TicketArtifactView>(state props)라
// fetch·부수효과 없이 계약을 검증한다. 시스템 코멘트 필터·role 폴백까지 확인.
//
// 실행:  node --import tsx --test apps/client/test/ticket-artifact-view.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TicketArtifactView } from '../src/components/TicketArtifact.tsx';

const render = (state) => renderToStaticMarkup(React.createElement(TicketArtifactView, { state }));

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

test('오류 상태: onRetry 주면 재시도 버튼 노출 (F2-3)', () => {
  const html = renderToStaticMarkup(
    React.createElement(TicketArtifactView, { state: { status: 'error', message: 'x' }, onRetry: () => {} }),
  );
  assert.match(html, /다시 시도/);
});

test('로드 상태 + disconnected: SSE 단절 배너 노출, 연결 시 미노출 (F2-3)', () => {
  const state = { status: 'loaded', ticket: { title: 'T' } };
  const off = renderToStaticMarkup(React.createElement(TicketArtifactView, { state, disconnected: true }));
  assert.match(off, /role="status"/);
  assert.match(off, /실시간 갱신이 일시중단/);
  const on = renderToStaticMarkup(React.createElement(TicketArtifactView, { state, disconnected: false }));
  assert.doesNotMatch(on, /실시간 갱신이 일시중단/);
});

test('로드 상태: 제목·우선순위·라벨·역할·설명·하위작업·코멘트', () => {
  const ticket = {
    title: '로그인 리다이렉트 버그',
    priority: 'high',
    status: 'in_progress',
    labels: ['bug', 'auth'],
    description: '로그인 후 빈 화면으로 리다이렉트됩니다.',
    role_assignments: [
      { slug: 'assignee', holder: { type: 'agent', id: 'a1', name: 'Rolf/AWB' } },
      { slug: 'reviewer', holder: { type: 'agent', id: 'a2', name: 'Rolf/AWB.Reviewer' } },
    ],
    children: [
      { id: 'c1', title: '리다이렉트 원인 조사', status: 'done' },
      { id: 'c2', title: '회귀 테스트 추가', status: 'todo' },
    ],
    comments: [
      { id: 'm0', author_type: 'system', author: 'System', content: '이동됨' },
      { id: 'm1', author_type: 'agent', author: 'Rolf/AWB', content: '원인 파악 완료' },
    ],
  };
  const html = render({ status: 'loaded', ticket });
  assert.match(html, /로그인 리다이렉트 버그/); // 제목
  assert.match(html, /high/); // 우선순위 배지
  assert.match(html, /bug/); // 라벨
  assert.match(html, /auth/);
  assert.match(html, /Rolf\/AWB/); // 담당자
  assert.match(html, /Rolf\/AWB\.Reviewer/); // 리뷰어
  assert.match(html, /빈 화면으로 리다이렉트/); // 설명
  assert.match(html, /리다이렉트 원인 조사/); // 하위 작업
  assert.match(html, /회귀 테스트 추가/);
  assert.match(html, /원인 파악 완료/); // 사람/에이전트 코멘트
  assert.doesNotMatch(html, /이동됨/); // 시스템 코멘트는 필터
});

test('role_assignments 비어도 비정규화 assignee/reporter 로 폴백', () => {
  const ticket = { title: 'T', assignee: 'LegacyBot', reporter: 'LegacyReporter', role_assignments: [] };
  const html = render({ status: 'loaded', ticket });
  assert.match(html, /LegacyBot/);
  assert.match(html, /LegacyReporter/);
});

test('설명에 티켓 토큰이 있으면 중첩 카드로 렌더', () => {
  const ticket = { title: 'T', description: '관련 @[ticket:dep-9|의존 티켓] 참고' };
  const html = render({ status: 'loaded', ticket });
  assert.match(html, /data-ticket-ref="dep-9"/);
  assert.match(html, /의존 티켓/);
});

// ─── "보드에서 열기" 버튼 (티켓 7815a958) ────────────────────────────────────

test('onOpenOnBoard 없으면 보드 열기 버튼 미노출', () => {
  const ticket = { title: 'T', board_id: 'b1' };
  const html = render({ status: 'loaded', ticket });
  assert.doesNotMatch(html, /보드에서 열기/);
});

test('board_id 있고 아카이브 안 됐으면 활성 버튼', () => {
  const ticket = { title: 'T', board_id: 'b1' };
  const html = renderToStaticMarkup(
    React.createElement(TicketArtifactView, { state: { status: 'loaded', ticket }, onOpenOnBoard: () => {} }),
  );
  assert.match(html, /보드에서 열기/);
  assert.doesNotMatch(html, /disabled=""/);
});

test('board_id 없으면 버튼 비활성 + 안내', () => {
  const ticket = { title: 'T' };
  const html = renderToStaticMarkup(
    React.createElement(TicketArtifactView, { state: { status: 'loaded', ticket }, onOpenOnBoard: () => {} }),
  );
  assert.match(html, /disabled=""/);
  assert.match(html, /보드를 찾을 수 없습니다/);
});

test('archived_at 있으면 board_id 가 있어도 버튼 비활성 + 안내', () => {
  const ticket = { title: 'T', board_id: 'b1', archived_at: '2026-01-01T00:00:00.000Z' };
  const html = renderToStaticMarkup(
    React.createElement(TicketArtifactView, { state: { status: 'loaded', ticket }, onOpenOnBoard: () => {} }),
  );
  assert.match(html, /disabled=""/);
  assert.match(html, /보관된 티켓은 보드에서 바로 열 수 없습니다/);
});
