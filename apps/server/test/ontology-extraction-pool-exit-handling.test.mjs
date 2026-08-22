// 회귀 테스트 — ticket e14ef1c9
// "[Ontology Graph 2/7] 추출 워커 — tree-sitter WASM Tier 1 + NestJS
// 리플렉션 룰셋" — 리뷰 라운드 1 추가 권고: pool.ts가 `error`뿐 아니라
// 비정상 `exit`(메시지도 에러 이벤트도 없이 워커가 그냥 죽는 경우 — OOM,
// 시그널 등)까지 회수하는지 검증한다. 이전 구현은 `error`만 들었으므로
// 이 경우 해당 태스크를 기다리던 Promise가 영구 대기했을 것이다.
//
// test/helpers/crashing-worker-fixture.mjs가 메시지를 받자마자
// process.exit(1)로 죽는다 — pool.ts의 `workerScriptPath` 테스트 전용
// override로 실제 worker.js 대신 이 픽스처를 스폰한다.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요) — 1/7과 같은 관례.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');
const CRASHING_WORKER = path.join(__dirname, 'helpers', 'crashing-worker-fixture.mjs');

const { runExtractionPool } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/pool.js'));

describe('worker pool exit handling (ticket e14ef1c9, 리뷰 지적 추가 권고)', () => {
  it('a worker that exits (code 1) with no message/error event is detected — the task resolves as an error, a replacement worker keeps the batch moving, and the overall promise settles (does not hang forever)', async () => {
    const tasks = [
      { path: 'a.ts', content: 'export const a = 1;', lang: 'typescript' },
      { path: 'b.ts', content: 'export const b = 2;', lang: 'typescript' },
      { path: 'c.ts', content: 'export const c = 3;', lang: 'typescript' },
    ];

    // poolSize=1: 매 태스크가 순서대로 같은(교체된) 슬롯에 배정되므로,
    // 워커가 매번 죽고 매번 교체 워커가 뜬다는 것까지 같이 검증한다.
    const results = await runExtractionPool(tasks, { poolSize: 1, workerScriptPath: CRASHING_WORKER });

    assert.equal(results.length, 3, '죽은 워커 때문에 결과가 유실되지 않고 태스크 수만큼 나와야 한다');
    for (const r of results) {
      assert.equal(r.bundle, null);
      assert.match(r.error, /worker exited unexpectedly \(code 1\)/);
      assert.deepEqual(r.decoratorFacts, []);
    }
    // 경로별로 정확히 매칭돼야 한다 — 워커가 죽어도 결과 배열의 인덱스
    // 정렬이 깨지지 않는다.
    assert.deepEqual(results.map((r) => r.path), ['a.ts', 'b.ts', 'c.ts']);
  });

  it('a worker pool with a healthy worker script still succeeds normally (sanity — the exit-handling addition did not break the happy path)', async () => {
    const tasks = [{ path: 'ok.ts', content: 'export function f() { return 1; }', lang: 'typescript' }];
    const results = await runExtractionPool(tasks);
    assert.equal(results.length, 1);
    assert.equal(results[0].error, null);
    assert.ok(results[0].bundle);
    assert.equal(results[0].bundle.defs[0]?.name, 'f');
  });
});
