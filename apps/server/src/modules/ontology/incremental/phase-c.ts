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
import { In, type DataSource } from 'typeorm';
import { OntologyEdge } from '../../../entities/OntologyEdge';
import { OntologyNode } from '../../../entities/OntologyNode';
import { OntologyEnrichmentQueue } from '../../../entities/OntologyEnrichmentQueue';

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

function parseEvidenceRef(raw: string): EvidenceRefEntry[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** graph_id 하나의 semantic/derived 활성 엣지를 스캔해 evidence_ref
 *  content_hash 불일치를 stale로 뒤집는다. evidence_ref가 비어 있는
 *  엣지는 판단 근거가 없으므로 건드리지 않는다(무근거 stale 오탐보다
 *  무판정이 안전 — false positive는 agent가 실제로 신선한 정보를
 *  재요약 대기열로 잘못 보내 낭비를 만들고, 무판정은 그냥 다음 스캔을
 *  기다린다). */
export async function runPhaseC(dataSource: DataSource, graphId: string): Promise<PhaseCResult> {
  const edgeRepo = dataSource.getRepository(OntologyEdge);
  const nodeRepo = dataSource.getRepository(OntologyNode);
  const queueRepo = dataSource.getRepository(OntologyEnrichmentQueue);

  const candidates = await edgeRepo.find({ where: { graph_id: graphId, layer: In(['semantic', 'derived']), status: 'active' } });
  if (candidates.length === 0) return { edgesScanned: 0, edgesFlippedStale: 0, enrichmentQueueUpserts: 0 };

  const evidenceByEdgeId = new Map<string, EvidenceRefEntry[]>();
  const allPaths = new Set<string>();
  for (const e of candidates) {
    const refs = parseEvidenceRef(e.evidence_ref);
    evidenceByEdgeId.set(e.id, refs);
    for (const ref of refs) if (ref?.path) allPaths.add(ref.path);
  }

  const currentHashByPath = new Map<string, string>();
  if (allPaths.size > 0) {
    const fileNodes = await nodeRepo.find({
      where: { graph_id: graphId, type: 'File', path: In([...allPaths]), status: 'active' },
      select: ['path', 'content_hash'],
    });
    for (const f of fileNodes) currentHashByPath.set(f.path, f.content_hash);
  }

  // 캡 대상 src 노드의 pagerank(centrality) — 대기열 우선순위 산정.
  // open-folder/active-ticket-folder tier는 실시간 UI/세션 컨텍스트가
  // 필요해 이 순수 배치 함수 범위 밖(OntologyEnrichmentQueue.ts 문서
  // 참고) — 여기선 centrality tier만 구현한다.
  const srcIds = [...new Set(candidates.map((e) => e.src_id))];
  const pagerankBySrcId = new Map<string, number>();
  if (srcIds.length > 0) {
    const srcNodes = await nodeRepo.find({ where: { graph_id: graphId, id: In(srcIds) }, select: ['id', 'pagerank'] });
    for (const n of srcNodes) pagerankBySrcId.set(n.id, n.pagerank);
  }

  let flipped = 0;
  const stamp = new Date();
  for (const e of candidates) {
    const refs = evidenceByEdgeId.get(e.id) ?? [];
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

  return { edgesScanned: candidates.length, edgesFlippedStale: flipped, enrichmentQueueUpserts: flipped };
}
