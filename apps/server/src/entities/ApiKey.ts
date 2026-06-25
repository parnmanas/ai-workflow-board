import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Agent } from './Agent';

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

  @Column({ type: 'varchar', nullable: true, default: null })
  agent_id: string | null;

  @ManyToOne(() => Agent, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'agent_id' })
  agent: Agent | null;

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
