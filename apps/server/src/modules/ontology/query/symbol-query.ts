// graph_find_symbol / graph_module_summary의 내부 질의 계층(ticket
// d35b7b7d, DESIGN.md 축 6). graph-query.ts(재귀 CTE + BFS)와 달리 여기는
// 재귀가 필요 없는 단순 인덱스 조회 + 집계라 별도 파일로 분리했다 — "내부
// 그래프-질의 서비스, 절대 free-form SQL로 노출하지 않는다"는 축 3의
// cross-cutting invariant는 동일하게 지킨다(전부 TypeORM QueryBuilder,
// dialect-agnostic).
import type { DataSource } from 'typeorm';
import { OntologyNode } from '../../../entities/OntologyNode';
import { OntologyEdge } from '../../../entities/OntologyEdge';
import { DEFAULT_CONFIDENCE_MIN, normalizeConfidenceMin } from './graph-query';

/** research-ontology.md §6 — "ordinal buckets (asserted ≥0.9 / likely
 *  0.6–0.9 / speculative <0.6), never a bare float." */
export type ConfidenceBucket = 'asserted' | 'likely' | 'speculative';

export function confidenceBucket(confidence: number): ConfidenceBucket {
  if (confidence >= 0.9) return 'asserted';
  if (confidence >= 0.6) return 'likely';
  return 'speculative';
}

const SYMBOL_MATCH_LIMIT = 20;

// ─────────────────────────────────────────────────────────────────────────
// graph_find_symbol — name / qualified-name / fuzzy 해소 캐스케이드
// ─────────────────────────────────────────────────────────────────────────

export interface FindSymbolInput {
  graphId: string;
  name: string;
  confidenceMin?: number;
}

export type SymbolMatchKind = 'exact_name' | 'exact_qualified_name' | 'fuzzy';

export interface SymbolMatch {
  node: OntologyNode;
  confidenceBucket: ConfidenceBucket;
  matchKind: SymbolMatchKind;
}

export interface FindSymbolResult {
  matches: SymbolMatch[];
  /** true면 matches.length===1 — graph_find_symbol 툴이 이 값으로 detail/
   *  suggested_next_calls 포함 여부를 결정한다(DESIGN.md 축 6: "on a unique
   *  high-confidence match"). confidenceMin 필터를 이미 통과한 뒤의
   *  유일성이라 별도 고신뢰 임계값을 다시 두지 않는다. */
  unique: boolean;
  confidenceMin: number;
}

function baseScope(graphId: string) {
  return { graph_id: graphId, status: 'active' as const };
}

/** name/fuzzy/qualified-name 해소 캐스케이드. exact name → exact
 *  qualified_name → bounded substring fuzzy 순으로 첫 비어있지 않은 티어에서
 *  멈춘다(각 티어 안에서는 confidence_min으로 필터). Tier 1.5 리졸버 자체의
 *  BK-tree(axis 1)와는 다른 관심사다 — 그건 추출 시점에 참조를 엣지로
 *  묶는 내부 구조고, 이건 이미 만들어진 그래프에서 에이전트가 이름으로
 *  노드를 찾는 조회 툴이다. */
export async function findSymbol(dataSource: DataSource, input: FindSymbolInput): Promise<FindSymbolResult> {
  if (!input.graphId) throw new Error('symbol-query: graphId is required');
  if (!input.name) throw new Error('symbol-query: name is required');
  const confidenceMin = normalizeConfidenceMin(input.confidenceMin);
  const repo = dataSource.getRepository(OntologyNode);

  const exactName = await repo.find({ where: { ...baseScope(input.graphId), name: input.name }, take: SYMBOL_MATCH_LIMIT });
  const exactNameConfident = exactName.filter((n) => n.confidence >= confidenceMin);
  if (exactNameConfident.length > 0) {
    return toResult(exactNameConfident, 'exact_name', confidenceMin);
  }

  const exactQualified = await repo.find({ where: { ...baseScope(input.graphId), qualified_name: input.name }, take: SYMBOL_MATCH_LIMIT });
  const exactQualifiedConfident = exactQualified.filter((n) => n.confidence >= confidenceMin);
  if (exactQualifiedConfident.length > 0) {
    return toResult(exactQualifiedConfident, 'exact_qualified_name', confidenceMin);
  }

  const fuzzy = await repo.createQueryBuilder('n')
    .where('n.graph_id = :graphId', { graphId: input.graphId })
    .andWhere('n.status = :status', { status: 'active' })
    .andWhere('n.confidence >= :confidenceMin', { confidenceMin })
    .andWhere('(n.name LIKE :pattern OR n.qualified_name LIKE :pattern)', { pattern: `%${input.name}%` })
    .orderBy('n.confidence', 'DESC')
    .addOrderBy('n.name', 'ASC')
    .limit(SYMBOL_MATCH_LIMIT)
    .getMany();
  return toResult(fuzzy, 'fuzzy', confidenceMin);
}

