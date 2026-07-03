import { z } from 'zod';

/**
 * Respawn-storm circuit-breaker configuration (ticket ab06eac2).
 *
 * Mirrors the `common/merge-gate-config.ts` shape (zod schema + parse/validate/
 * serialize/resolve) so a per-board `respawn_storm_config` text column reads and
 * writes exactly like `merge_gate_config` / `harness_config`.
 *
 * Semantics — a cause-agnostic last line of defence against death-loops.
 * Individual respawn bugs (watchdog false-positive self-kill 876b7679,
 * supervisor force_respawn blindness fdc69c13, gemini exit-41 re-dispatch
 * 672f6fc7, twin-echo spawns) were each fixed at the source, but there was no
 * general layer that notices "the same (ticket,role) is dying abnormally fast,
 * over and over, with zero forward progress". The detector counts those deaths
 * off the durable `subagents` table and, past a threshold, halts the ticket
 * (pend) + alerts + writes a first-class `respawn_storm_halted` activity row.
 *
 * DEFAULT ON, but conservative — this is a safety net whose whole value is
 * catching the NEXT unknown variant without a human first wiring it up, so
 * `enabled` defaults true. The thresholds are deliberately high (5 abnormal
 * QUICK deaths inside 30 min) and the detector NEVER flags a storm when there
 * is any forward-progress signal (a fresh non-system comment or a column
 * move). It also only counts "즉사"-shaped deaths — a subagent that ran longer
 * than `quick_death_seconds` is treated as productive-enough and excluded, so a
 * legitimately slow-but-working task that gets killed is never mistaken for a
 * crash loop (watchdog false-positive lesson, DoD 오탐 회귀).
 */
export const RespawnStormConfigSchema = z
  .object({
    /** Master switch for THIS board. Defaults on; set false to opt a board out. */
    enabled: z.boolean().optional(),
    /** Sliding-window length, minutes. Deaths older than this don't count. */
    window_minutes: z.number().int().positive().max(1440).optional(),
    /** Abnormal quick-death count inside the window that trips the breaker. */
    min_deaths: z.number().int().min(2).max(100).optional(),
    /**
     * A death only counts toward the storm when the subagent ran SHORTER than
     * this (즉사). A longer run = real work happened → excluded, so slow-but-
     * productive strands that die are never mistaken for a crash loop.
     */
    quick_death_seconds: z.number().int().positive().max(3600).optional(),
    /** On storm: auto-pend the ticket (surfaces on the User tab, drops future triggers). */
    auto_pend: z.boolean().optional(),
    /** On storm / twin: post a chat-room alert to the workspace. */
    notify: z.boolean().optional(),
    /** Detect 2+ concurrent live strands on the same (ticket,role). */
    detect_twins: z.boolean().optional(),
    /**
     * When a twin is detected, additionally record an autostop-intent event for
     * the late strand. The actual process-kill lives in the agent-manager
     * spawn-dedup (52e581ce / 66bddd2e); the server layer is the last-resort
     * detector, so this only surfaces intent unless that path consumes it.
     */
    auto_stop_late_twin: z.boolean().optional(),
  })
  .strict();

export type RespawnStormConfig = z.infer<typeof RespawnStormConfigSchema>;

export const RESPAWN_STORM_CONFIG_KEYS = [
  'enabled',
  'window_minutes',
  'min_deaths',
  'quick_death_seconds',
  'auto_pend',
  'notify',
  'detect_twins',
  'auto_stop_late_twin',
] as const;

/** Fully-resolved config every detector consumer reads (concrete values, ms-normalized). */
export interface ResolvedRespawnStorm {
  enabled: boolean;
  windowMs: number;
  minDeaths: number;
  quickDeathMs: number;
  autoPend: boolean;
  notify: boolean;
  detectTwins: boolean;
  autoStopLateTwin: boolean;
}

/** Built-in defaults — conservative on purpose (see file header). */
export const DEFAULT_RESPAWN_STORM: ResolvedRespawnStorm = {
  enabled: true,
  windowMs: 30 * 60_000,
  minDeaths: 5,
  quickDeathMs: 120_000,
  autoPend: true,
  notify: true,
  detectTwins: true,
  autoStopLateTwin: false,
};

