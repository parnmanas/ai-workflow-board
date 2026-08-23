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
import { insertChunked, updateChunked, yieldToEventLoop } from '../persist';
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

// 이 리졸버(imports[]/refs[]/heritage[] 루프)가 직접 생성하는 엣지 타입 —
// CONTAINS/DECLARES/DECORATES(persist.ts)와 OVERRIDES(polymorphic-cap.ts가
// 자기 own dedup을 이미 갖고 있음, 위 참고)는 여기 없다. ticket 964014f5의
// scopeFilePaths 재해소가 "이 파일들의 기존 outgoing edge를 지우고 다시
// 만든다"고 할 때 정확히 이 목록만 지운다 — 다른 타입까지 지우면 이
// 리졸버가 소유하지 않는 데이터를 건드리게 된다.
const RESOLVER_OWNED_EDGE_TYPES = ['IMPORTS', 'CALLS', 'INSTANTIATES', 'USES_TYPE', 'REFERENCES', 'EXTENDS', 'IMPLEMENTS'];

export interface ResolveCrossFileEdgesInput {
  graphId: string;
  workspaceId: string;
  /** persist.ts와 동일 — 이 리졸버 실행이 대상으로 삼은 커밋 sha. */
  commit: string;
  extractionRunId: string;
  /** ticket 964014f5(증분 갱신, DESIGN.md 축 4) — 지정하면 이 경로 집합에
   *  속한 파일들의 "자신의 outgoing refs"만 재해소한다(imports/refs/
   *  heritage 순회를 이 파일들로 제한). 심볼 인덱스(`buildGraphSymbolIndex`)
   *  자체는 여전히 그래프 전체로 구성한다 — 해소 **대상**(다른 파일의
   *  심볼)은 전체 그래프에서 찾아야 하고, 좁히는 것은 해소를 **시작하는**
   *  파일 쪽뿐이기 때문. 미지정(undefined) 시 기존과 동일하게 그래프
   *  전체를 훑는다(3/7의 초기 전체-그래프 해소 경로는 이 필드를 아예
   *  넘기지 않아 동작이 바이트 단위로 그대로다) — OVERRIDES 파생/폴리모픽
   *  캡(polymorphic-cap.ts)도 스코프와 무관하게 항상 전체 그래프
   *  기준이다(이미 그렇게 설계돼 있음, `index`/`existing`을 그대로 씀). */
  scopeFilePaths?: ReadonlySet<string>;
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
  const edgeRepo = dataSource.getRepository(OntologyEdge);

