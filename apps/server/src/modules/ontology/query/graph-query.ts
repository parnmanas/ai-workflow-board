// 그래프 질의 API(ticket 20b07fc8, DESIGN.md 축 3/6 cross-cutting invariants) —
// agent에는 free-form SQL을 절대 노출하지 않는 내부 서비스. TypeORM은 어느
// dialect에도 재귀 CTE 쿼리빌더가 없어(이슈 #1116/#10731 둘 다 미해결,
// scout-server.md §2 point 4) `dataSource.query(rawSql, params)`로 SQLite/
// Postgres 각 1개 hand-maintained variant를 쓴다.
//
// graph_neighbors/graph_blast_radius는 depth-capped + path-cycle-guarded
// 재귀 CTE(research-storage.md §2.4의 illustrative SQL을 그대로 이식).
// graph_call_path는 **절대 단일 재귀 CTE로 만들지 않는다** — DuckDB
// 자체 실측(424노드 그래프 -> 6억 행 폭발+OOM, `USING KEY` 도입 배경)과
// GitLab `namespaces_cte` 프로덕션 인시던트가 증명하듯, 표준 UNION ALL
// 재귀는 "이 노드가 이미 최단거리로 settle됐는지"를 모른다(cross-path
// dedup 없음, SQLite 포럼 Keith Medcalf) — 대신 application-orchestrated
// bidirectional level-BFS로 방문집합을 애플리케이션 메모리에 둔다
// (research-storage.md §2.4).
//
// 중요(리뷰 지적으로 수정됨): 최종 출력의 LIMIT만으로는 재귀 평가 자체의
// 폭발(수렴-후-재확산 그래프에서 서로 다른 경로 수만큼 중간 행이
// 생기는 것)을 막지 못한다 — depth cap 안에서도 마찬가지다. 그래서 CTE의
// 재귀 항은 `path` 컬럼과 경로별 cycle guard를 쓰는 대신, `UNION`(ALL이
// 아님)으로 `(node_id, depth)` 튜플 자체를 재귀 전체에 걸쳐 중복 제거한다
// — SQLite/Postgres 둘 다 재귀 CTE의 UNION(distinct)이 "이번 스텝에서 나온
// 후보 행이 지금까지 누적된 결과 전체와 완전히 같으면 버린다"를 표준
// SQL만으로 보장한다(DuckDB의 `USING KEY`처럼 비표준 확장이 아님). 그
// 결과 중간 행 수는 경로 수가 아니라 최대 `노드 수 × maxDepth`로
// 상한된다(조밀한 클리크·다이아몬드형 수렴-재확산 그래프에서도) —
// ontology-query-bounded-scale.test.mjs의 "합류 후 재확산" fixture가
// 이를 직접 증명한다. SQLite 문서 자체가 명시하듯 ORDER BY 없는 재귀
// CTE는 FIFO(너비 우선)로 확장되므로, 어떤 노드가 처음 등장하는 depth가
// 곧 최소 depth다 — path 없이도 정확성이 깨지지 않는다.
import type { DataSource } from 'typeorm';
import { OntologyNode } from '../../../entities/OntologyNode';
import { OntologyEdge, type OntologyCompleteness } from '../../../entities/OntologyEdge';
import { In } from 'typeorm';
import { yieldToEventLoop } from '../persist';

export const DEFAULT_CONFIDENCE_MIN = 0.75;
export const DEFAULT_MAX_DEPTH = 4;
export const MAX_ALLOWED_DEPTH = 6; // research-storage.md §2.4: "AWB should default this low — 3 to 6 hops — and refuse to run unbounded."
export const DEFAULT_ROW_CAP = 1000;
export const MAX_ALLOWED_ROW_CAP = 5000;
export const MAX_CALL_PATH_HOPS = 10; // research-storage.md §2.4: "a hard depth ceiling (e.g. 10 hops)"
export const MAX_CALL_PATH_VISITED = 50_000; // BFS 방문집합 자체의 방어적 상한(설계 문서에 없는, 이 구현이 추가한 defense-in-depth)

const FRONTIER_CHUNK_SIZE = 500; // persist.ts EDGE_CHUNK_SIZE/updateChunked 선례와 동일한 값 — 대량 IN(...) 절이 sql.js/Postgres 바인드 변수 한도를 넘지 않도록.

type Dialect = 'sqlite' | 'postgres';

function resolveDialect(dataSource: DataSource): Dialect {
  const type = dataSource.options.type;
  if (type === 'sqljs') return 'sqlite';
  if (type === 'postgres') return 'postgres';
  throw new Error(`graph-query: unsupported DataSource dialect '${String(type)}' — DESIGN.md 축 3은 SQLite(sql.js)/Postgres만 지원한다.`);
}

export function normalizeConfidenceMin(value: number | undefined): number {
  const v = value ?? DEFAULT_CONFIDENCE_MIN;
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`graph-query: confidenceMin must be within [0, 1], got ${String(value)}`);
  }
  return v;
}

function normalizeMaxDepth(value: number | undefined): number {
  const v = value ?? DEFAULT_MAX_DEPTH;
  if (!Number.isFinite(v) || v < 1) {
    throw new Error(`graph-query: maxDepth must be >= 1, got ${String(value)}`);
  }
  return Math.min(Math.trunc(v), MAX_ALLOWED_DEPTH);
}

function normalizeRowCap(value: number | undefined): number {
  const v = value ?? DEFAULT_ROW_CAP;
  if (!Number.isFinite(v) || v < 1) {
    throw new Error(`graph-query: rowCap must be >= 1, got ${String(value)}`);
  }
  return Math.min(Math.trunc(v), MAX_ALLOWED_ROW_CAP);
}

