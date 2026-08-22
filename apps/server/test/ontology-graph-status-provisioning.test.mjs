// 회귀 테스트 — ticket d35b7b7d "[Ontology Graph 6/7] MCP 툴 wave 1".
//
// 완료조건 2: "graph_status가 미인덱싱 repo+folder 최초 참조 시 실제로
// 그래프를 프로비저닝하는 end-to-end 테스트" — graph_status MCP 툴
// 핸들러를 실제로 호출해 OntologyGraph 행이 자동 생성되는지, 같은
// (resource_id, folder_path)를 다시 불러도 중복 생성되지 않는지(A1의
// "graph_id를 얻을 방법이 없어 막히는 상황" 해소가 idempotent해야 진짜
// 해소다), runInitialBuild() 이후 status가 building->ready로 바뀌는지를
// 검증한다. OntologyExtractionService/OntologyResolverService는 실제
// git-repo-cache/worker pool 없이 fake로 대체 — 이 테스트의 관심사는
// "provisioning 배선이 옳은가"이지 추출/해소 알고리즘 자체의 정확성이
// 아니다(그건 ontology-extraction-*/ontology-resolver-* 스위트가 이미
// 커버).
//
// 완료조건 3(잔여): confidence_min이 find_symbol/neighbors/blast_radius/
// call_path/module_summary 다섯 개 툴 전체에서 실제로 필터링에 반영되는지
// 툴 레이어(내부 query 함수가 아니라 MCP 핸들러)에서 확인한다 —
// ontology-query-*.test.mjs는 이미 query 함수 자체를 검증했으므로, 여기는
// "MCP 스키마->핸들러->서비스 배선"이 그 값을 실제로 전달하는지만 본다.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-graph-status-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { AppOntologyDataSource, initOntologyDb } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { OntologyGraph } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyGraph.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));
const { OntologyEdge } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEdge.js'));
const { OntologyLifecycleService } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/ontology-lifecycle.service.js'));
const { OntologyQueryService } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/ontology-query.service.js'));
const { registerOntologyTools } = await import('file://' + path.join(DIST_ROOT, 'modules/mcp/tools/ontology-tools.js'));

const WORKSPACE_ID = 'gs-ws';
const RESOURCE_ID = 'gs-resource-1';
const FOLDER_PATH = '';

function node(id, graphId, overrides = {}) {
  return {
    id, workspace_id: WORKSPACE_ID, graph_id: graphId, symbol_id: `sym:${id}`,
    type: 'Callable', layer: 'structural', name: id, path: '', confidence: 1, status: 'active',
    ...overrides,
  };
}
function edge(id, graphId, srcId, dstId, overrides = {}) {
  return {
    id, workspace_id: WORKSPACE_ID, graph_id: graphId, src_id: srcId, dst_id: dstId,
    type: 'CALLS', layer: 'structural', confidence: 0.9, status: 'active',
    ...overrides,
  };
}

let graphRepo, nodeRepo, edgeRepo;
let lifecycleService;
let tools;
let logs;

