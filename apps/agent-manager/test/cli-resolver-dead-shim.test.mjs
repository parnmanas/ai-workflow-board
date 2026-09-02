// 회귀 테스트: 죽은 Windows 배치 shim 은 후보에서 탈락한다.
//
// 인시던트: 호스트에 npm 전역 prefix 가 둘 있었고(`C:\nvm4w\nodejs` = 활성,
// `%APPDATA%\npm` = 낡은 잔존), 후자 안에서 Claude Code 자기 업데이트가
// `bin\claude.exe` 를 `claude.exe.old.<ts>` 로 rename 해놓고 새 바이너리를 못
// 떨어뜨렸다. `%APPDATA%\npm\claude.cmd` 는 그대로 남아 있었고, well-known 후보가
// PATH lookup 보다 먼저 오는 규칙(ticket ce65cf25) 때문에 resolveCliBin 이 매 부팅
// 마다 그 죽은 shim 을 고정했다 — PATH 에는 정상 설치(2.1.258)가 있었는데도.
// 결과: 모든 claude dispatch 가 cmd.exe 의 로케일 의존적인
// "'…\claude.exe'은(는) 내부 또는 외부 명령…" 로 죽었고, 셸에서 `claude` 는 멀쩡히
// 동작해서 진단이 어긋났다.
//
// 수정: shim 은 존재만으로 채택되지 않고, 본문에서 실행 대상을 파싱해 그 대상이
// 디스크에 있을 때만 후보로 인정한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWindowsShimTargets,
  windowsShimIsUsable,
  selectBinary,
} from '../dist/lib/cli-resolver.js';

const STALE = 'C:\\Users\\user\\AppData\\Roaming\\npm';
const ACTIVE = 'C:\\nvm4w\\nodejs';

// npm 7+ 가 네이티브 바이너리 bin 에 대해 생성하는 shim (실제 claude.cmd).
const NATIVE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;

// npm 7+ 가 JS entrypoint 에 대해 생성하는 shim (실제 codex.cmd / eslint.cmd).
// `%dp0%\node.exe` 는 IF EXIST 가드 + SET 대입으로만 등장하므로 필수 대상이 아니다.
const JS_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

// npm 6 형식: 호출 줄에서 `%~dp0\node.exe` 를 직접 쓰되 ELSE 로 PATH 의 node 에
// fall back 한다 — node 인터프리터는 여전히 필수 대상이 아니다.
const LEGACY_SHIM = `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\node_modules\\pkg\\bin\\cli.js" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\node_modules\\pkg\\bin\\cli.js" %*
)
`;

function fs(present) {
  const set = new Set(present.map((p) => p.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
}

test('parse: native-binary shim yields its single .exe target, dp0 double separators normalized', () => {
  const targets = parseWindowsShimTargets(NATIVE_SHIM, `${STALE}\\claude.cmd`);
  assert.deepEqual(targets, [
    `${STALE}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
  ]);
});

test('parse: JS-entrypoint shim yields the .js target only — node.exe is not required', () => {
  const targets = parseWindowsShimTargets(JS_SHIM, `${STALE}\\codex.cmd`);
  assert.deepEqual(targets, [`${STALE}\\node_modules\\@openai\\codex\\bin\\codex.js`]);
});

test('parse: legacy npm 6 shim also treats the node interpreter as optional', () => {
  const targets = parseWindowsShimTargets(LEGACY_SHIM, `${STALE}\\pkg.cmd`);
  assert.deepEqual(targets, [`${STALE}\\node_modules\\pkg\\bin\\cli.js`]);
});

test('usable: a shim whose target is on disk is usable', () => {
  const shim = `${ACTIVE}\\claude.cmd`;
  assert.equal(
    windowsShimIsUsable(shim, {
      read: () => NATIVE_SHIM,
      exists: fs([`${ACTIVE}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`]),
    }),
    true,
  );
});

test('usable: a shim whose target was renamed away is NOT usable', () => {
  const shim = `${STALE}\\claude.cmd`;
  assert.equal(
    windowsShimIsUsable(shim, {
      read: () => NATIVE_SHIM,
      // 자기 업데이트가 남긴 잔해만 있고 claude.exe 는 없다.
      exists: fs([
        `${STALE}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe.old.1788172540303`,
      ]),
    }),
    false,
  );
});

test('usable: an unreadable or unrecognized shim is accepted (conservative — never guess it is broken)', () => {
  assert.equal(windowsShimIsUsable('x.cmd', { read: () => null, exists: () => false }), true);
  assert.equal(
    windowsShimIsUsable('x.cmd', { read: () => '@echo off\r\nsomething-on-PATH %*\r\n', exists: () => false }),
    true,
  );
});

test('regression: a dead well-known shim loses to a working PATH shim of the same CLI', () => {
  // 인시던트 그대로의 후보 순서 — well-known(낡고 깨진 prefix) 먼저, PATH(정상) 나중.
  const sources = [
    `${STALE}\\claude.exe`, // 없음
    'C:\\Users\\user\\AppData\\Local\\Programs\\anthropic\\claude-code\\claude.exe', // 없음
    `${STALE}\\claude.cmd`, // 존재하지만 대상이 사라진 죽은 shim
    `${ACTIVE}\\claude`, // 확장자 없는 MSYS 래퍼 — 절대 선택 금지
    `${ACTIVE}\\claude.cmd`, // 정상 설치
  ];
  const picked = selectBinary('claude', sources, {
    isWindows: true,
    exists: fs([`${STALE}\\claude.cmd`, `${ACTIVE}\\claude`, `${ACTIVE}\\claude.cmd`]),
    shimUsable: (p) => p.toLowerCase() !== `${STALE}\\claude.cmd`.toLowerCase(),
  });
  assert.equal(picked.kind, 'shim');
  assert.equal(picked.bin, `${ACTIVE}\\claude.cmd`);
});

test('regression: when every shim is dead, fall back to literal rather than pinning a broken one', () => {
  const picked = selectBinary('claude', [`${STALE}\\claude.cmd`], {
    isWindows: true,
    exists: fs([`${STALE}\\claude.cmd`]),
    shimUsable: () => false,
  });
  assert.equal(picked.kind, 'literal');
  assert.equal(picked.bin, 'claude');
});

test('a real .exe still wins over a working shim listed earlier (invariant preserved)', () => {
  const exe = `${STALE}\\node_modules\\@openai\\codex\\bin\\codex.exe`;
  const picked = selectBinary('codex', [`${STALE}\\codex.cmd`, exe], {
    isWindows: true,
    exists: fs([`${STALE}\\codex.cmd`, exe]),
    shimUsable: () => true,
  });
  assert.equal(picked.kind, 'exe');
  assert.equal(picked.bin, exe);
});

test('POSIX is untouched: shimUsable is never consulted off Windows', () => {
  const picked = selectBinary('claude', ['/usr/local/bin/claude'], {
    isWindows: false,
    exists: () => true,
    shimUsable: () => {
      throw new Error('shimUsable must not be called on POSIX');
    },
  });
  assert.equal(picked.bin, '/usr/local/bin/claude');
});
