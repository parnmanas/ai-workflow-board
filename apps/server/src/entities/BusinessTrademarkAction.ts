import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('business_trademark_actions')
@Index(['account_id', 'company_id', 'trademark_id'])
@Index('uq_trademark_open_action', ['integration_id'], { unique: true, where: "status IN ('draft', 'sending', 'uncertain')" })
export class BusinessTrademarkAction {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) trademark_id: string;
  @Column({ type: 'varchar' }) integration_id: string;
  @Column({ type: 'varchar' }) credential_id: string;
  @Column({ type: 'varchar' }) context_digest: string;
  @Column({ type: 'integer' }) trademark_revision: number;
  @Column({ type: 'varchar' }) kind: 'mail' | 'contract';
  @Column({ type: 'text' }) encrypted_data: string;
  @Column({ type: 'varchar' }) payload_digest: string;
  @Column({ type: 'varchar', default: 'draft' }) status: 'draft' | 'sending' | 'sent' | 'uncertain';
  @Column({ type: 'varchar', default: '' }) external_id: string;
  @Column({ type: 'varchar', default: '' }) external_status: string;
  @Column({ type: 'varchar', nullable: true }) attempted_at: string | null;
  @Column({ type: 'text', default: '' }) last_error: string;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
