import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Stable account-owned sender identity; mailing lists remain audience labels. */
@Entity('marketing_brands')
@Index(['account_id'])
export class MarketingBrand {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) name: string;
  @CreateDateColumn() created_at: Date;
}
