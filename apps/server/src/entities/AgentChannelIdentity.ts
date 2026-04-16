import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Agent } from './Agent';

@Entity('agent_channel_identities')
export class AgentChannelIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  agent_id: string;

  @Column({ type: 'varchar' })
  channel_type: string;

  @Column({ type: 'varchar' })
  channel_external_id: string;

  @Column({ type: 'varchar', default: '' })
  display_name: string;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Agent, agent => agent.channel_identities, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_id' })
  agent: Agent;
}
