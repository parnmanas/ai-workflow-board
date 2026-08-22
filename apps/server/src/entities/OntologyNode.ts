import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

// docs/ontology-graph/DESIGN.md 축 2 + 이 결정의 근거인 research-ontology.md
// §8.5 property-set이 고정한 닫힌 어휘. `type`/`kind`는 의도적으로 union으로
// 두지 않았다 — 축 2의 워크스페이스 확장성 모델(core@X.Y.Z + 추가적인
// workspace_profile@N)상 실제 type taxonomy는 고정 enum이 아니라 열린,
// 워크스페이스별 설정 가능한 레지스트리이기 때문.
//
// OntologyEdge와 공유(그쪽에서 재export, 재정의 아님) — 두 테이블 모두 같은
// layer/status/confidence-method 어휘를 쓴다.
export type OntologyLayer = 'structural' | 'derived' | 'semantic' | 'curated';
export type OntologyStatus = 'active' | 'stale' | 'removed' | 'quarantined';
export type OntologyConfidenceMethod = 'constant' | 'agreement' | 'support' | 'calibrated' | 'human';

// ticket 964014f5(Ontology Graph 4/7), DESIGN.md 축 4 — durability tier.
// `volatile`(워크스페이스 소스) / `stable`(lockfile-pinned deps, 아직 이
// 코드베이스엔 ExternalPackage 추출기가 없어 실제로는 채워지지 않음 —
// 미래 티켓을 위해 어휘만 열어둠) / `frozen`(vendored/generated 경로,
// extraction/durability.ts의 휴리스틱으로 판정). File 노드가 최초로 갖고,
// 같은 파일의 def 노드들은 그 파일의 값을 그대로 상속한다(persist.ts).
// Phase B의 reverse-index pre-filter(incremental/reverse-lookup.ts)가 이
// 컬럼으로 "volatile 파일만 건드린 커밋은 stable/frozen 파티션을 아예
// 건드리지 않는다"를 구현한다(research-incremental.md §4.3).
export type OntologyDurability = 'volatile' | 'stable' | 'frozen';

