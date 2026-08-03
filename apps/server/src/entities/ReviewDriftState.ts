import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Classification of main-branch drift observed during a Review episode. See
 * `review-drift.ts`'s `classifyDrift` for the pure decision logic.
 *
 *   - 'fresh':                 no drift since the last check (or entry).
 *   - 'non_overlapping_drift': main moved, but not in paths this ticket's
 *                              branch touches — safe to proceed without a
 *                              rebase round-trip through Review.
 *   - 'overlapping_drift':     main moved in a path this branch also touches
 *                              (or a repo-global file) and the episode has not
 *                              yet spent its one reverification bounce.
 *   - 'overlapping_drift_budget_exhausted': same overlap, but this episode
 *                              already bounced once for it — Merging's own
 *                              rebase becomes the final re-verification point
 *                              instead of a second Review round-trip.
 */
export type DriftClassification =
  | 'fresh'
  | 'non_overlapping_drift'
  | 'overlapping_drift'
  | 'overlapping_drift_budget_exhausted';

/**
 * ReviewDriftState — one row per ticket, alive for the duration of a single
 * Review episode (ticket 59efbde9).
 *
 * WHY THIS EXISTS
 * `review_workflow`'s old base-freshness gate bounced Review → In Progress on
 * ANY origin/main advance, whether or not it actually touched anything this
 * ticket's branch cares about — under concurrent merges from other tickets,
 * main can advance every few minutes, so a ticket could bounce indefinitely
 * on the same non-conflicting drift (observed 5x in ticket ec498050's
 * retrospective). `check_review_drift` (the MCP tool built on top of this
 * entity) classifies drift by path overlap instead of raw commit count, and
 * this row is what makes the classification episode-aware: `reverification_
 * count` survives a Review → In Progress → Review round-trip so the SAME
 * overlapping-drift reason can bounce the ticket at most once
 * (MAX_DRIFT_REVERIFICATIONS, see review-drift.ts) before the classifier
 * starts recommending `proceed_no_action` instead of another bounce.
 *
 * LIFECYCLE
 * Lazy-upserted on the FIRST `check_review_drift` call of a Review episode
 * (that call's git snapshot becomes `base_sha_at_entry` / `branch_tip_sha_
 * at_entry` / `changed_paths_at_entry`). Every subsequent call in the same
 * episode refreshes `last_checked_base_sha` / `last_classification` but
 * leaves the entry snapshot and `reverification_count` alone — the counter
 * is the one field that must survive a Review → In Progress bounce (ticket-
 * move.ts deliberately does NOT clear this row on that transition). The row
 * is deleted only when the episode actually ends: Review → Merging, or any
 * move into a terminal column (see ticket-move.ts's dest-kind-gated delete).
 *
 * STORAGE
 * TypeORM `synchronize` creates `review_drift_states` on every backend
 * (sqlite + Postgres) — `synchronize` is hardcoded ON in `db.ts` (D-01), so
 * no hand-written migration is needed (same precedent as the sibling
 * `stuck_alerts` / `dispatch_intents` tables). No FK cascade — a deleted
 * ticket is tolerated (the row simply becomes orphaned dead weight, same
 * posture as `StuckTicketAlert`).
 */
@Entity('review_drift_states')
export class ReviewDriftState {
  // Single-row-per-ticket, same shape as StuckTicketAlert — the id IS the
  // ticket id, no separate uuid surface needed.
  @PrimaryColumn({ type: 'varchar' })
  ticket_id: string;

  @Column({ type: 'varchar', default: '' })
  workspace_id: string;

  @Column({ type: 'varchar', default: '' })
  board_id: string;

  @Column({ type: 'varchar', default: '' })
  base_branch: string;

  // Entry-episode snapshot — set once on the first check_review_drift call of
  // this episode, never touched again until the row is deleted.
  @Column({ type: 'varchar', default: '' })
  base_sha_at_entry: string;

  @Column({ type: 'varchar', default: '' })
  branch_tip_sha_at_entry: string;

  // JSON string array — the feature branch's own changed paths vs base,
  // captured at entry. Diagnostic/audit snapshot only: Q1's overlap rules
  // (`pathsOverlap` in review-drift.ts) always compare against a FRESH
  // `branchPaths` re-probed on every call, never this stored value — a
  // branch that gains commits mid-review is still checked accurately. This
  // column exists so the entry state is inspectable without re-probing git.
  @Column({ type: 'text', default: '[]' })
  changed_paths_at_entry: string;

  // Refreshed on every check_review_drift call.
  @Column({ type: 'varchar', default: '' })
  last_checked_base_sha: string;

  @Column({ type: 'varchar', default: 'fresh' })
  last_classification: DriftClassification;

  // Survives a Review <-> In Progress round-trip (see class docstring) — the
  // one field ticket-move.ts's episode-end delete is designed to protect.
  @Column({ type: 'int', default: 0 })
  reverification_count: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