function normalizeEdgeTypes(value: string[] | undefined): string[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// graph_neighbors / graph_blast_radius — bounded recursive CTE
// ─────────────────────────────────────────────────────────────────────────

export type ReachDirection = 'outgoing' | 'incoming';

export interface GraphReachInput {
  graphId: string;
  nodeId: string;
  edgeTypes?: string[];
  maxDepth?: number;
  confidenceMin?: number;
  rowCap?: number;
}

export interface GraphReachResultRow {
  node: OntologyNode;
  depth: number;
}

export interface GraphReachResult {
  rows: GraphReachResultRow[];
  /** true면 rowCap보다 도달 가능한 노드가 더 있었다는 뜻(캡 이후 잘림) — SQLite 공식 문서의 "unconditional LIMIT" 권고를 그대로 강제한 안전판. */
  truncated: boolean;
  maxDepth: number;
  confidenceMin: number;
  /** DESIGN.md 축 6(I1 해소분) — "결과 0건"과 "결과 0건, 커버리지가 알려진
   *  불완전 상태"를 구분하는 응답 레벨 rollup(SPDX 어휘 재사용, path_confidence와
   *  같은 "per-edge 나열이 아니라 라벨링된 단일 파생값" 자세). 아래
   *  rollupCompleteness() 참고. */
  completeness: OntologyCompleteness;
  durationMs: number;
}

interface ReachSqlParams {
  direction: ReachDirection;
  startId: string;
  graphId: string;
  maxDepth: number;
  confidenceMin: number;
  edgeTypes?: string[];
  rowCap: number;
}

// SQLite/sql.js variant. research-storage.md §2.4의 illustrative SQL은
// path 컬럼 + 경로별 cycle guard(instr())를 썼지만, 그건 "같은 경로 안에서
// 노드를 재방문하지 않는다"만 보장할 뿐 "여러 경로가 같은 노드로 합류하면
// 그 수만큼 중간 행이 생긴다"는 리뷰 지적을 막지 못한다(파일 헤더 참고).
// 대신 `UNION`(ALL 아님) + `(node_id, depth)` 튜플만으로 재귀 CTE
// 전체에 걸친 중복 제거를 표준 SQL로 얻는다 — path 컬럼 자체가 없다.
//
// CROSS JOIN(일반 JOIN이 아님)이 반드시 필요하다 — 실측으로 발견한 함정:
// `FROM ontology_edges e JOIN reach r ON e.src_id = r.node_id`로 쓰면
// SQLite의 재귀 CTE 플래너가 `reach`(재귀 작업 테이블, 통계 없음)를 못
// 믿고 `e`를 (graph_id, status, layer) 같은 엉뚱한 인덱스로 먼저 통째로
// 스캔한 뒤 매 행마다 `reach`를 다시 스캔하는 **정반대** 계획을 짠다
// (10만 엣지 그래프, depth<3에서 실측 24초 — FROM 절 순서를 바꾸거나
// `INDEXED BY`로 올바른 인덱스를 강제해도 이 조인 순서 자체는 안 고쳐짐,
// EXPLAIN QUERY PLAN으로 직접 확인). SQLite 공식 문서가 명시하는 대로
// `CROSS JOIN`은 옵티마이저의 테이블 재정렬을 끈다 — `reach`를 바깥
// 루프, `ontology_edges`를 (graph_id, src_id, type) 인덱스로 안쪽에서
// seek하게 강제하면 같은 조건이 5ms로 끝난다. SQLite는 CROSS JOIN에도
// ON 절을 허용하는 방언 확장이라 이 형태가 유효하다(표준 SQL의 CROSS
// JOIN과 달리) — Postgres는 CROSS JOIN에 ON을 허용하지 않으므로 아래
// buildReachSqlPostgres는 일반 JOIN을 그대로 쓴다(Postgres의 비용 기반
// 옵티마이저는 실제 통계를 갖고 있어 이 종류의 오판이 훨씬 덜하다는 것이
// 이 비대칭의 근거 — 이 레포 개발환경엔 Postgres 인스턴스가 없어 직접
// 실측은 못 했다, 후속 Postgres 실측 시 재확인 필요).
function buildReachSqlSqlite(p: ReachSqlParams): { sql: string; params: unknown[] } {
  const joinCol = p.direction === 'outgoing' ? 'src_id' : 'dst_id';
  const discoverCol = p.direction === 'outgoing' ? 'dst_id' : 'src_id';
  const params: unknown[] = [p.startId, p.maxDepth, p.graphId, p.confidenceMin];
  let typeFilter = '';
  if (p.edgeTypes) {
    typeFilter = ` AND e.type IN (${p.edgeTypes.map(() => '?').join(', ')})`;
    params.push(...p.edgeTypes);
  }
  params.push(p.startId, p.rowCap);
  const sql = `
    WITH RECURSIVE reach(node_id, depth) AS (
      SELECT ? AS node_id, 0 AS depth
      UNION
      SELECT e.${discoverCol} AS node_id, r.depth + 1 AS depth
      FROM reach r
      CROSS JOIN ontology_edges e ON e.${joinCol} = r.node_id
      WHERE r.depth < ?
        AND e.graph_id = ?
        AND e.status = 'active'
        AND e.confidence >= ?${typeFilter}
    )
    SELECT node_id, MIN(depth) AS depth
    FROM reach
    WHERE node_id != ?
    GROUP BY node_id
    ORDER BY depth ASC
    LIMIT ?
  `;
  return { sql, params };
}

// Postgres variant — 동일 의미론(UNION distinct 기반 (node_id,depth) 중복
// 제거, path 컬럼 없음).
function buildReachSqlPostgres(p: ReachSqlParams): { sql: string; params: unknown[] } {
  const joinCol = p.direction === 'outgoing' ? 'src_id' : 'dst_id';
  const discoverCol = p.direction === 'outgoing' ? 'dst_id' : 'src_id';
  const params: unknown[] = [p.startId, p.maxDepth, p.graphId, p.confidenceMin];
  let typeFilter = '';
  let nextIdx = 5;
  if (p.edgeTypes) {
    typeFilter = ` AND e.type = ANY($${nextIdx}::text[])`;
    params.push(p.edgeTypes);
    nextIdx += 1;
  }
  const notSelfIdx = nextIdx;
  const rowCapIdx = nextIdx + 1;
  params.push(p.startId, p.rowCap);
  const sql = `
    WITH RECURSIVE reach(node_id, depth) AS (
      SELECT $1::text AS node_id, 0 AS depth
      UNION
      SELECT e.${discoverCol}, r.depth + 1
      FROM ontology_edges e
      JOIN reach r ON e.${joinCol} = r.node_id
      WHERE r.depth < $2
        AND e.graph_id = $3
        AND e.status = 'active'
        AND e.confidence >= $4${typeFilter}
    )
    SELECT node_id, MIN(depth) AS depth
    FROM reach
    WHERE node_id <> $${notSelfIdx}
    GROUP BY node_id
    ORDER BY depth ASC
    LIMIT $${rowCapIdx}
  `;
  return { sql, params };
}

/** ontology-tools.ts의 graph_call_path 핸들러가 path 스텝의 src/dst를
 *  path:line 그라운딩용으로 하이드레이트할 때도 재사용한다(DESIGN.md 축 6:
 *  "every symbol/match carries path/start_line/end_line"). */
export async function hydrateNodes(dataSource: DataSource, graphId: string, ids: string[]): Promise<Map<string, OntologyNode>> {
  const out = new Map<string, OntologyNode>();
  if (ids.length === 0) return out;
  const repo = dataSource.getRepository(OntologyNode);
  for (let i = 0; i < ids.length; i += FRONTIER_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + FRONTIER_CHUNK_SIZE);
    const rows = await repo.find({ where: { graph_id: graphId, status: 'active', id: In(chunk) } });
    for (const n of rows) out.set(n.id, n);
    await yieldToEventLoop();
  }
  return out;
}

