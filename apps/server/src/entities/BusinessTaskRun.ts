import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { RuntimeSpec } from '../common/runtime-spec';

/** One durable user request. Business execution never needs a Ticket. */
@Entity('business_task_runs')
@Index(['account_id', 'company_id', 'task_id', 'sequence'])
@Index(['status', 'created_at'])
export class BusinessTaskRun {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) task_id: string;
  @Column({ type: 'integer' }) sequence: number;
  @Column({ type: 'varchar' }) requested_by: string;
  @Column({ type: 'varchar' }) request_entry_id: string;
  @Column({ type: 'varchar' }) input_digest: string;
  @Column({ type: 'simple-json' }) agent_runtime: RuntimeSpec;
  @Column({ type: 'varchar', default: 'queued' }) status: 'queued' | 'running' | 'needs_input' | 'completed' | 'failed';
  @Column({ type: 'varchar', default: '' }) room_id: string;
  @Column({ type: 'varchar', default: '' }) dispatch_message_id: string;
  @Column({ type: 'varchar', default: '' }) output_digest: string;
  @Column({ type: 'text', default: '' }) summary: string;
  @Column({ type: 'text', default: '' }) question: string;
  @Column({ type: 'text', default: '' }) last_error: string;
  @Column({ type: Date, nullable: true }) started_at: Date | null;
  @Column({ type: Date, nullable: true }) completed_at: Date | null;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
