import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('runtime_skill_assignments')
@Index('idx_runtime_skill_scope', ['workspace_id', 'runtime_key', 'skill_id', 'board_id', 'role_slug'], { unique: true })
export class RuntimeSkillAssignment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) workspace_id: string;
  @Column({ type: 'varchar' }) runtime_key: string;
  @Column({ type: 'varchar' }) skill_id: string;
  @Column({ type: 'varchar' }) skill_version_id: string;
  @Column({ type: 'varchar', default: '' }) board_id: string;
  @Column({ type: 'varchar', default: '' }) role_slug: string;
  @Column({ type: 'varchar', default: '' }) assigned_by: string;
  @CreateDateColumn() created_at: Date;
}
