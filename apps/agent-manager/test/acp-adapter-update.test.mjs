// 운영자가 ACP 어댑터를 올릴 수 있다 (`update_acp_adapter`).
//
// 배경: 어댑터는 모델 id 를 자기 번들에 하드코딩하므로 어댑터 버전이 세션의 모델 목록을 정한다.
// 매니저 의존성으로 번들했지만(83b519f4) 범위가 `^0.84.0` 이라 새 어댑터가 나와도 매니저를 다시
// 깔아서는 따라오지 않았다 — 운영자가 어댑터를 올릴 방법이 **여전히 없었다.**
//
// 그래서 매니저 홈(`acp-adapters/`)에 최신을 설치하고, 해석은 홈 설치본(managed)과 번들본 중
// **더 새 것**을 고른다. 고정하는 것:
//   1. 홈에 더 새 어댑터가 있으면 그것을 띄운다 — 업데이트가 실제로 효과가 있다.
//   2. 홈 것이 번들보다 낡았으면 번들을 띄운다 — 나중에 매니저가 더 새 번들을 가져왔을 때
//      옛 홈 설치본이 그것을 가리지 않는다(되돌아가는 일이 없다).
//   3. 버전을 디스크에서 매번 읽는다 — 올린 직후 옛 버전을 보고하지 않는다(require 캐시 함정).
//   4. 업데이트는 `npm install --prefix <home>/acp-adapters <pkg>@latest` 이고(전역 아님, 권한
//      상승 불필요), before/after 를 정직하게 보고한다. 실패는 던지지 않고 ok:false 로.
// 실행: node --test apps/agent-manager/test/acp-adapter-update.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG = '@agentclientprotocol/claude-agent-acp';
const BIN = 'claude-agent-acp';

// 홈을 격리한다 — 이 테스트가 운영자의 실제 매니저 홈을 건드리거나 읽으면 안 된다.
const home = await mkdtemp(join(tmpdir(), 'awb-acp-home-'));
process.env.AWB_ACP_ADAPTERS_DIR = home;

const { resolveAcpAdapter, resolveBundledAcpCommand, compareVersions } = await import('../dist/lib/clis/bundled-acp.js');
const { updateManagedAcpAdapter } = await import('../dist/lib/clis/acp-adapter-update.js');
const { collectAcpAdapters } = await import('../dist/lib/clis/acp-adapter-info.js');
const { findOnPath } = await import('../dist/lib/find-on-path.js');

/** 홈에 가짜 어댑터 패키지를 설치한 것처럼 만든다. */
async function installFake(version) {
  const dir = join(home, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: PKG, version, bin: { [BIN]: 'dist/index.js' } }));
  await writeFile(join(dir, 'dist', 'index.js'), '// fake adapter\n');
  return join(dir, 'dist', 'index.js');
}

const bundled = resolveAcpAdapter(PKG, BIN);
const bundledVersion = bundled?.version;

test('전제: 홈이 비어 있으면 번들본을 쓴다', async () => {
  await rm(join(home, 'node_modules'), { recursive: true, force: true });
  const r = resolveAcpAdapter(PKG, BIN);
  assert.equal(r.source, 'bundled');
  assert.match(String(r.version), /^\d+\.\d+\.\d+/);
});

test('홈에 더 새 어댑터가 있으면 그것을 띄운다 — 업데이트가 실제로 효과가 있다', async () => {
  const entry = await installFake('99.0.0');
  const r = resolveAcpAdapter(PKG, BIN);
  assert.equal(r.source, 'managed');
  assert.equal(r.version, '99.0.0');
  assert.deepEqual(r.args, [entry]);
  assert.equal(r.command, process.execPath, '매니저와 같은 node 로 js 를 직접 띄운다');
  // CLI 모듈 경로와 하트비트 보고도 같은 판정을 쓴다.
  const reported = (await collectAcpAdapters(findOnPath)).find((a) => a.cli === 'claude');
  assert.equal(reported.source, 'managed');
  assert.equal(reported.version, '99.0.0');
});

