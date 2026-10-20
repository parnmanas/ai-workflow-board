import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * A named, reusable roster that executes Missions together under one
 * orchestrator.
 *
 * An orchestrator slot (`orchestrator_spec`) is REQUIRED by the feature
 * contract — a team with no orchestrator cannot run a Mission, because the
 * whole model is "one agent owns the plan and delegates". The service layer
 * rejects a missing spec on create and update, and `startMission` re-asserts it.
 *
 * A team says WHO works (Runtime Host + CLI + model per slot), never WHERE:
 * the same team runs missions on different repositories, so the folder comes
 * from each mission's projects (OrchestrationMission.projects).
 *
 * Membership lives in the sibling `orchestration_team_members` table rather
 * than a JSON array column so a member row can carry its own capability blurb
 * and concurrency cap.
 *
 * `account_id`는 nullable이다(티켓 1b62b437): null = 글로벌 팀 — 모든 account에서
 * 보이고 로스터는 글로벌 에이전트로만 제한된다. 이는 로스터 축에만 해당하는 변경이다 —
 * 이 팀이 실행하는 Mission은 여전히 account에 종속되므로(OrchestrationMission.account_id는
 * 그대로 필수) 글로벌 팀의 budget/room 격리는 account 종속 팀과 동일하게 강하다.
 */
@Entity('orchestration_teams')
@Index('idx_orch_teams_account', ['account_id'])
export class OrchestrationTeam {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Nullable — Agent.account_id와 동일한 posture(티켓 1b62b437). null이면 글로벌 팀이며
   * 로스터에는 글로벌 에이전트만 들어갈 수 있다(OrchestrationTeamService.requireAccountAgent가
   * 강제). Mission.account_id는 그대로 필수다 — Team은 로스터 축, Mission은 실행·거버넌스
   * 스코프 축이고, account 비종속이 될 수 있는 건 전자뿐이다.
   */
  @Column({ type: 'varchar', nullable: true, default: null })
  account_id: string | null;

  /**
   * 이 팀을 생성한 account. account 종속 팀에도 항상 찍힌다(그 경우엔 이미
   * `account_id`가 권위 있는 스코프라 무해함). 글로벌 팀에게는 "MANAGE_ACTIONS을 가진
   * 아무 account나 공유 로스터를 편집할 수 있다"와 "만든 account만 편집할 수 있다"를
   * 가르는 유일한 값이다 — OrchestrationTeamService.assertTeamWritable 참고. 읽기(getTeam/
   * listTeams)는 이 값으로 게이팅되지 않는다 — 로스터/설정 쓰기만 게이팅된다.
   */
  @Column({ type: 'varchar', nullable: true, default: null })
  owner_account_id: string | null;

  /**
   * 글로벌 팀의 오케스트레이터가 create_orchestration_mission으로 지정할 수 있는
   * account 목록(미션의 run-budget/room이 귀속될 account). account 종속 팀에서는
   * 무시된다. 글로벌 팀에서 비어있거나 null이면 의도적인 deny-by-default다 — 사람이
   * account를 명시적으로 opt-in 시켜야 한다. orchestration-tools.ts의
   * create_orchestration_mission 참고.
   */
  @Column({ type: 'simple-json', nullable: true, default: null })
  allowed_account_ids: string[] | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  /**
   * Legacy: the orchestrator's runtime identity key from when slots declared
   * their own folder. The orchestrator now gets an identity per mission (its
   * slot in that mission's project folder — `OrchestrationMission.orchestrator_agent_id`),
   * so new teams leave this null. Old values stay so an identity recorded on
   * old missions still maps back to this team.
   */
  @Column({ type: 'varchar', nullable: true, default: null })
  orchestrator_agent_id: string | null;

  /**
   * The orchestrator's slot — same `TeamSlotSpec` shape as
   * `OrchestrationTeamMember.spec` (Runtime Host + CLI + model + credential,
   * no folder), so both slots are authored by one form and validated by one
   * function. Missions place it in their primary project's folder on its host.
   */
  @Column({ type: 'simple-json', nullable: true, default: null })
  orchestrator_spec: Record<string, any> | null;

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
   * 이 팀이 account 당 동시에 열어둘 수 있는(non-terminal) 미션 수 상한(티켓 1b62b437 —
   * 글로벌 팀이 생기기 전에는 팀 당 상한이었다; account 종속 팀은 account가 하나뿐이라
   * 두 개념이 같은 숫자다). agent-created 경로(`create_orchestration_mission` MCP 툴 —
   * 티켓 b7127aae)에서만 강제된다. human/REST 경로(`POST /api/orchestration/missions`)는
   * 이를 검사하지 않는다 — agent-created 미션에는 따로 없는 미션 단위 예산 게이트를
   * 대신하는 값이다(OrchestrationMission에는 `hard_budget_config`를 걸 board_id/ticket이
   * 없음). 따라서 N개 account에 허용된 글로벌 팀은 최대 `max_open_missions * N`개까지
   * 동시에 열 수 있다 — 허용된 account마다 독립된 슬롯이지, 공유 슬롯이 아니다.
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
