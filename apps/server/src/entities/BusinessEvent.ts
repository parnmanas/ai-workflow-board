import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('business_events')
@Index(['account_id', 'company_id', 'created_at'])
export class BusinessEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) actor_id: string;
  @Column({ type: 'varchar' }) kind: string;
  @Column({ type: 'varchar' }) message: string;
  @CreateDateColumn() created_at: Date;
}
