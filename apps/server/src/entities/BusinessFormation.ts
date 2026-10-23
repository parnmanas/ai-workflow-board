import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('business_formations')
@Index(['account_id'])
@Index('uq_business_formation_company_provider_env', ['company_id', 'provider', 'environment'], { unique: true })
export class BusinessFormation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) provider: string;
  @Column({ type: 'varchar' }) environment: 'sandbox' | 'live';
  @Column({ type: 'varchar' }) credential_id: string;
  @Column({ type: 'varchar' }) credential_digest: string;
  @Column({ type: 'text' }) encrypted_request: string;
  @Column({ type: 'varchar' }) payload_digest: string;
  @Column({ type: 'simple-json' }) summary: { name: string; state: string; entity_type: string; industry: string };
  @Column({ type: 'integer' }) state_fee_cents: number;
  @Column({ type: 'varchar' }) quoted_at: string;
  @Column({ type: 'varchar', default: 'draft' }) status: 'draft' | 'submitting' | 'uncertain' | 'submitted';
  @Column({ type: 'varchar', default: '' }) customer_id: string;
  @Column({ type: 'varchar', default: '' }) external_company_id: string;
  @Column({ type: 'varchar', default: '' }) provider_status: string;
  @Column({ type: 'text', default: '' }) last_error: string;
  @Column({ type: 'varchar', nullable: true }) attempted_at: string | null;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
