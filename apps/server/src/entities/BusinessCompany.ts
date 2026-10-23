import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('business_companies')
@Index(['account_id'])
export class BusinessCompany {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar', default: 'LLC' }) entity_type: string;
  @Column({ type: 'varchar', default: 'US' }) country: string;
  @Column({ type: 'varchar', default: '' }) jurisdiction: string;
  @Column({ type: 'text', default: '' }) description: string;
  @Column({ type: 'simple-json' }) campaign_ids: string[];
  @Column({ type: 'simple-json', default: '{}' }) service_choices: Record<string, { provider: string; plan: string }>;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
