import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('skill_proposals')
@Index(['workspace_id', 'status'])
export class SkillProposal {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) workspace_id: string;
  @Column({ type: 'varchar', default: '' }) skill_id: string;
  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'text' }) body: string;
  @Column({ type: 'simple-json', default: '[]' }) support_files: Array<{ path: string; content: string }>;
  @Column({ type: 'varchar' }) digest: string;
  @Column({ type: 'varchar', default: 'pending' }) status: 'pending' | 'approved' | 'rejected';
  @Column({ type: 'varchar', default: '' }) source_agent_id: string;
  @Column({ type: 'varchar', default: '' }) source_run_id: string;
  @Column({ type: 'varchar', default: '' }) reviewed_by: string;
  @Column({ type: 'text', default: '' }) review_note: string;
  @Column({ type: Date, nullable: true, default: null }) reviewed_at: Date | null;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
