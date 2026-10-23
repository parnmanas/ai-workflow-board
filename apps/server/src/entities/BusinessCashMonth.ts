import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('business_cash_months')
@Index(['account_id', 'company_id'])
@Index(['company_id', 'month'], { unique: true })
export class BusinessCashMonth {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) month: string;
  @Column({ type: 'integer' }) opening_minor: number;
  @Column({ type: 'integer' }) closing_minor: number;
  @Column({ type: 'text' }) statement_reference: string;
  @Column({ type: 'boolean', default: false }) closed: boolean;
  @Column({ type: 'varchar', default: '' }) closed_at: string;
  @Column({ type: 'text', default: '' }) reopen_reason: string;
  @Column({ type: 'varchar' }) actor_id: string;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
