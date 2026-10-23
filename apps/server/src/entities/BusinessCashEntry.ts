import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('business_cash_entries')
@Index(['account_id', 'company_id', 'date'])
@Index(['company_id', 'request_id'], { unique: true })
export class BusinessCashEntry {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) request_id: string;
  @Column({ type: 'text' }) request_payload: string;
  @Column({ type: 'varchar' }) date: string;
  @Column({ type: 'varchar' }) kind: string;
  @Column({ type: 'integer' }) amount_minor: number;
  @Column({ type: 'varchar', default: 'USD' }) currency: string;
  @Column({ type: 'text' }) description: string;
  @Column({ type: 'text', default: '' }) evidence: string;
  @Column({ type: 'boolean', default: false }) reconciled: boolean;
  @Column({ type: 'boolean', default: false }) voided: boolean;
  @Column({ type: 'text', default: '' }) void_reason: string;
  @Column({ type: 'varchar' }) actor_id: string;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
