// Phase C(ticket 964014f5, DESIGN.md 축 4 Decision — "evidence hash
// 무효화, lazy — LLM 호출 없음"). semantic/derived 레이어 엣지의
// evidence_ref([{path, start, end, content_hash}], OntologyEdge.ts 문서)가
// 인용한 File 노드들의 **현재** content_hash와 대조해 하나라도 어긋나면
// status='stale'로 뒤집는다. 여기서 절대 LLM을 호출하지 않는다 — 실제
// 재요약(Tier 3)은 ticket #9(LLM enrichment, DESIGN.md 10a §2, 미배정)의
// 몫이고, 이 함수는 "재요약이 필요하다"는 신호만 enrichment_queue에
// 얹는다(incremental/sweep.service.ts가 소비).
//
// 현재 코드베이스엔 semantic/derived 레이어 엣지를 만드는 경로가 아직
// 없다(Tier 1/1.5만 구현됨, 전부 layer='structural') — 그래서 실제 운영
// 데이터에서 이 함수는 매번 candidates=0으로 사실상 휴면이다. "미구현"이
// 아니라 "대상이 아직 없음"을 정직하게 구분하기 위해 스캔 자체는 항상
// 돌리고 결과를 그대로 반환한다(REVIEW-NOTES.md S5의 "정직하게 노출"
// 원칙과 같은 자세) — Tier 3가 나중에 semantic 엣지를 쌓기 시작하면 이
// 함수는 코드 변경 없이 즉시 유효해진다.
//
// 리뷰 지적(2라운드, 잔존 차단) — candidate 자체를 edgeRepo.find()로
// 한 번에 전부 메모리에 올리면, allPaths/srcIds 후속 조회를 청크로
// 나눠도 "그래프 전체 candidates 적재" 문제가 남는다(엣지 객체 +
// evidence_ref JSON을 그래프 크기만큼 동시 보유). keyset pagination
// (`id > lastId ORDER BY id LIMIT pageSize`)으로 페이지 단위로 순회하고,
// 각 페이지 안에서만 evidence path/src pagerank 조회 + stale 갱신 +
// queue upsert를 끝낸 뒤 페이지 상태(evidenceByEdgeId/currentHashByPath/
// pagerankBySrcId)를 버려 다음 페이지로 넘어간다 — 어떤 시점에도 한
// 페이지분(최대 pageSize개)의 candidate만 메모리에 있다. offset
// pagination(스킵 개수 기반)은 페이지 처리 중 active->stale 전환으로
// WHERE status='active' 조건에 걸리는 행 수 자체가 줄어 다음 페이지의
// OFFSET이 밀려 행을 건너뛸 수 있어 피한다 — id 기반 keyset은 "이미 본
// id보다 큰 것"만 보므로 그 문제가 없다.
import { In, MoreThan, type DataSource } from 'typeorm';
import { OntologyEdge } from '../../../entities/OntologyEdge';
import { OntologyNode } from '../../../entities/OntologyNode';
import { OntologyEnrichmentQueue } from '../../../entities/OntologyEnrichmentQueue';
import { yieldToEventLoop } from '../persist';

// persist.ts의 NODE_CHUNK_SIZE/EDGE_CHUNK_SIZE 선례와 동일한 값 — 리뷰
// 지적: allPaths/srcIds/candidate 자체는 그래프의 semantic/derived 엣지
// 수에 비례해 커질 수 있어, 단일 IN(...)이나 무제한 적재로 몰면 바인드
// 변수 한도/메모리 상한을 넘을 수 있다.
const ID_CHUNK_SIZE = 500;
const DEFAULT_PAGE_SIZE = 500;

interface EvidenceRefEntry {
  path: string;
  start?: number;
  end?: number;
  content_hash: string;
}

export interface PhaseCResult {
  edgesScanned: number;
  edgesFlippedStale: number;
  enrichmentQueueUpserts: number;
}

export interface PhaseCOptions {
  /** keyset pagination 페이지 크기 — 테스트가 작은 값을 주입해 실제
   *  다중 페이지 순회와 페이지 경계 누락 없음을 증명한다. 기본값은
   *  ID_CHUNK_SIZE와 동일한 500. */
  pageSize?: number;
}

