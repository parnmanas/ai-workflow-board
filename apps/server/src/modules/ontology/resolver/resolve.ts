// Tier 1.5 크로스파일 리졸버(ticket e52e7f64, DESIGN.md 축 1/4) —
// persist.ts(ticket e14ef1c9)가 File 노드 props에 durable하게 남겨둔
// refs[]/imports[]/heritage[]를 신뢰도 캐스케이드(cascade.ts)로 해소해
// IMPORTS/CALLS/INSTANTIATES/USES_TYPE/REFERENCES/EXTENDS/IMPLEMENTS
// 엣지를 만들고, reverse_edge_index를 채운다. Tier 1.5 자체가 "a separate,
// whole-workspace pass"로 설계돼 있어(DESIGN.md 축 1) 이 그래프의 노드
// 전체를 메모리에 올린다 — persist.ts와 마찬가지로 청크 insert +
// 명시적 매크로태스크 양보 계약을 그대로 재사용한다(insertChunked/
// yieldToEventLoop, persist.ts에서 import).
import { randomUUID } from 'node:crypto';
import { In, type DataSource } from 'typeorm';
import { OntologyEdge, type OntologyEdgeResolution } from '../../../entities/OntologyEdge';
import { OntologyReverseEdgeIndex } from '../../../entities/OntologyReverseEdgeIndex';
import { insertChunked, yieldToEventLoop } from '../persist';
import { buildGraphSymbolIndex, type DefNodeInfo, type GraphSymbolIndex } from './symbol-index';
import { resolveImportFactExact, resolveImportFactSuffix, resolveName, resolveRef, type CascadeResult } from './cascade';
import { deriveOverridesAndCapDynamicDispatch, type ExistingEdgeSnapshot, type ExistingEdges } from './polymorphic-cap';
import type { RefFact } from '../extraction/types';

const EDGE_CHUNK_SIZE = 500; // persist.ts 선례(NODE_CHUNK_SIZE/EDGE_CHUNK_SIZE)와 같은 값 — sql.js 표현식-트리 깊이 상한 아래로 여유있게.
const REVERSE_INDEX_CHUNK_SIZE = 500;

const CALL_SHAPE_TO_EDGE_TYPE: Record<RefFact['callShape'], string> = {
  call: 'CALLS',
  new: 'INSTANTIATES',
  type: 'USES_TYPE',
  value: 'REFERENCES',
};

export interface ResolveCrossFileEdgesInput {
  graphId: string;
  workspaceId: string;
  /** persist.ts와 동일 — 이 리졸버 실행이 대상으로 삼은 커밋 sha. */
  commit: string;
  extractionRunId: string;
}

export interface ResolveSummary {
  filesProcessed: number;
  edgesInserted: number;
  importsEdges: number;
  refEdgesByType: Record<string, number>;
  heritageEdges: number;
  overridesEdges: number;
  /** OVERRIDES/IMPLEMENTS 형제를 가진 CALLS 타겟이라 resolution='dynamic'으로
   *  캡된 엣지 수(REVIEW-NOTES.md I5, 후처리 조인). */
  dynamicCappedEdges: number;
  reverseIndexRows: number;
  unresolvedImports: number;
  unresolvedRefs: number;
  unresolvedHeritage: number;
  durationMs: number;
}

function baseEdgeFields(input: ResolveCrossFileEdgesInput) {
  return {
    workspace_id: input.workspaceId,
    graph_id: input.graphId,
    layer: 'structural' as const,
    confidence_method: 'constant' as const, // 캐스케이드 confidence는 tier별 고정값 — persist.ts DECORATES와 같은 자세(Tier 3의 "계산된, 자가보고 아님" 요구는 여기 해당 없음)
    support: null,
    call_count: null,
    evidence_kind: 'parser' as const,
    evidence_ref: '[]',
    rank: 'normal' as const,
    completeness: 'no_assertion' as const,
    extraction_run_id: input.extractionRunId,
    model_id: null,
    prompt_version: null,
    first_seen_commit: input.commit,
    last_seen_commit: input.commit,
    valid_from_commit: input.commit,
    valid_to_commit: null,
    status: 'active' as const,
  };
}

