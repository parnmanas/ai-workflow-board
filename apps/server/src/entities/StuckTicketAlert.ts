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

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
