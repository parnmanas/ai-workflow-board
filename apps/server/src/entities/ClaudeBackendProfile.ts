import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Instance-global Claude endpoint definition. Secrets remain in Credential. */
@Entity('claude_backend_profiles')
export class ClaudeBackendProfile {
  @PrimaryColumn({ type: 'varchar' })
  id: string;

  @Column({ type: 'varchar', unique: true })
  name: string;

  @Column({ type: 'varchar' })
  protocol: string;

  @Column({ type: 'text' })
  base_url: string;

  @Column({ type: 'varchar' })
  model: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  credential_ref: string | null;

  /** Validated non-secret runtime fields (env/args/adapter/etc.). */
  @Column({ type: 'text', default: '{}' })
  config: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
