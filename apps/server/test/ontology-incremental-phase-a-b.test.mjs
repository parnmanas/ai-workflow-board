// 회귀 테스트 — ticket 964014f5 "[Ontology Graph 4/7] 증분 갱신 — Phase
// A/B/C 스케줄러 + rename/move 무조건 재해소".
//
// ontology-resolver-graph-integration.test.mjs와 같은 자세: 실제 sql.js
// AppOntologyDataSource에 대해 extractFile() -> persistFactBundles() ->
// resolveCrossFileEdges()로 초기 그래프를 만든 뒤, 이 티켓이 새로 만든
// incremental/phase-a.ts, incremental/phase-b.ts를 그 위에서 구동한다.
// 컴파일된 dist/ 대상으로 실행(`npm run build` 필요) — ontology 계열
// 테스트 전체의 관례. 격리된 SQLJS_ONTOLOGY_DB_PATH 임시 파일을 써서
// 공유 dev database/ontology.db는 절대 건드리지 않는다.
//
// 완료조건 1(body-only 편집 조기 종료)과 완료조건 2(rename의 무조건
// 재해소, REVIEW-NOTES.md I2)를 각각 독립된 그래프(graph_id)로 검증한다.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-incremental-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { extractFile } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/extract-file.js'));
const { hashFactBundle } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/hash-bundle.js'));
const { persistFactBundles, insertChunked } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/persist.js'));
const { resolveCrossFileEdges } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/resolver/resolve.js'));
const { runPhaseA, runPhaseADeletion } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/incremental/phase-a.js'));
const { runPhaseB } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/incremental/phase-b.js'));
const { findAffectedFilePaths } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/incremental/reverse-lookup.js'));
const { AppOntologyDataSource, initOntologyDb, flushOntologySqljs } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));
const { OntologyEdge } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEdge.js'));
const { OntologyReverseEdgeIndex } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyReverseEdgeIndex.js'));

const WORKSPACE_ID = 'incremental-test-ws';
const RESOURCE_ID = 'incremental-test-resource';

let nodeRepo, edgeRepo;

before(async () => {
  await initOntologyDb();
  nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
  edgeRepo = AppOntologyDataSource.getRepository(OntologyEdge);
});

