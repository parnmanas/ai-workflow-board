import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * One row per (ticket, role) slot — the single source of truth for who is
 * holding which role on which ticket. Replaces the v1
 * `tickets.assignee_id` / `reporter_id` / `reviewer_id` columns, which are
 * dropped at the end of the v0.34 migration.
 *
 * Either `agent_id` or `user_id` is populated (never both, never neither) —
 * roles can be filled by agents or human users. `(ticket_id, role_id)` is
 * unique: a single role on a single ticket has at most one holder. Multiple
 * different roles on the same ticket can share a holder (e.g., assignee and
 * reviewer both = agent X).
 */
@Entity('ticket_role_assignments')
@Index('uniq_ticket_role', ['ticket_id', 'role_id'], { unique: true })
@Index('idx_ticket_role_agent', ['agent_id'])
@Index('idx_ticket_role_user', ['user_id'])
export class TicketRoleAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  ticket_id: string;

  @Column({ type: 'varchar' })
  role_id: string;

  /** Agent holding the role. Mutually exclusive with user_id. */
  @Column({ type: 'varchar', nullable: true, default: null })
  agent_id: string | null;

  /** Human user holding the role. Mutually exclusive with agent_id. */
  @Column({ type: 'varchar', nullable: true, default: null })
  user_id: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
