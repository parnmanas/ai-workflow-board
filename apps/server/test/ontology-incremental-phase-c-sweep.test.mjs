// 회귀 테스트 — ticket 964014f5 "[Ontology Graph 4/7]" Phase C(evidence-hash
// staleness, LLM 호출 없음) + 완료조건 3(스윕 stale-queue 크기/age
// 퍼센타일 텔레메트리 로깅). 컴파일된 dist/ 대상, 격리된
// SQLJS_ONTOLOGY_DB_PATH — ontology 계열 테스트 관례 그대로.
//
// 오늘의 실제 코드베이스엔 semantic/derived 레이어 엣지를 만드는 경로가
// 없다(Tier 1/1.5만 구현) — 그래서 이 테스트는 수작업으로 semantic 엣지
// 행을 직접 삽입해 Phase C/스윕을 대상이 있는 상태에서 검증한다.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-phase-c-sweep-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { runPhaseC } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/incremental/phase-c.js'));
const { insertChunked } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/persist.js'));
const { OntologyStaleSweepService } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/incremental/sweep.service.js'));
const { AppOntologyDataSource, initOntologyDb, flushOntologySqljs } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));
const { OntologyEdge } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEdge.js'));
const { OntologyEnrichmentQueue } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEnrichmentQueue.js'));

const WORKSPACE_ID = 'phase-c-sweep-ws';
const GRAPH_ID = 'phase-c-sweep-graph';
const FILE_PATH = 'summarized-file.ts';

let nodeRepo, edgeRepo, queueRepo;

before(async () => {
  await initOntologyDb();
  nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
  edgeRepo = AppOntologyDataSource.getRepository(OntologyEdge);
  queueRepo = AppOntologyDataSource.getRepository(OntologyEnrichmentQueue);
});

