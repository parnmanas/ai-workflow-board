import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Ticket } from './Ticket';

@Entity('agent_triggers')
export class AgentTrigger {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  ticket_id: string;

  @Column({ type: 'varchar' })
  role: string;  // 'assignee' | 'reporter' | 'reviewer' — validated in service layer

  @Column({ type: 'varchar', default: '' })
  agent_id: string;  // target agent id resolved from ticket's role field

  @Column({ type: 'varchar', default: '' })
  triggered_by: string;  // agent id or user id that caused the trigger

  @Column({ type: 'timestamp', nullable: true, default: null })
  expires_at: Date | null;

  @Column({ type: 'timestamp', nullable: true, default: null })
  acknowledged_at: Date | null;

  @Column({ type: 'timestamp', nullable: true, default: null })
  cooldown_until: Date | null;  // pre-computed deadline; trigger suppressed while NOW() < cooldown_until

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;

  @CreateDateColumn()
  created_at: Date;
}
