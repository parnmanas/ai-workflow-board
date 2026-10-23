import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { BusinessStage, TaskStatus } from '../modules/business/business.types';

@Entity('business_tasks')
@Index(['account_id', 'company_id'])
export class BusinessTask {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) stage: BusinessStage;
  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'text', default: '' }) description: string;
  @Column({ type: 'varchar', default: 'todo' }) status: TaskStatus;
  @Column({ type: 'simple-json' }) depends_on: string[];
  @Column({ type: 'varchar', nullable: true }) due_on: string | null;
  @Column({ type: 'varchar', default: '' }) owner: string;
  @Column({ type: 'text', default: '' }) notes: string;
  @Column({ type: 'varchar', nullable: true }) ticket_id: string | null;
  @Column({ type: 'integer', default: 0 }) position: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
