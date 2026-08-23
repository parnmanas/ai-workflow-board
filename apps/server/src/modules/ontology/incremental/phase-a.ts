// Phase A(ticket 964014f5, DESIGN.md 축 4) — 변경된 파일 하나를 재파싱하고
// symbol_id 기준으로 diff해 signature_hash 비교로 조기 종료 여부를
// 판정한다. rename이든 아니든 "이 경로의 기존 활성 노드"를
// qualifiedName으로 새 파싱 결과와 매칭"하는 하나의 로직으로 통일했다 —
// rename이 아니면 oldPath===newPath라 symbol_id 매칭과 동치이고, rename이면
// symbol_id(경로가 섞여 들어감, persist.ts의 fileSymbolId/defSymbolId)가
// 바뀌므로 qualifiedName(경로 비의존)으로만 매칭할 수 있다.
//
// 완료조건 1(body-only 편집 조기 종료)과 완료조건 2(rename의 무조건
// 재해소, REVIEW-NOTES.md I2)를 이 한 함수가 함께 만족한다:
//  - body-only 편집: oldPath===newPath, 모든 def의 signatureHash가
//    그대로 -> changedSymbolIds=[] -> shortCircuit=true.
//  - rename: oldPath!==newPath -> isRename=true(시그니처 변화와 무관하게
//    Phase B를 무조건 트리거해야 한다는 신호, 오케스트레이터가
//    forcedSelfResolvePath로 사용).
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { In, type DataSource, type Repository } from 'typeorm';
import { OntologyNode } from '../../../entities/OntologyNode';
import { OntologyEdge } from '../../../entities/OntologyEdge';
import { OntologyReverseEdgeIndex } from '../../../entities/OntologyReverseEdgeIndex';
import { extractFile } from '../extraction/extract-file';
import { hashFactBundle } from '../extraction/hash-bundle';
import { classifyDurability } from '../extraction/durability';
import { DEF_KIND_TO_NODE_TYPE, fileSymbolId, defSymbolId, insertChunked, updateChunked, yieldToEventLoop } from '../persist';
import type { ExtractionLang } from '../extraction/types';

// persist.ts의 NODE_CHUNK_SIZE/EDGE_CHUNK_SIZE 선례와 동일한 값 — 리뷰
// 지적(대량 그래프에서 IN(...) 파라미터 한도/이벤트 루프 안전) 반영.
const EDGE_CHUNK_SIZE = 500;

export interface PhaseAInput {
  graphId: string;
  workspaceId: string;
  resourceId: string;
  folderPath: string;
  /** 이 Phase A 실행이 대상으로 삼은 커밋 sha(또는 로컬 작업 트리 직접
   *  트리거면 빈 문자열/워킹 트리 마커) — persist.ts와 동일 관례. */
  commit: string;
  extractionRunId: string;
  /** 파일의 현재(새) 경로 — 노드가 갱신·삽입될 경로. */
  newPath: string;
  /** 기존 활성 노드를 찾을 경로. rename이 아니면 newPath와 동일해야 한다. */
  oldPath: string;
  lang: ExtractionLang;
  content: string;
}

export interface PhaseAResult {
  fileNodeId: string;
  fileDurability: OntologyNode['durability'];
  /** signature_hash가 바뀌었거나(새 symbol_id)/새로 생겼거나(새 symbol_id)/
   *  사라진(옛 symbol_id) def들의 symbol_id — Phase B의 reverse-index 조회
   *  입력 그대로. */
  changedSymbolIds: string[];
  /** oldPath !== newPath. */
  isRename: boolean;
  /** 이 그래프에 이 경로의 활성 File 노드가 이전에 없었다(진짜 신규 파일). */
  isNewFile: boolean;
  /** changedSymbolIds가 비어 있고 rename도 새 파일도 아니면 true — Phase B
   *  자체를 호출할 필요가 없다(완료조건 1). */
  shortCircuit: boolean;
}

function baseFileFields(input: PhaseAInput) {
  return {
    workspace_id: input.workspaceId,
    resource_id: input.resourceId,
    folder_path: input.folderPath,
    graph_id: input.graphId,
    status: 'active' as const,
    confidence: 1.0,
    confidence_method: 'constant' as const,
    extraction_run_id: input.extractionRunId,
    embedding_id: null,
    degree: 0,
    pagerank: 0,
  };
}

