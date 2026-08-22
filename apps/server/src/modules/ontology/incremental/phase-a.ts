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
import type { DataSource } from 'typeorm';
import { OntologyNode } from '../../../entities/OntologyNode';
import { OntologyReverseEdgeIndex } from '../../../entities/OntologyReverseEdgeIndex';
import { extractFile } from '../extraction/extract-file';
import { hashFactBundle } from '../extraction/hash-bundle';
import { classifyDurability } from '../extraction/durability';
import { DEF_KIND_TO_NODE_TYPE, fileSymbolId, defSymbolId } from '../persist';
import type { ExtractionLang } from '../extraction/types';

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

export async function runPhaseA(dataSource: DataSource, input: PhaseAInput): Promise<PhaseAResult> {
  const nodeRepo = dataSource.getRepository(OntologyNode);
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
  const matchedOldIds = new Set<string>();
  for (const def of bundle.defs) {
    const nodeType = DEF_KIND_TO_NODE_TYPE[def.kind];
    const newSymbolId = defSymbolId(input.newPath, def.qualifiedName);
    const existing = existingDefsByQName.get(def.qualifiedName);
    if (existing) {
      matchedOldIds.add(existing.id);
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
    }
  }
  // 사라진 def(soft-delete) — old symbol_id로 넣어야 그 심볼을 참조하던
  // (이제 끊어진) reverse_edge_index 행을 Phase B가 찾아 재해소한다.
  for (const existing of existingDefsByQName.values()) {
    if (matchedOldIds.has(existing.id)) continue;
    changedSymbolIds.push(existing.symbol_id);
    await nodeRepo.update({ id: existing.id }, { status: 'removed', valid_to_commit: input.commit });
  }

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
  const existingNodes = await nodeRepo.find({ where: { graph_id: input.graphId, path: input.filePath, status: 'active' } });
  const fileDurability = classifyDurability(input.filePath);
  if (existingNodes.length === 0) {
    return { fileNodeId: '', fileDurability, changedSymbolIds: [], isRename: false, isNewFile: false, shortCircuit: true };
  }
  const changedSymbolIds = existingNodes.map((n) => n.symbol_id);
  for (const n of existingNodes) {
    await nodeRepo.update({ id: n.id }, { status: 'removed', valid_to_commit: input.commit });
  }
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
