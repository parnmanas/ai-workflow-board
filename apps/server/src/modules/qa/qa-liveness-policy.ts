/**
 * QaRun liveness policy registry (ticket 40010b25).
 *
 * The old reaper judged whether a run was alive with a SINGLE global heuristic
 * (non-terminal + age > TTL → reap). That single proxy broke both ways on
 * different boards: it false-reaped live-but-slow runs and let dead drives sit
 * `running` forever once a single token had been recorded. "Dead" is defined
 * differently per board and cannot be inferred from the board's own record of
 * step count — so detection has to be PLUGGABLE per board (optionally per
 * scenario), not one hardcoded rule.
 *
 * This file is that registry. Each policy `type` maps to a `LivenessDetector`
 * that, given a run + the resolved policy + a clock, returns either a reason
 * string (→ reap, embedded in the run summary) or null (→ spare). The reaper
 * core just dispatches on `policy.type`; a new board "death signal" is a new
 * detector registered here, with NO change to the reaper.
 *
 * Built-in detectors:
 *   - `zero_progress`      — the legacy default. Reaps on TWO fuses (whichever
 *                            trips first), identical to the pre-ticket reaper so
 *                            a board with no policy is fully regression-safe:
 *                            (1) 6h-TTL absolute backstop — age
 *                            (started_at ?? created_at) exceeds the deadline
 *                            (defaults to the global QA_RUN_TTL_MS), regardless
 *                            of recorded steps; (2) fast zero-progress fuse — a
 *                            run that recorded ZERO steps past
 *                            QA_RUN_ZERO_PROGRESS_MS (default 40m), the common
 *                            "started but its build/drive died before any step
 *                            landed" rot. A run with ≥1 step is treated as
 *                            progressing and waits for the absolute TTL.
 *   - `heartbeat_deadline` — reap only when a monotonic progress token has not
 *                            STRICTLY advanced within `deadline_sec`. A repeated
 *                            (same/lower) token does not extend the deadline
 *                            (false-immortal guard); a strictly-advancing token
 *                            keeps resetting it (false-reap guard). AWB never
 *                            interprets what the token counts — disk artifacts,
 *                            frames, requests — only that it advances in time.
 */

import { z } from 'zod';
import type { QaRun } from '../../entities/QaRun';
import { type QaPhasesConfig, findPhase } from './qa-phases';

export type LivenessPolicy =
  | { type: 'zero_progress'; deadline_sec?: number }
  | { type: 'heartbeat_deadline'; deadline_sec: number }
  // Multi-phase model (ticket 90cc22f7): judge the run against the timeout of its
  // CURRENT phase (resolved qa_phases, supplied via ctx.phases) measured from
  // current_phase_at. `fallback_sec` is used when the run has no/unmatched
  // current_phase (else the first phase's timeout, else the global TTL).
  | { type: 'phase_timeouts'; fallback_sec?: number };

export interface LivenessEvalContext {
  now: Date;
  /** Global QA_RUN_TTL_MS — the absolute backstop deadline for `zero_progress` when the policy omits deadline_sec. */
  defaultTtlMs: number;
  /** Global QA_RUN_ZERO_PROGRESS_MS — the fast fuse window for `zero_progress` (0-step runs only). */
  defaultZeroProgressMs: number;
  /**
   * Resolved per-run QA phase model (scenario ?? board, see resolveQaPhases).
   * Only the `phase_timeouts` detector reads it; built once per run by the reaper.
   * null/undefined when the run's scope defines no phases.
   */
  phases?: QaPhasesConfig | null;
}

export interface LivenessDetector {
  readonly type: string;
  /**
   * Decide whether a NON-TERMINAL run is dead. Return a human-readable reason
   * (embedded in the reaped run's summary so "infra death" reads distinctly
   * from a tested failure), or null to spare the run.
   */
  evaluate(run: QaRun, policy: LivenessPolicy, ctx: LivenessEvalContext): string | null;
}

const toMin = (ms: number): number => Math.round(ms / 60_000);
const toSec = (ms: number): number => Math.round(ms / 1000);

