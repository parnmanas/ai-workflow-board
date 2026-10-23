import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('business_trademark_mail')
@Index(['account_id', 'company_id', 'trademark_id'])
export class BusinessTrademarkMail {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) trademark_id: string;
  @Column({ type: 'integer' }) trademark_revision: number;
  @Column({ type: 'varchar' }) provider: string;
  @Column({ type: 'varchar' }) credential_id: string;
  @Column({ type: 'varchar' }) credential_digest: string;
  @Column({ type: 'text' }) encrypted_payload: string;
  @Column({ type: 'varchar' }) payload_digest: string;
  @Column({ type: 'varchar', default: 'draft' }) status: 'draft' | 'sending' | 'sent' | 'uncertain';
  @Column({ type: 'varchar', default: '' }) provider_message_id: string;
  @Column({ type: 'varchar', default: '' }) delivery_status: string;
  @Column({ type: 'varchar', nullable: true }) checked_at: string | null;
  @Column({ type: 'varchar', nullable: true }) first_attempted_at: string | null;
  @Column({ type: 'varchar', nullable: true }) attempted_at: string | null;
  @Column({ type: 'text', default: '' }) last_error: string;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
