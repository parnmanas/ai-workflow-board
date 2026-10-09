// 네이티브 백그라운드 wake 웹 바인딩 — apps/client/src/native/backgroundWake.ts.
//
// 고정하는 것:
//   1. 웹(PWA·브라우저)에서는 전부 폴백 — supported=false, 상태는 빈 값. 백그라운드
//      리스닝이 있다고 거짓말하지 않는다.
//   2. 딥링크 파서: awb://sessions/…?say=… (알림 탭)와 https 공유 링크를 앱 경로로.
//      세션 경로가 아니면 null — 엉뚱한 화면으로 보내지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  backgroundWakeSupported,
  getBackgroundWakeStatus,
  isNativeApp,
  parseAwbDeepLink,
} from '../src/native/backgroundWake.ts';

test('웹에서는 네이티브가 아니다', () => {
  assert.equal(isNativeApp(), false);
});

test('웹 폴백은 지원하지 않는다고 답한다', async () => {
  assert.deepEqual(await backgroundWakeSupported(), { supported: false, reliable: false });
  assert.deepEqual(await getBackgroundWakeStatus(), {
    running: false, enabled: false, mic: false, notifications: false, batteryOptimized: false,
  });
});

test('awb:// 딥링크를 세션 경로로 바꾼다', () => {
  assert.equal(
    parseAwbDeepLink('awb://sessions/host-1/claude/s1?say=%EC%8B%9C%EC%9E%91%ED%95%B4'),
    '/sessions/host-1/claude/s1?say=%EC%8B%9C%EC%9E%91%ED%95%B4',
  );
  assert.equal(parseAwbDeepLink('awb://sessions/h/c/s'), '/sessions/h/c/s');
});

test('https 공유 링크의 세션 경로를 살린다', () => {
  assert.equal(parseAwbDeepLink('https://awb.example.com/sessions/h/c/s?say=x'), '/sessions/h/c/s?say=x');
});

test('세션 경로가 아니면 null이다', () => {
  assert.equal(parseAwbDeepLink('awb://open'), null);
  assert.equal(parseAwbDeepLink('awb://tickets/123'), null);
  assert.equal(parseAwbDeepLink('https://awb.example.com/tickets'), null);
  assert.equal(parseAwbDeepLink('not a url'), null);
  assert.equal(parseAwbDeepLink('tel:+821012345678'), null);
});
