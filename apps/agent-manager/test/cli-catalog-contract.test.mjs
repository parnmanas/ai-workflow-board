// agent-manager 의 CLI 모듈 ↔ AWB 서버의 CLI 카탈로그 contract.
//
// 두 앱은 별도 빌드 단위라 코드를 공유할 수 없고, 예전에는 파일 상단 주석으로
// "서로 손으로 맞춰라" 고만 적혀 있었다(cli-types.ts 헤더). 이 테스트는 서버 소스
// (`apps/server/src/common/cli-catalog.ts`)를 tsx 로 직접 읽어 매니저 모듈 선언과
// 비교한다 — 한쪽에만 CLI 나 provider 를 추가하면 여기서 바로 깨진다.
//
// 서버 소스가 없는 환경(매니저 패키지만 체크아웃한 경우)에서는 건너뛴다.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUILTIN_CLI_MODULES } from '../dist/lib/clis/index.js';

const serverCatalogPath = new URL('../../server/src/common/cli-catalog.ts', import.meta.url);

async function loadServerCatalog() {
  if (!existsSync(fileURLToPath(serverCatalogPath))) return null;
  let tsx;
  try {
    tsx = await import('tsx/esm/api');
  } catch {
    return null;
  }
  return tsx.tsImport(serverCatalogPath.href, import.meta.url);
}

test('매니저 CLI 모듈과 서버 CLI 카탈로그가 같은 사실을 선언한다', async (t) => {
  const server = await loadServerCatalog();
  if (!server) {
    t.skip('apps/server 소스 또는 tsx 를 찾을 수 없어 contract 비교를 건너뛴다');
    return;
  }
  const catalog = server.CLI_CATALOG;
  const byId = new Map(catalog.map((d) => [d.id, d]));

  // 1. id 집합: 서버는 `custom`(어댑터 없는 정체성)을 더 갖는다. 그 외는 동일.
  const serverIds = catalog.map((d) => d.id).filter((id) => id !== 'custom');
  assert.deepEqual(BUILTIN_CLI_MODULES.map((m) => m.id), serverIds);

  for (const m of BUILTIN_CLI_MODULES) {
    const d = byId.get(m.id);
    assert.ok(d, `서버 카탈로그에 ${m.id} 가 없다`);
    // 2. transport
    assert.equal(d.transport, m.transport, `${m.id} transport`);
    // 3. credential provider: prefix / id / fields / required
    if (m.credentials) {
      assert.ok(d.credential, `${m.id}: 서버 credential 이 null`);
      assert.equal(d.credential.prefix, m.credentials.prefix);
      assert.deepEqual(
        d.credential.providers.map((p) => ({ id: p.id, fields: [...p.fields], required: [...p.required] })),
        m.credentials.providers.map((p) => ({ id: p.id, fields: [...p.fields], required: [...p.required] })),
        `${m.id} credential providers`,
      );
    } else {
      assert.equal(d.credential, null, `${m.id}: 매니저는 credential 이 없는데 서버는 있다`);
    }
    // 4. login: harvest provider / provider-scoped
    if (m.login) {
      assert.ok(d.login, `${m.id}: 서버 login 이 null`);
      assert.equal(d.login.harvest_provider, m.login.harvestProvider);
      assert.equal(d.login.provider_scoped, !!m.login.providerScoped);
    } else {
      assert.equal(d.login, null, `${m.id}: 매니저는 로그인 자동화가 없는데 서버는 있다`);
    }
    // 5. sessions: acp / backend profile
    assert.equal(d.sessions.acp, !!m.sessions, `${m.id} sessions.acp`);
    assert.equal(d.sessions.backend_profile, !!m.sessions?.supportsBackendProfile, `${m.id} backend_profile`);
    // 6. effort slice
    if (m.effort) {
      assert.ok(d.effort, `${m.id}: 서버 effort 가 null`);
      assert.deepEqual([...d.effort.keys].sort(), [...m.effort.keys].sort(), `${m.id} effort keys`);
      assert.equal(d.effort.slice_key ?? undefined, m.effort.sliceKey ?? undefined, `${m.id} effort slice_key`);
    } else {
      assert.equal(d.effort, null, `${m.id}: 매니저는 effort 슬라이스가 없는데 서버는 있다`);
    }
    // 7. collaboration (capabilities 에서 파생)
    const collab = ['single', ...(m.capabilities.collaboration ?? [])];
    assert.deepEqual([...d.collaboration], collab, `${m.id} collaboration`);
  }
});
