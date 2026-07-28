import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('skill_versions')
@Index(['skill_id', 'version'], { unique: true })
@Index(['skill_id', 'digest'], { unique: true })
export class SkillVersion {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) workspace_id: string;
  @Column({ type: 'varchar' }) skill_id: string;
  @Column({ type: 'integer' }) version: number;
  @Column({ type: 'text' }) body: string;
  @Column({ type: 'simple-json', default: '[]' }) support_files: Array<{ path: string; content: string }>;
  @Column({ type: 'varchar' }) digest: string;
  @Column({ type: 'varchar', default: '' }) created_by: string;
  @Column({ type: 'varchar', default: '' }) source_proposal_id: string;
  @CreateDateColumn() created_at: Date;
}