const zeroProgressDetector: LivenessDetector = {
  type: 'zero_progress',
  evaluate(run, policy, ctx) {
    const startedAt = run.started_at ?? run.created_at;
    if (!startedAt) return null;
    const age = ctx.now.getTime() - new Date(startedAt).getTime();
    // Absolute backstop: a board may tune the deadline via deadline_sec, else
    // the global QA_RUN_TTL_MS (default 6h). Applies regardless of step count.
    const ttlMs =
      policy.type === 'zero_progress' && policy.deadline_sec ? policy.deadline_sec * 1000 : ctx.defaultTtlMs;
    if (age > ttlMs) {
      return (
        `fuse: 6h-TTL — no terminal status within ${toMin(ttlMs)} min (ran for ~${toMin(age)} min); ` +
        `the QA agent or its backing build/drive job is presumed dead. ` +
        `This is NOT a tested failure — re-run the scenario.`
      );
    }
    // Fast zero-progress fuse: a run that recorded ZERO steps past the global
    // QA_RUN_ZERO_PROGRESS_MS window (default 40m) is presumed dead before
    // making any progress. A run with ≥1 step is progressing — wait for the TTL.
    const stepCount = run.step_results?.length ?? 0;
    if (stepCount === 0 && age > ctx.defaultZeroProgressMs) {
      return (
        `fuse: zero-progress — no step recorded after ~${toMin(age)} min ` +
        `(threshold ${toMin(ctx.defaultZeroProgressMs)} min); the QA agent or its backing build/drive ` +
        `job is presumed dead before making any progress. This is NOT a tested failure — re-run the scenario.`
      );
    }
    return null;
  },
};

const heartbeatDeadlineDetector: LivenessDetector = {
  type: 'heartbeat_deadline',
  evaluate(run, policy, ctx) {
    if (policy.type !== 'heartbeat_deadline') return null;
    const deadlineMs = policy.deadline_sec * 1000;
    // Baseline = the last STRICT token advance, falling back to run start. A run
    // that has never heartbeat still gets deadline_sec from its start to emit its
    // first token (grace window), then must keep the token strictly advancing.
    const baselineRaw = run.liveness_token_at ?? run.started_at ?? run.created_at;
    if (!baselineRaw) return null;
    const stalledMs = ctx.now.getTime() - new Date(baselineRaw).getTime();
    if (stalledMs <= deadlineMs) return null;
    const tokenNote =
      run.liveness_token == null
        ? 'no liveness heartbeat ever received'
        : `progress token stuck at ${run.liveness_token}`;
    return (
      `liveness heartbeat stalled — ${tokenNote} for ~${toSec(stalledMs)}s ` +
      `(deadline ${policy.deadline_sec}s); the backing drive/process is presumed dead. ` +
      `This is infra death (token stalled), NOT a tested failure — re-run the scenario.`
    );
  },
};

const phaseTimeoutsDetector: LivenessDetector = {
  type: 'phase_timeouts',
  evaluate(run, policy, ctx) {
    if (policy.type !== 'phase_timeouts') return null;
    const config = ctx.phases ?? null;
    const activePhase = findPhase(config, run.current_phase);

    if (activePhase) {
      // Active phase matched: judge it against its own timeout from the phase
      // entry instant (current_phase_at), falling back to run start for a phase
      // stamped without a timestamp (legacy-safety).
      const baselineRaw = run.current_phase_at ?? run.started_at ?? run.created_at;
      if (!baselineRaw) return null;
      const elapsed = ctx.now.getTime() - new Date(baselineRaw).getTime();
      const limitMs = activePhase.timeout_sec * 1000;
      if (elapsed <= limitMs) return null;
      const label = activePhase.label || activePhase.id;
      return (
        `phase timeout — phase '${label}' has run ~${toSec(elapsed)}s ` +
        `(timeout ${activePhase.timeout_sec}s); the backing build/drive job for this phase is presumed dead. ` +
        `This is infra death (phase overran its timeout), NOT a tested failure — re-run the scenario.`
      );
    }

    // No current_phase, or it doesn't match the resolved model (stale/renamed
    // phase). Fall back to a single deadline measured from run start: the explicit
    // fallback_sec, else the FIRST phase's timeout (a sane "still in the opening
    // phase" guess), else the global TTL backstop so the run is never immortal.
    const baselineRaw = run.current_phase_at ?? run.started_at ?? run.created_at;
    if (!baselineRaw) return null;
    const elapsed = ctx.now.getTime() - new Date(baselineRaw).getTime();
    const fallbackSec = policy.fallback_sec ?? config?.phases[0]?.timeout_sec;
    const limitMs = fallbackSec ? fallbackSec * 1000 : ctx.defaultTtlMs;
    if (elapsed <= limitMs) return null;
    const where = run.current_phase ? `unmatched phase '${run.current_phase}'` : 'no phase set';
    return (
      `phase timeout (fallback) — ${where}, ran ~${toMin(elapsed)} min past the ` +
      `${Math.round(limitMs / 1000)}s fallback deadline; the QA agent or its backing job is presumed dead. ` +
      `This is NOT a tested failure — re-run the scenario.`
    );
  },
};