/**
 * DESIGN.md 축 6(I1 해소분) — graph_neighbors/graph_blast_radius의 응답
 * 레벨 completeness rollup. 재귀 CTE 자체(UNION distinct 기반 (node_id,depth)
 * dedup, 3라운드 리뷰를 거쳐 확정된 형태 — 파일 헤더 참고)는 건드리지
 * 않는다: completeness를 재귀 튜플에 얹으면 그 dedup 의미론이 깨진다(같은
 * 노드/depth라도 completeness가 다른 두 경로가 서로 다른 행으로 남아
 * "노드 수 × maxDepth" 상한이 무너진다). 대신 반환된 노드 집합에 대해서만
 * 유계(rowCap 크기)인 별도 rollup 질의로 답한다 — truncated와 마찬가지로
 * "이미 반환한 것"에 대한 정직성 신호이지, 잘려나간 전체 도달집합에 대한
 * 주장이 아니다.
 *
 * 결과 0건일 때는 이 rollup 질의 자체가 공허해지므로(discoveredIds가
 * 비어 있음) 다른 질문을 던진다: confidence_min 아래로 걸러진 엣지가
 * startId에서 나가는(방향에 따라 들어오는) 방향으로 하나라도 있는가?
 * 있다면 "확인된 무(無)"가 아니라 "알려진 커버리지 gap"이다 — 정확히
 * DESIGN.md가 든 예시(DECORATES 엣지가 기본 0.75 플로어 바로 아래
 * confidence≈0.6에 있어, 리플렉션/DI로만 도달하는 대상은 기본값으로
 * 조용히 빈 결과가 됨)를 구분해낸다.
 */
async function rollupCompleteness(
  dataSource: DataSource,
  direction: ReachDirection,
  graphId: string,
  startId: string,
  confidenceMin: number,
  edgeTypes: string[] | undefined,
  discoveredIds: string[],
): Promise<OntologyCompleteness> {
  const edgeRepo = dataSource.getRepository(OntologyEdge);

  if (discoveredIds.length > 0) {
    // 이 노드들을 "발견시킨" 엣지들 — outgoing이면 dst_id가, incoming이면
    // src_id가 발견된 쪽.
    const discoverCol = direction === 'outgoing' ? 'dst_id' : 'src_id';
    let sawComplete = false;
    for (let i = 0; i < discoveredIds.length; i += FRONTIER_CHUNK_SIZE) {
      const chunk = discoveredIds.slice(i, i + FRONTIER_CHUNK_SIZE);
      const qb = edgeRepo.createQueryBuilder('e')
        .select('DISTINCT e.completeness', 'completeness')
        .where('e.graph_id = :graphId', { graphId })
        .andWhere('e.status = :status', { status: 'active' })
        .andWhere('e.confidence >= :confidenceMin', { confidenceMin })
        .andWhere(`e.${discoverCol} IN (:...chunk)`, { chunk });
      if (edgeTypes) qb.andWhere('e.type IN (:...edgeTypes)', { edgeTypes });
      const rows: Array<{ completeness: OntologyCompleteness }> = await qb.getRawMany();
      for (const r of rows) {
        if (r.completeness === 'incomplete') return 'incomplete'; // worst-case 즉시 확정 — path_confidence의 min-along-path와 같은 정직성 원칙
        if (r.completeness === 'complete') sawComplete = true;
      }
      await yieldToEventLoop();
    }
    return sawComplete ? 'complete' : 'no_assertion';
  }

  // 결과 0건 — startId에서 이 방향으로 confidence_min 미만이라 걸러진 엣지가
  // 있는지 확인한다(있으면 "알려진 gap" = incomplete).
  const joinCol = direction === 'outgoing' ? 'src_id' : 'dst_id';
  const belowFloor = await edgeRepo.createQueryBuilder('e')
    .select('e.id', 'id')
    .where('e.graph_id = :graphId', { graphId })
    .andWhere('e.status = :status', { status: 'active' })
    .andWhere(`e.${joinCol} = :startId`, { startId })
    .andWhere('e.confidence < :confidenceMin', { confidenceMin })
    .limit(1)
    .getRawOne();
  return belowFloor ? 'incomplete' : 'no_assertion';
}

