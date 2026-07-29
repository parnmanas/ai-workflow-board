import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('child_runs')
@Index(['workspace_id', 'parent_run_id', 'runtime_child_id'], { unique: true })
@Index(['workspace_id', 'parent_run_id', 'status'])
export class ChildRun {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) workspace_id: string;
  @Column({ type: 'varchar' }) parent_run_id: string;
  @Column({ type: 'varchar' }) parent_agent_id: string;
  @Column({ type: 'varchar' }) runtime_child_id: string;
  @Column({ type: 'varchar', default: 'delegated' }) strategy: 'delegated' | 'swarm';
  @Column({ type: 'varchar', default: 'running' }) status: 'running' | 'completed' | 'failed' | 'cancelled';
  @Column({ type: 'integer', default: 1 }) depth: number;
  @Column({ type: 'integer', default: 0 }) budget: number;
  @Column({ type: 'varchar', default: '' }) title: string;
  @Column({ type: 'text', default: '' }) summary: string;
  @Column({ type: 'simple-json', default: '{}' }) runtime_metadata: Record<string, unknown>;
  @Column({ type: Date }) started_at: Date;
  @Column({ type: Date, nullable: true, default: null }) finished_at: Date | null;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
