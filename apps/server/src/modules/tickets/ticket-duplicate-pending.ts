import type { Ticket } from '../../entities/Ticket';

export const DUPLICATE_PENDING_SET_BY = 'duplicate_decision_guard';

// duplicate 판정과 무관하게 사용자 결정을 기다리는 서버 guard들이다.
// 레거시 duplicate 행은 생성 주체의 표시 이름을 pending_set_by에 저장했으므로
// ambiguous 감사 행만으로 복원하되, 이 값들은 stale 후보가 있어도 반드시 제외한다.
const NON_DUPLICATE_PENDING_SET_BY = new Set([
  'hard_budget_dispatch_guard',
  'agent_comment_pingpong_guard',
  'action_approval_gate',
  'ClaimVerification',
  'RespawnStormDetector',
  'TriggerLoopService',
]);

export function isDuplicateDecisionPending(
  ticket: Pick<Ticket, 'pending_user_action' | 'pending_set_by'>,
  hasAmbiguousCandidate = false,
): boolean {
  if (ticket.pending_user_action !== true) return false;
  if (ticket.pending_set_by === DUPLICATE_PENDING_SET_BY) return true;
  return hasAmbiguousCandidate && !NON_DUPLICATE_PENDING_SET_BY.has(ticket.pending_set_by);
}
