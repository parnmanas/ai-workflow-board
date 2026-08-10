import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * CiRedAlert — dedup + delivery-state row for `CiHealthMonitorService` (ticket
 * cc1c494e). One row per (board, repo, branch, workflow) currently in a red
 * streak; the sweep consults it to decide whether the streak has already been
 * surfaced within the re-alert cooldown, and to avoid re-creating a Backlog
 * ticket for an episode still open.
 *
 * Sibling of `StuckTicketAlert` (same durable-delivery shape), but keyed by
 * the monitored CI target rather than a ticket_id — there is no ticket to key
 * off until (and unless) this row causes one to be created, so the PK here is
 * a generated uuid plus a unique composite index on the target tuple instead
 * of `StuckTicketAlert`'s `@PrimaryColumn ticket_id`.
 *
 * DURABLE DELIVERY (mirrors StuckTicketAlert / ticket e7c87517 blocker #3):
 * the row is written BEFORE the chat post is attempted, and `delivered_at` is
 * stamped ONLY after a chat post actually succeeds — a failed first delivery
 * is retried every sweep instead of silenced for a full re-alert window.
 *
 * On recovery (latest completed run green) the row is deleted, not flagged —
 * keeps the table self-pruning, same as StuckTicketAlert's unstuck path.
 */
@Entity('ci_red_alerts')
@Index('uq_ci_red_alerts_target', ['board_id', 'repo_full_name', 'branch', 'workflow_id'], { unique: true })
export class CiRedAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  board_id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // "owner/repo" — parsed from the board environment repo's Resource.url.
  @Column({ type: 'varchar' })
  repo_full_name: string;

  @Column({ type: 'varchar' })
  branch: string;

  // GitHub workflow id, stored as text (external id — never arithmetic on it).
  @Column({ type: 'varchar' })
  workflow_id: string;

  @Column({ type: 'varchar', default: '' })
  workflow_name: string;

  @Column({ type: 'varchar', default: '' })
  first_failed_run_id: string;

  @Column({ type: 'varchar', default: '' })
  last_run_id: string;

  // Consecutive red (failure|timed_out|startup_failure) completed runs ending
  // at last_run_id. Reset (row deleted) the moment the latest completed run
  // is green.
  @Column({ type: 'int', default: 0 })
  streak: number;

  // Durable delivery state — see class docstring. `null` = an alert is owed
  // but has never been delivered; the re-alert cooldown keys off this field,
  // never off a plain "last attempted" timestamp.
  @Column({ type: Date, nullable: true, default: null })
  delivered_at: Date | null;

  @Column({ type: 'int', default: 0 })
  delivery_attempts: number;

  // Backlog ticket auto-created for this episode, if CI_MONITOR_CREATE_TICKET
  // was enabled and creation succeeded. Left null when disabled or when
  // creation itself failed (chat alert still fires independently).
  @Column({ type: 'varchar', nullable: true, default: null })
  created_ticket_id: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
