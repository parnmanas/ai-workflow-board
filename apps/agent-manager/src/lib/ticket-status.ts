// Board-less ticket status (docs/tickets.md) — the manager-side mirror of the
// server's `common/ticket-status.ts`. agent-manager is a separate package, so the
// fixed set is copied here (same posture as HarnessSpec / CloneWirePolicy) and
// every consumer imports it from this ONE module instead of typing literals.
//
// Old servers (board/column model) never put `status` on `agent_trigger`, while
// their REST ticket still carries a LEGACY root `status` that must NOT be read as
// workflow state. So the "status mode" switch is the TRIGGER's status (stamped
// on the ticket as `__awb_status`), and a REST `status` only counts when the
// ticket has no column snapshot at all (a board-less server's ticket).

export const TICKET_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
export type TicketStatus = typeof TICKET_STATUSES[number];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

/** The terminal status — entering it triggers the ticket's Git cleanup. */
export const TERMINAL_TICKET_STATUS: TicketStatus = 'done';

/** Narrow an arbitrary wire value to a known status, else null. Never throws. */
export function parseTicketStatus(raw: unknown): TicketStatus | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return (TICKET_STATUSES as readonly string[]).includes(value) ? value as TicketStatus : null;
}

/** A board-less ticket: no board, and no real column (a `status:<s>` column id
 *  is the board-less server's derived compatibility snapshot). */
export function isBoardlessTicket(ticket: any): boolean {
  if (!ticket || typeof ticket !== 'object') return false;
  if (ticket.board_id || ticket.board?.id) return false;
  const columnId = typeof ticket.current_column_id === 'string' ? ticket.current_column_id : '';
  return !columnId || columnId.startsWith('status:');
}

/**
 * The ticket's authoritative board-less status, or null for a column-model
 * (old server) ticket. `__awb_status` is stamped by the dispatcher from the
 * trigger envelope; a bare `status` is trusted only on a board-less ticket (a
 * board ticket's legacy root `status` sits next to its board/column).
 */
export function ticketWorkflowStatus(ticket: any): TicketStatus | null {
  if (!ticket || typeof ticket !== 'object') return null;
  const stamped = parseTicketStatus(ticket.__awb_status);
  if (stamped) return stamped;
  return isBoardlessTicket(ticket) ? parseTicketStatus(ticket.status) : null;
}

/** The column snapshot a board-less server derives from status (docs/tickets.md
 *  → SSE agent_trigger). Used only when a status payload arrives without one. */
export function columnFromStatus(status: TicketStatus): { id: string; name: string; kind: string } {
  return {
    id: `status:${status}`,
    name: TICKET_STATUS_LABELS[status],
    kind: status === TERMINAL_TICKET_STATUS ? 'terminal' : 'active',
  };
}

/** A `board_update` that changes the ticket's workflow position. Column servers
 *  emit `moved`; a board-less server may report the same transition as `moved`,
 *  `status_changed`, or an `updated` whose `field_changed` is `status`. */
export function isTicketStatusMove(ev: any): boolean {
  if (ev?.entity_type !== 'ticket') return false;
  if (ev.action === 'moved' || ev.action === 'status_changed') return true;
  return ev.action === 'updated' && ev.field_changed === 'status';
}
