// Polymorphic dispatch cap(ticket e52e7f64, DESIGN.md 축 1/2 —
// REVIEW-NOTES.md I5). resolve.ts에서 분리한 순수 함수 — DB/DataSource
// 의존이 전혀 없다(GraphSymbolIndex.membersByContainerId, 이미 메모리에
// 구성된 edgeRows, 그리고 resolve.ts가 미리 조회해 건네주는 기존 DB 엣지
// 스냅샷만 읽고 쓴다). resolve.ts의 나머지 부분(DB 조회, 청크 insert)과
// 섞이면 "OVERRIDES 파생→CALLS 캡" 로직만 단위테스트하기 위해 매번 임시
// sql.js DataSource를 띄워야 했을 것 — 그 비용 없이 직접 테스트하기 위해
// 이 파일로 뺐다(완료조건 3: "polymorphic dispatch 캡 로직 단위테스트").
//
// 리뷰 지적(1라운드, 블로커) — 이번 실행에서 새로 만든 edgeRows만 보면
// SCIP(Tier 2) 등 이 리졸버의 imports[]/refs[]/heritage[] 루프를 거치지
// 않고 별도 경로로 이미 graph_id에 저장된 CALLS/OVERRIDES/EXTENDS/
// IMPLEMENTS를 절대 캡할 수 없다 — "어느 tier(SCIP 포함)가 매칭했든 캡"
// 계약 위반. `existing` 파라미터로 graph_id 범위의 기존 활성 엣지 스냅샷을
// 함께 받아 폴리모픽 타겟 집합 계산과 캡 대상 판단 양쪽에 합류시킨다. 이
// 함수 자신은 여전히 DB에 쓰지 않는다 — `existingCallsIdsToCapDynamic`만
// 반환하고, 실제 UPDATE는 resolve.ts가 수행한다.
import { randomUUID } from 'node:crypto';
import type { OntologyEdge, OntologyEdgeResolution } from '../../../entities/OntologyEdge';
import type { DefNodeInfo, GraphSymbolIndex } from './symbol-index';

/** resolve.ts의 baseEdgeFields(input) 반환 형태 그대로 — OVERRIDES 엣지도
 *  같은 workspace_id/graph_id/layer/... 공통 필드를 쓴다. */
export type EdgeCommonFields = Omit<
  OntologyEdge,
  'id' | 'src_id' | 'dst_id' | 'type' | 'confidence' | 'resolution' | 'props' | 'created_at' | 'updated_at'
>;

/** graph_id 범위에서 이미 DB에 있는 엣지 하나를 캡 판단에 필요한 필드만
 *  추려 담은 스냅샷 — resolve.ts가 buildGraphSymbolIndex 이후 미리
 *  조회해 넘긴다(이 파일 자신은 DB를 조회하지 않는다). */
export interface ExistingEdgeSnapshot {
  id: string;
  src_id: string;
  dst_id: string;
  confidence: number;
  resolution: OntologyEdgeResolution | null;
}

export interface ExistingEdges {
  /** graph_id 범위의 기존 EXTENDS/IMPLEMENTS. */
  heritage: ExistingEdgeSnapshot[];
  /** graph_id 범위의 기존 OVERRIDES — 중복 파생 방지 + 폴리모픽 타겟 집합에 합류. */
  overrides: ExistingEdgeSnapshot[];
  /** graph_id 범위의 기존 활성(status='active') CALLS — SCIP 등 이 실행
   *  바깥에서 이미 저장된 것도 캡 대상이어야 한다. */
  calls: ExistingEdgeSnapshot[];
}

export const EMPTY_EXISTING_EDGES: ExistingEdges = { heritage: [], overrides: [], calls: [] };

export interface PolymorphicCapResult {
  overridesEdges: number;
  dynamicCappedEdges: number;
  /** 이번 실행의 edgeRows가 아니라 DB에 이미 있던 CALLS 엣지 중
   *  dynamic으로 갱신이 필요한 것들의 id — resolve.ts가 이 목록으로
   *  실제 UPDATE 문을 실행한다. */
  existingCallsIdsToCapDynamic: string[];
}

/** EXTENDS/IMPLEMENTS 위에서 같은 이름 Callable 멤버 쌍(서브클래스 멤버 ->
 *  슈퍼클래스/인터페이스 멤버)으로부터 OVERRIDES 엣지를 파생시키고, 해소된
 *  CALLS 타겟이 그 OVERRIDES 관계에 참여하면(자신이 override하거나, 자신을
 *  override하는 형제가 있거나 — 양방향) 어느 tier가 매칭했든
 *  `resolution='dynamic'`으로 캡한다. confidence(이름 해석 확신도)는 그대로
 *  둔다 — 두 축을 섞지 않는다(DESIGN.md 축 2). `edgeRows`는 in-place로
 *  변경된다(새 OVERRIDES 행 push + 대상 CALLS 행의 resolution 갱신) —
 *  resolve.ts의 기존 호출 자리(청크 insert 이전)와 같은 자세. `existing`을
 *  생략하면(기본값 EMPTY_EXISTING_EDGES) 이번 실행의 edgeRows만 보는
 *  이전 동작 그대로다. */
export function deriveOverridesAndCapDynamicDispatch(
  index: GraphSymbolIndex,
  edgeRows: OntologyEdge[],
  base: EdgeCommonFields,
  existing: ExistingEdges = EMPTY_EXISTING_EDGES,
): PolymorphicCapResult {
  let overridesEdges = 0;
  // 이미 DB에 있는 OVERRIDES 쌍(src|dst — 둘 다 OntologyNode.id, 즉 UUID라
  // 델리미터 충돌 걱정 없음)은 다시 파생하지 않는다.
  const existingOverridesPairs = new Set(existing.overrides.map((e) => `${e.src_id}|${e.dst_id}`));

  const heritageEdgesSnapshot: Array<{ src_id: string; dst_id: string; confidence: number }> = [
    ...edgeRows.filter((e) => e.type === 'EXTENDS' || e.type === 'IMPLEMENTS'),
    ...existing.heritage,
  ];
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
      if (existingOverridesPairs.has(`${subMember.id}|${superMember.id}`)) continue;
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
  for (const e of existing.overrides) {
    polymorphicTargetIds.add(e.src_id);
    polymorphicTargetIds.add(e.dst_id);
  }

  let dynamicCappedEdges = 0;
  for (const e of edgeRows) {
    if (e.type === 'CALLS' && polymorphicTargetIds.has(e.dst_id)) {
      e.resolution = 'dynamic';
      dynamicCappedEdges += 1;
    }
  }

  const existingCallsIdsToCapDynamic: string[] = [];
  for (const e of existing.calls) {
    if (polymorphicTargetIds.has(e.dst_id) && e.resolution !== 'dynamic') {
      existingCallsIdsToCapDynamic.push(e.id);
      dynamicCappedEdges += 1;
    }
  }

  return { overridesEdges, dynamicCappedEdges, existingCallsIdsToCapDynamic };
}