function parseEvidenceRef(raw: string): EvidenceRefEntry[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 페이지 하나(최대 pageSize개의 candidate 엣지)에 대해 evidence path
 *  조회 -> stale 판정 -> pagerank 조회 -> update/upsert까지 전부 끝내고
 *  반환한다. 이 함수를 벗어나면 이 페이지의 중간 상태(evidenceByEdgeId/
 *  currentHashByPath/pagerankBySrcId)는 전부 GC 대상이다 — 다음 페이지로
 *  넘어가도 누적되지 않는다. */
async function processPage(
  edgeRepo: ReturnType<DataSource['getRepository']>,
  nodeRepo: ReturnType<DataSource['getRepository']>,
  queueRepo: ReturnType<DataSource['getRepository']>,
  graphId: string,
  page: OntologyEdge[],
  stamp: Date,
): Promise<number> {
  const evidenceByEdgeId = new Map<string, EvidenceRefEntry[]>();
  const pagePaths = new Set<string>();
  for (const e of page) {
    const refs = parseEvidenceRef(e.evidence_ref);
    evidenceByEdgeId.set(e.id, refs);
    for (const ref of refs) if (ref?.path) pagePaths.add(ref.path);
  }

  const currentHashByPath = new Map<string, string>();
  const pagePathsArr = [...pagePaths];
  for (let i = 0; i < pagePathsArr.length; i += ID_CHUNK_SIZE) {
    const chunk = pagePathsArr.slice(i, i + ID_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const fileNodes = await nodeRepo.find({
      where: { graph_id: graphId, type: 'File', path: In(chunk), status: 'active' },
      select: ['path', 'content_hash'],
    });
    for (const f of fileNodes) currentHashByPath.set(f.path, f.content_hash);
    await yieldToEventLoop();
  }

  // 캡 대상 src 노드의 pagerank(centrality) — 대기열 우선순위 산정.
  // open-folder/active-ticket-folder tier는 실시간 UI/세션 컨텍스트가
  // 필요해 이 순수 배치 함수 범위 밖(OntologyEnrichmentQueue.ts 문서
  // 참고) — 여기선 centrality tier만 구현한다.
  const pageSrcIds = [...new Set(page.map((e) => e.src_id))];
  const pagerankBySrcId = new Map<string, number>();
  for (let i = 0; i < pageSrcIds.length; i += ID_CHUNK_SIZE) {
    const chunk = pageSrcIds.slice(i, i + ID_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const srcNodes = await nodeRepo.find({ where: { graph_id: graphId, id: In(chunk) }, select: ['id', 'pagerank'] });
    for (const n of srcNodes) pagerankBySrcId.set(n.id, n.pagerank);
    await yieldToEventLoop();
  }

  let flipped = 0;
  for (const e of page) {
    const refs = evidenceByEdgeId.get(e.id) ?? [];
    // evidence_ref가 비어 있는 엣지는 판단 근거가 없으므로 건드리지
    // 않는다(무근거 stale 오탐보다 무판정이 안전 — false positive는
    // agent가 실제로 신선한 정보를 재요약 대기열로 잘못 보내 낭비를
    // 만들고, 무판정은 그냥 다음 스캔을 기다린다).
    if (refs.length === 0) continue;
    const mismatched = refs.some((ref) => currentHashByPath.get(ref.path) !== ref.content_hash);
    if (!mismatched) continue;

    await edgeRepo.update({ id: e.id }, { status: 'stale' });
    flipped += 1;
    // priority: pagerank가 높을수록(더 중심적인 심볼) 더 먼저 드레인되도록
    // 음수로 반전 — OntologyEnrichmentQueue.priority 문서("낮을수록 먼저")
    // 그대로.
    const priority = -(pagerankBySrcId.get(e.src_id) ?? 0);
    await queueRepo.upsert(
      { graph_id: graphId, node_id: e.src_id, priority, staled_at: stamp, cooldown_until: null },
      ['graph_id', 'node_id'],
    );
  }
  return flipped;
}

/** graph_id 하나의 semantic/derived 활성 엣지를 keyset pagination으로
 *  페이지 단위로 순회하며 evidence_ref content_hash 불일치를 stale로
 *  뒤집는다. 어떤 시점에도 최대 pageSize개의 candidate만 메모리에
 *  있다(리뷰 지적, 잔존 차단 해소). */
export async function runPhaseC(dataSource: DataSource, graphId: string, opts: PhaseCOptions = {}): Promise<PhaseCResult> {
  const edgeRepo = dataSource.getRepository(OntologyEdge);
  const nodeRepo = dataSource.getRepository(OntologyNode);
  const queueRepo = dataSource.getRepository(OntologyEnrichmentQueue);
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;

  let edgesScanned = 0;
  let flipped = 0;
  let lastId: string | null = null;
  const stamp = new Date();

  for (;;) {
    // id 기반 keyset pagination — "이미 본 id보다 큰 것만" 조건이라
    // 이번 페이지 처리 중 status가 active->stale로 바뀌어도(WHERE
    // status='active' 조건에서 그 행이 빠져나가도) 다음 페이지 커서
    // (lastId)는 절대 값이라 밀리지 않는다. offset 기반이었다면 이번
    // 페이지에서 stale로 뒤집힌 행 수만큼 다음 OFFSET이 어긋나 아직
    // 안 본 행을 건너뛸 수 있다(리뷰 지적).
    const page = await edgeRepo.find({
      where: lastId
        ? { graph_id: graphId, layer: In(['semantic', 'derived']), status: 'active', id: MoreThan(lastId) }
        : { graph_id: graphId, layer: In(['semantic', 'derived']), status: 'active' },
      order: { id: 'ASC' },
      take: pageSize,
    });
    if (page.length === 0) break;

    lastId = page[page.length - 1].id;
    edgesScanned += page.length;
    flipped += await processPage(edgeRepo, nodeRepo, queueRepo, graphId, page, stamp);

    // 페이지 사이 명시적 매크로태스크 양보 — persist.ts/resolve.ts와
    // 동일한 계약.
    await yieldToEventLoop();
  }

  return { edgesScanned, edgesFlippedStale: flipped, enrichmentQueueUpserts: flipped };
}
