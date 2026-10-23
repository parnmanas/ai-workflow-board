import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('business_mail_connections')
@Index(['account_id', 'company_id'])
@Index(['enabled', 'next_sync_at'])
export class BusinessMailConnection {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar', nullable: true }) company_id: string | null;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar' }) provider: 'smtp_imap' | 'jmap';
  @Column({ type: 'varchar', default: 'operations' }) purpose: string;
  @Column({ type: 'varchar' }) credential_id: string;
  @Column({ type: 'text' }) encrypted_data: string;
  @Column({ type: 'boolean', default: true }) enabled: boolean;
  @Column({ type: 'integer', default: 5 }) interval_minutes: number;
  @Column({ type: 'varchar', default: 'configured' }) status: string;
  @Column({ type: 'varchar', default: '' }) next_sync_at: string;
  @Column({ type: 'varchar', default: '' }) synced_at: string;
  @Column({ type: 'varchar', default: '' }) last_error: string;
  @Column({ type: 'varchar', default: '' }) lease_token: string;
  @Column({ type: 'varchar', default: '' }) lease_until: string;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
