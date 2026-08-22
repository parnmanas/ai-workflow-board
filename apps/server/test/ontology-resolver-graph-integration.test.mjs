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
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ontology-resolver-integration-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'primary.db');
process.env.SQLJS_ONTOLOGY_DB_PATH = path.join(tmpDir, 'ontology.db');
process.env.NODE_ENV = 'test';

const { extractFile } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/extraction/extract-file.js'));
const { persistFactBundles, updateChunked } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/persist.js'));
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

describe('resolveCrossFileEdges — 리뷰 지적(1라운드, 블로커): 이 실행 바깥에서 이미 저장된 CALLS(SCIP 등)도 캡 대상이다', () => {
  const SCIP_GRAPH_ID = 'resolver-existing-scip-calls-graph';
  let scipCallsEdgeId;
  let scipSummary;

  before(async () => {
    const scipFixtures = [
      { path: 'scip/base.ts', src: `\nexport class Base {\n  render() {}\n}\n` },
      { path: 'scip/sub.ts', src: `\nimport { Base } from './base';\n\nexport class Sub extends Base {\n  render() {}\n}\n` },
    ];
    const bundles = [];
    for (const fx of scipFixtures) {
      const bundle = await extractFile(fx.path, fx.src, 'typescript');
      assert.equal(bundle.hasParseError, false, `${fx.path} 픽스처가 파싱 에러 없이 파싱돼야 한다`);
      bundle.fileHash = `hash-${fx.path}`;
      bundles.push(bundle);
    }
    await persistFactBundles(AppOntologyDataSource, {
      graphId: SCIP_GRAPH_ID,
      workspaceId: 'resolver-scip-ws',
      resourceId: 'resolver-scip-resource',
      folderPath: '',
      commit: 'scip-commit',
      extractionRunId: 'scip-extraction-run-1',
      bundles,
      decoratorFactsByPath: new Map(),
    });

    const subFile = await nodeRepo.findOne({ where: { graph_id: SCIP_GRAPH_ID, type: 'File', path: 'scip/sub.ts' } });
    const baseRender = await nodeRepo.findOne({ where: { graph_id: SCIP_GRAPH_ID, qualified_name: 'Base.render' } });
    assert.ok(subFile);
    assert.ok(baseRender);

    // SCIP(Tier 2) 스타일로 이미 정밀 해소돼 저장된 CALLS 엣지를 resolve.ts의
    // imports[]/refs[]/heritage[] 루프를 거치지 않고 직접 삽입한다 — src_id는
    // 실제 호출부가 아니어도 무방하다(OntologyEdge는 src_id/dst_id에 DB 레벨
    // FK가 없다, 엔티티 헤더 코멘트 참고). 이 테스트가 검증하려는 것은 오직
    // "이 리졸버 실행 바깥에서 이미 저장된 CALLS도 캡되는가"이다.
    scipCallsEdgeId = randomUUID();
    await edgeRepo.save({
      id: scipCallsEdgeId,
      workspace_id: 'resolver-scip-ws',
      graph_id: SCIP_GRAPH_ID,
      src_id: subFile.id,
      dst_id: baseRender.id,
      type: 'CALLS',
      layer: 'structural',
      confidence: 1.0,
      confidence_method: 'constant',
      support: null,
      call_count: null,
      evidence_kind: 'indexer',
      evidence_ref: '[]',
      rank: 'normal',
      completeness: 'no_assertion',
      extraction_run_id: 'scip-simulated-run',
      model_id: null,
      prompt_version: null,
      first_seen_commit: 'scip-commit',
      last_seen_commit: 'scip-commit',
      valid_from_commit: 'scip-commit',
      valid_to_commit: null,
      status: 'active',
      props: '{}',
    });

    scipSummary = await resolveCrossFileEdges(AppOntologyDataSource, {
      graphId: SCIP_GRAPH_ID,
      workspaceId: 'resolver-scip-ws',
      commit: 'scip-commit',
      extractionRunId: 'scip-resolve-run-1',
    });
  });

  it('Sub extends Base + render 오버라이드로 OVERRIDES가 이번 실행에서 파생된다(사전조건 확인)', async () => {
    const subRender = await nodeRepo.findOne({ where: { graph_id: SCIP_GRAPH_ID, qualified_name: 'Sub.render' } });
    const baseRender = await nodeRepo.findOne({ where: { graph_id: SCIP_GRAPH_ID, qualified_name: 'Base.render' } });
    const overrides = await edgeRepo.findOne({
      where: { graph_id: SCIP_GRAPH_ID, type: 'OVERRIDES', src_id: subRender.id, dst_id: baseRender.id },
    });
    assert.ok(overrides, 'Sub.render -> Base.render OVERRIDES가 이 실행에서 새로 파생돼야 한다');
  });

  it('resolve.ts의 refs[] 루프가 아니라 사전에 직접 삽입한 SCIP 스타일 CALLS(resolution=exact)가 dynamic으로 갱신된다', async () => {
    const updated = await edgeRepo.findOne({ where: { id: scipCallsEdgeId } });
    assert.ok(updated);
    assert.equal(updated.resolution, 'dynamic', '이 실행 바깥(SCIP 등)에서 이미 저장된 CALLS도 폴리모픽 타겟이면 dynamic으로 캡돼야 한다');
    assert.equal(updated.confidence, 1.0, 'confidence(이름 해석 확신도)는 캡과 무관하게 원래 값(SCIP의 1.0)을 유지해야 한다');
  });

  it('summary.dynamicCappedEdges에도 기존 DB CALLS의 캡이 반영된다', () => {
    assert.ok(scipSummary.dynamicCappedEdges >= 1, '기존에 저장돼 있던 CALLS의 캡도 summary 카운트에 반영돼야 한다');
  });
});

