/**
 * Shared priority helpers for the dispatch path.
 *
 * `priority_index` is the SINGLE sort key for the trigger queue and the
 * supervisor's stale-allocation re-push order. Anywhere in apps/server/src
 * that needs to compare ticket priorities MUST go through `priorityIndex()`
 * — comparing `Ticket.priority` strings (`'critical' / 'high' / ...`)
 * directly is forbidden and will fail the v0.41 acceptance grep.
 *
 * The order is fixed (lower = higher priority):
 *   0 critical
 *   1 high
 *   2 medium
 *   3 low
 *   4 unknown / fallback
 *
 * It must stay in sync with the plugin-side ordering and with
 * AllocationService.PRIORITY_ORDER.
 */

export const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

/** Index of the priority string in PRIORITY_ORDER. Falls back to PRIORITY_ORDER.length for unknown values; null/empty defaults to 'medium'. */
export function priorityIndex(p: string | null | undefined): number {
  const s = (p || 'medium').toLowerCase();
  const i = (PRIORITY_ORDER as readonly string[]).indexOf(s);
  return i >= 0 ? i : PRIORITY_ORDER.length;
}
