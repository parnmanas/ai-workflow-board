import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { ConnectorSnapshot } from '../modules/business/business.types';

@Entity('business_connections')
@Index(['account_id'])
@Index('uq_business_company_provider', ['company_id', 'provider'], { unique: true })
export class BusinessConnection {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) provider: string;
  @Column({ type: 'varchar' }) credential_id: string;
  @Column({ type: 'varchar', default: 'live' }) environment: 'live' | 'sandbox';
  @Column({ type: 'simple-json' }) config: Record<string, string>;
  @Column({ type: 'varchar', default: 'configured' }) status: 'configured' | 'syncing' | 'connected' | 'error';
  @Column({ type: 'simple-json', nullable: true }) snapshot: ConnectorSnapshot | null;
  @Column({ type: 'varchar', default: '' }) last_error: string;
  @Column({ type: 'varchar', nullable: true }) synced_at: string | null;
  @Column({ type: 'varchar', nullable: true }) attempted_at: string | null;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
