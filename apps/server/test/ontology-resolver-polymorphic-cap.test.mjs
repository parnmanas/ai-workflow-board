// 회귀 테스트 — ticket e52e7f64 "[Ontology Graph 3/7] 크로스파일 리졸버
// (Tier 1.5)" 완료조건 3: "polymorphic dispatch 캡 로직(OVERRIDES/IMPLEMENTS
// 조인) 단위테스트."
//
// resolver/polymorphic-cap.ts의 deriveOverridesAndCapDynamicDispatch()는
// resolve.ts가 원래 인라인으로 갖고 있던 로직을 분리한 순수 함수다 —
// DataSource가 전혀 필요 없고 GraphSymbolIndex.membersByContainerId와
// 메모리 위 edgeRows 배열만 읽고 쓴다(헤더 코멘트 참고). 이 스위트는 그
// 분리 덕분에 sql.js를 띄우지 않고 이 로직만 직접 단위테스트한다 —
// resolveCrossFileEdges() 전체를 통해 이 로직이 실제로 배선되는지는
// ontology-resolver-graph-integration.test.mjs가 end-to-end로 확인한다.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요) — ontology 계열
// 테스트 전체의 관례.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const { GraphSymbolIndex } = await import('file://' + path.join(DIST_ROOT, 'modules/ontology/resolver/symbol-index.js'));
const { deriveOverridesAndCapDynamicDispatch } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/ontology/resolver/polymorphic-cap.js')
);

const BASE = {
  workspace_id: 'ws-poly-test',
  graph_id: 'graph-poly-test',
  layer: 'structural',
  confidence_method: 'constant',
  support: null,
  call_count: null,
  evidence_kind: 'parser',
  evidence_ref: '[]',
  rank: 'normal',
  completeness: 'no_assertion',
  extraction_run_id: 'poly-test-run',
  model_id: null,
  prompt_version: null,
  first_seen_commit: 'c1',
  last_seen_commit: 'c1',
  valid_from_commit: 'c1',
  valid_to_commit: null,
  status: 'active',
};

let nextId = 0;
function uid(prefix) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function makeMember(qualifiedName, opts = {}) {
  const name = opts.name ?? qualifiedName.split('.').pop();
  return {
    id: uid('def'),
    symbolId: `def:${qualifiedName}`,
    name,
    qualifiedName,
    kind: opts.kind ?? 'method',
    type: opts.type ?? 'Callable',
    path: opts.path ?? 'src/x.ts',
    startLine: 1,
    endLine: 5,
  };
}

function makeEdge(type, srcId, dstId, opts = {}) {
  return { id: uid('edge'), type, src_id: srcId, dst_id: dstId, confidence: opts.confidence ?? 0.95, resolution: opts.resolution ?? 'name_match' };
}

describe('deriveOverridesAndCapDynamicDispatch — EXTENDS 기반', () => {
  it('서브클래스가 같은 이름의 Callable 멤버로 override하면 OVERRIDES 엣지를 파생시키고, 슈퍼클래스 멤버를 향한 CALLS를 dynamic으로 캡한다', () => {
    const index = new GraphSymbolIndex();
    const baseClassId = uid('class');
    const subClassId = uid('class');
    const baseRender = makeMember('BaseWidget.render');
    const subRender = makeMember('FancyWidget.render');
    index.addDeclaresMember(baseClassId, baseRender);
    index.addDeclaresMember(subClassId, subRender);

    const extendsEdge = makeEdge('EXTENDS', subClassId, baseClassId, { confidence: 0.95 });
    const callsEdge = makeEdge('CALLS', uid('caller'), baseRender.id, { resolution: 'name_match', confidence: 0.9 });
    const edgeRows = [extendsEdge, callsEdge];

    const result = deriveOverridesAndCapDynamicDispatch(index, edgeRows, BASE);

    assert.equal(result.overridesEdges, 1);
    assert.equal(result.dynamicCappedEdges, 1);

    const overrides = edgeRows.filter((e) => e.type === 'OVERRIDES');
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].src_id, subRender.id);
    assert.equal(overrides[0].dst_id, baseRender.id);
    assert.equal(overrides[0].confidence, 0.95, 'OVERRIDES confidence는 heritage 엣지(EXTENDS)의 confidence를 물려받는다');

    assert.equal(callsEdge.resolution, 'dynamic', '슈퍼클래스 메서드를 향한 CALLS는 dynamic으로 캡돼야 한다');
    assert.equal(callsEdge.confidence, 0.9, 'confidence(이름 해석 확신도)는 캡과 무관하게 그대로 유지된다 — DESIGN.md 축 2');
  });

  it('CALLS 타겟이 서브클래스 자신의 오버라이딩 메서드여도 캡된다 (양방향 — 자신이 override하는 형제가 있으면)', () => {
    const index = new GraphSymbolIndex();
    const baseClassId = uid('class');
    const subClassId = uid('class');
    const baseRender = makeMember('BaseWidget.render');
    const subRender = makeMember('FancyWidget.render');
    index.addDeclaresMember(baseClassId, baseRender);
    index.addDeclaresMember(subClassId, subRender);

    const extendsEdge = makeEdge('EXTENDS', subClassId, baseClassId);
    // 이번엔 CALLS 타겟이 subRender(서브클래스 자신의 메서드)다.
    const callsEdge = makeEdge('CALLS', uid('caller'), subRender.id);
    const edgeRows = [extendsEdge, callsEdge];

    const result = deriveOverridesAndCapDynamicDispatch(index, edgeRows, BASE);
    assert.equal(result.dynamicCappedEdges, 1);
    assert.equal(callsEdge.resolution, 'dynamic');
  });
});

