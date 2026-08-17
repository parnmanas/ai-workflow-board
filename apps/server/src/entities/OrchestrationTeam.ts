import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * A named roster of Agents that executes Missions together under one
 * orchestrator.
 *
 * `orchestrator_agent_id` is REQUIRED by the feature contract — a team with no
 * orchestrator cannot run a Mission, because the whole model is "one agent owns
 * the plan and delegates". The column is nullable at the DB level only so
 * TypeORM `synchronize` can add it to an existing SQLite/Postgres schema
 * without a hand-written migration (D-01, same posture as every other additive
 * column in this codebase); the service layer rejects an empty value on both
 * create and update, and `startMission` re-asserts it at dispatch time.
 *
 * Membership lives in the sibling `orchestration_team_members` table rather
 * than a JSON array column so a member row can carry its own capability blurb
 * and concurrency cap, and so an agent-scoped query ("which teams is this agent
 * on?") stays a plain indexed lookup.
 */
@Entity('orchestration_teams')
@Index('idx_orch_teams_workspace', ['workspace_id'])
export class OrchestrationTeam {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  /** Agent.id of the orchestrator. Enforced non-empty by the service layer. */
  @Column({ type: 'varchar', nullable: true, default: null })
  orchestrator_agent_id: string | null;

  /**
   * Extra standing instructions injected into every Mission's orchestrator
   * prompt for this team (house rules, review policy, tech constraints).
   * Free text; empty = nothing appended.
   */
  @Column({ type: 'text', default: '' })
  orchestrator_prompt: string;

  /**
   * Ceiling on steps dispatched concurrently across the whole Mission. Guards
   * a plan that fans out 20 independent steps from spawning 20 subagents at
   * once. Per-member ceilings are enforced separately via
   * OrchestrationTeamMember.max_concurrent.
   */
  @Column({ type: 'int', default: 3 })
  max_parallel_steps: number;

  /**
   * Ceiling on missions this team has open (non-terminal) at once, enforced
   * only on the agent-created path (`create_orchestration_mission` MCP tool —
   * ticket b7127aae). The human/REST path (`POST /api/orchestration/missions`)
   * does not check this; it substitutes for a per-mission budget gate that
   * agent-created missions don't otherwise have (OrchestrationMission has no
   * board_id/ticket to hang `hard_budget_config` off of).
   */
  @Column({ type: 'int', default: 1 })
  max_open_missions: number;

  /** 0 = disabled; a disabled team cannot start new Missions. */
  @Column({ type: 'int', default: 1 })
  enabled: number;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
