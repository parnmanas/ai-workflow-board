/**
 * pend_ticket Action 게이트 — 순수 판정 로직 (티켓 524bb434).
 *
 * 목적: 에이전트가 "배포가 필요하다" 같은, 자동화 가능한 작업을 이유로 곧장
 * 티켓을 Pending 하는 것을 막는다. pend_ticket 핸들러(ticket-crud-tools.ts)가
 * 티켓 범위의 "실행 가능한" Action(enabled + workspace/board 스코프 일치)을 모아
 * 이 함수로 판정한다:
 *   - 실행 가능한 Action 이 하나라도 있고 `no_action_reason` 이 비어 있으면 → 거부.
 *     반환 메시지에 후보 Action 목록과 다음 절차(run_action / save_action+run_action /
 *     no_action_reason 재호출)를 담아 에이전트가 즉시 행동으로 옮길 수 있게 한다.
 *   - `no_action_reason` 이 채워져 있거나 후보가 없으면 → 허용(Pending 은 사람의
 *     판단·자격증명·승인이 반드시 필요한 경우로 한정).
 *
 * Nest·DB 없이 검증되도록 순수 함수로 분리한다(common/consensus-state.ts 선례).
 */

export interface PendActionCandidate {
  id: string;
  name: string;
  description: string;
  target_agent_id: string;
  /** null = workspace-scope Action, uuid = board-scope Action. */
  board_id: string | null;
}

export interface PendActionGateResult {
  /** true → pend 진행 허용. false → 거부(`message` 로 후보·다음 절차 안내). */
  allowed: boolean;
  /** 게이트가 후보로 인식한 실행 가능 Action 수 (감사/로그용). */
  candidateCount: number;
  /** allowed=false 일 때 에이전트에게 되돌려줄 안내 메시지. */
  message?: string;
}

// 메시지에 나열하는 후보 상한 — 목록이 지나치게 길어지지 않게 한다.
const MAX_LISTED = 20;

/** 후보 Action 을 사람이 읽을 수 있는 목록 문자열로 변환한다. */
export function formatPendActionCandidates(candidates: PendActionCandidate[]): string {
  const shown = candidates.slice(0, MAX_LISTED);
  const lines = shown.map((a) => {
    const desc = (a.description || '').trim();
    const scope = a.board_id ? 'board' : 'workspace';
    return `  - ${a.name} (id: ${a.id}, scope: ${scope})${desc ? ` — ${desc}` : ''}`;
  });
  if (candidates.length > shown.length) {
    lines.push(`  - …and ${candidates.length - shown.length} more (use list_actions to see all)`);
  }
  return lines.join('\n');
}

/**
 * pend 시도를 판정한다. 부작용 없음 — 후보 목록과 no_action_reason 만 본다.
 */
export function evaluatePendActionGate(
  candidates: PendActionCandidate[],
  noActionReason: string | undefined | null,
): PendActionGateResult {
  const reason = (noActionReason ?? '').trim();
  const candidateCount = candidates.length;

  // 스코프 내 실행 가능한 Action 이 없거나, 왜 어떤 Action 도 안 맞는지 이미
  // 정당화했으면 → 통과.
  if (candidateCount === 0 || reason) {
    return { allowed: true, candidateCount };
  }

  const message =
    `pend_ticket blocked: ${candidateCount} runnable Action(s) exist in this ticket's scope. ` +
    `Pending is reserved for what an Action cannot resolve (a human decision, a credential/secret, an approval). ` +
    `Before parking, either RUN one that fits (run_action) or REGISTER + run a new one (save_action → run_action), ` +
    `then resume this ticket in place:\n${formatPendActionCandidates(candidates)}\n` +
    `If none can resolve the blocker, call pend_ticket again with no_action_reason stating specifically why ` +
    `(e.g. "prod approval needs a human signer — no Action covers the sign-off").`;

  return { allowed: false, candidateCount, message };
}
