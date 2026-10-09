// 회귀 테스트 — PWA 서버 주소 설정 순수 규칙 (serverConfig.ts).
//
// 외딴 서버를 가리키는 PWA의 전제 세 가지:
//   1. normalizeServerUrl이 입력을 하나로 모은다(후행 슬래시·공백·대소문자 무관).
//   2. http 외 스킴(javascript: 등)은 거부한다 — 저장값이 fetch/SSE URL에 그대로 들어가서다.
//   3. https 페이지 + http 서버 조합을 미리 경고한다(mixed content는 브라우저가 차단).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeServerUrl,
  isMixedContentRisk,
} from '../src/serverConfig.ts';

test('빈 입력은 same-origin("")이다', () => {
  assert.equal(normalizeServerUrl(''), '');
  assert.equal(normalizeServerUrl('   '), '');
});

test('후행 슬래시·경로 슬래시를 정리한다', () => {
  assert.equal(normalizeServerUrl('https://awb.example.com/'), 'https://awb.example.com');
  assert.equal(normalizeServerUrl('  http://192.168.1.10:7701///  '), 'http://192.168.1.10:7701');
});

test('subpath 배포의 경로는 유지한다', () => {
  assert.equal(normalizeServerUrl('https://host/awb/'), 'https://host/awb');
});

test('http 외 스킴은 거부한다', () => {
  for (const bad of ['javascript:alert(1)', 'ftp://host/x', 'awb.example.com', '://x']) {
    assert.throws(() => normalizeServerUrl(bad), /올바르지|입력할 수/, `${bad} 가 거부되지 않았다`);
  }
});

test('https 페이지에서 http 서버는 mixed-content 위험이다', () => {
  assert.equal(isMixedContentRisk('http://192.168.1.10:7701', 'https:'), true);
  assert.equal(isMixedContentRisk('https://awb.example.com', 'https:'), false);
  assert.equal(isMixedContentRisk('http://192.168.1.10:7701', 'http:'), false);
});