function toExistingSnapshot(e: OntologyEdge): ExistingEdgeSnapshot {
  return { id: e.id, src_id: e.src_id, dst_id: e.dst_id, confidence: e.confidence, resolution: e.resolution };
}

function findContainingDef(fileDefs: DefNodeInfo[], line: number): DefNodeInfo | null {
  let best: DefNodeInfo | null = null;
  for (const d of fileDefs) {
    if (d.startLine === null || d.endLine === null) continue;
    if (line < d.startLine || line > d.endLine) continue;
    if (!best || d.endLine - d.startLine < best.endLine! - best.startLine!) best = d;
  }
  return best;
}

/** DESIGN.md 축 1/4, REVIEW-NOTES.md S6/I5/I7 — 완료조건 1/2/3의 실행
 *  경로. graph_id 하나의 File/Def 노드 전체를 메모리 인덱스로 올린 뒤
 *  imports[]/refs[]/heritage[]를 캐스케이드로 해소하고, 클래스 계층에서
 *  OVERRIDES를 파생시켜 polymorphic CALLS 타겟을 dynamic으로 캡한다. */
export async function resolveCrossFileEdges(dataSource: DataSource, input: ResolveCrossFileEdgesInput): Promise<ResolveSummary> {
  const startedAt = Date.now();
  const index = await buildGraphSymbolIndex(dataSource, input.graphId);
  const base = baseEdgeFields(input);

  const edgeRows: OntologyEdge[] = [];
  const reverseIndexByKey = new Map<string, OntologyReverseEdgeIndex>();
  const refEdgesByType: Record<string, number> = { CALLS: 0, INSTANTIATES: 0, USES_TYPE: 0, REFERENCES: 0 };
  let importsEdges = 0;
  let heritageEdges = 0;
  let unresolvedImports = 0;
  let unresolvedRefs = 0;
  let unresolvedHeritage = 0;

  function recordReverseIndex(srcFileId: string, dstSymbolId: string): void {
    const key = JSON.stringify([dstSymbolId, srcFileId]); // symbol_id/file id 문자열이 임의 구두점을 포함할 수 있어 델리미터 충돌 없는 튜플 인코딩 사용
    if (!reverseIndexByKey.has(key)) {
      reverseIndexByKey.set(key, {
        id: randomUUID(),
        graph_id: input.graphId,
        dst_symbol_id: dstSymbolId,
        src_file_id: srcFileId,
      } as OntologyReverseEdgeIndex);
    }
  }

  function pushEdge(type: string, srcId: string, result: CascadeResult, srcFileId: string): void {
    edgeRows.push({
      id: randomUUID(),
      ...base,
      src_id: srcId,
      dst_id: result.nodeId,
      type,
      confidence: result.confidence,
      resolution: 'name_match' as OntologyEdgeResolution,
      props: JSON.stringify({ resolver: result.resolver }),
    } as OntologyEdge);
    recordReverseIndex(srcFileId, result.symbolId);
  }

  for (const fileInfo of index.filesByPath.values()) {
    // ── imports[] -> IMPORTS ──
    for (const imp of fileInfo.facts.imports) {
      const result = resolveImportFactExact(index, fileInfo, imp) ?? resolveImportFactSuffix(index, fileInfo, imp);
      if (!result) {
        unresolvedImports += 1;
        continue;
      }
      pushEdge('IMPORTS', fileInfo.id, result, fileInfo.id);
      importsEdges += 1;
    }

    // ── refs[] -> CALLS/INSTANTIATES/USES_TYPE/REFERENCES ──
    const fileDefs = index.defsByFilePath.get(fileInfo.path) ?? [];
    for (const ref of fileInfo.facts.refs) {
      const result = resolveRef(index, fileInfo, ref);
      if (!result) {
        unresolvedRefs += 1;
        continue;
      }
      // 'new' 타겟은 항상 클래스여야 한다 — 다른 kind로 잘못 해소됐으면
      // 엣지를 만들지 않는다(정확한 대상보다 미해소를 택하는 원칙,
      // cascade.ts와 동일).
      if (ref.callShape === 'new') {
        const targetNode = index.nodeById.get(result.nodeId);
        if (!targetNode || (targetNode as DefNodeInfo).type !== 'Type') {
          unresolvedRefs += 1;
          continue;
        }
      }
      const srcDef = findContainingDef(fileDefs, ref.startLine);
      const srcId = srcDef ? srcDef.id : fileInfo.id;
      const edgeType = CALL_SHAPE_TO_EDGE_TYPE[ref.callShape] ?? 'REFERENCES';
      pushEdge(edgeType, srcId, result, fileInfo.id);
      refEdgesByType[edgeType] = (refEdgesByType[edgeType] ?? 0) + 1;
    }

    // ── heritage[] -> EXTENDS/IMPLEMENTS ──
    for (const h of fileInfo.facts.heritage) {
      const result = resolveName(index, fileInfo, h.targetName, null);
      const targetNode = result ? index.nodeById.get(result.nodeId) : null;
      if (!result || !targetNode || (targetNode as DefNodeInfo).type !== 'Type') {
        unresolvedHeritage += 1;
        continue;
      }
      const ofDef = fileDefs.find((d) => d.qualifiedName === h.ofQualifiedName);
      if (!ofDef) {
        unresolvedHeritage += 1;
        continue;
      }
      pushEdge(h.relation === 'extends' ? 'EXTENDS' : 'IMPLEMENTS', ofDef.id, result, fileInfo.id);
      heritageEdges += 1;
    }

    await yieldToEventLoop(); // 파일 단위 순회 — persist.ts와 같은 명시적 매크로태스크 양보 계약
  }

  // ── OVERRIDES 파생 + polymorphic dispatch cap(REVIEW-NOTES.md I5) —
  // 별도 파일(polymorphic-cap.ts)의 순수 함수. 이번 실행에서 새로 만든
  // heritage/CALLS(edgeRows)뿐 아니라, SCIP 등 이 리졸버 바깥 경로로 이미
  // graph_id에 저장된 EXTENDS/IMPLEMENTS/OVERRIDES/활성 CALLS도 함께
  // 조회해 캡 판단에 합류시킨다(리뷰 지적 — "어느 tier가 매칭했든" 계약은
  // edgeRows만 봐서는 지켜지지 않는다, SCIP는 이 루프를 아예 거치지 않는
  // 별도 쓰기 경로다). ──
  const edgeRepo = dataSource.getRepository(OntologyEdge);
  const existing: ExistingEdges = {
    heritage: (await edgeRepo.find({ where: { graph_id: input.graphId, type: In(['EXTENDS', 'IMPLEMENTS']) } })).map(toExistingSnapshot),
    overrides: (await edgeRepo.find({ where: { graph_id: input.graphId, type: 'OVERRIDES' } })).map(toExistingSnapshot),
    calls: (await edgeRepo.find({ where: { graph_id: input.graphId, type: 'CALLS', status: 'active' } })).map(toExistingSnapshot),
  };
  const { overridesEdges, dynamicCappedEdges, existingCallsIdsToCapDynamic } = deriveOverridesAndCapDynamicDispatch(
    index,
    edgeRows,
    base,
    existing,
  );

  await insertChunked(edgeRepo, edgeRows, EDGE_CHUNK_SIZE);
  if (existingCallsIdsToCapDynamic.length > 0) {
    await edgeRepo.update({ id: In(existingCallsIdsToCapDynamic) }, { resolution: 'dynamic' });
  }
  const reverseIndexRows = [...reverseIndexByKey.values()];
  await insertChunked(dataSource.getRepository(OntologyReverseEdgeIndex), reverseIndexRows, REVERSE_INDEX_CHUNK_SIZE);

  return {
    filesProcessed: index.filesByPath.size,
    edgesInserted: edgeRows.length,
    importsEdges,
    refEdgesByType,
    heritageEdges,
    overridesEdges,
    dynamicCappedEdges,
    reverseIndexRows: reverseIndexRows.length,
    unresolvedImports,
    unresolvedRefs,
    unresolvedHeritage,
    durationMs: Date.now() - startedAt,
  };
}