test('홈 것이 번들보다 낡았으면 번들을 쓴다 — 매니저가 더 새 번들을 가져오면 옛 홈 설치본이 가리지 않는다', async () => {
  await installFake('0.0.1');
  const r = resolveAcpAdapter(PKG, BIN);
  assert.equal(r.source, 'bundled');
  assert.equal(r.version, bundledVersion);
  // 번들 전용 해석은 영향받지 않는다.
  assert.deepEqual(resolveBundledAcpCommand(PKG, BIN), { command: bundled.command, args: bundled.args });
});

test('버전은 디스크에서 매번 읽는다 — 올린 직후 옛 버전을 보고하지 않는다', async () => {
  await installFake('98.0.0');
  assert.equal(resolveAcpAdapter(PKG, BIN).version, '98.0.0');
  await installFake('99.1.0');
  assert.equal(resolveAcpAdapter(PKG, BIN).version, '99.1.0', 'require 캐시를 탔다면 98.0.0 이 그대로 나왔다');
});

test('updateManagedAcpAdapter: 홈에 --prefix 로 설치하고 before → after 를 보고한다', async () => {
  await rm(join(home, 'node_modules'), { recursive: true, force: true });
  const calls = [];
  const result = await updateManagedAcpAdapter(PKG, BIN, {
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      await installFake('99.2.0'); // npm 이 설치한 것처럼
      return { ok: true, output: 'added 1 package' };
    },
  });
  assert.deepEqual(calls, [['npm', 'install', '--prefix', home, '--no-audit', '--no-fund', `${PKG}@latest`]],
    '전역(-g)이 아니라 매니저 홈에 로컬 설치한다 — 권한 상승도, 다른 CLI 와의 prefix 레이스도 없다');
  assert.equal(result.ok, true);
  assert.equal(result.before, bundledVersion);
  assert.equal(result.after, '99.2.0');
  assert.equal(result.source, 'managed');
  assert.match(result.detail, /restart open sessions/, '열린 세션은 옛 어댑터를 쓴다는 사실을 알린다');
});

test('updateManagedAcpAdapter: npm 이 실패하면 던지지 않고 ok:false 와 사유를 돌려준다', async () => {
  await rm(join(home, 'node_modules'), { recursive: true, force: true });
  const result = await updateManagedAcpAdapter(PKG, BIN, {
    run: async () => ({ ok: false, output: 'npm ERR! 404 Not Found' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /404 Not Found/);
  assert.equal(result.after, bundledVersion, '실패해도 번들본은 그대로 쓰인다');
});

test('이미 최신이면 그렇다고 말한다 — 움직이지 않은 것을 "업데이트됨" 으로 뭉개지 않는다', async () => {
  await installFake('99.3.0');
  const result = await updateManagedAcpAdapter(PKG, BIN, { run: async () => ({ ok: true, output: 'up to date' }) });
  assert.equal(result.ok, true);
  assert.equal(result.before, result.after);
  assert.match(result.detail, /already the newest/);
});

test('compareVersions: 못 읽으면 null — "비교 불가" 와 "같다" 를 구분한다', () => {
  assert.equal(compareVersions('0.85.0', '0.84.9') > 0, true);
  assert.equal(compareVersions('0.84.0', '0.84.0'), 0);
  assert.equal(compareVersions(null, '1.0.0'), null);
  assert.equal(compareVersions('dev', '1.0.0'), null);
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});

test('이 빌드는 acp_adapter_update 를 광고한다 — 화면은 이 플래그가 있을 때만 Update 를 낸다', async () => {
  const { MANAGER_CAPABILITIES } = await import('../dist/lib/runtime-profiles.js');
  assert.ok(MANAGER_CAPABILITIES.includes('acp_adapter_update'));
  // 기존 플래그를 지우면 서버가 "지원 안 함" 으로 보고 디스패치를 거부한다 — 함께 남아 있어야 한다.
  assert.ok(MANAGER_CAPABILITIES.includes('context_window_clamp'));
});
