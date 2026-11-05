import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

@Entity('event_subscriptions')
@Index('idx_event_subscription_source', ['account_id', 'event_type', 'source_key', 'status'])
@Index('idx_event_subscription_owner', ['account_id', 'owner_key', 'created_at'])
export class EventSubscription {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  /** Native session address or room + runtime identity; callers only manage their own subscriptions. */
  @Column({ type: 'varchar' }) owner_key: string;
  @Column({ type: 'varchar' }) host_id: string;
  @Column({ type: 'varchar' }) event_type: string;
  @Column({ type: 'varchar' }) source_key: string;
  @Column({ type: 'simple-json' }) filter: Record<string, string>;
  @Column({ type: 'simple-json' }) target: Record<string, string>;
  @Column({ type: 'text' }) prompt: string;
  @Column({ type: 'varchar', default: 'active' }) status: string;
  @Column({ type: 'int', default: 1 }) max_triggers: number;
  @Column({ type: 'int', default: 0 }) matched_count: number;
  @Column({ type: 'int', default: 60 }) cooldown_seconds: number;
  @Column({ type: Date, nullable: true }) last_matched_at: Date | null;
  @Column({ type: Date }) expires_at: Date;
  @CreateDateColumn() created_at: Date;
}
