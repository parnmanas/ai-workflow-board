/**
 * Ticket lifecycle — the fixed status set that replaced board columns
 * (docs/tickets.md). Every status comparison in the server imports from here;
 * never type a status literal somewhere else.
 *
 *   backlog     → not ready, never dispatched
 *   todo        → queued for the assignee; the dispatcher starts it
 *   in_progress → the assignee is working on it
 *   review      → the agent finished and wants a human to look
 *   done        → finished (terminal)
 */

export const TICKET_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

export const DEFAULT_TICKET_STATUS: TicketStatus = 'todo';
export const DONE_STATUS: TicketStatus = 'done';

/** Statuses an agent may be working in — anything not finished and not parked in backlog. */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = ['todo', 'in_progress', 'review'];

export function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === 'string' && (TICKET_STATUSES as readonly string[]).includes(value);
}

/**
 * Loose input → status. Accepts the canonical id, its label, and the old
 * column names agents still say out of habit ("In Progress", "Done",
 * "Merging"…) so a `move_ticket` from an older prompt lands somewhere sane.
 * Returns null for anything else — callers reject, they never guess.
 */
export function parseTicketStatus(value: unknown): TicketStatus | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return null;
  if (isTicketStatus(key)) return key;
  const aliases: Record<string, TicketStatus> = {
    to_do: 'todo',
    ready: 'todo',
    plan: 'todo',
    planning: 'todo',
    inprogress: 'in_progress',
    doing: 'in_progress',
    working: 'in_progress',
    merging: 'in_progress',
    in_review: 'review',
    intake: 'backlog',
    complete: 'done',
    completed: 'done',
    closed: 'done',
  };
  return aliases[key] ?? null;
}

export function isDoneStatus(status: string | null | undefined): boolean {
  return status === DONE_STATUS;
}

/** Any pending flag parks a ticket: no dispatch, no capacity slot. */
export function isTicketPending(ticket: {
  pending_user_action?: boolean | null;
  pending_on_tickets?: boolean | null;
  pending_ci_wait?: boolean | null;
}): boolean {
  return !!(ticket.pending_user_action || ticket.pending_on_tickets || ticket.pending_ci_wait);
}

/**
 * Legacy column projection of a status, still put on `agent_trigger` /
 * `board_update` so agent-managers that predate the board removal keep
 * dispatching (they require `current_column_id/_name/_kind`).
 */
export function statusColumnProjection(status: TicketStatus): {
  current_column_id: string;
  current_column_name: string;
  current_column_kind: string;
} {
  return {
    current_column_id: `status:${status}`,
    current_column_name: TICKET_STATUS_LABELS[status],
    current_column_kind: status === 'done' ? 'terminal' : status === 'backlog' ? 'intake' : status === 'review' ? 'review' : 'active',
  };
}
