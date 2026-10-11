import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('credentials')
export class Credential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Nullable: a NULL account_id marks a GLOBAL (instance-level) credential
  // shared across every account. Non-NULL pins the credential to one
  // account (the original behaviour). Mirrors the Agent.account_id
  // nullable pattern used for manager rows (migrations 018/019).
  @Column({ type: 'varchar', nullable: true, default: null })
  account_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar' })
  provider: string;

  @Column({ type: 'text' })
  encrypted_data: string;

  // Opt-in: hand every stored field to agent runs of the readable account(s)
  // as `<env_prefix>_<FIELD>` env vars. Non-CLI providers only — see
  // common/credential-agent-env.ts.
  @Column({ type: 'boolean', default: false })
  agent_env: boolean;

  @Column({ type: 'varchar', default: '' })
  env_prefix: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