after(async () => {
  if (AppOntologyDataSource?.isInitialized) {
    await flushOntologySqljs(AppOntologyDataSource, true);
    await AppOntologyDataSource.destroy();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedGraph(graphId, fixtures, commit) {
  const bundles = [];
  for (const fx of fixtures) {
    const bundle = await extractFile(fx.path, fx.src, 'typescript');
    assert.equal(bundle.hasParseError, false, `${fx.path} 픽스처가 파싱 에러 없이 파싱돼야 한다`);
    // extractFile() 자신은 해싱하지 않는다(구조적 사실만) — worker.ts가
    // 실제 추출 풀 경로에서 하는 것과 똑같이 hashFactBundle()로 fileHash +
    // 각 def의 contentHash/signatureHash를 채운다. 이걸 빠뜨리면(예:
    // ontology-resolver-graph-integration.test.mjs처럼 fileHash만 손으로
    // 채우는 옛 패턴) signature_hash가 계속 ''로 남아 Phase A의 조기
    // 종료 판정 자체가 무의미해진다.
    hashFactBundle(bundle, fx.src);
    bundles.push(bundle);
  }
  await persistFactBundles(AppOntologyDataSource, {
    graphId,
    workspaceId: WORKSPACE_ID,
    resourceId: RESOURCE_ID,
    folderPath: '',
    commit,
    extractionRunId: `${graphId}-extract-1`,
    bundles,
    decoratorFactsByPath: new Map(),
  });
  return resolveCrossFileEdges(AppOntologyDataSource, {
    graphId,
    workspaceId: WORKSPACE_ID,
    commit,
    extractionRunId: `${graphId}-resolve-1`,
  });
}

describe('완료조건 1 — body-only 편집은 다른 파일을 건드리지 않고 Phase A에서 조기 종료된다', () => {
  const GRAPH_ID = 'phase-a-shortcircuit-graph';
  const BASE_PATH = 'base.ts';
  const CALLER_PATH = 'caller.ts';
  // 인스턴스 메서드 호출(`b.render()`, b는 지역 변수)은 이 리졸버가 타입
  // 추론을 하지 않아 애초에 해소되지 않는다(resolveRef의 qualifier 해소는
  // import 바인딩/같은 파일 top-level def만 컨테이너로 인정 —
  // cascade.ts). 그래서 픽스처는 qualifier 없는 최상위 함수 export/import/
  // 호출로 구성한다 — 이게 정확히 caller.ts의 CALLS 엣지가 실제로
  // 만들어지는 패턴이다.
  const V1_BASE_SRC = `
export function render() {
  return 1;
}
`;
  const V2_BASE_BODY_ONLY_SRC = `
export function render() {
  // body만 바뀜 — 파라미터/반환형/이름은 그대로
  const x = 1 + 1;
  return x;
}
`;
  const CALLER_SRC = `
import { render } from './base';

export function trigger() {
  render();
}
`;

  let baseFileNodeBefore, callerCallsEdgeBefore, baseRenderDefBefore;

  before(async () => {
    await seedGraph(
      GRAPH_ID,
      [
        { path: BASE_PATH, src: V1_BASE_SRC },
        { path: CALLER_PATH, src: CALLER_SRC },
      ],
      'commit-1',
    );
    baseFileNodeBefore = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: BASE_PATH } });
    baseRenderDefBefore = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'render', path: BASE_PATH } });
    const callerFile = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: CALLER_PATH } });
    callerCallsEdgeBefore = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'CALLS', dst_id: baseRenderDefBefore.id },
    });
    assert.ok(baseFileNodeBefore);
    assert.ok(baseRenderDefBefore);
    assert.ok(callerCallsEdgeBefore, 'caller.trigger --CALLS--> Base.render 엣지가 초기 해소에서 만들어져 있어야 한다');
    assert.notEqual(baseRenderDefBefore.signature_hash, '', '초기 추출이 signature_hash를 채워야 한다(이 티켓 이전엔 항상 빈 문자열이었음)');
  });

  it('body만 바뀐 재파싱 결과는 content_hash는 바뀌고 signature_hash는 그대로다', async () => {
    const phaseA = await runPhaseA(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      commit: 'commit-2',
      extractionRunId: 'phase-a-run-1',
      newPath: BASE_PATH,
      oldPath: BASE_PATH,
      lang: 'typescript',
      content: V2_BASE_BODY_ONLY_SRC,
    });

    assert.equal(phaseA.isRename, false);
    assert.equal(phaseA.isNewFile, false);
    assert.deepEqual(phaseA.changedSymbolIds, [], 'body-only 편집은 changedSymbolIds가 비어 있어야 한다');
    assert.equal(phaseA.shortCircuit, true, '완료조건 1 — 다른 시그니처 변경도 rename도 아니면 조기 종료');

    const baseFileAfter = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: BASE_PATH } });
    const baseRenderDefAfter = await nodeRepo.findOne({ where: { id: baseRenderDefBefore.id } });
    assert.notEqual(baseFileAfter.content_hash, baseFileNodeBefore.content_hash, 'File.content_hash는 body 변경으로 바뀌어야 한다');
    assert.equal(baseRenderDefAfter.signature_hash, baseRenderDefBefore.signature_hash, 'Base.render의 signature_hash는 body-only 편집으로 바뀌면 안 된다');
    assert.notEqual(baseRenderDefAfter.content_hash, baseRenderDefBefore.content_hash, 'Base.render의 content_hash는(body 포함 전체 범위) 바뀌어야 한다');
  });

  it('Phase A가 shortCircuit이면 Phase B를 호출해도 아무 파일도 건드리지 않는다 — caller.ts의 CALLS 엣지가 그대로다', async () => {
    const phaseA = await runPhaseA(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      commit: 'commit-3',
      extractionRunId: 'phase-a-run-2',
      newPath: BASE_PATH,
      oldPath: BASE_PATH,
      lang: 'typescript',
      // 위 테스트의 body-only 편집을 한 번 더 다른 문구로 반복 — 여전히 시그니처는 동일.
      content: V2_BASE_BODY_ONLY_SRC.replace('const x = 1 + 1;', 'const x = 2 + 2;'),
    });
    assert.equal(phaseA.shortCircuit, true);

    const phaseB = await runPhaseB(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      commit: 'commit-3',
      extractionRunId: 'phase-a-run-2',
      changedFilePath: BASE_PATH,
      phaseA,
    });
    assert.equal(phaseB.ran, false, 'shortCircuit=true인 Phase A 결과로는 Phase B가 아예 실행되지 않아야 한다');
    assert.deepEqual(phaseB.scopeFilePaths, []);

    const callerCallsEdgeAfter = await edgeRepo.findOne({ where: { id: callerCallsEdgeBefore.id } });
    assert.ok(callerCallsEdgeAfter, 'caller.ts의 기존 CALLS 엣지는 그대로 살아있어야 한다(soft-delete 안 됨)');
    assert.equal(callerCallsEdgeAfter.status, 'active');
    assert.equal(
      callerCallsEdgeAfter.updated_at.getTime?.() ?? new Date(callerCallsEdgeAfter.updated_at).getTime(),
      callerCallsEdgeBefore.updated_at.getTime?.() ?? new Date(callerCallsEdgeBefore.updated_at).getTime(),
      'caller.ts는 전혀 재해소되지 않았어야 하므로 그 CALLS 엣지의 updated_at도 그대로다',
    );
  });
});

