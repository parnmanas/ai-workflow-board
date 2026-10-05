import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/** Execution settings only; the CLI host remains the source of transcripts. */
@Entity('agent_session_executions')
@Index('uq_agent_session_execution', ['manager_id', 'cli', 'session_id'], { unique: true })
export class AgentSessionExecution {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ type: 'varchar' })
  account_id: string;
  @Column({ type: 'varchar' })
  manager_id: string;
  @Column({ type: 'varchar' })
  cli: string;
  @Column({ type: 'varchar' })
  session_id: string;
  @Column({ type: 'varchar', nullable: true, default: null })
  credential_id: string | null;
  @Column({ type: 'text', default: '{}' })
  config_defaults: string;
  @Column({ type: 'text', nullable: true, default: null })
  runtime_profile: string | null;
  @CreateDateColumn()
  created_at: Date;
}
