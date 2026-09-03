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
 *   needs_recovery — lease 가 만료됐지만 `retry_policy='manual'`(비멱등·위험 작업)이라
 *               자동 재실행이 금지된 상태. `recovery_reason` 에 사유가 담기고,
 *               사람 또는 orchestrator 의 명시적 `retry` 만이 이 상태를 벗어난다.
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

  // ── lease / fencing (티켓 4d065f82) ────────────────────────────────────────

  /**
   * 이번 attempt 의 fencing token — `dispatchStep` 이 디스패치마다 새로 발급하고
   * work order 에 실어 보낸다. 보고는 이 값을 그대로 되돌려줘야 받아들여진다.
   *
   * `visit`(그래프 loop 재진입 축)으로는 재시도를 막을 수 없어서 별도로 둔다:
   * 재시도는 `attempt` 만 올리고 `visit` 은 그대로라, attempt 1 의 살아있는
   * subagent 가 attempt 2 의 결과를 덮어쓰는 경로가 열려 있었다. 반대로 이 토큰은
   * 재진입이든 재시도든 **모든 재디스패치**에서 새로 발급되므로 두 축을 모두 덮는다.
   *
   * `''` = 이 기능 이전에 디스패치돼 work order 에 토큰이 없는 step. 그 경우에만
   * 토큰 없는 보고를 받아준다 — 업그레이드 시점에 이미 나가 있던 작업이 보고
   * 자체를 못 하고 막히는 wedge 를 피하기 위함이다.
   */
  @Column({ type: 'varchar', default: '' })
  lease_token: string;

  /**
   * 마지막 생존 신호 시각. `report_orchestration_progress` 가 **매 호출마다** 갱신한다.
   *
   * 리퍼의 타임아웃 기준선이며, 이 컬럼이 생기기 전에는 `started_at` 이 그 역할을
   * 했다 — 그런데 `started_at` 은 최초 progress 호출에서 한 번만 찍히고(`?? new Date()`)
   * 이후 갱신되지 않아서, "heartbeat 가 시계를 되돌린다"는 문서상 계약이 두 번째
   * 호출부터는 거짓이었다. 1분마다 살아있다고 보고하는 step 도 결국 시간 초과로
   * 죽었다. 이 컬럼이 그 계약을 실제로 성립시킨다.
   */
  @Column({ type: Date, nullable: true, default: null })
  last_heartbeat_at: Date | null;

  /**
   * `auto`(기본) | `manual`. `manual` 이면 lease 만료 시 자동 재실행 대신
   * `needs_recovery` 로 간다. `orchestration.constants.ts` 의 `StepRetryPolicy` 참고.
   */
  @Column({ type: 'varchar', default: 'auto' })
  retry_policy: string;

  /**
   * `status === 'needs_recovery'` 일 때 왜 자동 복구가 불가능한지에 대한 사람이 읽을
   * 사유. UI 와 orchestrator 브리핑에 그대로 노출된다. 다른 상태에서는 `''`.
   */
  @Column({ type: 'text', default: '' })
  recovery_reason: string;

  // ── 그래프 실행 상태(티켓 1ca9e49b) ────────────────────────────────────────

  /**
   * 이 node가 지금까지 실행에 들어간 횟수(1-based, 미실행이면 0). `attempt`와는
   * 다른 축이다: `attempt`는 **같은 iteration 안에서의 재시도**이고, `visit`은
   * loop_back edge를 통한 **재진입 횟수**다. 하나의 evaluator→revision loop에서
   * draft가 두 번째로 실행되면 visit=2, attempt는 다시 1부터 센다.
   * `GraphSpec` node의 `max_visits`와 대조돼 무한 반복을 막는다.
   */
  @Column({ type: 'int', default: 0 })
  visit: number;

  /**
   * 이 step이 마지막으로 보고한 verdict(소문자 정규화). evaluator/router node가
   * 조건 분기를 고르는 근거이며, `EdgeCondition.verdict`와 대조된다.
   * '' = verdict 없음(일반 task node의 정상 상태).
   */
  @Column({ type: 'varchar', default: '' })
  verdict: string;

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
