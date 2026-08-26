// 회귀 테스트 — ticket d22b83b4 "[Ontology Graph 7/7] Knowledge UI 셸".
//
// 완료조건 1/2: 새 REST 컨트롤러(ontology.controller.ts)가 graph_status와
// 같은 provisioning helper(OntologyLifecycleService.resolveOrProvision)를
// 호출해 building/ready 상태를 반환하고, 신선도(behind/ahead vs HEAD) +
// dirty_ratio를 같은 응답에 얹는지 검증한다.
//
// 이 스위트는 두 계층을 나눠 검증한다:
//  (1) OntologyLifecycleService.computeDirtyRatio() — 실제 DB(격리된
//      sql.js 온톨로지 DataSource)에 OntologyEdge 행을 직접 심어 비율
//      계산을 검증. 서비스 레이어 로직이라 컨트롤러 없이도 완전히 검증
//      가능.
//  (2) OntologyController — 이 저장소의 기존 REST 컨트롤러들(예:
//      resources.controller.ts)과 마찬가지로 HTTP 계층 자체(Express
//      app.listen 등)를 테스트하는 선례가 없다 — 컨트롤러 메서드를 직접
//      호출하고 Express Response를 흉내내는 최소 fake만 쓴다(MCP 툴
//      테스트가 handler를 직접 호출하는 것과 같은 자세). git-repo-cache의
//      ensureRepoCache/countBehindAhead 자체는 free function이라 이
//      컨트롤러 안에서 스텁으로 교체할 DI 지점이 없으므로, "커밋이
//      비어있어 git 접근을 아예 시도하지 않는" 경로와 "리소스를 못 찾아
//      freshness_error로 흡수하는" 경로는 실제 Resource/Credential repo로
//      검증하고, "정상적으로 behind/ahead를 계산하는" 경로(인자 순서 —
//      baseRef=HEAD, headRef=graph.commit이어야 behind가 "그래프가 HEAD보다
//      몇 커밋 뒤처졌는가"라는 의미가 된다)는 별도로
//      countBehindAhead 자체를 스크래치 git repo에 대해 직접 호출하는
//      단위 테스트로 커버한다(ontology-git-diff-rename-detection.test.mjs와
//      같은 자세) — ensureRepoCache는 http(s) URL만 허용해(SSH 전용 URL과
//      같은 이유로 file:// 로컬 clone이 막힘) 실제 네트워크 없이는 그
//      합성 경로 자체를 e2e로 돌릴 방법이 이 저장소 어디에도 없다
//      (resources.controller.ts의 git-read 엔드포인트도 마찬가지로
//      미검증 상태 — 같은 한계를 그대로 인정한다).
//
// 컴파일된 dist/ 대상(server 계열 관례). 격리된 SQLJS_DB_PATH/
// SQLJS_ONTOLOGY_DB_PATH 임시 파일을 써서 공유 dev database/*.db는 절대
// 건드리지 않는다.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-graph-freshness-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { AppDataSource, AppOntologyDataSource, initDb, flushOntologySqljs } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { Resource } = await import('file://' + path.join(DIST_ROOT, 'entities/Resource.js'));
const { Credential } = await import('file://' + path.join(DIST_ROOT, 'entities/Credential.js'));
const { OntologyGraph } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyGraph.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));
const { OntologyEdge } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEdge.js'));
const { OntologyReverseEdgeIndex } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyReverseEdgeIndex.js'));
const { OntologyLifecycleService, GraphRefResolutionError } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/ontology-lifecycle.service.js'));
const { OntologyController } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/ontology.controller.js'));
const { countBehindAhead } = await import('file://' + path.join(DIST_ROOT, 'modules/mcp/shared/git-repo-cache.js'));

const WORKSPACE_ID = 'gf-ws';
const OTHER_WORKSPACE_ID = 'gf-ws-other';
const RESOURCE_ID = 'gf-resource-missing'; // 의도적으로 Resource 테이블에 행을 만들지 않음(존재하지 않는 리소스 경로 검증용)

