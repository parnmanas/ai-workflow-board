import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('comment_summary_runs')
@Index(['ticket_id'], { unique: true })
export class CommentSummaryRun {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) ticket_id: string;
  @Column({ type: 'varchar' }) workspace_id: string;
  @Column({ type: 'varchar' }) agent_id: string;
  @Column({ type: 'varchar', default: 'pending' }) status: 'pending' | 'completing' | 'completed' | 'failed';
  @Column({ type: 'int', default: 0 }) source_comment_count: number;
  @Column({ type: 'text', default: '[]' }) source_comment_ids: string;
  @Column({ type: 'text', default: '' }) error: string;
  @Column({ type: 'varchar', default: '' }) error_code: string;
  @Column({ type: 'varchar', default: '' }) dispatch_trigger_id: string;
  @Column({ type: Date, nullable: true, default: null }) completed_at: Date | null;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