describe('완료조건 1 반증 — 시그니처가 실제로 바뀌면 조기 종료하지 않고 참조 파일이 재해소된다', () => {
  const GRAPH_ID = 'phase-a-signature-change-graph';
  const BASE_PATH = 'base2.ts';
  const CALLER_PATH = 'caller2.ts';
  const V1_SRC = `
export function render() {
  return 1;
}
`;
  const V2_SIGNATURE_CHANGED_SRC = `
export function render(flag: boolean) {
  return flag ? 1 : 0;
}
`;
  const CALLER_SRC = `
import { render } from './base2';

export function trigger() {
  render();
}
`;

  before(async () => {
    await seedGraph(GRAPH_ID, [
      { path: BASE_PATH, src: V1_SRC },
      { path: CALLER_PATH, src: CALLER_SRC },
    ], 'commit-1');
  });

  it('파라미터 추가(시그니처 변경)는 changedSymbolIds를 채우고, Phase B가 caller2.ts를 재해소 대상으로 찾는다', async () => {
    const phaseA = await runPhaseA(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      commit: 'commit-2',
      extractionRunId: 'sig-run-1',
      newPath: BASE_PATH,
      oldPath: BASE_PATH,
      lang: 'typescript',
      content: V2_SIGNATURE_CHANGED_SRC,
    });
    assert.equal(phaseA.shortCircuit, false);
    assert.ok(phaseA.changedSymbolIds.length >= 1, 'Base.render의 signature_hash 변경이 changedSymbolIds에 잡혀야 한다');

    const phaseB = await runPhaseB(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      commit: 'commit-2',
      extractionRunId: 'sig-run-1',
      changedFilePath: BASE_PATH,
      phaseA,
    });
    assert.equal(phaseB.ran, true);
    assert.ok(phaseB.scopeFilePaths.includes(CALLER_PATH), `reverse-index가 ${CALLER_PATH}를 영향받는 파일로 찾아야 한다`);
  });
});

