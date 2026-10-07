/**
 * 작업 제안(docs/voice-operator.md "작업 제안") — 순수 규칙. 저장·배달은 OperatorProposalService.
 *
 * operator 는 다른 세션에 일을 **직접 시키지 못한다**. 제안을 남기면 사용자가 승인한 뒤에 AWB 가 대상 세션에
 * 보낸다. 보낼 때 프롬프트 첫 줄에 출처를 단다 — 받는 세션이 "누가 시켰고 사람이 승인했다" 를 알게, 화면이
 * 그 행을 operator 작업으로 그리게(`apps/client/src/components/sessions/sessionTranscript.logic.ts`).
 */
import type { AgentSessionPromptProposal } from '../../entities/AgentSessionPromptProposal';
import type { SessionProposalView } from '../../common/types/agent-sessions';

export type { SessionProposalView };

/** server·client 계약 — 바꾸면 화면의 전사 라벨(`OPERATOR_TASK_RE`)도 같이 바꾼다. */
export const OPERATOR_TASK_PREFIX = '[AWB 오퍼레이터 작업]';
export const OPERATOR_TASK_APPROVED = '사용자 승인';

export const PROPOSAL_TEXT_MAX_CHARS = 8_000;
export const PROPOSAL_REASON_MAX_CHARS = 1_000;

export const PROPOSAL_OPEN_STATUSES = ['pending', 'queued'] as const;
export type ProposalStatus = 'pending' | 'queued' | 'sent' | 'failed' | 'dismissed' | 'withdrawn' | 'superseded';

/** 대상 세션에 실제로 보내는 글. */
export function composeOperatorTaskPrompt(operatorName: string, text: string): string {
  return `${OPERATOR_TASK_PREFIX} ${operatorName} — ${OPERATOR_TASK_APPROVED}\n${text}`;
}

export function proposalView(
  row: AgentSessionPromptProposal,
  names: { manager_name: string; cli_label: string },
): SessionProposalView {
  return {
    id: row.id,
    operator: { id: row.operator_id, name: row.operator_name },
    origin: row.origin,
    target: {
      manager_id: row.manager_id, manager_name: names.manager_name, cli: row.cli, cli_label: names.cli_label,
      session_id: row.session_id, title: row.target_title,
    },
    text: row.text,
    reason: row.reason,
    status: row.status,
    error: row.error,
    decided_via: row.decided_via,
    delivered_turn_id: row.delivered_turn_id,
    created_at: new Date(row.created_at).toISOString(),
    decided_at: row.decided_at ? new Date(row.decided_at).toISOString() : null,
  };
}
