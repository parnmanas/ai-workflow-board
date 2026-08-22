// 회귀 테스트 — ticket e52e7f64 "[Ontology Graph 3/7] 크로스파일 리졸버
// (Tier 1.5)".
//
// ontology-resolver-cascade.test.mjs / ontology-resolver-polymorphic-cap.test.mjs가
// cascade.ts와 polymorphic-cap.ts를 DB 없이 손으로 구성한 GraphSymbolIndex로
// 격리 검증한다면, 이 스위트는 resolve.ts의 진입점(resolveCrossFileEdges)이
// 실제 sql.js DataSource에 대해 extractFile() -> persistFactBundles() ->
// resolveCrossFileEdges() 전체 파이프라인으로 옳게 배선됐는지를 확인한다 —
// DB에서 읽어들이는 buildGraphSymbolIndex(), 청크 insert, reverse_edge_index
// 영속화·중복제거는 이 통합 경로에서만 실제로 실행된다.
//
// 픽스처는 barrel 재수출(entities/index.ts 미러, 완료조건 1을 실제
// extractFile() 라운드트립으로도 재확인) + heritage(EXTENDS) +
// polymorphic dispatch cap(완료조건 3) + 미해소 case를 한 그래프 안에
// 같이 담는다:
//   services/base-widget.ts  — export class BaseWidget { render() {} }
//   services/fancy-widget.ts — BaseWidget을 extends, render() 오버라이드
//   services/index.ts        — `export { BaseWidget } from './base-widget'` 배럴
//   consumer.ts               — 배럴을 통해 import, BaseWidget.render() 호출 +
//                                new BaseWidget() (reverse_edge_index 중복제거 확인용)
//   orphan.ts                 — 그래프 밖 파일을 import(항상 미해소로 남아야 함)
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-resolver-integration-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { extractFile } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/extract-file.js'));
const { persistFactBundles } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/persist.js'));
const { resolveCrossFileEdges } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/resolver/resolve.js'));
const { AppOntologyDataSource, initOntologyDb, flushOntologySqljs } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
const { OntologyNode } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyNode.js'));
const { OntologyEdge } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyEdge.js'));
const { OntologyReverseEdgeIndex } = await import('file://' + path.join(DIST_ROOT, 'entities/OntologyReverseEdgeIndex.js'));

const GRAPH_ID = 'resolver-integration-graph';

const FIXTURES = [
  {
    path: 'services/base-widget.ts',
    src: `
export class BaseWidget {
  render() {}
}
`,
  },
  {
    path: 'services/fancy-widget.ts',
    src: `
import { BaseWidget } from './base-widget';

export class FancyWidget extends BaseWidget {
  render() {}
}
`,
  },
  {
    // AWB 자신의 apps/server/src/entities/index.ts와 같은 패턴 — 완료조건 1의
    // 픽스처를 실제 extractFile() 라운드트립으로도 재확인한다.
    path: 'services/index.ts',
    src: `export { BaseWidget } from './base-widget';\n`,
  },
  {
    path: 'consumer.ts',
    src: `
import { BaseWidget } from './services/index';

export function trigger() {
  BaseWidget.render();
}

export function makeOne() {
  return new BaseWidget();
}
`,
  },
  {
    path: 'orphan.ts',
    src: `
import { Missing } from './nowhere';

export function orphanCall() {
  Missing.doStuff();
}
`,
  },
];

let nodeRepo, edgeRepo, reverseIndexRepo, summary;

before(async () => {
  await initOntologyDb();
  nodeRepo = AppOntologyDataSource.getRepository(OntologyNode);
  edgeRepo = AppOntologyDataSource.getRepository(OntologyEdge);
  reverseIndexRepo = AppOntologyDataSource.getRepository(OntologyReverseEdgeIndex);

  const bundles = [];
  for (const fx of FIXTURES) {
    const bundle = await extractFile(fx.path, fx.src, 'typescript');
    assert.equal(bundle.hasParseError, false, `${fx.path} 픽스처가 파싱 에러 없이 파싱돼야 한다`);
    bundle.fileHash = `hash-${fx.path}`;
    bundles.push(bundle);
  }

  await persistFactBundles(AppOntologyDataSource, {
    graphId: GRAPH_ID,
    workspaceId: 'resolver-integration-ws',
    resourceId: 'resolver-integration-resource',
    folderPath: '',
    commit: 'resolver-integration-commit',
    extractionRunId: 'resolver-integration-run-1',
    bundles,
    decoratorFactsByPath: new Map(),
  });

  summary = await resolveCrossFileEdges(AppOntologyDataSource, {
    graphId: GRAPH_ID,
    workspaceId: 'resolver-integration-ws',
    commit: 'resolver-integration-commit',
    extractionRunId: 'resolver-integration-resolve-run-1',
  });
});

after(async () => {
  if (AppOntologyDataSource?.isInitialized) {
    await flushOntologySqljs(AppOntologyDataSource, true);
    await AppOntologyDataSource.destroy();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveCrossFileEdges — 완료조건 1: entities/index.ts 미러 배럴이 실제 파이프라인에서도 0.95로 해소된다', () => {
  it('consumer.ts -> services/index.ts 배럴 -> base-widget.ts 종단까지 추적된 IMPORTS 엣지가 0.95/import-map이다', async () => {
    const consumerFile = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: 'consumer.ts' } });
    const baseWidget = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'BaseWidget', type: 'Type' } });
    assert.ok(consumerFile);
    assert.ok(baseWidget);

    const edge = await edgeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'IMPORTS', src_id: consumerFile.id, dst_id: baseWidget.id } });
    assert.ok(edge, 'consumer.ts --IMPORTS--> BaseWidget 엣지가 배럴을 넘어 존재해야 한다');
    assert.equal(edge.confidence, 0.95);
    assert.equal(JSON.parse(edge.props).resolver, 'import-map');
  });
});

