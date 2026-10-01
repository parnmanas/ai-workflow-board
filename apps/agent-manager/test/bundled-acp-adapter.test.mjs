// ACP 어댑터는 매니저와 **함께** 올라간다 (실측 2026-10-01).
//
// 증상: 세션 안 모델 드롭다운이 새 모델(claude-opus-5-5)을 영영 몰랐다. CLI
// 바이너리(claude 2.1.286)에는 있었고 호스트 열거도 그걸 보여줬는데, 세션 안 목록만
// 몰랐다. 원인은 **어댑터가 자기 번들에 모델 id 를 하드코딩**하고, 그 어댑터가
// 매니저와 무관한 별개 전역 패키지였던 것 — 세 호스트 모두 0.79.0 (최신 0.84.0) 이었다.
// `update_manager` 를 몇 번 돌려도 어댑터는 그대로였다: 매니저는 PATH 에서 이름으로만
// 찾았고(`findOnPath('claude-agent-acp')`) 버전을 확인하지도, 범위를 요구하지도 않았다.
//
// 그래서 어댑터를 `awb-agent-manager` 의 **의존성**으로 선언하고 번들본을 먼저 쓴다.
// `npm i -g awb-agent-manager` 한 번이 매니저와 어댑터를 같이 올린다.
//
// 여기서 고정하는 것:
//   1. 번들본을 찾으면 그것을 쓰고, `node <js>` 로 띄운다(Windows 의 .cmd shim 을 타지 않는다).
//   2. PATH 에 다른 어댑터가 있어도 **번들본이 이긴다** — 이게 "같이 올라간다" 의 핵심이다.
//   3. 번들이 없으면(구버전 설치) 기존 PATH → npx 경로로 조용히 떨어진다.
//   4. 운영자 탈출구 `AWB_ACP_COMMAND_<CLI>` 는 여전히 **최우선**이다.
// 실행: node --test apps/agent-manager/test/bundled-acp-adapter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { resolveBundledAcpCommand } from '../dist/lib/clis/bundled-acp.js';
import { cliSessions } from '../dist/lib/clis/index.js';
import { resolveAcpCommandForCli } from '../dist/lib/agent-session-runner.js';

const ADAPTERS = [
  ['claude', '@agentclientprotocol/claude-agent-acp', 'claude-agent-acp'],
  ['codex', '@agentclientprotocol/codex-acp', 'codex-acp'],
];

test('번들된 어댑터를 찾고, 매니저와 같은 node 로 js 를 직접 띄운다', () => {
  for (const [, pkg, bin] of ADAPTERS) {
    const resolved = resolveBundledAcpCommand(pkg, bin);
    assert.ok(resolved, `${pkg} 번들본을 찾아야 한다 (의존성 선언이 빠졌는가?)`);
    assert.equal(resolved.command, process.execPath, 'PATH 의 node 가 아니라 매니저를 돌리는 node');
    assert.equal(resolved.args.length, 1);
    assert.ok(existsSync(resolved.args[0]), `어댑터 entry 가 실제로 있어야 한다: ${resolved.args[0]}`);
    // bin 심링크나 셸 shim 이 아니라 패키지 안의 js 를 직접 가리킨다.
    assert.match(resolved.args[0], /[\\/]dist[\\/]index\.js$/);
  }
});

test('없는 패키지는 null — 호출자가 PATH/npx 로 떨어질 수 있어야 한다', () => {
  assert.equal(resolveBundledAcpCommand('@agentclientprotocol/does-not-exist-acp', 'nope'), null);
});

test('PATH 에 어댑터가 있어도 번들본이 이긴다 — 이게 "매니저와 같이 올라간다" 의 전부다', async () => {
  // 예전 동작(PATH 우선)이라면 아래 stub 경로가 그대로 돌아왔고, 그래서 0.79.0 이
  // 영원히 쓰였다.
  const stub = async (name) => `/usr/local/bin/${name}`;
  for (const [cli, pkg, bin] of ADAPTERS) {
    const sessions = cliSessions(cli);
    assert.ok(sessions, `${cli} 에 sessions spec 이 있어야 한다`);
    const resolved = await sessions.resolveAcpCommand(stub);
    const bundled = resolveBundledAcpCommand(pkg, bin);
    assert.deepEqual(
      { command: resolved.command, args: [...resolved.args] },
      { command: bundled.command, args: [...bundled.args] },
      `${cli}: PATH stub 이 아니라 번들본이 선택돼야 한다`,
    );
    assert.notEqual(resolved.command, `/usr/local/bin/${bin}`);
  }
});

test('AWB_ACP_COMMAND_<CLI> 는 번들본보다도 앞이다 — 운영자 탈출구는 유지된다', async (t) => {
  const prev = process.env.AWB_ACP_COMMAND_CLAUDE;
  process.env.AWB_ACP_COMMAND_CLAUDE = '/opt/custom/acp --flag';
  t.after(() => {
    if (prev === undefined) delete process.env.AWB_ACP_COMMAND_CLAUDE;
    else process.env.AWB_ACP_COMMAND_CLAUDE = prev;
  });
  const resolved = await resolveAcpCommandForCli('claude');
  assert.deepEqual(resolved, { command: '/opt/custom/acp', args: ['--flag'] });
});

test('override 가 없으면 resolveAcpCommandForCli 도 번들본을 돌려준다', async () => {
  const prev = process.env.AWB_ACP_COMMAND_CLAUDE;
  delete process.env.AWB_ACP_COMMAND_CLAUDE;
  try {
    const resolved = await resolveAcpCommandForCli('claude');
    const bundled = resolveBundledAcpCommand('@agentclientprotocol/claude-agent-acp', 'claude-agent-acp');
    assert.equal(resolved.command, bundled.command);
    assert.deepEqual([...resolved.args], [...bundled.args]);
  } finally {
    if (prev !== undefined) process.env.AWB_ACP_COMMAND_CLAUDE = prev;
  }
});
