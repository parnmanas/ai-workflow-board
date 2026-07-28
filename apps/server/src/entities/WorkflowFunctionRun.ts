import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('workflow_function_runs')
@Index(['function_id', 'created_at'])
@Index(['workspace_id', 'ticket_id', 'created_at'])
export class WorkflowFunctionRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  function_id: string;

  @Column({ type: 'varchar' })
  function_key: string;

  @Column({ type: 'int', default: 1 })
  function_version: number;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  ticket_id: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  parent_run_id: string | null;

  @Column({ type: 'varchar', default: 'system' })
  actor_type: string;

  @Column({ type: 'varchar', default: '' })
  actor_id: string;

  @Column({ type: 'varchar', default: '' })
  actor_name: string;

  @Column({ type: 'varchar', default: 'running' })
  status: string;

  @Column({ type: 'text', default: '{}' })
  inputs: string;

  @Column({ type: 'text', default: '{}' })
  outputs: string;

  @Column({ type: 'text', default: '{}' })
  evidence: string;

  @Column({ type: 'varchar', default: '' })
  idempotency_key: string;

  @Column({ type: 'varchar', default: '' })
  error_code: string;

  @Column({ type: 'text', default: '' })
  error_message: string;

  @Column({ type: 'int', default: 1 })
  attempt: number;

  @Column({ type: Date, nullable: true, default: null })
  started_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  completed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;
}
