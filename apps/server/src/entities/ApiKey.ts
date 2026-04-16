import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Agent } from './Agent';

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', unique: true })
  key: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  agent_id: string | null;

  @ManyToOne(() => Agent, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'agent_id' })
  agent: Agent | null;

  @Column({ type: 'varchar', default: 'full' })
  scope: string;

  @Column({ type: 'int', default: 1 })
  is_active: number;

  @Column({ type: 'timestamp', nullable: true, default: null })
  expires_at: Date | null;

  @Column({ type: 'timestamp', nullable: true, default: null })
  last_used_at: Date | null;

  @Column({ type: 'int', default: 0 })
  use_count: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