async function boundedReach(dataSource: DataSource, direction: ReachDirection, input: GraphReachInput): Promise<GraphReachResult> {
  const startedAt = Date.now();
  if (!input.graphId) throw new Error('graph-query: graphId is required');
  if (!input.nodeId) throw new Error('graph-query: nodeId is required');
  const dialect = resolveDialect(dataSource);
  const maxDepth = normalizeMaxDepth(input.maxDepth);
  const confidenceMin = normalizeConfidenceMin(input.confidenceMin);
  const rowCap = normalizeRowCap(input.rowCap);
  const edgeTypes = normalizeEdgeTypes(input.edgeTypes);

  const buildSql = dialect === 'postgres' ? buildReachSqlPostgres : buildReachSqlSqlite;
  // rowCap보다 1개 더 가져와서, 정확히 rowCap개가 "우연히 딱 맞은" 경우와
  // "잘렸다"를 구분한다(추가 COUNT 쿼리 없이 truncated를 정확히 판정).
  const { sql, params } = buildSql({
    direction,
    startId: input.nodeId,
    graphId: input.graphId,
    maxDepth,
    confidenceMin,
    edgeTypes,
    rowCap: rowCap + 1,
  });

  const raw: Array<{ node_id: string; depth: number | string }> = await dataSource.query(sql, params);
  const truncated = raw.length > rowCap;
  const capped = raw.slice(0, rowCap);
  const nodesById = await hydrateNodes(dataSource, input.graphId, capped.map((r) => r.node_id));

  const rows: GraphReachResultRow[] = [];
  for (const r of capped) {
    const node = nodesById.get(r.node_id);
    if (!node) continue; // 엣지 status='active'는 통과했으나 대상 노드가 quarantined/removed로 걸러진 드문 경우 — 조용히 스킵
    rows.push({ node, depth: typeof r.depth === 'string' ? Number.parseInt(r.depth, 10) : r.depth });
  }

  const completeness = await rollupCompleteness(
    dataSource, direction, input.graphId, input.nodeId, confidenceMin, edgeTypes, rows.map((r) => r.node.id),
  );

  return { rows, truncated, maxDepth, confidenceMin, completeness, durationMs: Date.now() - startedAt };
}

/** DESIGN.md §11 seed #5 — 정방향(src->dst) 이웃 탐색. edgeTypes로 필터 가능. */
export async function graphNeighbors(dataSource: DataSource, input: GraphReachInput): Promise<GraphReachResult> {
  return boundedReach(dataSource, 'outgoing', input);
}

/** research-extraction.md §5.3 — "reverse-reachability = the query enterprises actually want": 역방향(dst->src)으로 "이 노드에 의존하는 것은 무엇인가"를 답한다. */
export async function graphBlastRadius(dataSource: DataSource, input: GraphReachInput): Promise<GraphReachResult> {
  return boundedReach(dataSource, 'incoming', input);
}

// ─────────────────────────────────────────────────────────────────────────
// graph_call_path — application-orchestrated bidirectional level-BFS
// ─────────────────────────────────────────────────────────────────────────

export interface GraphCallPathInput {
  graphId: string;
  fromId: string;
  toId: string;
  edgeTypes?: string[];
  confidenceMin?: number;
  /** 하드 상한 MAX_CALL_PATH_HOPS(10)로 클램프된다 — 절대 unbounded 아님. */
  maxHops?: number;
}

export interface GraphCallPathStep {
  edgeId: string;
  srcId: string;
  dstId: string;
  type: string;
  confidence: number;
}

export interface GraphCallPathResult {
  found: boolean;
  path: GraphCallPathStep[];
  /** min-along-path(never multiplied) — research-ontology.md §6.5. found=false면 null, fromId===toId(빈 경로)면 1. */
  pathConfidence: number | null;
  hops: number;
  nodesVisited: number;
  /** true면 MAX_CALL_PATH_VISITED 캡에 걸려 조기 중단됨(found는 false) — 방문집합 자체에 대한 defense-in-depth. */
  truncated: boolean;
  /** DESIGN.md 축 6 — 실제 적용된 confidence floor(입력 미지정 시
   *  DEFAULT_CONFIDENCE_MIN=0.75). graph_neighbors/graph_blast_radius의
   *  GraphReachResult.confidenceMin과 같은 자세 — 호출자가 생략해도 응답이
   *  실제 적용값을 정직하게 알려준다. */
  confidenceMin: number;
  durationMs: number;
}

interface VisitRecord {
  /** 루트(fromId/toId) 자신은 null. */
  edge: GraphCallPathStep | null;
  /** forward 방향: 이 노드의 부모(fromId 쪽으로 한 걸음). backward 방향: 이 노드의 자식(toId 쪽으로 한 걸음). 루트는 null. */
  via: string | null;
  /** 이 노드를 최초 발견한 라운드에서의, 그 방향 자신의 depth(fromId/toId=0). */
  depth: number;
}

interface MeetingCandidate {
  nodeId: string;
  /** forwardDepth + backwardDepth — 이 교차점을 지나는 경로의 총 hop 수. */
  combinedDepth: number;
  edge: GraphCallPathStep;
  /** 이 방향(thisVisited) 쪽에서 본 부모/자식 — 후보가 선정되면 이 값으로 VisitRecord를 커밋한다. */
  via: string;
}