// Ontology Graph 노드 테이블(ticket 6ca4894a, DESIGN.md 축 2/3). 구조적/파생/
// semantic 그래프 엔티티(파일, callable, community, concept 등) 1개당 1행.
// 전체 property set + index 형태는 research-ontology.md §8.5를 그대로
// 따른다. `resource_id`/`folder_path` 스코핑은 Ticket.base_repo_resource_id의
// 선례(scout-server.md §1)를 따름 — plain 컬럼, DB 레벨 FK 없음, 애플리케이션
// 코드에서 해석.
//
// `graph_id`는 각 행을 (workspace_id, resource_id, folder_path) 그래프에
// 스코프하지만 아직 OntologyGraph 테이블은 없다 — 그 lifecycle 엔티티는
// ticket #6의 범위(graph_status가 자동 프로비저닝)라, graph_id도 다른 모든
// 컬럼과 같은 "관례상 FK" 자세를 취하는 bare 컬럼이다.
//
// STORAGE: sql.js(dev) 백엔드에서는 이 엔티티가 독립적으로 flush되는 두 번째
// `buildOntologyDataSourceOptions()` DataSource로 들어가고, 절대 primary
// data.db로 가지 않는다 — db.ts 참고. Postgres에서는 기존 단일 DataSource에
// 그대로 들어간다(변경 없음). TypeORM `synchronize`가 자동 DDL(D-01, db.ts:
// 395-474가 전 분기에 하드코딩) — 이 배럴의 다른 모든 테이블과 같은 관례로
// 손으로 쓴 마이그레이션 불필요.
@Index(['graph_id', 'symbol_id'], { unique: true })
@Index(['graph_id', 'path'])
@Index(['graph_id', 'type', 'layer'])
// ticket d35b7b7d(Ontology Graph 6/7) — graph_find_symbol의 exact-name 조회용.
@Index(['graph_id', 'name'])
@Entity('ontology_nodes')
export class OntologyNode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // 이 노드가 추출된 repo resource — Ticket.base_repo_resource_id의 "plain
  // varchar, FK 없음" 선례(scout-server.md §1)를 따름.
  @Column({ type: 'varchar', default: '' })
  resource_id: string;

  @Column({ type: 'varchar', default: '' })
  folder_path: string;

  @Column({ type: 'varchar' })
  graph_id: string;

  // 안정적이고 content-addressed된, SCIP 형태의 identity — 모든 증분 업데이트
  // 메커니즘(ticket #3/#4)이 전제로 삼는 조건. 그래프 단위로만 유니크하고
  // 전역 유니크는 아님(위 composite index 참고, 컬럼 레벨 unique 아님).
  @Column({ type: 'varchar' })
  symbol_id: string;

  @Column({ type: 'varchar' })
  type: string;

  @Column({ type: 'varchar', default: '' })
  kind: string;

  @Column({ type: 'varchar' })
  layer: OntologyLayer;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  qualified_name: string;

  @Column({ type: 'varchar', default: '' })
  path: string;

  @Column({ type: 'int', nullable: true, default: null })
  start_line: number | null;

  @Column({ type: 'int', nullable: true, default: null })
  end_line: number | null;

  @Column({ type: 'varchar', default: '' })
  content_hash: string;

  // ticket 964014f5, DESIGN.md 축 4 — content_hash와 분리된 "선언부만"의
  // 해시(이름/kind/arity/visibility/파라미터·반환타입/heritage, body 제외).
  // Callable/Type/Field 노드에만 의미가 있다(File은 항상 ''). body-only
  // 편집은 content_hash만 바뀌고 signature_hash는 그대로라 Phase A가 다른
  // 파일을 건드리지 않고 조기 종료할 수 있다 — extraction/hash-bundle.ts가
  // 실제 값을 계산.
  @Column({ type: 'varchar', default: '' })
  signature_hash: string;

  @Column({ type: 'varchar', default: 'volatile' })
  durability: OntologyDurability;

  @Column({ type: 'varchar', default: '' })
  lang: string;

  @Column({ type: 'varchar', default: 'active' })
  status: OntologyStatus;

  // 이 행을 쓴 추출기/리졸버가 항상 명시적으로 계산해서 넣는다 — DB
  // 기본값을 절대 쓰지 않음(DESIGN.md 축 2: confidence_method='agreement'는
  // 서비스 레이어 불변식이지 자가보고/가정값이 아님).
  @Column({ type: 'float' })
  confidence: number;

  @Column({ type: 'varchar', default: 'constant' })
  confidence_method: OntologyConfidenceMethod;

  // 바이템포럴 버저닝(커밋 공간 기준, wall-clock 아님) — soft-delete만 지원.
  @Column({ type: 'varchar', default: '' })
  first_seen_commit: string;

  @Column({ type: 'varchar', default: '' })
  last_seen_commit: string;

  @Column({ type: 'varchar', default: '' })
  valid_from_commit: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  valid_to_commit: string | null;

  @Column({ type: 'varchar', default: '' })
  extraction_run_id: string;

  @Column({ type: 'varchar', default: '' })
  profile_version: string;

  // 별도 컬럼을 둘 정도는 아닌 타입별 속성(예: Type.is_abstract,
  // Callable.arity)을 담는 자유형식 JSON 자루 — Resource.content와 같은
  // 자세: text 컬럼, 앱 코드가 형태를 소유.
  @Column({ type: 'text', default: '{}' })
  props: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  embedding_id: string | null;

  // 캐시된 그래프 알고리즘 산출값 — centrality pass가 돌기 전까지는 0.
  @Column({ type: 'int', default: 0 })
  degree: number;

  @Column({ type: 'float', default: 0 })
  pagerank: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
