import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { AgentChannelIdentity } from './AgentChannelIdentity';

@Entity('agents')
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar', default: 'custom' })
  type: string;

  @Column({ type: 'varchar', default: '' })
  avatar_url: string;

  @Column({ type: 'int', default: 1 })
  is_active: number;

  @Column({ type: 'int', default: 0 })
  is_online: number;

  @Column({ type: 'varchar', default: '[]' })
  roles: string;  // JSON-serialised string array e.g. '["assignee","reviewer"]'

  @Column({ type: Date, nullable: true, default: null })
  connected_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_seen_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_error_upload_at: Date | null;

  @Column({ type: 'varchar', default: '' })
  webhook_url: string;

  @Column({ type: 'varchar', default: '' })
  workspace_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  parent_agent_id: string | null;

  @Column({ type: 'text', default: '' })
  role_prompt: string;

  @Column({ type: 'simple-json', nullable: true, default: null })
  role_prompt_meta: Record<string, any> | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => AgentChannelIdentity, identity => identity.agent, { cascade: true })
  channel_identities: AgentChannelIdentity[];
}
