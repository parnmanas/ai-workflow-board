import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { CheckoutMode, WorkspaceFolderRepoRef } from '../common/workspace-folder-options';
import { MissionCompletionCriterion, MissionPostAction } from '../modules/orchestration/orchestration.constants';

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
@Index('idx_orch_missions_post_actions_pending', ['post_actions_pending'])
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

  /**
   * 팀이 목표에 접근하는 방식 — 제약, 타협 불가 사항, 선호하는 접근법.
   * `objective`(무엇을)나 `context`(배경)와는 별개다: 자유 텍스트로 orchestrator의
   * 브리핑에 렌더링될 뿐 프로그램적으로 검증되지 않는다(`acceptance_criteria`의
   * 기존 prose 방식을 그대로 따름 — 티켓 2dc3c62f "실행 계약"의 method 필드).
   */
  @Column({ type: 'text', default: '' })
  method: string;

  /**
   * 구조화된 완료 체크리스트(티켓 2dc3c62f) — `acceptance_criteria`는 자유
   * prose로 그대로 두고, 이건 그 위에 얹는 선택적 프로그램적 게이트다.
   * `[]`/null = 게이트 없음(기존 Mission 전부 이 상태) — `completeMission()`은
   * 모든 항목이 `met:true`일 때만 `status:'completed'`를 허용한다.
   * orchestration.constants.ts의 `MissionCompletionCriterion` / `allCriteriaMet`
   * 참고. 구조(어떤 criteria가 있는지)는 `acceptance_criteria`와 동일하게
   * brief-locked이고, `met`/`note`는 런타임에 `update_orchestration_criteria`
   * MCP 툴로 바뀐다.
   */
  @Column({ type: 'simple-json', nullable: true, default: null })
  completion_criteria: MissionCompletionCriterion[] | null;

  /**
   * 완료 후 순서가 있는 Action 디스패치 목록(티켓 2dc3c62f). 각 항목은 Action
   * 하나와 조건('always'/'on_success'/'on_failure')을 지정하며, runner가
   * `completeMission`이 미션을 확정한 직후 이 조건을 최종 상태와 대조해
   * 평가한다. `on-ticket-done-action.service.ts`와 동일하게 fire-and-forget이다:
   * 디스패치 실패는 기록되고 루프는 계속되며, 그 ActionRun의 최종 결과는
   * 미션에 다시 추적되지 않고(`MissionPostAction.status` 문서 참고)
   * `mission.status`도 절대 바꾸지 않는다.
   */
  @Column({ type: 'simple-json', nullable: true, default: null })
  post_actions: MissionPostAction[] | null;

  /**
   * `post_actions` 안에 아직 확정되지 않은(`pending`/`in_flight`) 항목이
   * 있는지를 나타내는 색인 가능한 플래그(리뷰 지적 반영, 티켓 2dc3c62f) —
   * post_actions 자체는 simple-json이라 SQL WHERE로 내용을 거를 수 없다.
   * `runPostActions()`가 매 저장마다 이 값을 재계산해 항상 실제 배열
   * 내용과 일치시키고, `OrchestrationReaperService.reapPendingPostActions`가
   * `finished_at DESC take:N` 같은 최신순 창 대신 이 컬럼으로 직접 질의해서
   * — 오래된 terminal Mission이 최근 Mission들에 밀려 영영 복구 대상에서
   * 빠지는 기아(starvation) 없이 — 미확정 항목이 있는 Mission만 정확히
   * 찾아낸다.
   */
  @Column({ type: 'boolean', default: false })
  post_actions_pending: boolean;

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

  // ── Agent 작업공간(ticket 2dc3c62f) ────────────────────────────────────────
  // QaScenario/Action/SecurityProfile과 동일한 필드 구성 + 정규화 방식이다
  // (common/workspace-folder-options.ts 참고). 이 mission 값은 루트이고, 각
  // 디스패치된 step은 그 아래 `<root>/<step_key>`로 격리된다
  // (orchestration-runner.service.ts의 dispatchStep 참고) — 동시 진행 중인
  // step끼리 폴더를 공유하는 일이 없다.

  /** `.awb/orch/` 아래의 working_dir-relative 루트(worktree 규약 ③). '' = 미설정
   *  → 결정론적 기본값 `.awb/orch/<mission8>`(resolveWorkspaceFolder). */
  @Column({ type: 'varchar', default: '' })
  workspace_folder: string;

  /** 모든 step이 체크아웃할 repo. null = board/workspace environment_config repo 재사용. */
  @Column({ type: 'simple-json', nullable: true, default: null })
  repo_ref: WorkspaceFolderRepoRef | null;

  /** 각 step의 작업폴더를 준비하는 방식. 'fresh'는 매 디스패치마다 폴더를 비우고 재체크아웃한다. */
  @Column({ type: 'varchar', default: 'reuse' })
  checkout_mode: CheckoutMode;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