interface ExpandSideResult {
  next: string[];
  candidates: MeetingCandidate[];
  truncated: boolean;
}

const CANDIDATE_KEY_CHUNK_SIZE = 200; // otherVisited 키를 IN(...)에 넣을 때의 청크 크기 — FRONTIER_CHUNK_SIZE(500)와 곱해진 상한(아래 후보 탐지 쿼리 코멘트)을 더 좁게 유지하려고 일부러 더 작게 잡는다.

interface CandidateSqlParams {
  matchColumn: 'src_id' | 'dst_id';
  discoverColumn: 'src_id' | 'dst_id';
  chunk: string[];
  otherChunk: string[];
  graphId: string;
  confidenceMin: number;
  edgeTypes?: string[];
}

interface CandidateRow {
  id: string;
  src_id: string;
  dst_id: string;
  type: string;
  confidence: number | string;
  discovered_id: string;
}

// 후보 탐지 SQL(양 방언 공통 설계) — 리뷰 지적(3라운드): OntologyEdge에는
// (graph_id, src_id, dst_id[, type]) 유일성 제약이 없어, 같은 frontier→
// discovered 쌍 사이에 서로 다른 type/evidence/run의 active edge가 임의
// 개수 있을 수 있다. "결과의 서로 다른 discoveredId 수는 otherChunk
// 크기로 유계"였던 이전 주장은 **행 수**가 아니라 **distinct 값 개수**에만
// 해당했다 — LIMIT 없는 `getMany()`는 discoveredId당 parallel edge가
// 전부 몇 개든 다 적재했다. 이제 `ROW_NUMBER() OVER (PARTITION BY
// discoverColumn ORDER BY confidence DESC, id ASC)`로 discoveredId당
// 대표 edge를 정확히 1개(가장 신뢰도 높은 것, 동점이면 id로 결정론적
// tie-break)만 골라 **결과 row 자체를 otherChunk 크기로 상한**한다 —
// distinct 값 개수가 아니라 실제 반환 row 수가 유계라는 뜻. 어느 한
// (src,dst) 쌍에 60,000개의 parallel edge가 있어도 SQL 엔진이 내부적으로
// 정렬하는 동안만 처리하고, Node 쪽으로 넘어오는 entity/row는 여전히
// discoveredId당 1개뿐이다(TypeORM 엔티티 hydration 비용도 그만큼만).
function buildCandidateSqlSqlite(p: CandidateSqlParams): { sql: string; params: unknown[] } {
  const params: unknown[] = [p.graphId, p.confidenceMin];
  const chunkPh = p.chunk.map(() => '?').join(', ');
  params.push(...p.chunk);
  const otherPh = p.otherChunk.map(() => '?').join(', ');
  params.push(...p.otherChunk);
  let typeFilter = '';
  if (p.edgeTypes) {
    typeFilter = ` AND e.type IN (${p.edgeTypes.map(() => '?').join(', ')})`;
    params.push(...p.edgeTypes);
  }
  const sql = `
    WITH ranked AS (
      SELECT e.id AS edge_id, e.src_id, e.dst_id, e.type, e.confidence,
             e.${p.discoverColumn} AS discovered_id,
             ROW_NUMBER() OVER (PARTITION BY e.${p.discoverColumn} ORDER BY e.confidence DESC, e.id ASC) AS rn
      FROM ontology_edges e
      WHERE e.graph_id = ?
        AND e.status = 'active'
        AND e.confidence >= ?
        AND e.${p.matchColumn} IN (${chunkPh})
        AND e.${p.discoverColumn} IN (${otherPh})${typeFilter}
    )
    SELECT edge_id AS id, src_id, dst_id, type, confidence, discovered_id
    FROM ranked
    WHERE rn = 1
  `;
  return { sql, params };
}

function buildCandidateSqlPostgres(p: CandidateSqlParams): { sql: string; params: unknown[] } {
  const params: unknown[] = [p.graphId, p.confidenceMin];
  let idx = 3;
  const chunkPh = p.chunk.map(() => `$${idx++}`).join(', ');
  params.push(...p.chunk);
  const otherPh = p.otherChunk.map(() => `$${idx++}`).join(', ');
  params.push(...p.otherChunk);
  let typeFilter = '';
  if (p.edgeTypes) {
    typeFilter = ` AND e.type = ANY($${idx}::text[])`;
    params.push(p.edgeTypes);
    idx += 1;
  }
  const sql = `
    WITH ranked AS (
      SELECT e.id AS edge_id, e.src_id, e.dst_id, e.type, e.confidence,
             e.${p.discoverColumn} AS discovered_id,
             ROW_NUMBER() OVER (PARTITION BY e.${p.discoverColumn} ORDER BY e.confidence DESC, e.id ASC) AS rn
      FROM ontology_edges e
      WHERE e.graph_id = $1
        AND e.status = 'active'
        AND e.confidence >= $2
        AND e.${p.matchColumn} IN (${chunkPh})
        AND e.${p.discoverColumn} IN (${otherPh})${typeFilter}
    )
    SELECT edge_id AS id, src_id, dst_id, type, confidence, discovered_id
    FROM ranked
    WHERE rn = 1
  `;
  return { sql, params };
}

interface RankedLimitSqlParams {
  matchColumn: 'src_id' | 'dst_id';
  discoverColumn: 'src_id' | 'dst_id';
  chunk: string[];
  graphId: string;
  confidenceMin: number;
  edgeTypes?: string[];
  limit: number;
}

