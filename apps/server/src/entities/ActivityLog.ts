import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('activity_logs')
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  entity_type: string;

  @Column({ type: 'varchar' })
  entity_id: string;

  @Column({ type: 'varchar' })
  action: string;

  @Column({ type: 'varchar', default: '' })
  field_changed: string;

  @Column({ type: 'varchar', default: '' })
  old_value: string;

  @Column({ type: 'varchar', default: '' })
  new_value: string;

  @Column({ type: 'varchar', default: '' })
  actor_id: string;

  @Column({ type: 'varchar', default: '' })
  actor_name: string;

  @Column({ type: 'varchar', default: '' })
  ticket_id: string;

  @Column({ type: 'varchar', default: '' })
  role: string;  // agent role at time of activity (e.g. 'assignee', 'reviewer', '')

  @Column({ type: 'varchar', default: '' })
  trigger_source: string;  // 'agent_trigger' | 'manual' | ''

  @CreateDateColumn()
  created_at: Date;
}
