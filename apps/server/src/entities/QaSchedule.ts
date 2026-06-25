import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * QaSchedule — an automatic trigger layer on top of the sequential QA batch
 * (ticket b6bb7efd, built on #daf06262). When a schedule comes due, the
 * background QaScheduleService kicks a QaRunBatch via QaRunService.startBatch —
 * exactly the same orchestrator the manual "전체/선택 순차 실행" buttons use, so
 * scheduling is purely the "when", not a second run path.
 *
 * Scope:
 *   - scope='all'      → at dispatch time, expand to every ENABLED scenario in
 *     scope (board_id <uuid> = that board, board_id null = the whole workspace).
 *     We deliberately store NO scenario id snapshot for 'all' so adding/removing
 *     a scenario is reflected automatically on the next run (the ticket's
 *     "id 스냅샷 말고 실행 시 resolve" requirement — handled by startBatch({all:true})).
 *   - scope='selected' → run exactly `scenario_ids`, in order.
 *
 * Cadence: exactly one of `cron` (5-field, UTC — see qa-cron.ts) or
 * `interval_ms`. `next_run_at` is the precomputed next firing instant the tick
 * compares against; `last_run_at`/`last_batch_id` record the most recent kick.
 *
 * JSON column (`scenario_ids`) is TypeORM `simple-json`, exactly like
 * QaRunBatch.scenario_ids / QaScenario.steps — it serializes/deserializes
 * automatically, so (unlike the Ticket JSON-string columns and their 5-touch
 * parseTicket wiring) there are no manual parse/stringify touch points. Reads
 * still coalesce null → [] in the JSON projection (scheduleToJson) so older rows
 * render cleanly. The equivalent of awb-field-wiring's 5 touch points here is:
 * (1) this column, (2) MCP create/update write, (3) REST create/update write,
 * (4) scheduleToJson read projection (shared by REST + MCP), (5) client type +
 * editor state — all wired, just without manual JSON.stringify/parse.
 */
@Entity('qa_schedules')
@Index(['workspace_id', 'enabled'])
export class QaSchedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // null = workspace-scoped schedule (scope='all' runs every enabled scenario in
  // the workspace); <uuid> = pinned to a board (scope='all' runs that board's
  // enabled scenarios).
  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  // 'all' = resolve enabled scenarios in scope at dispatch time.
  // 'selected' = run the explicit `scenario_ids` list.
  @Column({ type: 'varchar', default: 'all' })
  scope: QaScheduleScope;

  // Ordered scenario ids for scope='selected'. Ignored for scope='all'.
  @Column({ type: 'simple-json', nullable: true, default: null })
  scenario_ids: string[] | null;

  // Exactly one cadence is set. cron is a 5-field UTC expression (qa-cron.ts);
  // interval_ms is a fixed gap in milliseconds. The service rejects "both"/"neither".
  @Column({ type: 'varchar', nullable: true, default: null })
  cron: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  interval_ms: number | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // Passed straight through to the dispatched batch: halt on the first
  // non-passed run when true (default false → run all scenarios).
  @Column({ type: 'boolean', default: false })
  stop_on_fail: boolean;

  // Precomputed next firing instant the tick compares against. Recomputed after
  // every dispatch (and on enable/cadence change). null while disabled / unset.
  @Column({ type: Date, nullable: true, default: null })
  next_run_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_run_at: Date | null;

  // The most recent QaRunBatch this schedule kicked — the client can fetch it
  // (get_qa_batch) to show the last result rollup.
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

export type QaScheduleScope = 'all' | 'selected';
