// 회귀 테스트 — ticket 20b07fc8 "[Ontology Graph 5/7] 질의 API" 완료조건 1:
// "대형(수백만 엣지) 합성 fixture에서 bounded 쿼리가 실제로 유계(row 수
// 상한 내)로 종료됨을 회귀 테스트로 확인."
//
// **리뷰 지적 반영(1차 라운드, 블로커 1/2)**: 최초 구현은 최종 출력의
// row cap(LIMIT)이 재귀 평가 자체를 보호한다고 착각했다 — 실제로는
// `GROUP BY`/`ORDER BY` 뒤에만 적용돼, 수렴 후 재확산하는 그래프에서는
// depth cap 안에서도 경로 수만큼 중간 행이 쌓인 뒤에야 잘렸다(DuckDB
// 실측 — research-storage.md §2.3, 424노드에서 6억 행+OOM과 같은 위험
// 클래스). graph-query.ts는 이제 재귀 CTE를 `UNION`(distinct) +
// `(node_id, depth)` 튜플만으로 재작성해 중간 행 자체를 노드 수×depth로
// 상한한다(path 컬럼과 경로별 cycle guard는 더 이상 없음 — UNION의
// 전체-누적-결과 대상 중복 제거가 그 역할을 대신한다). graphCallPath의
// BFS도 청크별 SQL LIMIT으로 방문 예산을 정확히 강제하도록 고쳤다
// (ontology-query-call-path.test.mjs의 별도 스위트가 그 정확성/방문상한
// 회귀를 함께 증명).
//
// 이 스위트는 세 가지를 분리해서 증명한다:
//
//   (A) 작지만 "조밀한" fixture — rowCap이 실제로 걸려 잘리고 truncated가
//       정확히 서는지를 빠르고 결정론적으로 검증(수 ms).
//   (B) 진짜 대형(300k 노드 / 300만 엣지) fixture — 현실적인 평균 fan-out
//       (~10)으로, 물리적 엣지 수는 "수백만"을 문자 그대로 만족시키면서도
//       depth cap 안에서 재귀 평가가 실제로 안전하게 끝난다는 것을 증명한다.
//   (C) **합류 후 재확산(다이아몬드) fixture** — 리뷰 지적이 정확히
//       요구한 "다수 경로가 같은 노드로 합류했다 다시 퍼지는" 위상.
//       노드 600여 개뿐이지만 UNION ALL(수정 전) 의미론이었다면 경로
//       수가 200²=40,000 이상으로 폭발했을 구조에서, 실제 반환 행 수가
//       "노드 수"와 정확히 일치함을(경로 수가 아니라) 단정 검증한다.
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
    // "끝난다"와 "방문집합이 안전 상한을 넘지 않는다"뿐이다. 리뷰 지적
    // 반영 후 이제 MAX_CALL_PATH_VISITED는 청크별 SQL LIMIT으로 강제되는
    // 진짜 하드 캡이라 슬랙(+1000) 없이 단정한다.
    assert.ok(result.nodesVisited <= MAX_CALL_PATH_VISITED, `방문 노드 수가 하드 상한을 넘으면 안 된다: ${result.nodesVisited}`);
    console.log(`  [graphCallPath] found=${result.found} hops=${result.hops} nodesVisited=${result.nodesVisited} truncated=${result.truncated} durationMs=${result.durationMs}`);
  });
});

