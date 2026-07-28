import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Reusable operation exposed to humans, workflows, and MCP agents.
 * workspace_id NULL means global; a value means workspace-specific.
 */
@Entity('workflow_functions')
@Index('uq_workflow_functions_global_key', ['key'], { unique: true, where: 'workspace_id IS NULL' })
@Index('uq_workflow_functions_workspace_key', ['workspace_id', 'key'], { unique: true, where: 'workspace_id IS NOT NULL' })
export class WorkflowFunction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  workspace_id: string | null;

  @Column({ type: 'varchar' })
  key: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'varchar', default: 'builtin' })
  executor_type: string;

  @Column({ type: 'text', default: '{}' })
  input_schema: string;

  @Column({ type: 'text', default: '{}' })
  output_schema: string;

  @Column({ type: 'text', default: '{}' })
  config: string;

  @Column({ type: 'varchar', default: 'read' })
  risk_level: string;

  @Column({ type: 'varchar', default: 'none' })
  idempotency_mode: string;

  @Column({ type: 'int', default: 300000 })
  timeout_ms: number;

  @Column({ type: 'int', default: 1 })
  max_attempts: number;

  @Column({ type: 'varchar', default: 'none' })
  approval_policy: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'boolean', default: false })
  builtin: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
