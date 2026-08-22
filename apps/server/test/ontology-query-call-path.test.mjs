// 회귀 테스트 — ticket 20b07fc8 "[Ontology Graph 5/7] 질의 API".
//
// graphCallPath(application-orchestrated bidirectional level-BFS)를
// 검증한다: 완료조건 3(path_confidence는 min-along-path, 곱셈 금지),
// 완료조건 2 중 BFS 쪽(confidence_min이 프론티어 쿼리에 실제 적용),
// hop cap이 "총 경로 길이" 상한으로 정확히 작동함(편도 각각 maxHops가
// 아니라 왕복 합쳐 maxHops라는 것 — 구현 중 발견한 함정, graph-query.ts의
// loop 코멘트 참고), **리뷰 지적(1라운드, 블로커3)** — 같은 라운드에서
// 여러 교차 후보가 발견될 때 첫 번째가 아니라 combinedDepth가 최소인
// 후보를 고르는지, **리뷰 지적(2라운드)** — 그 1라운드 수정의 "청크당
// SQL LIMIT"과 결합하면서 생긴 새 결함(예산 캡에 걸려 잘린 청크에서
// 후보 하나를 찾으면 잘려나간 나머지의 더 짧은 후보를 놓칠 수 있었음),
// 그리고 **리뷰 지적(3라운드)** — OntologyEdge에 (src_id,dst_id[,type])
// 유일성 제약이 없어 같은 노드 쌍 사이에 parallel active edge가 임의
// 개수 있을 수 있다는 점(후보 탐지가 "서로 다른 discoveredId 수"로만
// 유계였지 "반환 row 수"로는 유계가 아니었던 결함)까지 전부 결정론적으로
// 재현한다 — graph-query.ts는 이제 후보 탐지·새 노드 발견 둘 다
// discoveredId(또는 대상 노드)당 confidence 최댓값 대표 edge 1개만
// ROW_NUMBER()로 골라 반환 row 자체를 유계로 만든다. 방문 상한 자체가
// 진짜 하드 캡인지(리뷰 지적 1라운드 블로커2, "새 노드 발견" 쪽)는
// ontology-query-bounded-scale.test.mjs의 (D) 단일 허브 fixture가
// 별도로 증명한다.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요) — ontology 계열
// 테스트 전체의 관례.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-query-callpath-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { graphCallPath, MAX_CALL_PATH_HOPS, MAX_CALL_PATH_VISITED } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/ontology/query/graph-query.js')
);
const { AppOntologyDataSource, initOntologyDb, flushOntologySqljs } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));
const { OntologyEdge } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEdge.js'));

const GRAPH_ID = 'callpath-graph';
const WORKSPACE_ID = 'callpath-ws';

let nodeRepo, edgeRepo;

function node(id) {
  return { id, workspace_id: WORKSPACE_ID, graph_id: GRAPH_ID, symbol_id: `sym:${id}`, type: 'Callable', layer: 'structural', name: id, confidence: 1, status: 'active' };
}
function edge(id, srcId, dstId, confidence, overrides = {}) {
  return { id, workspace_id: WORKSPACE_ID, graph_id: GRAPH_ID, src_id: srcId, dst_id: dstId, type: 'CALLS', layer: 'structural', confidence, status: 'active', ...overrides };
}

