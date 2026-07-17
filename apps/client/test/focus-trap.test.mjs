// 포커스 트랩 인덱스 계산 테스트 (에픽 bf65ca00 · Phase 1 · S4 접근성).
//
// 모바일 모달의 Tab/Shift+Tab 랩어라운드 산술을 node:test 로 검증한다(DOM 불필요).
//
// 실행:  node --import tsx --test apps/client/test/focus-trap.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { nextFocusableIndex } from '../src/components/focusTrap.ts';

test('정방향(Tab): 다음으로, 마지막에서 처음으로 랩', () => {
  assert.equal(nextFocusableIndex(3, 0, false), 1);
  assert.equal(nextFocusableIndex(3, 1, false), 2);
  assert.equal(nextFocusableIndex(3, 2, false), 0); // 마지막 → 처음
});

test('역방향(Shift+Tab): 이전으로, 처음에서 마지막으로 랩', () => {
  assert.equal(nextFocusableIndex(3, 2, true), 1);
  assert.equal(nextFocusableIndex(3, 1, true), 0);
  assert.equal(nextFocusableIndex(3, 0, true), 2); // 처음 → 마지막
});

test('현재 포커스가 목록 밖(-1): 정방향 0, 역방향 마지막', () => {
  assert.equal(nextFocusableIndex(3, -1, false), 0);
  assert.equal(nextFocusableIndex(3, -1, true), 2);
});

test('요소 1개: 항상 자기 자신(0)', () => {
  assert.equal(nextFocusableIndex(1, 0, false), 0);
  assert.equal(nextFocusableIndex(1, 0, true), 0);
});

test('트랩 대상 없음(count<=0): -1 (호출부 no-op)', () => {
  assert.equal(nextFocusableIndex(0, -1, false), -1);
  assert.equal(nextFocusableIndex(0, 0, true), -1);
});
