// 클라이언트 정적 카탈로그 미러(src/cli/catalog.ts STATIC_CLI_CATALOG)와 서버의
// 원본(apps/server/src/common/cli-catalog.ts CLI_CATALOG)이 바이트 단위로 같은지
// 고정한다. 클라이언트는 fetch 전·실패 시·테스트에서 이 미러를 쓰므로, 둘이
// 어긋나면 서버가 없는 상황에서 UI 가 다른 사실을 보여주게 된다.
//
// 서버 파일은 별도 작업에서 만들어진다 — 아직 없으면 실패가 아니라 skip 으로
// 표시한다(존재하는 순간부터 실제 비교가 돈다).
//
// 실행:  node --import tsx --test apps/client/test/cli-catalog-contract.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { STATIC_CLI_CATALOG } from '../src/cli/catalog.ts';

const SERVER_CATALOG_URL = new URL('../../server/src/common/cli-catalog.ts', import.meta.url);

test('STATIC_CLI_CATALOG mirrors the server CLI_CATALOG exactly', async (t) => {
  if (!fs.existsSync(fileURLToPath(SERVER_CATALOG_URL))) {
    t.skip(`server catalog not present yet (${fileURLToPath(SERVER_CATALOG_URL)}) — contract check skipped`);
    return;
  }
  const server = await import(SERVER_CATALOG_URL.href);
  assert.ok(Array.isArray(server.CLI_CATALOG), 'server module must export CLI_CATALOG');
  // JSON round-trip so `undefined` optional keys (e.g. effort.slice_key absent
  // vs. explicitly undefined) compare equal — the wire format is JSON anyway.
  assert.deepEqual(
    JSON.parse(JSON.stringify(STATIC_CLI_CATALOG)),
    JSON.parse(JSON.stringify(server.CLI_CATALOG)),
  );
});
