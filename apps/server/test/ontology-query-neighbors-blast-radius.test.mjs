// 회귀 테스트 — ticket 20b07fc8 "[Ontology Graph 5/7] 질의 API".
//
// graphNeighbors(정방향)/graphBlastRadius(역방향, "누가 이 노드에
// 의존하는가")의 bounded 재귀 CTE를 실제 sql.js DataSource에 대해
// 검증한다: depth cap, path-cycle-guard, confidence_min 필터(완료조건 2
// 중 CTE 쪽), edge_types 필터, row cap + truncated 플래그, 그리고
// status='active'가 아닌 엣지/노드는 절대 순회·반환되지 않는다는 것(보드
// 러슨 — 그래프 후처리는 active 행만 다뤄야 한다)까지.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요) — ontology 계열
// 테스트 전체의 관례. 격리된 SQLJS_ONTOLOGY_DB_PATH 임시 파일을 써서
// 공유 dev database/ontology.db는 절대 건드리지 않는다.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-query-reach-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { graphNeighbors, graphBlastRadius } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/ontology/query/graph-query.js')
);
const { AppOntologyDataSource, initOntologyDb, flushOntologySqljs } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));
const { OntologyEdge } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEdge.js'));

const GRAPH_ID = 'reach-graph';
const WORKSPACE_ID = 'reach-ws';

let nodeRepo, edgeRepo;

function node(id, overrides = {}) {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    graph_id: GRAPH_ID,
    symbol_id: `sym:${id}`,
    type: 'Callable',
    layer: 'structural',
    name: id,
    confidence: 1,
    status: 'active',
    ...overrides,
  };
}

function edge(id, srcId, dstId, overrides = {}) {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    graph_id: GRAPH_ID,
    src_id: srcId,
    dst_id: dstId,
    type: 'CALLS',
    layer: 'structural',
    confidence: 0.9,
    status: 'active',
    ...overrides,
  };
}

before(async () => {
  await initOntologyDb();
  nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
  edgeRepo = AppOntologyDataSource.getRepository(OntologyEdge);

  // A -> B -> C -> D -> A(cycle) : 전부 CALLS, confidence 0.9
  // A -> E(0.5, CALLS)          : 기본 confidence_min(0.75) 아래라 배제되어야 함
  // E -> F(0.9, CALLS)
  // B -> F(0.9, IMPORTS)        : 다른 edge type
  // B -> G(0.9, CALLS)          : G는 quarantined 노드 -> 결과에서 빠져야 함
  // C -> H(0.9, CALLS)          : 엣지 자체가 removed -> 아예 순회되면 안 됨
  await nodeRepo.insert([
    node('A'), node('B'), node('C'), node('D'), node('E'), node('F'),
    node('G', { status: 'quarantined' }),
    node('H'),
  ]);
  await edgeRepo.insert([
    edge('e-ab', 'A', 'B'),
    edge('e-bc', 'B', 'C'),
    edge('e-cd', 'C', 'D'),
    edge('e-da', 'D', 'A'),
    edge('e-ae', 'A', 'E', { confidence: 0.5 }),
    edge('e-ef', 'E', 'F'),
    edge('e-bf', 'B', 'F', { type: 'IMPORTS' }),
    edge('e-bg', 'B', 'G'),
    edge('e-ch', 'C', 'H', { status: 'removed' }),
  ]);
});

after(async () => {
  if (AppOntologyDataSource?.isInitialized) {
    await flushOntologySqljs(AppOntologyDataSource, true);
    await AppOntologyDataSource.destroy();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('graphNeighbors — 기본 confidence_min(0.75)과 depth cap', () => {
  it('A에서 정방향으로 depth<=4까지, confidence>=0.75인 엣지만 따라간다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'A' });
    const byId = Object.fromEntries(result.rows.map((r) => [r.node.id, r.depth]));
    assert.deepEqual(byId, { B: 1, C: 2, F: 2, D: 3 }, 'E(0.5)와 A 자신은 빠지고, D->A 사이클은 재진입 없이 depth 3에서 멈춰야 한다');
    assert.equal(result.truncated, false);
  });

  it('quarantined 노드(G)는 confidence 0.9 엣지로 도달 가능해도 결과에서 빠진다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'A' });
    assert.ok(!result.rows.some((r) => r.node.id === 'G'), 'active가 아닌 노드는 hydration 단계에서 걸러져야 한다');
  });

  it('removed 엣지(C->H)는 순회 자체가 되지 않는다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'A' });
    assert.ok(!result.rows.some((r) => r.node.id === 'H'));
  });

  it('confidenceMin을 낮추면 E/F 경로가 살아난다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'A', confidenceMin: 0.4 });
    const byId = Object.fromEntries(result.rows.map((r) => [r.node.id, r.depth]));
    assert.equal(byId.E, 1);
    assert.equal(byId.F, 2); // E->F(depth2)와 B->F(depth2) 중 더 작은 depth로 수렴(둘 다 2라 동일)
  });

  it('maxDepth=1이면 B만 보인다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'A', maxDepth: 1 });
    assert.deepEqual(result.rows.map((r) => r.node.id).sort(), ['B']);
  });

  it('edgeTypes=["CALLS"]면 IMPORTS로만 닿는 F는 배제된다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'A', edgeTypes: ['CALLS'] });
    assert.deepEqual(result.rows.map((r) => r.node.id).sort(), ['B', 'C', 'D']);
  });

  it('rowCap이 실제 도달 가능 수보다 작으면 잘리고 truncated=true다(SQLite 공식 문서의 unconditional LIMIT 권고)', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'A', rowCap: 1 });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].node.id, 'B'); // depth 오름차순이므로 가장 가까운 노드
    assert.equal(result.truncated, true);
  });

  it('rowCap이 충분히 크면 truncated=false다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'A', rowCap: 100 });
    assert.equal(result.truncated, false);
  });
});

describe('graphBlastRadius — 역방향(reverse-reachability): "누가 이 노드에 의존하는가"', () => {
  it('D의 blast radius는 D를 향해 들어오는 체인을 역으로 따라간다', async () => {
    const result = await graphBlastRadius(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'D' });
    const byId = Object.fromEntries(result.rows.map((r) => [r.node.id, r.depth]));
    assert.deepEqual(byId, { C: 1, B: 2, A: 3 });
  });
});

describe('입력 검증', () => {
  it('graphId/nodeId 누락은 즉시 throw한다', async () => {
    await assert.rejects(() => graphNeighbors(AppOntologyDataSource, { graphId: '', nodeId: 'A' }));
    await assert.rejects(() => graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: '' }));
  });

  it('confidenceMin이 [0,1] 밖이면 throw한다', async () => {
    await assert.rejects(() => graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'A', confidenceMin: 1.5 }));
  });

  it('maxDepth는 MAX_ALLOWED_DEPTH(6)로 클램프되어 예외 없이 동작한다', async () => {
    const result = await graphNeighbors(AppOntologyDataSource, { graphId: GRAPH_ID, nodeId: 'A', maxDepth: 999 });
    assert.equal(result.maxDepth, 6);
  });
});
