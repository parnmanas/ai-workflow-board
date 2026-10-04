// Ticket lifecycle — client mirror of `apps/server/src/common/ticket-status.ts`
// (docs/tickets.md). Boards/columns are gone; every ticket sits in exactly one
// of these fixed statuses. Never compare against a status literal typed by hand
// elsewhere — import from here. React-free so `node --test` can import it.

export const TICKET_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

/** Lane dot / pill colour per status (kanban lane header, list view, panel select). */
export const TICKET_STATUS_COLORS: Record<TicketStatus, string> = {
  backlog: '#64748b',
  todo: '#60a5fa',
  in_progress: '#f59e0b',
  review: '#a78bfa',
  done: '#10b981',
};

export const DEFAULT_TICKET_STATUS: TicketStatus = 'todo';
export const DONE_STATUS: TicketStatus = 'done';

export function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === 'string' && (TICKET_STATUSES as readonly string[]).includes(value);
}

/** Label for any status-ish string; unknown values render verbatim instead of disappearing. */
export function ticketStatusLabel(status: string | null | undefined): string {
  if (isTicketStatus(status)) return TICKET_STATUS_LABELS[status];
  return status || '—';
}

export function ticketStatusColor(status: string | null | undefined): string {
  return isTicketStatus(status) ? TICKET_STATUS_COLORS[status] : '#64748b';
}

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Higher = more urgent. Used by the list view's priority sort. */
export const TICKET_PRIORITY_RANK: Record<TicketPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/** Any pending flag parks a ticket: no dispatch (mirror of the server's isTicketPending). */
export function isTicketPending(ticket: {
  pending_user_action?: boolean | null;
  pending_on_tickets?: boolean | null;
  pending_ci_wait?: boolean | null;
}): boolean {
  return !!(ticket.pending_user_action || ticket.pending_on_tickets || ticket.pending_ci_wait);
}

/**
 * Why a manual Run (POST /tickets/:id/trigger) did not dispatch — the server's
 * `reason` slug in words. Unknown slugs render verbatim rather than vanish.
 */
export function triggerReasonLabel(reason: string | null | undefined): string {
  const r = (reason || '').trim();
  switch (r) {
    case 'unassigned': return '담당자가 지정되지 않았습니다';
    case 'pending': return '대기(pending) 플래그가 있어 디스패치하지 않습니다';
    case 'archived': return '보관된 티켓입니다';
    case 'duplicate': return '다른 티켓의 중복으로 확정되어 원본 티켓에서 처리합니다';
    case 'workspace_paused': return '워크스페이스의 티켓 디스패치가 일시정지되어 있습니다';
    case 'host_offline': return '담당자의 Runtime Host 가 오프라인입니다';
    case 'agent_busy': return '담당자가 동시 처리 한도만큼 다른 티켓을 처리 중입니다';
    case 'queued': return '대기열에 올렸습니다 — 담당자가 비는 대로 시작합니다';
    case 'instance_quiesced': return '서버가 디스패치를 멈춘(quiesce) 상태입니다';
    case '': return '알 수 없는 이유';
    default:
      if (r.startsWith('status_')) {
        return `${ticketStatusLabel(r.slice('status_'.length))} 상태에서는 실행하지 않습니다`;
      }
      return r;
  }
}
