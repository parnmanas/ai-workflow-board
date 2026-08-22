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
