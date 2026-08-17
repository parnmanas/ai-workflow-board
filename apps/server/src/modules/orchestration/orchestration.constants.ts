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
];

/** Satisfies a downstream `depends_on` edge. `skipped` counts — the orchestrator
 *  declared the work unnecessary, so dependents must not stay pending forever. */
export const DEPENDENCY_SATISFYING_STATUSES: readonly StepStatus[] = ['done', 'skipped'];

/** Poisons downstream steps: a dependent can never run, so it goes `blocked`. */
export const DEPENDENCY_POISONING_STATUSES: readonly StepStatus[] = ['failed', 'blocked', 'cancelled'];

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
  'orchestrator_woken',
  'mission_paused',
  'mission_resumed',
  'mission_completed',
  'mission_failed',
  'mission_cancelled',
  'note',
  'error',
] as const;
export type OrchestrationEventType = (typeof ORCHESTRATION_EVENT_TYPES)[number];

// ── Limits ───────────────────────────────────────────────────────────────────

export const STEP_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
export const MAX_STEPS_CEILING = 200;
export const MAX_PARALLEL_CEILING = 12;
export const INSTRUCTIONS_MAX = 8000;
export const SUMMARY_MAX = 8000;
export const MAX_ARTIFACTS_PER_STEP = 30;

// ── Plan validation ──────────────────────────────────────────────────────────

export interface PlanStepInput {
  step_key: string;
  title: string;
  instructions?: string;
  acceptance_criteria?: string;
  depends_on?: string[];
  assignee_agent_id?: string;
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
    if (s.status === 'failed' || s.status === 'blocked' || s.status === 'cancelled') {
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
