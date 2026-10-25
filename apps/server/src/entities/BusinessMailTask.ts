import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Durable intake/outbox and reply state. External text, drafts and runtime settings are encrypted. */
@Entity('business_mail_tasks')
@Index('uq_business_mail_task_message', ['message_id'], { unique: true })
@Index('uq_business_mail_reply_key', ['account_id', 'reply_key'], { unique: true })
@Index(['status', 'created_at'])
@Index(['notification_state', 'created_at'])
@Index(['account_id', 'connection_id'])
export class BusinessMailTask {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) connection_id: string;
  @Column({ type: 'varchar' }) message_id: string;
  @Column({ type: 'varchar', nullable: true, default: null }) reply_key: string | null;
  @Column({ type: 'varchar', default: 'queued' }) status: 'queued' | 'drafting' | 'review' | 'sending' | 'sent' | 'uncertain' | 'skipped' | 'failed' | 'cancelled';
  @Column({ type: 'text' }) encrypted_data: string;
  @Column({ type: 'varchar', default: '' }) room_id: string;
  @Column({ type: 'varchar', default: '' }) agent_key: string;
  @Column({ type: 'varchar', default: '' }) host_id: string;
  @Column({ type: 'varchar', default: '' }) outbound_message_id: string;
  @Column({ type: 'varchar', default: '' }) started_at: string;
  @Column({ type: 'varchar', default: '' }) sent_at: string;
  @Column({ type: 'varchar', default: '' }) decided_by: string;
  @Column({ type: 'varchar', default: '' }) last_error: string;
  @Column({ type: 'varchar', default: 'pending' }) notification_state: string;
  @Column({ type: 'varchar', default: 'none' }) review_notification_state: string;
  @Column({ type: 'varchar', default: '' }) notification_at: string;
  @Column({ type: 'integer', default: 0 }) notification_attempts: number;
  @Column({ type: 'integer', default: 0 }) review_notification_attempts: number;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