describe('(C) 합류 후 재확산(다이아몬드) fixture — 재귀 CTE 중간 행이 경로 수가 아니라 노드 수로 상한된다', () => {
  const GRAPH_ID = 'diamond-graph';
  const WIDTH = 200; // Root->A(200개)->HUB1(1개, 200개 경로 합류)->B(200개, 각 200개 경로)->HUB2(1개, 200*200=40,000개 경로 합류)

  before(async () => {
    // 노드 id는 이 파일의 다른 describe 블록들과 전역 PK(ontology_nodes.id는
    // graph_id와 무관하게 그 자체로 유니크)가 겹치지 않도록 'dm-' 접두사를
    // 쓴다((A)의 'root'와 충돌했던 리뷰 후속 수정 라운드에서 발견).
    const nodes = [{ id: 'dm-root', workspace_id: 'ws', graph_id: GRAPH_ID, symbol_id: 'sym:dm-root', type: 'Callable', layer: 'structural', name: 'root', confidence: 1, status: 'active' }];
    const edges = [];
    const mkNode = (id) => ({ id, workspace_id: 'ws', graph_id: GRAPH_ID, symbol_id: `sym:${id}`, type: 'Callable', layer: 'structural', name: id, confidence: 1, status: 'active' });
    const mkEdge = (id, src, dst) => ({ id, workspace_id: 'ws', graph_id: GRAPH_ID, src_id: src, dst_id: dst, type: 'CALLS', layer: 'structural', confidence: 0.9, status: 'active' });

    nodes.push(mkNode('dm-hub1'), mkNode('dm-hub2'));
    for (let i = 0; i < WIDTH; i++) {
      nodes.push(mkNode(`dm-a${i}`), mkNode(`dm-b${i}`));
      edges.push(mkEdge(`dm-e-root-a${i}`, 'dm-root', `dm-a${i}`)); // depth1: root -> A_i (합류 시작)
      edges.push(mkEdge(`dm-e-a${i}-hub1`, `dm-a${i}`, 'dm-hub1')); // depth2: A_i -> hub1 (WIDTH개 경로 합류)
      edges.push(mkEdge(`dm-e-hub1-b${i}`, 'dm-hub1', `dm-b${i}`)); // depth3: hub1 -> B_i (재확산, 각 B_i가 WIDTH개 경로를 물려받음)
      edges.push(mkEdge(`dm-e-b${i}-hub2`, `dm-b${i}`, 'dm-hub2')); // depth4: B_i -> hub2 (WIDTH*WIDTH개 경로 합류)
    }
    await bulkInsertNodes(nodes);
    await bulkInsertEdges(edges);
  });

  it('depth4까지 604개 노드(1+200+1+200+1) 전부가 빠르게, 정확한 depth로 반환된다', async () => {
    const t0 = Date.now();
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'dm-root', rowCap: 5000, maxDepth: 6 });
    const wallMs = Date.now() - t0;
    // UNION ALL(수정 전) 의미론이었다면 hub2에 도달하는 중간 행만 최소
    // WIDTH*WIDTH=40,000개(그리고 depth4 전체로는 그보다 훨씬 많이)
    // 쌓였어야 한다 — 노드 수(604) 근처에서 빠르게 끝난다는 것 자체가
    // 중복 제거가 실제로 동작하고 있다는 증거다.
    const byId = new Map(result.rows.map((r) => [r.node.id, r.depth]));
    assert.equal(result.rows.length, 1 + WIDTH + 1 + WIDTH, '반환 행 수는 도달 가능한 "노드" 수와 정확히 같아야 한다(경로 수 아님)');
    assert.equal(result.truncated, false);
    assert.equal(byId.get('dm-a0'), 1);
    assert.equal(byId.get('dm-hub1'), 2);
    assert.equal(byId.get('dm-b0'), 3);
    assert.equal(byId.get('dm-hub2'), 4);
    assert.ok(wallMs < 5000, `합류-재확산 그래프 질의가 비정상적으로 오래 걸렸다(중간 행 폭발 의심): ${wallMs}ms`);
  });

  it('rowCap을 작게 주면(경로 수가 아니라) 여전히 정확히 rowCap개로 잘린다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'dm-root', rowCap: 10, maxDepth: 6 });
    assert.equal(result.rows.length, 10);
    assert.equal(result.truncated, true);
  });
});

describe('(D) 단일 허브 fixture — BFS 방문 상한이 진짜 하드 캡이다', () => {
  const GRAPH_ID = 'hub-graph';
  const HUB_OUT_DEGREE = MAX_CALL_PATH_VISITED + 10_000; // 방문 상한보다 확실히 더 많은 outgoing edge를 가진 단일 허브

  before(async () => {
    // 이 스위트는 OntologyEdge만 조회한다(graphCallPath는 노드를
    // hydrate하지 않는다) — 노드 row는 만들 필요 없다. 엣지 id는 (B)
    // fixture의 'e0'..'e2999999'와 전역 PK가 겹치지 않도록 'hub-' 접두사를
    // 쓴다(리뷰 후속 수정 라운드에서 발견한 충돌).
    let batch = [];
    for (let i = 0; i < HUB_OUT_DEGREE; i++) {
      batch.push({ id: `hub-e${i}`, workspace_id: 'ws', graph_id: GRAPH_ID, src_id: 'hub', dst_id: `leaf${i}`, type: 'CALLS', layer: 'structural', confidence: 0.9, status: 'active' });
      if (batch.length >= INSERT_BATCH) {
        await bulkInsertEdges(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await bulkInsertEdges(batch);
  });

  it('허브에서 도달 불가능한 목적지로의 탐색은 nodesVisited<=MAX_CALL_PATH_VISITED를 정확히(슬랙 없이) 지키며 truncated=true로 끝난다', async () => {
    const t0 = Date.now();
    // 'unreachable'은 어떤 엣지로도 가리켜지지 않는 고립 노드 — 절대
    // found=true가 될 수 없어, 이 테스트가 순수하게 방문 상한 자체만
    // 검증하게 한다.
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'hub', toId: 'unreachable' });
    const wallMs = Date.now() - t0;
    assert.equal(result.found, false);
    assert.equal(result.truncated, true);
    assert.ok(result.nodesVisited <= MAX_CALL_PATH_VISITED, `방문 노드 수가 하드 상한을 넘었다: ${result.nodesVisited}`);
    assert.ok(result.nodesVisited > MAX_CALL_PATH_VISITED - 100, `상한 근처까지 실제로 방문했어야 한다(너무 적으면 캡이 아니라 다른 이유로 멈춘 것): ${result.nodesVisited}`);
    assert.ok(wallMs < 30_000, `단일 허브 탐색이 비정상적으로 오래 걸렸다: ${wallMs}ms`);
  });
});
