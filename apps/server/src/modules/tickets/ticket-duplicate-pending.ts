import type { Ticket } from '../../entities/Ticket';

export const DUPLICATE_PENDING_SET_BY = 'duplicate_decision_guard';

export function isDuplicateDecisionPending(
  ticket: Pick<Ticket, 'pending_user_action' | 'pending_set_by'>,
): boolean {
  return ticket.pending_user_action === true
    && ticket.pending_set_by === DUPLICATE_PENDING_SET_BY;
}
