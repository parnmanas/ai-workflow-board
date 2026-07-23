import { z } from 'zod';

/**
 * Per-ticket hard-budget configuration (ticket a940d75b).
 *
 * Mirrors the `common/respawn-storm-config.ts` shape (zod schema + parse/
 * validate/serialize/resolve) so a per-board `hard_budget_config` text column
 * reads and writes exactly like `respawn_storm_config` / `merge_gate_config`.
 *
 * Semantics — a content-agnostic ceiling on top of the existing pattern-based
 * guards. `applyAgentCommentPingPongGuard` (common/agent-comment-pingpong.ts)
 * only fires on a narrow waiting/no-target pattern repeated 3x; a slow-burn
 * loop that keeps posting DIFFERENT-looking agent comments, or a dispatch
 * storm of organically-completing (non-crashing) subagent runs, sails through
 * untouched. This config adds three independent ceilings:
 *   (a) max_auto_responses — lifetime cap on agent-authored, non-system
 *       comments on a single ticket (common/hard-budget-guard.ts,
 *       enforced at every MCP/REST comment-creation surface).
 *   (b) max_tokens_per_window — rolling-window cap on summed
 *       input_tokens+output_tokens across a ticket's `subagents` rows
 *       (ticket ef53fdf4, trigger-loop.service.ts). Deliberately shares
 *       window_minutes/the epoch rule with (c) below rather than getting its
 *       own token_window_minutes — one rolling window is simpler to reason
 *       about than two, and this feature is an emergency brake against acute
 *       runaway loops, not a long-term cost dashboard (that's
 *       AgentUsageService / WorkflowHealthDashboard, ticket 6dd3f968). See
 *       hard-budget-guard.ts's `countWindowTokens` for why
 *       cache_read/cache_creation tokens are excluded from the sum. A CLI
 *       that never reports usage (Antigravity, pre-6dd3f968 manager builds)
 *       leaves its `subagents` row's token columns NULL, so those dispatches
 *       are naturally excluded from the sum rather than counted as zero —
 *       this ceiling only ever sees CLIs that actually report usage.
 *   (c) max_dispatches_per_window — rolling-window cap on successful
 *       `_emitTrigger` dispatches for a single ticket (trigger-loop.service.ts).
 *
 * All three counters share one "epoch" rule: only events AFTER the ticket's
 * most recent human-driven unpend count (see `lastHumanUnpendAt` in
 * hard-budget-guard.ts). Without this, a breach auto-pends the ticket, a
 * human clears it, and the very next agent comment/dispatch/token re-trips
 * the same already-over-limit count — permanently killing the ticket.
 *
 * DEFAULT ON, but conservative — same safety-net posture as respawn-storm.
 * Thresholds are deliberately higher than respawn-storm's (5 deaths/30min)
 * because this counts NORMALLY-COMPLETING events, which have a much higher
 * organic rate than abnormal quick deaths.
 */
export const HardBudgetConfigSchema = z
  .object({
    /** Master switch for THIS board. Defaults on; set false to opt a board out. */
    enabled: z.boolean().optional(),
    /** (a) Lifetime cap on agent-authored, non-system comments per ticket (since the last human unpend). */
    max_auto_responses: z.number().int().positive().max(10000).optional(),
    /** (c) Sliding-window length, minutes, for the dispatch-rate cap. */
    window_minutes: z.number().int().positive().max(1440).optional(),
    /** (c) Successful-dispatch count inside the window that trips the breaker. */
    max_dispatches_per_window: z.number().int().positive().max(1000).optional(),
    /** (b) Summed input+output tokens inside the SAME window (window_minutes above) that trips the breaker. */
    max_tokens_per_window: z.number().int().positive().max(100_000_000).optional(),
    /** On breach: auto-pend the ticket (surfaces on the User tab, drops future triggers). */
    auto_pend: z.boolean().optional(),
    /** On breach: post a chat-room alert to the workspace. */
    notify: z.boolean().optional(),
  })
  .strict();

export type HardBudgetConfig = z.infer<typeof HardBudgetConfigSchema>;

export const HARD_BUDGET_CONFIG_KEYS = [
  'enabled',
  'max_auto_responses',
  'window_minutes',
  'max_dispatches_per_window',
  'max_tokens_per_window',
  'auto_pend',
  'notify',
] as const;

/** Fully-resolved config every guard/gate consumer reads (concrete values, ms-normalized). */
export interface ResolvedHardBudget {
  enabled: boolean;
  maxAutoResponses: number;
  windowMs: number;
  maxDispatchesPerWindow: number;
  maxTokensPerWindow: number;
  autoPend: boolean;
  notify: boolean;
}