// 대량(수만 건) edge를 빠르게 심기 위한 원시 다중-row INSERT — TypeORM의
// repo.insert(bigArray)는 한 문장에 전부 넣으려다 바인드 변수 한도를
// 넘길 수 있어(ontology-query-bounded-scale.test.mjs와 같은 이유) 500개씩
// 청크로 나눈다. 이 fixture 세팅 자체는 persist.ts의 "청크 사이 매크로태스크
// 양보" 계약과 무관하다(그 계약은 population write 경로 검증용).
const RAW_INSERT_BATCH = 500;
async function bulkInsertEdgesRaw(rows) {
  for (let i = 0; i < rows.length; i += RAW_INSERT_BATCH) {
    const batch = rows.slice(i, i + RAW_INSERT_BATCH);
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
  nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
  edgeRepo = AppOntologyDataSource.getRepository(OntologyEdge);

  const nodes = [];
  const edges = [];

  // ── 1) min-along-path 검증용 체인: A->B->C->D->E, 각기 다른 confidence.
  //    전부 기본 confidence_min(0.75) 이상이라 경로 자체는 항상 발견되고,
  //    min(0.95,0.85,0.78,0.99)=0.78 != product(≈0.622) — 곱셈이 아니라
  //    min이라는 것을 두 값이 뚜렷이 다르게 나오도록 골랐다.
  for (const id of ['A', 'B', 'C', 'D', 'E']) nodes.push(node(id));
  edges.push(edge('e-ab', 'A', 'B', 0.95), edge('e-bc', 'B', 'C', 0.85), edge('e-cd', 'C', 'D', 0.78), edge('e-de', 'D', 'E', 0.99));

  // ── 2) confidence_min이 BFS 프론티어 쿼리에 실제 적용되는지: I->J 단일
  //    엣지, confidence=0.5(기본 임계값 아래). 다른 경로 없음.
  nodes.push(node('I'), node('J'));
  edges.push(edge('e-ij', 'I', 'J', 0.5));

  // ── 3) hop cap: K0->K1->...->K12 (총 12홉 체인), 전부 고신뢰도.
  for (let i = 0; i <= 12; i++) nodes.push(node(`K${i}`));
  for (let i = 0; i < 12; i++) edges.push(edge(`e-k${i}`, `K${i}`, `K${i + 1}`, 0.9));

  // ── 4) edgeTypes 필터: X->Y(IMPORTS, 0.9)만 있고 CALLS 경로 없음.
  nodes.push(node('X'), node('Y'));
  edges.push(edge('e-xy', 'X', 'Y', 0.9, { type: 'IMPORTS' }));

  // ── 5) 완전히 분리된 컴포넌트: Z1 -> Z2, W1 -> W2(서로 연결 없음).
  nodes.push(node('Z1'), node('Z2'), node('W1'), node('W2'));
  edges.push(edge('e-z', 'Z1', 'Z2', 0.9));

  // ── 6) 리뷰 지적 3(비최단 경로) 재현용: QS에서 QT까지 두 경로가 있다 —
  //    QS->QM->QP2->QY->QT(4홉, 최단)와 QS->QM->QP1->QX->QZ->QT(5홉, 더 김).
  //    (노드 id는 위 4)/5)의 X/Y/Z1/Z2와 겹치지 않도록 Q 접두사를 붙였다.)
  //    핵심은 라운드 타이밍이다: backward가 라운드1에서 QT의 바로 이웃을
  //    한꺼번에 조회하면서 QY(depth1)와 QZ(depth1)를 "같은 라운드"에 함께
  //    발견하고, 라운드3에서 QZ의 이웃 QX를 depth2로 추가 발견한다. 그
  //    뒤 라운드4(forward, depth3)에서 QP1->QX와 QP2->QY가 **같은 라운드**에
  //    함께 발견되는데, QX는 이미 backward에 depth2로 있어
  //    combinedDepth=3+2=5, QY는 depth1로 있어 combinedDepth=3+1=4다.
  //    edge id를 'a-...'(QP1->QX)가 'z-...'(QP2->QY)보다 사전식으로 먼저
  //    오도록 골라, "라운드 안에서 첫 교차점을 즉시 확정"하던 예전
  //    로직이었다면 반드시 틀린(5홉) 답을 냈을 순서로 고정한다 — 지금
  //    구현은 라운드 전체의 후보를 모아 최솟값을 고르므로 순서와
  //    무관하게 4홉(QY 경유)을 반환해야 한다.
  nodes.push(node('QS'), node('QM'), node('QP1'), node('QP2'), node('QX'), node('QY'), node('QZ'), node('QT'));
  edges.push(
    edge('e0-qs-qm', 'QS', 'QM', 0.9),
    edge('e1-qm-qp1', 'QM', 'QP1', 0.9),
    edge('e2-qm-qp2', 'QM', 'QP2', 0.9),
    edge('a-qp1-qx', 'QP1', 'QX', 0.9), // 사전식으로 z-qp2-qy보다 먼저 — "먼저 발견"되지만 더 긴 경로
    edge('z-qp2-qy', 'QP2', 'QY', 0.9),
    edge('e3-qx-qz', 'QX', 'QZ', 0.9),
    edge('e4-qy-qt', 'QY', 'QT', 0.9),
    edge('e5-qz-qt', 'QZ', 'QT', 0.9),
  );

  await nodeRepo.insert(nodes);
  await edgeRepo.insert(edges);

  // ── 7) 리뷰 지적(2라운드): 후보 탐지가 SQL LIMIT에 걸리지 않는다는
  //    불변식 직접 증명. QP1에 60,000개(MAX_CALL_PATH_VISITED보다 많음)의
  //    무관한 더미 outgoing edge를 추가한다 — 전부 backwardVisited에
  //    없는 목적지(hc-leafN)라 후보가 아니다. 이전(1라운드) 수정처럼
  //    "새 노드 발견"과 "후보 탐지"가 같은 SQL LIMIT을 공유했다면, 이
  //    더미 fan-out이 QP1->QX(진짜 후보, 더 긴 경로)조차 밀어낼 수 있었다.
  //    지금 구현은 후보 탐지 쿼리 자체가 `dst_id IN otherVisited키`로
  //    걸려 있어 더미 6만 개는 애초에 조회 대상도 아니다(WHERE 절 자체가
  //    걸러냄, LIMIT으로 잘라내는 게 아님) — 그래서 아래 "리뷰 지적" 테스트가
  //    이 더미들이 있어도 여전히 4홉(QY 경유)을 빠르게 반환해야 한다.
  const DUMMY_HUB_OUT_DEGREE = MAX_CALL_PATH_VISITED + 10_000;
  const DUMMY_BATCH = 500;
  const dummyEdges = [];
  for (let i = 0; i < DUMMY_HUB_OUT_DEGREE; i++) {
    dummyEdges.push({
      id: `hc-e${i}`, workspace_id: WORKSPACE_ID, graph_id: GRAPH_ID,
      src_id: 'QP1', dst_id: `hc-leaf${i}`, type: 'CALLS', layer: 'structural', confidence: 0.9, status: 'active',
    });
  }
  await bulkInsertEdgesRaw(dummyEdges);

  // ── 8) 리뷰 지적(3라운드): OntologyEdge에는 (graph_id, src_id, dst_id[,
  //    type]) 유일성 제약이 없다 — 같은 (src,dst) 쌍 사이에 서로 다른
  //    type/evidence/run의 active edge가 임의 개수 있을 수 있다. RH->RY
  //    사이에 60,000개 이상의 **parallel**(같은 src/dst) edge를 심는다 —
  //    "결과의 서로 다른 discoveredId 수는 otherChunk로 유계"라는 이전
  //    주장은 distinct 값 개수에만 해당했지 반환 row 수에는 해당하지
  //    않았다(진짜 버그). 그중 정확히 1개(id 'rh-ry-best')만 confidence
  //    0.95로 나머지 59,999개(전부 0.76)보다 눈에 띄게 높게 잡아, 후보
  //    쿼리가 discoveredId(RY)당 대표 edge를 진짜로 "confidence 최댓값"
  //    하나만 고르는지(단순히 아무 거나 하나 고르는 게 아니라) 직접
  //    증명한다 — path_confidence로 어느 쪽이 골렸는지 뚜렷이 구분된다.
  await nodeRepo.insert([node('RS'), node('RH'), node('RY'), node('RT')]);
  await edgeRepo.insert([edge('e-rs-rh', 'RS', 'RH', 0.99), edge('e-ry-rt', 'RY', 'RT', 0.99)]);
  const parallelEdges = [{ id: 'rh-ry-best', workspace_id: WORKSPACE_ID, graph_id: GRAPH_ID, src_id: 'RH', dst_id: 'RY', type: 'CALLS', layer: 'structural', confidence: 0.95, status: 'active' }];
  const PARALLEL_EDGE_COUNT = MAX_CALL_PATH_VISITED + 10_000;
  for (let i = 0; i < PARALLEL_EDGE_COUNT; i++) {
    parallelEdges.push({ id: `rh-ry-dup${i}`, workspace_id: WORKSPACE_ID, graph_id: GRAPH_ID, src_id: 'RH', dst_id: 'RY', type: 'CALLS', layer: 'structural', confidence: 0.76, status: 'active' });
  }
  await bulkInsertEdgesRaw(parallelEdges);
});

