/**
 * Shared vocabulary + pure plan logic for Orchestration mode.
 *
 * Everything here is dependency-free so both the runner service and the MCP
 * tool layer can validate a plan the same way, and so the DAG rules can be
 * reasoned about (and unit-tested) without a database.
 */

// ── Mission status ───────────────────────────────────────────────────────────

export const MISSION_STATUSES = [
  'draft',
  'planning',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminalMissionStatus(s: string): boolean {
  return (TERMINAL_MISSION_STATUSES as readonly string[]).includes(s);
}

// ── Step status ──────────────────────────────────────────────────────────────

export const STEP_STATUSES = [
  'pending',
  'ready',
  'dispatched',
  'running',
  'done',
  'failed',
  'blocked',
  'skipped',
  'cancelled',
  'needs_recovery',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** In flight: a subagent may be working on it right now. Counts against parallelism. */
export const IN_FLIGHT_STEP_STATUSES: readonly StepStatus[] = ['dispatched', 'running'];

/** Terminal: will never transition again without explicit orchestrator/operator action. */
export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = [
  'done',
  'failed',
  'blocked',
  'skipped',
  'cancelled',
  'needs_recovery',
];

/**
 * 재시도 정책(티켓 4d065f82) — lease 가 만료됐을 때 자동으로 다시 띄워도 되는가.
 *
 * `auto`(기본)는 기존 동작 그대로다: 리퍼가 `failed` 로 넘기고 orchestrator 가
 * 정상 실패 처리 경로에서 재시도를 결정한다. `manual` 은 **비멱등·위험 작업**용이다 —
 * 배포, 결제, 외부로 나가는 게시처럼 "한 번 더 실행"이 그 자체로 피해인 작업.
 * 이 경우 리퍼는 자동 재실행 대신 `needs_recovery` 로 전환하고 사유를 남긴다.
 *
 * 판정을 서버가 추측하지 않고 계획 시점에 orchestrator 가 선언하게 둔 이유:
 * 어떤 작업이 비멱등인지는 step 의 instructions 안에만 있는 의미론이라
 * 상태 머신이 사후에 알아낼 방법이 없다. 선언되지 않으면 기존 동작을 유지한다.
 */
export const STEP_RETRY_POLICIES = ['auto', 'manual'] as const;
export type StepRetryPolicy = (typeof STEP_RETRY_POLICIES)[number];

/** Satisfies a downstream `depends_on` edge. `skipped` counts — the orchestrator
 *  declared the work unnecessary, so dependents must not stay pending forever. */
export const DEPENDENCY_SATISFYING_STATUSES: readonly StepStatus[] = ['done', 'skipped'];

/** Poisons downstream steps: a dependent can never run, so it goes `blocked`.
 *  `needs_recovery` 도 포함된다 — 사람이 손대기 전에는 절대 `done` 이 되지 않으므로
 *  하류를 `pending` 으로 방치하면 미션이 조용히 멈춘 것처럼 보인다. */
export const DEPENDENCY_POISONING_STATUSES: readonly StepStatus[] = [
  'failed',
  'blocked',
  'cancelled',
  'needs_recovery',
];

export function isInFlight(s: string): boolean {
  return (IN_FLIGHT_STEP_STATUSES as readonly string[]).includes(s);
}
export function isTerminalStepStatus(s: string): boolean {
  return (TERMINAL_STEP_STATUSES as readonly string[]).includes(s);
}

// ── Timeline event types ─────────────────────────────────────────────────────

export const ORCHESTRATION_EVENT_TYPES = [
  'mission_created',
  'mission_started',
  'plan_submitted',
  'step_assigned',
  'step_dispatched',
  'step_progress',
  'step_completed',
  'step_failed',
  'step_blocked',
  'step_skipped',
  'step_retried',
  // 복구(티켓 4d065f82) — lease 만료로 자동 재실행이 금지된 step, 그리고 지각 보고가
  // fencing 으로 거부된 순간. 후자는 "왜 내 결과가 반영 안 됐나"를 설명하는 유일한 근거다.
  'step_needs_recovery',
  'step_lease_rejected',
  // 복구 reconciliation(리뷰 라운드1 P0-1) — lease 만료 관측 → 유예 → 재연결 성공
  // 또는 새 attempt 자동 재디스패치. 각 단계가 왜 그렇게 됐는지 사후 재구성 가능해야 한다.
  'step_lease_stale',
  'step_lease_recovered',
  'step_auto_redispatched',
  // 재개 가능한 체크포인트 저장(리뷰 라운드1 P0-2) — 마지막 값은 step 에 있고,
  // 각 저장 시점은 여기 append-only 로 남는다.
  'step_checkpoint',
  // 상류 복구로 자동 차단이 풀린 하류(리뷰 라운드1 P1-4).
  'step_unblocked',
  'orchestrator_woken',
  'mission_paused',
  'mission_resumed',
  'mission_completed',
  'mission_failed',
  'mission_cancelled',
  'criteria_updated',
  // 그래프 실행 trace(티켓 1ca9e49b) — "어느 edge를 왜 골랐는가"와 "몇 번째 반복인가"를
  // 사후에 재구성할 수 있게 하는 이벤트들. UI 타임라인이 그대로 렌더링한다.
  'edge_selected',
  'node_revisited',
  'loop_exhausted',
  'graph_budget_exhausted',
  // 실행 중 그래프 부분 수정(티켓 2fc8f99a) — 어떤 edge/node/예산이 언제 왜 바뀌었는지
  // 사후에 재구성할 수 있어야 "왜 이 분기가 갑자기 열렸나"를 설명할 수 있다.
  'graph_patched',
  'post_action_dispatched',
  'post_action_dispatch_failed',
  'post_action_skipped',
  'note',
  'error',
] as const;
export type OrchestrationEventType = (typeof ORCHESTRATION_EVENT_TYPES)[number];

// ── Mission 실행 계약 (ticket 2dc3c62f) ──────────────────────────────────────
//
// 세 가지 신규 개념이 Mission의 "실행 계약"을 이룬다:
//   - `method`      — objective(무엇)와 별개로 orchestrator가 지켜야 할 접근
//                      방식/제약(어떻게). 자유 텍스트로 유지한다 — 이미
//                      `acceptance_criteria` prose가 검증 없는 자유 서술로도
//                      충분히 기능해온 선례를 그대로 따른다.
//   - completion criteria — `acceptance_criteria` prose는 그대로 두되, 종료
//                      게이트가 필요한 항목만 구조화된 체크리스트로 별도
//                      추적한다(QaScenario.steps와 같은 "구조화 배열 +
//                      prose 병행" 패턴).
//   - post-actions  — 완료 후 순서/조건/실패정책을 갖는 Action 디스패치
//                      목록. on-ticket-done-action.service.ts의 "디스패치
//                      실패는 기록하고 계속 진행"과 동일한 실패정책을 쓴다:
//                      개별 Action의 최종 성공/실패까지 추적하지 않는다 —
//                      디스패치 성공 시 run_id를 남겨 감사 추적선(get_action_run
//                      경로)만 확보하고, Mission의 최종 상태는 절대 되돌리지
//                      않는다(설계 결정, 티켓 본문 "post-action 실패가 Mission
//                      성공 상태에 미치는 영향" 참고).

export const POST_ACTION_CONDITIONS = ['always', 'on_success', 'on_failure'] as const;
export type PostActionCondition = (typeof POST_ACTION_CONDITIONS)[number];

/**
 * `dispatched`는 ActionRun 생성에 성공했다는 뜻일 뿐, 그 Action 자체가
 * 성공했다는 뜻이 아니다 — `run_id`로 `get_action_run`/AWB UI에서 실제 결과를
 * 추적한다. 'succeeded'/'failed' 같은 이름을 쓰지 않는 이유: Mission은 그
 * ActionRun의 최종 완료를 기다리거나 구독하지 않으므로(설계 결정), 그런
 * 이름은 실제로 추적하지 않는 것을 추적하는 것처럼 오인시킨다.
 */
/**
 * `in_flight`(리뷰 지적 반영, 티켓 2dc3c62f) — dispatch() 호출 "직전"에 저장되는
 * 중간 상태. completeMission()이 terminal status를 저장한 직후 ~ post_actions
 * 처리 사이, 또는 dispatch() 호출 자체의 도중에 프로세스가 죽으면(재시작 등)
 * 이 상태로 영구히 남을 수 있다 — runPostActions()가 재호출될 때(reaper 복구
 * 스윕) `pending`은 안전하게 재시도하지만 `in_flight`는 절대 재시도하지 않는다
 * (dispatch()가 실제로 이미 발화했을 수도 있어 재시도하면 중복 디스패치 위험).
 * 대신 일정 유예시간이 지난 `in_flight`는 `dispatch_failed`(결과 불명으로
 * 처리)로 전환해 "영구 미실행·무감사" 상태를 벗어나게 한다.
 */
export const POST_ACTION_STATUSES = ['pending', 'in_flight', 'dispatched', 'dispatch_failed', 'skipped'] as const;
export type PostActionStatus = (typeof POST_ACTION_STATUSES)[number];

/** in_flight 상태가 이보다 오래 지속되면 크래시로 중단된 것으로 간주하고
 *  dispatch_failed로 전환한다(재시도는 절대 하지 않음 — 중복 디스패치 방지). */
export const POST_ACTION_STALE_IN_FLIGHT_MS = 2 * 60_000;

export interface MissionPostAction {
  /** Action.id — 대상 workspace 소속인지는 디스패치 시점에 재검증한다. */
  action_id: string;
  /** 오름차순 실행 순서. 동률이면 배열 원래 순서를 유지(안정 정렬). */
  order: number;
  /** 'always' | 'on_success'(completed일 때만) | 'on_failure'(failed일 때만). */
  condition: PostActionCondition;
  status: PostActionStatus;
  run_id?: string | null;
  room_id?: string | null;
  error?: string;
  dispatched_at?: string | null;
}

export interface MissionCompletionCriterion {
  /** 미션 내 고유 slug. STEP_KEY_PATTERN과 동일한 규칙을 재사용한다. */
  key: string;
  description: string;
  met: boolean;
  met_at?: string | null;
  /** met=true/false로 전환할 때 orchestrator가 남긴 근거. */
  note?: string;
}

// STEP_KEY_PATTERN(아래 Limits 섹션)과 같은 모양이다 — alias 참조가 아니라
// 리터럴을 그대로 다시 쓴 것이다, 이 섹션이 파일에서 그보다 먼저 선언되므로.
export const CRITERION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export interface CompletionCriteriaValidationError {
  error: string;
}

/**
 * 구조화된 completion criteria 배열을 정규화 + 검증한다. 빈 배열/undefined는
 * "구조화 게이트 없음"(하위호환 — 기존 Mission은 전부 이 상태)을 뜻하는
 * 유효한 값이라 에러가 아니다. key 중복/빈 description만 거부한다 — plan의
 * step_key처럼 DAG를 이루지는 않으므로 validatePlan만큼 정교할 필요가 없다.
 */
export function normalizeCompletionCriteria(
  input: unknown,
): { criteria: MissionCompletionCriterion[] } | CompletionCriteriaValidationError {
  if (input == null) return { criteria: [] };
  if (!Array.isArray(input)) return { error: 'completion_criteria must be an array' };
  const seen = new Set<string>();
  const out: MissionCompletionCriterion[] = [];
  for (const raw of input) {
    const key = String((raw as any)?.key ?? '').trim();
    if (!CRITERION_KEY_PATTERN.test(key)) {
      return { error: `invalid completion criterion key "${(raw as any)?.key}" — use lowercase letters, digits, '.', '_' or '-' (max 48 chars)` };
    }
    if (seen.has(key)) return { error: `duplicate completion criterion key "${key}"` };
    seen.add(key);
    const description = String((raw as any)?.description ?? '').trim();
    if (!description) return { error: `completion criterion "${key}" has no description` };
    out.push({
      key,
      description,
      met: (raw as any)?.met === true,
      met_at: (raw as any)?.met === true ? (raw as any)?.met_at ?? null : null,
      note: String((raw as any)?.note ?? '').slice(0, 1000),
    });
  }
  return { criteria: out };
}

/** `completion_criteria`가 비어있으면 게이트 없음(하위호환) — 그 외엔 전원 met이어야 true. */
export function allCriteriaMet(criteria: MissionCompletionCriterion[] | null | undefined): boolean {
  if (!Array.isArray(criteria) || criteria.length === 0) return true;
  return criteria.every((c) => c.met === true);
}

export interface PostActionsValidationError {
  error: string;
}

/**
 * post_actions 배열을 정규화 + 검증한다. 정의(구조) 단계에서는 항상
 * status='pending'으로 리셋한다 — 실행 상태는 오직 runPostActions()만 쓴다
 * (사람/오케스트레이터가 브리핑을 통해 정의를 바꿀 수 있는 건 draft일 때뿐이라,
 * 이 함수가 호출되는 시점엔 어차피 아직 아무것도 디스패치되지 않았다).
 *
 * `order`는 호출자(UI/MCP caller) 입력을 신뢰하지 않고 **항상** 최종 배열
 * 순서(빈 항목 제거 후) 그대로 0..N-1로 다시 매긴다(리뷰 2라운드 지적 반영,
 * 티켓 2dc3c62f) — `order`는 이제 `OrchestrationRunnerService`가 dispatch
 * idempotency key(`orchestration:<mission>:<order>`)의 일부로 쓰기 때문에
 * 유일성이 프로그램적으로 중요하다. 클라이언트가 입력 순서를 그대로 배열로
 * 보내는 한(재정렬 UI 없음) 이 재매김은 사용자가 의도한 순서를 그대로
 * 보존하면서 중복/공백 order를 원천적으로 막는다.
 */
export function normalizePostActions(input: unknown): { postActions: MissionPostAction[] } | PostActionsValidationError {
  if (input == null) return { postActions: [] };
  if (!Array.isArray(input)) return { error: 'post_actions must be an array' };
  const out: MissionPostAction[] = [];
  input.forEach((raw) => {
    const actionId = String((raw as any)?.action_id ?? '').trim();
    if (!actionId) return; // 빈 항목은 조용히 무시 — UI가 편집 중 빈 행을 보낼 수 있다
    const condition = (POST_ACTION_CONDITIONS as readonly string[]).includes((raw as any)?.condition)
      ? (raw as any).condition
      : 'always';
    out.push({
      action_id: actionId,
      order: out.length,
      condition,
      status: 'pending',
      run_id: null,
      room_id: null,
      error: '',
      dispatched_at: null,
    });
  });
  return { postActions: out };
}

/** post_action의 condition이 미션의 최종 status와 맞는지 판정한다. */
export function postActionApplies(condition: PostActionCondition, missionStatus: string): boolean {
  if (condition === 'always') return true;
  if (condition === 'on_success') return missionStatus === 'completed';
  if (condition === 'on_failure') return missionStatus === 'failed';
  return false;
}

// ── Limits ───────────────────────────────────────────────────────────────────

export const STEP_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
export const MAX_STEPS_CEILING = 200;
export const MAX_PARALLEL_CEILING = 12;
export const INSTRUCTIONS_MAX = 8000;
export const SUMMARY_MAX = 8000;
export const MAX_ARTIFACTS_PER_STEP = 30;
/** Upper bound on OrchestrationTeam.max_open_missions. The floor is 0 (a deliberate
 *  "no agent-created missions" value), enforced separately by the clamp that uses this. */
export const MAX_OPEN_MISSIONS_CEILING = 20;

// ── Plan validation ──────────────────────────────────────────────────────────

export interface PlanStepInput {
  step_key: string;
  title: string;
  instructions?: string;
  acceptance_criteria?: string;
  depends_on?: string[];
  assignee_agent_id?: string;
  /** 'auto'(기본) | 'manual'. `StepRetryPolicy` 참고 — 티켓 4d065f82. */
  retry_policy?: StepRetryPolicy;
}

export interface PlanValidationError {
  error: string;
}

/**
 * Validate an orchestrator-submitted plan as a DAG.
 *
 * Checks, in order: non-empty, per-step key shape, key uniqueness, dependency
 * targets exist, no self-edge, and acyclicity (Kahn's algorithm). Returns the
 * steps in a topologically-stable order — dependency-first, then the author's
 * original order among peers — so `position` reflects a legal execution order
 * and the UI's lane rendering is deterministic.
 *
 * Rejecting a cycle here is what stops the single worst failure mode of the
 * feature: a plan where nothing is ever dispatchable and the mission sits
 * `running` with zero activity until an operator notices.
 */
export function validatePlan(
  steps: PlanStepInput[],
  opts: { maxSteps: number },
): { steps: PlanStepInput[] } | PlanValidationError {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { error: 'plan must contain at least one step' };
  }
  if (steps.length > opts.maxSteps) {
    return { error: `plan has ${steps.length} steps, exceeding the mission limit of ${opts.maxSteps}` };
  }

  const seen = new Set<string>();
  for (const s of steps) {
    const key = String(s?.step_key ?? '').trim();
    if (!STEP_KEY_PATTERN.test(key)) {
      return {
        error:
          `invalid step_key "${s?.step_key}" — use lowercase letters, digits, '.', '_' or '-' ` +
          `(max 48 chars, must start alphanumeric)`,
      };
    }
    if (seen.has(key)) return { error: `duplicate step_key "${key}"` };
    seen.add(key);
    if (!String(s?.title ?? '').trim()) return { error: `step "${key}" has no title` };
    if (String(s?.instructions ?? '').length > INSTRUCTIONS_MAX) {
      return { error: `step "${key}" instructions exceed ${INSTRUCTIONS_MAX} characters` };
    }
  }

  const deps = new Map<string, string[]>();
  for (const s of steps) {
    const key = String(s.step_key).trim();
    const list = Array.isArray(s.depends_on)
      ? Array.from(new Set(s.depends_on.map((d) => String(d ?? '').trim()).filter(Boolean)))
      : [];
    for (const d of list) {
      if (d === key) return { error: `step "${key}" depends on itself` };
      if (!seen.has(d)) return { error: `step "${key}" depends on unknown step "${d}"` };
    }
    deps.set(key, list);
  }

  // Kahn's algorithm — also yields the dependency-first ordering we persist.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const key of seen) {
    indegree.set(key, 0);
    dependents.set(key, []);
  }
  for (const [key, list] of deps) {
    indegree.set(key, list.length);
    for (const d of list) dependents.get(d)!.push(key);
  }

  const byKey = new Map(steps.map((s) => [String(s.step_key).trim(), s]));
  const authorOrder = steps.map((s) => String(s.step_key).trim());
  const ordered: PlanStepInput[] = [];
  // Ready set kept in author order so peers keep the orchestrator's intent.
  let ready = authorOrder.filter((k) => (indegree.get(k) ?? 0) === 0);
  while (ready.length > 0) {
    const next: string[] = [];
    for (const key of ready) {
      ordered.push(byKey.get(key)!);
      for (const dep of dependents.get(key) ?? []) {
        const remaining = (indegree.get(dep) ?? 0) - 1;
        indegree.set(dep, remaining);
        if (remaining === 0) next.push(dep);
      }
    }
    ready = authorOrder.filter((k) => next.includes(k));
  }

  if (ordered.length !== steps.length) {
    const stuck = authorOrder.filter((k) => !ordered.some((s) => String(s.step_key).trim() === k));
    return {
      error:
        `plan contains a dependency cycle involving: ${stuck.join(', ')}. ` +
        `Every step must be reachable from a step with no dependencies.`,
    };
  }

  return { steps: ordered };
}

