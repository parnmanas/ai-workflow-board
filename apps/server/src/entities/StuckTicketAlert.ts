import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * StuckTicketAlert — dedup row for `StuckTicketDetectorService` (ticket
 * 8e934802). One row per stuck ticket; the detector consults it to
 * decide whether the same stale-WAIT state has already been surfaced
 * to the workspace chat room within the re-alert cooldown.
 *
 * Layer-1 design (no schema break):
 *  - `ticket_id` is the PK; we tolerate a missing ticket on read (the
 *    detector skips rows whose ticket has been deleted). No FK cascade
 *    is declared so a future ticket deletion can't choke on a join.
 *  - `last_cycle_count` is the agent-comment cycle count at the moment
 *    of the most-recent alert. Re-alert iff `current > last` OR
 *    `last_alerted_at` is older than the cooldown.
 *  - `last_comment_id` lets the detector identify a "newer non-agent
 *    comment arrived" unstuck condition without re-scanning history.
 *
 * On unstuck (column move, claim/release, or a fresh non-agent comment)
 * the row is deleted, not flagged — keeps the table self-pruning.
 */
@Entity('stuck_alerts')
export class StuckTicketAlert {
  // Single-row-per-ticket. Plain string (not @PrimaryGeneratedColumn)
  // — the id IS the ticket id, no separate uuid surface needed.
  @PrimaryColumn({ type: 'varchar' })
  ticket_id: string;

  @Column({ type: Date })
  last_alerted_at: Date;

  @Column({ type: 'int', default: 0 })
  last_cycle_count: number;

  // ID of the most-recent agent comment counted by the alert. Stored so
  // the detector can spot a brand-new comment that pushes the cycle
  // count forward (re-alert path) without recomputing.
  @Column({ type: 'varchar', default: '' })
  last_comment_id: string;

  // Durable delivery state (ticket e7c87517, reviewer blocker #3). The row is
  // persisted BEFORE the chat post is attempted (crash-safe recovery pointer),
  // and `delivered_at` is stamped ONLY after a chat post actually succeeds. The
  // no-progress re-alert cooldown keys off `delivered_at`, NOT `last_alerted_at`
  // — so a first delivery that fails (no alerts room / send throws) is retried
  // every sweep instead of being silenced for a full REALERT window. `null` =
  // an alert is owed but has never been delivered. `delivery_attempts` counts
  // attempts for observability / debugging a persistently-undeliverable alert.
  @Column({ type: Date, nullable: true, default: null })
  delivered_at: Date | null;

  @Column({ type: 'int', default: 0 })
  delivery_attempts: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