after(async () => {
  if (AppOntologyDataSource?.isInitialized) {
    await flushOntologySqljs(AppOntologyDataSource, true);
    await AppOntologyDataSource.destroy();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('graphCallPath — 완료조건 3: path_confidence는 min-along-path, 곱셈 아님', () => {
  it('A->B->C->D->E 경로의 path_confidence는 min(0.78)이지 product(~0.622)가 아니다', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'A', toId: 'E' });
    assert.equal(result.found, true);
    assert.equal(result.hops, 4);
    assert.equal(result.pathConfidence, 0.78);
    assert.equal(result.path.map((s) => s.srcId).join('->'), 'A->B->C->D');
    assert.equal(result.path.map((s) => s.dstId).join('->'), 'B->C->D->E');
  });

  it('fromId===toId면 빈 경로에 pathConfidence=1을 반환한다', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'A', toId: 'A' });
    // ticket d35b7b7d — confidenceMin(실제 적용된 값)이 응답 필드로 추가됨.
    assert.deepEqual(result, {
      found: true, path: [], pathConfidence: 1, hops: 0, nodesVisited: 1, truncated: false,
      confidenceMin: 0.75, durationMs: result.durationMs,
    });
  });
});

describe('graphCallPath — 리뷰 지적(1라운드): 같은 라운드에 여러 교차 후보가 있으면 최단(combinedDepth 최소)을 고른다', () => {
  it('QS->QT는 더 긴 경로(QP1/QX/QZ, 5홉)가 먼저 발견돼도 진짜 최단(QP2/QY, 4홉)을 반환한다', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'QS', toId: 'QT' });
    assert.equal(result.found, true);
    assert.equal(result.hops, 4);
    assert.equal(result.path.map((s) => s.srcId).join('->'), 'QS->QM->QP2->QY');
    assert.equal(result.path.map((s) => s.dstId).join('->'), 'QM->QP2->QY->QT');
    assert.ok(!result.path.some((s) => s.srcId === 'QP1' || s.srcId === 'QX' || s.srcId === 'QZ'), '더 긴 QP1/QX/QZ 경유 경로가 섞이면 안 된다');
  });
});

