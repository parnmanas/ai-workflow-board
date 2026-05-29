import { Entity, PrimaryColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Ticket } from './Ticket';

// Join row that blocks `ticket_id` until `prerequisite_ticket_id` reaches a
// terminal column. M:N — one ticket can have many prerequisites, one
// prerequisite can block many tickets. Distinct from `Ticket.next_ticket_id`
// (forward 1:1 push); this is the backward M:N pull.
//
// Auto-resume sweep keys off the `prerequisite_ticket_id` index: when a
// ticket lands on a terminal column TriggerLoopService scans every row
// pointing AT it, then re-evaluates each dependent's full prereq set.
@Entity('ticket_prerequisites')
@Index('idx_ticket_prerequisites_prereq', ['prerequisite_ticket_id'])
// Forward lookup ("what blocks ticket X?") filters by ticket_id on every
// prereq list + the detail-panel render; only the reverse (prereq) side was
// indexed — perf ticket b3812637.
@Index('idx_ticket_prerequisites_ticket', ['ticket_id'])
export class TicketPrerequisite {
  @PrimaryColumn({ type: 'varchar' })
  ticket_id: string;

  @PrimaryColumn({ type: 'varchar' })
  prerequisite_ticket_id: string;

  @CreateDateColumn()
  created_at: Date;

  // Display name of the actor (agent or user) that added the link. Stored as
  // a string for the same reason as `Ticket.pending_set_by` — the source can
  // be either an Agent or a User row and the UI only needs the label.
  @Column({ type: 'varchar', default: '' })
  created_by: string;

  // Optional context for *why* the link exists. Surfaced on the ticket
  // detail panel's Prerequisites section so a human / agent walking up to a
  // blocked ticket can read intent without scrolling the comment log.
  @Column({ type: 'text', default: '' })
  reason: string;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'prerequisite_ticket_id' })
  prerequisite_ticket: Ticket;
}
