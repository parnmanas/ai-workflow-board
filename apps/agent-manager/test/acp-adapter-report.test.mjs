// ACP 어댑터 버전을 **보이게** 만든다 (하트비트 `acp_adapters`).
//
// 왜: 어댑터는 모델 id 를 자기 번들에 하드코딩하므로 **어댑터 버전이 세션의 모델
// 목록·capability 를 정한다**. 2026-10-01 에 세 호스트의 claude-agent-acp 가 0.79.0
// (최신 0.84.0) 으로 조용히 5버전 썩어, CLI 바이너리에는 있는 Opus 5.5 가 세션에서는
// 영영 안 떴다. AWB 는 CLI 버전만 보고했고 어댑터는 "있다/없다" 만 봤기 때문에 화면에
// 단서가 하나도 없었고, 진단에 며칠이 걸렸다.
//
// 고정하는 것:
//   1. 어댑터를 쓰는 CLI 는 패키지·버전·출처를 보고한다.
//   2. 번들본을 쓰면 `source: 'bundled'` 다 — 이게 "매니저와 함께 올라간다" 의 관측점이다.
//      'path'/'npx' 는 그 매니저가 번들을 안 들고 있다는 신호다.
//   3. 어댑터 패키지가 없는 CLI(CLI 가 ACP 내장)는 'builtin' 으로 구분된다 — 버전 미상과
//      섞이면 화면이 "뒤처졌다" 를 잘못 말한다.
//   4. env override 는 버전을 알 수 없다고 **말한다**(추측하지 않는다).
// 실행: node --test apps/agent-manager/test/acp-adapter-report.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acpAdapterPackages, collectAcpAdapters } from '../dist/lib/clis/acp-adapter-info.js';
import { findOnPath } from '../dist/lib/find-on-path.js';

const SOURCES = new Set(['override', 'bundled', 'path', 'npx', 'builtin']);

test('어댑터 패키지 목록은 비어 있지 않고 npm 스펙 모양이다', () => {
  const pkgs = acpAdapterPackages();
  assert.ok(pkgs.length >= 2, 'claude·codex 어댑터는 최소한 보고된다');
  for (const p of pkgs) assert.match(p, /^@[\w.-]+\/[\w.-]+$/);
});

test('claude·codex 는 번들된 어댑터를 버전과 함께 보고한다', async () => {
  const rows = await collectAcpAdapters(findOnPath);
  for (const cli of ['claude', 'codex']) {
    const row = rows.find((r) => r.cli === cli);
    assert.ok(row, `${cli} 가 보고돼야 한다`);
    assert.ok(SOURCES.has(row.source), `알려진 source: ${row.source}`);
    // 이 저장소에서는 어댑터가 의존성으로 들어와 있으므로 번들본이 잡힌다.
    assert.equal(row.source, 'bundled', `${cli}: 의존성 선언이 빠졌거나 해석이 깨졌다`);
    assert.match(String(row.version), /^\d+\.\d+\.\d+/, `${cli}: 번들본이면 버전을 읽을 수 있다`);
    assert.ok(row.package?.startsWith('@agentclientprotocol/'));
  }
});

test('어댑터 패키지가 없는 ACP CLI 는 builtin 으로 구분된다 — 버전 미상과 섞지 않는다', async () => {
  const rows = await collectAcpAdapters(findOnPath);
  const builtin = rows.filter((r) => r.source === 'builtin');
  assert.ok(builtin.length > 0, 'opencode 처럼 CLI 가 ACP 를 내장하는 경우가 있다');
  for (const r of builtin) {
    assert.equal(r.package, null, 'builtin 은 올릴 별도 패키지가 없다');
    assert.equal(r.version, null);
  }
});

test('env override 는 버전을 모른다고 말한다 — 추측하지 않는다', async (t) => {
  const prev = process.env.AWB_ACP_COMMAND_CLAUDE;
  process.env.AWB_ACP_COMMAND_CLAUDE = 'node /opt/custom-acp.js';
  t.after(() => {
    if (prev === undefined) delete process.env.AWB_ACP_COMMAND_CLAUDE;
    else process.env.AWB_ACP_COMMAND_CLAUDE = prev;
  });
  const rows = await collectAcpAdapters(findOnPath);
  const claude = rows.find((r) => r.cli === 'claude');
  assert.equal(claude.source, 'override');
  assert.equal(claude.version, null, '운영자가 고정한 명령의 버전은 AWB 가 알 수 없다');
});

test('수집은 던지지 않는다 — 하트비트 경로이므로 best-effort 다', async () => {
  const rows = await collectAcpAdapters(async () => {
    throw new Error('PATH 조회 실패');
  });
  assert.ok(Array.isArray(rows) && rows.length > 0);
});
