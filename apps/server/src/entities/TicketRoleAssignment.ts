import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * One row per (ticket, role, holder) — the single source of truth for who is
 * holding which role on which ticket. Replaces the v1
 * `tickets.assignee_id` / `reporter_id` / `reviewer_id` columns, which are
 * dropped at the end of the v0.34 migration.
 *
 * Either `agent_id` or `user_id` is populated (never both, never neither) —
 * roles can be filled by agents or human users.
 *
 * MULTI-HOLDER (다중담당자 T1): a single role on a single ticket may now have
 * **several** holders. The uniqueness key was relaxed from `(ticket_id,
 * role_id)` → `(ticket_id, role_id, holder_key)` so the same role can carry
 * more than one holder while still rejecting the *same* holder twice on the
 * same role. `holder_key` is the normalized identity of the holder
 * (`agent:<id>` or `user:<id>`) — a single indexable column that sidesteps
 * the NULL-distinctness gotcha of indexing `(agent_id, user_id)` directly
 * (Postgres treats NULLs as distinct, so a raw composite would let the same
 * agent be added twice). It is maintained by TicketRoleAssignmentService on
 * every write; callers never set it by hand.
 *
 * Multiple different roles on the same ticket can still share a holder (e.g.,
 * assignee and reviewer both = agent X). Consumers that assume one holder per
 * role read the first holder via a shim until the T2 fan-out lands.
 */
@Entity('ticket_role_assignments')
@Index('uniq_ticket_role_holder', ['ticket_id', 'role_id', 'holder_key'], { unique: true })
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

  /**
   * Normalized holder identity — `agent:<agent_id>` or `user:<user_id>`.
   * Part of the `(ticket_id, role_id, holder_key)` unique key so the same
   * holder can't be pinned twice on one role while distinct holders coexist.
   * Never null in practice (vacant rows are deleted outright); defaults to
   * empty string so the ADD COLUMN backfills existing rows safely before the
   * data migration rewrites the real value.
   */
  @Column({ type: 'varchar', default: '' })
  holder_key: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