before(async () => {
  await initOntologyDb();
  graphRepo = AppOntologyDataSource.getRepository(OntologyGraph);
  nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
  edgeRepo = AppOntologyDataSource.getRepository(OntologyEdge);

  const fakeExtraction = {
    extractRepo: async () => ({
      commit: 'deadbeef',
      filesDiscovered: 3, filesSkippedByExtension: 0, filesSkippedTooLargeOrBinary: 0,
      filesFailedExtraction: 0, extractionFailures: [], treeWalkMs: 1, fetchMs: 1, extractMs: 1,
      totalLines: 100, endToEndLinesPerSecond: 100,
      filesProcessed: 3, nodesInserted: 2, edgesInserted: 1, containsEdges: 0, declaresEdges: 0,
      decoratesEdges: 0, decoratesUnresolved: 0, parseErrorFiles: 0, skippedFiles: 0, durationMs: 1,
    }),
  };
  const fakeResolver = {
    resolveGraph: async () => ({
      filesProcessed: 3, edgesInserted: 1, importsEdges: 0, refEdgesByType: {},
      heritageEdges: 0, overridesEdges: 0, dynamicCappedEdges: 0, reverseIndexRows: 0,
      unresolvedImports: 0, unresolvedRefs: 0,
    }),
  };
  const noopLogger = { info() {}, warn() {}, error() {} };
  lifecycleService = new OntologyLifecycleService(AppOntologyDataSource, fakeExtraction, fakeResolver, noopLogger);
  const queryService = new OntologyQueryService(AppOntologyDataSource);

  logs = [];
  const capturingLogger = {
    info: (cat, msg, meta) => { logs.push({ cat, msg, meta }); },
    warn() {}, error() {},
  };

  tools = {};
  const fakeServer = { tool(name, description, schema, handler) { tools[name] = { handler }; } };
  registerOntologyTools(fakeServer, {
    logger: capturingLogger,
    ontologyLifecycleService: lifecycleService,
    ontologyQueryService: queryService,
  });
});

