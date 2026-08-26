import type { Ticket } from '../../entities/Ticket';

export const DUPLICATE_PENDING_SET_BY = 'duplicate_decision_guard';

// 명시적 원인 식별자가 도입되기 전 duplicate 생성 경로들이 저장하던 안내다.
// 생성자 표시명은 일반 Pending에도 쓰이므로 양성 증거가 될 수 없다.
const LEGACY_DUPLICATE_PENDING_REASON = /^Confirm whether this .+ report duplicates one of the suggested tickets\.$/;

export function isDuplicateDecisionPending(
  ticket: Pick<Ticket, 'pending_user_action' | 'pending_reason' | 'pending_set_by'>,
  hasAmbiguousCandidate = false,
): boolean {
  if (ticket.pending_user_action !== true) return false;
  if (ticket.pending_set_by === DUPLICATE_PENDING_SET_BY) return true;
  return hasAmbiguousCandidate && LEGACY_DUPLICATE_PENDING_REASON.test(ticket.pending_reason || '');
}