/**
 * Fold environment overrides onto the built-in defaults. Lets an operator tune
 * the GLOBAL baseline (before any per-board config) without a code change —
 * same escape hatch the stuck-detector exposes. A per-board respawn_storm_config
 * then overrides this baseline.
 */
export function respawnStormDefaultsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRespawnStorm {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const bool = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw == null) return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '') return fallback;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return true;
  };
  return {
    enabled: bool(env.RESPAWN_STORM_ENABLED, DEFAULT_RESPAWN_STORM.enabled),
    windowMs: num(env.RESPAWN_STORM_WINDOW_MINUTES, DEFAULT_RESPAWN_STORM.windowMs / 60_000) * 60_000,
    minDeaths: num(env.RESPAWN_STORM_MIN_DEATHS, DEFAULT_RESPAWN_STORM.minDeaths),
    quickDeathMs: num(env.RESPAWN_STORM_QUICK_DEATH_SECONDS, DEFAULT_RESPAWN_STORM.quickDeathMs / 1000) * 1000,
    autoPend: bool(env.RESPAWN_STORM_AUTO_PEND, DEFAULT_RESPAWN_STORM.autoPend),
    notify: bool(env.RESPAWN_STORM_NOTIFY, DEFAULT_RESPAWN_STORM.notify),
    detectTwins: bool(env.RESPAWN_STORM_DETECT_TWINS, DEFAULT_RESPAWN_STORM.detectTwins),
    autoStopLateTwin: bool(env.RESPAWN_STORM_AUTO_STOP_LATE_TWIN, DEFAULT_RESPAWN_STORM.autoStopLateTwin),
  };
}

/**
 * Parse a stored respawn_storm_config text column. Returns null for null/empty/
 * malformed/schema-violating input — a corrupt row must degrade to "use the
 * baseline", never throw on a read path (same contract as parseMergeGateConfig).
 */
export function parseRespawnStormConfig(raw: string | null | undefined): RespawnStormConfig | null {
  if (!raw) return null;
  try {
    const parsed = RespawnStormConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return isEmptyRespawnStorm(parsed.data) ? null : parsed.data;
  } catch {
    return null;
  }
}

/**
 * Resolve a stored config into the concrete values the detector reads. A board
 * with no config (null / corrupt) inherits `base` verbatim (which is the
 * env-folded default). Any key the board set overrides `base`; unset keys keep
 * the baseline — so `{min_deaths: 8}` raises just the threshold and leaves
 * everything else at the default.
 */
export function resolveRespawnStormConfig(
  raw: string | null | undefined,
  base: ResolvedRespawnStorm = DEFAULT_RESPAWN_STORM,
): ResolvedRespawnStorm {
  const cfg = parseRespawnStormConfig(raw);
  if (!cfg) return { ...base };
  return {
    enabled: cfg.enabled ?? base.enabled,
    windowMs: cfg.window_minutes != null ? cfg.window_minutes * 60_000 : base.windowMs,
    minDeaths: cfg.min_deaths ?? base.minDeaths,
    quickDeathMs: cfg.quick_death_seconds != null ? cfg.quick_death_seconds * 1000 : base.quickDeathMs,
    autoPend: cfg.auto_pend ?? base.autoPend,
    notify: cfg.notify ?? base.notify,
    detectTwins: cfg.detect_twins ?? base.detectTwins,
    autoStopLateTwin: cfg.auto_stop_late_twin ?? base.autoStopLateTwin,
  };
}

/**
 * Validate write-path input (REST PATCH body / MCP tool arg). Unlike
 * parseRespawnStormConfig this REJECTS bad input so the caller can 400 — silent
 * null-coercion on a write would make a typo'd key vanish without feedback
 * (same contract as validateMergeGateConfigInput).
 */
export function validateRespawnStormConfigInput(
  input: unknown,
): { ok: true; value: RespawnStormConfig } | { ok: false; error: string } {
  const parsed = RespawnStormConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid respawn_storm_config: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Serialize for storage: empty configs collapse to null (column stays null →
 * "inherit the baseline" stays representable as the single falsy state).
 */
export function serializeRespawnStormConfig(value: RespawnStormConfig | null | undefined): string | null {
  if (!value || isEmptyRespawnStorm(value)) return null;
  return JSON.stringify(value);
}

function isEmptyRespawnStorm(value: RespawnStormConfig): boolean {
  return RESPAWN_STORM_CONFIG_KEYS.every(k => value[k] === undefined);
}
