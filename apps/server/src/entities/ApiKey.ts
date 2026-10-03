import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  name: string;

  // SHA-256 hash (hex) of the raw key — NOT the raw key. The plaintext is
  // returned exactly once at creation and never persisted (security finding:
  // secrets). Lookups hash the presented key and match against this column.
  // Column name kept as `key` so the unique index / existing schema is reused
  // and no NOT-NULL drop is required on Postgres.
  @Column({ type: 'varchar', unique: true })
  key: string;

  // Masked hint for display (e.g. "awb_1234***cdef"). The only key material an
  // operator can see after creation — the raw key is unrecoverable.
  @Column({ type: 'varchar', nullable: true, default: null })
  key_prefix: string | null;

  // P4c-4: retired audit column (Agent 테이블 없음 — 신규 키는 항상 NULL).
  // 실FK 없음. 이력 조회용으로만 남긴다.
  @Column({ type: 'varchar', nullable: true, default: null })
  agent_id: string | null;

  // Host 바인딩 지속 키 (P0, A안). pairing redeem이 manager Agent 행과 함께
  // RuntimeHost 행을 만들고 이 컬럼에 그 id를 stamped한다. 평문 varchar로
  // 두어 실FK를 늘리지 않는다 — 마이그레이션 FK 11개 불변.
  // P4에서 agent_id가 제거되면 이쪽이 유일한 바인딩이 된다.
  @Column({ type: 'varchar', nullable: true, default: null })
  host_id: string | null;

  @Column({ type: 'varchar', default: 'full' })
  scope: string;

  @Column({ type: 'int', default: 1 })
  is_active: number;

  @Column({ type: Date, nullable: true, default: null })
  expires_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_used_at: Date | null;

  @Column({ type: 'int', default: 0 })
  use_count: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
