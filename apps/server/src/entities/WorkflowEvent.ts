import { Entity, PrimaryColumn, Column, Index, CreateDateColumn } from 'typeorm';

/** Small, allowlisted event metadata. Never stores session transcripts or credentials. */
@Entity('workflow_events')
@Index('idx_workflow_event_source', ['account_id', 'event_type', 'source_key', 'created_at'])
@Index('idx_workflow_event_pending', ['processed', 'created_at'])
export class WorkflowEvent {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) event_type: string;
  @Column({ type: 'varchar' }) source_key: string;
  @Column({ type: 'simple-json' }) data: Record<string, string>;
  @Column({ type: 'int', default: 0 }) processed: number;
  @CreateDateColumn() created_at: Date;
}
