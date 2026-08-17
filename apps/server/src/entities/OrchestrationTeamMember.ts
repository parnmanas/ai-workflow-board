import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * One Agent's membership in an OrchestrationTeam.
 *
 * `capabilities` is the single most load-bearing field of the whole feature:
 * it is rendered verbatim into the orchestrator's planning prompt as the
 * roster blurb, so it is what the orchestrator actually reasons over when it
 * decides who gets which step. An empty blurb still works (the orchestrator
 * falls back to the agent name + role_label) but produces markedly worse
 * assignments, so the UI nudges for it.
 *
 * The orchestrator agent itself is NOT required to have a member row — it is
 * addressed through OrchestrationTeam.orchestrator_agent_id. A team MAY still
 * add it as a member if the operator wants the orchestrator to also execute
 * steps; nothing forbids it, and `assign_orchestration_step` accepts any agent
 * with a member row.
 */
@Entity('orchestration_team_members')
@Index('idx_orch_members_team', ['team_id'])
@Index('idx_orch_members_agent', ['agent_id'])
export class OrchestrationTeamMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  team_id: string;

  /** Denormalized from the team so member queries stay workspace-scoped without a join. */
  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  agent_id: string;

  /** Short human/orchestrator-facing role label: 'backend', 'reviewer', 'researcher'. */
  @Column({ type: 'varchar', default: '' })
  role_label: string;

  /** Free-text capability description rendered into the orchestrator's roster block. */
  @Column({ type: 'text', default: '' })
  capabilities: string;

  /** Max steps this member may have in flight at once. */
  @Column({ type: 'int', default: 1 })
  max_concurrent: number;

  /** Display/tie-break order within the roster. */
  @Column({ type: 'int', default: 0 })
  position: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