/**
 * The detector registry — the extension point. Register a new board's death
 * signal here (or via registerLivenessDetector) and the reaper picks it up by
 * `policy.type` without any core change.
 */
const REGISTRY = new Map<string, LivenessDetector>();

export function registerLivenessDetector(detector: LivenessDetector): void {
  REGISTRY.set(detector.type, detector);
}

export function getLivenessDetector(type: string): LivenessDetector | undefined {
  return REGISTRY.get(type);
}

export function livenessDetectorTypes(): string[] {
  return [...REGISTRY.keys()];
}

registerLivenessDetector(zeroProgressDetector);
registerLivenessDetector(heartbeatDeadlineDetector);
registerLivenessDetector(phaseTimeoutsDetector);

export const DEFAULT_LIVENESS_POLICY: LivenessPolicy = { type: 'zero_progress' };

/**
 * Zod schema for the WRITE path (MCP update_board / create|update_qa_scenario).
 * A discriminated union keyed on `type`: zero_progress's deadline is optional
 * (falls back to the global TTL), heartbeat_deadline's is mandatory and must be
 * a positive integer (a deadline with no number is meaningless).
 */
export const LivenessPolicySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('zero_progress'),
    deadline_sec: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('heartbeat_deadline'),
    deadline_sec: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('phase_timeouts'),
    fallback_sec: z.number().int().positive().optional(),
  }),
]);

/** Serialize a validated policy (or null) for storage as the entity's text column. */
export function serializeLivenessPolicy(policy: LivenessPolicy | null | undefined): string | null {
  if (!policy) return null;
  return JSON.stringify(policy);
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Parse a stored liveness_policy JSON string into a validated descriptor.
 * Returns null for empty/unparseable/unknown-type/bad-params input — we FAIL
 * SAFE to null (never throw mid-sweep) so one malformed board config can't break
 * reaping for every other run. Used both by the reaper (read path) and by the
 * JSON projection so the client sees the normalized object.
 */
export function parseLivenessPolicy(raw: string | null | undefined): LivenessPolicy | null {
  if (!raw) return null;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null;
  if (!REGISTRY.has(obj.type)) return null;
  if (obj.type === 'zero_progress') {
    const d = numOrUndef(obj.deadline_sec);
    return d ? { type: 'zero_progress', deadline_sec: Math.floor(d) } : { type: 'zero_progress' };
  }
  if (obj.type === 'heartbeat_deadline') {
    const d = numOrUndef(obj.deadline_sec);
    if (!d) return null; // heartbeat_deadline REQUIRES a positive deadline
    return { type: 'heartbeat_deadline', deadline_sec: Math.floor(d) };
  }
  if (obj.type === 'phase_timeouts') {
    const f = numOrUndef(obj.fallback_sec);
    return f ? { type: 'phase_timeouts', fallback_sec: Math.floor(f) } : { type: 'phase_timeouts' };
  }
  return null;
}

/**
 * Resolve the effective policy for a run. An EXPLICIT liveness_policy always
 * wins (scenario-level over board-level) — an operator who set heartbeat_deadline
 * keeps it even if phases are defined. When neither scope sets an explicit policy
 * BUT a QA phase model is resolved for the run, auto-select `phase_timeouts` so
 * defining phases is enough to get per-phase timeouts (no separate policy write).
 * Otherwise fall back to the built-in `zero_progress` default. Each scope's raw
 * JSON is parsed independently so a malformed scenario policy falls through to the
 * board, then to the phase/default tiers.
 */
export function resolveLivenessPolicy(
  scenarioRaw: string | null | undefined,
  boardRaw: string | null | undefined,
  phases?: QaPhasesConfig | null,
): LivenessPolicy {
  const explicit = parseLivenessPolicy(scenarioRaw) ?? parseLivenessPolicy(boardRaw);
  if (explicit) return explicit;
  if (phases && phases.phases.length > 0) return { type: 'phase_timeouts' };
  return DEFAULT_LIVENESS_POLICY;
}
