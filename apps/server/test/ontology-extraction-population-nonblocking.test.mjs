// 회귀 테스트 — ticket e14ef1c9
// "[Ontology Graph 2/7] 추출 워커 — tree-sitter WASM Tier 1 + NestJS
// 리플렉션 룰셋"
//
// 1/7 리뷰에서 이 티켓 자신에 명시적으로 인계된 완료조건
// (ontology-sqljs-independent-datasource.test.mjs의 "KNOWN V1 LIMITATION"
// 테스트 바로 위 긴 코멘트, ticket e14ef1c9 코멘트 스레드 두 번째 항목
// 그대로):
//   (a) 대량 insert는 청크 사이 명시적 매크로태스크(setImmediate) 양보를
//       계약으로 넣어야 한다 — await만 이어지는 microtask 체인은 timer/I·O
//       phase로의 공정한 양보를 보장하지 않는다.
//   (b) 이 실제 population 경로가 기존 AWB 쓰기(primary DataSource)를
//       블로킹하지 않는다는 것을 *이 티켓 자신의* 실제 쓰기 경로로
//       직접 검증해야 한다 — 1/7의 "COMPLETION CRITERION 3a" 1차 시도가
//       반려된 이유가 정확히 "population 구현 자체가 이 티켓에 없어서
//       test-only setTimeout으로 흉내만 냈다"였다(그 파일 자신의 코멘트).
//
// 이 스위트는 실제 persist.ts::persistFactBundles()(합성 setTimeout이나
// mock 없이, 진짜 청크 insert 루프)를 온톨로지 DataSource에 대해 돌리면서
// 동시에 primary DataSource에 진짜 쓰기 하나를 넣는다. 판정은 wall-clock
// 레이스가 아니라 **결정론적 이벤트루프 페이즈 순서**로 한다: persist.ts가
// 노출하는 onChunkInserted 훅으로 "지금까지 몇 청크가 끝났는지"를 관찰하고,
// 그 관찰 자체도 setImmediate로 스스로를 재예약하는 체인이라 매 tick마다
// 진행 상황을 찍는다 — population이 정말 청크 사이에 양보한다면 이 체인은
// "0 완료" -> "일부 완료" -> "전부 완료"의 중간 상태를 여러 번 관찰하고,
// 그 사이사이 primary DataSource 쓰기도 최소 한 번은 끼어들어 완료돼야
// 한다. 양보 없이 한 덩어리로 돈다면(회귀) 이 체인은 population이 이미
// 다 끝난 뒤에야 처음 실행되므로 "중간 상태"를 단 하나도 못 본다.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요) — 1/7과 같은 관례.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-population-nonblocking-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { persistFactBundles } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/persist.js'));
const { AppDataSource, AppOntologyDataSource, initOntologyDb, flushSqljs, flushOntologySqljs } =
  await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { Workspace } = await import('file://' + path.join(DIST_ROOT, 'entities/Workspace.js'));

// NODE_CHUNK_SIZE/EDGE_CHUNK_SIZE(persist.ts)가 둘 다 500이므로, 청크 수를
// 확실히 여러 개(2개 이상씩) 만들려면 파일당 defs를 500 넘게 잡는다 —
// 노드 쪽만이 아니라 엣지(=CONTAINS) 쪽 청크 반복도 같은 수라 함께 검증된다.
const FILES = 3;
const DEFS_PER_FILE = 400; // 3 * 400 = 1200 defs + 3 file nodes = 1203 nodes -> 3 노드 청크(500+500+203), 1200 CONTAINS 엣지 -> 3 엣지 청크

function makeBundle(fileIndex) {
  const defs = [];
  for (let i = 0; i < DEFS_PER_FILE; i++) {
    defs.push({
      qualifiedName: `Fn${fileIndex}_${i}`,
      name: `Fn${fileIndex}_${i}`,
      kind: 'function',
      startLine: i + 1,
      endLine: i + 1,
      startByte: i * 20,
      endByte: i * 20 + 10,
      parentQualifiedName: null,
      exported: false,
      docstring: null,
    });
  }
  return {
    path: `synthetic/file_${fileIndex}.ts`,
    lang: 'typescript',
    defs,
    refs: [],
    imports: [],
    exports: [],
    heritage: [],
    docstrings: [],
    fileHash: `hash-${fileIndex}`,
    extractorVersion: '1.0.0',
    hasParseError: false,
    skippedReason: null,
  };
}

