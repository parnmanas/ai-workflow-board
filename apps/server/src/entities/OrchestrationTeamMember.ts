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

  /**
   * 가입 시점 팀 자신의 workspace_id 스냅샷 — 정보용일 뿐, 이 모듈의 어떤 쿼리도 이
   * 값으로 member를 필터링하지 않는다(실제 스코핑은 전부 team_id/agent_id/id가 담당).
   * OrchestrationTeam.workspace_id와 동일하게 nullable(티켓 1b62b437) — 글로벌 팀의
   * member는 null이며, 글로벌 팀은 구조상 글로벌(workspace 비종속) 에이전트만 member로
   * 가진다.
   */
  @Column({ type: 'varchar', nullable: true, default: null })
  workspace_id: string | null;

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
