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
//
// (리뷰 지적 반영) "설치돼 있는가"만으로는 이 티켓의 원 회귀(702d0ebe — codex가
// 구버전 snap을 npm-global보다 먼저 잡음)를 판별할 수 없다 — 실제로 *어느*
// 절대경로가 선택됐는지가 필요하다. 아래는 그 경로가 실제로 새어 나오는지,
// 경로 해석 자체가 실패해도 기동이 죽지 않는지, 공백 섞인 경로도 한 줄 로그에서
// 모호하지 않게 렌더링되는지를 검증한다.

test('checkAuxiliaryCli는 resolveBin이 고른 절대경로로 probe하고 그 경로를 반환한다', async () => {
  const calls = [];
  const result = await checkAuxiliaryCli(
    'gh',
    async (command, args) => {
      calls.push({ command, args });
      return { installed: true, healthy: true, version: 'gh version 2.97.0 (2026-07-31)', reason: null };
    },
    (cliType) => {
      assert.equal(cliType, 'gh', 'resolveBin에는 호출한 CLI 이름이 그대로 전달돼야 한다');
      return '/home/parn/.local/bin/gh';
    },
  );
  assert.deepEqual(
    result,
    {
      installed: true,
      healthy: true,
      version: 'gh version 2.97.0 (2026-07-31)',
      reason: null,
      resolvedPath: '/home/parn/.local/bin/gh',
    },
    'probe 결과에 resolveBin이 고른 절대경로가 resolvedPath로 실려야 한다',
  );
  assert.deepEqual(
    calls,
    [{ command: '/home/parn/.local/bin/gh', args: ['--version'] }],
    'probe는 literal 이름이 아니라 resolveBin이 고른 절대경로로 실행돼야 한다 — 그래야 로그의 경로와 실제 실행된 파일이 항상 일치한다',
  );
});

test('checkAuxiliaryCli는 resolveBin이 literal 이름을 반환하면(해석 실패) resolvedPath를 null로 둔다', async () => {
  const result = await checkAuxiliaryCli(
    'gh',
    async () => ({ installed: false, healthy: false, version: null, reason: 'not_found' }),
    () => 'gh', // resolveCliBin의 literal fallback — 절대경로가 아니다
  );
  assert.equal(result.resolvedPath, null, 'literal 이름은 절대경로가 아니므로 resolvedPath는 null이어야 한다');
  assert.equal(result.installed, false);
});

test('checkAuxiliaryCli는 resolveBin이 throw해도 죽지 않고 literal 이름으로 계속 probe한다', async () => {
  const calls = [];
  const result = await checkAuxiliaryCli(
    'gh',
    async (command) => {
      calls.push(command);
      return { installed: true, healthy: true, version: 'gh version 2.97.0', reason: null };
    },
    () => {
      throw new Error('resolveCliBin boom');
    },
  );
  assert.equal(result.resolvedPath, null, '경로 해석이 throw하면 resolvedPath는 null로 degrade해야 한다');
  assert.deepEqual(
    calls,
    ['gh'],
    'resolveBin이 throw해도 probe는 literal 이름으로 계속 시도해야 한다(기동 실패로 전파되면 안 됨)',
  );
});

test('checkAuxiliaryCli는 probe가 throw해도 죽지 않고 probe_unavailable로 degrade한다(resolvedPath는 보존)', async () => {
  const result = await checkAuxiliaryCli(
    'gh',
    async () => {
      throw new Error('boom');
    },
    () => '/usr/bin/gh',
  );
  assert.deepEqual(
    result,
    { installed: false, healthy: false, version: null, reason: 'probe_unavailable', resolvedPath: '/usr/bin/gh' },
    'probe가 throw해도 probe_unavailable로 degrade해야 하고, 이미 구한 경로는 진단을 위해 보존돼야 한다(기동 로그 자체가 죽으면 안 됨)',
  );
});

test('formatCliResolutionSummary는 설치된 CLI를 버전@"절대경로"로, 미설치 CLI는 사유@-로 렌더링한다', () => {
  const line = formatCliResolutionSummary([
    [
      'claude',
      { installed: true, healthy: true, version: 'claude 2.1.3', reason: null, resolvedPath: '/usr/local/bin/claude' },
    ],
    [
      'codex',
      {
        installed: true,
        healthy: true,
        version: 'codex 0.146.0',
        reason: null,
        resolvedPath: '/home/parn/.npm-global/bin/codex',
      },
    ],
    ['gh', { installed: false, healthy: false, version: null, reason: 'not_found', resolvedPath: null }],
    ['git', { installed: true, healthy: true, version: 'git version 2.43.0', reason: null, resolvedPath: '/usr/bin/git' }],
  ]);
  assert.equal(
    line,
    'claude=claude 2.1.3@"/usr/local/bin/claude" codex=codex 0.146.0@"/home/parn/.npm-global/bin/codex" gh=NOT_FOUND(not_found)@- git=git version 2.43.0@"/usr/bin/git"',
    '한 줄 요약 포맷이 어긋나면 운영자가 agent-manager.log에서 grep하기 어려워진다',
  );
});

test('formatCliResolutionSummary는 버전 문자열이 없는 healthy probe를 "installed"로 대체한다', () => {
  const line = formatCliResolutionSummary([
    ['git', { installed: true, healthy: true, version: null, reason: null, resolvedPath: '/usr/bin/git' }],
  ]);
  assert.equal(line, 'git=installed@"/usr/bin/git"', 'version이 없어도 installed=true면 "installed"로 표시돼야 한다');
});

test('formatCliResolutionSummary는 사유가 없는 미설치 probe를 "unknown"으로 대체한다', () => {
  const line = formatCliResolutionSummary([
    ['gh', { installed: false, healthy: false, version: null, reason: null, resolvedPath: null }],
  ]);
  assert.equal(line, 'gh=NOT_FOUND(unknown)@-', 'reason이 없어도 NOT_FOUND(unknown)으로 표시돼야 한다');
});

test('formatCliResolutionSummary는 경로에 공백이 있어도 큰따옴표로 감싸 한 줄 로그를 모호하지 않게 렌더링한다', () => {
  const line = formatCliResolutionSummary([
    [
      'gh',
      {
        installed: true,
        healthy: true,
        version: '2.97.0',
        reason: null,
        resolvedPath: 'C:\\Program Files\\GitHub CLI\\gh.exe',
      },
    ],
    ['git', { installed: true, healthy: true, version: '2.43.0', reason: null, resolvedPath: '/usr/bin/git' }],
  ]);
  assert.equal(
    line,
    'gh=2.97.0@"C:\\Program Files\\GitHub CLI\\gh.exe" git=2.43.0@"/usr/bin/git"',
    '경로 안의 공백이 큰따옴표로 감싸져 있어야 다음 id=value 항목과의 경계가 모호해지지 않는다',
  );
  assert.ok(
    line.includes('gh=2.97.0@"C:\\Program Files\\GitHub CLI\\gh.exe"'),
    'gh 항목은 공백이 있어도 여는/닫는 큰따옴표로 하나의 값임을 명확히 알 수 있어야 한다',
  );
});

test('formatCliResolutionSummary는 경로에 포함된 큰따옴표를 이스케이프한다', () => {
  const line = formatCliResolutionSummary([
    ['gh', { installed: true, healthy: true, version: '2.97.0', reason: null, resolvedPath: '/weird/"quoted"/gh' }],
  ]);
  assert.equal(line, 'gh=2.97.0@"/weird/\\"quoted\\"/gh"');
});