// "새 노드 발견"(2단계) 전용 — buildCandidateSql*과 같은 이유(스키마에
// parallel edge를 막는 유일성 제약이 없음, 리뷰 지적 3라운드)로 여기도
// discoveredId당 대표 edge 1개만 골라야 한다. 후보 탐지와의 차이는
// otherChunk 필터가 없다는 것과, "몇 개의 서로 다른 새 노드까지
// 볼 것인가"를 뜻하는 LIMIT이 ROW_NUMBER로 디듀프된 뒤에 걸린다는 것
// — 그래야 LIMIT이 진짜 "새 노드 수" 예산이지, "같은 새 노드로 가는
// parallel edge 행 수"에 좀먹히지 않는다.
function buildNewNodeSqlSqlite(p: RankedLimitSqlParams): { sql: string; params: unknown[] } {
  const params: unknown[] = [p.graphId, p.confidenceMin];
  const chunkPh = p.chunk.map(() => '?').join(', ');
  params.push(...p.chunk);
  let typeFilter = '';
  if (p.edgeTypes) {
    typeFilter = ` AND e.type IN (${p.edgeTypes.map(() => '?').join(', ')})`;
    params.push(...p.edgeTypes);
  }
  params.push(p.limit);
  const sql = `
    WITH ranked AS (
      SELECT e.id AS edge_id, e.src_id, e.dst_id, e.type, e.confidence,
             e.${p.discoverColumn} AS discovered_id,
             ROW_NUMBER() OVER (PARTITION BY e.${p.discoverColumn} ORDER BY e.confidence DESC, e.id ASC) AS rn
      FROM ontology_edges e
      WHERE e.graph_id = ?
        AND e.status = 'active'
        AND e.confidence >= ?
        AND e.${p.matchColumn} IN (${chunkPh})${typeFilter}
    )
    SELECT edge_id AS id, src_id, dst_id, type, confidence, discovered_id
    FROM ranked
    WHERE rn = 1
    ORDER BY discovered_id ASC
    LIMIT ?
  `;
  return { sql, params };
}

function buildNewNodeSqlPostgres(p: RankedLimitSqlParams): { sql: string; params: unknown[] } {
  const params: unknown[] = [p.graphId, p.confidenceMin];
  let idx = 3;
  const chunkPh = p.chunk.map(() => `$${idx++}`).join(', ');
  params.push(...p.chunk);
  let typeFilter = '';
  if (p.edgeTypes) {
    typeFilter = ` AND e.type = ANY($${idx}::text[])`;
    params.push(p.edgeTypes);
    idx += 1;
  }
  params.push(p.limit);
  const limitIdx = idx;
  const sql = `
    WITH ranked AS (
      SELECT e.id AS edge_id, e.src_id, e.dst_id, e.type, e.confidence,
             e.${p.discoverColumn} AS discovered_id,
             ROW_NUMBER() OVER (PARTITION BY e.${p.discoverColumn} ORDER BY e.confidence DESC, e.id ASC) AS rn
      FROM ontology_edges e
      WHERE e.graph_id = $1
        AND e.status = 'active'
        AND e.confidence >= $2
        AND e.${p.matchColumn} IN (${chunkPh})${typeFilter}
    )
    SELECT edge_id AS id, src_id, dst_id, type, confidence, discovered_id
    FROM ranked
    WHERE rn = 1
    ORDER BY discovered_id ASC
    LIMIT $${limitIdx}
  `;
  return { sql, params };
}

/** DESIGN.md §11 seed #5 / research-storage.md §2.4 — "Shortest call path — unsafe as one query, safe as an orchestrated loop." 양 끝에서 교대로 레벨 단위로 확장한다.
 *
 * **리뷰 지적(2라운드)으로 재설계됨** — 1라운드 수정(청크당 SQL LIMIT으로
 * 방문 예산 강제 + 라운드 전체 후보 중 combinedDepth 최소 선택)은 각각은
 * 옳았지만 **결합**하면 새 결함이 생겼다: 한 청크가 예산 캡에 걸려 잘리고
 * 그 잘린 부분집합 안에서 후보가 하나라도 나오면, 잘려나가 아예 조회되지
 * 않은 나머지 부분에 더 짧은(combinedDepth가 더 작은) 후보가 있어도
 * 놓친 채 확정해버렸다 — "라운드 전체를 본다"는 전제가 예산 캡 경계에서
 * 깨진 것.
 *
 * 고친 구조: 이번 청크에서 할 일을 **두 단계로 분리**한다.
 *   (1) **후보 탐지** — `discoverColumn IN otherVisited의 키`로 딱 집어
 *       조회한다(buildCandidateSql* 참고 — ROW_NUMBER()로 discoveredId당
 *       대표 edge 1개만 골라 **결과 row 자체**가 otherVisited 청크
 *       크기(<=CANDIDATE_KEY_CHUNK_SIZE)로 유계다, distinct 값 개수가
 *       아니라 — 리뷰 지적 3라운드). 이 바운드는 허브의 raw fan-out과
 *       무관하므로 **LIMIT을 걸지 않는다**(걸면 2라운드에 지적된 버그가
 *       재발한다). thisVisited는 건드리지 않는다 — 승자만 나중에
 *       커밋해야, otherVisited가 클수록 후보 수만큼 방문 예산을 소모해
 *       안전 상한을 우회하는 일이 없다.
 *   (2) **새 노드 발견** — otherVisited에 없는, 진짜 처음 보는 노드만
 *       상대로 한다(이미 (1)에서 다뤘으므로 명시적으로 제외). 허브의
 *       원래 위험(단일 노드가 수백만 active edge)이 실제로 존재하는
 *       곳이 여기라, 남은 방문 예산을 SQL `LIMIT`으로 그대로 강제한다.
 *       (1)에서 이미 후보가 나왔으면 이번 청크의 (2)는 건너뛴다 — 답을
 *       이미 확정할 수 있으니 새 프론티어를 더 넓힐 필요가 없다.
 * 이 분리 덕분에 "후보 판정"은 절대 SQL LIMIT에 의해 잘리지 않는다 —
 * 라운드 안의 모든 후보가 항상 전부 모인 뒤에야 비교된다. */
