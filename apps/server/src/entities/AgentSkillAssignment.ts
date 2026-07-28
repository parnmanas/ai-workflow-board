import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('agent_skill_assignments')
@Index(['agent_id', 'skill_id', 'board_id', 'role_slug'], { unique: true })
export class AgentSkillAssignment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) workspace_id: string;
  @Column({ type: 'varchar' }) agent_id: string;
  @Column({ type: 'varchar' }) skill_id: string;
  @Column({ type: 'varchar' }) skill_version_id: string;
  @Column({ type: 'varchar', default: '' }) board_id: string;
  @Column({ type: 'varchar', default: '' }) role_slug: string;
  @Column({ type: 'varchar', default: '' }) assigned_by: string;
  @CreateDateColumn() created_at: Date;
}
