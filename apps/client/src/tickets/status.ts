import { t as translate } from '../i18n/core';
// Ticket lifecycle — client mirror of `apps/server/src/common/ticket-status.ts`
// (docs/tickets.md). Boards/columns are gone; every ticket sits in exactly one
// of these fixed statuses. Never compare against a status literal typed by hand
// elsewhere — import from here. React-free so `node --test` can import it.

export const TICKET_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  get backlog() { return translate('Backlog'); },
  get todo() { return translate('To Do'); },
  get in_progress() { return translate('In Progress'); },
  get review() { return translate('Review'); },
  get done() { return translate('Done'); },
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
  get low() { return translate('Low'); },
  get medium() { return translate('Medium'); },
  get high() { return translate('High'); },
  get critical() { return translate('Critical'); },
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
    case 'unassigned': return translate('담당자가 지정되지 않았습니다');
    case 'pending': return translate('대기(pending) 플래그가 있어 디스패치하지 않습니다');
    case 'archived': return translate('보관된 티켓입니다');
    case 'duplicate': return translate('다른 티켓의 중복으로 확정되어 원본 티켓에서 처리합니다');
    case 'account_paused': return translate('계정의 티켓 디스패치가 일시정지되어 있습니다');
    case 'host_offline': return translate('담당자의 Runtime Host 가 오프라인입니다');
    case 'agent_busy': return translate('담당자가 동시 처리 한도만큼 다른 티켓을 처리 중입니다');
    case 'queued': return translate('대기열에 올렸습니다 — 담당자가 비는 대로 시작합니다');
    case 'instance_quiesced': return translate('서버가 디스패치를 멈춘(quiesce) 상태입니다');
    case '': return translate('알 수 없는 이유');
    default:
      if (r.startsWith('status_')) {
        return translate('{0} 상태에서는 실행하지 않습니다', { 0: ticketStatusLabel(r.slice('status_'.length)) });
      }
      return r;
  }
}