describe('완료조건 2 — rename/move는 signature_hash와 무관하게 이동한 파일 자신의 outgoing refs를 무조건 재해소한다(REVIEW-NOTES.md I2)', () => {
  const GRAPH_ID = 'phase-a-rename-graph';
  // I2가 지목한 정확한 실패 모드: consumer.ts가 상대경로 './util'로 helper를
  // import한다. pkg/util.ts와 moved/util.ts는 같은 basename의 "동명이인"
  // 파일 — consumer.ts가 pkg/ 안에 있을 때는 pkg/util.ts를 가리키지만,
  // consumer.ts 자체가 moved/ 로 이동하면 같은 './util' 텍스트가 이제
  // moved/util.ts를 가리킨다. content_hash/signature_hash 둘 다 그대로인
  // pure rename인데도 해소 타겟이 조용히 달라지는 사례.
  const CONSUMER_OLD_PATH = 'pkg/consumer.ts';
  const CONSUMER_NEW_PATH = 'moved/consumer.ts';
  const PKG_UTIL_PATH = 'pkg/util.ts';
  const MOVED_UTIL_PATH = 'moved/util.ts';
  const CONSUMER_SRC = `
import { helper } from './util';

export function run() {
  helper();
}
`;

  before(async () => {
    await seedGraph(
      GRAPH_ID,
      [
        { path: CONSUMER_OLD_PATH, src: CONSUMER_SRC },
        { path: PKG_UTIL_PATH, src: `export function helper() { return 1; }\n` },
        { path: MOVED_UTIL_PATH, src: `export function helper() { return 2; }\n` },
      ],
      'commit-1',
    );
  });

  it('이동 전: consumer.ts의 IMPORTS 엣지는 pkg/util.ts의 helper를 가리킨다', async () => {
    const consumerFile = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: CONSUMER_OLD_PATH } });
    const pkgHelper = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, path: PKG_UTIL_PATH, qualified_name: 'helper' } });
    const edge = await edgeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'IMPORTS', src_id: consumerFile.id, dst_id: pkgHelper.id } });
    assert.ok(edge, 'consumer.ts --IMPORTS--> pkg/util.ts#helper 엣지가 있어야 한다');
    assert.equal(edge.status, 'active');
  });

  it('pkg/consumer.ts -> moved/consumer.ts로 순수 rename(content 동일) 후 Phase A는 isRename=true를 반환한다', async () => {
    const consumerFileBefore = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: CONSUMER_OLD_PATH } });

    const phaseA = await runPhaseA(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      commit: 'commit-2',
      extractionRunId: 'rename-run-1',
      newPath: CONSUMER_NEW_PATH,
      oldPath: CONSUMER_OLD_PATH,
      lang: 'typescript',
      content: CONSUMER_SRC, // 바이트 단위로 동일 — 순수 rename
    });

    assert.equal(phaseA.isRename, true);
    assert.equal(phaseA.shortCircuit, false, 'rename은 시그니처 변경이 없어도 조기 종료하면 안 된다(I2)');
    assert.equal(phaseA.fileNodeId, consumerFileBefore.id, 'File 노드의 내부 id는 rename으로도 보존돼야 한다(OntologyEdge가 이 id를 참조)');

    const consumerFileAfter = await nodeRepo.findOne({ where: { id: consumerFileBefore.id } });
    assert.equal(consumerFileAfter.path, CONSUMER_NEW_PATH);
    assert.equal(consumerFileAfter.symbol_id, `file:${CONSUMER_NEW_PATH}`);

    const oldPathNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, path: CONSUMER_OLD_PATH, status: 'active' } });
    assert.equal(oldPathNode, null, '옛 경로엔 더 이상 활성 노드가 남아있으면 안 된다(같은 행이 새 경로로 갱신됐다)');

    // Phase B를 실제로 돌려야 재해소가 일어난다 — 이 시점엔 아직 안 돌렸다.
    const staleEdgeStillActive = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'IMPORTS', src_id: consumerFileBefore.id, status: 'active' },
    });
    assert.ok(staleEdgeStillActive, 'Phase B 실행 전에는 옛 IMPORTS 엣지가 아직 active로 남아있다');

    const phaseB = await runPhaseB(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      commit: 'commit-2',
      extractionRunId: 'rename-run-1',
      changedFilePath: CONSUMER_NEW_PATH,
      phaseA,
    });
    assert.equal(phaseB.ran, true, 'rename은 changedSymbolIds가 비어 있어도 Phase B를 무조건 트리거해야 한다');
    assert.ok(phaseB.scopeFilePaths.includes(CONSUMER_NEW_PATH));

    // 완료조건 2의 핵심 단언 — 옛 타겟(pkg/util.ts#helper)을 향하던 엣지는
    // soft-delete되고, 새 위치 기준으로 재해소된 IMPORTS 엣지는 다른
    // 타겟(moved/util.ts#helper)을 가리켜야 한다.
    const pkgHelper = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, path: PKG_UTIL_PATH, qualified_name: 'helper' } });
    const movedHelper = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, path: MOVED_UTIL_PATH, qualified_name: 'helper' } });

    const oldTargetEdge = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'IMPORTS', src_id: consumerFileBefore.id, dst_id: pkgHelper.id },
    });
    assert.ok(oldTargetEdge, '옛 타겟을 향하던 엣지 행 자체는 이력으로 남아있어야 한다(soft-delete)');
    assert.equal(oldTargetEdge.status, 'removed', 'REVIEW-NOTES.md I2 — 이동 전 타겟을 향한 엣지는 재해소 후 살아있으면 안 된다');

    const newTargetEdge = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'IMPORTS', src_id: consumerFileBefore.id, dst_id: movedHelper.id, status: 'active' },
    });
    assert.ok(newTargetEdge, 'REVIEW-NOTES.md I2 — 이동한 파일의 상대경로 import는 새 위치 기준으로 재해소돼 moved/util.ts#helper를 가리켜야 한다');
    assert.equal(newTargetEdge.confidence, 0.95);
    assert.equal(JSON.parse(newTargetEdge.props).resolver, 'import-map');
  });
});