after(async () => {
  if (AppOntologyDataSource?.isInitialized) {
    await flushOntologySqljs(AppOntologyDataSource, true);
    await AppOntologyDataSource.destroy();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function minimalNodeRow({ id, type, path: p, content_hash, pagerank }) {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    graph_id: GRAPH_ID,
    symbol_id: `${type.toLowerCase()}:${p ?? id}`,
    type,
    layer: 'structural',
    name: p ? p.split('/').pop() : type,
    confidence: 1,
    path: p ?? '',
    content_hash: content_hash ?? '',
    pagerank: pagerank ?? 0,
    status: 'active',
  };
}

describe('Phase C — evidence_ref content_hash 불일치를 stale로 뒤집고 enrichment_queue를 채운다(LLM 호출 없음)', () => {
  const FILE_ID = randomUUID();
  const SUMMARY_NODE_ID = randomUUID();
  const SEMANTIC_EDGE_ID = randomUUID();
  const NO_EVIDENCE_EDGE_ID = randomUUID();

  before(async () => {
    await nodeRepo.insert([
      minimalNodeRow({ id: FILE_ID, type: 'File', path: FILE_PATH, content_hash: 'hash-v1', pagerank: 0 }),
      // priority는 엣지의 SRC(=재요약 대상, 여기선 Concept 노드) pagerank로
      // 산정된다(phase-c.ts) — FILE 노드가 아니라 이 노드에 pagerank를 줘야 한다.
      minimalNodeRow({ id: SUMMARY_NODE_ID, type: 'Concept', path: '', content_hash: '', pagerank: 0.5 }),
    ]);
    await edgeRepo.insert([
      {
        id: SEMANTIC_EDGE_ID,
        workspace_id: WORKSPACE_ID,
        graph_id: GRAPH_ID,
        src_id: SUMMARY_NODE_ID,
        dst_id: FILE_ID,
        type: 'ABOUT',
        layer: 'semantic',
        confidence: 0.8,
        status: 'active',
        evidence_ref: JSON.stringify([{ path: FILE_PATH, start: 1, end: 5, content_hash: 'hash-v1' }]),
        props: '{}',
      },
      {
        // evidence_ref가 비어 있는 semantic 엣지 — 판단 근거가 없으니
        // 절대 stale로 뒤집으면 안 된다(false positive보다 무판정이 안전).
        id: NO_EVIDENCE_EDGE_ID,
        workspace_id: WORKSPACE_ID,
        graph_id: GRAPH_ID,
        src_id: SUMMARY_NODE_ID,
        dst_id: FILE_ID,
        type: 'ABOUT',
        layer: 'semantic',
        confidence: 0.8,
        status: 'active',
        evidence_ref: '[]',
        props: '{}',
      },
    ]);
  });

  it('content_hash가 evidence_ref와 여전히 일치하면 아무것도 뒤집지 않는다', async () => {
    const result = await runPhaseC(AppOntologyDataSource, GRAPH_ID);
    assert.equal(result.edgesScanned, 2);
    assert.equal(result.edgesFlippedStale, 0);
    assert.equal(result.enrichmentQueueUpserts, 0);

    const edge = await edgeRepo.findOne({ where: { id: SEMANTIC_EDGE_ID } });
    assert.equal(edge.status, 'active');
  });

  it('File.content_hash가 바뀌면(다른 경로로 재추출됨) evidence_ref 불일치 엣지만 stale로 뒤집힌다', async () => {
    await nodeRepo.update({ id: FILE_ID }, { content_hash: 'hash-v2' });

    const result = await runPhaseC(AppOntologyDataSource, GRAPH_ID);
    assert.equal(result.edgesFlippedStale, 1, 'evidence_ref를 가진 엣지 하나만 뒤집혀야 한다');
    assert.equal(result.enrichmentQueueUpserts, 1);

    const flippedEdge = await edgeRepo.findOne({ where: { id: SEMANTIC_EDGE_ID } });
    assert.equal(flippedEdge.status, 'stale');
    const untouchedEdge = await edgeRepo.findOne({ where: { id: NO_EVIDENCE_EDGE_ID } });
    assert.equal(untouchedEdge.status, 'active', 'evidence_ref가 빈 엣지는 무근거로 stale 처리하면 안 된다');

    const queueRow = await queueRepo.findOne({ where: { graph_id: GRAPH_ID, node_id: SUMMARY_NODE_ID } });
    assert.ok(queueRow, 'stale로 뒤집힌 엣지의 src 노드가 enrichment_queue에 올라가야 한다');
    assert.ok(queueRow.priority < 0, 'pagerank(0.5)가 있으므로 priority는 음수(더 먼저 드레인)여야 한다');
  });

  it('같은 불일치 상태로 Phase C를 다시 돌려도 enrichment_queue 행이 중복되지 않는다(unique 인덱스, upsert)', async () => {
    const before = await queueRepo.find({ where: { graph_id: GRAPH_ID, node_id: SUMMARY_NODE_ID } });
    assert.equal(before.length, 1);

    await runPhaseC(AppOntologyDataSource, GRAPH_ID);

    const after = await queueRepo.find({ where: { graph_id: GRAPH_ID, node_id: SUMMARY_NODE_ID } });
    assert.equal(after.length, 1, 'graph_id+node_id unique 인덱스 — 같은 노드는 항상 한 행으로 upsert');
  });
});

describe('완료조건 3 — 스윕이 stale-queue 크기/age 퍼센타일을 텔레메트리로 로깅한다(LLM 호출 없음)', () => {
  const loggedCalls = [];
  const fakeLogService = {
    info: (...args) => loggedCalls.push(['info', ...args]),
    warn: (...args) => loggedCalls.push(['warn', ...args]),
    error: (...args) => loggedCalls.push(['error', ...args]),
  };
  // OntologyStaleSweepService.resolveOntologyDataSource()는 AppOntologyDataSource가
  // non-null이면(이 테스트 환경 — sql.js) nestDataSource를 절대 쓰지 않는다 —
  // 그래서 placeholder를 넘겨도 안전하다(qa-run-reaper-behavior.test.mjs의
  // noopLog 패턴과 동일하게 DI 컨테이너 없이 직접 new).
  const sweep = new OntologyStaleSweepService({}, fakeLogService);

  // runOnce()는 cooldown_until을 갱신하는 부수효과가 있어(드레인 대상을
  // 다음 스윕에서 또 고르지 않기 위해) 호출 순서가 결과에 영향을 준다 —
  // 그래서 "1번째 호출(드레인 발생)"과 "2번째 호출(cooldown으로 제외)"을
  // 한 테스트 안에서 순서대로 검증한다(별도 it()로 나누면 앞선 무관한
  // 호출이 뒤 테스트의 cooldown 창을 먼저 소비해버린다).
  it('대기열이 있으면 그래프별 크기/age 퍼센타일을 계산해 로깅하고, 두 번째 스윕은 cooldown 때문에 재드레인하지 않는다', async () => {
    const emptyGraphId = 'sweep-empty-graph';
    const firstSweep = await sweep.runOnce();

    assert.ok(!firstSweep.some((r) => r.graphId === emptyGraphId), '대상이 없는 그래프는 결과에 아예 등장하지 않아야 한다(정직한 무판정)');

    const forGraph = firstSweep.find((r) => r.graphId === GRAPH_ID);
    assert.ok(forGraph, '앞선 describe 블록이 만든 enrichment_queue 행이 이 그래프에 있어야 한다');
    assert.equal(forGraph.queueSize, 1);
    assert.ok(forGraph.ageMsP50 >= 0 && forGraph.ageMsP90 >= 0 && forGraph.ageMsP99 >= 0);
    assert.equal(forGraph.drainedThisSweep, 1, '첫 스윕은 cooldown이 없던 행을 batchCap 안에서 드레인 고려해야 한다');

    const telemetryLog = loggedCalls.find(
      (c) => c[0] === 'info' && c[1] === 'OntologySweep' && c[2] === 'stale queue telemetry' && c[3]?.graph_id === GRAPH_ID,
    );
    assert.ok(telemetryLog, '완료조건 3 — LogService.info(\'OntologySweep\', \'stale queue telemetry\', {...})로 실제 로깅돼야 한다');
    assert.equal(telemetryLog[3].queue_size, 1);

    // 방금 cooldown_until이 미래로 갱신됐으니 즉시 재드레인하면 안 된다.
    const secondSweep = await sweep.runOnce();
    const secondForGraph = secondSweep.find((r) => r.graphId === GRAPH_ID);
    assert.equal(secondForGraph.drainedThisSweep, 0, 'cooldown 안에 있는 행은 재드레인 대상에서 빠져야 한다');
    assert.equal(secondForGraph.queueSize, 1, 'queueSize 자체는(드레인 여부와 무관하게) 여전히 1이다');
  });
});

describe('리뷰 지적(차단2) — Phase C의 allPaths/srcIds 청크 조회가 청크 경계(500) 너머까지 정확히 처리한다', () => {
  const GRAPH_ID = 'phase-c-chunk-graph';
  const N = 620; // ID_CHUNK_SIZE(500)보다 크게 — 청크 하나로는 안 끝나야 한다.

  it('620개의 distinct src 노드 + evidence_ref 경로가 청크 경계를 넘어도 각자 자기 pagerank로 정확히 처리된다', async () => {
    const dstFileId = randomUUID();
    const dstRow = {
      id: dstFileId,
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      symbol_id: 'file:chunk-shared.ts',
      type: 'File',
      layer: 'structural',
      name: 'chunk-shared.ts',
      qualified_name: 'chunk-shared.ts',
      path: 'chunk-shared.ts',
      confidence: 1,
      content_hash: 'this-will-never-match-any-evidence_ref',
      status: 'active',
    };

    const srcIds = Array.from({ length: N }, () => randomUUID());
    const srcRows = srcIds.map((id, i) => ({
      id,
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      symbol_id: `concept:${i}`,
      type: 'Concept',
      layer: 'semantic',
      name: `concept${i}`,
      qualified_name: `concept${i}`,
      path: '',
      confidence: 1,
      status: 'active',
      pagerank: i / 1000,
    }));
    await insertChunked(nodeRepo, [dstRow, ...srcRows], 500);

    // 각 엣지가 서로 다른 가짜 경로를 evidence_ref로 인용한다 — 실제
    // File 노드가 없는 경로라 currentHashByPath 조회가 항상 미스, 그래서
    // 전부 stale로 뒤집힌다. 동시에 이 N개의 distinct 가짜 경로가
    // allPaths 청크 조회를, N개의 distinct src가 srcIds 청크 조회를 각각
    // 500개 경계 너머까지 실제로 돌게 만든다.
    const edgeRows = srcIds.map((srcId, i) => ({
      id: randomUUID(),
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      src_id: srcId,
      dst_id: dstFileId,
      type: 'ABOUT',
      layer: 'semantic',
      confidence: 0.8,
      status: 'active',
      evidence_ref: JSON.stringify([{ path: `nonexistent-${i}.ts`, content_hash: 'whatever' }]),
      props: '{}',
    }));
    await insertChunked(edgeRepo, edgeRows, 500);

    const result = await runPhaseC(AppOntologyDataSource, GRAPH_ID);
    assert.equal(result.edgesScanned, N);
    assert.equal(
      result.edgesFlippedStale,
      N,
      '가짜 경로라 전부 불일치해야 한다 — allPaths 청크가 일부만 처리되면 이 수가 500언저리에서 끊긴다',
    );

    // 청크 경계 양쪽(첫 청크 시작/첫 청크 끝/둘째 청크 시작/둘째 청크 끝)에서
    // 각자 자기 pagerank로 priority가 정확히 산정됐는지 확인 — srcIds
    // 청크 조회가 엉뚱한 청크의 값을 섞어 매칭하면 이 값이 틀어진다.
    for (const i of [0, 499, 500, N - 1]) {
      const row = await queueRepo.findOne({ where: { graph_id: GRAPH_ID, node_id: srcIds[i] } });
      assert.ok(row, `index ${i}의 enrichment_queue 행이 있어야 한다`);
      assert.ok(
        Math.abs(row.priority - -(i / 1000)) < 1e-9,
        `index ${i}는 자기 pagerank(${i / 1000})로 priority(-pagerank)가 산정돼야 한다 — 실제는 ${row.priority}`,
      );
    }
  });
});

describe('리뷰 지적(차단2, 잔존) — Phase C의 candidate 스캔 자체가 keyset pagination으로 순회된다', () => {
  const GRAPH_ID = 'phase-c-keyset-pagination-graph';
  const N = 7; // pageSize=2로 나누면 4페이지(2,2,2,1) — 마지막 페이지가 꽉 안 찬 경우까지 포함.

  it('작은 pageSize(2)를 주입해도 7개 candidate가 페이지 경계 누락 없이 전부 처리된다', async () => {
    const dstFileId = randomUUID();
    const dstRow = {
      id: dstFileId,
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      symbol_id: 'file:keyset-shared.ts',
      type: 'File',
      layer: 'structural',
      name: 'keyset-shared.ts',
      qualified_name: 'keyset-shared.ts',
      path: 'keyset-shared.ts',
      confidence: 1,
      content_hash: 'never-matches-any-evidence_ref',
      status: 'active',
    };
    const srcIds = Array.from({ length: N }, () => randomUUID());
    const srcRows = srcIds.map((id, i) => ({
      id,
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      symbol_id: `keyset-concept:${i}`,
      type: 'Concept',
      layer: 'semantic',
      name: `k${i}`,
      qualified_name: `k${i}`,
      path: '',
      confidence: 1,
      status: 'active',
      pagerank: (i + 1) / 100,
    }));
    await insertChunked(nodeRepo, [dstRow, ...srcRows], 500);

    const edgeRows = srcIds.map((srcId, i) => ({
      id: randomUUID(),
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      src_id: srcId,
      dst_id: dstFileId,
      type: 'ABOUT',
      layer: 'semantic',
      confidence: 0.8,
      status: 'active',
      evidence_ref: JSON.stringify([{ path: `keyset-nonexistent-${i}.ts`, content_hash: 'whatever' }]),
      props: '{}',
    }));
    await insertChunked(edgeRepo, edgeRows, 500);

    const result = await runPhaseC(AppOntologyDataSource, GRAPH_ID, { pageSize: 2 });
    assert.equal(result.edgesScanned, N, 'pageSize=2로 4번(2+2+2+1) 나눠 순회해도 스캔 총량은 N이어야 한다');
    assert.equal(
      result.edgesFlippedStale,
      N,
      '모든 페이지가 처리돼야 한다 — 마지막(꽉 안 찬) 페이지가 누락되면 이 수가 N보다 작아진다',
    );

    for (let i = 0; i < N; i++) {
      const row = await queueRepo.findOne({ where: { graph_id: GRAPH_ID, node_id: srcIds[i] } });
      assert.ok(row, `index ${i}(페이지 ${Math.floor(i / 2) + 1})가 처리돼야 한다`);
      assert.ok(
        Math.abs(row.priority - -((i + 1) / 100)) < 1e-9,
        `index ${i}는 자기 pagerank로 priority가 산정돼야 한다 — 페이지 상태가 섞이면 이 값이 틀어진다`,
      );
    }
  });
});