function edge(id, graphId, overrides = {}) {
  return {
    id, workspace_id: WORKSPACE_ID, graph_id: graphId, src_id: `${id}-src`, dst_id: `${id}-dst`,
    type: 'CALLS', layer: 'structural', confidence: 0.9, status: 'active',
    ...overrides,
  };
}

function node(id, graphId, symbolId, overrides = {}) {
  return {
    id, workspace_id: WORKSPACE_ID, graph_id: graphId, symbol_id: symbolId,
    type: 'Callable', layer: 'structural', name: symbolId, confidence: 1, status: 'active',
    ...overrides,
  };
}

function fakeRes() {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
}

let graphRepo, nodeRepo, edgeRepo, resourceRepo, credentialRepo;
let lifecycleService, controller, logs;

before(async () => {
  await initDb();
  graphRepo = AppOntologyDataSource.getRepository(OntologyGraph);
  nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
  edgeRepo = AppOntologyDataSource.getRepository(OntologyEdge);
  resourceRepo = AppDataSource.getRepository(Resource);
  credentialRepo = AppDataSource.getRepository(Credential);

  const fakeExtraction = { extractRepo: async () => { throw new Error('not used in this suite'); } };
  const fakeResolver = { resolveGraph: async () => { throw new Error('not used in this suite'); } };
  const noopLogger = { info() {}, warn() {}, error() {} };
  lifecycleService = new OntologyLifecycleService(AppOntologyDataSource, fakeExtraction, fakeResolver, noopLogger);
  // 이 스위트의 프로비저닝 검증은 백그라운드 빌드 자체가 대상이 아니다.
  // sql.js 단일 연결에서 fire-and-forget 트랜잭션이 다음 테스트와 겹치지 않게 한다.
  lifecycleService.kickOffInitialBuild = () => {};

  logs = [];
  const capturingLogger = {
    info: (cat, msg, meta) => { logs.push({ cat, msg, meta }); },
    warn() {}, error() {},
  };
  controller = new OntologyController(resourceRepo, credentialRepo, lifecycleService, capturingLogger, AppDataSource);
});

