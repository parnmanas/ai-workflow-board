import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * QaRunBatch — a manual sequential run of several QaScenarios.
 *
 * The whole reason this entity exists: a QaRun is dispatched async (startQaRun
 * posts a prompt and returns immediately; the run only reaches a terminal
 * status much later when the QA agent calls complete_qa_run, or the reaper
 * errors it after 6h). So "run scenarios in order" can NOT be a for-loop over
 * startQaRun — that fires them all at once. Instead a batch dispatches ONLY the
 * current index, and the next index is dispatched from completeRun()/the reaper
 * when the current run finalizes. This row is the cursor that drives that
 * one-at-a-time advance.
 *
 * `scenario_ids` / `run_ids` are TypeORM `simple-json`, exactly like
 * QaScenario.steps — a fresh entity serializes/deserializes automatically, so
 * (unlike the Ticket JSON-string columns) there are no manual parse/stringify
 * touch points to wire. `run_ids[i]` is the QaRun dispatched for
 * `scenario_ids[i]` (empty until that index is reached).
 */
@Entity('qa_run_batches')
@Index(['workspace_id', 'created_at'])
export class QaRunBatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  // Ordered scenario ids to run, one after another.
  @Column({ type: 'simple-json', nullable: true, default: null })
  scenario_ids: string[] | null;

  // run_ids[i] = the QaRun dispatched for scenario_ids[i]. Grows as the batch
  // advances; '' marks an index whose dispatch was skipped (e.g. the scenario
  // was deleted/disabled mid-batch).
  @Column({ type: 'simple-json', nullable: true, default: null })
  run_ids: string[] | null;

  // Index of the scenario currently dispatched (and awaiting finalize). Once
  // the batch is done/aborted this equals the index of the last run it touched.
  @Column({ type: 'int', default: 0 })
  current_index: number;

  // running → done | aborted. `aborted` only happens with stop_on_fail when a
  // run finalizes non-passed; otherwise a batch always walks to `done`.
  @Column({ type: 'varchar', default: 'running' })
  status: QaRunBatchStatus;

  // When true, the first non-passed (failed/error) run halts the batch
  // (status=aborted). Default false → keep going through failures.
  @Column({ type: 'boolean', default: false })
  stop_on_fail: boolean;

  // Result rollup over finalized runs in this batch.
  @Column({ type: 'int', default: 0 })
  passed: number;

  @Column({ type: 'int', default: 0 })
  failed: number;

  @Column({ type: 'int', default: 0 })
  errored: number;

  @Column({ type: 'varchar', default: 'user' })
  triggered_by_type: string;

  @Column({ type: 'varchar', default: '' })
  triggered_by_id: string;

  @Column({ type: Date, nullable: true, default: null })
  finished_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

export type QaRunBatchStatus = 'running' | 'done' | 'aborted';
