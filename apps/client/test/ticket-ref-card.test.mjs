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
import TicketRefCard from '../src/components/chat/TicketRefCard.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { TicketMetaProvider } from '../src/contexts/TicketMetaContext.tsx';

const renderCard = (props) => renderToStaticMarkup(React.createElement(TicketRefCard, props));

// F2-4 ⓐ: 칩 렌더는 useTicketMeta 컨텍스트가 있어야 하므로, 캐시가 이미 채워진 DI
// 스토어를 TicketMetaProvider 로 주입해 렌더한다(get(id) 가 동기 반환 → SSR 에 칩 노출).
// TicketMetaProvider 는 board_update 구독차 BoardStreamProvider 를 요구한다(effect 는
// SSR 에서 안 돌지만 컨텍스트는 필요). api/네트워크 없이 순수 렌더 계약만 본다.
const renderCardWithMeta = (props, metaById) => {
  const store = {
    get: (id) => metaById[id],
    ensure: () => {},
    invalidate: () => {},
    subscribe: () => () => {},
  };
  return renderToStaticMarkup(
    React.createElement(
      BoardStreamProvider,
      null,
      React.createElement(TicketMetaProvider, { store }, React.createElement(TicketRefCard, props)),
    ),
  );
};

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

// ─── F-1 (ticket 24694916): 구조화 metadata 카드 — action 배지 ────────────────
// agent-manager 가 tool result 에서 캡처한 ticket_refs 를 MessageList 가 각 ref →
// action 을 실은 TicketRefCard 로 렌더한다. 카드를 직접 렌더해 배지 델타를 고정한다
// (content-token 경로는 action 없이 호출 → 기존 인라인 카드 그대로).

test('F-1: action prop → 한글 배지 + aria 에 액션·제목', () => {
  const html = renderCard({ id: 'T-1', title: '로그인 버그', action: 'move' });
  assert.match(html, /이동/); // '이동' 한글 배지
  assert.match(html, /로그인 버그/); // 제목 라벨
  assert.match(html, /data-ticket-ref="T-1"/); // 클릭 대상 식별
  assert.match(html, /aria-label="티켓 이동 — 티켓 열기: 로그인 버그"/);
});

test('F-1: 알 수 없는 action → 코드 문자열 그대로 배지 노출', () => {
  const html = renderCard({ id: 'T-3', title: 'x', action: 'weird' });
  assert.match(html, /weird/);
});

// F-1 재요청: 확장된 mutation surface(update_child_ticket/handoff/consensus/…)의
// action 코드가 클라 ACTION_LABEL 에도 한글로 매핑돼 방출↔렌더 계약이 일치함을 고정.
test('F-1: 확장 action 코드 → 한글 배지 (agent-manager 라벨과 일치)', () => {
  for (const [action, label] of [
    ['handoff', '핸드오프'],
    ['consensus', '합의'],
    ['prereq', '선행조건'],
    ['unarchive', '아카이브 해제'],
    ['release', '클레임 해제'],
    ['propose', '이동 제안'],
  ]) {
    const html = renderCard({ id: 'T-x', title: '작업', action });
    assert.match(html, new RegExp(label), `${action} → ${label} 배지`);
    assert.match(html, new RegExp(`aria-label="티켓 ${label} — 티켓 열기: 작업"`));
  }
});

// F-1 2차 재요청: typed-comment mutation(ask/answer/decision) + reject_handoff 의
// 신규 action 코드도 클라 ACTION_LABEL 에 한글로 매핑돼 방출↔렌더 계약이 일치함을 고정.
test('F-1: comment/reject action 코드 → 한글 배지 (agent-manager 라벨과 일치)', () => {
  for (const [action, label] of [
    ['question', '질문'],
    ['answer', '답변'],
    ['decision', '결정'],
    ['reject', '반려'],
  ]) {
    const html = renderCard({ id: 'T-x', title: '작업', action });
    assert.match(html, new RegExp(label), `${action} → ${label} 배지`);
    assert.match(html, new RegExp(`aria-label="티켓 ${label} — 티켓 열기: 작업"`));
  }
});

