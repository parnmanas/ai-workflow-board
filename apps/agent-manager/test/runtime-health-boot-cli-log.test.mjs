import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkAuxiliaryCli,
  formatCliResolutionSummary,
} from '../dist/lib/runtime/runtime-health.js';

// ticket 49c173c8 — systemd PATH 드롭인이 ~/.local/bin을 조용히 빠뜨려 `gh`가
// 다른 곳에서는 다 되는데 에이전트 세션 안에서만 해석되지 않았고, 매니저 쪽엔
// 아무 신호도 없었다. 이 두 헬퍼는 다음번 같은 사각지대를 조기에 잡기 위한
// 기동 시점 1회 로그(main.ts)를 뒷받침한다.

test('checkAuxiliaryCli는 설치된 probe 결과를 그대로 통과시킨다', async () => {
  const result = await checkAuxiliaryCli('gh', async (command, args) => {
    assert.equal(command, 'gh', 'probe에 넘기는 command는 호출한 CLI 이름이어야 한다');
    assert.deepEqual(args, ['--version'], 'probe 인자는 --version이어야 한다');
    return { installed: true, healthy: true, version: 'gh version 2.97.0 (2026-07-31)', reason: null };
  });
  assert.deepEqual(
    result,
    { installed: true, healthy: true, version: 'gh version 2.97.0 (2026-07-31)', reason: null },
    '설치된 CLI의 probe 결과는 변형 없이 그대로 반환돼야 한다',
  );
});

test('checkAuxiliaryCli는 미설치 probe 결과도 그대로 통과시킨다', async () => {
  const result = await checkAuxiliaryCli('gh', async () => ({
    installed: false,
    healthy: false,
    version: null,
    reason: 'not_found',
  }));
  assert.equal(result.installed, false, '미설치 CLI는 installed=false를 유지해야 한다');
  assert.equal(result.reason, 'not_found', '미설치 사유(reason)가 그대로 전달돼야 한다');
});

test('checkAuxiliaryCli는 probe가 throw해도 죽지 않고 probe_unavailable로 degrade한다', async () => {
  const result = await checkAuxiliaryCli('gh', async () => {
    throw new Error('boom');
  });
  assert.deepEqual(
    result,
    { installed: false, healthy: false, version: null, reason: 'probe_unavailable' },
    'probe가 throw하면 probe_unavailable 형태로 degrade해야 한다(기동 로그 자체가 죽으면 안 됨)',
  );
});

test('formatCliResolutionSummary는 설치된 CLI는 버전으로, 미설치 CLI는 사유로 렌더링한다', () => {
  const line = formatCliResolutionSummary([
    ['claude', { installed: true, healthy: true, version: 'claude 2.1.3', reason: null }],
    ['codex', { installed: true, healthy: true, version: 'codex 0.146.0', reason: null }],
    ['gh', { installed: false, healthy: false, version: null, reason: 'not_found' }],
    ['git', { installed: true, healthy: true, version: 'git version 2.43.0', reason: null }],
  ]);
  assert.equal(
    line,
    'claude=claude 2.1.3 codex=codex 0.146.0 gh=NOT_FOUND(not_found) git=git version 2.43.0',
    '한 줄 요약 포맷이 어긋나면 운영자가 agent-manager.log에서 grep하기 어려워진다',
  );
});

test('formatCliResolutionSummary는 버전 문자열이 없는 healthy probe를 "installed"로 대체한다', () => {
  const line = formatCliResolutionSummary([
    ['git', { installed: true, healthy: true, version: null, reason: null }],
  ]);
  assert.equal(line, 'git=installed', 'version이 없어도 installed=true면 "installed"로 표시돼야 한다');
});

test('formatCliResolutionSummary는 사유가 없는 미설치 probe를 "unknown"으로 대체한다', () => {
  const line = formatCliResolutionSummary([
    ['gh', { installed: false, healthy: false, version: null, reason: null }],
  ]);
  assert.equal(line, 'gh=NOT_FOUND(unknown)', 'reason이 없어도 NOT_FOUND(unknown)으로 표시돼야 한다');
});
