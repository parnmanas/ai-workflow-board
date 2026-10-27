import type { AgentSessionEventRecord } from '../../types';

export interface SessionLimitWindow {
  key: string;
  limitName: string;
  id: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
  observedAt: string;
}

/** Quotas are snapshots, never sums. Late history must not replace newer reports. */
export function sessionLimitWindows(events: AgentSessionEventRecord[]): SessionLimitWindow[] {
  const latest = new Map<string, { at: number; windows: SessionLimitWindow[] }>();
  for (const event of events) {
    if (event.type !== 'usage_limits') continue;
    const p = event.payload;
    if (!p || typeof p.limit_id !== 'string' || !Array.isArray(p.windows) || typeof p.observed_at !== 'string') continue;
    const at = Date.parse(p.observed_at);
    if (!Number.isFinite(at) || at < (latest.get(p.limit_id)?.at ?? 0)) continue;
    const windows: SessionLimitWindow[] = [];
    for (const w of p.windows.slice(0, 8)) {
      if (!w || typeof w.id !== 'string' || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent) || w.used_percent < 0) continue;
      windows.push({
        key: `${p.limit_id}:${w.id}`,
        limitName: typeof p.limit_name === 'string' ? p.limit_name : '',
        id: w.id,
        usedPercent: Math.min(100, w.used_percent),
        windowMinutes: typeof w.window_minutes === 'number' && Number.isFinite(w.window_minutes) && w.window_minutes > 0 ? w.window_minutes : null,
        resetsAt: typeof w.resets_at === 'string' && Number.isFinite(Date.parse(w.resets_at)) ? w.resets_at : null,
        observedAt: p.observed_at,
      });
    }
    if (windows.length) latest.set(p.limit_id, { at, windows });
  }
  return [...latest.values()].slice(-8).flatMap((value) => value.windows);
}

/** Focus reads are bounded metadata snapshots and can arrive behind a newer read or SSE. */
export function mergeSessionLimitEvents(current: AgentSessionEventRecord[], incoming: AgentSessionEventRecord[]): AgentSessionEventRecord[] {
  const latest = new Map<string, AgentSessionEventRecord>();
  for (const event of [...current, ...incoming]) {
    if (sessionLimitWindows([event]).length === 0) continue;
    const id = event.payload.limit_id;
    const previous = latest.get(id);
    if (!previous || Date.parse(event.payload.observed_at) >= Date.parse(previous.payload.observed_at)) latest.set(id, event);
  }
  return [...latest.values()].sort((a, b) => Date.parse(a.payload.observed_at) - Date.parse(b.payload.observed_at)).slice(-8);
}