describe('리뷰 지적(차단1) — Phase A가 CONTAINS/DECLARES 구조 엣지를 신규/삭제 def와 동기화한다', () => {
  const GRAPH_ID = 'phase-a-structural-edges-graph';
  const FILE_PATH = 'struct.ts';
  const V1_SRC = `
export class Widget {
  render() {
    return 1;
  }
}
`;
  const V2_ADD_DEFS_SRC = `
export class Widget {
  render() {
    return 1;
  }
  extra() {
    return 2;
  }
}

export function helper() {
  return 3;
}
`;
  const V3_REMOVE_RENDER_SRC = `
export class Widget {
  extra() {
    return 2;
  }
}

export function helper() {
  return 3;
}
`;

  let fileNode, widgetNode, renderNode;

  before(async () => {
    await seedGraph(GRAPH_ID, [{ path: FILE_PATH, src: V1_SRC }], 'commit-1');
    fileNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: FILE_PATH } });
    widgetNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'Widget' } });
    renderNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'Widget.render' } });
    const containsEdge = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'CONTAINS', src_id: fileNode.id, dst_id: widgetNode.id },
    });
    const declaresEdge = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'DECLARES', src_id: widgetNode.id, dst_id: renderNode.id },
    });
    assert.ok(containsEdge && declaresEdge, '사전조건 — 초기 추출(persist.ts)이 이미 CONTAINS/DECLARES를 만들어야 한다');
  });

  it('(a) 기존 파일에 top-level def(helper)와 nested def(Widget.extra) 추가 시 CONTAINS/DECLARES가 active로 새로 생긴다', async () => {
    const phaseA = await runPhaseA(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      commit: 'commit-2',
      extractionRunId: 'struct-run-1',
      newPath: FILE_PATH,
      oldPath: FILE_PATH,
      lang: 'typescript',
      content: V2_ADD_DEFS_SRC,
    });
    assert.equal(phaseA.shortCircuit, false, '새 def 추가는 changedSymbolIds를 채워 조기 종료하면 안 된다');

    const helperNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'helper' } });
    const extraNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'Widget.extra' } });
    assert.ok(helperNode);
    assert.ok(extraNode);

    const helperContains = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'CONTAINS', src_id: fileNode.id, dst_id: helperNode.id, status: 'active' },
    });
    assert.ok(helperContains, 'top-level 신규 def(helper)는 File--CONTAINS-->helper 엣지가 active로 생겨야 한다');

    const extraDeclares = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'DECLARES', src_id: widgetNode.id, dst_id: extraNode.id, status: 'active' },
    });
    assert.ok(extraDeclares, '중첩 신규 def(Widget.extra)는 Widget--DECLARES-->extra 엣지가 active로 생겨야 한다');
  });

  it('(b) def 삭제(Widget.render 제거) 시 그 def를 향하던 DECLARES 엣지가 removed 처리된다', async () => {
    await runPhaseA(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      commit: 'commit-3',
      extractionRunId: 'struct-run-2',
      newPath: FILE_PATH,
      oldPath: FILE_PATH,
      lang: 'typescript',
      content: V3_REMOVE_RENDER_SRC,
    });

    const renderAfter = await nodeRepo.findOne({ where: { id: renderNode.id } });
    assert.equal(renderAfter.status, 'removed');

    const declaresEdgeAfter = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'DECLARES', src_id: widgetNode.id, dst_id: renderNode.id },
    });
    assert.ok(declaresEdgeAfter);
    assert.equal(
      declaresEdgeAfter.status,
      'removed',
      'Widget--DECLARES-->render 엣지도 render가 삭제되면 removed로 같이 처리돼야 한다(리뷰 지적)',
    );
  });

  it('(b) 파일 삭제(runPhaseADeletion) 시 그 파일이 만든 CONTAINS 엣지도 removed 처리된다', async () => {
    const helperNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'helper' } });
    const helperContainsBefore = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'CONTAINS', src_id: fileNode.id, dst_id: helperNode.id },
    });
    assert.equal(helperContainsBefore.status, 'active');

    await runPhaseADeletion(AppOntologyDataSource, { graphId: GRAPH_ID, commit: 'commit-4', filePath: FILE_PATH });

    const helperContainsAfter = await edgeRepo.findOne({ where: { id: helperContainsBefore.id } });
    assert.equal(
      helperContainsAfter.status,
      'removed',
      '파일 삭제 시 그 파일이 만든 CONTAINS 엣지도 removed 처리돼야 한다(리뷰 지적)',
    );
  });
});

