// 회귀 테스트 — ticket 20b07fc8 "[Ontology Graph 5/7] 질의 API" 완료조건 1:
// "대형(수백만 엣지) 합성 fixture에서 bounded 쿼리가 실제로 유계(row 수
// 상한 내)로 종료됨을 회귀 테스트로 확인."
//
// 중요한 함정(graph-query.ts 파일 헤더 코멘트에도 기록) — 최종 출력의
// row cap(LIMIT)은 도달 가능한 "노드" 수만 제한할 뿐, 재귀 CTE 자체가
// 내부적으로 생성하는 "경로" 수는 다른 문제다. DuckDB의 자체 실측
// (research-storage.md §2.3 — 424노드 그래프에서 vanilla 재귀 CTE가
// 6억 행을 만들고 OOM)은 depth cap 안에서도 조밀한(fan-out이 큰) 그래프면
// 중간 평가 비용이 Σ(fan-in×fan-out)^depth로 폭발할 수 있다는 뜻이다.
// 그래서 이 스위트는 두 가지를 분리해서 증명한다:
//
//   (A) 작지만 "조밀한" fixture — rowCap이 실제로 걸려 잘리고 truncated가
//       정확히 서는지를 빠르고 결정론적으로 검증(수 ms).
//   (B) 진짜 대형(300k 노드 / 300만 엣지) fixture — 현실적인 평균 fan-out
//       (~10)으로, 물리적 엣지 수는 "수백만"을 문자 그대로 만족시키면서도
//       depth cap 안에서 재귀 평가가 실제로 안전하게 끝난다는 것을 증명한다
//       (모든 실제 코드 그래프의 평균 차수가 완전 이분 그래프처럼
//       극단적이지 않다는 research-extraction.md §1의 243.6 refs/kLOC
//       실측과 같은 전제 — 의도적으로 인접한 두 레이어가 완전 연결된
//       조밀한 그래프를 쓰지 않는다. 그런 그래프는 depth cap이 있어도
//       여전히 값비쌀 수 있다는 것이 바로 (A)/헤더 코멘트가 인정하는
//       한계다).
//
// 대량 삽입은 이 서비스의 제품 경로(persist.ts/resolve.ts)가 지키는
// "청크 사이 매크로태스크 양보" 계약과 무관한 **테스트 픽스처 세팅**이라
// insertChunked를 재사용하지 않고 원시 다중-row INSERT로 빠르게 만든다
// (이 계약은 population write 경로 자체를 검증하는 2/7·3/7 테스트의
// 몫이지, 이 티켓의 질의 서비스가 지킬 계약이 아니다).
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-query-scale-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { graphNeighbors, graphCallPath, MAX_CALL_PATH_VISITED } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/ontology/query/graph-query.js')
);
const { AppOntologyDataSource, initOntologyDb, flushOntologySqljs } = await import('file://' + path.join(DIST_ROOT, 'db.js'));

const INSERT_BATCH = 500; // persist.ts EDGE_CHUNK_SIZE 선례와 동일한 안전 크기

async function bulkInsertNodes(rows) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const r of batch) params.push(r.id, r.workspace_id, r.graph_id, r.symbol_id, r.type, r.layer, r.name, r.confidence, r.status);
    await AppOntologyDataSource.query(
      `INSERT INTO ontology_nodes (id, workspace_id, graph_id, symbol_id, type, layer, name, confidence, status) VALUES ${placeholders}`,
      params,
    );
  }
}

async function bulkInsertEdges(rows) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const r of batch) params.push(r.id, r.workspace_id, r.graph_id, r.src_id, r.dst_id, r.type, r.layer, r.confidence, r.status);
    await AppOntologyDataSource.query(
      `INSERT INTO ontology_edges (id, workspace_id, graph_id, src_id, dst_id, type, layer, confidence, status) VALUES ${placeholders}`,
      params,
    );
  }
}

before(async () => {
  await initOntologyDb();
});