// persist.ts Phase 1의 baseEdgeFields(commit)와 동일한 CONTAINS/DECLARES
// 공통 필드 — 신규 def가 생겼을 때 이 구조적 엣지를 여기서도 똑같이 만든다
// (리뷰 지적 — Phase A가 노드만 만들고 CONTAINS/DECLARES를 빠뜨려 활성
// 그래프가 불일치했음).
function baseEdgeFields(input: PhaseAInput) {
  return {
    workspace_id: input.workspaceId,
    graph_id: input.graphId,
    layer: 'structural' as const,
    confidence: 1.0,
    confidence_method: 'constant' as const,
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
    props: '{}',
  };
}

/**
 * 리뷰 지적(차단) — 노드를 removed 처리할 때 그 노드가 src/dst인 활성
 * 엣지(CONTAINS/DECLARES/DECORATES는 물론, resolver-owned 타입까지 전부)를
 * 함께 removed 처리하지 않으면, 삭제된 def/파일을 가리키는 active 엣지가
 * 그래프에 남아 "활성 그래프"의 정합성이 깨진다. graph_id 범위에서
 * src_id/dst_id가 nodeIds에 속하는 active 엣지를 청크 조회해 모은 뒤
 * updateChunked로 한꺼번에 removed 처리한다(대량 삭제 대비 IN(...) 파라미터
 * 한도 + 이벤트 루프 안전 — 리뷰 지적, persist.ts/resolve.ts와 동일한
 * bounded-chunk 규율).
 */
async function removeEdgesTouchingNodes(
  edgeRepo: Repository<OntologyEdge>,
  graphId: string,
  nodeIds: string[],
  commit: string,
): Promise<void> {
  if (nodeIds.length === 0) return;
  const touchedIds = new Set<string>();
  for (let i = 0; i < nodeIds.length; i += EDGE_CHUNK_SIZE) {
    const chunk = nodeIds.slice(i, i + EDGE_CHUNK_SIZE);
    const rows = await edgeRepo.find({
      where: [
        { graph_id: graphId, src_id: In(chunk), status: 'active' },
        { graph_id: graphId, dst_id: In(chunk), status: 'active' },
      ],
      select: ['id'],
    });
    for (const r of rows) touchedIds.add(r.id);
    await yieldToEventLoop();
  }
  if (touchedIds.size > 0) {
    await updateChunked(edgeRepo, [...touchedIds], EDGE_CHUNK_SIZE, { status: 'removed', valid_to_commit: commit });
  }
}