describe('리뷰 지적(차단1c) — 신규 파일(그래프에 처음 들어오는 경로)에서도 CONTAINS/DECLARES가 생긴다', () => {
  const GRAPH_ID = 'phase-a-new-file-structural-edges-graph';
  const NEW_FILE_PATH = 'brand-new.ts';
  const SRC = `
export class Foo {
  bar() {
    return 1;
  }
}
`;

  it('그래프에 전혀 없던 파일을 Phase A로 처음 넣으면 CONTAINS/DECLARES가 active로 생긴다', async () => {
    const phaseA = await runPhaseA(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      folderPath: '',
      commit: 'commit-1',
      extractionRunId: 'new-file-run-1',
      newPath: NEW_FILE_PATH,
      oldPath: NEW_FILE_PATH,
      lang: 'typescript',
      content: SRC,
    });
    assert.equal(phaseA.isNewFile, true);

    const fileNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: NEW_FILE_PATH } });
    const fooNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'Foo' } });
    const barNode = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'Foo.bar' } });
    assert.ok(fileNode && fooNode && barNode);

    const containsEdge = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'CONTAINS', src_id: fileNode.id, dst_id: fooNode.id, status: 'active' },
    });
    assert.ok(containsEdge, '신규 파일의 top-level def도 CONTAINS 엣지가 생겨야 한다');

    const declaresEdge = await edgeRepo.findOne({
      where: { graph_id: GRAPH_ID, type: 'DECLARES', src_id: fooNode.id, dst_id: barNode.id, status: 'active' },
    });
    assert.ok(declaresEdge, '신규 파일의 중첩 def도 DECLARES 엣지가 생겨야 한다');
  });
});