describe('resolveCrossFileEdges — 리뷰 지적(2라운드, 블로커1): removed 상태의 heritage/OVERRIDES는 폴리모픽 캡 대상에서 제외된다', () => {
  const STATUS_GRAPH_ID = 'resolver-status-filter-graph';
  let removedOverridesCallsId;
  let removedHeritageCallsId;
  let activeControlCallsId;

  function edgeRow(overrides) {
    return {
      id: randomUUID(),
      workspace_id: 'resolver-status-filter-ws',
      graph_id: STATUS_GRAPH_ID,
      layer: 'structural',
      confidence: 0.95,
      confidence_method: 'constant',
      support: null,
      call_count: null,
      evidence_kind: 'parser',
      evidence_ref: '[]',
      rank: 'normal',
      completeness: 'no_assertion',
      extraction_run_id: 'status-filter-run',
      model_id: null,
      prompt_version: null,
      first_seen_commit: 'c1',
      last_seen_commit: 'c1',
      valid_from_commit: 'c1',
      valid_to_commit: null,
      status: 'active',
      props: '{}',
      resolution: null,
      ...overrides,
    };
  }

  before(async () => {
    // 이 그래프에는 File 노드를 전혀 만들지 않는다(persistFactBundles 미호출)
    // — resolveCrossFileEdges의 파일 순회는 0회라 edgeRows=[](이번 실행이
    // 새로 만드는 heritage/CALLS가 전혀 없음). 아래 세 시나리오는 전부
    // 기존 DB 엣지(existing.*) 조회 경로만으로 구성된다 — status 필터
    // 자체를 직접 겨냥한다.

    // (1) 이미 removed된 OVERRIDES — 대상을 향한 활성 CALLS는 캡되면 안 된다.
    const removedOverridesDst = randomUUID(); // "이미 삭제된 override 대상" 역할
    await edgeRepo.save(edgeRow({ src_id: randomUUID(), dst_id: removedOverridesDst, type: 'OVERRIDES', status: 'removed' }));
    removedOverridesCallsId = randomUUID();
    await edgeRepo.save(
      edgeRow({ id: removedOverridesCallsId, src_id: randomUUID(), dst_id: removedOverridesDst, type: 'CALLS', resolution: 'exact', evidence_kind: 'indexer' }),
    );

    // (2) 이미 removed된 EXTENDS(heritage) — 새 OVERRIDES 파생에 기여하지
    // 않아야 하고, 그 대상을 향한 활성 CALLS도 캡되면 안 된다.
    const removedHeritageSuper = randomUUID(); // "상속 관계가 이미 끊긴" 슈퍼클래스 역할
    await edgeRepo.save(edgeRow({ src_id: randomUUID(), dst_id: removedHeritageSuper, type: 'EXTENDS', status: 'removed' }));
    removedHeritageCallsId = randomUUID();
    await edgeRepo.save(
      edgeRow({ id: removedHeritageCallsId, src_id: randomUUID(), dst_id: removedHeritageSuper, type: 'CALLS', resolution: 'exact', evidence_kind: 'indexer' }),
    );

    // (대조군) 같은 그래프 안에서 ACTIVE OVERRIDES는 여전히 캡을 유발해야
    // 한다 — 양성 대조 없이는 "아무것도 캡되지 않는 버그"와 구분할 수 없다.
    const activeSuper = randomUUID();
    await edgeRepo.save(edgeRow({ src_id: randomUUID(), dst_id: activeSuper, type: 'OVERRIDES', status: 'active' }));
    activeControlCallsId = randomUUID();
    await edgeRepo.save(
      edgeRow({ id: activeControlCallsId, src_id: randomUUID(), dst_id: activeSuper, type: 'CALLS', resolution: 'exact', evidence_kind: 'indexer' }),
    );

    await resolveCrossFileEdges(AppOntologyDataSource, {
      graphId: STATUS_GRAPH_ID,
      workspaceId: 'resolver-status-filter-ws',
      commit: 'c1',
      extractionRunId: 'status-filter-resolve-run',
    });
  });

  it('removed 상태의 OVERRIDES는 폴리모픽 타겟에서 제외돼, 그 대상을 향한 활성 exact CALLS가 dynamic으로 바뀌지 않는다', async () => {
    const edge = await edgeRepo.findOne({ where: { id: removedOverridesCallsId } });
    assert.equal(edge.resolution, 'exact', 'removed OVERRIDES는 이제 없는 관계로 취급돼야 한다');
  });

  it('removed 상태의 EXTENDS(heritage)는 새 OVERRIDES 파생에 기여하지 않아, 그 대상을 향한 활성 exact CALLS가 dynamic으로 바뀌지 않는다', async () => {
    const edge = await edgeRepo.findOne({ where: { id: removedHeritageCallsId } });
    assert.equal(edge.resolution, 'exact');
  });

  it('(대조군) 같은 그래프의 ACTIVE OVERRIDES는 여전히 CALLS를 dynamic으로 캡한다 — 위 두 케이스가 전체 캡 로직 무력화가 아님을 증명', async () => {
    const edge = await edgeRepo.findOne({ where: { id: activeControlCallsId } });
    assert.equal(edge.resolution, 'dynamic');
  });
});

