import { isRecord } from '../../agent-session-history.js';
import type { SessionUsageLimits } from '../../session-usage-limits.js';

/** Codex rollout token_count carries quota even when token info is null. */
export function codexUsageLimits(record: unknown): SessionUsageLimits | null {
  if (!isRecord(record) || record.type !== 'event_msg' || record.payload?.type !== 'token_count') return null;
  const limits = record.payload.rate_limits;
  if (!isRecord(limits) || typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp))) return null;
  const windows: SessionUsageLimits['windows'] = [];
  for (const id of ['primary', 'secondary']) {
    const window = limits[id];
    if (!isRecord(window) || typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent) || window.used_percent < 0) continue;
    const reset = typeof window.resets_at === 'number' && window.resets_at > 0 ? new Date(window.resets_at * 1000) : null;
    windows.push({
      id,
      used_percent: Math.min(100, window.used_percent),
      window_minutes: typeof window.window_minutes === 'number' && Number.isFinite(window.window_minutes) && window.window_minutes > 0 ? window.window_minutes : null,
      resets_at: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
    });
  }
  if (!windows.length) return null;
  return {
    limit_id: typeof limits.limit_id === 'string' ? limits.limit_id.slice(0, 100) : 'codex',
    ...(typeof limits.limit_name === 'string' && limits.limit_name ? { limit_name: limits.limit_name.slice(0, 100) } : {}),
    observed_at: new Date(record.timestamp).toISOString(),
    windows,
  };
}
