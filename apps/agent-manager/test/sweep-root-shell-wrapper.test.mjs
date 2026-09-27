// 턴 종료 스윕이 **자기 세션의 CLI** 를 orphan 으로 잡으면 안 된다.
//
// 실측 증상 (2026-09-27, ralf/Windows): TXIV 의 예약 Action 두 개(T3 perf sweep ·
// T4 docs sync)가 6일 연속 전부 실패했고 아무도 몰랐다. 매일 에이전트 세션만 태우고
// 산출물이 없었다. 실패 요약은 항상 같았다:
//
//   session cleanup killed 1 live background task(s) — …
//   reaped pids: 257196. pid=257196 "C:\Users\…\nvm\v22.22.0\\node_modules\@anthropic-ai\claude-cod…"
//
// 죽은 것은 **그 run 자신의 claude** 였다. 원인은 Windows 의 shim 실행 방식이다:
// npm 글로벌 `.cmd` shim 으로만 잡히는 CLI 는 cross-spawn 이 `cmd.exe /d /s /c <shim>`
// 으로 감싼다. 그래서 우리가 들고 있는 pid 는 cmd.exe 이고 진짜 CLI 는 그 외동 자식이다.
// 스윕이 cmd.exe 에서 내려가면 CLI 자신이 "남겨진 백그라운드 태스크" 로 잡힌다.
// POSIX 에는 이 래퍼가 없어서 같은 코드가 리눅스 호스트에서는 멀쩡했다.
//
// 그래서 고정하는 것: 스윕의 뿌리는 셸 래퍼를 뚫고 내려간 **진짜 CLI** 다.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectNonBenignDescendants,
  isShellWrapperCmd,
  resolveSweepRoot,
} from '../dist/lib/process-tree.js';

// ralf 에서 실제로 읽은 트리 모양 그대로.
const WRAPPER = 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "C:\\Users\\user\\AppData\\Local\\nvm\\v22.22.0\\claude.cmd ^"--resume^" ^"4da61…"';
const CLI = '"C:\\Users\\user\\AppData\\Local\\nvm\\v22.22.0\\\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" "--resume"';

const RALF = [
  { pid: 313068, ppid: 1, cmd: 'awb-agent-manager' },
  { pid: 275388, ppid: 313068, cmd: WRAPPER },
  { pid: 310260, ppid: 275388, cmd: CLI },
];

test('Windows cmd.exe 래퍼를 뚫고 진짜 CLI 를 뿌리로 삼는다', () => {
  assert.equal(resolveSweepRoot(RALF, 275388), 310260);
});

test('보정한 뿌리로 스윕하면 세션 자신의 CLI 가 orphan 으로 잡히지 않는다', () => {
  // 고치기 전: 래퍼에서 내려가 CLI 를 잡고 죽였다.
  const before = collectNonBenignDescendants(RALF, 275388);
  assert.deepEqual(before.map((p) => p.pid), [310260], '이것이 6일 동안 일어나던 일이다');

  // 고친 뒤: 깨끗한 턴 종료 — 남겨진 것이 없다.
  const after = collectNonBenignDescendants(RALF, resolveSweepRoot(RALF, 275388));
  assert.deepEqual(after, []);
});

test('CLI 가 띄운 진짜 백그라운드 작업은 그대로 잡는다', () => {
  // 보정이 "아무것도 안 잡는다" 로 퇴화하면 이 기능 자체가 무의미해진다.
  const withOrphan = [...RALF, { pid: 400100, ppid: 310260, cmd: 'node long-running-scraper.js' }];
  const found = collectNonBenignDescendants(withOrphan, resolveSweepRoot(withOrphan, 275388));
  assert.deepEqual(found.map((p) => p.pid), [400100]);
});

test('자식이 하나가 아니면 내려가지 않는다 — 모르는 모양에서는 예전대로 동작한다', () => {
  const twoKids = [...RALF, { pid: 400200, ppid: 275388, cmd: 'node something-else.js' }];
  assert.equal(resolveSweepRoot(twoKids, 275388), 275388);
});

test('CLI 가 이미 죽어 래퍼만 남았으면 내려갈 곳이 없다', () => {
  const orphanWrapper = [RALF[0], RALF[1]];
  assert.equal(resolveSweepRoot(orphanWrapper, 275388), 275388);
  // 자식이 없으므로 스윕 결과도 비어 있다 → 정상 종료로 처리된다.
  assert.deepEqual(collectNonBenignDescendants(orphanWrapper, 275388), []);
});

test('래퍼가 아닌 뿌리는 그대로 둔다 (POSIX 경로 회귀)', () => {
  const posix = [
    { pid: 100, ppid: 1, cmd: 'awb-agent-manager' },
    { pid: 200, ppid: 100, cmd: '/usr/local/bin/claude --resume abc' },
    { pid: 300, ppid: 200, cmd: 'node scraper.js' },
  ];
  assert.equal(resolveSweepRoot(posix, 200), 200, 'CLI 를 직접 spawn 한 경우는 보정할 것이 없다');
  assert.deepEqual(collectNonBenignDescendants(posix, resolveSweepRoot(posix, 200)).map((p) => p.pid), [300]);
});

test('알 수 없는 pid 는 그대로 돌려준다', () => {
  assert.equal(resolveSweepRoot(RALF, 999999), 999999);
  assert.equal(resolveSweepRoot([], 275388), 275388);
});

test('ppid 사이클이 있어도 멈춘다', () => {
  // 망가진 프로세스 테이블이 스윕을 영원히 돌게 만들면 안 된다.
  const cyclic = [
    { pid: 1, ppid: 2, cmd: 'cmd.exe /c a' },
    { pid: 2, ppid: 1, cmd: 'cmd.exe /c b' },
  ];
  assert.ok(Number.isInteger(resolveSweepRoot(cyclic, 1)));
});

// ─── 래퍼 판정 ────────────────────────────────────────────────────────────

test('셸 래퍼만 래퍼로 본다', () => {
  assert.equal(isShellWrapperCmd(WRAPPER), true);
  assert.equal(isShellWrapperCmd('cmd.exe /c "foo.cmd"'), true);
  assert.equal(isShellWrapperCmd('"c:\\windows\\system32\\cmd.exe" /c "powershell -NoProfile"'), true);
  assert.equal(isShellWrapperCmd('/bin/sh -c "exec node x.js"'), true);
  assert.equal(isShellWrapperCmd('/bin/bash -lc "npm start"'), true);

  // 대화형 셸은 우리가 실행을 위임한 래퍼가 아니다 — 뚫고 내려가면 스윕의 뿌리가
  // 엉뚱한 곳으로 옮겨 간다.
  assert.equal(isShellWrapperCmd('cmd.exe'), false);
  assert.equal(isShellWrapperCmd('/bin/bash'), false);
  // CLI 자체를 래퍼로 오인하면 한 칸 더 내려가 진짜 orphan 을 놓친다.
  assert.equal(isShellWrapperCmd(CLI), false);
  assert.equal(isShellWrapperCmd('node scraper.js'), false);
  // 경로에 'sh' 가 들어간다고 셸이 아니다.
  assert.equal(isShellWrapperCmd('/opt/shiny/bin/shiny-server'), false);
});
