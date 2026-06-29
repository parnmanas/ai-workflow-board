import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * WorkspaceSchedule — a general-purpose "do this task at this time" trigger for a
 * single agent (ticket 8845be79). Born from the floating `Ralf-QaRelay` Windows
 * Scheduled Task an agent had registered via host MCP: that need belongs INSIDE
 * AWB, so this generalizes the proven QA/Security scheduler template
 * (QaSchedule b6bb7efd / SecuritySchedule 7c07c19d) into a content-agnostic one.
 *
 * What it does: when a schedule comes due, the background WorkspaceScheduleService
 * opens a FRESH chat room each run, drops the `target_agent_id` in, and sends
 * `task_prompt` as the opening message — exactly the QA/Security RUN dispatch
 * shape (qa-run.service.ts:198-245: create room → add agent + synthetic 'system'
 * user → sendMessage). The scheduler owns only the "when"; the actual work runs
 * through the existing chat → agent-manager spawn path (no second dispatch route).
 *
 * Confirmed product decisions (2026-06-29):
 *   1. ONE target per schedule — a single `target_agent_id` + a single free-text
 *      `task_prompt`. No multi-target / task-list fan-out.
 *   2. NEW ROOM PER RUN — every tick creates a new chat room (`last_room_id`
 *      records the most recent one). No reused per-schedule room.
 *
 * Cadence: exactly one of `cron` (5-field UTC — see modules/qa/qa-cron.ts, reused)
 * or `interval_ms`. `next_run_at` is the precomputed next firing instant the tick
 * compares against; `last_run_at`/`last_room_id` record the most recent dispatch.
 *
 * Idempotency: `next_run_at` is advanced + persisted BEFORE the (async) dispatch,
 * so a re-entrant/overlapping tick sees the cursor already past `now` and no-ops
 * — the same ordering QaScheduleService uses. Unlike QA/Security there is no
 * batch/run lifecycle to poll, so there is no SKIP-if-running guard: a scheduled
 * task is fire-and-forget; the pre-advance is the sole duplicate-dispatch guarantee.
 *
 * Column types follow QaSchedule for SQLite/Postgres dual compat (varchar / int /
 * Date / boolean / text). No JSON-array columns here, so none of the
 * awb-field-wiring manual parse/stringify touch points apply.
 */
@Entity('workspace_schedules')
@Index(['workspace_id', 'enabled'])
export class WorkspaceSchedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // null = workspace-scoped (no board context); <uuid> = pinned to a board so the
  // dispatched task carries that board's context. Does not affect WHEN it fires.
  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  // The single agent this schedule dispatches the task to.
  @Column({ type: 'varchar' })
  target_agent_id: string;

  // The free-text task message sent to the agent when the schedule fires. `text`
  // (not varchar) so long multi-line prompts are not truncated on either DB.
  @Column({ type: 'text', default: '' })
  task_prompt: string;

  // Exactly one cadence is set. cron is a 5-field UTC expression (qa-cron.ts);
  // interval_ms is a fixed gap in milliseconds. The service rejects "both"/"neither".
  @Column({ type: 'varchar', nullable: true, default: null })
  cron: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  interval_ms: number | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // Precomputed next firing instant the tick compares against. Recomputed after
  // every dispatch (and on enable/cadence change). null while disabled / unset.
  @Column({ type: Date, nullable: true, default: null })
  next_run_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_run_at: Date | null;

  // The most recent chat room this schedule opened — the client can deep-link to
  // it to see the last dispatched conversation.
  @Column({ type: 'varchar', nullable: true, default: null })
  last_room_id: string | null;

  @Column({ type: 'varchar', default: 'user' })
  triggered_by_type: string;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