describe('durability pre-filter — volatile 변경은 stable/frozen 파티션의 reverse-index 워크를 건너뛴다(research-incremental.md §4.3)', () => {
  const GRAPH_ID = 'durability-filter-graph';
  const DST_SYMBOL_ID = 'def:shared.ts#hot';
  const VOLATILE_PATH = 'app/consumer.ts';
  const FROZEN_PATH = 'node_modules/pkg/consumer.js';

  function fileNodeRow(p, durability) {
    return {
      id: randomUUID(),
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      symbol_id: `file:${p}`,
      type: 'File',
      layer: 'structural',
      name: p.split('/').pop(),
      confidence: 1,
      path: p,
      durability,
      status: 'active',
    };
  }

  let volatileFileId, frozenFileId;

  before(async () => {
    const volatileRow = fileNodeRow(VOLATILE_PATH, 'volatile');
    const frozenRow = fileNodeRow(FROZEN_PATH, 'frozen');
    volatileFileId = volatileRow.id;
    frozenFileId = frozenRow.id;
    await nodeRepo.insert([volatileRow, frozenRow]);
    await AppOntologyDataSource.getRepository(OntologyReverseEdgeIndex).insert([
      { id: randomUUID(), graph_id: GRAPH_ID, dst_symbol_id: DST_SYMBOL_ID, src_file_id: volatileFileId },
      { id: randomUUID(), graph_id: GRAPH_ID, dst_symbol_id: DST_SYMBOL_ID, src_file_id: frozenFileId },
    ]);
  });

  it('변경이 volatile 파티션에서 일어났으면 frozen referencing 파일은 결과에서 제외된다', async () => {
    const affected = await findAffectedFilePaths(AppOntologyDataSource, GRAPH_ID, [DST_SYMBOL_ID], {
      changeOriginatesInDurablePartition: false,
    });
    assert.ok(affected.has(VOLATILE_PATH));
    assert.ok(!affected.has(FROZEN_PATH), 'volatile 커밋은 frozen 파티션의 reverse-index 워크 자체를 건너뛰어야 한다(DESIGN.md 축 4)');
  });

  it('변경 자신이 stable/frozen 파티션에서 일어났으면(그 파티션 자신의 revision이 움직임) durability와 무관하게 전부 포함된다', async () => {
    const affected = await findAffectedFilePaths(AppOntologyDataSource, GRAPH_ID, [DST_SYMBOL_ID], {
      changeOriginatesInDurablePartition: true,
    });
    assert.ok(affected.has(VOLATILE_PATH));
    assert.ok(affected.has(FROZEN_PATH), "partition's own revision moved 예외 — 이 경우엔 pre-filter를 걸지 않는다");
  });

  it('changedSymbolIds가 비어 있으면 쿼리 없이 빈 집합을 반환한다', async () => {
    const affected = await findAffectedFilePaths(AppOntologyDataSource, GRAPH_ID, [], { changeOriginatesInDurablePartition: false });
    assert.equal(affected.size, 0);
  });
});

describe('파일 삭제 — runPhaseADeletion이 활성 노드를 soft-delete하고 changedSymbolIds를 채운다', () => {
  const GRAPH_ID = 'phase-a-deletion-graph';
  const DELETED_PATH = 'to-delete.ts';

  before(async () => {
    await seedGraph(GRAPH_ID, [{ path: DELETED_PATH, src: `export function gone() { return 1; }\n` }], 'commit-1');
  });

  it('삭제된 파일의 File/Def 노드가 모두 status=removed로 바뀐다', async () => {
    const before = await nodeRepo.find({ where: { graph_id: GRAPH_ID, path: DELETED_PATH, status: 'active' } });
    assert.ok(before.length >= 2, 'File + gone() def 최소 2행');

    const result = await runPhaseADeletion(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      commit: 'commit-2',
      filePath: DELETED_PATH,
    });
    assert.equal(result.changedSymbolIds.length, before.length);
    assert.equal(result.shortCircuit, false);

    const after = await nodeRepo.find({ where: { graph_id: GRAPH_ID, path: DELETED_PATH, status: 'active' } });
    assert.equal(after.length, 0, '삭제 후엔 이 경로에 활성 노드가 하나도 없어야 한다');
  });

  it('이미 활성 노드가 없는 경로를 다시 삭제 처리하면 shortCircuit=true(idempotent)', async () => {
    const result = await runPhaseADeletion(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      commit: 'commit-3',
      filePath: DELETED_PATH,
    });
    assert.equal(result.shortCircuit, true);
    assert.deepEqual(result.changedSymbolIds, []);
  });
});

