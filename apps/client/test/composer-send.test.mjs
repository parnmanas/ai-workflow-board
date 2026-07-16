// 채팅 컴포저 전송 흐름의 경합/접근성 회귀 테스트 (티켓 e0567bb3, Review P1·P2).
//
// 리뷰 반송 사유 두 가지를 그대로 재현·검증한다:
//   1) 비동기 전송이 끝날 때 사용자가 컴포저 밖 컨트롤로 focus 를 옮겼다면
//      focus 를 되빼앗지 않는다(접근성/키보드 탐색 — 요구사항 4).
//   2) 느린 전송 도중 paste/drop 으로 추가된 첨부가 전송 성공 콜백의 strip
//      클리어에 함께 지워지지 않는다(미리보기 URL revoke·서버 orphan 방지).
//
// 미러가 아니라 ChatMessageInput.tsx 가 실제로 import 하는 composerSend.ts 를
// 그대로 구동한다. 컴포넌트의 handleSend 는 가드·스냅샷·동기 setState 이후
// completeComposerSend 에 오케스트레이션(전송→첨부 정산→focus 복귀)을 위임하고
// ref/세터/전송호출/포커스 read·restore 만 주입한다. 따라서 정산 분기(스냅샷 밖
// 첨부 보존)나 focus 게이팅을 지우거나 오배선하면 이 테스트가 실패한다.
//
// 커버 경계(정직한 잔여물): 컴포넌트에 남는 미검증 코드는 DI 리터럴뿐이다 —
// completeComposerSend 에 무엇을 주입하는지(readFocus 가 document.activeElement/
// rootRef.current/document.body 를, restoreFocus 가 inputHandleRef.focus 를,
// sentLocalIds 가 전송 시작 시점 strip 을 가리키는지). 이 React/DOM glue 는 jsdom
// 풀마운트가 있어야 실행되며 이 레포엔 jsdom 이 없다(루트 CLAUDE.md). 아래 전송
// 오케스트레이션·정산·focus 결정 로직은 전부 이 테스트가 실제로 구동한다.
//
// 실행:  npm test -w client   (레포 루트)
//   또는 node --import tsx --test apps/client/test/composer-send.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldRestoreComposerFocus,
  partitionSettledAttachments,
  completeComposerSend,
} from '../src/components/chat/utils/composerSend.ts';

// ─── 테스트 유틸 ──────────────────────────────────────────────────────────────

/** 외부에서 임의 시점에 완료시킬 수 있는 promise (전송 응답 시점 통제용). */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 고유 정체성만 필요한 가짜 DOM 노드. */
const node = () => ({});
/** 주어진 자식들만 contains() 하는 가짜 컴포저 루트. */
const rootWith = (...children) => ({ contains: (n) => children.includes(n) });

/** React useState 세터(updater 함수 형태)를 흉내낸 셀. */
function cell(initial) {
  let state = initial;
  return { set: (updater) => { state = updater(state); }, get: () => state };
}

/** 첨부 strip 행 최소 시드. */
const att = (localId, extra = {}) => ({ localId, status: 'done', ...extra });

// ─── 1. 순수 결정 함수 ────────────────────────────────────────────────────────

test('shouldRestoreComposerFocus: 아무 것도 focus 안 됨(null) → 복귀', () => {
  assert.equal(shouldRestoreComposerFocus({ active: null, composerRoot: rootWith(), body: node() }), true);
});

test('shouldRestoreComposerFocus: focus 가 <body> 로 떨어짐(전송 중 Send 버튼 disable→blur) → 복귀', () => {
  const body = node();
  assert.equal(shouldRestoreComposerFocus({ active: body, composerRoot: rootWith(), body }), true);
});

test('shouldRestoreComposerFocus: focus 가 컴포저 안(textarea)에 남아 있음 → 복귀', () => {
  const textarea = node();
  assert.equal(
    shouldRestoreComposerFocus({ active: textarea, composerRoot: rootWith(textarea), body: node() }),
    true,
  );
});

test('shouldRestoreComposerFocus: 사용자가 컴포저 밖 컨트롤로 이동 → focus 유지(뺏지 않음)', () => {
  const outside = node();
  assert.equal(shouldRestoreComposerFocus({ active: outside, composerRoot: rootWith(), body: node() }), false);
});

test('partitionSettledAttachments: 전송 시작 이후 추가된 첨부는 정산에서 살아남는다', () => {
  const sent = att('a', { previewUrl: 'blob:sent' });
  const pasted = att('b', { previewUrl: 'blob:pasted' });
  const { remaining, revokeUrls } = partitionSettledAttachments([sent, pasted], new Set(['a']));
  assert.deepEqual(remaining.map((e) => e.localId), ['b']); // paste 된 b 보존
  assert.deepEqual(revokeUrls, ['blob:sent']); // 전송 소유 a 의 URL 만 revoke
});

test('partitionSettledAttachments: 전부 이 전송 소유면 모두 제거, 가진 URL 만 revoke', () => {
  const withUrl = att('a', { previewUrl: 'blob:a' });
  const noUrl = att('b'); // 이미지 아님 → previewUrl 없음
  const { remaining, revokeUrls } = partitionSettledAttachments([withUrl, noUrl], new Set(['a', 'b']));
  assert.deepEqual(remaining, []);
  assert.deepEqual(revokeUrls, ['blob:a']);
});

