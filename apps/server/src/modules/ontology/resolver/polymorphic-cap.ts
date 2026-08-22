// Polymorphic dispatch cap(ticket e52e7f64, DESIGN.md 축 1/2 —
// REVIEW-NOTES.md I5). resolve.ts에서 분리한 순수 함수 — DB/DataSource
// 의존이 전혀 없다(GraphSymbolIndex.membersByContainerId와 이미 메모리에
// 구성된 edgeRows만 읽고 쓴다). resolve.ts의 나머지 부분(DB 조회, 청크
// insert)과 섞이면 "OVERRIDES 파생→CALLS 캡" 로직만 단위테스트하기 위해
// 매번 임시 sql.js DataSource를 띄워야 했을 것 — 그 비용 없이 직접
// 테스트하기 위해 이 파일로 뺐다(완료조건 3: "polymorphic dispatch 캡
// 로직 단위테스트").
import { randomUUID } from 'node:crypto';
import type { OntologyEdge, OntologyEdgeResolution } from '../../../entities/OntologyEdge';
import type { DefNodeInfo, GraphSymbolIndex } from './symbol-index';

/** resolve.ts의 baseEdgeFields(input) 반환 형태 그대로 — OVERRIDES 엣지도
 *  같은 workspace_id/graph_id/layer/... 공통 필드를 쓴다. */
export type EdgeCommonFields = Omit<
  OntologyEdge,
  'id' | 'src_id' | 'dst_id' | 'type' | 'confidence' | 'resolution' | 'props' | 'created_at' | 'updated_at'
>;

export interface PolymorphicCapResult {
  overridesEdges: number;
  dynamicCappedEdges: number;
}

/** EXTENDS/IMPLEMENTS 위에서 같은 이름 Callable 멤버 쌍(서브클래스 멤버 ->
 *  슈퍼클래스/인터페이스 멤버)으로부터 OVERRIDES 엣지를 파생시키고, 해소된
 *  CALLS 타겟이 그 OVERRIDES 관계에 참여하면(자신이 override하거나, 자신을
 *  override하는 형제가 있거나 — 양방향) 어느 tier가 매칭했든
 *  `resolution='dynamic'`으로 캡한다. confidence(이름 해석 확신도)는 그대로
 *  둔다 — 두 축을 섞지 않는다(DESIGN.md 축 2). `edgeRows`는 in-place로
 *  변경된다(새 OVERRIDES 행 push + 대상 CALLS 행의 resolution 갱신) —
 *  resolve.ts의 기존 호출 자리(청크 insert 이전)와 같은 자세. */
export function deriveOverridesAndCapDynamicDispatch(
  index: GraphSymbolIndex,
  edgeRows: OntologyEdge[],
  base: EdgeCommonFields,
): PolymorphicCapResult {
  let overridesEdges = 0;
  const heritageEdgesSnapshot = edgeRows.filter((e) => e.type === 'EXTENDS' || e.type === 'IMPLEMENTS');
  for (const hEdge of heritageEdgesSnapshot) {
    const subMembers = index.membersByContainerId.get(hEdge.src_id) ?? [];
    const superMembers = index.membersByContainerId.get(hEdge.dst_id) ?? [];
    if (subMembers.length === 0 || superMembers.length === 0) continue;
    const superByName = new Map(
      superMembers.filter((m: DefNodeInfo) => m.type === 'Callable').map((m: DefNodeInfo) => [m.name, m] as const),
    );
    for (const subMember of subMembers) {
      if (subMember.type !== 'Callable') continue;
      const superMember = superByName.get(subMember.name);
      if (!superMember) continue;
      edgeRows.push({
        id: randomUUID(),
        ...base,
        src_id: subMember.id,
        dst_id: superMember.id,
        type: 'OVERRIDES',
        confidence: hEdge.confidence,
        resolution: 'name_match' as OntologyEdgeResolution,
        props: JSON.stringify({ resolver: 'heritage-derived' }),
      } as OntologyEdge);
      overridesEdges += 1;
    }
  }

  const polymorphicTargetIds = new Set<string>();
  for (const e of edgeRows) {
    if (e.type === 'OVERRIDES') {
      polymorphicTargetIds.add(e.src_id);
      polymorphicTargetIds.add(e.dst_id);
    }
  }
  let dynamicCappedEdges = 0;
  for (const e of edgeRows) {
    if (e.type === 'CALLS' && polymorphicTargetIds.has(e.dst_id)) {
      e.resolution = 'dynamic';
      dynamicCappedEdges += 1;
    }
  }

  return { overridesEdges, dynamicCappedEdges };
}
