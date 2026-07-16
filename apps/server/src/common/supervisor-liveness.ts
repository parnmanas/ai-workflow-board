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
 * Default fast liveness-based re-dispatch floor (ms). When a stale allocation
 * has NO live strand (current_task absent / TTL-expired) AND NO recent
 * output-liveness — i.e. nobody is actually working it — the supervisor's FIRST
 * re-push fires after this floor instead of the full supervisor_stale_ms
 * window. The re-push is the ordinary non-force nudge and funnels through
 * _emitTrigger's in-flight-strand + provisioning single-flight gates, so a
 * strand that IS live (or mid-provision) simply drops the nudge — no
 * double-spawn, no respawn storm, no branch collision.
 */
export const DEFAULT_SUPERVISOR_LIVENESS_FLOOR_MS = 2 * 60_000; // 2 min

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