function toResult(nodes: OntologyNode[], matchKind: SymbolMatchKind, confidenceMin: number): FindSymbolResult {
  return {
    matches: nodes.map((node) => ({ node, confidenceBucket: confidenceBucket(node.confidence), matchKind })),
    unique: nodes.length === 1,
    confidenceMin,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// graph_module_summary — get_board_summary 패턴 미러링(집계 전용)
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 50;
const SCOPE_CHUNK_SIZE = 500; // graph-query.ts FRONTIER_CHUNK_SIZE와 같은 값 — 대량 IN(...) 바인드 변수 상한 방어

export interface ModuleSummaryInput {
  graphId: string;
  /** 요약 대상 디렉터리/모듈/파일 경로. 빈 문자열 = 저장소 루트(그 밑
   *  전체). */
  path: string;
  confidenceMin?: number;
  topN?: number;
}

export interface ModuleSummaryResult {
  path: string;
  symbolCount: number;
  topSymbols: OntologyNode[];
  /** 이 스코프 밖 심볼로 나가는, 집계된(중복제거된) 의존 대상 수 — "Aggregate,
   *  never raw" 불변식(축 3/6): per-edge 나열이 아니라 distinct 카운트만. */
  dependencyCount: number;
  /** 이 스코프 밖에서 안으로 들어오는, 집계된 의존자 수. */
  dependentCount: number;
  confidenceMin: number;
}

function moduleScopeQuery(dataSource: DataSource, graphId: string, path: string) {
  const prefix = `${path === '' ? '' : `${path}/`}%`;
  return dataSource.getRepository(OntologyNode).createQueryBuilder('n')
    .where('n.graph_id = :graphId', { graphId })
    .andWhere('n.status = :status', { status: 'active' })
    .andWhere('(n.path = :path OR n.path LIKE :prefix)', { path, prefix });
}

export async function moduleSummary(dataSource: DataSource, input: ModuleSummaryInput): Promise<ModuleSummaryResult> {
  if (!input.graphId) throw new Error('symbol-query: graphId is required');
  if (input.path === undefined || input.path === null) throw new Error('symbol-query: path is required (empty string = repo root)');
  const confidenceMin = normalizeConfidenceMin(input.confidenceMin);
  const topN = Math.min(Math.max(Math.trunc(input.topN ?? DEFAULT_TOP_N), 1), MAX_TOP_N);

  const idRows: Array<{ id: string }> = await moduleScopeQuery(dataSource, input.graphId, input.path)
    .select('n.id', 'id')
    .getRawMany();
  const idSet = new Set(idRows.map((r) => r.id));

  if (idSet.size === 0) {
    return { path: input.path, symbolCount: 0, topSymbols: [], dependencyCount: 0, dependentCount: 0, confidenceMin };
  }

  const topSymbols = await moduleScopeQuery(dataSource, input.graphId, input.path)
    .orderBy('n.pagerank', 'DESC')
    .addOrderBy('n.degree', 'DESC')
    .limit(topN)
    .getMany();

  const edgeRepo = dataSource.getRepository(OntologyEdge);
  const idArray = [...idSet];
  const outside = { dst: new Set<string>(), src: new Set<string>() };
  for (let i = 0; i < idArray.length; i += SCOPE_CHUNK_SIZE) {
    const chunk = idArray.slice(i, i + SCOPE_CHUNK_SIZE);

    const outRows: Array<{ dst_id: string }> = await edgeRepo.createQueryBuilder('e')
      .select('DISTINCT e.dst_id', 'dst_id')
      .where('e.graph_id = :graphId', { graphId: input.graphId })
      .andWhere('e.status = :status', { status: 'active' })
      .andWhere('e.confidence >= :confidenceMin', { confidenceMin })
      .andWhere('e.src_id IN (:...chunk)', { chunk })
      .getRawMany();
    for (const r of outRows) if (!idSet.has(r.dst_id)) outside.dst.add(r.dst_id);

    const inRows: Array<{ src_id: string }> = await edgeRepo.createQueryBuilder('e')
      .select('DISTINCT e.src_id', 'src_id')
      .where('e.graph_id = :graphId', { graphId: input.graphId })
      .andWhere('e.status = :status', { status: 'active' })
      .andWhere('e.confidence >= :confidenceMin', { confidenceMin })
      .andWhere('e.dst_id IN (:...chunk)', { chunk })
      .getRawMany();
    for (const r of inRows) if (!idSet.has(r.src_id)) outside.src.add(r.src_id);
  }

  return {
    path: input.path,
    symbolCount: idSet.size,
    topSymbols,
    dependencyCount: outside.dst.size,
    dependentCount: outside.src.size,
    confidenceMin,
  };
}

export { DEFAULT_CONFIDENCE_MIN };
