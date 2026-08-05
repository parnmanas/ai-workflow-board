import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type TicketDuplicateOutcome =
  | 'auto_linked'
  | 'confirmed_link'
  | 'rejected'
  | 'ambiguous_pending'
  | 'resolved_from_canonical'
  | 'corrected_independent';

@Entity('ticket_duplicate_decisions')
@Index('idx_ticket_duplicate_report', ['report_ticket_id'])
@Index('idx_ticket_duplicate_candidate', ['candidate_ticket_id'])
export class TicketDuplicateDecision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  report_ticket_id: string;

  @Column({ type: 'varchar' })
  candidate_ticket_id: string;

  @Column({ type: 'varchar' })
  outcome: TicketDuplicateOutcome;

  @Column({ type: 'int', default: 0 })
  confidence: number;

  @Column({ type: 'text', default: '[]' })
  matched_signals: string;

  @Column({ type: 'varchar', default: 'chat-dedupe-v1' })
  policy_version: string;

  @Column({ type: 'varchar', default: '' })
  actor_id: string;

  @Column({ type: 'varchar', default: '' })
  actor_name: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
