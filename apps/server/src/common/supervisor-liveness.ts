// Supervisor liveness / cadence policy (ticket 1fcba693).
//
// Pure helpers + policy constants, kept OUT of ticket-supervisor.service.ts so
// the same definitions can be unit-tested in isolation (mirrors the
// decideForceRespawn extraction) and so any future write-path guard and the
// supervisor tick agree on ONE definition of "reasonable supervisor_stale_ms"
// and of the fast re-dispatch floor.
//
// Why this exists — the incident (ticket 1fcba693):
//   A workspace carried supervisor_stale_ms = 14_400_000 (4 h), written at
//   runtime as a one-off band-aid during the 2026-07-01 exit-143 deathloop and
//   never reverted. Nothing in code ever produces that literal (entity +
//   migration default is 30 min); it lived only in the DB row. With a 4 h
//   window the TicketSupervisor — the ONLY backstop that re-dispatches a
//   ticket whose own edge-trigger was already consumed — waited up to 4 h
//   before even the FIRST re-push of a ticket whose strand had died / been
//   killed on a manager restart / never spawned. That is the "티켓이 3~4시간
//   간격으로 처리, 병렬 처리 증거 없음" incident.
//
// The stale window intentionally stays large-tunable: it governs how long a
// PRESENT-but-quiet strand is left alone before the force_respawn escalation,
// and force-killing a live-but-quiet worker is exactly the exit-143 deathloop
// the output-liveness gate (ticket fdc69c13 / 47a72129) closed. So we do NOT
// shrink it. Instead we decouple "nobody is working this ticket" detection
// from it, and make an over-large value observable.

/**
 * Entity / migration default for Workspace.supervisor_stale_ms (30 min).
 * Single source of truth — imported by TicketSupervisorService as its in-code
 * fallback and used here to derive the "surprisingly large" threshold.
 */
export const DEFAULT_SUPERVISOR_STALE_MS = 30 * 60_000; // 30 min

/**
 * Entity / migration default for Workspace.supervisor_resend_ms (5 min) — the
 * cooldown between supervisor re-pushes. Centralized here alongside the stale
 * default so the supervisor tick and the cadence diagnostic share ONE value.
 */
export const DEFAULT_SUPERVISOR_RESEND_MS = 5 * 60_000; // 5 min

/**
 * Default fast liveness-based re-dispatch floor (ms). When a stale allocation
 * has NO live strand (current_task absent / TTL-expired) AND NO recent
 * output-liveness — i.e. nobody is actually working it — the supervisor's FIRST
 * re-push fires after this floor instead of the full supervisor_stale_ms
 * window. The re-push is the ordinary non-force nudge and funnels through the
 * server's in-flight-strand gate (_emitTrigger drops it while hasLiveRoleStrand
 * is true) and, downstream, the agent-manager's provision-spanning single-flight
 * (one session per ticket:role:agent key), so a strand that IS live (or
 * mid-provision) simply drops the nudge — no double-spawn, no respawn storm, no
 * branch collision.
 */
export const DEFAULT_SUPERVISOR_LIVENESS_FLOOR_MS = 2 * 60_000; // 2 min

/**
 * The TicketSupervisor tick interval (ms). The supervisor is edge-agnostic: it
 * only re-evaluates every stale allocation once per tick, so a recovery
 * *threshold* being crossed is not observed until the NEXT tick — every real
 * recovery bound is therefore `threshold + up to one tick`. Exported as a shared
 * policy constant (single source of truth) so the tick loop and the cadence
 * diagnostic report the SAME number instead of a hard-coded 60_000 in each.
 */
export const SUPERVISOR_TICK_MS = 60_000; // 60 s

/**
 * Resolve the liveness floor, honoring the SUPERVISOR_LIVENESS_FLOOR_MS env
 * override for ops tuning (same pattern as StuckTicketDetectorService's env
 * knobs). Non-positive / non-finite → the default.
 */
export function resolveSupervisorLivenessFloorMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.SUPERVISOR_LIVENESS_FLOOR_MS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_SUPERVISOR_LIVENESS_FLOOR_MS;
}

/**
 * Threshold above which a supervisor_stale_ms is "surprisingly large" — well
 * beyond any normal cadence tuning and into the range where the value silently
 * paces stalled-ticket recovery off the supervisor backstop (the 1fcba693 4 h
 * incident). 4× the 30 min default = 2 h.
 *
 * NOT a hard cap: incident response legitimately raises the window into the
 * hours band for a while (see ticket 47a72129's 8 h test), so we never reject
 * or clamp the value — we flag it so a mis-set / units-bug / stale-band-aid
 * value can't persist unnoticed.
 */
export const SUPERVISOR_STALE_MS_SANE_MAX = 4 * DEFAULT_SUPERVISOR_STALE_MS; // 2 h

export type StaleMsTier = 'normal' | 'elevated';

/**
 * Classify a supervisor_stale_ms for observability. `elevated` means it exceeds
 * the sane-max and an operator should confirm it's intentional. Pure — unit
 * tested; consumed by the supervisor's once-per-workspace warn + gauge.
 */
export function classifySupervisorStaleMs(
  staleMs: number,
  saneMax: number = SUPERVISOR_STALE_MS_SANE_MAX,
): { tier: StaleMsTier; elevated: boolean } {
  const elevated = Number.isFinite(staleMs) && staleMs > saneMax;
  return { tier: elevated ? 'elevated' : 'normal', elevated };
}

