import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** A reusable launch preference. Execution folders and identities belong to the caller. */
@Entity('agent_templates')
export class AgentTemplate {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar' }) host_id: string;
  @Column({ type: 'varchar' }) cli: string;
  @Column({ type: 'varchar', nullable: true }) model: string | null;
  @Column({ type: 'varchar', nullable: true }) effort: string | null;
  @Column({ type: 'simple-json' }) runtime_config: Record<string, any>;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
