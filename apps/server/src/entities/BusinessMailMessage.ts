import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('business_mail_messages')
@Index(['account_id', 'created_at'])
@Index(['connection_id', 'direction', 'confirmed'])
@Index('uq_business_mail_source', ['connection_id', 'source_key'], { unique: true })
@Index(['thread_key', 'account_id'])
@Index(['account_id', 'message_key'])
@Index(['account_id', 'subject_key'])
export class BusinessMailMessage {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) connection_id: string;
  @Column({ type: 'varchar' }) source_key: string;
  @Column({ type: 'text', default: '' }) address_keys: string;
  // Keyed digests (mail/mail-thread.ts) so conversations group without decrypting every row.
  // '' until assigned; instance import clears them because they depend on this server's key.
  @Column({ type: 'varchar', default: '' }) message_key: string;
  @Column({ type: 'varchar', default: '' }) thread_key: string;
  @Column({ type: 'varchar', default: '' }) subject_key: string;
  @Column({ type: 'varchar' }) direction: 'inbound' | 'outbound';
  @Column({ type: 'varchar', default: 'received' }) status: 'received' | 'sending' | 'accepted' | 'uncertain';
  @Column({ type: 'text' }) encrypted_data: string;
  @Column({ type: 'varchar', default: '' }) payload_digest: string;
  @Column({ type: 'boolean', default: false }) confirmed: boolean;
  @Column({ type: 'varchar', default: '' }) confirmed_by: string;
  @Column({ type: 'varchar', default: '' }) confirmed_at: string;
  @Column({ type: 'varchar', default: '' }) actor_id: string;
  @Column({ type: 'varchar', default: '' }) last_error: string;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
