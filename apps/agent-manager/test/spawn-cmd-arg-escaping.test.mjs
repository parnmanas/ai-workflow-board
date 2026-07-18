// 회귀 테스트: spawn 사이트는 CLI 를 cross-spawn 으로 실행한다(raw spawn +
// `shell: true` 가 아니라). 그래서 Windows `.cmd`/`.bat` shim 이 cmd.exe 로,
// 인자를 PROPERLY ESCAPED 해 감싸진다(ticket e299c6b3). 순수 `shell: true` 는
// 인자를 escape 없이 이어붙여(Node DEP0190) codex 의 inline-TOML `-c` attribution
// 인자를 공백/따옴표/중괄호에서 쪼개고, subagent 에 붙는 MCP 헤더를 오염시킨다.
//
// 실제 Windows cmd.exe 실행은 여기서 못 하지만, cross-spawn 이 모든 플랫폼에서
// 보장하는 성질은 증명할 수 있다: 공백·따옴표가 가득한 복잡한 인자가 spawn 경로를
// 통과하며 단일 argv 엔트리로 살아남는다. POSIX 에서 cross-spawn 은
// child_process.spawn(argv, shell 없음)으로 위임하므로, 이 테스트는 누군가 spawn
// 사이트에 `shell: true` 를 다시 넣는 것도 막는다 — 그건 이 인자들을 쪼갤 것이다
// (아래에서 검증).

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

function makeArgEchoShim() {
  const dir = mkdtempSync(join(tmpdir(), 'awb-argtest-'));
  const shim = join(dir, 'argecho.sh');
  // 받은 argv 엔트리를 한 줄에 하나씩 출력한다.
  writeFileSync(shim, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
  chmodSync(shim, 0o755);
  return { dir, shim };
}

test('cross-spawn preserves complex CLI args as single argv entries', () => {
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

test('control: shell:true DOES split the same args (why we use cross-spawn)', () => {
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
