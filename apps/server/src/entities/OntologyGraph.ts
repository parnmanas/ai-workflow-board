import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

// Ontology Graph lifecycle 레지스트리(ticket d35b7b7d, DESIGN.md 축 6 "Graph
// lifecycle & discovery"). OntologyNode/Edge의 `graph_id`는 이 테이블이 없던
// 동안 관례상 FK로만 존재했다(OntologyNode.ts 코멘트 참고) — 이 엔티티가 그
// 참조의 실제 대상이다. (account_id, resource_id, folder_path) 하나당
// 행 하나만 존재(unique index) — graph_status가 이 유니크 제약으로 최초
// 프로비저닝을 원자적으로 선점한다(board lesson: 외부 입력 idempotency는
// 부수효과 전에 DB로 선점).
export type OntologyGraphStatus = 'building' | 'ready' | 'stale' | 'error';

// STORAGE: OntologyNode/Edge와 같은 자세 — sql.js에서는
// buildOntologyDataSourceOptions()의 독립 DataSource, Postgres에서는 기존
// 단일 DataSource(db.ts 참고).
@Index(['account_id', 'resource_id', 'folder_path'], { unique: true })
@Entity('ontology_graphs')
export class OntologyGraph {
  // 이 행의 id가 곧 OntologyNode/Edge.graph_id 값이다.
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  resource_id: string;

  // 빈 문자열 = 저장소 루트.
  @Column({ type: 'varchar', default: '' })
  folder_path: string;

  @Column({ type: 'varchar', default: 'building' })
  status: OntologyGraphStatus;

  // 마지막으로 성공적으로 빌드/갱신된 시각 — 최초 빌드가 끝나기 전엔 null.
  // 보드 레슨: dialect 중립 `type: Date`로 선언(문자열 'datetime' 금지).
  @Column({ type: Date, nullable: true, default: null })
  indexed_at: Date | null;

  // indexed_at 시점의 커밋 sha — 최초 빌드 전엔 빈 문자열.
  @Column({ type: 'varchar', default: '' })
  commit: string;

  // 빌드 진행 상황 스냅샷(JSON 자루, OntologyNode.props와 같은 자세) —
  // graph_status 응답의 progress 필드가 이걸 파싱해 반환한다.
  @Column({ type: 'text', default: '{}' })
  progress: string;

  // status='error'일 때의 마지막 에러 메시지. 그 외에는 빈 문자열.
  @Column({ type: 'varchar', default: '' })
  error: string;

  // 지금 이 그래프를 빌드하는 실행의 토큰(ticket 461d210a). 빌드를 시작할 때(claim)
  // 새로 만들고, 빌드를 끝내는 쓰기(ready · error)와 lease 연장은 이 값이 그대로일
  // 때만 한다 — lease 가 지나 다른 빌드가 다시 claim 하면 값이 바뀌므로, 주인을 잃은
  // 빌드가 새 빌드의 결과나 상태를 덮지 못한다. building 이 아닐 때는 빈 문자열.
  @Column({ type: 'varchar', default: '' })
  build_id: string;

  // building 의 주인(빌드를 돌리는 서버)이 살아 있다고 볼 시각의 끝. 빌드가 도는 동안
  // heartbeat 가 계속 미루고, 지나면 그 building 은 끊긴 빌드다 — 읽기가 error 로
  // 돌리고 Refresh 가 다시 claim 한다(ontology-lifecycle.service.ts). building 이
  // 아닐 때, 그리고 이 컬럼이 생기기 전에 남은 building 행은 null 이다.
  @Column({ type: Date, nullable: true, default: null })
  build_lease_until: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