describe('graphCallPath — 리뷰 지적(2라운드): 후보 탐지는 SQL LIMIT의 영향을 받지 않는다', () => {
  it('QP1이 QT를 향하지 않는 60,000개 이상의 무관한 엣지를 가져도 여전히 4홉(QY 경유)을 빠르게 찾는다', async () => {
    // fixture 7)에서 QP1에 MAX_CALL_PATH_VISITED+10,000개의 더미 엣지를
    // 심어뒀다 — 1라운드 수정처럼 "새 노드 발견"과 "후보 탐지"가 같은
    // SQL LIMIT을 공유했다면, 사전식으로 더미들 사이 어딘가에 낄 수 있는
    // QP1->QX(진짜 후보)가 잘려나가 없어질 수 있었다. 이번 결과는 여전히
    // 1라운드 수정 때와 정확히 같아야 하고(경로·hops 동일), 무엇보다
    // nodesVisited가 더미 6만 개에 끌려 커지지 않아야 한다(후보 탐지가
    // otherVisited 크기로만 유계라는 증거) — 그리고 무엇보다 빨라야 한다.
    const t0 = Date.now();
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'QS', toId: 'QT' });
    const wallMs = Date.now() - t0;
    assert.equal(result.found, true);
    assert.equal(result.hops, 4);
    assert.equal(result.path.map((s) => s.srcId).join('->'), 'QS->QM->QP2->QY');
    assert.ok(!result.path.some((s) => s.srcId === 'QP1' || s.srcId === 'QX' || s.srcId === 'QZ'), '더 긴 QP1/QX/QZ 경유 경로가 섞이면 안 된다');
    assert.ok(result.nodesVisited < 100, `방문 노드 수가 더미 fan-out(60,000+)에 끌려 커지면 안 된다: ${result.nodesVisited}`);
    assert.ok(wallMs < 10_000, `QP1의 거대한 무관 fan-out이 후보 탐지를 느리게 만들면 안 된다: ${wallMs}ms`);
  });
});

