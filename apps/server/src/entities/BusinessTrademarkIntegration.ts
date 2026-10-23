import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('business_trademark_integrations')
@Index(['account_id', 'company_id', 'trademark_id'])
@Index('uq_trademark_integration_provider', ['trademark_id', 'provider'], { unique: true })
@Index('uq_trademark_oauth_state', ['oauth_state_hash'], { unique: true })
export class BusinessTrademarkIntegration {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) trademark_id: string;
  @Column({ type: 'varchar' }) provider: string;
  @Column({ type: 'varchar' }) credential_id: string;
  @Column({ type: 'text' }) encrypted_data: string;
  @Column({ type: 'varchar', default: 'configured' }) status: 'configured' | 'connected' | 'error' | 'disconnected';
  @Column({ type: 'boolean', default: false }) auto_sync: boolean;
  @Column({ type: 'integer', default: 15 }) interval_minutes: number;
  @Column({ type: 'varchar', nullable: true }) next_sync_at: string | null;
  @Column({ type: 'varchar', nullable: true }) synced_at: string | null;
  @Column({ type: 'text', default: '' }) last_error: string;
  @Column({ type: 'varchar', nullable: true }) oauth_state_hash: string | null;
  @Column({ type: 'varchar', default: '' }) lease_token: string;
  @Column({ type: 'varchar', default: '' }) lease_until: string;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
