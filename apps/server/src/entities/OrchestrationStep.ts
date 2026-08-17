import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * One delegated unit of a Mission's plan — a node in the plan DAG.
 *
 * Dependencies are stored as `depends_on`, an array of sibling `step_key`
 * values (NOT ids): the orchestrator authors the plan as a single JSON
 * document in one tool call, so it can only reference steps by a name it
 * chose itself. Keys are unique per mission and validated (existence +
 * acyclicity) at plan-submission time, so the runner can resolve them by
 * plain lookup afterwards.
 *
 * Status machine:
 *   pending → ready → dispatched → running → (done | failed | blocked)
 *   pending/ready → blocked      (a dependency failed or was cancelled)
 *   any non-terminal → skipped | cancelled
 *
 *   pending    — created, dependencies not yet satisfied.
 *   ready      — dependencies satisfied, waiting for a parallelism slot.
 *   dispatched — the step prompt was posted to the member's room.
 *   running    — the member reported progress at least once.
 *   done       — member reported success.
 *   failed     — member reported failure, or the reaper timed it out.
 *   blocked    — member reported it cannot proceed, or an upstream step failed.
 *   skipped    — the orchestrator decided it is unnecessary.
 *   cancelled  — the mission was cancelled while this step was open.
 *
 * `dispatched` and `running` are BOTH "in flight" for parallelism accounting —
 * the split exists only so the UI can distinguish "prompt sent, subagent may
 * still be spawning" from "the member has actually spoken".
 */
@Entity('orchestration_steps')
@Index('idx_orch_steps_mission', ['mission_id'])
@Index('idx_orch_steps_assignee', ['assignee_agent_id'])
@Index('idx_orch_steps_status', ['status'])
export class OrchestrationStep {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  mission_id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  team_id: string;

  /** Orchestrator-chosen slug, unique within the mission. Used by `depends_on`. */
  @Column({ type: 'varchar' })
  step_key: string;

  @Column({ type: 'varchar' })
  title: string;

  /** The actual work order handed to the member agent. */
  @Column({ type: 'text', default: '' })
  instructions: string;

  /** Definition of done for THIS step. Optional; inherited context otherwise. */
  @Column({ type: 'text', default: '' })
  acceptance_criteria: string;

  /** Sibling step_keys that must reach `done` (or `skipped`) first. */
  @Column({ type: 'simple-json', nullable: true, default: null })
  depends_on: string[] | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  assignee_agent_id: string | null;

  @Column({ type: 'varchar', default: 'pending' })
  status: string;

  /** Ordering within the plan; also the tie-break for dispatch. */
  @Column({ type: 'int', default: 0 })
  position: number;

  /** Plan version this step was authored in — lets the UI mark re-planned steps. */
  @Column({ type: 'int', default: 1 })
  plan_version: number;

  /** ChatRoom hosting this step's dispatch to the member agent. */
  @Column({ type: 'varchar', nullable: true, default: null })
  room_id: string | null;

  /** Member's closing report. Fed to downstream steps as dependency context. */
  @Column({ type: 'text', default: '' })
  result_summary: string;

  /**
   * Structured artifacts the member produced: PR urls, ticket ids, file paths,
   * resource ids. `[{ kind, ref, label }]`. Rendered as links in the UI and as
   * context lines in dependent steps' prompts.
   */
  @Column({ type: 'simple-json', nullable: true, default: null })
  artifacts: Array<{ kind: string; ref: string; label: string }> | null;

  /** Dispatch count. Incremented on every (re)dispatch, including retries. */
  @Column({ type: 'int', default: 0 })
  attempt: number;

  @Column({ type: 'int', default: 2 })
  max_attempts: number;

  @Column({ type: Date, nullable: true, default: null })
  dispatched_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  started_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  finished_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