describe('graphCallPath — 리뷰 지적(3라운드): parallel edge가 있어도 후보 탐지는 discoveredId당 대표 edge 1개로 유계다', () => {
  it('RH->RY 사이 60,000개 이상의 parallel edge 중 confidence 최댓값(0.95) 하나만 대표로 골라 RS->RH->RY->RT(3홉)을 반환한다', async () => {
    // fixture 8) — RH->RY 사이에 60,000개+ parallel edge(전부 같은
    // src/dst)가 있고, 그중 confidence가 뚜렷이 높은 것(0.95, id
    // 'rh-ry-best')은 단 하나뿐이며 나머지(59,999개, 0.76)는 명백히
    // 낮다. path_confidence는 min-along-path이므로:
    //   대표로 'rh-ry-best'(0.95)가 골렸다면 -> min(0.99, 0.95, 0.99) = 0.95
    //   아무 duplicate('...-dup*', 0.76)나 골렸다면          -> min(0.99, 0.76, 0.99) = 0.76
    // 두 값이 뚜렷이 달라, 어떤 대표가 실제로 골렸는지 이 단정 하나로
    // 정확히 구분된다 — "느리지 않다"만으로는 못 잡는, 결과의 정확성
    // 자체에 대한 단정이다.
    const t0 = Date.now();
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'RS', toId: 'RT' });
    const wallMs = Date.now() - t0;
    assert.equal(result.found, true);
    assert.equal(result.hops, 3);
    assert.equal(result.path.map((s) => s.srcId).join('->'), 'RS->RH->RY');
    assert.equal(result.pathConfidence, 0.95, 'discoveredId(RY)당 대표 edge로 confidence 최댓값이 골려야 한다 — duplicate 중 아무거나 골리면 0.76이 나온다');
    assert.ok(result.nodesVisited < 100, `방문 노드 수가 parallel edge 6만 개에 끌려 커지면 안 된다: ${result.nodesVisited}`);
    assert.ok(wallMs < 10_000, `RH->RY 사이 거대한 parallel edge가 후보 탐지를 느리게 만들면 안 된다: ${wallMs}ms`);
  });
});

describe('graphCallPath — 완료조건 2: confidence_min이 BFS 프론티어 쿼리에 실제 적용된다', () => {
  it('기본 confidence_min(0.75) 아래 엣지뿐이면 경로를 찾지 못한다', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'I', toId: 'J' });
    assert.equal(result.found, false);
    assert.equal(result.pathConfidence, null);
  });

  it('confidenceMin을 낮추면 같은 엣지로 경로를 찾는다', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'I', toId: 'J', confidenceMin: 0.3 });
    assert.equal(result.found, true);
    assert.equal(result.pathConfidence, 0.5);
  });
});

describe('graphCallPath — hop cap은 "총 경로 길이" 상한이다', () => {
  it('정확히 상한(10)만큼 떨어진 K0->K10은 찾는다', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'K0', toId: 'K10' });
    assert.equal(result.found, true);
    assert.equal(result.hops, 10);
  });

  it('상한을 넘는 K0->K12(총 12홉)는 못 찾는다 — 편도 10홉씩 허용되는 버그였다면 이 케이스가 잘못 발견됐을 것', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'K0', toId: 'K12' });
    assert.equal(result.found, false);
  });

  it('maxHops를 MAX_CALL_PATH_HOPS보다 크게 요청해도 하드 상한으로 클램프된다', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'K0', toId: 'K12', maxHops: 999 });
    assert.equal(result.found, false, `MAX_CALL_PATH_HOPS=${MAX_CALL_PATH_HOPS}를 넘는 12홉 경로는 여전히 못 찾아야 한다`);
  });
});

describe('graphCallPath — edgeTypes 필터와 미연결 컴포넌트', () => {
  it('edgeTypes=["CALLS"]면 IMPORTS 전용 경로(X->Y)를 찾지 못한다', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'X', toId: 'Y', edgeTypes: ['CALLS'] });
    assert.equal(result.found, false);
  });

  it('edgeTypes 필터 없이는 IMPORTS 경로도 찾는다', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'X', toId: 'Y' });
    assert.equal(result.found, true);
    assert.equal(result.path[0].type, 'IMPORTS');
  });

  it('완전히 분리된 컴포넌트 사이는 경로가 없다', async () => {
    const result = await graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'Z1', toId: 'W1' });
    assert.equal(result.found, false);
    assert.equal(result.pathConfidence, null);
  });
});

describe('입력 검증', () => {
  it('graphId/fromId/toId 누락은 즉시 throw한다', async () => {
    await assert.rejects(() => graphCallPath(AppOntologyDataSource, { graphId: '', fromId: 'A', toId: 'B' }));
    await assert.rejects(() => graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: '', toId: 'B' }));
    await assert.rejects(() => graphCallPath(AppOntologyDataSource, { graphId: GRAPH_ID, fromId: 'A', toId: '' }));
  });
});
