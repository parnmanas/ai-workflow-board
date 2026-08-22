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

const { AppDataSource, AppOntologyDataSource, initDb } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { Resource } = await import('file://' + path.join(DIST_ROOT, 'entities/Resource.js'));
const { Credential } = await import('file://' + path.join(DIST_ROOT, 'entities/Credential.js'));
const { OntologyGraph } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyGraph.js'));
const { OntologyEdge } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEdge.js'));
const { OntologyLifecycleService } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/ontology-lifecycle.service.js'));
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

function fakeRes() {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
}

let graphRepo, edgeRepo, resourceRepo, credentialRepo;
let lifecycleService, controller, logs;

before(async () => {
  await initDb();
  graphRepo = AppOntologyDataSource.getRepository(OntologyGraph);
  edgeRepo = AppOntologyDataSource.getRepository(OntologyEdge);
  resourceRepo = AppDataSource.getRepository(Resource);
  credentialRepo = AppDataSource.getRepository(Credential);

  const fakeExtraction = { extractRepo: async () => { throw new Error('not used in this suite'); } };
  const fakeResolver = { resolveGraph: async () => { throw new Error('not used in this suite'); } };
  const noopLogger = { info() {}, warn() {}, error() {} };
  lifecycleService = new OntologyLifecycleService(AppOntologyDataSource, fakeExtraction, fakeResolver, noopLogger);

  logs = [];
  const capturingLogger = {
    info: (cat, msg, meta) => { logs.push({ cat, msg, meta }); },
    warn() {}, error() {},
  };
  controller = new OntologyController(resourceRepo, credentialRepo, lifecycleService, capturingLogger);
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
