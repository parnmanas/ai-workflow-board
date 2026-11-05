import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

@Entity('event_deliveries')
@Index('uq_event_delivery', ['subscription_id', 'event_id'], { unique: true })
@Index('idx_event_delivery_pending', ['status', 'available_at'])
export class EventDelivery {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) subscription_id: string;
  @Column({ type: 'varchar' }) event_id: string;
  @Column({ type: 'varchar', default: 'pending' }) status: string;
  @Column({ type: 'int', default: 0 }) attempts: number;
  @Column({ type: Date }) available_at: Date;
  @Column({ type: 'varchar', nullable: true }) lease_token: string | null;
  @Column({ type: 'text', default: '' }) last_error: string;
  @Column({ type: 'varchar', nullable: true }) dispatched_turn_id: string | null;
  @CreateDateColumn() created_at: Date;
}
