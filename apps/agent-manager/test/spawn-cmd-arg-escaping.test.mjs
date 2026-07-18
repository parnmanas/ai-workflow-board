// 회귀 테스트: spawn 사이트는 CLI 를 cross-spawn 으로 실행한다(raw spawn +
// `shell: true` 가 아니라). 그래서 Windows `.cmd`/`.bat` shim 이 cmd.exe 로,
// 인자를 PROPERLY ESCAPED 해 감싸진다(ticket e299c6b3). 순수 `shell: true` 는
// 인자를 escape 없이 이어붙여(Node DEP0190) codex 의 inline-TOML `-c` attribution
// 인자를 공백/따옴표/중괄호에서 쪼개고, subagent 에 붙는 MCP 헤더를 오염시킨다.
//
// 이 파일은 두 플랫폼을 갈라 검증한다:
//   • POSIX(리눅스 CI): cross-spawn 이 `.sh` 를 shell 없이 실행하며 복잡한 argv 를
//     단일 엔트리로 보존한다(+ shell:true 대조군이 그걸 쪼갬을 시연).
//   • Windows(windows-latest CI): 실제 `codex.cmd` npm shim 을 cross-spawn 으로
//     실행 — `.cmd -> cmd.exe /d /s /c` 해석/escaping 분기를 실제로 태워
//     `spawn codex ENOENT` 회귀를 잡고, 공백/따옴표/중괄호가 든 argv 가 온전히
//     도착하며 성공(exit 0) 종료함을 증명한다. (ci.yml 의 `agent-manager-spawn-cmd`
//     매트릭스 잡이 이 파일을 두 OS 에서 돌린다.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CodexCliAdapter.buildOneshotSpawn 이 `-c` attribution 으로 내보내는 정확한 형태.
const CODEX_ATTRIBUTION_ARG =
  'mcp_servers.awb.http_headers={ "X-AWB-Client-Type" = "managed-subagent", ' +
  '"X-AWB-Subagent-Ticket-Id" = "d7513e04-527e-44d5-8dd2-e561690cecc2", ' +
  '"X-AWB-Subagent-Role" = "reviewer" }';
const CWD_WITH_SPACE = '/tmp/awb wt/ticket dir';
const CLI_ARGS = ['exec', '-c', CODEX_ATTRIBUTION_ARG, '--cd', CWD_WITH_SPACE, '--json'];

const isWindows = process.platform === 'win32';

function makeArgEchoShim() {
  const dir = mkdtempSync(join(tmpdir(), 'awb-argtest-'));
  const shim = join(dir, 'argecho.sh');
  // 받은 argv 엔트리를 한 줄에 하나씩 출력한다.
  writeFileSync(shim, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
  chmodSync(shim, 0o755);
  return { dir, shim };
}

test('cross-spawn preserves complex CLI args as single argv entries', { skip: isWindows }, () => {
  const { dir, shim } = makeArgEchoShim();
  try {
    const res = crossSpawn.sync(shim, CLI_ARGS, { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || 'shim exited non-zero');
    const lines = res.stdout.split('\n').filter((l) => l.length > 0);
    // 6개 인자 모두 쪼개지지 않고 그대로 도착해야 한다.
    assert.deepEqual(lines, CLI_ARGS);
    // shell-concat 이었으면 망가졌을 codex attribution TOML 이 정확히 단일 argv
    // 엔트리로 들어온다.
    assert.ok(lines.includes(CODEX_ATTRIBUTION_ARG));
    assert.ok(lines.includes(CWD_WITH_SPACE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control: shell:true DOES split the same args (why we use cross-spawn)', { skip: isWindows }, () => {
  const { dir, shim } = makeArgEchoShim();
  try {
    // cross-spawn 이 피하는 버그를 시연: shell:true 면 인자들이 하나의 command
    // 문자열로 이어붙여진 뒤 shell 이 다시 쪼개므로, TOML 인자가 여러 argv 엔트리로
    // 조각난다.
    const res = spawnSync(shim, CLI_ARGS, { encoding: 'utf8', shell: true });
    const lines = res.stdout.split('\n').filter((l) => l.length > 0);
    assert.notDeepEqual(lines, CLI_ARGS);
    assert.ok(
      !lines.includes(CODEX_ATTRIBUTION_ARG),
      'shell:true 는 TOML 인자를 온전히 유지하면 안 된다(그게 바로 회귀 버그)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Windows: 실제 `.cmd -> cmd.exe` 스폰/escaping 분기 (ticket e299c6b3 재현 환경) ──
//
// npm 글로벌 codex 는 형제 `.exe` 없이 `%APPDATA%\npm\codex.cmd` 배치 shim 만
// 노출하고, 그 shim 은 argv 를 `%*` 로 node 에 넘긴다(npm 이 만드는 모든 .cmd shim
// 의 구조). raw `child_process.spawn("codex.cmd")` 는 CreateProcess 가 `.cmd` 를
// 실행 대상으로 못 잡아 `spawn ... ENOENT` 로 죽었다. cross-spawn 은 이를
// `cmd.exe /d /s /c` 로 감싸고 인자를 CommandLineToArgvW 규칙 + cmd 메타문자
// 카렛-escaping 으로 감싸므로, 배치 `%*` → node 재파싱까지 왕복해도 argv 가
// 보존된다. 이 테스트는 그 왕복을 실제 cmd.exe 에서 태운다 → windows-latest 러너 전용.
test(
  'windows: cross-spawn runs a real codex.cmd npm shim (no ENOENT) and preserves complex argv',
  { skip: !isWindows },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'awb-winshim-'));
    try {
      // node 로 argv 를 그대로 되뱉는 helper (실제 npm shim 이 하듯 `%*` 로 넘김).
      const echo = join(dir, 'argecho.mjs');
      writeFileSync(echo, 'for (const a of process.argv.slice(2)) process.stdout.write(a + "\\n");\n');
      // codex.cmd 배치 shim: `%~dp0` 로 sibling helper 를 찾고 argv 를 `%*` 로 전달.
      // (cwd 와 무관하게 동작해야 하므로 %~dp0 사용 — 실제 npm shim 과 동일.)
      const shim = join(dir, 'codex.cmd');
      writeFileSync(shim, '@echo off\r\nnode "%~dp0argecho.mjs" %*\r\n');

      const res = crossSpawn.sync(shim, CLI_ARGS, { encoding: 'utf8' });
      // 회귀의 핵심: `.cmd` 를 spawn 할 수 있어야 한다(ENOENT 아님) + 성공 종료.
      assert.equal(res.error, undefined, `spawn error: ${res.error && res.error.message}`);
      assert.equal(res.status, 0, res.stderr || 'codex.cmd shim exited non-zero');
      const lines = res.stdout.split(/\r?\n/).filter((l) => l.length > 0);
      // 공백/따옴표/중괄호가 든 6개 인자가 단일 argv 엔트리로 온전히 왕복.
      assert.deepEqual(lines, CLI_ARGS);
      assert.ok(lines.includes(CODEX_ATTRIBUTION_ARG));
      assert.ok(lines.includes(CWD_WITH_SPACE));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
