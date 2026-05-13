import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import { emptyToNullUuid } from '../database/uuid-column';

@Entity('activity_logs')
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  workspace_id: string;

  @Column({ type: 'varchar' })
  entity_type: string;

  // Polymorphic — entity_type discriminates ('ticket' | 'comment' | …) and
  // entity_id is the row id in the matching table. Currently always a uuid
  // but kept as varchar to leave room for future entity types that might
  // key on slug or composite id. No SQL JOIN exists against this column,
  // so the PG operator-mismatch doesn't apply.
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

  // Kept varchar deliberately — the literal `'system'` sentinel is written
  // by TriggerLoopService / BacklogPromotionService / AgentDispatchQueue to
  // mark automation-originated rows (TriggerLoopService._handleActivity
  // skips on `actor_id === 'system'` to avoid re-processing its own writes).
  // No SQL JOIN exists against this column, so leaving it varchar keeps the
  // sentinel intact without breaking PG operator semantics.
  @Column({ type: 'varchar', default: '' })
  actor_id: string;

  @Column({ type: 'varchar', default: '' })
  actor_name: string;

  // Always a tickets.id (uuid) when set, '' for logs not associated with a
  // ticket. Kept varchar because the '' sentinel is widely used and the
  // column isn't joined against tickets.id anywhere in current code.
  @Column({ type: 'varchar', default: '' })
  ticket_id: string;

  @Column({ type: 'varchar', default: '' })
  role: string;  // agent role at time of activity (e.g. 'assignee', 'reviewer', '')

  @Column({ type: 'varchar', default: '' })
  trigger_source: string;  // 'agent_trigger' | 'manual' | ''

  @CreateDateColumn()
  created_at: Date;
}