after(async () => {
  if (AppOntologyDataSource.isInitialized) await AppOntologyDataSource.destroy();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function callTool(name, args) {
  const res = await tools[name].handler(args, {});
  assert.ok(!res.isError, `${name} returned an error: ${res.isError ? res.content[0].text : ''}`);
  return JSON.parse(res.content[0].text);
}

describe('graph_status — 완료조건 2: 미인덱싱 repo+folder 최초 참조 시 실제 프로비저닝', () => {
  it('처음 보는 (resource_id, folder_path)는 OntologyGraph 행을 자동 생성하고 status=building을 반환한다', async () => {
    const body = await callTool('graph_status', { workspace_id: WORKSPACE_ID, resource_id: RESOURCE_ID, folder_path: FOLDER_PATH });
    assert.equal(body.status, 'building');
    assert.ok(body.graph_id, 'graph_id must be present so the caller is never stuck without one (A1)');
    assert.equal(body.indexed_at, null);
    assert.equal(body.commit, '');

    const rows = await graphRepo.find({ where: { workspace_id: WORKSPACE_ID, resource_id: RESOURCE_ID, folder_path: FOLDER_PATH } });
    assert.equal(rows.length, 1, 'exactly one OntologyGraph row must exist after the first reference');
    assert.equal(rows[0].id, body.graph_id);
  });

  it('같은 (resource_id, folder_path)를 다시 불러도 새 행을 만들지 않는다(idempotent provisioning)', async () => {
    const first = await callTool('graph_status', { workspace_id: WORKSPACE_ID, resource_id: RESOURCE_ID, folder_path: FOLDER_PATH });
    const second = await callTool('graph_status', { workspace_id: WORKSPACE_ID, resource_id: RESOURCE_ID, folder_path: FOLDER_PATH });
    assert.equal(first.graph_id, second.graph_id);

    const rows = await graphRepo.find({ where: { workspace_id: WORKSPACE_ID, resource_id: RESOURCE_ID, folder_path: FOLDER_PATH } });
    assert.equal(rows.length, 1);
  });

  it('runInitialBuild() 완료 후 status가 ready로 바뀌고 indexed_at/commit/progress가 채워진다', async () => {
    const before1 = await callTool('graph_status', { workspace_id: WORKSPACE_ID, resource_id: RESOURCE_ID, folder_path: FOLDER_PATH });
    const graph = await graphRepo.findOne({ where: { id: before1.graph_id } });

    // fire-and-forget(kickOffInitialBuild)을 기다리지 않고 실제 구현
    // (runInitialBuild)을 직접 호출한다 — ontology-lifecycle.service.ts
    // 자신의 doc comment가 명시하는 테스트 방식.
    await lifecycleService.runInitialBuild(graph);

    const afterBuild = await callTool('graph_status', { workspace_id: WORKSPACE_ID, resource_id: RESOURCE_ID, folder_path: FOLDER_PATH });
    assert.equal(afterBuild.status, 'ready');
    assert.equal(afterBuild.commit, 'deadbeef');
    assert.ok(afterBuild.indexed_at, 'indexed_at must be set once the build completes');
    assert.equal(afterBuild.progress.nodes_inserted, 2);
    assert.equal(afterBuild.progress.edges_inserted, 2); // extractResult.edgesInserted(1) + resolveResult.edgesInserted(1)
  });

  it('graph_status 호출은 Done-when 텔레메트리(에이전트/티켓별 호출 로그)로 기록된다', async () => {
    logs.length = 0;
    await callTool('graph_status', { workspace_id: WORKSPACE_ID, resource_id: RESOURCE_ID, folder_path: FOLDER_PATH });
    const callLog = logs.find((l) => l.cat === 'Ontology' && l.meta?.tool === 'graph_status');
    assert.ok(callLog, 'every graph_ tool call must be logged for the call-frequency Done-when');
  });

  it('graph_lifecycle 서비스가 없는(standalone) 컨텍스트에서는 명시적 에러로 성실히 실패한다', async () => {
    const degraded = {};
    const fakeServer = { tool(name, description, schema, handler) { degraded[name] = handler; } };
    registerOntologyTools(fakeServer, { logger: { info() {}, warn() {}, error() {} } });
    const res = await degraded.graph_status({ workspace_id: WORKSPACE_ID, resource_id: 'other', folder_path: '' }, {});
    assert.ok(res.isError);
    assert.match(res.content[0].text, /standalone/i);
  });
});

describe('confidence_min — 완료조건 3: wave1 다섯 개 조회/순회 툴에 실제로 적용된다(MCP 핸들러 레이어)', () => {
  const CONF_GRAPH_ID = 'gs-conf-graph';

  before(async () => {
    // resolveGraph()는 graph_id를 캐릭터 그대로 신뢰하지 않고 실제
    // OntologyGraph 행 + workspace_id 일치를 확인한다(다른 workspace 소유
    // 그래프는 not_found로 취급 — 존재 여부를 흘리지 않는다, tool-authz-gate.ts
    // 코멘트 참고) — 그래서 OntologyNode/Edge뿐 아니라 이 행도 직접 만들어야 한다.
    await graphRepo.insert({ id: CONF_GRAPH_ID, workspace_id: WORKSPACE_ID, resource_id: 'conf-resource', folder_path: '', status: 'ready' });

    // CA는 path='mod' 안, CB는 path='other'(스코프 밖) — graph_module_summary가
    // dependency_count를 "스코프 밖으로 나가는 엣지"로 집계하려면 두 끝이
    // 실제로 서로 다른 스코프에 있어야 한다(path='' 전체-repo 스코프로 하면
    // 둘 다 "안쪽"이라 바깥 의존성 자체가 존재하지 않게 된다).
    await nodeRepo.insert([
      node('CA', CONF_GRAPH_ID, { path: 'mod' }),
      node('CB', CONF_GRAPH_ID, { path: 'other' }),
      node('CLOW', CONF_GRAPH_ID, { name: 'lowConfSymbol', confidence: 0.5 }),
    ]);
    await edgeRepo.insert([
      edge('e-ca-cb', CONF_GRAPH_ID, 'CA', 'CB', { confidence: 0.5 }),
    ]);
  });

  it('graph_neighbors: 기본 confidence_min(0.75) 아래 엣지는 제외되고, confidence_min을 낮추면 포함된다', async () => {
    const withDefault = await callTool('graph_neighbors', { workspace_id: WORKSPACE_ID, graph_id: CONF_GRAPH_ID, node_id: 'CA' });
    assert.equal(withDefault.matches.length, 0);
    assert.equal(withDefault.confidence_min, 0.75);

    const lowered = await callTool('graph_neighbors', { workspace_id: WORKSPACE_ID, graph_id: CONF_GRAPH_ID, node_id: 'CA', confidence_min: 0.4 });
    assert.equal(lowered.matches.length, 1);
    assert.equal(lowered.matches[0].id, 'CB');
  });

  it('graph_blast_radius: 같은 엣지를 역방향에서도 confidence_min으로 필터링한다', async () => {
    const withDefault = await callTool('graph_blast_radius', { workspace_id: WORKSPACE_ID, graph_id: CONF_GRAPH_ID, node_id: 'CB' });
    assert.equal(withDefault.matches.length, 0);

    const lowered = await callTool('graph_blast_radius', { workspace_id: WORKSPACE_ID, graph_id: CONF_GRAPH_ID, node_id: 'CB', confidence_min: 0.4 });
    assert.equal(lowered.matches.length, 1);
    assert.equal(lowered.matches[0].id, 'CA');
  });

  it('graph_call_path: 낮은 confidence 엣지뿐이면 기본값으로는 못 찾고, 낮추면 찾는다 — 응답의 confidence_min도 실제 적용값을 반영', async () => {
    const withDefault = await callTool('graph_call_path', { workspace_id: WORKSPACE_ID, graph_id: CONF_GRAPH_ID, from_id: 'CA', to_id: 'CB' });
    assert.equal(withDefault.found, false);
    assert.equal(withDefault.confidence_min, 0.75);

    const lowered = await callTool('graph_call_path', { workspace_id: WORKSPACE_ID, graph_id: CONF_GRAPH_ID, from_id: 'CA', to_id: 'CB', confidence_min: 0.4 });
    assert.equal(lowered.found, true);
    assert.equal(lowered.confidence_min, 0.4);
    // path:line 그라운딩(DESIGN.md 축 6 mandatory-bound) — src/dst가 하이드레이트된 심볼 참조를 담아야 한다.
    assert.equal(lowered.path[0].src.id, 'CA');
    assert.equal(lowered.path[0].dst.id, 'CB');
  });

  it('graph_find_symbol: confidence_min 아래 노드는 매치에서 제외되고, 낮추면 포함된다', async () => {
    const withDefault = await callTool('graph_find_symbol', { workspace_id: WORKSPACE_ID, graph_id: CONF_GRAPH_ID, name: 'lowConfSymbol' });
    assert.equal(withDefault.matches.length, 0);

    const lowered = await callTool('graph_find_symbol', { workspace_id: WORKSPACE_ID, graph_id: CONF_GRAPH_ID, name: 'lowConfSymbol', confidence_min: 0.4 });
    assert.equal(lowered.matches.length, 1);
    assert.equal(lowered.unique, true);
    assert.ok(lowered.detail, 'a unique match must include detail');
    assert.ok(Array.isArray(lowered.suggested_next_calls) && lowered.suggested_next_calls.length > 0);
  });

  it('graph_module_summary: confidence_min이 dependency/dependent 집계에 적용되고 응답에 반영된다', async () => {
    const withDefault = await callTool('graph_module_summary', { workspace_id: WORKSPACE_ID, graph_id: CONF_GRAPH_ID, path: 'mod' });
    assert.equal(withDefault.symbol_count, 1); // path='mod' 스코프 안에는 CA 하나뿐(CB는 'other', CLOW는 '')
    assert.equal(withDefault.dependency_count, 0); // CA->CB 엣지(0.5)가 기본 floor 아래라 집계에서 빠짐
    assert.equal(withDefault.confidence_min, 0.75);

    const lowered = await callTool('graph_module_summary', { workspace_id: WORKSPACE_ID, graph_id: CONF_GRAPH_ID, path: 'mod', confidence_min: 0.4 });
    assert.equal(lowered.dependency_count, 1); // CB가 스코프 밖 의존 대상으로 집계됨
  });
});
