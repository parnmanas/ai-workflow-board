import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * A unit of work handed to an OrchestrationTeam.
 *
 * A Mission is deliberately NOT a board Ticket: a ticket's lifecycle is driven
 * by column moves and role routing, while a Mission's lifecycle is driven by a
 * plan the orchestrator authors at runtime. Sharing the Ticket entity would
 * have forced the plan/step DAG into columns and the two models fight each
 * other (a step is not "in a column", and a plan is re-authored mid-flight).
 *
 * Status machine:
 *   draft → planning → running → (completed | failed)
 *   any non-terminal → paused → running   (operator pause/resume)
 *   any non-terminal → cancelled          (operator)
 *
 *   draft     — created, never dispatched.
 *   planning  — the mission prompt was posted to the orchestrator's room and we
 *               are waiting for `submit_orchestration_plan`.
 *   running   — a plan exists; the engine dispatches ready steps and wakes the
 *               orchestrator on failures / wave boundaries.
 *   paused    — operator hold; the engine dispatches nothing. In-flight steps
 *               are NOT killed (their subagents are already running); their
 *               results are recorded but no new step goes out until resume.
 *   completed / failed / cancelled — terminal.
 *
 * `orchestrator_agent_id` is snapshotted from the team at start so editing the
 * team mid-mission never re-points a live mission at a different agent.
 */
@Entity('orchestration_missions')
@Index('idx_orch_missions_workspace', ['workspace_id'])
@Index('idx_orch_missions_team', ['team_id'])
@Index('idx_orch_missions_status', ['status'])
export class OrchestrationMission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  team_id: string;

  @Column({ type: 'varchar' })
  title: string;

  /** What the team must achieve. Rendered as the core of the orchestrator prompt. */
  @Column({ type: 'text', default: '' })
  objective: string;

  /** Background / links / prior art. Optional. */
  @Column({ type: 'text', default: '' })
  context: string;

  /** Definition of done. The orchestrator is told to verify these before completing. */
  @Column({ type: 'text', default: '' })
  acceptance_criteria: string;

  @Column({ type: 'varchar', default: 'draft' })
  status: string;

  /** Snapshot of team.orchestrator_agent_id taken at start. */
  @Column({ type: 'varchar', nullable: true, default: null })
  orchestrator_agent_id: string | null;

  /** ChatRoom hosting the orchestrator conversation for this mission. */
  @Column({ type: 'varchar', nullable: true, default: null })
  room_id: string | null;

  /** Orchestrator's own prose summary of the current plan (latest submission). */
  @Column({ type: 'text', default: '' })
  plan_summary: string;

  /** Increments on every accepted plan submission; 1 = the initial plan. */
  @Column({ type: 'int', default: 0 })
  plan_version: number;

  /** Final report written by `complete_orchestration_mission`. */
  @Column({ type: 'text', default: '' })
  result_summary: string;

  /**
   * Why the mission ended the way it did when it did NOT end through the
   * orchestrator (reaper timeout, operator cancel, dispatch failure). Empty for
   * a clean orchestrator-driven finish.
   */
  @Column({ type: 'text', default: '' })
  failure_reason: string;

  /** Snapshot of team.max_parallel_steps at start; editable per mission. */
  @Column({ type: 'int', default: 3 })
  max_parallel_steps: number;

  /** Hard ceiling on total steps across all plan versions — runaway-plan guard. */
  @Column({ type: 'int', default: 60 })
  max_steps: number;

  /** Hard ceiling on accepted plan submissions — replan-loop guard. */
  @Column({ type: 'int', default: 6 })
  max_plan_versions: number;

  /**
   * Minutes a step may stay in flight before the reaper fails it and wakes the
   * orchestrator. 0 = no timeout (operator opt-out).
   */
  @Column({ type: 'int', default: 90 })
  step_timeout_minutes: number;

  @Column({ type: 'varchar', default: 'user' })
  created_by_type: string;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @Column({ type: Date, nullable: true, default: null })
  started_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  finished_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
