import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('run_skill_snapshots')
@Index(['workspace_id', 'run_id'], { unique: true })
export class RunSkillSnapshot {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) workspace_id: string;
  @Column({ type: 'varchar' }) run_id: string;
  @Column({ type: 'varchar' }) agent_id: string;
  @Column({ type: 'simple-json' }) manifest: unknown;
  @Column({ type: 'varchar' }) digest: string;
  @Column({ type: 'varchar', default: 'pinned' }) status: 'pinned' | 'locked';
  @Column({ type: Date, nullable: true, default: null }) locked_at: Date | null;
  @CreateDateColumn() created_at: Date;
}