/** Built-in defaults — conservative on purpose (see file header). */
export const DEFAULT_HARD_BUDGET: ResolvedHardBudget = {
  enabled: true,
  maxAutoResponses: 100,
  windowMs: 60 * 60_000,
  maxDispatchesPerWindow: 30,
  maxTokensPerWindow: 2_000_000,
  autoPend: true,
  notify: true,
};

/**
 * Fold environment overrides onto the built-in defaults. Same escape hatch
 * the respawn-storm / stuck detectors expose — lets an operator tune the
 * GLOBAL baseline without a code change. A per-board hard_budget_config then
 * overrides this baseline.
 */
export function hardBudgetDefaultsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedHardBudget {
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
    enabled: bool(env.HARD_BUDGET_ENABLED, DEFAULT_HARD_BUDGET.enabled),
    maxAutoResponses: num(env.HARD_BUDGET_MAX_AUTO_RESPONSES, DEFAULT_HARD_BUDGET.maxAutoResponses),
    windowMs: num(env.HARD_BUDGET_WINDOW_MINUTES, DEFAULT_HARD_BUDGET.windowMs / 60_000) * 60_000,
    maxDispatchesPerWindow: num(env.HARD_BUDGET_MAX_DISPATCHES_PER_WINDOW, DEFAULT_HARD_BUDGET.maxDispatchesPerWindow),
    maxTokensPerWindow: num(env.HARD_BUDGET_MAX_TOKENS_PER_WINDOW, DEFAULT_HARD_BUDGET.maxTokensPerWindow),
    autoPend: bool(env.HARD_BUDGET_AUTO_PEND, DEFAULT_HARD_BUDGET.autoPend),
    notify: bool(env.HARD_BUDGET_NOTIFY, DEFAULT_HARD_BUDGET.notify),
  };
}

/**
 * Parse a stored hard_budget_config text column. Returns null for null/empty/
 * malformed/schema-violating input — a corrupt row must degrade to "use the
 * baseline", never throw on a read path (same contract as parseRespawnStormConfig).
 */
export function parseHardBudgetConfig(raw: string | null | undefined): HardBudgetConfig | null {
  if (!raw) return null;
  try {
    const parsed = HardBudgetConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return isEmptyHardBudget(parsed.data) ? null : parsed.data;
  } catch {
    return null;
  }
}

/**
 * Resolve a stored config into the concrete values guards/gates read. A board
 * with no config (null / corrupt) inherits `base` verbatim (which is the
 * env-folded default). Any key the board set overrides `base`; unset keys keep
 * the baseline.
 */
export function resolveHardBudgetConfig(
  raw: string | null | undefined,
  base: ResolvedHardBudget = DEFAULT_HARD_BUDGET,
): ResolvedHardBudget {
  const cfg = parseHardBudgetConfig(raw);
  if (!cfg) return { ...base };
  return {
    enabled: cfg.enabled ?? base.enabled,
    maxAutoResponses: cfg.max_auto_responses ?? base.maxAutoResponses,
    windowMs: cfg.window_minutes != null ? cfg.window_minutes * 60_000 : base.windowMs,
    maxDispatchesPerWindow: cfg.max_dispatches_per_window ?? base.maxDispatchesPerWindow,
    maxTokensPerWindow: cfg.max_tokens_per_window ?? base.maxTokensPerWindow,
    autoPend: cfg.auto_pend ?? base.autoPend,
    notify: cfg.notify ?? base.notify,
  };
}

/**
 * Validate write-path input (REST PATCH body / MCP tool arg). Unlike
 * parseHardBudgetConfig this REJECTS bad input so the caller can 400 — silent
 * null-coercion on a write would make a typo'd key vanish without feedback
 * (same contract as validateRespawnStormConfigInput).
 */
export function validateHardBudgetConfigInput(
  input: unknown,
): { ok: true; value: HardBudgetConfig } | { ok: false; error: string } {
  const parsed = HardBudgetConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid hard_budget_config: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Serialize for storage: empty configs collapse to null (column stays null →
 * "inherit the baseline" stays representable as the single falsy state).
 */
export function serializeHardBudgetConfig(value: HardBudgetConfig | null | undefined): string | null {
  if (!value || isEmptyHardBudget(value)) return null;
  return JSON.stringify(value);
}

function isEmptyHardBudget(value: HardBudgetConfig): boolean {
  return HARD_BUDGET_CONFIG_KEYS.every(k => value[k] === undefined);
}
