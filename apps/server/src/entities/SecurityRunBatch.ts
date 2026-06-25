import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * SecurityRunBatch — a manual sequential run of several SecurityProfiles
 * ("수동 전체 점검"). Direct sibling of QaRunBatch (qa-run-batch.ts): a profile
 * id list driven one-at-a-time by a cursor.
 *
 * The whole reason this entity exists: a SecurityRun is dispatched async
 * (startRun posts a prompt and returns immediately; the run only reaches a
 * terminal status much later when the inspection agent calls
 * complete_security_run, or the reaper errors it after the TTL). So "run
 * profiles in order" can NOT be a for-loop over startRun — that fires them all
 * at once, defeating the "동시 금지" requirement. Instead a batch dispatches ONLY
 * the current index, and the next index is dispatched from
 * onRunFinalized() (completeRun / reaper) when the current run finalizes. This
 * row is the cursor that drives that one-at-a-time advance.
 *
 * `profile_ids` / `run_ids` are TypeORM `simple-json`, exactly like
 * QaRunBatch.scenario_ids / SecurityProfile.checklist — a fresh entity
 * serializes/deserializes automatically, so (unlike the Ticket JSON-string
 * columns) there are no manual parse/stringify touch points to wire.
 * `run_ids[i]` is the SecurityRun dispatched for `profile_ids[i]` (empty until
 * that index is reached; '' marks an index whose dispatch was skipped because
 * the profile was deleted/disabled mid-batch).
 */
@Entity('security_run_batches')
@Index(['workspace_id', 'created_at'])
export class SecurityRunBatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  // Ordered profile ids to run, one after another.
  @Column({ type: 'simple-json', nullable: true, default: null })
  profile_ids: string[] | null;

  // run_ids[i] = the SecurityRun dispatched for profile_ids[i]. Grows as the
  // batch advances; '' marks an index whose dispatch was skipped.
  @Column({ type: 'simple-json', nullable: true, default: null })
  run_ids: string[] | null;

  // Index of the profile currently dispatched (and awaiting finalize). Once the
  // batch is done/aborted this equals the index of the last run it touched.
  @Column({ type: 'int', default: 0 })
  current_index: number;

  // running → done | aborted. `aborted` only happens with stop_on_fail when a
  // run finalizes non-passed; otherwise a batch always walks to `done`.
  @Column({ type: 'varchar', default: 'running' })
  status: SecurityRunBatchStatus;

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

export type SecurityRunBatchStatus = 'running' | 'done' | 'aborted';