/**
 * The supervisor's FIRST-re-push threshold for one stale allocation (ticket
 * 1fcba693).
 *
 *   - A stuck ticket (WAIT-loop, already throttled by the stuck detector) and a
 *     PRESENT / producing strand keep the full stale window — no behavior
 *     change, deathloop stays closed.
 *   - A stale allocation that NOBODY is working (absentStrand: no live strand
 *     AND no recent output) drops to the fast floor so a dead / killed /
 *     never-spawned session is re-dispatched in minutes, not the (possibly
 *     hours-long) stale window.
 *
 * Clamped so the floor never exceeds the workspace's own (possibly small)
 * stale window — a tiny stale window must still win. Pure — unit tested like
 * decideForceRespawn.
 */
export function resolveFirstPushThresholdMs(opts: {
  staleMs: number;
  livenessFloorMs: number;
  absentStrand: boolean;
  isStuck: boolean;
}): number {
  if (opts.absentStrand && !opts.isStuck) {
    return Math.min(opts.staleMs, opts.livenessFloorMs);
  }
  return opts.staleMs;
}

/**
 * Per-death-mode recovery numbers the current cadence implies (ticket 1fcba693).
 *
 * `thresholds` are the DETECTION thresholds — the staleness a stale allocation
 * must accrue before the supervisor's first re-push can fire for that death
 * mode, tick-EXCLUSIVE. `bounds` add `SUPERVISOR_TICK_MS` (the supervisor only
 * looks once per tick, so detection lags the threshold by up to one tick) to
 * give the actual OBSERVED upper bound. Splitting the two is the reviewer AC: a
 * field literally named `*_bounds_ms` must equal the value it claims.
 *
 *   - registry_absent  — no current_task at all (never spawned, or the manager
 *     cleared it on a clean exit / release). `absentStrand` is true immediately,
 *     so the first re-push fires at the fast liveness floor, clamped so it never
 *     exceeds the workspace's own (possibly smaller) stale window.
 *   - leaked_current_task — a current_task LEAKED by a dirty death (SIGTERM
 *     self-update with no drain, respawn child with no release listener,
 *     reap-without-exit) WITHOUT any recent output-liveness. hasLiveRoleStrand
 *     keeps counting it as LIVE until its TTL (`currentTaskStaleMs`) expires, so
 *     `absentStrand` — and the reclaim — only flip at that TTL. The gate is the
 *     TTL, NOT `min(stale, TTL)`: a stale window SMALLER than the TTL cannot
 *     reclaim a leaked seat any sooner, so clamping by stale would UNDER-report
 *     (e.g. stale=5 min still recovers a leak in 15 min, not 5).
 *   - leaked_with_output — a leaked current_task whose strand emitted model
 *     output RIGHT BEFORE dying (the COMMON silent-exit shape — a subagent
 *     almost always produces tokens up to the moment it is killed). This is the
 *     reviewer's correctness case, because `absentStrand = !hasLiveStrand &&
 *     !hasRecentOutput` needs BOTH gates to clear:
 *       · `!hasLiveStrand`   — current_task AND output both older than the TTL
 *         (hasLiveRoleStrand honors output-liveness within the TTL too), and
 *       · `!hasRecentOutput` — output older than `min(staleMs, outputTtl)`.
 *     So the seat is held NON-absent (un-reclaimed) until output ages past
 *     `max(currentTaskStaleMs, min(staleMs, outputLivenessTtlMs))` — NOT the
 *     bare 15 min TTL. On a large stale window this collapses to ~stale (a leak
 *     at 15 min that left output is only recovered ~stale later, not at the
 *     TTL). Reporting the TTL here (the old single leaked value) UNDER-reported
 *     this common path. Clearing output-liveness on a clean/sealed exit
 *     (AgentStatusService.clearCurrentTask) is what lets a properly-released
 *     seat skip this gate and recover at the fast floor / registry_absent
 *     instead — the value shrinks to the floor exactly when the manager can
 *     release the seat.
 *   - present_strand — a present / producing strand is paced off the full
 *     effective stale window (the output-liveness gate keeps a live-but-quiet
 *     worker safe), so this is the value's real observable harm.
 *
 * Pure — unit tested like resolveFirstPushThresholdMs.
 */
export interface RecoveryModeNumbers {
  registry_absent: number;
  leaked_current_task: number;
  leaked_with_output: number;
  present_strand: number;
}

export function resolveRecoveryModeMs(opts: {
  staleMs: number;
  livenessFloorMs: number;
  currentTaskStaleMs: number;
  outputLivenessTtlMs: number;
  tickMs?: number;
}): { thresholds: RecoveryModeNumbers; bounds: RecoveryModeNumbers } {
  const tick = opts.tickMs ?? SUPERVISOR_TICK_MS;
  // The output-liveness half of the absentStrand gate: hasRecentOutput compares
  // the last output age against min(staleMs, retention TTL). A leaked seat whose
  // strand left output before dying stays non-absent until this clears, so its
  // real recovery is max(TTL, this) — the current_task TTL never wins alone once
  // there is recent output. Retention is derived >= staleMs (resolveOutput-
  // LivenessTtlMs), so this equals staleMs in normal configs and only caps a
  // pathological staleMs past the retention ceiling.
  const outputGate = Math.min(opts.staleMs, opts.outputLivenessTtlMs);
  const thresholds: RecoveryModeNumbers = {
    registry_absent: Math.min(opts.staleMs, opts.livenessFloorMs),
    leaked_current_task: opts.currentTaskStaleMs,
    leaked_with_output: Math.max(opts.currentTaskStaleMs, outputGate),
    present_strand: opts.staleMs,
  };
  return {
    thresholds,
    bounds: {
      registry_absent: thresholds.registry_absent + tick,
      leaked_current_task: thresholds.leaked_current_task + tick,
      leaked_with_output: thresholds.leaked_with_output + tick,
      present_strand: thresholds.present_strand + tick,
    },
  };
}
