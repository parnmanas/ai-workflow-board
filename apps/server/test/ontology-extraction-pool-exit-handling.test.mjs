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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');
const CRASHING_WORKER = path.join(__dirname, 'helpers', 'crashing-worker-fixture.mjs');
const HANGING_WORKER = path.join(__dirname, 'helpers', 'hanging-worker-fixture.mjs');

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

// ticket 461d210a — 죽지도 답하지도 않는 워커(멈춘 파서 · 무한 루프). 파일별 시간 상한이 없던
// 동안에는 runExtractionPool 이 끝나지 않아, 그 그래프가 building 에 영영 머물렀다.
//
// 이 프로세스의 스레드 수(Linux 의 /proc). 멈춘 워커를 terminate 하지 않으면 그 스레드가
// 남아 계속 돈다. /proc 이 없는 플랫폼에서는 그 단언만 건너뛴다.
function liveThreads() {
  try { return fs.readdirSync('/proc/self/task').length; } catch { return null; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 앞 테스트의 풀이 terminate 를 기다리지 않고 끝나므로, 그 워커 스레드가 사라져 수가 멈출
// 때까지 기다린 값을 기준으로 삼는다 — 사라지는 중인 스레드가 새어 나간 스레드를 가리지 않게.
async function settledThreads() {
  let last = liveThreads();
  let stableSince = Date.now();
  const deadline = Date.now() + 5_000;
  while (last !== null && Date.now() < deadline && Date.now() - stableSince < 250) {
    await sleep(25);
    const now = liveThreads();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    }
  }
  return last;
}

describe('worker pool task timeout (ticket 461d210a)', () => {
  it('a worker that holds one file past taskTimeoutMs is stopped — that file is recorded as failed and a replacement worker finishes the batch', { timeout: 20_000 }, async () => {
    const tasks = [
      { path: 'before.ts', content: 'export const a = 1;', lang: 'typescript' },
      { path: 'hang.ts', content: 'export const b = 2;', lang: 'typescript' },
      { path: 'after.ts', content: 'export const c = 3;', lang: 'typescript' },
    ];
    const threadsBefore = await settledThreads();

    // poolSize=1: 멈춘 파일 뒤의 파일은 교체 워커만 처리할 수 있다.
    const results = await runExtractionPool(tasks, { poolSize: 1, taskTimeoutMs: 300, workerScriptPath: HANGING_WORKER });

    assert.deepEqual(results.map((r) => r.path), ['before.ts', 'hang.ts', 'after.ts']);
    assert.equal(results[0].error, null);
    assert.ok(results[0].bundle);
    assert.equal(results[1].bundle, null);
    assert.deepEqual(results[1].decoratorFacts, []);
    assert.match(results[1].error, /timed out after 300ms/);
    assert.equal(results[2].error, null);
    assert.ok(results[2].bundle, '멈춘 워커를 바꾼 새 워커가 나머지 파일을 처리한다');

    if (threadsBefore !== null) {
      // 풀은 끝날 때 terminate 를 기다리지 않는다 — 스레드가 사라질 때까지 잠깐 본다.
      const deadline = Date.now() + 5_000;
      while (liveThreads() > threadsBefore && Date.now() < deadline) await sleep(25);
      assert.ok(liveThreads() <= threadsBefore, '멈춘 워커의 스레드가 남았다 — 시간을 넘긴 워커를 terminate 하지 않았다');
    }
  });

  // 메인 스레드가 상한보다 오래 멈췄다 풀리면, 타이머가 이미 도착해 있는 답보다 먼저 돈다(타이머
  // 단계가 메시지를 전하는 poll 단계보다 앞이다). 그 답을 시간 초과로 버리면 안 된다. 멈춤은
  // setImmediate 에서 건다 — 메시지 처리 루프 안에서 멈추면 그 루프가 늦게 온 답까지 곧바로 처리해
  // 타이머 순서가 드러나지 않는다.
  it('a main-thread stall past taskTimeoutMs does not turn an answer that already arrived into a timeout', { timeout: 20_000 }, async () => {
    const blockMainThread = (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { /* 바쁜 대기 */ }
    };
    const tasks = [
      { path: 'warm.ts', content: 'export const a = 1;', lang: 'typescript' },
      { path: 'slow-answer.ts', content: 'export const b = 2;', lang: 'typescript' },
    ];
    // 첫 파일로 워커를 데운다 — 두 번째 파일에는 기동 유예 없이 상한(200ms)만 준다.
    const results = await runExtractionPool(tasks, {
      poolSize: 1,
      taskTimeoutMs: 200,
      workerScriptPath: HANGING_WORKER,
      onProgress: (completed) => {
        if (completed === 1) setImmediate(() => blockMainThread(800));
      },
    });
    assert.equal(results[1].error, null, '멈춘 동안 도착한 답이 시간 초과로 버려졌다');
    assert.ok(results[1].bundle);
  });

  it("a fresh worker's first file also gets its start-up time — a limit shorter than start-up does not fail every file", { timeout: 20_000 }, async () => {
    // 실제 worker.js 의 기동 + 첫 문법 로드는 0.1–0.3초다. 상한 1ms 면 유예 없이는 모든 파일이 실패한다.
    const tasks = [
      { path: 'a.ts', content: 'export function a() { return 1; }', lang: 'typescript' },
      { path: 'b.ts', content: 'export function b() { return 2; }', lang: 'typescript' },
    ];
    const results = await runExtractionPool(tasks, { poolSize: 2, taskTimeoutMs: 1 });
    assert.deepEqual(results.map((r) => r.error), [null, null]);
  });
});