// ─── 2. 전송 오케스트레이션 (completeComposerSend) ────────────────────────────
// 기본 deps: 각 테스트가 필요한 것만 덮어쓴다.
function baseDeps(overrides) {
  return {
    content: 'hi',
    attachmentIds: [],
    sentLocalIds: new Set(),
    send: async () => ({ id: 'm' }),
    onSent: () => {},
    setPendingAttachments: () => {},
    revokeObjectURL: () => {},
    setSendError: () => {},
    setText: () => {},
    setSending: () => {},
    readFocus: () => ({ active: null, composerRoot: rootWith(), body: node() }),
    restoreFocus: () => {},
    ...overrides,
  };
}

test('P1: 전송 대기 중 사용자가 컴포저 밖으로 이동 → resolve 후 focus 되빼앗지 않음', async () => {
  const d = deferred();
  const outside = node();
  let restored = 0;
  let sendingFinal;
  const p = completeComposerSend(baseDeps({
    send: () => d.promise,
    setSending: (v) => { sendingFinal = v; },
    // 전송이 in-flight 인 동안 사용자가 밖의 컨트롤로 Tab → settle 시점 active=outside.
    readFocus: () => ({ active: outside, composerRoot: rootWith(), body: node() }),
    restoreFocus: () => { restored += 1; },
  }));
  d.resolve({ id: 'm1' });
  await p;
  assert.equal(restored, 0, '밖으로 이동한 focus 를 뺏지 않아야 한다');
  assert.equal(sendingFinal, false, 'finally 에서 spinner 해제');
});

test('P1: 마우스 클릭 Send 경로(전송 중 버튼 disable→body) → focus 컴포저로 복귀', async () => {
  const d = deferred();
  const body = node();
  let restored = 0;
  const p = completeComposerSend(baseDeps({
    send: () => d.promise,
    readFocus: () => ({ active: body, composerRoot: rootWith(), body }),
    restoreFocus: () => { restored += 1; },
  }));
  d.resolve({ id: 'm1' });
  await p;
  assert.equal(restored, 1, 'body(=아무 컨트롤도 focus 안 됨)면 복귀해 연속 입력 보장');
});

test('P2: 전송 성공 도중 paste 된 첨부가 성공 정산에서 살아남는다', async () => {
  const d = deferred();
  const strip = cell([att('a', { previewUrl: 'blob:a', attachmentId: 'srv-a' })]);
  const revoked = [];
  const sent = [];
  const p = completeComposerSend(baseDeps({
    attachmentIds: ['srv-a'],
    sentLocalIds: new Set(['a']), // 전송 시작 시점 스냅샷
    send: () => d.promise,
    onSent: (m) => sent.push(m),
    setPendingAttachments: strip.set,
    revokeObjectURL: (u) => revoked.push(u),
  }));
  // 전송이 in-flight 인 동안 사용자가 새 파일을 paste → strip 에 새 행 추가.
  strip.set((prev) => [...prev, att('b', { previewUrl: 'blob:b', status: 'uploading' })]);
  // 이제 전송 성공.
  d.resolve({ id: 'm1' });
  await p;
  assert.deepEqual(strip.get().map((e) => e.localId), ['b'], '전송 소유(a)만 제거, paste(b)는 보존');
  assert.deepEqual(revoked, ['blob:a'], 'a 의 미리보기 URL 만 revoke — b 는 revoke 금지');
  assert.deepEqual(sent, [{ id: 'm1' }], 'onSent 는 서버 메시지로 호출');
});

test('P2: 전송 실패 → 에러 노출, 빈 컴포저면 draft 복원, 첨부 보존, focus 게이팅 유지', async () => {
  const d = deferred();
  const strip = cell([att('a', { previewUrl: 'blob:a' })]);
  const textC = cell(''); // 낙관적으로 비워진 상태
  let err;
  let restored = 0;
  const body = node();
  const p = completeComposerSend(baseDeps({
    content: 'hi',
    sentLocalIds: new Set(['a']),
    send: () => d.promise,
    onSent: () => { throw new Error('성공 콜백이 호출되면 안 됨'); },
    setPendingAttachments: strip.set,
    setSendError: (m) => { err = m; },
    setText: textC.set,
    readFocus: () => ({ active: body, composerRoot: rootWith(), body }),
    restoreFocus: () => { restored += 1; },
  }));
  d.reject(new Error('network down'));
  await p;
  assert.equal(err, 'network down', '에러 메시지 노출');
  assert.equal(textC.get(), 'hi', '컴포저가 비어 있었으므로 draft 복원');
  assert.deepEqual(strip.get().map((e) => e.localId), ['a'], '실패 시 첨부 보존(재시도용)');
  assert.equal(restored, 1, 'body 면 실패 후에도 focus 복귀');
});

test('P2: 전송 실패했는데 사용자가 이미 다음 메시지를 입력 중 → draft 클로버 금지', async () => {
  const d = deferred();
  const textC = cell('다음 메시지'); // 전송 대기 중 사용자가 입력
  const p = completeComposerSend(baseDeps({
    content: 'hi',
    send: () => d.promise,
    setText: textC.set,
  }));
  d.reject(new Error('network'));
  await p;
  assert.equal(textC.get(), '다음 메시지', '입력 중이면 실패 draft 로 덮어쓰지 않음');
});