test('F-1: action 미지정(content-token 경로) → 배지 없음, 기존 인라인 카드 유지', () => {
  const html = renderCard({ id: 'T-2', title: '순수제목' });
  assert.doesNotMatch(html, /이동|생성|수정|코멘트/); // 액션 배지 없음
  assert.match(html, /aria-label="티켓 열기: 순수제목"/); // 기존 aria 그대로
  assert.match(html, /data-ticket-ref="T-2"/);
});

// ─── F2-4 ⓑ 승인 카드 변형 (ticket d21b28fc) ─────────────────────────────────
// propose/consensus action 은 일반 카드와 다른 톤/아이콘(🗳️) + data-ticket-approval
// 표식으로 렌더한다. propose 는 target 컬럼을 "→ <컬럼>" detail 배지로 노출한다.
test('F2-4 ⓑ: propose → 승인 변형(🗳️ + data-ticket-approval) + detail "→ 컬럼" 배지', () => {
  const html = renderCard({ id: 'T-p', title: '제안 티켓', action: 'propose', detail: 'Review' });
  assert.match(html, /data-ticket-approval=""/); // 승인 변형 표식
  assert.match(html, /🗳️/); // 투표 아이콘(일반 🎫 아님)
  assert.match(html, /이동 제안/); // action 배지
  assert.match(html, /→ Review/); // detail 배지(제안 대상 컬럼)
  assert.match(html, /data-ticket-ref="T-p"/);
});

test('F2-4 ⓑ: consensus → 승인 변형이되 detail 없으면 detail 배지 없음', () => {
  const html = renderCard({ id: 'T-c', title: '합의 티켓', action: 'consensus' });
  assert.match(html, /data-ticket-approval=""/);
  assert.match(html, /합의/);
  assert.doesNotMatch(html, /→\s/); // detail 미지정 → 화살표 배지 없음
});

test('F2-4 ⓑ: 비승인 action(move) 은 승인 변형/🗳️ 없음(회귀 없음)', () => {
  const html = renderCard({ id: 'T-m', title: '이동', action: 'move', detail: 'Review' });
  assert.doesNotMatch(html, /data-ticket-approval/); // 승인 아님
  assert.doesNotMatch(html, /🗳️/);
  assert.doesNotMatch(html, /→ Review/); // detail 은 승인 카드에서만 배지로 뜬다
});

// ─── F2-4 ⓐ 상태 카드 칩 (ticket d21b28fc) ───────────────────────────────────
// 메타(현재 컬럼/우선순위)가 있으면 카드 끝에 칩으로 붙는다. 메타 없으면 칩 생략(기존 렌더 불변).
test('F2-4 ⓐ: 메타 있으면 우선순위·상태 칩 렌더', () => {
  const html = renderCardWithMeta(
    { id: 'T-1', title: '로그인 버그', action: 'move' },
    { 'T-1': { priority: 'high', status: 'In Review' } },
  );
  assert.match(html, /data-meta-chip=""/); // 칩 존재
  assert.match(html, /high/); // 우선순위 칩 라벨
  assert.match(html, /In Review/); // 상태(컬럼) 칩 라벨
  assert.match(html, /data-ticket-ref="T-1"/);
});

test('F2-4 ⓐ: 메타 없으면 칩 생략(카드 본체는 그대로)', () => {
  const html = renderCardWithMeta({ id: 'T-none', title: '메타없음', action: 'move' }, {});
  assert.doesNotMatch(html, /data-meta-chip/); // 칩 없음
  assert.match(html, /메타없음/); // 카드 본체는 정상 렌더
  assert.match(html, /data-ticket-ref="T-none"/);
});

test('F2-4 ⓐ: 프로바이더 밖(useTicketMeta no-op)에서도 카드는 그대로 렌더', () => {
  // renderCard 는 프로바이더 없이 렌더 — useTicketMeta 가 undefined 반환 → 칩만 생략.
  const html = renderCard({ id: 'T-safe', title: '안전', action: 'move' });
  assert.doesNotMatch(html, /data-meta-chip/);
  assert.match(html, /data-ticket-ref="T-safe"/);
});