after(async () => {
  if (AppOntologyDataSource.isInitialized) await AppOntologyDataSource.destroy();
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('OntologyLifecycleService.computeDirtyRatio', () => {
  it('엣지가 하나도 없으면 null(측정 불가 ≠ 0%)', async () => {
    const graph = await graphRepo.save(graphRepo.create({ workspace_id: WORKSPACE_ID, resource_id: 'r-empty', folder_path: '', status: 'ready' }));
    assert.equal(await lifecycleService.computeDirtyRatio(graph.id), null);
  });

  it('전부 active면 dirty_ratio=0', async () => {
    const graph = await graphRepo.save(graphRepo.create({ workspace_id: WORKSPACE_ID, resource_id: 'r-clean', folder_path: '', status: 'ready' }));
    await edgeRepo.save([edge('e1', graph.id), edge('e2', graph.id), edge('e3', graph.id)]);
    assert.equal(await lifecycleService.computeDirtyRatio(graph.id), 0);
  });

  it('active/stale 혼합이면 stale/(active+stale) 비율을 정확히 반환한다', async () => {
    const graph = await graphRepo.save(graphRepo.create({ workspace_id: WORKSPACE_ID, resource_id: 'r-mixed', folder_path: '', status: 'ready' }));
    await edgeRepo.save([
      edge('m1', graph.id, { status: 'active' }),
      edge('m2', graph.id, { status: 'active' }),
      edge('m3', graph.id, { status: 'active' }),
      edge('m4', graph.id, { status: 'stale' }),
    ]);
    assert.equal(await lifecycleService.computeDirtyRatio(graph.id), 0.25);
  });

  it('removed/quarantined 엣지는 분모에서 제외한다', async () => {
    const graph = await graphRepo.save(graphRepo.create({ workspace_id: WORKSPACE_ID, resource_id: 'r-removed', folder_path: '', status: 'ready' }));
    await edgeRepo.save([
      edge('x1', graph.id, { status: 'active' }),
      edge('x2', graph.id, { status: 'stale' }),
      edge('x3', graph.id, { status: 'removed' }),
      edge('x4', graph.id, { status: 'quarantined' }),
    ]);
    // active=1, stale=1 → 분모 2, removed/quarantined 2개는 무시돼야 0.5
    assert.equal(await lifecycleService.computeDirtyRatio(graph.id), 0.5);
  });
});

describe('OntologyController.graph — 브라우저 렌더링 스냅샷', () => {
  it('ready 그래프의 활성 노드와 양 끝이 선택된 활성 엣지를 반환한다', async () => {
    const graph = await graphRepo.save(graphRepo.create({ workspace_id: WORKSPACE_ID, resource_id: 'render-ready', folder_path: '', status: 'ready' }));
    const [a, b] = await nodeRepo.save([
      node('render-node-a', graph.id, 'render/a', { name: 'a', degree: 2, pagerank: 0.8 }),
      node('render-node-b', graph.id, 'render/b', { name: 'b', degree: 1, pagerank: 0.4 }),
    ]);
    await edgeRepo.save(edge('render-edge', graph.id, { src_id: a.id, dst_id: b.id }));

    const res = fakeRes();
    await controller.graph(WORKSPACE_ID, graph.id, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body.nodes.map((item) => item.id), [a.id, b.id]);
    assert.equal(res._body.edges.length, 1);
    assert.equal(res._body.total_nodes, 2);
    assert.equal(res._body.total_edges, 1);
    assert.equal(res._body.truncated, false);
  });

  it('선택 밖 고신뢰 엣지가 30,000개를 넘어도 선택 노드 사이 엣지를 반환한다', async () => {
    const graph = await graphRepo.save(graphRepo.create({ workspace_id: WORKSPACE_ID, resource_id: 'render-large-edge-distribution', folder_path: '', status: 'ready' }));
    const [a, b] = await nodeRepo.save([
      node('render-large-a', graph.id, 'render/large-a', { degree: 2, pagerank: 0.8 }),
      node('render-large-b', graph.id, 'render/large-b', { degree: 1, pagerank: 0.4 }),
    ]);
    const distractors = Array.from({ length: 30_001 }, (_, index) => edge(
      `render-distractor-${String(index).padStart(5, '0')}`,
      graph.id,
      { src_id: `outside-src-${index}`, dst_id: `outside-dst-${index}`, confidence: 1 },
    ));
    for (let index = 0; index < distractors.length; index += 500) {
      await edgeRepo.insert(distractors.slice(index, index + 500));
    }
    await edgeRepo.save(edge('render-selected-edge', graph.id, {
      src_id: a.id,
      dst_id: b.id,
      confidence: 0.1,
    }));

    const res = fakeRes();
    await controller.graph(WORKSPACE_ID, graph.id, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body.edges.map((item) => item.id), ['render-selected-edge']);
    assert.equal(res._body.total_edges, 30_002);
  });

  it('building 그래프는 불완전 스냅샷 대신 409를 반환한다', async () => {
    const graph = await graphRepo.save(graphRepo.create({ workspace_id: WORKSPACE_ID, resource_id: 'render-building', folder_path: '', status: 'building' }));
    const res = fakeRes();
    await controller.graph(WORKSPACE_ID, graph.id, res);
    assert.equal(res._status, 409);
    assert.equal(res._body.status, 'building');
  });
});

describe('countBehindAhead — 컨트롤러가 실제로 쓰는 (repoPath, \'HEAD\', graph.commit) 호출 방식', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-freshness-git-'));
  function git(args) {
    return execFileSync('git', args, { cwd: repoDir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString().trim();
  }
  let indexedCommit;

  before(() => {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@awb.local']);
    git(['config', 'user.name', 'AWB Test']);
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export const a = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'indexed commit']);
    indexedCommit = git(['rev-parse', 'HEAD']);

    // HEAD를 두 커밋 전진시킨다 — 그래프는 여전히 indexedCommit을 가리킨다.
    fs.writeFileSync(path.join(repoDir, 'b.ts'), 'export const b = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'c2']);
    fs.writeFileSync(path.join(repoDir, 'c.ts'), 'export const c = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'c3']);
  });

  after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('인덱싱 시점 커밋이 HEAD보다 2커밋 뒤처져 있으면 behind=2, ahead=0을 반환한다', async () => {
    const result = await countBehindAhead(repoDir, 'HEAD', indexedCommit);
    assert.deepEqual(result, { behind: 2, ahead: 0 });
  });

  it('인덱싱 시점 커밋 == HEAD면 behind=0, ahead=0(완전히 신선함)', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const result = await countBehindAhead(repoDir, 'HEAD', head);
    assert.deepEqual(result, { behind: 0, ahead: 0 });
  });
});

describe('OntologyController.status', () => {
  it('workspace_id 누락 시 400', async () => {
    const res = fakeRes();
    await controller.status(undefined, undefined, RESOURCE_ID, undefined, res);
    assert.equal(res._status, 400);
    assert.match(res._body.error, /workspace_id/);
  });

  it('graph_id/resource_id 둘 다 없으면 400', async () => {
    const res = fakeRes();
    await controller.status(WORKSPACE_ID, undefined, undefined, undefined, res);
    assert.equal(res._status, 400);
    assert.match(res._body.error, /graph_id or resource_id/);
  });

  it('최초 참조(status=building, commit 없음)는 git 조회를 시도하지 않고 dirty_ratio/behind/ahead가 모두 null', async () => {
    const res = fakeRes();
    await controller.status(WORKSPACE_ID, undefined, 'r-fresh-build', '', res);
    assert.equal(res._status, 200);
    assert.equal(res._body.status, 'building');
    assert.equal(res._body.commit, '');
    assert.equal(res._body.dirty_ratio, null);
    assert.equal(res._body.behind, null);
    assert.equal(res._body.ahead, null);
    assert.equal(res._body.freshness_error, null);
    assert.ok(res._body.graph_id);
  });

  it('commit이 있는데 참조된 Resource가 없으면 freshness_error로 흡수하고 status/dirty_ratio는 그대로 반환한다', async () => {
    // resolveOrProvision으로 그래프를 만든 뒤, runInitialBuild가 하는 것처럼
    // DB를 직접 ready+commit으로 갱신 — 이 그래프의 resource_id는
    // Resource 테이블에 실존하지 않는다(RESOURCE_ID 상수 자체가 그 목적).
    const { graph } = await lifecycleService.getOrCreateGraph({ workspaceId: WORKSPACE_ID, resourceId: RESOURCE_ID, folderPath: '' });
    await graphRepo.update({ id: graph.id }, { status: 'ready', indexed_at: new Date(), commit: 'deadbeefcafe' });
    await edgeRepo.save([edge('fe1', graph.id, { status: 'active' }), edge('fe2', graph.id, { status: 'stale' })]);

    const res = fakeRes();
    await controller.status(WORKSPACE_ID, graph.id, undefined, undefined, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.status, 'ready');
    assert.equal(res._body.commit, 'deadbeefcafe');
    assert.equal(res._body.dirty_ratio, 0.5);
    assert.equal(res._body.behind, null);
    assert.equal(res._body.ahead, null);
    assert.match(res._body.freshness_error, /not found/i);
  });

  it('다른 workspace 소유 graph_id를 조회하면 404(존재 유출 없이 not_found)', async () => {
    const { graph } = await lifecycleService.getOrCreateGraph({ workspaceId: WORKSPACE_ID, resourceId: 'r-cross-ws', folderPath: '' });
    const res = fakeRes();
    await controller.status(OTHER_WORKSPACE_ID, graph.id, undefined, undefined, res);
    assert.equal(res._status, 404);
    assert.equal(res._body.code, 'not_found');
  });
});

describe('OntologyController.viewOpened — 휴먼 그래프뷰 재방문 텔레메트리', () => {
  it('workspace_id 누락 시 400, 로깅 없음', async () => {
    const before = logs.length;
    const res = fakeRes();
    await controller.viewOpened({}, { currentUser: { id: 'u1' } }, res);
    assert.equal(res._status, 400);
    assert.equal(logs.length, before);
  });

  it('정상 호출은 LogService.info를 Ontology 카테고리로 정확히 1회 기록한다(6/7 graph tool call 로깅과 같은 메커니즘)', async () => {
    const before = logs.length;
    const res = fakeRes();
    await controller.viewOpened(
      { workspace_id: WORKSPACE_ID, resource_id: 'r-view', folder_path: 'apps/server' },
      { currentUser: { id: 'u1' } },
      res,
    );
    assert.equal(res._body.ok, true);
    assert.equal(logs.length, before + 1);
    const entry = logs[logs.length - 1];
    assert.equal(entry.cat, 'Ontology');
    assert.match(entry.msg, /graph view opened/);
    assert.equal(entry.meta.workspace_id, WORKSPACE_ID);
    assert.equal(entry.meta.resource_id, 'r-view');
    assert.equal(entry.meta.folder_path, 'apps/server');
    assert.equal(entry.meta.user_id, 'u1');
  });
});

// ─── 리뷰 지적 회귀(승인 블로커, 라운드1) ────────────────────────────────
// "Refresh Graph" 버튼이 GET /status(resolveOrProvision)만 다시 부르는데,
// resolveOrProvision은 created===true(최초 참조)일 때만 kickOffInitialBuild를
// 부른다 — 기존 ready/stale/error 그래프에 대한 "Refresh"가 실제로는
// 아무것도 재시작하지 않았고, 특히 실패한 최초 빌드는 UI에서 영구히
// 재시도 불가능했다. forceRebuild()(원자적 단일-승자 UPDATE)로 해소.

describe('OntologyLifecycleService.runInitialBuild — 재실행 idempotency(리뷰 지적의 근본 원인)', () => {
  it('전체 빌드 트랜잭션 중 주기 flush가 겹쳐도 flush가 COMMIT 뒤까지 대기한다', async () => {
    const graph = await graphRepo.save(graphRepo.create({ workspace_id: WORKSPACE_ID, resource_id: 'r-flush-overlap', folder_path: '', status: 'building' }));
    let releaseBuild;
    const buildGate = new Promise((resolve) => { releaseBuild = resolve; });
    let inserted;
    const insertedSignal = new Promise((resolve) => { inserted = resolve; });
    const extraction = {
      extractRepo: async ({ dataSource }) => {
        await dataSource.getRepository(OntologyNode).insert(node('flush-overlap-node', graph.id, 'sym:flush-overlap'));
        inserted();
        await buildGate;
        return { commit: 'flush-safe', filesDiscovered: 1, filesFailedExtraction: 0, nodesInserted: 1, edgesInserted: 0 };
      },
    };
    const svc = new OntologyLifecycleService(AppOntologyDataSource, extraction, {
      resolveGraph: async () => ({ edgesInserted: 0 }),
    }, { info() {}, warn() {}, error() {} });

    const build = svc.runInitialBuild(graph);
    await insertedSignal;
    let flushFinished = false;
    const flush = flushOntologySqljs(AppOntologyDataSource, true).then(() => { flushFinished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(flushFinished, false, '활성 빌드 트랜잭션 중에는 export하면 안 된다');
    releaseBuild();
    await assert.doesNotReject(build);
    await assert.doesNotReject(flush);
    assert.equal((await graphRepo.findOne({ where: { id: graph.id } })).status, 'ready');
  });

  it('두 번째 실행이 첫 번째 실행의 노드/엣지/역방향색인을 정확히 교체한다 — 중복 적재도, unique 제약 위반도 없어야 한다', async () => {
    const graph = await graphRepo.save(graphRepo.create({
      workspace_id: WORKSPACE_ID, resource_id: 'r-idempotent', folder_path: '', status: 'ready',
    }));
    const nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
    const reverseRepo = AppOntologyDataSource.getRepository(OntologyReverseEdgeIndex);

    // 실제 extractRepo/resolveGraph를 흉내내는 fake — 매 호출마다 진짜 repo에
    // 행을 심는다(요약 숫자만 반환하는 다른 describe 블록의 fake와 달리,
    // 여기서는 실제 DB 부수효과 자체를 검증해야 하므로).
    let call = 0;
    const insertingExtraction = {
      extractRepo: async () => {
        call += 1;
        const rows = call === 1
          ? [node(randomUUID(), graph.id, 'sym:a')]
          : [node(randomUUID(), graph.id, 'sym:a', { name: 'a-v2' }), node(randomUUID(), graph.id, 'sym:b')];
        await nodeRepo.insert(rows);
        return {
          commit: `c${call}`, filesDiscovered: rows.length, filesSkippedByExtension: 0, filesSkippedTooLargeOrBinary: 0,
          filesFailedExtraction: 0, extractionFailures: [], treeWalkMs: 1, fetchMs: 1, extractMs: 1, totalLines: 1,
          endToEndLinesPerSecond: 1, filesProcessed: rows.length, nodesInserted: rows.length, edgesInserted: 0,
          containsEdges: 0, declaresEdges: 0, decoratesEdges: 0, decoratesUnresolved: 0, parseErrorFiles: 0,
          skippedFiles: 0, durationMs: 1,
        };
      },
    };
    const insertingResolver = {
      resolveGraph: async () => {
        const edgeRows = call === 1 ? [edge('e1', graph.id)] : [edge('e2', graph.id), edge('e3', graph.id)];
        await edgeRepo.save(edgeRows);
        await reverseRepo.insert([{ graph_id: graph.id, dst_symbol_id: 'sym:a', src_file_id: 'f1' }]);
        return {
          filesProcessed: 1, edgesInserted: edgeRows.length, importsEdges: 0, refEdgesByType: {}, heritageEdges: 0,
          overridesEdges: 0, dynamicCappedEdges: 0, reverseIndexRows: 1, unresolvedImports: 0, unresolvedRefs: 0,
        };
      },
    };

    const svc = new OntologyLifecycleService(AppOntologyDataSource, insertingExtraction, insertingResolver, { info() {}, warn() {}, error() {} });

    await svc.runInitialBuild(graph);
    assert.equal((await nodeRepo.find({ where: { graph_id: graph.id } })).length, 1, '1회차 후 노드 1개');
    assert.equal((await edgeRepo.find({ where: { graph_id: graph.id } })).length, 1, '1회차 후 엣지 1개');

    const afterFirst = await graphRepo.findOne({ where: { id: graph.id } });
    await assert.doesNotReject(
      svc.runInitialBuild(afterFirst),
      '재실행이 OntologyNode의 (graph_id, symbol_id) 유니크 인덱스 위반으로 죽으면 안 된다(첫 실행도 sym:a를 심었으므로, 지우지 않고 재실행하면 반드시 충돌한다)',
    );

    const finalNodes = await nodeRepo.find({ where: { graph_id: graph.id } });
    const finalEdges = await edgeRepo.find({ where: { graph_id: graph.id } });
    const finalReverse = await reverseRepo.find({ where: { graph_id: graph.id } });
    assert.equal(finalNodes.length, 2, '2회차 후 노드는 2회차가 심은 2개뿐이어야 한다(1회차 잔존/중복 없음)');
    assert.deepEqual(finalNodes.map((n) => n.symbol_id).sort(), ['sym:a', 'sym:b']);
    assert.equal(finalEdges.length, 2, '2회차 후 엣지는 2개뿐이어야 한다 — OntologyEdge는 유니크 제약이 없어, 지우지 않았다면 1회차 엣지가 살아남아 3개가 됐을 것');
    assert.equal(finalReverse.length, 1, '역방향색인도 2회차 것만 남아야 한다 — 누적되면 2개');

    const finalGraph = await graphRepo.findOne({ where: { id: graph.id } });
    assert.equal(finalGraph.status, 'ready');
    assert.equal(finalGraph.commit, 'c2');
  });

  it('교체 도중 추출이 실패하면 트랜잭션이 기존 ready 스냅샷을 보존한다', async () => {
    const graph = await graphRepo.save(graphRepo.create({
      workspace_id: WORKSPACE_ID, resource_id: 'r-rollback', folder_path: '', status: 'ready', commit: 'stable-commit',
    }));
    const nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
    const original = node('rollback-old', graph.id, 'sym:stable');
    await nodeRepo.insert(original);

    const failingExtraction = {
      extractRepo: async ({ dataSource }) => {
        await dataSource.getRepository(OntologyNode).insert(node('rollback-new', graph.id, 'sym:partial'));
        throw new Error('의도한 추출 실패');
      },
    };
    const svc = new OntologyLifecycleService(
      AppOntologyDataSource,
      failingExtraction,
      { resolveGraph: async () => { throw new Error('호출되면 안 됨'); } },
      { info() {}, warn() {}, error() {} },
    );

    await assert.rejects(() => svc.runInitialBuild(graph), /의도한 추출 실패/);
    const rows = await nodeRepo.find({ where: { graph_id: graph.id } });
    assert.deepEqual(rows.map((row) => row.symbol_id), ['sym:stable']);
    const failedGraph = await graphRepo.findOne({ where: { id: graph.id } });
    assert.equal(failedGraph.status, 'error');
    assert.equal(failedGraph.commit, 'stable-commit', '마지막 ready 커밋 메타데이터도 보존해야 한다');
  });
});

describe('OntologyLifecycleService.forceRebuild — "Refresh Graph" 액션의 실제 재시작', () => {
  it('ready 그래프를 refresh하면 building으로 전환되고 started=true', async () => {
    const graph = await graphRepo.save(graphRepo.create({
      workspace_id: WORKSPACE_ID, resource_id: 'r-refresh-ready', folder_path: '', status: 'ready', commit: 'oldsha', indexed_at: new Date(),
    }));
    const result = await lifecycleService.forceRebuild({ graphId: graph.id, workspaceId: WORKSPACE_ID });
    assert.equal(result.started, true);
    assert.equal(result.graph.status, 'building');
  });

  it('error 그래프를 refresh하면 error 필드가 비워지고 building으로 전환된다 — "영구 재시도 불가" 버그의 정확한 회귀', async () => {
    const graph = await graphRepo.save(graphRepo.create({
      workspace_id: WORKSPACE_ID, resource_id: 'r-refresh-error', folder_path: '', status: 'error', error: 'boom: previous failure',
    }));
    const result = await lifecycleService.forceRebuild({ graphId: graph.id, workspaceId: WORKSPACE_ID });
    assert.equal(result.started, true);
    assert.equal(result.graph.status, 'building');
    assert.equal(result.graph.error, '');
  });

  it('이미 building 중인 그래프를 refresh하면 새 빌드를 킥오프하지 않는다(started=false)', async () => {
    const graph = await graphRepo.save(graphRepo.create({
      workspace_id: WORKSPACE_ID, resource_id: 'r-refresh-building', folder_path: '', status: 'building',
    }));
    const result = await lifecycleService.forceRebuild({ graphId: graph.id, workspaceId: WORKSPACE_ID });
    assert.equal(result.started, false);
    assert.equal(result.graph.status, 'building');
  });

  it('동시 두 번의 refresh 요청(중복 클릭) 중 정확히 하나만 승자가 된다 — 원자적 단일-승자 UPDATE(actions.service.ts와 같은 패턴)', async () => {
    const graph = await graphRepo.save(graphRepo.create({
      workspace_id: WORKSPACE_ID, resource_id: 'r-refresh-race', folder_path: '', status: 'ready',
    }));
    const [a, b] = await Promise.all([
      lifecycleService.forceRebuild({ graphId: graph.id, workspaceId: WORKSPACE_ID }),
      lifecycleService.forceRebuild({ graphId: graph.id, workspaceId: WORKSPACE_ID }),
    ]);
    const startedCount = [a.started, b.started].filter(Boolean).length;
    assert.equal(startedCount, 1, '정확히 하나만 started=true여야 한다(둘 다 true면 병렬 빌드, 둘 다 false면 아무도 재시작 안 됨)');
  });

  it('존재하지 않는 graph_id는 not_found', async () => {
    await assert.rejects(
      () => lifecycleService.forceRebuild({ graphId: 'gf-does-not-exist', workspaceId: WORKSPACE_ID }),
      (e) => e instanceof GraphRefResolutionError && e.code === 'not_found',
    );
  });

  it('다른 workspace 소유 그래프는 not_found(존재 유출 없음)', async () => {
    const graph = await graphRepo.save(graphRepo.create({
      workspace_id: WORKSPACE_ID, resource_id: 'r-refresh-cross-ws', folder_path: '', status: 'ready',
    }));
    await assert.rejects(
      () => lifecycleService.forceRebuild({ graphId: graph.id, workspaceId: OTHER_WORKSPACE_ID }),
      (e) => e instanceof GraphRefResolutionError && e.code === 'not_found',
    );
  });
});

describe('OntologyController.refresh — "Refresh Graph" 커맨드 엔드포인트(조회 GET과 분리된 POST)', () => {
  it('workspace_id 누락 시 400', async () => {
    const res = fakeRes();
    await controller.refresh({ graph_id: 'x' }, res);
    assert.equal(res._status, 400);
  });

  it('graph_id 누락 시 400', async () => {
    const res = fakeRes();
    await controller.refresh({ workspace_id: WORKSPACE_ID }, res);
    assert.equal(res._status, 400);
  });

  it('존재하지 않는 graph_id는 404', async () => {
    const res = fakeRes();
    await controller.refresh({ workspace_id: WORKSPACE_ID, graph_id: 'gf-ctrl-does-not-exist' }, res);
    assert.equal(res._status, 404);
    assert.equal(res._body.code, 'not_found');
  });

  it('ready 그래프를 refresh하면 200 + started=true + status=building, 곧바로 재호출하면 started=false(중복 킥오프 방지가 컨트롤러 계층까지 이어진다)', async () => {
    const graph = await graphRepo.save(graphRepo.create({
      workspace_id: WORKSPACE_ID, resource_id: 'r-ctrl-refresh', folder_path: '', status: 'ready',
    }));

    const res = fakeRes();
    await controller.refresh({ workspace_id: WORKSPACE_ID, graph_id: graph.id }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.started, true);
    assert.equal(res._body.status, 'building');
    assert.equal(res._body.graph_id, graph.id);

    const res2 = fakeRes();
    await controller.refresh({ workspace_id: WORKSPACE_ID, graph_id: graph.id }, res2);
    assert.equal(res2._status, 200);
    assert.equal(res2._body.started, false);
    assert.equal(res2._body.status, 'building');
  });
});
