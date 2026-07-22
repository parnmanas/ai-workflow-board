// Accumulate per-turn CliUsageSnapshot values into a running total for the
// lifetime of one subagent/session record (ticket 6dd3f968). Each `result` /
// `turn.completed` event describes ONE API call's tokens (input grows with
// context but is not itself a running session total), so a persistent Claude
// session with many turns must SUM across every observed event to reflect the
// whole process's real cost — confirmed empirically: `base-session-manager.ts`
// already keys turn-end detection off the same per-turn `result` event, so a
// long ticket session emits many of them, not one at process death.

import type { CliUsageSnapshot } from './cli-adapters/base.js';

function sumNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Fold `next` into `acc`, summing every present field. `null` in both stays
 *  `null` (e.g. Codex's `total_cost_usd`, which never has a value to sum). A
 *  `null` `next` is a no-op — callers pass whatever `extractUsage` returned,
 *  including null for lines that carry no usage. */
export function accumulateUsage(
  acc: CliUsageSnapshot | null,
  next: CliUsageSnapshot | null,
): CliUsageSnapshot | null {
  if (!next) return acc;
  if (!acc) return { ...next };
  return {
    input_tokens: sumNullable(acc.input_tokens, next.input_tokens),
    output_tokens: sumNullable(acc.output_tokens, next.output_tokens),
    cache_read_input_tokens: sumNullable(acc.cache_read_input_tokens, next.cache_read_input_tokens),
    cache_creation_input_tokens: sumNullable(acc.cache_creation_input_tokens, next.cache_creation_input_tokens),
    total_cost_usd: sumNullable(acc.total_cost_usd, next.total_cost_usd),
  };
}
