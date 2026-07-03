import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * QaRun — one execution of a QaScenario.
 *
 * Mirrors `ActionRun` (scenario_id ↔ action_id, room_id is the dispatch
 * vehicle) and extends it with the QA result accumulation: a `status`
 * lifecycle, per-step `step_results`, the flat `artifact_resource_ids` list
 * (screenshots / videos / dumps stored as existing Resource rows), and a
 * `summary`. Re-running a scenario simply inserts another QaRun, so history is
 * preserved.
 */
@Entity('qa_runs')
@Index(['scenario_id', 'created_at'])
export class QaRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  scenario_id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  // pending → running → passed | failed | error | build_failed
  // `build_failed` is a first-class build death (ticket 80d52250): the build step
  // itself failed, distinct from a functional `failed` or an infra `error`. It is
  // terminal and, like failed/error, files an on-failure fix ticket (carrying the
  // build log). Set by report_build_failure, never self-reported as a pass.
  @Column({ type: 'varchar', default: 'pending' })
  status: QaRunStatus;

  // ChatRoom the QA agent runs in (existing chat dispatch infra).
  @Column({ type: 'varchar', default: '' })
  room_id: string;

  // Per-step results: { idx, status, log, artifact_resource_ids[] }.
  @Column({ type: 'simple-json', nullable: true, default: null })
  step_results: QaStepResult[] | null;

  // Flat accumulation of every artifact Resource id produced by this run.
  @Column({ type: 'simple-json', nullable: true, default: null })
  artifact_resource_ids: string[] | null;

  @Column({ type: 'text', default: '' })
  summary: string;

  // The repo HEAD SHA this run built/tested, reported by the agent at completion
  // via complete_qa_run (the server has no local clone to resolve it). On a PASS
  // this becomes the scenario's new last_built_commit, flipping cold_then_warm to
  // the warm branch for the NEXT run (decideRunFreshness). '' = not reported →
  // next run stays cold (safe). Mirrors SecurityRun.scanned_commit, whose PASS
  // advances SecurityProfile.last_passed_commit. (warm-build, ticket be2f998a)
  @Column({ type: 'varchar', default: '' })
  built_commit: string;

  @Column({ type: 'varchar', default: 'user' })
  triggered_by_type: string;

  @Column({ type: 'varchar', default: '' })
  triggered_by_id: string;

  // Set once when this run auto-files (or reuses, for per_open_ticket dedupe) a
  // fix ticket on failure — the run-level idempotency guard so a re-finalize of
  // the same run never double-files. null = no auto-ticket created for this run.
  @Column({ type: 'varchar', nullable: true, default: null })
  auto_ticket_id: string | null;

  // Rerun generation (ticket 467dbc7a). 0 = a first-time run (manual, seeded, or
  // the original failure run). When QaRerunOnFixService re-runs a scenario after
  // its fix ticket reaches Done, it stamps generation = (fix-ticket generation
  // + 1) here. If this run also fails, QaFailureTicketService carries the value
  // onto the new fix ticket as a `qa-rerun:<n>` label, so the next Done→rerun
  // edge reads it back and the QA↔fix loop converges at max_rerun_attempts.
  @Column({ type: 'int', default: 0 })
  rerun_generation: number;

  // Sequential-batch membership (QaRunBatch). null = standalone run. When set,
  // completeRun()/the reaper consult the batch to dispatch the NEXT scenario
  // once THIS run reaches a terminal status. `batch_index` is this run's slot
  // in the batch's ordered scenario_ids — the advance guard compares it against
  // the batch's current_index for idempotency (a re-finalized run won't match
  // once the batch has already moved on).
  @Column({ type: 'varchar', nullable: true, default: null })
  batch_id: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  batch_index: number | null;

  @Column({ type: Date, nullable: true, default: null })
  started_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  finished_at: Date | null;

  // ── Liveness heartbeat (board-pluggable reaper policy, ticket 40010b25) ──────
  // A run under the `heartbeat_deadline` liveness_policy must keep a monotonic
  // progress token advancing. `qa_run_heartbeat` ingestion records the latest
  // token here (high-water mark) and stamps `liveness_token_at` ONLY when the
  // token STRICTLY increases. The reaper measures staleness from
  // liveness_token_at — so a repeated/stale token (same value) does not extend
  // the deadline (false-immortal guard) while a strictly-advancing token keeps
  // resetting it (false-reap guard). Both null on legacy runs / runs that never
  // heartbeat — those fall back to started_at for the deadline baseline, and the
  // default `zero_progress` policy ignores these fields entirely (regression-safe).
  @Column({ type: 'float', nullable: true, default: null })
  liveness_token: number | null;

  @Column({ type: Date, nullable: true, default: null })
  liveness_token_at: Date | null;

  // ── Multi-phase QA model (ticket 90cc22f7) ───────────────────────────────────
  // A run can move through several phases (e.g. Unity import → build → run), each
  // with its own timeout. `current_phase` is the active phase id (matched against
  // the resolved qa_phases config — scenario ?? board, see resolveQaPhases). null =
  // legacy single-running run that never set a phase (regression-safe: the
  // phase_timeouts detector falls back to a sane default and the default
  // zero_progress / heartbeat_deadline policies ignore these fields entirely).
  // `current_phase_at` is the entry instant — the deadline baseline for the active
  // phase's timeout_sec (each setPhase resets it).
  @Column({ type: 'varchar', nullable: true, default: null })
  current_phase: string | null;

  @Column({ type: Date, nullable: true, default: null })
  current_phase_at: Date | null;

  // Ordered transition log for the RunDetail timeline — one entry per phase the
  // run entered. The latest entry's left_at is null while that phase is active;
  // setPhase stamps it when the next phase begins. null on legacy runs.
  @Column({ type: 'simple-json', nullable: true, default: null })
  phase_history: QaPhaseHistoryEntry[] | null;

  @CreateDateColumn()
  created_at: Date;
}

export type QaRunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error';

/** One phase-transition record for QaRun.phase_history (ISO timestamps). */
export interface QaPhaseHistoryEntry {
  phase: string;
  entered_at: string;
  // null while the phase is active; set to the next phase's entry instant on transition.
  left_at: string | null;
}

export interface QaStepResult {
  idx: number;
  status: 'pending' | 'passed' | 'failed' | 'skipped';
  log?: string;
  artifact_resource_ids?: string[];
}
