import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * SecuritySchedule — an automatic trigger layer on top of the sequential
 * security batch (SecurityRunBatch). Direct sibling of QaSchedule
 * (qa-schedule.ts), built on the same "scheduling is the WHEN, the batch is the
 * WHAT" split: when a schedule comes due, the background SecurityScheduleService
 * kicks a SecurityRunBatch via SecurityRunService.startBatch — exactly the same
 * orchestrator the manual "전체/선택 순차 실행" path uses, so scheduling is purely
 * the trigger, not a second run path.
 *
 * Scope:
 *   - scope='all'      → at dispatch time, expand to every ENABLED profile in
 *     scope (board_id <uuid> = that board, board_id null = the whole workspace).
 *     We deliberately store NO profile id snapshot for 'all' so adding/removing a
 *     profile is reflected automatically on the next run (the ticket's
 *     "id 스냅샷 말고 실행 시 resolve" requirement — handled by startBatch({all:true})).
 *   - scope='selected' → run exactly `profile_ids`, in order.
 *
 * Cadence: exactly one of `cron` (5-field, UTC — reuses qa-cron.ts) or
 * `interval_ms`. `next_run_at` is the precomputed next firing instant the tick
 * compares against; `last_run_at`/`last_batch_id` record the most recent kick.
 *
 * Deploy-timing footgun (the ticket's ⚠️): a scheduled run hits the RUNNING
 * (deployed) server, which auto-deploys from production.private only AFTER main
 * merges — so a schedule firing right after a fix-merge can inspect pre-deploy
 * code and report a false green. Two layers of mitigation: (1) every SecurityRun
 * records `scanned_commit` (the worktree HEAD the agent actually inspected), so
 * the inspected code is always reconstructable from the run — the schedule never
 * hides WHICH commit it checked; (2) operationally, set the cadence coarser than
 * your main→prod deploy lag (a fixed wall-clock cron hour, or a multi-minute
 * interval) so a scheduled run lands after the deploy. Documented on the editor +
 * docs/security-scheduler.md.
 *
 * JSON column (`profile_ids`) is TypeORM `simple-json`, exactly like
 * QaSchedule.scenario_ids — it serializes/deserializes automatically, so there
 * are no manual parse/stringify touch points. Reads still coalesce null → [] in
 * the JSON projection (scheduleToJson) so older rows render cleanly.
 */
@Entity('security_schedules')
@Index(['workspace_id', 'enabled'])
export class SecuritySchedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // null = workspace-scoped schedule (scope='all' runs every enabled profile in
  // the workspace); <uuid> = pinned to a board (scope='all' runs that board's
  // enabled profiles).
  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  // 'all' = resolve enabled profiles in scope at dispatch time.
  // 'selected' = run the explicit `profile_ids` list.
  @Column({ type: 'varchar', default: 'all' })
  scope: SecurityScheduleScope;

  // Ordered profile ids for scope='selected'. Ignored for scope='all'.
  @Column({ type: 'simple-json', nullable: true, default: null })
  profile_ids: string[] | null;

  // Exactly one cadence is set. cron is a 5-field UTC expression (qa-cron.ts);
  // interval_ms is a fixed gap in milliseconds. The service rejects "both"/"neither".
  @Column({ type: 'varchar', nullable: true, default: null })
  cron: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  interval_ms: number | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // Passed straight through to the dispatched batch: halt on the first
  // non-passed run when true (default false → run all profiles).
  @Column({ type: 'boolean', default: false })
  stop_on_fail: boolean;

  // Precomputed next firing instant the tick compares against. Recomputed after
  // every dispatch (and on enable/cadence change). null while disabled / unset.
  @Column({ type: Date, nullable: true, default: null })
  next_run_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_run_at: Date | null;

  // The most recent SecurityRunBatch this schedule kicked — the client can fetch
  // it (get_security_batch) to show the last result rollup.
  @Column({ type: 'varchar', nullable: true, default: null })
  last_batch_id: string | null;

  @Column({ type: 'varchar', default: 'user' })
  triggered_by_type: string;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

export type SecurityScheduleScope = 'all' | 'selected';
