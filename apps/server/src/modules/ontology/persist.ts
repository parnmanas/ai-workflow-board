// FactBundle[] + DecoratorFact[] -> OntologyNode/OntologyEdge 행 (ticket
// e14ef1c9, DESIGN.md 축 1/2). 그래프 엣지는 Tier 1 산출물만 — CONTAINS(파일→
// 최상위 def)/DECLARES(부모 def→자식 def)/DECORATES(ast-grep 룰셋)뿐,
// refs[]/imports[]/exports[]/heritage[]는 아직 미해소라 엣지로 만들지
// 않는다(크로스파일 해소는 3/7 리졸버 몫). 다만 그 원시 fact 자체는
// File 노드의 props JSON에 그대로 실어 durable하게 남긴다(리뷰 지적
// 라운드 1 — 3/7이 재파싱 없이 읽어갈 수 있어야 한다).
//
// 1/7 리뷰에서 이관된 완료조건(ontology-sqljs-independent-datasource.test.mjs
// 코멘트, ticket e14ef1c9 코멘트 스레드): 대량 insert는 청크 사이 명시적
// 매크로태스크(setImmediate) 양보를 계약으로 넣어야 한다 — await만 이어지는
// microtask 체인은 timer/I/O phase로의 공정한 양보를 보장하지 않는다. 이
// 계약을 어기지 않는 것이 이 파일 전체의 존재 이유다(non-blocking 회귀
// 테스트는 test/ontology-extraction-population-nonblocking.test.mjs).
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { DataSource, Repository } from 'typeorm';
import { OntologyNode } from '../../entities/OntologyNode';
import { OntologyEdge } from '../../entities/OntologyEdge';
import type { DefFact, DefKind, FactBundle } from './extraction/types';
import type { DecoratorFact } from './extraction/decorator-rules';

const NODE_CHUNK_SIZE = 500; // 1/7 선례(ontology-sqljs-independent-datasource.test.mjs) — sql.js 표현식-트리 깊이 상한(~1000) 아래로 여유있게.
const EDGE_CHUNK_SIZE = 500;

// 3/7 리졸버(resolver/resolve.ts)가 같은 청크-삽입+매크로태스크-양보
// 계약을 재사용한다 — 독립 재구현으로 계약이 갈라지는 걸 막기 위해 export.
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const DEF_KIND_TO_NODE_TYPE: Record<DefKind, string> = {
  class: 'Type',
  interface: 'Type',
  type: 'Type',
  enum: 'Type',
  function: 'Callable',
  method: 'Callable',
  field: 'Field',
  variable: 'Field',
};

function fileSymbolId(relPath: string): string {
  return `file:${relPath}`;
}
function defSymbolId(relPath: string, qualifiedName: string): string {
  return `def:${relPath}#${qualifiedName}`;
}

export interface PersistInput {
  graphId: string;
  workspaceId: string;
  resourceId: string;
  folderPath: string;
  /** 이 추출 실행이 대상으로 삼은 커밋 sha — 없으면 ''(예: 로컬 작업 트리
   *  직접 벤치마크). OntologyNode/Edge의 바이템포럴 커밋 컬럼에 그대로 쓴다. */
  commit: string;
  extractionRunId: string;
  bundles: FactBundle[];
  /** bundle.path -> 그 파일에서 뽑힌 DecoratorFact[] (없으면 빈 배열). */
  decoratorFactsByPath: Map<string, DecoratorFact[]>;
  /** 청크 하나가 insert + 매크로태스크 양보를 마칠 때마다 호출(node 단계,
   *  그다음 edge 단계 — 두 단계 걸쳐 누적 호출됨, 각 단계 자신의
   *  완료행수/전체행수). 순수 관찰용 — 진행률 로깅과, 이 파일의 핵심
   *  계약(청크 사이 명시적 매크로태스크 양보)을 wall-clock 레이스 없이
   *  결정론적으로 검증하는 회귀 테스트(test/ontology-extraction-population-nonblocking.test.mjs)
   *  둘 다가 쓴다. */
  onChunkInserted?: (info: { kind: 'node' | 'edge'; completedRows: number; totalRows: number }) => void;
}

