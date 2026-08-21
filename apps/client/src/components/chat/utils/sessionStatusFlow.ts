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

/**
 * Review round 2, P1 #2 fix: the room-entry GET above is a snapshot read that
 * races the live SSE push — GET can read stale state A, a newer SSE B can
 * land first, and then the deferred GET(A) response would otherwise
 * unconditionally replace the map and stomp B back to A (or drop an agent B
 * added that A never had). `updatedAtSeq` is the caller's per-agent map of
 * "the monotonic sequence number assigned when `prev` was last set by SSE for
 * this agent"; `requestStartedSeq` is the sequence number captured when the
 * GET was issued.
 *
 * Review round 2 follow-up (P1 #2, second pass): this used to compare
 * `Date.now()` epoch-ms timestamps. Two events that land in the same
 * millisecond — a real possibility, not just a theoretical one, since a GET
 * can be issued and an SSE frame can be handled in the same tick — produced
 * equal timestamps, and `<=` then classified the SSE event as "not newer",
 * letting the snapshot wrongly stomp it. A caller-maintained monotonic
 * counter (see ChatPage.tsx's `sessionStatusSeqRef`) has no resolution floor:
 * every event gets its own strictly-increasing integer, so two events can
 * never tie, and "happened after the GET began" is always decidable. Any
 * agent SSE has touched since the GET began keeps whatever `prev` currently
 * holds instead of the snapshot row.
 */
export function mergeSessionStatusSnapshot(
  prev: SessionStatusByAgent,
  rows: SessionStatusSnapshotRow[],
  updatedAtSeq: Record<string, number>,
  requestStartedSeq: number,
): SessionStatusByAgent {
  const next = restoreSessionStatusSnapshot(rows);
  for (const agentId of Object.keys(updatedAtSeq)) {
    if (updatedAtSeq[agentId] <= requestStartedSeq) continue;
    if (prev[agentId]) {
      next[agentId] = prev[agentId];
    } else {
      delete next[agentId];
    }
  }
  return next;
}
