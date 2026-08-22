import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

// Tier-3 LLM 재보강 대기열(ticket 964014f5, DESIGN.md 축 4 —
// research-incremental.md §5 "a small enrichment_queue(node_id, priority,
// staled_at, cooldown_until) table backing §5's scheduler"). Phase C
// (incremental/phase-c.ts)가 semantic/derived 엣지를 evidence-hash 불일치로
// stale 처리할 때, 그 엣지의 src 노드를 "재보강이 필요할 수 있는 대상"으로
// upsert한다. 실제로 LLM을 호출해 드레인하는 것은 ticket #9(LLM enrichment,
// 아직 미배정 — DESIGN.md 10a §2)의 몫이라, 이 테이블은 이 티켓 시점엔
// incremental/sweep.service.ts의 텔레메트리 원자료(크기/age 퍼센타일,
// 완료조건 3)로만 소비된다 — cooldown_until 갱신 자체는 실제 배선.
//
// 원본 컬럼 목록은 research-incremental.md의 (node_id, priority, staled_at,
// cooldown_until) 그대로이되, graph_id를 추가했다 — 워크스페이스/그래프별
// 텔레메트리 집계(REVIEW-NOTES.md S5: "log stale-queue size/age percentiles
// per workspace over time")를 위해 graph_id 없이는 여러 그래프의 대기열이
// 섞여 집계될 수밖에 없다.
//
// STORAGE: OntologyNode/Edge와 같은 자세 — sql.js에서는
// buildOntologyDataSourceOptions()의 독립 DataSource, Postgres에서는 기존
// 단일 DataSource(db.ts 참고).
@Index(['graph_id', 'staled_at'])
@Index(['graph_id', 'node_id'], { unique: true })
@Entity('ontology_enrichment_queue')
export class OntologyEnrichmentQueue {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  graph_id: string;

  // OntologyNode.id(내부 uuid) — 재보강 대상 노드. 그래프당 노드 하나엔
  // 대기열 행도 하나만(위 unique index) — 같은 노드가 여러 번 stale이
  // 돼도 staled_at/priority만 최신값으로 upsert된다(중복 대기열 행 방지).
  @Column({ type: 'varchar' })
  node_id: string;

  // 우선순위 점수 — 낮을수록 먼저 드레인(research-ontology.md §4.2/§9:
  // open folder > active-ticket folder > top-N centrality). 이 티켓
  // 시점에는 centrality(OntologyNode.pagerank 기반, 높을수록 우선순위
  // 숫자가 작아지도록 역변환)만 구현하고, open-folder/active-ticket-folder
  // tier는 실시간 UI/세션 컨텍스트가 필요해 이 백그라운드 서비스 범위
  // 밖이라 명시적으로 향후 확장 지점으로 남긴다(incremental/phase-c.ts
  // 코멘트 참고) — S5와 같은 "정직하게 노출" 원칙.
  @Column({ type: 'float', default: 0 })
  priority: number;

  @Column({ type: Date })
  staled_at: Date;

  // 스윕이 이 행을 마지막으로 "드레인"(텔레메트리 집계 + 북키핑, 이
  // 티켓 시점엔 실제 LLM 호출 없음)한 뒤 재고려 가능한 시각. null = 아직
  // 한 번도 드레인 안 됨. Sourcegraph 오토인덱서의 per-repo cooldown과
  // 같은 자세(research-incremental.md §5.2) — 같은 노드가 계속 stale을
  // 반복해도 짧은 시간 안에 두 번 재고려하지 않는다.
  @Column({ type: Date, nullable: true, default: null })
  cooldown_until: Date | null;

  @CreateDateColumn()
  created_at: Date;
}