export async function runPhaseA(dataSource: DataSource, input: PhaseAInput): Promise<PhaseAResult> {
  const nodeRepo = dataSource.getRepository(OntologyNode);
  const edgeRepo = dataSource.getRepository(OntologyEdge);
  const reverseRepo = dataSource.getRepository(OntologyReverseEdgeIndex);
  const isRename = input.oldPath !== input.newPath;
  const fileDurability = classifyDurability(input.newPath);

  const bundle = await extractFile(input.newPath, input.content, input.lang);
  hashFactBundle(bundle, input.content);

  const existingNodes = await nodeRepo.find({ where: { graph_id: input.graphId, path: input.oldPath, status: 'active' } });
  const existingFile = existingNodes.find((n) => n.type === 'File') ?? null;
  const existingDefsByQName = new Map(existingNodes.filter((n) => n.type !== 'File').map((n) => [n.qualified_name, n]));

  const changedSymbolIds: string[] = [];
  const symbolIdRemap: Array<{ oldId: string; newId: string }> = [];
  const fileProps = JSON.stringify({
    has_parse_error: bundle.hasParseError,
    refs: bundle.refs,
    imports: bundle.imports,
    exports: bundle.exports,
    heritage: bundle.heritage,
  });

  // ── File 노드 ──
  const newFileSymbolId = fileSymbolId(input.newPath);
  let fileNodeId: string;
  if (existingFile) {
    fileNodeId = existingFile.id;
    if (existingFile.symbol_id !== newFileSymbolId) symbolIdRemap.push({ oldId: existingFile.symbol_id, newId: newFileSymbolId });
    await nodeRepo.update(
      { id: fileNodeId },
      {
        symbol_id: newFileSymbolId,
        path: input.newPath,
        qualified_name: input.newPath,
        name: path.basename(input.newPath),
        content_hash: bundle.fileHash,
        durability: fileDurability,
        lang: bundle.lang,
        profile_version: bundle.extractorVersion,
        last_seen_commit: input.commit,
        props: fileProps,
      },
    );
  } else {
    fileNodeId = randomUUID();
    await nodeRepo.insert({
      id: fileNodeId,
      ...baseFileFields(input),
      symbol_id: newFileSymbolId,
      type: 'File',
      kind: '',
      layer: 'structural',
      name: path.basename(input.newPath),
      qualified_name: input.newPath,
      path: input.newPath,
      start_line: null,
      end_line: null,
      content_hash: bundle.fileHash,
      signature_hash: '',
      durability: fileDurability,
      lang: bundle.lang,
      first_seen_commit: input.commit,
      last_seen_commit: input.commit,
      valid_from_commit: input.commit,
      valid_to_commit: null,
      profile_version: bundle.extractorVersion,
      props: fileProps,
    } as OntologyNode);
  }

  // ── Def 노드 diff(qualifiedName 매칭) ──
  // 리뷰 지적(차단) — 노드 diff만으론 부족하다. persist.ts Phase 1과
  // 동일하게 CONTAINS(최상위)/DECLARES(중첩)를 새 def마다 실제로 만들어야
  // 활성 그래프가 일관된다. bundle.defs는 extract-file.ts의 정렬 불변식대로
  // startByte 오름차순 + 부모가 항상 자식보다 먼저 나오므로, 매칭/신규
  // 상관없이 처리한 즉시 nodeIdByQualifiedName에 넣어두면 그 뒤에 나오는
  // 자식 def가 부모 id를 항상 찾을 수 있다(persist.ts의 nodeIdByQualifiedName
  // 관례 그대로).
  const matchedOldIds = new Set<string>();
  const nodeIdByQualifiedName = new Map<string, string>();
  const newEdgeRows: OntologyEdge[] = [];
  const edgeBase = baseEdgeFields(input);
  for (const def of bundle.defs) {
    const nodeType = DEF_KIND_TO_NODE_TYPE[def.kind];
    const newSymbolId = defSymbolId(input.newPath, def.qualifiedName);
    const existing = existingDefsByQName.get(def.qualifiedName);
    if (existing) {
      matchedOldIds.add(existing.id);
      nodeIdByQualifiedName.set(def.qualifiedName, existing.id);
      if (existing.symbol_id !== newSymbolId) symbolIdRemap.push({ oldId: existing.symbol_id, newId: newSymbolId });
      // signature_hash 비교가 핵심 early-cutoff 판정 — body만 바뀌면(즉
      // content_hash만 다르고 signature_hash는 같으면) changedSymbolIds에
      // 안 들어간다. existing.signature_hash가 ''(이 티켓 이전 데이터,
      // persist.ts가 아직 못 채웠던 레거시 행)면 무조건 "바뀐 것으로" 취급
      // — 빈 값과의 일치는 우연이라도 신뢰할 근거가 없다.
      if (existing.signature_hash === '' || existing.signature_hash !== def.signatureHash) {
        changedSymbolIds.push(newSymbolId);
      }
      await nodeRepo.update(
        { id: existing.id },
        {
          symbol_id: newSymbolId,
          path: input.newPath,
          start_line: def.startLine,
          end_line: def.endLine,
          content_hash: def.contentHash,
          signature_hash: def.signatureHash,
          durability: fileDurability,
          lang: bundle.lang,
          profile_version: bundle.extractorVersion,
          last_seen_commit: input.commit,
          props: JSON.stringify({ exported: def.exported, docstring: def.docstring }),
        },
      );
    } else {
      // 새로 생긴 def — 이 파일에 새 symbol이 추가됐으니 Phase B가
      // "누가 이 이름을 참조하려다 실패해 있었는지"는 reverse index엔
      // 없다(참조자가 애초에 미해소로 남아 reverse_edge_index에 안
      // 잡혔을 것) — changedSymbolIds에 넣어도 이번 세대엔 조회가
      // 공집합으로 돌아오는 게 정상이다. 그래도 정직하게 넣는다: 이
      // 심볼을 향한 reverse_edge_index 행이 미래에 생기면(다른 파일이
      // 나중에 이 def를 import) 그 시점 Phase A/B가 정상 처리한다.
      changedSymbolIds.push(newSymbolId);
      const newId = randomUUID();
      nodeIdByQualifiedName.set(def.qualifiedName, newId);
      await nodeRepo.insert({
        id: newId,
        ...baseFileFields(input),
        symbol_id: newSymbolId,
        type: nodeType,
        kind: def.kind,
        layer: 'structural',
        name: def.name,
        qualified_name: def.qualifiedName,
        path: input.newPath,
        start_line: def.startLine,
        end_line: def.endLine,
        content_hash: def.contentHash,
        signature_hash: def.signatureHash,
        durability: fileDurability,
        lang: bundle.lang,
        first_seen_commit: input.commit,
        last_seen_commit: input.commit,
        valid_from_commit: input.commit,
        valid_to_commit: null,
        profile_version: bundle.extractorVersion,
        props: JSON.stringify({ exported: def.exported, docstring: def.docstring }),
      } as OntologyNode);

      // persist.ts Phase 1과 동일: 최상위면 File--CONTAINS-->def, 중첩이면
      // 부모def--DECLARES-->def. 부모는 정렬 불변식상 이미 위에서 처리돼
      // nodeIdByQualifiedName에 있다.
      const srcId = def.parentQualifiedName ? nodeIdByQualifiedName.get(def.parentQualifiedName)! : fileNodeId;
      const edgeType = def.parentQualifiedName ? 'DECLARES' : 'CONTAINS';
      newEdgeRows.push({
        id: randomUUID(),
        ...edgeBase,
        src_id: srcId,
        dst_id: newId,
        type: edgeType,
        resolution: null,
      } as OntologyEdge);
    }
  }
  if (newEdgeRows.length > 0) await insertChunked(edgeRepo, newEdgeRows, EDGE_CHUNK_SIZE);

  // 사라진 def(soft-delete) — old symbol_id로 넣어야 그 심볼을 참조하던
  // (이제 끊어진) reverse_edge_index 행을 Phase B가 찾아 재해소한다.
  const removedDefIds: string[] = [];
  for (const existing of existingDefsByQName.values()) {
    if (matchedOldIds.has(existing.id)) continue;
    changedSymbolIds.push(existing.symbol_id);
    removedDefIds.push(existing.id);
    await nodeRepo.update({ id: existing.id }, { status: 'removed', valid_to_commit: input.commit });
  }
  // 리뷰 지적(차단) — 사라진 def를 향하거나 사라진 def가 만든 기존
  // CONTAINS/DECLARES/DECORATES(및 기타) 활성 엣지를 함께 removed 처리
  // 안 하면, 삭제된 노드를 가리키는 active 엣지가 그래프에 남는다.
  await removeEdgesTouchingNodes(edgeRepo, input.graphId, removedDefIds, input.commit);

  // ── reverse_edge_index remap(rename으로 symbol_id가 바뀐 행만) ──
  for (const { oldId, newId } of symbolIdRemap) {
    await reverseRepo.update({ graph_id: input.graphId, dst_symbol_id: oldId }, { dst_symbol_id: newId });
  }

  const isNewFile = existingFile === null;
  return {
    fileNodeId,
    fileDurability,
    changedSymbolIds,
    isRename,
    isNewFile,
    shortCircuit: !isRename && !isNewFile && changedSymbolIds.length === 0,
  };
}

