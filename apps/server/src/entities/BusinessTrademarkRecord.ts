import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('business_trademark_records')
@Index(['account_id', 'company_id', 'trademark_id'])
@Index('uq_trademark_source_record', ['integration_id', 'source_hash'], { unique: true })
export class BusinessTrademarkRecord {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) trademark_id: string;
  @Column({ type: 'varchar' }) integration_id: string;
  @Column({ type: 'varchar' }) source_hash: string;
  @Column({ type: 'text' }) encrypted_data: string;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
