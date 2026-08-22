// 회귀 테스트 — ticket e14ef1c9
// "[Ontology Graph 2/7] 추출 워커 — tree-sitter WASM Tier 1 + NestJS
// 리플렉션 룰셋"
//
// 완료조건 2: "DECORATES 룰셋이 AWB 자신의 AuthGuard 등 실제 NestJS
// 가드에서 엣지 생성 확인(dogfood 검증)". 이 스위트는 AWB 자기 소스
// (boards.controller.ts의 실제 `@UseGuards(AuthGuard)` 클래스 데코레이터,
// admin.guard.ts의 AdminGuard)를 실제 worker_threads 풀 + persist.ts
// 전체 경로로 돌려서, 격리된 sql.js 온톨로지 DB에 실제 DECORATES 엣지
// 행이 만들어지는지 끝까지 검증한다 — 합성 fixture가 아니라 이 저장소
// 자신의 코드가 입력이다.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요, test 스크립트가
// 보장) — 1/7의 ontology-sqljs-independent-datasource.test.mjs와 같은 관례.
// 격리된 SQLJS_DB_PATH/SQLJS_ONTOLOGY_DB_PATH 임시 파일을 써서 공유 dev
// database/*.db는 절대 건드리지 않는다.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');
// 이 파일은 apps/server/test/ 아래 — repo 루트는 세 단계 위.
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-decorator-dogfood-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { runExtractionPool } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/pool.js'));
const { langForPath } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/types.js'));
const { persistFactBundles } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/persist.js'));
const { AppOntologyDataSource, initOntologyDb, flushOntologySqljs } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));
const { OntologyEdge } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEdge.js'));

const DOGFOOD_FILES = [
  'apps/server/src/modules/boards/boards.controller.ts', // 실제 @UseGuards(AuthGuard) 클래스 데코레이터
  'apps/server/src/common/guards/auth.guard.ts', // AuthGuard 정의부 — 같은 그래프 안에서 이름으로 해석되는 대상
  'apps/server/src/common/guards/admin.guard.ts', // moveToWorkspace 등의 @UseGuards(AdminGuard)
];

describe('DECORATES ruleset dogfood — AWB 자신의 소스 (ticket e14ef1c9, 완료조건 2)', () => {
  let summary;
  let nodeRepo, edgeRepo;

  before(async () => {
    await initOntologyDb();
    nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
    edgeRepo = AppOntologyDataSource.getRepository(OntologyEdge);

    const tasks = DOGFOOD_FILES.map((relPath) => {
      const abs = path.join(REPO_ROOT, relPath);
      return { path: relPath, content: fs.readFileSync(abs, 'utf8'), lang: langForPath(relPath) };
    });
    const results = await runExtractionPool(tasks, { poolSize: 2 });
    for (const r of results) {
      assert.equal(r.error, null, `${r.path} 추출이 에러 없이 끝나야 한다: ${r.error}`);
    }

    const bundles = results.map((r) => r.bundle);
    const decoratorFactsByPath = new Map(results.map((r) => [r.path, r.decoratorFacts]));

    summary = await persistFactBundles(AppOntologyDataSource, {
      graphId: 'dogfood-graph',
      workspaceId: 'dogfood-ws',
      resourceId: 'dogfood-resource',
      folderPath: '',
      commit: 'dogfood-commit',
      extractionRunId: 'dogfood-run-1',
      bundles,
      decoratorFactsByPath,
    });
  });

  after(async () => {
    if (AppOntologyDataSource?.isInitialized) {
      await flushOntologySqljs(AppOntologyDataSource, true);
      await AppOntologyDataSource.destroy();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces at least one DECORATES edge overall', () => {
    assert.ok(summary.decoratesEdges >= 1, `DECORATES 엣지가 최소 1개는 생성돼야 한다 (got ${summary.decoratesEdges})`);
  });

  it('creates a DECORATES edge from BoardsController to the real AuthGuard node, at the documented discounted confidence tier', async () => {
    const controllerNode = await nodeRepo.findOne({ where: { qualified_name: 'BoardsController', type: 'Type' } });
    assert.ok(controllerNode, 'BoardsController 클래스 노드가 존재해야 한다');
    assert.equal(controllerNode.path, 'apps/server/src/modules/boards/boards.controller.ts');

    const guardNode = await nodeRepo.findOne({ where: { qualified_name: 'AuthGuard', type: 'Type' } });
    assert.ok(guardNode, 'AuthGuard 클래스 노드가 존재해야 한다');
    assert.equal(guardNode.path, 'apps/server/src/common/guards/auth.guard.ts');

    const edge = await edgeRepo.findOne({ where: { type: 'DECORATES', src_id: controllerNode.id, dst_id: guardNode.id } });
    assert.ok(edge, 'BoardsController --DECORATES--> AuthGuard 엣지가 생성돼야 한다 (완료조건 2)');

    // DESIGN.md 축 1 Integration points / REVIEW-NOTES.md I6이 고정한 값 그대로.
    assert.equal(edge.confidence, 0.6);
    assert.equal(edge.confidence_method, 'constant');
    assert.equal(edge.resolution, 'dynamic');
    assert.equal(edge.layer, 'structural');
  });

  it('creates DECORATES edges from AdminGuard-protected methods to the real AdminGuard node', async () => {
    const adminGuardNode = await nodeRepo.findOne({ where: { qualified_name: 'AdminGuard', type: 'Type' } });
    assert.ok(adminGuardNode);

    const inbound = await edgeRepo.find({ where: { type: 'DECORATES', dst_id: adminGuardNode.id } });
    assert.ok(inbound.length >= 1, 'AdminGuard로 향하는 DECORATES 엣지가 최소 1개는 있어야 한다');

    const srcNodes = await Promise.all(inbound.map((e) => nodeRepo.findOne({ where: { id: e.src_id } })));
    assert.ok(
      srcNodes.some((n) => n?.qualified_name === 'BoardsController.moveToWorkspace'),
      'moveToWorkspace 메서드가 실제 @UseGuards(AdminGuard) 대상으로 해석돼야 한다',
    );
  });

  it('has zero dangling edges — every src_id/dst_id resolves to a real persisted node', async () => {
    const allNodeIds = new Set((await nodeRepo.find({ select: ['id'] })).map((n) => n.id));
    const allEdges = await edgeRepo.find();
    const dangling = allEdges.filter((e) => !allNodeIds.has(e.src_id) || !allNodeIds.has(e.dst_id));
    assert.deepEqual(dangling, []);
  });
});

// TypeORM/sql.js는 이벤트 루프를 붙잡아두는 핸들을 남긴다 — `--test-force-exit`로
// 실행해야 한다(package.json test 스크립트가 보장).
