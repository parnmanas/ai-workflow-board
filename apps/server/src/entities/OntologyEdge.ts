import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, Check } from 'typeorm';
import { OntologyLayer, OntologyStatus, OntologyConfidenceMethod } from './OntologyNode';

export type { OntologyLayer, OntologyStatus, OntologyConfidenceMethod };

// DESIGN.md 축 2가 고정한 엣지 전용 닫힌 어휘. `type`(CONTAINS, CALLS,
// DECORATES, AFFECTS_CODE, ...)은 의도적으로 union이 아니다 — OntologyNode.
// type/kind와 같은 열린/워크스페이스 확장 가능한 taxonomy 논리.
//
// DESIGN.md 축 2에 고정됨(리뷰 지적, integrity/major) — 이름 해석
// 신뢰도(name-resolution confidence)와 런타임 디스패치 신뢰도는 별개 축.
// 구조적 CALLS 엣지에만 해당, 다른 모든 엣지 타입에서는 null/미사용. 위
// type/kind/layer와 달리 이 어휘는 진짜 닫혀 있어서(워크스페이스 확장
// 불가) — 리뷰 지적, 6ca4894a Review round 1 — TypeScript union만이 아니라
// 실제 DB 레벨 CHECK 제약(아래)으로 강제한다. TypeORM `simple-enum` 컬럼
// 타입을 검토했으나 기각했다 — sqlite/sql.js 드라이버에서는 그냥 순수
// `varchar`로 내려가고 검증이 전혀 없다(typeorm@0.3.31의
// DateUtils.simpleEnumToString이 단순 문자열화만 함을 직접 확인) — Postgres
// (simple-enum이 네이티브 enum 타입으로 매핑되는 곳)에서만 실제로 강제되고
// sql.js 백엔드는 조용히 무방비로 남는다. 반면 `@Check()` 제약은 SQLite
// (sql.js)와 Postgres 둘 다 네이티브로 synchronize하는 이식성 있는 SQL
// 기능이다.
export const ONTOLOGY_EDGE_RESOLUTION_VALUES = ['exact', 'name_match', 'dynamic', 'unresolved'] as const;
export type OntologyEdgeResolution = typeof ONTOLOGY_EDGE_RESOLUTION_VALUES[number];
export type OntologyEvidenceKind =
  | 'parser' | 'indexer' | 'git' | 'heuristic' | 'cooccurrence' | 'embedding' | 'llm' | 'human';
export type OntologyEdgeRank = 'preferred' | 'normal' | 'deprecated';
// SPDX 유래 어휘(research-ontology.md §8.5/§8.6) — "결과 0건"과 "결과 0건,
// 커버리지가 알려진 불완전 상태"를 구분한다.
export type OntologyCompleteness = 'complete' | 'incomplete' | 'no_assertion';

// Ontology Graph 엣지 테이블(ticket 6ca4894a, DESIGN.md 축 2/3).
// RelationTuple의 subject/object 튜플 형태(research-ontology.md §8.5,
// scout-server.md §2)를 거울처럼 따르지만, 양 끝은 항상 같은 그래프 안의
// OntologyNode 행이고 `src_id`/`dst_id`로 주소한다 — OntologyNode.id,
// plain varchar, DB 레벨 FK 없음, 이 코드베이스의 모든 크로스엔티티
// 참조(RelationTuple, Ticket.base_repo_resource_id, ...)와 같은 관례.
//
// STORAGE: sql.js(dev) → 독립적으로 flush되는 두 번째
// `buildOntologyDataSourceOptions()` DataSource, 절대 primary data.db 아님.
// Postgres(prod) → 기존 단일 DataSource 그대로(변경 없음). db.ts 참고.
@Index(['graph_id', 'src_id', 'type'])
@Index(['graph_id', 'dst_id', 'type'])
@Index(['graph_id', 'type', 'layer'])
@Index(['graph_id', 'status', 'layer'])
@Check(`"resolution" IN (${ONTOLOGY_EDGE_RESOLUTION_VALUES.map((v) => `'${v}'`).join(', ')}) OR "resolution" IS NULL`)
@Entity('ontology_edges')
export class OntologyEdge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  graph_id: string;

  @Column({ type: 'varchar' })
  src_id: string;

  @Column({ type: 'varchar' })
  dst_id: string;

  @Column({ type: 'varchar' })
  type: string;

  @Column({ type: 'varchar' })
  layer: OntologyLayer;

  @Column({ type: 'float' })
  confidence: number;

  @Column({ type: 'varchar', default: 'constant' })
  confidence_method: OntologyConfidenceMethod;

  // 공동 변경/agreement support count(예: CO_CHANGED_WITH의 lift/Jaccard
  // 표본 크기) — 모든 엣지 타입이 채우는 건 아님.
  @Column({ type: 'int', nullable: true, default: null })
  support: number | null;

  // 구조적 CALLS 전용(DESIGN.md 축 2의 resolution='dynamic' cap 메커니즘).
  // 다른 모든 엣지 타입에서는 null/미사용. 컬럼 자체는 'varchar'로 둔다
  // ('enum'/'simple-enum' 아님) — 실제로 양 백엔드에서 값을 강제하는 건 위
  // @Check() 제약이다. simple-enum이 왜 안 되는지는 그 데코레이터 코멘트
  // 참고.
  @Column({ type: 'varchar', nullable: true, default: null })
  resolution: OntologyEdgeResolution | null;

  // CALLS 전용 카운터, resolution과 같은 "구조적 전용" 자세.
  @Column({ type: 'int', nullable: true, default: null })
  call_count: number | null;

  @Column({ type: 'varchar', default: '' })
  evidence_kind: OntologyEvidenceKind | '';

  // JSON [{path, start, end, content_hash}] — layer='semantic'일 때
  // 필수(앱에서 강제, DB 제약 아님).
  @Column({ type: 'text', default: '[]' })
  evidence_ref: string;

  @Column({ type: 'varchar', default: 'normal' })
  rank: OntologyEdgeRank;

  @Column({ type: 'varchar', default: 'no_assertion' })
  completeness: OntologyCompleteness;

  @Column({ type: 'varchar', default: '' })
  extraction_run_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  model_id: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  prompt_version: string | null;

  // 바이템포럴 버저닝(커밋 공간 기준, wall-clock 아님) — soft-delete만
  // 지원, OntologyNode와 같은 자세.
  @Column({ type: 'varchar', default: '' })
  first_seen_commit: string;

  @Column({ type: 'varchar', default: '' })
  last_seen_commit: string;

  @Column({ type: 'varchar', default: '' })
  valid_from_commit: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  valid_to_commit: string | null;

  @Column({ type: 'varchar', default: 'active' })
  status: OntologyStatus;

  @Column({ type: 'text', default: '{}' })
  props: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
