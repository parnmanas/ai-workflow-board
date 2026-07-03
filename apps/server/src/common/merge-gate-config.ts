import { z } from 'zod';

/**
 * Merge/integration gate configuration (ticket c806bad3).
 *
 * Mirrors the `common/harness-config.ts` shape (zod schema + parse/validate/
 * serialize) so a per-board `merge_gate_config` text column reads and writes
 * exactly like `harness_config` / `effort_presets`.
 *
 * Semantics — a board opts INTO a mechanical integration gate on the Merging
 * column boundary. Merge quality is otherwise entirely prompt-driven +
 * agent-self-report; this moves the checks the merging prompt only *asks* for
 * into server code that actually *blocks*:
 *   - `require_fresh_base` — a Review→Merging move is rejected when the
 *     ticket's feature branch is BEHIND base (stale-base). The reviewer looked
 *     at a diff cut from an old base; require a rebase first.
 *   - `require_full_merge` — a Merging→Done move is rejected when the feature
 *     branch still carries commits NOT in base (partial-merge). Catches the
 *     "merged 1 of 6 commits, called it Done" class of accident.
 *
 * DEFAULT OFF: `enabled` defaults false and every check defaults true *only
 * when enabled*. A board with no `merge_gate_config` (null) — every board
 * today — behaves exactly as before (DoD "게이트 미설정 보드는 기존 동작
 * 불변"). The check itself also degrades to a pass whenever the repo / base /
 * feature branch can't be resolved, so enabling it never manufactures a
 * false block on a ticket the server can't actually verify.
 */
export const MergeGateConfigSchema = z
  .object({
    /** Master switch. Everything below is inert while this is false. */
    enabled: z.boolean().optional(),
    /** Block Review→Merging when the feature branch is behind base. */
    require_fresh_base: z.boolean().optional(),
    /** Block Merging→Done when the feature branch isn't fully merged into base. */
    require_full_merge: z.boolean().optional(),
  })
  .strict();

export type MergeGateConfig = z.infer<typeof MergeGateConfigSchema>;

export const MERGE_GATE_CONFIG_KEYS = [
  'enabled',
  'require_fresh_base',
  'require_full_merge',
] as const;

/** A board with the gate enabled but no explicit per-check toggles gates BOTH
 *  checks — enabling the gate at all is the opt-in signal, individual checks
 *  are on unless a board deliberately turns one off. */
export interface ResolvedMergeGate {
  enabled: boolean;
  require_fresh_base: boolean;
  require_full_merge: boolean;
}

/**
 * Parse a stored merge_gate_config text column. Returns null for null/empty/
 * malformed/schema-violating input — a corrupt row must degrade to "no gate",
 * never throw on a read path (same contract as parseHarnessConfig).
 */
export function parseMergeGateConfig(raw: string | null | undefined): MergeGateConfig | null {
  if (!raw) return null;
  try {
    const parsed = MergeGateConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return isEmptyMergeGate(parsed.data) ? null : parsed.data;
  } catch {
    return null;
  }
}

/**
 * Resolve the stored config into concrete booleans every gate consumer reads.
 * `enabled` false (or config absent) → both checks off. When enabled, a check
 * is ON unless the board explicitly set it false — so `{enabled:true}` gates
 * both checks, `{enabled:true, require_full_merge:false}` gates only the
 * stale-base check.
 */
export function resolveMergeGate(raw: string | null | undefined): ResolvedMergeGate {
  const cfg = parseMergeGateConfig(raw);
  const enabled = cfg?.enabled === true;
  if (!enabled) {
    return { enabled: false, require_fresh_base: false, require_full_merge: false };
  }
  return {
    enabled: true,
    require_fresh_base: cfg?.require_fresh_base !== false,
    require_full_merge: cfg?.require_full_merge !== false,
  };
}

/**
 * Validate write-path input (REST PATCH body / MCP tool arg). Unlike
 * parseMergeGateConfig this REJECTS bad input so the caller can 400 — silent
 * null-coercion on a write would make a typo'd key vanish without feedback
 * (same contract as validateHarnessConfigInput).
 */
export function validateMergeGateConfigInput(
  input: unknown,
): { ok: true; value: MergeGateConfig } | { ok: false; error: string } {
  const parsed = MergeGateConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid merge_gate_config: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Serialize for storage: empty configs collapse to null (column stays null →
 * "no gate" stays representable as the single falsy state).
 */
export function serializeMergeGateConfig(value: MergeGateConfig | null | undefined): string | null {
  if (!value || isEmptyMergeGate(value)) return null;
  return JSON.stringify(value);
}

function isEmptyMergeGate(value: MergeGateConfig): boolean {
  return MERGE_GATE_CONFIG_KEYS.every(k => value[k] === undefined);
}