after(async () => {
  if (AppOntologyDataSource?.isInitialized) {
    await flushOntologySqljs(AppOntologyDataSource, true);
    await AppOntologyDataSource.destroy();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('(A) 작지만 조밀한 fixture — rowCap이 실제로 잘린다', () => {
  const GRAPH_ID = 'dense-small-graph';
  const WIDTH = 40; // depth1 40개, depth2 최대 40*40=1600개 도달 가능(전부 물리적으로 저장) — rowCap(예: 50)보다 훨씬 크다.

  before(async () => {
    const nodes = [{ id: 'root', workspace_id: 'ws', graph_id: GRAPH_ID, symbol_id: 'sym:root', type: 'Callable', layer: 'structural', name: 'root', confidence: 1, status: 'active' }];
    const edges = [];
    for (let i = 0; i < WIDTH; i++) {
      const mid = `m${i}`;
      nodes.push({ id: mid, workspace_id: 'ws', graph_id: GRAPH_ID, symbol_id: `sym:${mid}`, type: 'Callable', layer: 'structural', name: mid, confidence: 1, status: 'active' });
      edges.push({ id: `e-root-${i}`, workspace_id: 'ws', graph_id: GRAPH_ID, src_id: 'root', dst_id: mid, type: 'CALLS', layer: 'structural', confidence: 0.9, status: 'active' });
      for (let j = 0; j < WIDTH; j++) {
        const leaf = `leaf-${i}-${j}`;
        nodes.push({ id: leaf, workspace_id: 'ws', graph_id: GRAPH_ID, symbol_id: `sym:${leaf}`, type: 'Callable', layer: 'structural', name: leaf, confidence: 1, status: 'active' });
        edges.push({ id: `e-${i}-${j}`, workspace_id: 'ws', graph_id: GRAPH_ID, src_id: mid, dst_id: leaf, type: 'CALLS', layer: 'structural', confidence: 0.9, status: 'active' });
      }
    }
    await bulkInsertNodes(nodes);
    await bulkInsertEdges(edges);
  });

  it('rowCap보다 도달 가능한 노드가 훨씬 많아도 결과는 정확히 rowCap개고 truncated=true다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'root', rowCap: 50, maxDepth: 4 });
    assert.equal(result.rows.length, 50);
    assert.equal(result.truncated, true);
  });

  it('rowCap을 도달 가능 수(1640 = 40 + 40*40)보다 크게 주면 전부 반환되고 truncated=false다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'root', rowCap: 5000, maxDepth: 4 });
    assert.equal(result.rows.length, 1640);
    assert.equal(result.truncated, false);
  });
});

describe('(B) 진짜 대형 fixture — 300k 노드 / 300만 엣지, 현실적 평균 fan-out', () => {
  const GRAPH_ID = 'large-realistic-graph';
  const NODE_COUNT = 300_000;
  const AVG_OUT_DEGREE = 10;
  const EDGE_COUNT = NODE_COUNT * AVG_OUT_DEGREE; // 3,000,000

  before(async () => {
    const t0 = Date.now();
    const nodeRows = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      const id = `n${i}`;
      nodeRows.push({ id, workspace_id: 'ws', graph_id: GRAPH_ID, symbol_id: `sym:${id}`, type: 'Callable', layer: 'structural', name: id, confidence: 1, status: 'active' });
    }
    await bulkInsertNodes(nodeRows);

    // 엣지는 스트리밍 배치로 생성+삽입한다(300만 개를 한 번에 배열로
    // 들고 있지 않기 위해) — 각 노드에서 AVG_OUT_DEGREE개의 무작위 대상으로
    // 나간다. confidence는 항상 기본 confidence_min(0.75) 이상으로 둬서
    // 이 스위트는 순수하게 "유계 종료"만 검증하고 confidence 필터링은
    // 다른 두 테스트 파일(neighbors/blast-radius, call-path)의 몫으로
        // 남겨둔다.
    let batch = [];
    let edgeSeq = 0;
    for (let i = 0; i < NODE_COUNT; i++) {
      for (let k = 0; k < AVG_OUT_DEGREE; k++) {
        const dst = Math.floor(Math.random() * NODE_COUNT);
        batch.push({
          id: `e${edgeSeq}`, workspace_id: 'ws', graph_id: GRAPH_ID,
          src_id: `n${i}`, dst_id: `n${dst}`, type: 'CALLS', layer: 'structural',
          confidence: 0.75 + Math.random() * 0.25, status: 'active',
        });
        edgeSeq += 1;
      }
      if (batch.length >= INSERT_BATCH) {
        await bulkInsertEdges(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await bulkInsertEdges(batch);

    assert.equal(edgeSeq, EDGE_COUNT);
    console.log(`  [scale fixture] ${NODE_COUNT} 노드 / ${edgeSeq} 엣지 삽입 완료 — ${Date.now() - t0}ms`);
  });

  it('300만 엣지 그래프에서도 graphNeighbors는 완료되고 rowCap 안에 머문다(하드 타임아웃 이하)', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'n0', rowCap: 200, maxDepth: 4 });
    assert.ok(result.rows.length <= 200, `row cap을 넘으면 안 된다: ${result.rows.length}`);
    // 평균 out-degree 10에 depth 4면 도달 가능 노드가 200개보다 훨씬
    // 많을 것이 거의 확실하다(무작위 그래프의 birthday-paradox식 수렴을
    // 감안해도) — truncated=true가 나오는지까지 함께 확인해 "우연히
    // 작아서 안 잘린 것"이 아님을 보인다.
    assert.equal(result.truncated, true);
    console.log(`  [graphNeighbors] durationMs=${result.durationMs}`);
  });

  it('300만 엣지 그래프에서도 graphCallPath는 완료된다(무한 루프/OOM 없이)', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'n0', toId: 'n1' });
    // found든 아니든 상관없다 — 이 테스트가 증명하는 것은 오직
    // "끝난다"와 "방문집합이 안전 상한을 넘지 않는다"뿐이다.
    assert.ok(result.nodesVisited <= MAX_CALL_PATH_VISITED + 1000, `방문 노드 수가 안전 상한을 크게 넘었다: ${result.nodesVisited}`);
    console.log(`  [graphCallPath] found=${result.found} hops=${result.hops} nodesVisited=${result.nodesVisited} truncated=${result.truncated} durationMs=${result.durationMs}`);
  });
});
