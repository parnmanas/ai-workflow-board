// Windows 호스트에서 모델 목록이 영구히 옛 값에 묶여 있던 버그 (실측 2026-10-01).
//
// 증상: ralf(Windows)와 rolf(Linux)가 **같은** claude 2.1.286 을 깔고 있는데 rolf 에는
// Opus 5.5 가 보이고 ralf 에는 영영 안 보였다. 모델 목록 새로고침도, CLI 업그레이드도
// 고치지 못했다.
//
// 원인: npm 은 Windows 에서 symlink 대신 배치 shim 을 떨어뜨리고, cli-resolver 는
// `.exe` 를 well-known 위치에서 못 찾으면 그 shim 을 채택한다("resolved via shim":
// `…\nvm\v22.22.0\claude.cmd`, **160 bytes**). scanBinaryStrings 가 그 160바이트
// 배치 스크립트를 스캔하니 매치가 0개였고, listModels 는 그것을 "이 설치는 모델 문자열을
// 안 싣는다" 로 읽어 하드코딩 폴백 목록(옛 CLAUDE_CURATED_MODELS)으로 내려갔다. 그 목록엔
// `claude-opus-5` 는 있고 `claude-opus-5-5` 는 없다 — 그래서 **영구히** 안 보였다.
// staleness 처럼 보이지만 재열거로 절대 낫지 않는 종류의 실패였고, 폴백이 조용해서
// 진단에 며칠이 걸렸다.
//
// 여기서 고정하는 것 세 가지:
//   1. 배치 shim 을 건네받으면 그 shim 이 실행하는 실제 바이너리로 바꿔 스캔한다.
//   2. 스캔이 비었을 때 **구체 모델 id 를 하드코딩해 메꾸지 않는다** — 그 목록은 정의상
//      썩고 실제 열거 결과와 구분되지 않는다. alias 만 내놓는다(설치된 CLI 에서 각
//      family 의 최신을 자동으로 따라가므로 썩지 않는다).
//   3. 그래도 비면 조용히 넘어가지 않고 로그로 알린다.
//
// IO 는 주입한다 — win32 경로 의미론은 Linux 에서 stat 되지 않으므로(의도된 설계),
// 실제 Windows 파일 없이 POSIX CI 에서 이 판단을 검증하려면 시임이 필요하다.
// 실행: node --test apps/agent-manager/test/claude-model-scan-windows-shim.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveShimTarget } from '../dist/lib/cli-adapters/model-introspect.js';

// ralf 의 `claude.cmd` 실물 (2026-10-01 에 읽은 그대로).
const RALF_SHIM_PATH = 'C:\\Users\\user\\AppData\\Local\\nvm\\v22.22.0\\claude.cmd';
const RALF_SHIM_BODY = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n');
const RALF_REAL_EXE =
  'C:\\Users\\user\\AppData\\Local\\nvm\\v22.22.0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

function io({ files = {}, present = [] } = {}) {
  return {
    read: (p) => (p in files ? files[p] : null),
    isFile: (p) => present.includes(p),
  };
}

test('배치 shim 은 그 shim 이 실행하는 실제 바이너리로 바뀐다 — 160바이트를 스캔하지 않는다', () => {
  const resolved = resolveShimTarget(
    RALF_SHIM_PATH,
    io({ files: { [RALF_SHIM_PATH]: RALF_SHIM_BODY }, present: [RALF_REAL_EXE] }),
  );
  assert.equal(resolved, RALF_REAL_EXE);
});

test('.exe 를 바로 받았으면 그대로 둔다 — shim 처리는 shim 에만 적용된다', () => {
  // rolf 경로. 여기서 shim 파싱이 끼어들면 Linux 가 멀쩡히 돌던 경로를 망가뜨린다.
  const linuxBin = '/home/parn/.npm-global/bin/claude';
  assert.equal(resolveShimTarget(linuxBin, io()), linuxBin);
  assert.equal(resolveShimTarget(RALF_REAL_EXE, io()), RALF_REAL_EXE);
});

test('shim 의 대상이 디스크에 없으면 받은 경로를 그대로 돌려준다 (best-effort)', () => {
  // 반쯤 업데이트된 설치(claude.exe.old.<ts> 로 rename 된 상태). 여기서 없는 경로를
  // 돌려주면 스캔이 ENOENT 로 죽는 대신 조용히 빈 목록이 되어야 한다.
  const resolved = resolveShimTarget(
    RALF_SHIM_PATH,
    io({ files: { [RALF_SHIM_PATH]: RALF_SHIM_BODY }, present: [] }),
  );
  assert.equal(resolved, RALF_SHIM_PATH);
});

test('읽을 수 없는 shim 도 던지지 않는다', () => {
  assert.equal(resolveShimTarget(RALF_SHIM_PATH, io({ files: {}, present: [] })), RALF_SHIM_PATH);
});

test('`.bat` 도 같은 경로를 탄다 — npm 6 레이아웃', () => {
  const batPath = 'C:\\tools\\claude.bat';
  const target = 'C:\\tools\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const body = '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*';
  assert.equal(
    resolveShimTarget(batPath, io({ files: { [batPath]: body }, present: [target] })),
    target,
  );
});


// 폴백이 alias 만 내놓는지(하드코딩 구체 id 가 되살아나지 않는지)는 listModels 계약의
// 원래 홈인 claude-model-enum.test.mjs 가 단언한다 — 여기서 또 쓰면 같은 것을 두 곳에서
// 고정하게 된다.