describe('updateChunked — 리뷰 지적(2라운드, 블로커2): 대량 CALLS 갱신이 단일 IN(...) 문 하나로 몰리지 않는다', () => {
  const CHUNK_GRAPH_ID = 'resolver-chunked-update-graph';
  const CALL_COUNT = 7;
  let callIds = [];

  before(async () => {
    callIds = [];
    for (let i = 0; i < CALL_COUNT; i++) {
      const id = randomUUID();
      callIds.push(id);
      await edgeRepo.save({
        id,
        workspace_id: 'resolver-chunk-ws',
        graph_id: CHUNK_GRAPH_ID,
        src_id: randomUUID(),
        dst_id: randomUUID(),
        type: 'CALLS',
        layer: 'structural',
        confidence: 1.0,
        confidence_method: 'constant',
        support: null,
        call_count: null,
        evidence_kind: 'indexer',
        evidence_ref: '[]',
        rank: 'normal',
        completeness: 'no_assertion',
        extraction_run_id: 'chunk-test-run',
        model_id: null,
        prompt_version: null,
        first_seen_commit: 'c1',
        last_seen_commit: 'c1',
        valid_from_commit: 'c1',
        valid_to_commit: null,
        status: 'active',
        props: '{}',
        resolution: 'exact',
      });
    }
  });

  it('작은 chunkSize(2)를 주입해도 7개 id 전부가(4개의 개별 UPDATE 문에 걸쳐) resolution=dynamic으로 갱신된다', async () => {
    await updateChunked(edgeRepo, callIds, 2, { resolution: 'dynamic' });
    const rows = await edgeRepo.find({ where: { graph_id: CHUNK_GRAPH_ID, type: 'CALLS' } });
    assert.equal(rows.length, CALL_COUNT);
    for (const row of rows) assert.equal(row.resolution, 'dynamic', `id=${row.id}는 dynamic으로 갱신돼야 한다`);
  });

  it('빈 id 배열이면 아무 것도 하지 않는다(no-op, 에러 없음)', async () => {
    await updateChunked(edgeRepo, [], 2, { resolution: 'dynamic' });
  });
});
