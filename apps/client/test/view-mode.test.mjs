// ViewMode 순수 로직 회귀 테스트 (에픽 bf65ca00 · Phase 1 · S1 공통 셸).
//
// 미러가 아니라 App/컨텍스트/토글이 실제로 import 하는 src/contexts/viewMode.ts 를
// 그대로 구동한다. 라우팅 기본 섹션 매핑(defaultSectionForMode)이나 지속/기본값
// 로직(readInitialMode/persistMode)을 오배선하면 이 테스트가 실패한다.
//
// 실행:  node --import tsx --test apps/client/test/view-mode.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultSectionForMode,
  readInitialMode,
  persistMode,
  STORAGE_KEY,
} from '../src/contexts/viewMode.ts';

// ─── 1. 라우팅 기본 섹션 (단일 진실) ──────────────────────────────────────────

test('defaultSectionForMode: chat → assistant(Chat-first 홈)', () => {
  assert.equal(defaultSectionForMode('chat'), 'assistant');
});

test('defaultSectionForMode: advanced → boards(기존 Board)', () => {
  assert.equal(defaultSectionForMode('advanced'), 'boards');
});

// ─── 2. 지속/기본값 (window.localStorage 샤임) ───────────────────────────────

/** jsdom 없이 window.localStorage 만 흉내 내는 최소 샤임. */
function withWindow(store, fn) {
  const had = 'window' in globalThis;
  const prev = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
  };
  try {
    return fn();
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

test('readInitialMode: window 없음(노드) → 기본 chat', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(readInitialMode(), 'chat');
});

test('readInitialMode: 저장값 advanced → 복원', () => {
  withWindow({ [STORAGE_KEY]: 'advanced' }, () => {
    assert.equal(readInitialMode(), 'advanced');
  });
});

test('readInitialMode: 손상된 저장값 → 기본 chat(폴백)', () => {
  withWindow({ [STORAGE_KEY]: 'garbage' }, () => {
    assert.equal(readInitialMode(), 'chat');
  });
});

test('persistMode → readInitialMode 왕복', () => {
  const store = {};
  withWindow(store, () => {
    persistMode('advanced');
    assert.equal(store[STORAGE_KEY], 'advanced', 'localStorage 에 기록');
    assert.equal(readInitialMode(), 'advanced', '기록값을 복원');
  });
});
