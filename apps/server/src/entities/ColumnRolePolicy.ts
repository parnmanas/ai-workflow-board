import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Expected outcome of a single agent cycle on a given column×role pair.
 *
 *   - 'move':                       the agent is expected to call move_ticket
 *                                   (typically to the next column). Skipping
 *                                   the move past `max_cycles_without_progress`
 *                                   counts as a policy violation.
 *   - 'wait_until_label_removed':   the agent is expected to keep waiting until
 *                                   one of `gate_labels` is removed. Always
 *                                   honored as a legitimate WAIT.
 *   - 'terminal':                   end-state column — no movement expected.
 */
export type ColumnRolePolicyExpectedAction =
  | 'move'
  | 'wait_until_label_removed'
  | 'terminal';

/**
 * Side-effect to apply when a policy violation is detected (cycle counter
 * crossed threshold AND no gate label intersection).
 *
 *   - 'alert':                Post a structured chat message + write a
 *                             policy_violation activity row. Default; safe.
 *   - 'auto_move':            Promote the ticket via move_ticket as a system
 *                             actor. Layered behind a per-column toggle.
 *                             Reserved for PR #4 — accepted as a value here
 *                             so the schema is stable across the epic.
 *   - 'escalate_meta_ticket': Create a new high-priority meta-ticket on the
 *                             AWB board To Do.
 */
export type ColumnRolePolicyOnViolation =
  | 'alert'
  | 'auto_move'
  | 'escalate_meta_ticket';

/**
 * ColumnRolePolicy — declarative "what should this column×role cycle have
 * produced" enforcement layer (ticket f886ada7).
 *
 * Pairs with `StuckTicketDetectorService` (ticket 8e934802): the stuck
 * detector recognises the stale-WAIT *shape* (N consecutive agent comments
 * without lifecycle events); this row tells the system what the system
 * *expected* in that same window. The two together turn "agent forgot to
 * move_ticket" from "ticket stuck forever" into a structured alert (and,
 * once PR #4 ships, an opt-in auto-promotion).
 *
 *   Lookup key: (board_id, column_id, role_slug).
 *
 *   `gate_labels` is a JSON-stringified glob list (e.g. `["BLOCKED-*"]`).
 *   Matched against the ticket's labels case-insensitively. An intersection
 *   means "legitimate WAIT" and short-circuits the violation branch.
 *
 *   `enabled = false` disables enforcement for this row only — the stuck
 *   detector still runs its existing stale-WAIT heuristic.
 *
 * Schema-stability: this entity is shipped fully populated up front (incl.
 * `auto_move` enum value and `enabled` toggle) so PR #3/#4 don't require
 * another migration. PR #2 wires the `alert` path only; the other values
 * are accepted on writes but ignored on reads.
 */
@Entity('column_role_policies')
@Index('idx_crp_board_column_role', ['board_id', 'column_id', 'role_slug'], { unique: true })
@Index('idx_crp_column_role', ['column_id', 'role_slug'])
export class ColumnRolePolicy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  board_id: string;

  @Column({ type: 'varchar' })
  column_id: string;

  /**
   * Role slug from `WorkspaceRole.slug` (e.g. 'assignee', 'reporter',
   * 'reviewer', 'planner', or a custom slug). Matched against the roles
   * triggered by this column (read from `BoardColumn.role_routing`).
   */
  @Column({ type: 'varchar' })
  role_slug: string;

  @Column({ type: 'varchar', default: 'move' })
  expected_action: ColumnRolePolicyExpectedAction;

  /**
   * Where the ticket should land when `expected_action = 'move'`. `null`
   * (stored as empty string) for `terminal` / `wait_until_label_removed`.
   */
  @Column({ type: 'varchar', default: '' })
  target_column_id: string;

  /**
   * JSON-stringified array of glob patterns (case-insensitive). Empty `'[]'`
   * means "no label legitimises a WAIT — every cycle without a move is a
   * violation". Defaults to `["BLOCKED-*"]`.
   */
  @Column({ type: 'text', default: '["BLOCKED-*"]' })
  gate_labels: string;

  @Column({ type: 'int', default: 4 })
  max_cycles_without_progress: number;

  @Column({ type: 'varchar', default: 'alert' })
  on_violation: ColumnRolePolicyOnViolation;

  /**
   * Per-row toggle. Off → stuck detector still sweeps the ticket but does
   * not emit a policy_violation alert for this (column, role) pair.
   */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
