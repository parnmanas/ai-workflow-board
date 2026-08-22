// 배포 후 stale 탭 청크 로드 실패 복구 순수 로직 테스트 (ticket 2cae7314).
//
// react/DOM 불필요 — sessionStorage 는 최소 get/set 인터페이스로 주입한다
// (board memory: client 로직 DI-extract node:test).
//
// 실행:  node --import tsx --test apps/client/test/chunk-reload.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isChunkLoadError,
  shouldReloadForChunkError,
  CHUNK_RELOAD_GUARD_KEY,
} from '../src/utils/chunkReload.ts';

// 가짜 sessionStorage — Map 기반, DOM/브라우저 불필요.
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
    _map: map,
  };
}

test('shouldReloadForChunkError: 이번 세션 첫 실패는 가드를 세우고 true(=지금 reload)', () => {
  const storage = fakeStorage();
  assert.equal(storage.getItem(CHUNK_RELOAD_GUARD_KEY), null);
  assert.equal(shouldReloadForChunkError(storage), true);
  assert.equal(storage.getItem(CHUNK_RELOAD_GUARD_KEY), '1', 'reload 전 가드를 먼저 세워야 한다');
});

test('shouldReloadForChunkError: 이미 가드가 세워져 있으면(재시도 후 재실패) false — 무한 루프 방지', () => {
  const storage = fakeStorage({ [CHUNK_RELOAD_GUARD_KEY]: '1' });
  assert.equal(shouldReloadForChunkError(storage), false);
});

test('shouldReloadForChunkError: 같은 세션 내 반복 호출은 최초 1회만 true', () => {
  const storage = fakeStorage();
  assert.equal(shouldReloadForChunkError(storage), true);
  assert.equal(shouldReloadForChunkError(storage), false);
  assert.equal(shouldReloadForChunkError(storage), false);
});

test('isChunkLoadError: 브라우저별 동적 import 실패 메시지를 인식', () => {
  assert.equal(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/y.js')), true);
  assert.equal(isChunkLoadError(new TypeError('error loading dynamically imported module: https://x/y.js')), true);
  assert.equal(isChunkLoadError(new Error('Importing a module script failed')), true);
  assert.equal(isChunkLoadError(new Error('Loading chunk 4 failed.')), true);
  assert.equal(isChunkLoadError(new Error('Loading CSS chunk 4 failed.')), true);
});

test('isChunkLoadError: 무관한 오류는 false', () => {
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'foo')")), false);
  assert.equal(isChunkLoadError(new Error('network error')), false);
  assert.equal(isChunkLoadError('a plain string'), false);
  assert.equal(isChunkLoadError(undefined), false);
});
