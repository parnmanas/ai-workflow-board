import { t as translate } from '../../i18n/core';
import type { ActivityView } from '../../activity';
import type { OrchestrationApproval, OrchestrationCounts } from '../../types';

/**
 * 미션 실행 승인(docs/orchestration.md "실행 승인")의 화면 규칙. 렌더 없이 단언할 수 있게 순수 함수로 둔다.
 *
 * 누가 답하는가는 서버가 정한다(`route`) — 화면은 그 값을 읽기만 한다. 사용자에게 온 요청이 먼저,
 * 오케스트레이터가 판단 중인 요청은 그 뒤에 "지켜보는" 카드로 둔다(사용자가 먼저 답할 수도 있다).
 */

/** 미결 요청 — 사용자 차례가 먼저, 각 무리 안에서는 오래된 순. */
export function pendingApprovals(approvals: OrchestrationApproval[] | undefined): OrchestrationApproval[] {
  const pending = (approvals || []).filter((a) => a.status === 'pending');
  const order = (a: OrchestrationApproval) => (a.route === 'user' ? 0 : 1);
  return pending.sort((a, b) => order(a) - order(b) || Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** step key → 그 step 의 미결 요청 수(사용자 차례만). step 목록이 "승인 대기" 를 표시하는 근거. */
export function approvalsByStep(approvals: OrchestrationApproval[] | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of approvals || []) {
    if (a.status !== 'pending' || a.route !== 'user' || !a.step_key) continue;
    out.set(a.step_key, (out.get(a.step_key) ?? 0) + 1);
  }
  return out;
}

/** 이 요청이 왜 지금 그쪽에 있는가 — 카드의 한 줄 설명. */
export function routeReasonLabel(approval: Pick<OrchestrationApproval, 'route' | 'route_reason'>): string {
  switch (approval.route_reason) {
    case 'orchestrator_trusted':
      return translate('The orchestrator is deciding — it has trusted permissions. You can answer first.');
    case 'orchestrator_not_trusted':
      return translate('The orchestrator is not trusted, so you decide.');
    case 'orchestrator_request':
      return translate('The orchestrator itself is asking.');
    case 'orchestrator_escalated':
      return translate('The orchestrator asked you to decide.');
    case 'orchestrator_timeout':
      return translate('The orchestrator did not answer in time.');
    case 'orchestrator_unreachable':
      return translate('The orchestrator could not be reached.');
    default:
      return approval.route === 'user' ? translate('Waiting for your approval.') : translate('The orchestrator is deciding.');
  }
}

/**
 * 사이드바 · 목록의 미션 진행 점. 사람이 답해야 하는 사실이 미션 상태보다 먼저다 — 세션의
 * `awaiting_permission` 과 같은 attention tone 이다(activity.ts). 승인 요청이 확인 게이트보다 앞선다:
 * 승인은 일하던 runtime 이 그 자리에서 멈춘 것이다.
 */
export function missionAttention(counts: Pick<OrchestrationCounts, 'awaitingUser' | 'awaitingApproval'> | null | undefined): ActivityView | null {
  if (counts?.awaitingApproval) return { label: translate('Needs your approval'), tone: 'attention', live: false };
  if (counts?.awaitingUser) return { label: translate('Needs your decision'), tone: 'attention', live: false };
  return null;
}