export interface PhaseADeletionInput {
  graphId: string;
  commit: string;
  /** 삭제된 파일의 경로. */
  filePath: string;
}

/** 파일 삭제 — 새 content가 없으므로 diff가 아니라 그 경로의 활성 노드
 *  전부를 soft-delete한다. changedSymbolIds는 사라진 File/def들의 옛
 *  symbol_id — Phase B가 "이걸 참조하던 파일"을 찾아 미해소로 갱신한다. */
export async function runPhaseADeletion(dataSource: DataSource, input: PhaseADeletionInput): Promise<PhaseAResult> {
  const nodeRepo = dataSource.getRepository(OntologyNode);
  const edgeRepo = dataSource.getRepository(OntologyEdge);
  const existingNodes = await nodeRepo.find({ where: { graph_id: input.graphId, path: input.filePath, status: 'active' } });
  const fileDurability = classifyDurability(input.filePath);
  if (existingNodes.length === 0) {
    return { fileNodeId: '', fileDurability, changedSymbolIds: [], isRename: false, isNewFile: false, shortCircuit: true };
  }
  const changedSymbolIds = existingNodes.map((n) => n.symbol_id);
  const removedIds = existingNodes.map((n) => n.id);
  for (const n of existingNodes) {
    await nodeRepo.update({ id: n.id }, { status: 'removed', valid_to_commit: input.commit });
  }
  // 리뷰 지적(차단) — 파일 자신 + 그 파일의 모든 def가 removed됐으니, 이
  // 노드들이 src/dst인 활성 CONTAINS/DECLARES/DECORATES(및 기타) 엣지도
  // 같이 removed 처리한다.
  await removeEdgesTouchingNodes(edgeRepo, input.graphId, removedIds, input.commit);
  const fileNode = existingNodes.find((n) => n.type === 'File');
  return {
    fileNodeId: fileNode?.id ?? '',
    fileDurability,
    changedSymbolIds,
    isRename: false,
    isNewFile: false,
    shortCircuit: changedSymbolIds.length === 0,
  };
}