describe('deriveOverridesAndCapDynamicDispatch — IMPLEMENTS 기반', () => {
  it('인터페이스를 구현하는 메서드도 같은 방식으로 OVERRIDES + dynamic 캡을 유발한다', () => {
    const index = new GraphSymbolIndex();
    const interfaceId = uid('iface');
    const classId = uid('class');
    const ifaceMethod = makeMember('IThing.doWork');
    const implMethod = makeMember('Impl.doWork');
    index.addDeclaresMember(interfaceId, ifaceMethod);
    index.addDeclaresMember(classId, implMethod);

    const implementsEdge = makeEdge('IMPLEMENTS', classId, interfaceId);
    const callsEdge = makeEdge('CALLS', uid('caller'), ifaceMethod.id);
    const edgeRows = [implementsEdge, callsEdge];

    const result = deriveOverridesAndCapDynamicDispatch(index, edgeRows, BASE);
    assert.equal(result.overridesEdges, 1);
    assert.equal(result.dynamicCappedEdges, 1);
    assert.equal(callsEdge.resolution, 'dynamic');
  });
});

describe('deriveOverridesAndCapDynamicDispatch — 부정 케이스', () => {
  it('override 관계가 전혀 없는 CALLS 타겟은 resolution이 그대로 유지된다', () => {
    const index = new GraphSymbolIndex();
    const unrelatedMethod = makeMember('StandaloneService.run');
    const callsEdge = makeEdge('CALLS', uid('caller'), unrelatedMethod.id, { resolution: 'name_match' });
    const edgeRows = [callsEdge]; // EXTENDS/IMPLEMENTS 엣지 자체가 없음

    const result = deriveOverridesAndCapDynamicDispatch(index, edgeRows, BASE);
    assert.equal(result.overridesEdges, 0);
    assert.equal(result.dynamicCappedEdges, 0);
    assert.equal(callsEdge.resolution, 'name_match', '무관한 CALLS는 건드리지 않아야 한다');
  });

  it('서브/슈퍼 컨테이너 중 한쪽이라도 DECLARES 멤버가 없으면 OVERRIDES를 만들지 않는다', () => {
    const index = new GraphSymbolIndex();
    const baseClassId = uid('class');
    const subClassId = uid('class');
    // superMembers만 등록하고 subMembers는 비워둔다.
    index.addDeclaresMember(baseClassId, makeMember('BaseWidget.render'));

    const extendsEdge = makeEdge('EXTENDS', subClassId, baseClassId);
    const edgeRows = [extendsEdge];

    const result = deriveOverridesAndCapDynamicDispatch(index, edgeRows, BASE);
    assert.equal(result.overridesEdges, 0);
    assert.equal(result.dynamicCappedEdges, 0);
  });

  it('이름이 같아도 Callable이 아닌 멤버(Field)는 OVERRIDES로 파생되지 않는다', () => {
    const index = new GraphSymbolIndex();
    const baseClassId = uid('class');
    const subClassId = uid('class');
    const baseField = makeMember('Base.value', { type: 'Field', kind: 'field' });
    const subField = makeMember('Sub.value', { type: 'Field', kind: 'field' });
    index.addDeclaresMember(baseClassId, baseField);
    index.addDeclaresMember(subClassId, subField);

    const extendsEdge = makeEdge('EXTENDS', subClassId, baseClassId);
    const edgeRows = [extendsEdge];

    const result = deriveOverridesAndCapDynamicDispatch(index, edgeRows, BASE);
    assert.equal(result.overridesEdges, 0, 'Field 동명 멤버는 override 파생 대상이 아니다(Callable 전용)');
  });

  it('슈퍼클래스에 없는 이름의 서브클래스 메서드는 override로 파생되지 않는다', () => {
    const index = new GraphSymbolIndex();
    const baseClassId = uid('class');
    const subClassId = uid('class');
    index.addDeclaresMember(baseClassId, makeMember('Base.renderA'));
    index.addDeclaresMember(subClassId, makeMember('Sub.renderB')); // 이름이 다름

    const extendsEdge = makeEdge('EXTENDS', subClassId, baseClassId);
    const edgeRows = [extendsEdge];

    const result = deriveOverridesAndCapDynamicDispatch(index, edgeRows, BASE);
    assert.equal(result.overridesEdges, 0);
  });
});

describe('deriveOverridesAndCapDynamicDispatch — 다중 멤버', () => {
  it('여러 메서드가 동시에 override되면 각각 OVERRIDES가 파생되고, 그 중 CALLS된 것만 캡된다', () => {
    const index = new GraphSymbolIndex();
    const baseClassId = uid('class');
    const subClassId = uid('class');
    const baseRender = makeMember('Base.render');
    const baseDestroy = makeMember('Base.destroy');
    const subRender = makeMember('Sub.render');
    const subDestroy = makeMember('Sub.destroy');
    index.addDeclaresMember(baseClassId, baseRender);
    index.addDeclaresMember(baseClassId, baseDestroy);
    index.addDeclaresMember(subClassId, subRender);
    index.addDeclaresMember(subClassId, subDestroy);

    const extendsEdge = makeEdge('EXTENDS', subClassId, baseClassId);
    // render만 실제로 호출된다 — destroy는 override는 되지만 CALLS 대상이 아니다.
    const callsRender = makeEdge('CALLS', uid('caller'), baseRender.id);
    const edgeRows = [extendsEdge, callsRender];

    const result = deriveOverridesAndCapDynamicDispatch(index, edgeRows, BASE);
    assert.equal(result.overridesEdges, 2, 'render/destroy 둘 다 OVERRIDES로 파생돼야 한다');
    assert.equal(result.dynamicCappedEdges, 1, 'CALLS가 실제로 존재하는 render만 캡 대상이다');
    assert.equal(callsRender.resolution, 'dynamic');
  });
});