export interface PersistSummary {
  filesProcessed: number;
  nodesInserted: number;
  edgesInserted: number;
  containsEdges: number;
  declaresEdges: number;
  decoratesEdges: number;
  /** 대상 def를 못 찾았거나, 가드/인터셉터/파이프 인자 식별자가 같은 그래프
   *  안에서 0개 또는 2개 이상의 클래스 노드에 매칭돼 애매하게 남은 경우
   *  (또는 @Cron()/@EventPattern()처럼 애초에 식별자 인자가 없는 경우) —
   *  DECORATES는 상수 낮은 신뢰도라도 잘못된 대상을 향한 엣지보다는 엣지를
   *  만들지 않는 쪽을 택한다(research-extraction.md 함정 #4). */
  decoratesUnresolved: number;
  parseErrorFiles: number;
  skippedFiles: number;
  durationMs: number;
}

interface FileDefIndex {
  bundle: FactBundle;
  fileNodeId: string;
  nodeIdByQualifiedName: Map<string, string>;
}

export async function insertChunked<T extends object>(
  repo: Repository<T>,
  rows: T[],
  chunkSize: number,
  onChunk?: (completedRows: number, totalRows: number) => void,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    if (chunk.length > 0) await repo.insert(chunk);
    onChunk?.(Math.min(i + chunkSize, rows.length), rows.length);
    // 명시적 매크로태스크 양보 — 위 파일 헤더 코멘트의 계약. 마지막 청크
    // 뒤에도 무조건 양보한다(특수 케이스 분기 없이 균일하게).
    await yieldToEventLoop();
  }
}

function findDecoratedTargetNodeId(index: FileDefIndex, fact: DecoratorFact): string | null {
  let best: DefFact | null = null;
  for (const def of index.bundle.defs) {
    if (def.name !== fact.targetName) continue;
    if (fact.targetStartLine < def.startLine || fact.targetStartLine > def.endLine) continue;
    const kindMatches =
      (fact.targetKind === 'class' && def.kind === 'class') ||
      (fact.targetKind === 'method' && def.kind === 'method') ||
      (fact.targetKind === 'field' && def.kind === 'field');
    if (!kindMatches) continue;
    if (!best || def.endLine - def.startLine < best.endLine - best.startLine) best = def;
  }
  return best ? index.nodeIdByQualifiedName.get(best.qualifiedName) ?? null : null;
}

/** FactBundle[] + DecoratorFact[]를 OntologyNode/OntologyEdge 행으로
 *  바꿔 청크 단위로 insert한다. `dataSource`는 호출자가 고른다 —
 *  sql.js에서는 AppOntologyDataSource, Postgres에서는 (AppOntologyDataSource가
 *  null이므로) NestJS가 관리하는 단일 primary DataSource, db.ts의 듀얼
 *  DataSource 계약 그대로(축 3). */
