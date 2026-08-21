import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('skill_versions')
@Index(['skill_id', 'version'], { unique: true })
@Index(['skill_id', 'digest'], { unique: true })
export class SkillVersion {
  @PrimaryGeneratedColumn('uuid') id: string;
  /**
   * Mirrors the parent Skill's scope — NULL for a version of a global skill.
   * Kept denormalized (rather than joined through skill_id) so the hot
   * snapshot-resolution query can filter versions without a join; the invariant
   * is "a version's workspace_id always equals its skill's".
   */
  @Column({ type: 'varchar', nullable: true, default: null }) workspace_id: string | null;
  @Column({ type: 'varchar' }) skill_id: string;
  @Column({ type: 'integer' }) version: number;
  @Column({ type: 'text' }) body: string;
  @Column({ type: 'simple-json', default: '[]' }) support_files: Array<{ path: string; content: string }>;
  @Column({ type: 'varchar' }) digest: string;
  @Column({ type: 'varchar', default: '' }) created_by: string;
  @Column({ type: 'varchar', default: '' }) source_proposal_id: string;
  @CreateDateColumn() created_at: Date;
}