/**
 * Given the current step set, classify each non-terminal step as
 * dispatchable / still-waiting / permanently-blocked.
 *
 * Pure function over `{ step_key, status, depends_on }` so the runner can call
 * it after every state change without another DB round-trip, and so the
 * "nothing is dispatchable and nothing is in flight" deadlock signal is
 * computed in exactly one place.
 */
export interface StepStateView {
  step_key: string;
  status: string;
  depends_on: string[] | null;
}

export interface PlanProgress {
  /** Non-terminal, all dependencies satisfied → may be dispatched now. */
  dispatchable: string[];
  /** Non-terminal, waiting on a dependency that is still open. */
  waiting: string[];
  /** Non-terminal, but a dependency reached a poisoning status → can never run. */
  newlyBlocked: string[];
  inFlight: string[];
  done: string[];
  failed: string[];
  allTerminal: boolean;
}

export function computePlanProgress(steps: StepStateView[]): PlanProgress {
  const byKey = new Map(steps.map((s) => [s.step_key, s]));
  const out: PlanProgress = {
    dispatchable: [],
    waiting: [],
    newlyBlocked: [],
    inFlight: [],
    done: [],
    failed: [],
    allTerminal: true,
  };

  for (const s of steps) {
    if (isInFlight(s.status)) {
      out.inFlight.push(s.step_key);
      out.allTerminal = false;
      continue;
    }
    if (s.status === 'done' || s.status === 'skipped') {
      out.done.push(s.step_key);
      continue;
    }
    // `needs_recovery` 가 여기 반드시 있어야 한다(티켓 4d065f82). 이 함수는
    // TERMINAL_STEP_STATUSES 를 참조하지 않고 상태를 직접 나열해 분류하므로, 목록에
    // 없는 상태는 아래 "pending / ready" 분기로 흘러 **dispatchable 로 분류된다** —
    // 즉 자동 재실행을 금지하려고 만든 상태가 오히려 즉시 재디스패치를 부른다.
    // 정확히 막으려던 비멱등 작업의 중복 실행이라 그냥 두면 기능이 반대로 동작한다.
    if (
      s.status === 'failed' ||
      s.status === 'blocked' ||
      s.status === 'cancelled' ||
      s.status === 'needs_recovery'
    ) {
      out.failed.push(s.step_key);
      continue;
    }
    // pending / ready
    out.allTerminal = false;
    const deps = Array.isArray(s.depends_on) ? s.depends_on : [];
    let poisoned = false;
    let waiting = false;
    for (const d of deps) {
      const dep = byKey.get(d);
      // A dangling dependency (referenced step no longer exists after a replan)
      // is treated as satisfied rather than as a permanent block: validatePlan
      // guarantees it can't happen inside one plan version, and treating it as
      // poison would silently strand steps across a replan.
      if (!dep) continue;
      if ((DEPENDENCY_POISONING_STATUSES as readonly string[]).includes(dep.status)) {
        poisoned = true;
        break;
      }
      if (!(DEPENDENCY_SATISFYING_STATUSES as readonly string[]).includes(dep.status)) {
        waiting = true;
      }
    }
    if (poisoned) out.newlyBlocked.push(s.step_key);
    else if (waiting) out.waiting.push(s.step_key);
    else out.dispatchable.push(s.step_key);
  }

  return out;
}