describe('리뷰 지적(차단2) — resolve.ts의 scopeFilePaths 정리가 청크 경계(500) 너머까지 전부 처리한다', () => {
  const GRAPH_ID = 'resolve-scope-chunk-graph';
  const FILE_PATH = 'many-defs.ts';
  const DEF_COUNT = 620; // EDGE_CHUNK_SIZE(500)보다 크게 — 청크 하나로는 안 끝나야 한다.

  it('620개 넘는 기존 리졸버 소유 CALLS 엣지가 재해소 전에 전부 removed 처리된다', async () => {
    const fileId = randomUUID();
    const dstId = randomUUID();
    const defIds = Array.from({ length: DEF_COUNT }, () => randomUUID());

    const fileRow = {
      id: fileId,
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      symbol_id: `file:${FILE_PATH}`,
      type: 'File',
      layer: 'structural',
      name: FILE_PATH,
      qualified_name: FILE_PATH,
      path: FILE_PATH,
      confidence: 1,
      status: 'active',
      props: JSON.stringify({ refs: [], imports: [], exports: [], heritage: [] }),
    };
    const dstRow = {
      id: dstId,
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      symbol_id: 'def:target#shared',
      type: 'Callable',
      layer: 'structural',
      name: 'target',
      qualified_name: 'target',
      path: FILE_PATH,
      confidence: 1,
      status: 'active',
    };
    const defRows = defIds.map((id, i) => ({
      id,
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      symbol_id: `def:${FILE_PATH}#fn${i}`,
      type: 'Callable',
      layer: 'structural',
      name: `fn${i}`,
      qualified_name: `fn${i}`,
      path: FILE_PATH,
      confidence: 1,
      status: 'active',
      signature_hash: 'sig',
    }));
    await insertChunked(nodeRepo, [fileRow, dstRow, ...defRows], 500);

    const edgeRows = defIds.map((srcId) => ({
      id: randomUUID(),
      workspace_id: WORKSPACE_ID,
      graph_id: GRAPH_ID,
      src_id: srcId,
      dst_id: dstId,
      type: 'CALLS',
      layer: 'structural',
      confidence: 0.75,
      status: 'active',
      resolution: 'name_match',
      props: '{}',
    }));
    await insertChunked(edgeRepo, edgeRows, 500);

    await resolveCrossFileEdges(AppOntologyDataSource, {
      graphId: GRAPH_ID,
      workspaceId: WORKSPACE_ID,
      commit: 'c2',
      extractionRunId: 'chunk-run-1',
      scopeFilePaths: new Set([FILE_PATH]),
    });

    const stillActive = await edgeRepo.find({ where: { graph_id: GRAPH_ID, type: 'CALLS', status: 'active' } });
    assert.equal(
      stillActive.length,
      0,
      `청크 경계(500)를 넘는 ${DEF_COUNT}개 CALLS 엣지가 재해소 전 전부 removed 처리돼야 한다 — 청크 루프가 첫 청크만 처리하면 일부가 active로 남는다`,
    );
    const removed = await edgeRepo.find({ where: { graph_id: GRAPH_ID, type: 'CALLS', status: 'removed' } });
    assert.equal(removed.length, DEF_COUNT);
  });
});
