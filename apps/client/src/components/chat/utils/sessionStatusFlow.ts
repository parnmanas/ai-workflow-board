// Keep-alive / background-task badge glue (ticket e18be8ff review round 1).
// Extracted out of ChatPage.tsx so the prune-on-expiry and
// restore-on-room-entry logic can be exercised without a full React/jsdom
// mount — same pattern as participantFlow.ts.

export interface SessionStatusEntry {
  name: string;
  keepAliveUntilMs: number | null;
  backgroundTaskCount: number;
}

export type SessionStatusByAgent = Record<string, SessionStatusEntry>;

export interface SessionStatusSnapshotRow {
  agent_id: string;
  agent_name: string;
  keep_alive_until_ms: number | null;
  background_task_count: number;
}

/** Mirrors the server-side liveness filter in chat-session-status.store.ts. */
export function isSessionStatusLive(entry: SessionStatusEntry, now: number): boolean {
  return (entry.keepAliveUntilMs !== null && entry.keepAliveUntilMs > now) || entry.backgroundTaskCount > 0;
}

/**
 * P1 #1 fix: drop any entry whose keep-alive deadline has passed and that has
 * no live background tasks, so a lost/late exit push can't leave a "잔여 0분"
 * badge stuck forever. Returns the same object reference when nothing changed
 * so callers can skip a re-render.
 */
export function pruneExpiredSessionStatus(prev: SessionStatusByAgent, now: number): SessionStatusByAgent {
  let changed = false;
  const next: SessionStatusByAgent = {};
  for (const [agentId, entry] of Object.entries(prev)) {
    if (isSessionStatusLive(entry, now)) {
      next[agentId] = entry;
    } else {
      changed = true;
    }
  }
  return changed ? next : prev;
}

/**
 * P1 #2 fix: build the room's badge state from a GET session-status snapshot
 * fetched on room load/re-entry, so an already-active keep-alive/background
 * task is visible immediately instead of only after the next SSE push.
 */
export function restoreSessionStatusSnapshot(rows: SessionStatusSnapshotRow[]): SessionStatusByAgent {
  const next: SessionStatusByAgent = {};
  for (const row of rows) {
    next[row.agent_id] = {
      name: row.agent_name || 'Agent',
      keepAliveUntilMs: row.keep_alive_until_ms,
      backgroundTaskCount: row.background_task_count,
    };
  }
  return next;
}