  // ticket 964014f5 — scopeFilePaths가 있으면(증분 Phase B 재해소) 이
  // 파일들이 "자신의 outgoing edge"로 이미 갖고 있던 이 리졸버 소유 타입
  // 엣지를 먼저 soft-delete한다. 안 그러면 아래 루프의 pushEdge()가 기존
  // DB 상태를 전혀 조회하지 않고 무조건 새 행을 push하므로(원래 "그래프
  // 전체를 처음부터" 한 번만 도는 전제였다), 여전히 똑같이 해소되는
  // ref/import/heritage마다 매 재실행마다 중복 엣지가 쌓인다.
  // reverse_edge_index도 같은 이유로 이 파일들의 src_file_id 행을 지운다
  // (자신의 doc 코멘트대로 "추출 런마다 재계산"되는 파생 색인 — 재계산
  // 전에 이전 런의 행을 남겨두면 안 됨). scopeFilePaths가 없으면(기존
  // whole-graph 호출) 이 블록은 아예 실행되지 않아 동작이 바이트 단위로
  // 그대로다.
  if (input.scopeFilePaths && input.scopeFilePaths.size > 0) {
    const scopedSrcNodeIds: string[] = [];
    const scopedFileNodeIds: string[] = [];
    for (const p of input.scopeFilePaths) {
      const f = index.filesByPath.get(p);
      if (!f) continue; // 그래프에 없는 경로(예: 스코프에 넘겼지만 아직 미추출) — 조용히 스킵
      scopedFileNodeIds.push(f.id);
      scopedSrcNodeIds.push(f.id);
      for (const d of index.defsByFilePath.get(p) ?? []) scopedSrcNodeIds.push(d.id);
    }
    // 리뷰 지적(차단) — scopedSrcNodeIds/scopedFileNodeIds는 git-diff 대량
    // 배치에서 스코프에 든 파일 수만큼 커질 수 있어, 단일 IN(...)으로
    // 몰면 SQLite/Postgres 바인드 변수 한도를 넘을 수 있다. persist.ts/
    // resolve.ts 기존 관례(insertChunked/updateChunked)와 동일하게
    // EDGE_CHUNK_SIZE로 나눠 조회/삭제하고 청크 사이 이벤트 루프를 양보한다.
    const staleOutgoingIds: string[] = [];
    for (let i = 0; i < scopedSrcNodeIds.length; i += EDGE_CHUNK_SIZE) {
      const chunk = scopedSrcNodeIds.slice(i, i + EDGE_CHUNK_SIZE);
      const rows = await edgeRepo.find({
        where: { graph_id: input.graphId, src_id: In(chunk), type: In(RESOLVER_OWNED_EDGE_TYPES), status: 'active' },
        select: ['id'],
      });
      staleOutgoingIds.push(...rows.map((e) => e.id));
      await yieldToEventLoop();
    }
    if (staleOutgoingIds.length > 0) {
      await updateChunked(edgeRepo, staleOutgoingIds, EDGE_CHUNK_SIZE, {
        status: 'removed',
        valid_to_commit: input.commit,
      });
    }

    const reverseRepoForCleanup = dataSource.getRepository(OntologyReverseEdgeIndex);
    for (let i = 0; i < scopedFileNodeIds.length; i += EDGE_CHUNK_SIZE) {
      const chunk = scopedFileNodeIds.slice(i, i + EDGE_CHUNK_SIZE);
      if (chunk.length > 0) await reverseRepoForCleanup.delete({ src_file_id: In(chunk) });
      await yieldToEventLoop();
    }
  }

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
    if (input.scopeFilePaths && !input.scopeFilePaths.has(fileInfo.path)) continue;
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
  // 별도 쓰기 경로다). 세 조회 전부 status='active'로 제한 — removed/
  // quarantined 엣지(장차 ticket #4의 증분 갱신이 soft-delete할 대상)를
  // 폴리모픽 타겟 집합에 계속 포함시키면, 이미 지워진 상속/오버라이드가
  // 활성 CALLS를 계속 dynamic으로 잘못 캡하게 된다(리뷰 지적 라운드 2).
  // edgeRepo는 함수 상단에서 이미 선언(scopeFilePaths 정리용으로 먼저
  // 필요했다) — 재선언하지 않고 그대로 재사용. ──
  const existing: ExistingEdges = {
    heritage: (
      await edgeRepo.find({ where: { graph_id: input.graphId, type: In(['EXTENDS', 'IMPLEMENTS']), status: 'active' } })
    ).map(toExistingSnapshot),
    overrides: (await edgeRepo.find({ where: { graph_id: input.graphId, type: 'OVERRIDES', status: 'active' } })).map(
      toExistingSnapshot,
    ),
    calls: (await edgeRepo.find({ where: { graph_id: input.graphId, type: 'CALLS', status: 'active' } })).map(toExistingSnapshot),
  };
  const { overridesEdges, dynamicCappedEdges, existingCallsIdsToCapDynamic } = deriveOverridesAndCapDynamicDispatch(
    index,
    edgeRows,
    base,
    existing,
  );

  await insertChunked(edgeRepo, edgeRows, EDGE_CHUNK_SIZE);
  // 단일 IN(...) UPDATE 하나로 전체 목록을 보내면 수십만 심볼/다중천
  // fan-in 규모에서 SQLite/sql.js·PostgreSQL의 바인드 변수 한도를 넘어
  // 문장 자체가 실패할 수 있다(리뷰 지적 라운드 2) — insertChunked와 같은
  // EDGE_CHUNK_SIZE로 나눠 청크 사이 양보한다.
  await updateChunked(edgeRepo, existingCallsIdsToCapDynamic, EDGE_CHUNK_SIZE, { resolution: 'dynamic' });
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
