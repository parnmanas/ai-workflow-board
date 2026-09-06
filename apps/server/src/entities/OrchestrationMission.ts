import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { CheckoutMode, WorkspaceFolderRepoRef } from '../common/workspace-folder-options';
import { MissionCompletionCriterion, MissionPostAction } from '../modules/orchestration/orchestration.constants';
import { GraphSpec } from '../modules/orchestration/orchestration-graph';

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

  // ── 실행 그래프(티켓 1ca9e49b) ─────────────────────────────────────────────

  /**
   * Graph 모드 feature flag. false(기본)면 `submit_orchestration_plan`은 `graph`
   * 입력을 거부하고 미션은 기존 wave/DAG 경로 그대로 동작한다 — 즉 기존 미션의
   * 동작은 이 티켓 이후에도 한 글자도 바뀌지 않는다. 미션 단위 플래그로 둔 이유:
   * 전역 env 스위치는 이미 진행 중인 미션까지 한꺼번에 의미를 바꿔버리는데,
   * 그래프 기능은 미션이 **시작될 때** 어떤 계약으로 계획됐는지에 종속적이다.
   */
  @Column({ type: 'boolean', default: false })
  graph_enabled: boolean;

  /**
   * 확정된 실행 그래프. null = 아직 그래프가 제출되지 않음(legacy wave 경로).
   * `orchestration-graph.ts`의 `validateGraphSpec`을 통과한 정규화된 값만 저장된다.
   * plan과 같은 이유로 simple-json이다 — 스케줄러는 어차피 미션 전체를 한 번에
   * 읽으므로 edge를 따로 질의할 필요가 없고, `completion_criteria`/`post_actions`가
   * 이미 확립한 패턴을 따른다.
   */
  @Column({ type: 'simple-json', nullable: true, default: null })
  graph_spec: GraphSpec | null;

  /**
   * 이 미션에서 지금까지 디스패치된 node 실행 횟수의 총합(global budget 소진량).
   * `graph_spec.max_total_visits`와 대조되며, 초과하면 loop 재진입이 거부되고
   * orchestrator가 깨어난다. 재시도(attempt)도 실행이므로 함께 센다 — 예산의
   * 목적은 "이 미션이 subagent를 몇 번이나 더 띄울 수 있는가"이기 때문이다.
   */
  @Column({ type: 'int', default: 0 })
  total_visits: number;

  /**
   * 그래프가 부분 수정(patch)된 횟수 — 0 = 확정 이후 한 번도 patch 되지 않음(티켓 2fc8f99a).
   *
   * `GraphSpec.version`(스키마 버전)과 **다른 축**이다: 그쪽은 "이 서버가 해석할 수 있는
   * 스키마인가"를 판정하는 값이라 `validateGraphSpec`이 상수와 엄격히 비교한다. 그래서
   * 수정 횟수를 거기에 실을 수 없고, 별도 카운터를 둔다. `plan_version`과도 다르다 —
   * patch는 plan(step 집합)을 바꾸지 않으므로 replan 예산을 소모하지 않는다.
   */
  @Column({ type: 'int', default: 0 })
  graph_revision: number;

  // ── 사용자 확인 강도(티켓 5dbe4aa2) ────────────────────────────────────────

  /**
   * 이 미션에서 사람의 confirm 게이트를 얼마나 세울 것인가 —
   * `none` | `auto`(기본) | `key_steps` | `every_step`.
   * `orchestration.constants.ts` 의 `CONFIRM_POLICIES` 참고.
   *
   * 기본값을 `auto` 로 둬도 **기존 미션의 동작은 한 글자도 바뀌지 않는다**: confirm
   * 노드는 graph 모드에서만 만들 수 있고 `graph_enabled` 기본값이 false 이므로, 기존
   * 미션은 정책값과 무관하게 confirm 노드를 가질 수 없다. `none` 을 기본으로 두면
   * 하위호환에 아무 이득 없이 새 기능만 기본 off 가 된다.
   *
   * DDL 마이그레이션은 쓰지 않는다 — 이 저장소의 `db.ts` 는 전 백엔드에서
   * `synchronize` 를 켜고 migration 은 DATA 전용이다. 대신 읽는 쪽이 항상
   * `normalizeConfirmPolicy()` 를 거쳐 빈 문자열/NULL 로 남은 기존 행도 기본값으로
   * 접힌다.
   */
  @Column({ type: 'varchar', default: 'auto' })
  confirm_policy: string;

  // ── 미션 대화의 사용자 chat 옵션(티켓 9cfd8161) ───────────────────────────

  /**
   * 이 미션의 대화방에서 사람이 발화할 수 있는가 —
   * `open`(기본) | `participants_only` | `off`.
   * 어휘와 근거는 `orchestration.constants.ts` 의 `USER_CHAT_MODES` 참고.
   *
   * 이 값이 미션 대화의 **단일 기준**이다. 방의 `ChatRoom.open_join` 은 여기서 파생돼
   * 동기화되는 캐시이고, 발화 게이트(`requireMissionRoomSpeaker`)는 방 플래그가 아니라
   * 이 컬럼을 직접 읽는다 — 그래서 옵션을 바꾸면 **이미 실행 중인 미션 방에도 즉시**
   * 반영된다.
   *
   * `confirm_policy` / `graph_enabled` 와 달리 **브리핑 계약이 아니다**. 저 둘은
   * orchestrator 가 브리핑에서 들은 대로 그래프를 짜므로 시작 뒤 바꾸면 실행 규칙과
   * 어긋나지만, 이 옵션은 "사람이 이 방에서 말할 수 있는가"만 정할 뿐 orchestrator 가
   * 들은 내용을 한 글자도 바꾸지 않는다. 그래서 `updateMission` 의 draft 잠금
   * (`touchesBrief`)에서 의도적으로 빠져 있고, running 중에도 편집 가능하다.
   *
   * `confirm_policy` 와 같은 이유로 DDL 마이그레이션은 쓰지 않는다 — 이 저장소의
   * `db.ts` 는 전 백엔드에서 `synchronize` 를 켜고 migration 은 DATA 전용이다. 대신
   * 읽는 쪽이 항상 `normalizeUserChatMode()` 를 거쳐 빈 문자열/NULL 로 남은 기존 행도
   * 기본값으로 접힌다.
   */
  @Column({ type: 'varchar', default: 'open' })
  user_chat_mode: string;

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