describe('resolveCrossFileEdges — heritage + 완료조건 3: polymorphic dispatch cap', () => {
  it('FancyWidget extends BaseWidget이 EXTENDS 엣지로 해소된다', async () => {
    const fancyWidget = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'FancyWidget', type: 'Type' } });
    const baseWidget = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'BaseWidget', type: 'Type' } });
    const edge = await edgeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'EXTENDS', src_id: fancyWidget.id, dst_id: baseWidget.id } });
    assert.ok(edge);
    assert.equal(edge.confidence, 0.95);
  });

  it('OVERRIDES가 FancyWidget.render -> BaseWidget.render로 파생된다', async () => {
    const fancyRender = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'FancyWidget.render' } });
    const baseRender = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'BaseWidget.render' } });
    assert.ok(fancyRender);
    assert.ok(baseRender);
    const edge = await edgeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'OVERRIDES', src_id: fancyRender.id, dst_id: baseRender.id } });
    assert.ok(edge);
  });

  it('trigger()의 BaseWidget.render() 호출이 CALLS로 해소되고, OVERRIDES 형제가 있어 resolution이 dynamic으로 캡된다', async () => {
    const baseRender = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'BaseWidget.render' } });
    const trigger = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'trigger' } });
    const edge = await edgeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'CALLS', src_id: trigger.id, dst_id: baseRender.id } });
    assert.ok(edge, 'trigger --CALLS--> BaseWidget.render 엣지가 있어야 한다');
    assert.equal(edge.confidence, 0.95, 'confidence(이름 해석)는 캡과 무관하게 유지된다');
    assert.equal(edge.resolution, 'dynamic', 'BaseWidget.render는 FancyWidget.render의 override 대상이라 dynamic으로 캡돼야 한다');
  });

  it('makeOne()의 new BaseWidget()은 INSTANTIATES로 해소되고, 클래스 자신은 override 대상이 아니라 캡되지 않는다', async () => {
    const baseWidget = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'BaseWidget', type: 'Type' } });
    const makeOne = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'makeOne' } });
    const edge = await edgeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'INSTANTIATES', src_id: makeOne.id, dst_id: baseWidget.id } });
    assert.ok(edge);
    assert.equal(edge.confidence, 0.95);
    assert.equal(edge.resolution, 'name_match', 'BaseWidget 클래스 자신은 OVERRIDES 참여자가 아니므로 dynamic으로 캡되면 안 된다');
  });

  it('summary 카운트: OVERRIDES 1개, dynamic 캡 1개(이 그래프의 유일한 CALLS 엣지)', () => {
    assert.equal(summary.overridesEdges, 1);
    assert.equal(summary.dynamicCappedEdges, 1);
  });
});

describe('resolveCrossFileEdges — reverse_edge_index 영속화 + 중복제거', () => {
  it('같은 (dst_symbol_id, src_file_id) 쌍을 향한 서로 다른 엣지(IMPORTS + INSTANTIATES)는 reverse_edge_index 행 1개로 합쳐진다', async () => {
    const consumerFile = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: 'consumer.ts' } });
    const baseWidget = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'BaseWidget', type: 'Type' } });
    const rows = await reverseIndexRepo.find({
      where: { graph_id: GRAPH_ID, dst_symbol_id: baseWidget.symbol_id, src_file_id: consumerFile.id },
    });
    assert.equal(rows.length, 1, 'consumer.ts -> BaseWidget을 향한 IMPORTS/INSTANTIATES 두 엣지가 reverse_edge_index에서는 중복 없이 한 행으로 합쳐져야 한다');
  });

  it('다른 심볼(BaseWidget.render)을 향한 엣지는 별도 reverse_edge_index 행을 남긴다', async () => {
    const consumerFile = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: 'consumer.ts' } });
    const baseRender = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, qualified_name: 'BaseWidget.render' } });
    const rows = await reverseIndexRepo.find({
      where: { graph_id: GRAPH_ID, dst_symbol_id: baseRender.symbol_id, src_file_id: consumerFile.id },
    });
    assert.equal(rows.length, 1);
  });
});

describe('resolveCrossFileEdges — 그래프 밖 참조는 추측 없이 미해소로 남는다', () => {
  it('그래프에 없는 파일을 향한 import는 엣지를 만들지 않고 unresolvedImports에 집계된다', async () => {
    const orphanFile = await nodeRepo.findOne({ where: { graph_id: GRAPH_ID, type: 'File', path: 'orphan.ts' } });
    const importEdges = await edgeRepo.find({ where: { graph_id: GRAPH_ID, type: 'IMPORTS', src_id: orphanFile.id } });
    assert.deepEqual(importEdges, []);
    assert.ok(summary.unresolvedImports >= 1);
  });

  it('해소 안 되는 qualifier를 통한 참조는 엣지를 만들지 않고 unresolvedRefs에 집계된다', () => {
    assert.ok(summary.unresolvedRefs >= 1);
  });
});