async function expandOneSide(
  dataSource: DataSource,
  graphId: string,
  confidenceMin: number,
  edgeTypes: string[] | undefined,
  matchColumn: 'src_id' | 'dst_id',
  discoverIsDst: boolean,
  frontier: string[],
  thisVisited: Map<string, VisitRecord>,
  otherVisited: Map<string, VisitRecord>,
  thisDepth: number,
): Promise<ExpandSideResult> {
  const next: string[] = [];
  const candidates: MeetingCandidate[] = [];
  const dialect = resolveDialect(dataSource);
  const discoverColumn = discoverIsDst ? 'dst_id' : 'src_id';
  const otherKeys = [...otherVisited.keys()];

  for (let i = 0; i < frontier.length; i += FRONTIER_CHUNK_SIZE) {
    const chunk = frontier.slice(i, i + FRONTIER_CHUNK_SIZE);

    // ── (1) 후보 탐지 — LIMIT 없음, discoveredId당 대표 edge 1개만
    // 반환되므로 결과 row 자체가 otherChunk 크기로 유계 ──
    for (let j = 0; j < otherKeys.length; j += CANDIDATE_KEY_CHUNK_SIZE) {
      const otherChunk = otherKeys.slice(j, j + CANDIDATE_KEY_CHUNK_SIZE);
      const buildCandidateSql = dialect === 'postgres' ? buildCandidateSqlPostgres : buildCandidateSqlSqlite;
      const { sql, params } = buildCandidateSql({ matchColumn, discoverColumn, chunk, otherChunk, graphId, confidenceMin, edgeTypes });
      const rows: CandidateRow[] = await dataSource.query(sql, params);
      for (const r of rows) {
        const discoveredId = r.discovered_id;
        const viaId = discoverIsDst ? r.src_id : r.dst_id;
        const other = otherVisited.get(discoveredId)!; // otherChunk 자체가 otherVisited.keys()에서 왔으므로 항상 존재
        const confidence = typeof r.confidence === 'string' ? Number.parseFloat(r.confidence) : r.confidence;
        candidates.push({
          nodeId: discoveredId,
          combinedDepth: thisDepth + other.depth,
          edge: { edgeId: r.id, srcId: r.src_id, dstId: r.dst_id, type: r.type, confidence },
          via: viaId,
        });
      }
      await yieldToEventLoop();
    }
    if (candidates.length > 0) continue; // 이미 답을 확정할 수 있음 — 이 청크의 (2)는 건너뛴다(다음 청크의 (1)은 계속 돈다 — 더 짧은 후보가 있을 수 있으므로).

    // ── (2) 새 노드 발견 — discoveredId당 대표 edge 1개로 디듀프한 뒤
    // 남은 방문 예산만큼 SQL LIMIT으로 강제(디듀프 후 LIMIT 순서가
    // 중요 — 그래야 LIMIT이 "새 노드 수" 예산이지 parallel edge 행
    // 수에 좀먹히지 않는다) ──
    const remaining = MAX_CALL_PATH_VISITED - (thisVisited.size + otherVisited.size);
    if (remaining <= 0) return { next, candidates, truncated: true };
    const buildNewNodeSql = dialect === 'postgres' ? buildNewNodeSqlPostgres : buildNewNodeSqlSqlite;
    // +1: 이 청크 하나가 예산을 넘는지 잘라내지 않고도 판별하기 위함 —
    // 이 쿼리는 최대 remaining+1개의 "서로 다른 새 노드" row를 반환한다
    // (정확히 예산과 같은 수가 아니라 "그보다 하나 더 많을 수 있다" —
    // 판별용으로 의도적).
    const { sql: newNodeSql, params: newNodeParams } = buildNewNodeSql({
      matchColumn, discoverColumn, chunk, graphId, confidenceMin, edgeTypes, limit: remaining + 1,
    });
    const newNodeRows: CandidateRow[] = await dataSource.query(newNodeSql, newNodeParams);

    const chunkExceeded = newNodeRows.length > remaining;
    const usable = chunkExceeded ? newNodeRows.slice(0, remaining) : newNodeRows;

    for (const r of usable) {
      const discoveredId = r.discovered_id;
      const viaId = discoverIsDst ? r.src_id : r.dst_id;
      // otherVisited 멤버는 (1)이 이미 후보로 전부 처리했으므로 명시적으로
      // 제외한다 — 여기 도달하는 건 반드시 양쪽 다 몰랐던 진짜 새 노드다.
      if (thisVisited.has(discoveredId) || otherVisited.has(discoveredId)) continue;
      const confidence = typeof r.confidence === 'string' ? Number.parseFloat(r.confidence) : r.confidence;
      thisVisited.set(discoveredId, { edge: { edgeId: r.id, srcId: r.src_id, dstId: r.dst_id, type: r.type, confidence }, via: viaId, depth: thisDepth });
      next.push(discoveredId);
    }

    if (chunkExceeded) return { next, candidates, truncated: true };
    await yieldToEventLoop();
  }
  return { next, candidates, truncated: false };
}

