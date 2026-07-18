// 회귀 테스트: Windows npm-shim CLI resolution (ticket e299c6b3).
//
// Windows 에서 `npm i -g` 로 설치된 codex 는 형제 `codex.exe` 없이
// `%APPDATA%\npm\codex.cmd`(배치 shim)만 노출한다. Node 의 spawn() 은 CreateProcess
// 를 직접 호출하는데 `.cmd` 는 실행 못 해서, bare `spawn("codex")` 가
// `spawn codex ENOENT` 로 던지고 모든 codex subagent dispatch 가 5분 루프로 조용히
// 실패했다. 수정은 두 부분:
//   1. selectBinary()(여기서 테스트): `.exe` 가 없으면 `.cmd`/`.bat` shim 으로
//      resolve — 단 진짜 `.exe` 는 항상 우선(feedback_windows_claude_exe_only).
//      platform + fs 존재를 주입하므로 실제 Windows 호스트 없이 테스트 가능.
//   2. spawn 사이트가 그 shim 을 cross-spawn 으로 실행 → `cmd.exe /d /s /c` 로
//      감싸고 인자 escape. 이는 spawn-cmd-arg-escaping.test.mjs 에서 다룬다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBinary, resolveCliBin, _resetResolverCache } from '../dist/lib/cli-resolver.js';

const NPM = 'C:\\Users\\user\\AppData\\Roaming\\npm';

// 가짜 대소문자 무시 Windows 파일시스템: 여기 있는 경로만 "존재"한다.
function winExists(present) {
  const set = new Set(present.map((p) => p.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
}

test('codex: npm .cmd-only shim resolves to the .cmd (no ENOENT literal fallback)', () => {
  // 그런 호스트의 `where codex` 는 확장자 없는 bash 래퍼를 먼저, 그다음 .cmd shim
  // 을 출력한다. .exe candidate 는 디스크에 없다.
  const sources = [
    `${NPM}\\codex`, // MSYS bash 래퍼 — 실행 불가, 무시돼야 함
    `${NPM}\\codex.cmd`, // 진짜 배치 shim
    `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.exe`, // candidate, 없음
    `${NPM}\\codex.cmd`, // last-resort candidate (중복 OK)
  ];
  const picked = selectBinary('codex', sources, {
    isWindows: true,
    exists: winExists([`${NPM}\\codex`, `${NPM}\\codex.cmd`]), // .exe 없음
  });
  assert.equal(picked.kind, 'shim');
  assert.equal(picked.bin, `${NPM}\\codex.cmd`);
});

test('claude: a real .exe always beats a sibling .cmd shim (feedback_windows_claude_exe_only)', () => {
  const PKG = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin`;
  const sources = [
    `${NPM}\\claude`, // bash 래퍼 (존재)
    `${NPM}\\claude.cmd`, // shim (존재)
    `${PKG}\\claude.exe`, // 진짜 exe (존재) — 이겨야 함
    `${NPM}\\claude.cmd`, // last-resort candidate
  ];
  const picked = selectBinary('claude', sources, {
    isWindows: true,
    exists: winExists([`${NPM}\\claude`, `${NPM}\\claude.cmd`, `${PKG}\\claude.exe`]),
  });
  assert.equal(picked.kind, 'exe');
  assert.equal(picked.bin, `${PKG}\\claude.exe`);
});

test('windows: extensionless bash wrapper is never selected even as the only present file', () => {
  const sources = [`${NPM}\\codex`]; // MSYS 래퍼만 존재
  const picked = selectBinary('codex', sources, {
    isWindows: true,
    exists: winExists([`${NPM}\\codex`]),
  });
  // .exe 도 .cmd/.bat 도 없음 → literal fallback, 실행 불가한 bash 래퍼가 아님.
  assert.equal(picked.kind, 'literal');
  assert.equal(picked.bin, 'codex');
});

test('windows: a .cmd path that is not on disk is not selected', () => {
  const picked = selectBinary('codex', [`${NPM}\\codex.cmd`], {
    isWindows: true,
    exists: winExists([]), // 아무것도 없음
  });
  assert.equal(picked.kind, 'literal');
  assert.equal(picked.bin, 'codex');
});

test('windows: first present .exe wins over a later .exe', () => {
  const a = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.exe`;
  const b = 'C:\\Program Files\\codex\\codex.exe';
  const picked = selectBinary('codex', [a, b], {
    isWindows: true,
    exists: winExists([a, b]),
  });
  assert.equal(picked.kind, 'exe');
  assert.equal(picked.bin, a);
});

test('posix: first executable file wins; extension is irrelevant', () => {
  const sources = ['/usr/local/bin/codex', '/home/u/.npm-global/bin/codex'];
  const picked = selectBinary('codex', sources, {
    isWindows: false,
    exists: (p) => p === '/home/u/.npm-global/bin/codex', // /usr/local 쪽은 없음
  });
  assert.equal(picked.kind, 'exe');
  assert.equal(picked.bin, '/home/u/.npm-global/bin/codex');
});

test('posix: nothing executable → literal fallback', () => {
  const picked = selectBinary('codex', ['/usr/bin/codex'], {
    isWindows: false,
    exists: () => false,
  });
  assert.equal(picked.kind, 'literal');
  assert.equal(picked.bin, 'codex');
});

test('resolveCliBin smoke: returns a non-empty string on the current host', () => {
  _resetResolverCache();
  const bin = resolveCliBin('codex');
  assert.equal(typeof bin, 'string');
  assert.ok(bin.length > 0);
  _resetResolverCache();
});
