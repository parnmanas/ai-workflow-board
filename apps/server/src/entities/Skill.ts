import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('skills')
@Index(['workspace_id', 'slug'], { unique: true })
export class Skill {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) workspace_id: string;
  @Column({ type: 'varchar' }) slug: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'text', default: '' }) description: string;
  @Column({ type: 'varchar', default: 'active' }) status: 'active' | 'quarantined';
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
