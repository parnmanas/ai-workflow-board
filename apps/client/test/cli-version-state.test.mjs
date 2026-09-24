// cliUpdateState — "설치된 CLI 가 최신인가" 판정. Update 버튼을 잠글지 말지를
// 가르는 한 곳이라, 세 상태(최신/구버전/모름)가 서로 새면 안 된다.

import assert from 'node:assert/strict';
import test from 'node:test';

const { cliUpdateState, extractSemver } = await import('../src/utils/cliVersions.ts');

test('CLI 마다 다른 버전 장식을 벗기고 비교한다', () => {
  assert.equal(extractSemver('2.1.281 (Claude Code)'), '2.1.281');
  assert.equal(extractSemver('codex-cli 0.153.4'), '0.153.4');
  assert.equal(extractSemver('v1.18.32'), '1.18.32');
  assert.equal(extractSemver('nightly'), null);

  assert.equal(cliUpdateState('2.1.273 (Claude Code)', '2.1.281'), 'outdated');
  assert.equal(cliUpdateState('2.1.281 (Claude Code)', '2.1.281'), 'up-to-date');
  assert.equal(cliUpdateState('codex-cli 0.153.4', '0.156.1'), 'outdated');
});

test('자리별로 숫자를 비교한다 — 문자열 비교는 0.9.0 을 0.10.0 보다 새것으로 만든다', () => {
  assert.equal(cliUpdateState('0.9.0', '0.10.0'), 'outdated');
  assert.equal(cliUpdateState('2.1.9', '2.1.10'), 'outdated');
  assert.equal(cliUpdateState('2.2.0', '2.1.281'), 'up-to-date');
});

test('최신을 모르면 unknown 이다 — 그 경우 화면은 버튼을 잠그지 않는다', () => {
  assert.equal(cliUpdateState('2.1.281', null), 'unknown');
  assert.equal(cliUpdateState('2.1.281', undefined), 'unknown');
  assert.equal(cliUpdateState(null, '2.1.281'), 'unknown');
  assert.equal(cliUpdateState('nightly', '2.1.281'), 'unknown');
});

test('설치본이 배포본보다 앞서 있으면 올릴 게 없다 — up-to-date 로 접는다', () => {
  assert.equal(cliUpdateState('2.2.0', '2.1.281'), 'up-to-date');
});
