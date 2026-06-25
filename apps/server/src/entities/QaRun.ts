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

  // pending → running → passed | failed | error
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

  @CreateDateColumn()
  created_at: Date;
}

export type QaRunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error';

export interface QaStepResult {
  idx: number;
  status: 'pending' | 'passed' | 'failed' | 'skipped';
  log?: string;
  artifact_resource_ids?: string[];
}