export async function persistFactBundles(dataSource: DataSource, input: PersistInput): Promise<PersistSummary> {
  const startedAt = Date.now();
  const nodeRepo = dataSource.getRepository(OntologyNode);
  const edgeRepo = dataSource.getRepository(OntologyEdge);

  const nodeRows: OntologyNode[] = [];
  const edgeRows: OntologyEdge[] = [];
  const classNodeIdsByName = new Map<string, string[]>();
  const fileIndexes: FileDefIndex[] = [];

  let parseErrorFiles = 0;
  let skippedFiles = 0;
  let containsEdges = 0;
  let declaresEdges = 0;

  const baseNodeFields = (commit: string) => ({
    workspace_id: input.workspaceId,
    resource_id: input.resourceId,
    folder_path: input.folderPath,
    graph_id: input.graphId,
    status: 'active' as const,
    confidence: 1.0,
    confidence_method: 'constant' as const,
    first_seen_commit: commit,
    last_seen_commit: commit,
    valid_from_commit: commit,
    valid_to_commit: null,
    extraction_run_id: input.extractionRunId,
    embedding_id: null,
    degree: 0,
    pagerank: 0,
  });
  const baseEdgeFields = (commit: string) => ({
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
    first_seen_commit: commit,
    last_seen_commit: commit,
    valid_from_commit: commit,
    valid_to_commit: null,
    status: 'active' as const,
    props: '{}',
  });

  // ── Phase 1: File + Def 노드, CONTAINS/DECLARES 엣지 ──
  for (const bundle of input.bundles) {
    if (bundle.skippedReason) {
      skippedFiles += 1;
      continue;
    }
    if (bundle.hasParseError) parseErrorFiles += 1;

    const fileNodeId = randomUUID();
    nodeRows.push({
      id: fileNodeId,
      ...baseNodeFields(input.commit),
      symbol_id: fileSymbolId(bundle.path),
      type: 'File',
      kind: '',
      layer: 'structural',
      name: path.basename(bundle.path),
      qualified_name: bundle.path,
      path: bundle.path,
      start_line: null,
      end_line: null,
      content_hash: bundle.fileHash,
      lang: bundle.lang,
      profile_version: bundle.extractorVersion,
      // 리뷰 지적(라운드 1) — refs[]/imports[]/exports[]/heritage[]는 아직
      // 엣지가 아니지만(크로스파일 해소는 3/7 리졸버 몫), 원시 fact 자체는
      // 3/7이 소비할 수 있게 durable하게 남아야 한다. 새 테이블/컬럼 없이
      // File 노드 자신의 props(OntologyNode.ts 자신의 문서: "타입별 속성을
      // 담는 자유형식 JSON 자루")에 실어 보낸다 — graph_id 스코프로 이미
      // 쿼리 가능하므로 별도 반환 경로가 필요 없다.
      props: JSON.stringify({
        has_parse_error: bundle.hasParseError,
        refs: bundle.refs,
        imports: bundle.imports,
        exports: bundle.exports,
        heritage: bundle.heritage,
      }),
    } as OntologyNode);

    const nodeIdByQualifiedName = new Map<string, string>();
    for (const def of bundle.defs) {
      const id = randomUUID();
      nodeIdByQualifiedName.set(def.qualifiedName, id);
      const nodeType = DEF_KIND_TO_NODE_TYPE[def.kind];
      nodeRows.push({
        id,
        ...baseNodeFields(input.commit),
        symbol_id: defSymbolId(bundle.path, def.qualifiedName),
        type: nodeType,
        kind: def.kind,
        layer: 'structural',
        name: def.name,
        qualified_name: def.qualifiedName,
        path: bundle.path,
        start_line: def.startLine,
        end_line: def.endLine,
        content_hash: '',
        lang: bundle.lang,
        profile_version: bundle.extractorVersion,
        props: JSON.stringify({ exported: def.exported, docstring: def.docstring }),
      } as OntologyNode);

      if (def.kind === 'class') {
        const list = classNodeIdsByName.get(def.name) ?? [];
        list.push(id);
        classNodeIdsByName.set(def.name, list);
      }

      // 정렬 불변식(extract-file.ts): defs[]는 startByte 오름차순이고 부모는
      // 항상 자식보다 먼저 나오므로, parentQualifiedName 조회는 항상 이미
      // 채워져 있다.
      const srcId = def.parentQualifiedName ? nodeIdByQualifiedName.get(def.parentQualifiedName)! : fileNodeId;
      const edgeType = def.parentQualifiedName ? 'DECLARES' : 'CONTAINS';
      if (edgeType === 'CONTAINS') containsEdges += 1; else declaresEdges += 1;
      edgeRows.push({
        id: randomUUID(),
        ...baseEdgeFields(input.commit),
        src_id: srcId,
        dst_id: id,
        type: edgeType,
        resolution: null,
      } as OntologyEdge);
    }

    fileIndexes.push({ bundle, fileNodeId, nodeIdByQualifiedName });
  }

  // ── Phase 2: DECORATES ──
  // guard/interceptor/pipe: 대상 def(같은 파일) x 가드/인터셉터/파이프
  // 클래스(전체 그래프, 이름 기준 유일 매칭).
  // cron/event_pattern(리뷰 지적 라운드 1로 추가) — 인자가 식별자가 아니라
  // 문자열 리터럴(cron 표현식/이벤트 패턴명)이라 기존 "이름으로 클래스
  // 찾기" 경로가 애초에 적용되지 않는다. 대신 axis 2의 기존 구조적
  // 어휘(Endpoint — 새 타입을 발명하지 않음)로 이 데코레이터 occurrence
  // 전용 노드를 만든다: 파일+대상+family+라인으로 스코프되므로 크로스파일
  // 해석이 필요 없고 Tier 1 자체로 완결된다. 이렇게 해야 "룰셋이 감지는
  // 하지만 그래프엔 안 남아 쿼리 불가"였던 이전 상태를 벗어난다.
  let decoratesEdges = 0;
  let decoratesUnresolved = 0;
  for (const index of fileIndexes) {
    const facts = input.decoratorFactsByPath.get(index.bundle.path) ?? [];
    for (const fact of facts) {
      const targetNodeId = findDecoratedTargetNodeId(index, fact);
      if (!targetNodeId) {
        decoratesUnresolved += 1;
        continue;
      }

      if (fact.family === 'cron' || fact.family === 'event_pattern') {
        const endpointId = randomUUID();
        const endpointName = fact.primaryArgText ?? `${fact.family}:${fact.targetName}`;
        nodeRows.push({
          id: endpointId,
          ...baseNodeFields(input.commit),
          symbol_id: `endpoint:${index.bundle.path}#${fact.targetName}#${fact.family}#${fact.targetStartLine}`,
          type: 'Endpoint',
          kind: fact.family,
          layer: 'structural',
          name: endpointName,
          qualified_name: endpointName,
          path: index.bundle.path,
          start_line: fact.targetStartLine,
          end_line: fact.targetEndLine,
          content_hash: '',
          lang: index.bundle.lang,
          profile_version: index.bundle.extractorVersion,
          props: '{}',
        } as OntologyNode);
        edgeRows.push({
          id: randomUUID(),
          ...baseEdgeFields(input.commit),
          src_id: targetNodeId,
          dst_id: endpointId,
          type: 'DECORATES',
          confidence: 0.6,
          resolution: 'dynamic',
          props: JSON.stringify({ family: fact.family }),
        } as OntologyEdge);
        decoratesEdges += 1;
        continue;
      }

      if (fact.argIdentifiers.length === 0) {
        decoratesUnresolved += 1;
        continue;
      }
      let anyResolved = false;
      for (const argName of fact.argIdentifiers) {
        const candidates = classNodeIdsByName.get(argName);
        if (!candidates || candidates.length !== 1) continue; // 0개(그래프 밖) 또는 2개 이상(동명이인) — 스킵
        anyResolved = true;
        edgeRows.push({
          id: randomUUID(),
          ...baseEdgeFields(input.commit),
          src_id: targetNodeId,
          dst_id: candidates[0],
          type: 'DECORATES',
          confidence: 0.6,
          resolution: 'dynamic',
          props: JSON.stringify({ family: fact.family }),
        } as OntologyEdge);
        decoratesEdges += 1;
      }
      if (!anyResolved) decoratesUnresolved += 1;
    }
  }

  await insertChunked(nodeRepo, nodeRows, NODE_CHUNK_SIZE, (completedRows, totalRows) =>
    input.onChunkInserted?.({ kind: 'node', completedRows, totalRows }));
  await insertChunked(edgeRepo, edgeRows, EDGE_CHUNK_SIZE, (completedRows, totalRows) =>
    input.onChunkInserted?.({ kind: 'edge', completedRows, totalRows }));

  return {
    filesProcessed: input.bundles.length,
    nodesInserted: nodeRows.length,
    edgesInserted: edgeRows.length,
    containsEdges,
    declaresEdges,
    decoratesEdges,
    decoratesUnresolved,
    parseErrorFiles,
    skippedFiles,
    durationMs: Date.now() - startedAt,
  };
}
