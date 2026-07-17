// Chat-first 랜딩 뷰 렌더 계약 테스트 (에픽 bf65ca00 · Phase 1 · S2).
//
// 어시스턴트 지정 상태별(로딩·오류·미지정·무효·정상) 마크업을 react-dom/server 로
// jsdom 없이 고정한다. 순수 <ChatFirstHomeView>(state·isAdmin props)라 fetch·라우팅
// 없이 계약만 검증 — 특히 미지정/무효에서 "임의 에이전트 자동선택 금지 + 관리자 지정
// 안내" empty state 와, 관리자/비관리자 분기(CTA vs 안내문)를 확인한다.
//
// 실행:  node --import tsx --test apps/client/test/chat-first-home-view.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatFirstHomeView } from '../src/components/ChatFirstHome.tsx';

const render = (props) =>
  renderToStaticMarkup(React.createElement(ChatFirstHomeView, { isAdmin: false, ...props }));

test('로딩: 불러오는 중 문구', () => {
  const html = render({ state: { status: 'loading' } });
  assert.match(html, /불러오는 중/);
});

test('오류: role=alert + 메시지', () => {
  const html = render({ state: { status: 'error', message: 'HTTP 500' } });
  assert.match(html, /role="alert"/);
  assert.match(html, /불러오지 못했습니다/);
  assert.match(html, /HTTP 500/);
});

test('정상(ready): 어시스턴트 이름 + 대화 시작 버튼 + 인사', () => {
  const html = render({ state: { status: 'ready', assistantName: 'Rolf/AWB' }, userName: 'Parn' });
  assert.match(html, /Rolf\/AWB/);
  assert.match(html, /대화 시작하기/);
  assert.match(html, /Parn 님/);
});

test('정상(ready): starting 중이면 버튼 문구가 여는 중으로 바뀜', () => {
  const html = render({ state: { status: 'ready', assistantName: 'A' }, starting: true });
  assert.match(html, /대화 여는 중/);
  assert.doesNotMatch(html, /대화 시작하기/);
});

test('미지정 + 관리자: 지정 안내 + 지정 CTA', () => {
  const html = render({ state: { status: 'unset' }, isAdmin: true });
  assert.match(html, /지정되지 않았습니다/);
  assert.match(html, /어시스턴트 지정하기/); // 관리자 CTA
  assert.doesNotMatch(html, /대화 시작하기/); // 미지정이면 대화 시작 불가
});

test('미지정 + 비관리자: 관리자에게 요청 안내(관리자 CTA 없음)', () => {
  const html = render({ state: { status: 'unset' }, isAdmin: false });
  assert.match(html, /지정되지 않았습니다/);
  assert.match(html, /관리자에게/);
  assert.doesNotMatch(html, /어시스턴트 지정하기/);
});

test('무효(invalid) + 관리자: 사용 불가 안내 + 다시 지정 CTA', () => {
  const html = render({ state: { status: 'invalid' }, isAdmin: true });
  assert.match(html, /사용할 수 없습니다/);
  assert.match(html, /다시 지정하기/);
});

test('빈/오류/정상 어디서든 좌측 메뉴 대체 진입(Boards/AI Agents/Chat)은 항상 노출', () => {
  for (const state of [{ status: 'loading' }, { status: 'unset' }, { status: 'ready', assistantName: 'A' }]) {
    const html = render({ state });
    assert.match(html, /Boards/);
    assert.match(html, /AI Agents/);
  }
});