describe('population non-blocking contract (ticket e14ef1c9, 1/7 리뷰 인계 완료조건)', () => {
  before(async () => {
    await AppDataSource.initialize();
    await initOntologyDb();
    await flushSqljs(AppDataSource, true);
    await flushOntologySqljs(AppOntologyDataSource, true);
  });

  after(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    if (AppOntologyDataSource?.isInitialized) await AppOntologyDataSource.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('yields via setImmediate between chunks — a concurrent primary-DataSource write observes and completes during a mid-run state, not only before/after the whole run', async () => {
    const bundles = Array.from({ length: FILES }, (_, i) => makeBundle(i));
    const decoratorFactsByPath = new Map(bundles.map((b) => [b.path, []]));

    const chunkObservations = []; // {kind, completedRows, totalRows} — persist.ts 자신의 신호
    let chunksSoFar = 0;
    let totalChunksExpected = null; // 첫 관찰 이후 계산

    const probeLog = []; // 매 tick마다 관찰한 chunksSoFar 스냅샷
    let populationDone = false;
    let primaryWriteCompletedAtChunkCount = null;

    function scheduleProbe() {
      setImmediate(() => {
        probeLog.push(chunksSoFar);
        if (!populationDone) scheduleProbe();
      });
    }
    scheduleProbe();

    // population 호출 *이전에* 등록 — 이 콜백이 큐에 먼저 들어가므로, 위
    // 파일 헤더 코멘트가 설명하는 이벤트루프 phase 순서에 따라
    // persistFactBundles()의 첫 yield 지점(청크 0 완료 직후) 이후,
    // 두 번째 청크가 시작되기 *전에* 반드시 실행된다 — wall-clock이
    // 아니라 setImmediate 큐의 FIFO 등록 순서로 결정되는 구조적 사실이다.
    const primaryWritePromise = new Promise((resolve) => {
      setImmediate(async () => {
        const repo = AppDataSource.getRepository(Workspace);
        await repo.save(repo.create({ name: 'nonblocking-probe', description: 'concurrent primary write during ontology population' }));
        primaryWriteCompletedAtChunkCount = chunksSoFar;
        resolve();
      });
    });

    const persistPromise = persistFactBundles(AppOntologyDataSource, {
      graphId: 'nonblocking-graph',
      workspaceId: 'nonblocking-ws',
      resourceId: 'nonblocking-resource',
      folderPath: '',
      commit: 'nonblocking-commit',
      extractionRunId: 'nonblocking-run-1',
      bundles,
      decoratorFactsByPath,
      onChunkInserted: ({ completedRows, totalRows }) => {
        chunkObservations.push({ completedRows, totalRows });
        chunksSoFar += 1;
      },
    });

    const summary = await persistPromise;
    populationDone = true;
    await primaryWritePromise; // 이미 완료돼 있어야 하지만, 확실히 정리한다.

    totalChunksExpected = chunkObservations.length;
    assert.ok(totalChunksExpected >= 6, `노드 3청크 + 엣지 3청크 이상을 기대했다 (got ${totalChunksExpected})`);
    assert.equal(summary.nodesInserted, FILES * DEFS_PER_FILE + FILES);
    assert.equal(summary.edgesInserted, FILES * DEFS_PER_FILE);

    // ── 핵심 단언 1: 동시 primary 쓰기는 population이 "0 청크 완료"이거나
    // "전부 완료"인 순간이 아니라, 정말로 중간(1개 이상, 전체 미만)에
    //끼어들어 실행됐다 — 이게 바로 "블로킹되지 않았다"의 결정론적 증거.
    assert.ok(
      primaryWriteCompletedAtChunkCount !== null,
      'primary 쓰기 콜백이 실행되긴 했어야 한다',
    );
    assert.ok(
      primaryWriteCompletedAtChunkCount > 0 && primaryWriteCompletedAtChunkCount < totalChunksExpected,
      `동시 primary 쓰기는 population 도중(1..${totalChunksExpected - 1} 청크 완료 시점)에 끝나야 한다 — ` +
        `0이면 population을 시작하기도 전에 새치기한 것이고 ${totalChunksExpected}(전부)면 population이 끝날 때까지 ` +
        `막혀 있었다는 뜻이다. 관측값: ${primaryWriteCompletedAtChunkCount}`,
    );

    // ── 핵심 단언 2: probe 체인 자신도 population 도중 여러 번(최소 3회)
    // 실행돼, "중간 상태"가 우연한 1회성 관측이 아니라 반복적으로
    // 존재했음을 보여준다 — 첫 청크에서만 우연히 한 번 양보하고 나머지는
    // 한 덩어리로 도는 회귀도 잡아낸다.
    const midRunProbes = probeLog.filter((c) => c > 0 && c < totalChunksExpected);
    assert.ok(
      midRunProbes.length >= 3,
      `population 도중 중간 상태를 최소 3번은 관측해야 한다(매 청크 사이 양보) — got ${midRunProbes.length} (전체 로그: ${JSON.stringify(probeLog)})`,
    );
    // 중간 상태들은 단조 비감소여야 한다(청크는 순서대로만 완료된다).
    for (let i = 1; i < midRunProbes.length; i++) {
      assert.ok(midRunProbes[i] >= midRunProbes[i - 1], 'probe가 관측한 완료 청크 수는 단조 비감소여야 한다');
    }

    // ── primary DataSource가 실제로 그 쓰기를 받았는지(가짜 신호가 아님) ──
    const wsRepo = AppDataSource.getRepository(Workspace);
    const found = await wsRepo.findOne({ where: { name: 'nonblocking-probe' } });
    assert.ok(found, '동시 primary 쓰기가 실제로 커밋됐어야 한다');
  });
});

// TypeORM/sql.js는 이벤트 루프를 붙잡아두는 핸들을 남긴다 — `--test-force-exit`로
// 실행해야 한다(package.json test 스크립트가 보장).
