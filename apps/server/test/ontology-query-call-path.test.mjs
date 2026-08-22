// 회귀 테스트 — ticket 20b07fc8 "[Ontology Graph 5/7] 질의 API".
//
// graphCallPath(application-orchestrated bidirectional level-BFS)를
// 검증한다: 완료조건 3(path_confidence는 min-along-path, 곱셈 금지),
// 완료조건 2 중 BFS 쪽(confidence_min이 프론티어 쿼리에 실제 적용),
// 그리고 hop cap이 "총 경로 길이" 상한으로 정확히 작동함(편도 각각
// maxHops가 아니라 왕복 합쳐 maxHops라는 것 — 구현 중 발견한 함정,
// graph-query.ts의 loop 코멘트 참고).
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

const { graphCallPath, MAX_CALL_PATH_HOPS } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/query/graph-query.js'));
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

  await nodeRepo.insert(nodes);
  await edgeRepo.insert(edges);
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
    assert.deepEqual(result, { found: true, path: [], pathConfidence: 1, hops: 0, nodesVisited: 1, truncated: false, durationMs: result.durationMs });
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
