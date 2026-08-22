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
// 중요: depth cap은 "출력 row 수"가 아니라 "재귀 평가 자체가 절대 무한/
// 임의로 깊어지지 않는다"는 것만 보장한다 — 조밀한(fan-out이 큰) 그래프에서는
// 캡 안에서도 중간 평가 비용이 노드 수가 아니라 Σ(fan-in×fan-out)^depth에
// 가깝다는 것을 research-storage.md §2.4가 스스로 인정한다("re-explores a
// node once per distinct incoming path within the depth cap... acceptable
// because depth is capped"). 이 파일의 안전장치는 (1) depth cap을 항상 강제
// 적용(기본 3-6 hop 대역, null/unbounded 절대 불가), (2) 출력 row cap을
// LIMIT으로 강제(SQLite 공식 문서가 권고하는 "unconditional LIMIT" 안전판),
// (3) BFS는 방문 노드 수 자체에도 별도 상한을 둔다 — 세 가지 조합이지,
// 어느 하나도 "임의로 조밀한 그래프에서 항상 빠르다"는 보장은 아니다.
import type { DataSource } from 'typeorm';
import { OntologyEdge } from '../../../entities/OntologyEdge';
import { OntologyNode } from '../../../entities/OntologyNode';
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

function normalizeConfidenceMin(value: number | undefined): number {
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

// SQLite/sql.js variant — research-storage.md §2.4의 illustrative SQL을
// 그대로 이식(cycle guard: 구분자 문자열 + instr()). id는 uuid라 쉼표를
// 포함하지 않으므로 ','를 구분자로 써도 충돌하지 않는다(원 SQL의 가정과 동일).
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
  const params: unknown[] = [p.startId, p.startId, p.maxDepth, p.graphId, p.confidenceMin];
  let typeFilter = '';
  if (p.edgeTypes) {
    typeFilter = ` AND e.type IN (${p.edgeTypes.map(() => '?').join(', ')})`;
    params.push(...p.edgeTypes);
  }
  params.push(p.startId, p.rowCap);
  const sql = `
    WITH RECURSIVE reach(node_id, depth, path) AS (
      SELECT ? AS node_id, 0 AS depth, ',' || ? || ',' AS path
      UNION ALL
      SELECT e.${discoverCol} AS node_id, r.depth + 1 AS depth, r.path || e.${discoverCol} || ',' AS path
      FROM reach r
      CROSS JOIN ontology_edges e ON e.${joinCol} = r.node_id
      WHERE r.depth < ?
        AND e.graph_id = ?
        AND e.status = 'active'
        AND e.confidence >= ?${typeFilter}
        AND instr(r.path, ',' || e.${discoverCol} || ',') = 0
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

// Postgres variant — 동일 의미론, cycle guard만 text[] + ANY()로 이식
// (research-storage.md §2.4: "ported to a Postgres text[]/ANY() check").
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
    WITH RECURSIVE reach(node_id, depth, path) AS (
      SELECT $1::text AS node_id, 0 AS depth, ARRAY[$1::text] AS path
      UNION ALL
      SELECT e.${discoverCol}, r.depth + 1, r.path || e.${discoverCol}
      FROM ontology_edges e
      JOIN reach r ON e.${joinCol} = r.node_id
      WHERE r.depth < $2
        AND e.graph_id = $3
        AND e.status = 'active'
        AND e.confidence >= $4${typeFilter}
        AND NOT (e.${discoverCol} = ANY(r.path))
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

async function hydrateNodes(dataSource: DataSource, graphId: string, ids: string[]): Promise<Map<string, OntologyNode>> {
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

  return { rows, truncated, maxDepth, confidenceMin, durationMs: Date.now() - startedAt };
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
  durationMs: number;
}

interface VisitRecord {
  edge: GraphCallPathStep;
  /** forward 방향: 이 노드의 부모(fromId 쪽으로 한 걸음). backward 방향: 이 노드의 자식(toId 쪽으로 한 걸음). */
  via: string;
}

function toStep(e: OntologyEdge): GraphCallPathStep {
  return { edgeId: e.id, srcId: e.src_id, dstId: e.dst_id, type: e.type, confidence: e.confidence };
}

async function fetchFrontierEdges(
  dataSource: DataSource,
  graphId: string,
  confidenceMin: number,
  edgeTypes: string[] | undefined,
  column: 'src_id' | 'dst_id',
  frontier: string[],
): Promise<OntologyEdge[]> {
  if (frontier.length === 0) return [];
  const repo = dataSource.getRepository(OntologyEdge);
  const out: OntologyEdge[] = [];
  for (let i = 0; i < frontier.length; i += FRONTIER_CHUNK_SIZE) {
    const chunk = frontier.slice(i, i + FRONTIER_CHUNK_SIZE);
    let qb = repo
      .createQueryBuilder('e')
      .where('e.graph_id = :graphId', { graphId })
      .andWhere('e.status = :status', { status: 'active' })
      .andWhere('e.confidence >= :confidenceMin', { confidenceMin })
      .andWhere(`e.${column} IN (:...chunk)`, { chunk });
    if (edgeTypes) qb = qb.andWhere('e.type IN (:...edgeTypes)', { edgeTypes });
    out.push(...(await qb.getMany()));
    await yieldToEventLoop();
  }
  return out;
}

/** DESIGN.md §11 seed #5 / research-storage.md §2.4 — "Shortest call path — unsafe as one query, safe as an orchestrated loop." 양 끝에서 동시에 레벨 단위로 확장하고 프론티어가 만나는 즉시 멈춘다. */
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
    return { found: true, path: [], pathConfidence: 1, hops: 0, nodesVisited: 1, truncated: false, durationMs: Date.now() - startedAt };
  }

  const forwardVisited = new Map<string, VisitRecord | null>([[input.fromId, null]]);
  const backwardVisited = new Map<string, VisitRecord | null>([[input.toId, null]]);
  let forwardFrontier = [input.fromId];
  let backwardFrontier = [input.toId];
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

    if (useForward) {
      const edges = await fetchFrontierEdges(dataSource, input.graphId, confidenceMin, edgeTypes, 'src_id', forwardFrontier);
      const next: string[] = [];
      for (const e of edges) {
        if (forwardVisited.has(e.dst_id)) continue;
        forwardVisited.set(e.dst_id, { edge: toStep(e), via: e.src_id });
        if (backwardVisited.has(e.dst_id)) {
          meetingId = e.dst_id;
          break;
        }
        next.push(e.dst_id);
      }
      forwardFrontier = next;
    } else {
      const edges = await fetchFrontierEdges(dataSource, input.graphId, confidenceMin, edgeTypes, 'dst_id', backwardFrontier);
      const next: string[] = [];
      for (const e of edges) {
        if (backwardVisited.has(e.src_id)) continue;
        backwardVisited.set(e.src_id, { edge: toStep(e), via: e.dst_id });
        if (forwardVisited.has(e.src_id)) {
          meetingId = e.src_id;
          break;
        }
        next.push(e.src_id);
      }
      backwardFrontier = next;
    }
    forwardTurn = !forwardTurn;

    if (!meetingId && forwardVisited.size + backwardVisited.size > MAX_CALL_PATH_VISITED) {
      truncated = true;
      break;
    }
    await yieldToEventLoop();
  }

  const nodesVisited = forwardVisited.size + backwardVisited.size;
  if (!meetingId) {
    return { found: false, path: [], pathConfidence: null, hops: 0, nodesVisited, truncated, durationMs: Date.now() - startedAt };
  }

  const forwardHalf: GraphCallPathStep[] = [];
  for (let cur = meetingId; ; ) {
    const rec = forwardVisited.get(cur);
    if (!rec) break; // fromId 자신(루트 마커)에 도달
    forwardHalf.unshift(rec.edge);
    cur = rec.via;
  }
  const backwardHalf: GraphCallPathStep[] = [];
  for (let cur = meetingId; ; ) {
    const rec = backwardVisited.get(cur);
    if (!rec) break; // toId 자신(루트 마커)에 도달
    backwardHalf.push(rec.edge);
    cur = rec.via;
  }
  const path = [...forwardHalf, ...backwardHalf];
  const pathConfidence = path.reduce((min, step) => Math.min(min, step.confidence), 1);

  return { found: true, path, pathConfidence, hops: path.length, nodesVisited, truncated: false, durationMs: Date.now() - startedAt };
}
