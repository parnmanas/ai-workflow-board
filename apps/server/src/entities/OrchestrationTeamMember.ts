import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * One slot on an OrchestrationTeam's roster. The row `id` is the slot's
 * address: missions assign steps to it (`OrchestrationStep.assignee_slot`).
 *
 * `capabilities` is the single most load-bearing field of the whole feature:
 * it is rendered verbatim into the orchestrator's planning prompt as the
 * roster blurb, so it is what the orchestrator actually reasons over when it
 * decides who gets which step. An empty blurb still works (the orchestrator
 * falls back to the slot name + role_label) but produces markedly worse
 * assignments, so the UI nudges for it.
 *
 * The orchestrator itself is NOT required to have a member row — it is the
 * team's `orchestrator_spec`. A team MAY still put it on the roster (a member
 * row with the same spec) if the operator wants the orchestrator to also
 * execute steps.
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
   * 가입 시점 팀 자신의 account_id 스냅샷 — 정보용일 뿐, 이 모듈의 어떤 쿼리도 이
   * 값으로 member를 필터링하지 않는다(실제 스코핑은 전부 team_id/agent_id/id가 담당).
   * OrchestrationTeam.account_id와 동일하게 nullable(티켓 1b62b437) — 글로벌 팀의
   * member는 null이며, 글로벌 팀은 구조상 글로벌(account 비종속) 에이전트만 member로
   * 가진다.
   */
  @Column({ type: 'varchar', nullable: true, default: null })
  account_id: string | null;

  /**
   * Legacy: the runtime identity key this slot had while slots declared their
   * own working folder. A slot is no longer an identity on its own — it gets one
   * per project folder of each mission (orchestration-roster.ts) — so new rows
   * leave this null. Kept for rows written before the change, so an execution
   * identity recorded on old missions still maps back to its slot.
   */
  @Column({ type: 'varchar', nullable: true, default: null })
  agent_id: string | null;

  /**
   * How this slot runs: Runtime Host + CLI + model + credential + backend +
   * execution config (`TeamSlotSpec`, common/orchestration-member-spec.ts). No
   * folder: a mission decides where (its projects' folders on this host).
   *
   * Nullable because rows written before the spec-based roster carry null; such
   * a slot is left out of a mission's roster. Rows written while slots declared a
   * folder still hold `working_dir` / `folder_scope` keys — `parseTeamSlotSpec`
   * ignores them and the next save drops them.
   */
  @Column({ type: 'simple-json', nullable: true, default: null })
  spec: Record<string, any> | null;

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