export async function graphCallPath(dataSource: DataSource, input: GraphCallPathInput): Promise<GraphCallPathResult> {
  const startedAt = Date.now();
  if (!input.graphId) throw new Error('graph-query: graphId is required');
  if (!input.fromId) throw new Error('graph-query: fromId is required');
  if (!input.toId) throw new Error('graph-query: toId is required');
  resolveDialect(dataSource); // 지원 dialect 가드 — BFS 쿼리 자체는 TypeORM QueryBuilder라 dialect-agnostic하지만, 지원 백엔드 목록은 CTE 경로와 동일하게 강제한다.

  const confidenceMin = normalizeConfidenceMin(input.confidenceMin);
  const rawMaxHops = input.maxHops ?? MAX_CALL_PATH_HOPS;
  if (!Number.isFinite(rawMaxHops) || rawMaxHops < 1) {
    throw new Error(`graph-query: maxHops must be >= 1, got ${String(input.maxHops)}`);
  }
  const maxHops = Math.min(Math.trunc(rawMaxHops), MAX_CALL_PATH_HOPS);
  const edgeTypes = normalizeEdgeTypes(input.edgeTypes);

  if (input.fromId === input.toId) {
    return { found: true, path: [], pathConfidence: 1, hops: 0, nodesVisited: 1, truncated: false, confidenceMin, durationMs: Date.now() - startedAt };
  }

  const forwardVisited = new Map<string, VisitRecord>([[input.fromId, { edge: null, via: null, depth: 0 }]]);
  const backwardVisited = new Map<string, VisitRecord>([[input.toId, { edge: null, via: null, depth: 0 }]]);
  let forwardFrontier = [input.fromId];
  let backwardFrontier = [input.toId];
  let forwardDepth = 0;
  let backwardDepth = 0;
  let meetingId: string | null = null;
  let truncated = false;

  // 매 라운드 정확히 "한쪽만" 한 레벨 확장한다(양쪽을 동시에 확장하면
  // maxHops가 라운드 수를 세게 되어 실제로는 편도 maxHops씩, 합쳐서
  // 최대 2*maxHops짜리 경로까지 찾아버린다 — research-storage.md §2.4의
  // "a hard depth ceiling (e.g. 10 hops)"는 총 경로 길이 상한을 뜻하므로,
  // round 카운트가 곧 총 hop 수와 정확히 일치해야 한다). 양쪽 다 프론티어가
  // 남아있으면 교대로, 한쪽이 막히면 남은 쪽으로 예산을 몰아준다.
  let forwardTurn = true;
  for (let round = 0; !meetingId && round < maxHops; round += 1) {
    const useForward = forwardTurn ? forwardFrontier.length > 0 : forwardFrontier.length > 0 && backwardFrontier.length === 0;
    const useBackward = !useForward && backwardFrontier.length > 0;
    if (!useForward && !useBackward) break; // 양쪽 다 막다른 길 — 더 확장할 프론티어가 없음

    let candidates: MeetingCandidate[];
    if (useForward) {
      forwardDepth += 1;
      const r = await expandOneSide(
        dataSource, input.graphId, confidenceMin, edgeTypes,
        'src_id', true, forwardFrontier, forwardVisited, backwardVisited, forwardDepth,
      );
      forwardFrontier = r.next;
      candidates = r.candidates;
      if (r.truncated) truncated = true;
    } else {
      backwardDepth += 1;
      const r = await expandOneSide(
        dataSource, input.graphId, confidenceMin, edgeTypes,
        'dst_id', false, backwardFrontier, backwardVisited, forwardVisited, backwardDepth,
      );
      backwardFrontier = r.next;
      candidates = r.candidates;
      if (r.truncated) truncated = true;
    }
    forwardTurn = !forwardTurn;

    if (candidates.length > 0) {
      // 이번 라운드에서 발견된 교차 후보 중 총 hop 수가 최소인 것을 고른다
      // — 쿼리 행 순서와 무관하게 진짜 최단 경로가 되도록(리뷰 지적 3).
      // expandOneSide의 후보 탐지(위 함수 코멘트 (1))는 SQL LIMIT을 전혀
      // 쓰지 않으므로, 여기 모인 candidates는 이번 라운드의 전체 집합이지
      // 예산 캡에 잘린 부분집합이 아니다(리뷰 지적 2라운드로 고친 부분).
      let best = candidates[0];
      for (const c of candidates) if (c.combinedDepth < best.combinedDepth) best = c;
      meetingId = best.nodeId;
      // 승자만 thisVisited(이번 라운드를 확장한 쪽)에 커밋한다 — 다른
      // 후보들은 방문 예산에 넣지 않는다(otherVisited가 클수록 후보 수만큼
      // 예산을 소모하면 안전 상한을 우회할 수 있다).
      const winnerVisited = useForward ? forwardVisited : backwardVisited;
      if (!winnerVisited.has(meetingId)) {
        winnerVisited.set(meetingId, { edge: best.edge, via: best.via, depth: useForward ? forwardDepth : backwardDepth });
      }
      truncated = false; // 답을 확정했으므로 이번 라운드의 부분 truncation은 무관하다.
      break;
    }
    if (truncated) break; // 후보 없이 예산 초과 — 더 진행해도 안전하지 않다.
    await yieldToEventLoop();
  }

  const nodesVisited = forwardVisited.size + backwardVisited.size;
  if (!meetingId) {
    return { found: false, path: [], pathConfidence: null, hops: 0, nodesVisited, truncated, confidenceMin, durationMs: Date.now() - startedAt };
  }

  const forwardHalf: GraphCallPathStep[] = [];
  for (let cur = meetingId; ; ) {
    const rec = forwardVisited.get(cur)!;
    if (!rec.edge || rec.via === null) break; // fromId 자신(루트 마커)에 도달
    forwardHalf.unshift(rec.edge);
    cur = rec.via;
  }
  const backwardHalf: GraphCallPathStep[] = [];
  for (let cur = meetingId; ; ) {
    const rec = backwardVisited.get(cur)!;
    if (!rec.edge || rec.via === null) break; // toId 자신(루트 마커)에 도달
    backwardHalf.push(rec.edge);
    cur = rec.via;
  }
  const path = [...forwardHalf, ...backwardHalf];
  const pathConfidence = path.reduce((min, step) => Math.min(min, step.confidence), 1);

  return { found: true, path, pathConfidence, hops: path.length, nodesVisited, truncated: false, confidenceMin, durationMs: Date.now() - startedAt };
}
