// 공통 상태 뷰(EmptyState·ErrorState·PermissionNotice) 렌더 계약 테스트
// (종합 상태 설계 · F2-3 · 98d0936e).
//
// 빈/오류/권한 상태 표현을 단일 컴포넌트로 수렴했으므로, 각 컴포넌트의 시맨틱
// (role)·필수 문구·선택적 액션(재시도) 노출을 react-dom/server 로 jsdom 없이 고정한다.
//
// 실행:  node --import tsx --test apps/client/test/state-views.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EmptyState } from '../src/components/common/EmptyState.tsx';
import { ErrorState } from '../src/components/common/ErrorState.tsx';
import { PermissionNotice } from '../src/components/common/PermissionNotice.tsx';

const h = React.createElement;
const render = (el) => renderToStaticMarkup(el);

test('EmptyState: 제목·설명·액션 렌더', () => {
  const html = render(
    h(EmptyState, { title: '표시할 항목이 없습니다', description: '아직 티켓이 없어요', action: h('button', null, '새로 만들기') }),
  );
  assert.match(html, /표시할 항목이 없습니다/);
  assert.match(html, /아직 티켓이 없어요/);
  assert.match(html, /새로 만들기/);
});

test('EmptyState: 설명 없으면 제목만', () => {
  const html = render(h(EmptyState, { title: '비어 있음' }));
  assert.match(html, /비어 있음/);
});

test('ErrorState: role=alert + 기본 제목 + 메시지', () => {
  const html = render(h(ErrorState, { message: 'HTTP 500' }));
  assert.match(html, /role="alert"/);
  assert.match(html, /문제가 발생했습니다/);
  assert.match(html, /HTTP 500/);
});

test('ErrorState: onRetry 있으면 재시도 버튼, 없으면 미노출', () => {
  const withRetry = render(h(ErrorState, { message: 'x', onRetry: () => {} }));
  assert.match(withRetry, /다시 시도/);
  const withoutRetry = render(h(ErrorState, { message: 'x' }));
  assert.doesNotMatch(withoutRetry, /다시 시도/);
});

test('ErrorState: 커스텀 title 로 문맥 좁히기', () => {
  const html = render(h(ErrorState, { title: '티켓을 불러오지 못했습니다', message: 'HTTP 404' }));
  assert.match(html, /불러오지 못했습니다/);
  assert.match(html, /HTTP 404/);
});

test('PermissionNotice: role=note + 기본 제목', () => {
  const html = render(h(PermissionNotice, {}));
  assert.match(html, /role="note"/);
  assert.match(html, /접근 권한이 없습니다/);
});

test('PermissionNotice: 커스텀 title/message (영문 화면 언어 보존)', () => {
  const html = render(
    h(PermissionNotice, { title: 'Admin access required', message: 'Admin access is required to edit workspace settings.' }),
  );
  assert.match(html, /Admin access required/);
  assert.match(html, /required to edit workspace settings/);
});
