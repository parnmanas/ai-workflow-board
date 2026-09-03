import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { ConfirmDecision } from '../modules/orchestration/orchestration.constants';

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
 *   awaiting_user — graph 모드의 `confirm` node 가 **사람의 Pass/Fail 판정**을 기다리며
 *               durable pause 중(티켓 5dbe4aa2). subagent 가 뜨지 않으므로 in-flight 가
 *               아니고, 스스로 `done` 으로 전이하므로 terminal 도 아니다. 상태가 DB 에
 *               있으므로 서버가 재시작해도 그대로 남고, 판정이 들어오면 그 자리에서
 *               이어진다.
 *
 * `dispatched` and `running` are BOTH "in flight" for parallelism accounting —
 * the split exists only so the UI can distinguish "prompt sent, subagent may
 * still be spawning" from "the member has actually spoken".
 */
@Entity('orchestration_steps')
@Index('idx_orch_steps_mission', ['mission_id'])
@Index('idx_orch_steps_assignee', ['assignee_agent_id'])
@Index('idx_orch_steps_status', ['status'])
// 리퍼의 confirm 리마인더 후보 스캔용(티켓 a78cb566). 후보는 `status='awaiting_user'` 로
// 좁힌 뒤 선점 시각 순으로 오래 기다린 것부터 가져간다 — 그 두 컬럼이 그대로 이 색인이다.
@Index('idx_orch_steps_confirm_gate', ['status', 'confirm_notified_at'])
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

  /**
   * 작업자가 남긴 **재개 가능한** 진행 상태(티켓 4d065f82, 리뷰 라운드1 P0-2).
   *
   * timeline 의 progress 메시지와는 다른 축이다: 그쪽은 사람이 읽는 500자 서술이라
   * 재시작한 작업자가 "어디서부터 이어서 하면 되는지"를 프로그램적으로 복원할 수 없다.
   * 이 컬럼은 작업자가 스스로 정의한 구조화 상태를 그대로 담고, lease 가 만료돼 새
   * attempt 로 재디스패치될 때 **work order 에 실려 나간다** — 그래야 재개가 처음부터
   * 다시 하는 것과 달라진다.
   *
   * 마지막 값만 보관한다(last-writer-wins). 이력이 필요하면 timeline 의
   * `step_checkpoint` 이벤트가 각 저장 시점을 append-only 로 남긴다.
   */
  @Column({ type: 'simple-json', nullable: true, default: null })
  checkpoint: Record<string, any> | null;

  @Column({ type: Date, nullable: true, default: null })
  checkpoint_at: Date | null;

  /**
   * lease 가 만료된 것으로 처음 관측된 시각 — 유예(grace) 창의 시작점이다.
   * null = 정상(생존 신호가 시간 안에 들어오고 있음).
   *
   * 리퍼는 만료를 보자마자 step 을 죽이지 않는다. 먼저 이 값을 찍고 작업자에게
   * 재연결/상태보고를 요청한 뒤, 유예 안에 heartbeat 가 들어오면 lease 를 그대로
   * 되살린다. 유예까지 지나야 새 attempt 로 재디스패치한다.
   */
  @Column({ type: Date, nullable: true, default: null })
  lease_stale_since: Date | null;

  /**
   * 이 step 이 **상류 실패 때문에 엔진이 자동으로** blocked 로 만든 것인지.
   *
   * 작업자가 스스로 "막혔다"고 보고한 blocked 와 반드시 구분해야 한다: 상류가 복구되면
   * 전자는 다시 실행 가능해져야 하고, 후자는 사람이 판단하기 전까지 그대로 둬야 한다.
   * 이 플래그가 없으면 둘을 가를 방법이 `result_summary` 문자열 검사뿐이다.
   */
  @Column({ type: 'boolean', default: false })
  auto_blocked: boolean;

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

  // ── 사용자 확인 게이트(티켓 5dbe4aa2) ──────────────────────────────────────

  /**
   * 이 confirm node 에 사람이 내린 판정. null = 아직 판정 전, 또는 loop 재진입으로
   * 리셋됨. confirm 이 아닌 node 에서는 항상 null 이다.
   *
   * `verdict` 컬럼에도 같은 값이 복사되는데(그래야 `evaluateEdge` 의 분기 기계를
   * 그대로 재사용한다), 이 컬럼은 그 위에 **누가·언제·왜·몇 번째 pass 에서** 를 얹는다.
   * 특히 `visit` 이 중요하다: loop 가 재진입하면 같은 step 이 다음 iteration 으로 다시
   * 열리는데, 브라우저에 떠 있던 이전 pass 의 화면이 그대로 제출되면 남의 pass 판정이
   * 현재 pass 에 기록된다. 제출 시 이 값을 대조해 stale 화면을 거부한다.
   *
   * `orchestration.constants.ts` 의 `ConfirmDecision` 참고.
   */
  @Column({ type: 'simple-json', nullable: true, default: null })
  confirm_decision: ConfirmDecision | null;

  // ── 게이트 대기 알림 선점(claim) 마커 (티켓 a78cb566) ─────────────────────
  //
  // 세 컬럼 모두 **스칼라**다. 예전엔 `confirm_notice` 라는 simple-json 한 덩어리였는데
  // 두 가지를 못 했다:
  //
  //   1. **원자적 선점** — JSON blob 은 `WHERE` 절에서 이식성 있게 비교할 수 없어서
  //      "읽고 → 판단하고 → 쓴다" 밖에 못 했다. 서버가 둘이면 둘 다 "아직 안 보냈다"를
  //      읽고 둘 다 보낸다. 스칼라 컬럼이면 단일 UPDATE 의 `WHERE` 에 조건을 실어
  //      **DB 가 승자를 하나만 고르게** 할 수 있다(SQLite·Postgres 공통).
  //   2. **색인 가능한 후보 스캔** — 리퍼가 "리마인더 보낼 만료 게이트"를 SQL 로 직접
  //      고를 수 있어야 한다. JSON 안에 든 값으로는 `WHERE`/`ORDER BY` 를 걸 수 없어,
  //      예전엔 미션을 무순서로 잘라 온 뒤 애플리케이션에서 걸렀고 그게 기아를 만들었다.
  //
  // 관측용 수치(수신자 수·실제 전달 채널 수)는 여기 두지 않는다. 타임라인의
  // `confirm_notified` 이벤트 `data` 에 이미 들어 있고, 두 곳에 두면 어긋난다.
  //
  // loop 재진입에서 **일부러 리셋하지 않는다**. 키가 pass 번호(`visit`)라서 새 pass 는
  // 값이 저절로 달라져 다시 자격이 생긴다. 미리 null 로 밀면 "그 사이에 이미 나갔는지"
  // 를 판별할 근거만 잃는다.

  /**
   * 최초 게이트 알림을 선점한 pass 번호. `visit` 과 같으면 이 pass 는 이미 누군가
   * 선점했다(= 보내는 중이거나 보냈다). null = 아직 아무도 선점하지 않았다.
   *
   * "보냈다"가 아니라 "선점했다"인 것이 중요하다 — 발송은 배경에서 돌기 때문에 성공을
   * 기다렸다가 쓰면 그 사이 두 번째 발송이 끼어든다. 발송 **전에** 쓴다.
   */
  @Column({ type: 'int', nullable: true, default: null })
  confirm_notified_visit: number | null;

  /**
   * 위 선점 시각. 리퍼의 리마인더 대기 시간을 재는 **기준점(anchor)** 이다.
   *
   * 선점에 실패했거나(발송 직전 프로세스가 죽는 등) 이 기능 이전에 열린 게이트는 null 인데,
   * 그때 리퍼는 `dispatched_at` 으로 떨어진다 — 최초 알림이 유실된 게이트야말로 리마인더가
   * 가장 필요한 경우라 여기서 끊으면 안 된다.
   */
  @Column({ type: Date, nullable: true, default: null })
  confirm_notified_at: Date | null;

  /**
   * 장기 미응답 리마인더를 선점한 pass 번호. `visit` 과 같으면 이 pass 의 리마인더는
   * 이미 나갔다. pass 당 1회이고, loop 로 다음 pass 가 열리면 값이 달라져 다시 자격이 생긴다.
   */
  @Column({ type: 'int', nullable: true, default: null })
  confirm_reminded_visit: number | null;

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
