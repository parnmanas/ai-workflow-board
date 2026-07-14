// agent-manager 버전 collapse 게이트(scripts/check-version-bump.mjs)의 순수 로직 커버리지.
// 핵심은 semver 를 '문자열'이 아니라 '숫자'로 비교하는 것 — 문자열 비교면 1.6.10 < 1.6.9
// 로 잘못 판정해 게이트가 정상 범프를 collapse 로 오탐하거나, 진짜 collapse 를 통과시킨다.
// (ticket c17a8a40, board lesson #1)
//
// git 을 부르는 checkRange 경로는 CI 통합 검증(워크플로 + 실제 --preflight 실행)에서
// 다루고, 여기서는 git 없이 결정적인 순수 함수와 git-free skip 분기만 검증한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseVersion, compareVersions, checkRange } = await import('../scripts/check-version-bump.mjs');

test('parseVersion: x.y.z 를 숫자 3튜플로', () => {
  assert.deepEqual(parseVersion('1.6.19'), [1, 6, 19]);
  assert.deepEqual(parseVersion(' 1.6.19 '), [1, 6, 19], '앞뒤 공백 trim');
  assert.deepEqual(parseVersion('1.6.19-rc.1'), [1, 6, 19], 'prerelease 꼬리 제거');
  assert.deepEqual(parseVersion('2.0.0+build.5'), [2, 0, 0], 'build metadata 제거');
});

test('parseVersion: 형식이 어긋나면 throw', () => {
  assert.throws(() => parseVersion('1.6'), /파싱 불가/);
  assert.throws(() => parseVersion('1.6.x'), /파싱 불가/);
  assert.throws(() => parseVersion('abc'), /파싱 불가/);
  assert.throws(() => parseVersion(''), /파싱 불가/);
});

test('compareVersions: 같은 버전은 0 (collapse 판정의 기준)', () => {
  assert.equal(compareVersions('1.6.19', '1.6.19'), 0);
});

test('compareVersions: patch 증감', () => {
  assert.equal(compareVersions('1.6.20', '1.6.19'), 1);
  assert.equal(compareVersions('1.6.19', '1.6.20'), -1);
});

test('compareVersions: 문자열 비교 함정 — 두 자리 수는 숫자로 비교해야 한다', () => {
  // 문자열 비교면 "1.6.10" < "1.6.9" 로 뒤집힌다. 반드시 숫자 비교여야 함.
  assert.equal(compareVersions('1.6.10', '1.6.9'), 1, '1.6.10 > 1.6.9');
  assert.equal(compareVersions('1.6.9', '1.6.10'), -1, '1.6.9 < 1.6.10');
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '1.10.0 > 1.9.0');
  assert.equal(compareVersions('1.6.100', '1.6.99'), 1, '1.6.100 > 1.6.99');
});

test('compareVersions: minor / major 경계', () => {
  assert.equal(compareVersions('1.7.0', '1.6.99'), 1, 'minor 가 우선');
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1, 'major 가 우선');
  assert.equal(compareVersions('1.6.19', '2.0.0'), -1);
});

test('checkRange: BEFORE ref 가 비었거나 zero-SHA 면 git 없이 skip(pass)', () => {
  const empty = checkRange('', 'HEAD');
  assert.equal(empty.ok, true);
  assert.ok(empty.skipped, '최초 push 로 간주해 skip 사유를 남긴다');

  const zero = checkRange('0'.repeat(40), 'HEAD');
  assert.equal(zero.ok, true, '브랜치 최초 생성(before=0000…) 은 비교 불가 → skip');
  assert.ok(zero.skipped);
});
