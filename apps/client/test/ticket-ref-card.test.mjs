// 티켓 참조 카드 렌더 계약 테스트 (에픽 bf65ca00 · Phase 1 · S2).
//
// renderMarkdown 이 `@[ticket:<id>|title]` 토큰을 인터랙티브 TicketRefCard 로
// 렌더하는지, 기존 멘션 pill·plain 텍스트·코드스팬 동작은 회귀 없이 유지되는지
// react-dom/server(renderToStaticMarkup)로 jsdom 없이 고정한다. 카드는 오프너
// 컨텍스트의 no-op 기본값으로 프로바이더 없이도 안전히 렌더된다(api 의존 0).
//
// 실행:  node --import tsx --test apps/client/test/ticket-ref-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { renderMarkdown } from '../src/components/chat/utils/markdown.tsx';

const render = (text, participants) =>
  renderToStaticMarkup(React.createElement(React.Fragment, null, ...renderMarkdown(text, participants)));

test('티켓 토큰 → 인터랙티브 카드(제목·클릭 버튼·aria)', () => {
  const html = render('확인해줘 @[ticket:abc-123|로그인 버튼 버그] 방금 만들었어');
  assert.match(html, /로그인 버튼 버그/); // 제목 라벨
  assert.match(html, /data-ticket-ref="abc-123"/); // id 를 실어 클릭 대상 식별
  assert.match(html, /<button/); // 포커스 가능한 인터랙티브 요소
  assert.match(html, /aria-label="티켓 열기: 로그인 버튼 버그"/);
  assert.match(html, /확인해줘/); // 앞뒤 본문 보존
  assert.match(html, /방금 만들었어/);
});

test('title 없는 티켓 토큰 → id 를 라벨로 폴백', () => {
  const html = render('@[ticket:ffffffff-1111-2222-3333-444444444444]');
  assert.match(html, /data-ticket-ref="ffffffff-1111-2222-3333-444444444444"/);
  assert.match(html, /aria-label="티켓 열기: ffffffff-1111-2222-3333-444444444444"/);
});

test('기존 멘션 pill 은 회귀 없음(카드로 바뀌지 않음)', () => {
  const html = render('@[agent:agent-9|Rolf] 님 봐주세요');
  assert.match(html, /aria-label="Mention: @Rolf"/); // 멘션 pill 유지
  assert.doesNotMatch(html, /data-ticket-ref/); // 카드로 오인 렌더 금지
});

test('한 메시지에 멘션 + 티켓 카드 혼재', () => {
  const html = render('@[agent:a1|Bob] 이 @[ticket:t-7|배포 이슈] 처리 부탁');
  assert.match(html, /aria-label="Mention: @Bob"/);
  assert.match(html, /data-ticket-ref="t-7"/);
  assert.match(html, /배포 이슈/);
});

test('코드스팬 안의 티켓 토큰은 파싱하지 않는다(리터럴)', () => {
  const html = render('토큰 문법은 `@[ticket:x|Y]` 처럼 씁니다');
  assert.doesNotMatch(html, /data-ticket-ref/); // 카드 렌더 금지
  assert.match(html, /@\[ticket:x\|Y\]/); // 코드 안에선 원문 그대로
});

test('티켓 토큰 없는 plain 텍스트는 카드 0', () => {
  const html = render('그냥 평범한 메시지입니다');
  assert.doesNotMatch(html, /data-ticket-ref/);
  assert.match(html, /그냥 평범한 메시지입니다/);
});
