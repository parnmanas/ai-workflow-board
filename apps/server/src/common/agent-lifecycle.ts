// Agent lifecycle state model (ticket bfdd80b7).
//
// WHY THIS EXISTS
// Before this, an agent's liveness was a single boolean `is_online` derived from
// `last_seen_at` recency. That collapsed two very different situations into one:
//   - "created but never started" (`connected_at IS NULL`, never spawned), and
//   - "was running, now stopped/offline" (`connected_at` set, heartbeat stale).
// Both present as `is_online = 0`, so a user sending a chat / assigning a ticket
// to a never-started agent got no signal at all — the exact silent-drop this
// ticket fixes. A named lifecycle state makes the difference visible in the UI
// and drives the auto-start / feedback decision on the dispatch + chat paths.
//
// Pure + dependency-free so the server (AgentStatusService wire projection,
// AgentAutostartService dispatch decision) and unit tests share ONE definition.

/**
 * User-facing agent lifecycle state. Precedence when several signals hold at
 * once is encoded in `deriveAgentLifecycleState`:
 *   online > error > starting > never_started > offline
 *
 *   - never_started — registered (a DB row exists) but never connected once.
 *                     `connected_at IS NULL`. A Start is required.
 *   - starting      — a spawn_agent was just dispatched (auto-start or manual)
 *                     and the agent has not reported online yet. Transient.
 *   - online        — heartbeating / reachable right now.
 *   - offline       — was online before (`connected_at` set) but the heartbeat
 *                     went stale. A Start (or manager reconnect) is required.
 *   - error         — the most recent (auto-)start attempt failed (manager
 *                     offline, no working dir, spawn error). Actionable: the
 *                     failure reason is surfaced alongside.
 */
export type AgentLifecycleState =
  | 'never_started'
  | 'starting'
  | 'online'
  | 'offline'
  | 'error';

/**
 * Why an auto-start attempt cannot proceed (or `ok` when it can). Kept next to
 * the state type so the dispatch/chat feedback copy and the tests share one
 * vocabulary.
 *   - ok               — a live manager supervises the agent and a working dir
 *                        is set; spawn_agent can be issued.
 *   - already_live     — the agent is already reachable; nothing to start.
 *   - no_manager_linked— the agent has no `manager_agent_id`; nothing can spawn
 *                        it automatically (standalone / bare-proxy agent).
 *   - manager_offline  — a manager is linked but no live manager instance is
 *                        heartbeating, so the spawn command would no-op.
 *   - no_working_dir   — a live manager exists but the agent has no working_dir;
 *                        the manager refuses to spawn without one.
 */
export type AutostartFeasibility =
  | 'ok'
  | 'already_live'
  | 'no_manager_linked'
  | 'manager_offline'
  | 'no_working_dir';

export interface AgentLifecycleInput {
  /** Reachable / heartbeating right now (DB `is_online` OR a live instance). */
  isOnline: boolean;
  /** Agent.connected_at — null iff the agent has never connected once. */
  connectedAt: Date | string | null | undefined;
  /** A spawn was recently dispatched and the agent has not come online yet. */
  isStarting?: boolean;
  /** The most recent (auto-)start attempt failed and the agent is still down. */
  hasRecentStartError?: boolean;
}

/**
 * Classify an agent's lifecycle state from its liveness signals. Pure.
 *
 * Precedence rationale: an agent that is reachable is `online` regardless of any
 * stale start marker. A failed start is more actionable than a pending one, so
 * `error` outranks `starting`. `never_started` vs `offline` is the whole point
 * of this ticket and is decided solely by whether the agent ever connected.
 */
export function deriveAgentLifecycleState(input: AgentLifecycleInput): AgentLifecycleState {
  if (input.isOnline) return 'online';
  if (input.hasRecentStartError) return 'error';
  if (input.isStarting) return 'starting';
  const neverConnected = input.connectedAt === null || input.connectedAt === undefined;
  return neverConnected ? 'never_started' : 'offline';
}

/** True for states where the agent cannot currently receive a dispatch/chat and
 *  therefore needs auto-start and/or user-facing feedback. */
export function isUnreachableState(state: AgentLifecycleState): boolean {
  return state === 'never_started' || state === 'offline' || state === 'error';
}

/**
 * Short human label per state — Korean, matching the board's output language.
 * Used by both the ticket-activity / chat feedback copy and (mirrored) the
 * client badge, so server-authored messages read consistently with the UI.
 */
export function agentLifecycleLabel(state: AgentLifecycleState): string {
  switch (state) {
    case 'never_started': return '미시작';
    case 'starting': return '시작 중';
    case 'online': return 'online';
    case 'offline': return 'offline';
    case 'error': return '오류';
  }
}

/**
 * Human explanation for why auto-start could not run — surfaced to the user in
 * the chat system message / ticket activity so "왜 안 되는지" is always visible.
 *
 * `reason` is widened to `string` (ticket 1f750878): besides the known
 * AutostartFeasibility slugs, the manager-side spawn-failure ack carries a
 * free-form `detail` (e.g. "spawn_agent: working_dir is empty …") that
 * `markStartError` stores and `_emit` surfaces as `lifecycle_detail`. An
 * unrecognized reason falls through to the raw string so that concrete
 * manager failure detail stays visible rather than collapsing to undefined.
 */
export function autostartFeasibilityLabel(reason: string): string {
  switch (reason) {
    case 'ok': return '자동 시작을 시도합니다';
    case 'already_live': return '이미 온라인입니다';
    case 'no_manager_linked': return 'Agent Manager 가 연결되어 있지 않아 자동 시작할 수 없습니다 (수동 Start 필요)';
    case 'manager_offline': return 'Agent Manager 가 오프라인이라 자동 시작할 수 없습니다 (매니저 기동 후 Start 필요)';
    case 'no_working_dir': return 'working_dir 가 설정되지 않아 자동 시작할 수 없습니다 (관리자 설정 필요)';
    // Manager-side runtime spawn failure (post-dispatch) — the ack detail is
    // already human-readable; pass it through so the specific cause is shown.
    default: return reason;
  }
}
