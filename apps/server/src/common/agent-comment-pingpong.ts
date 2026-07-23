const SHA_RE = /\b[0-9a-f]{7,40}\b/i;
const APPROVAL_RE = /(?:승인|approved?|approval)/i;
const CLEAR_RE = /(?:blocker\s*(?:없|none|0)|no\s+blockers?|변경\s*요청\s*없)/i;
const WORK_RE = /(?:\?|질문|변경\s*요청|request(?:ed)?\s+changes?|handoff|인계|새\s*(?:작업|요청)|consensus|합의)/i;
const WAIT_RE = /(?:대기(?:\s*유지|\s*결정)?|waiting|작업\s*(?:티켓|대상).*(?:없|부재)|in-progress.*0건)/i;
const TARGET_RE = /(?:^|[\s`'"(])(?:apps|src|test|packages)\/[\w./-]+|\b[\w./-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java)\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i;

export type PingPongComment = { content?: string; metadata?: unknown; author_type?: string };

// 티켓 8fc94adf — pending_user_action 게이트를 add_comment 전용이 아니라
// ask_question/answer_question/record_decision/handoff_to_agent 도 공유하는
// 진입 조건으로 추출. 사람이 unpend 하기 전까지 이 4개 툴도 agent 저작
// 코멘트/핸드오프를 생성하지 못하게 막는다(user 저작은 항상 통과 — pend 해제
// 자체가 사람의 행동이므로).
export function isPendingUserActionBlocked(
  ticket: { pending_user_action?: boolean },
  authorType: string,
): boolean {
  return authorType === 'agent' && !!ticket.pending_user_action;
}

function metadataOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch {} }
  return {};
}

export function terminalAckKey(comment: PingPongComment): string | null {
  if (comment.author_type !== 'agent') return null;
  const content = comment.content || '';
  if (WORK_RE.test(content)) return null;
  const meta = metadataOf(comment.metadata);
  const structured = meta.terminal_ack === true;
  if (!structured && !(SHA_RE.test(content) && APPROVAL_RE.test(content) && CLEAR_RE.test(content))) return null;
  const sha = String(meta.sha || content.match(SHA_RE)?.[0] || '').toLowerCase();
  const cycle = String(meta.transition_id || meta.event_id || meta.approval_cycle_id || '').toLowerCase();
  // A structured acknowledgement without a commit/cycle identity is not safe
  // to dedupe: two independent approvals would otherwise collapse forever.
  if (!sha && !cycle) return null;
  const approval = String(meta.approval_status || 'approved').toLowerCase();
  const blockers = String(meta.blocker_status || 'none').toLowerCase();
  return `${sha || `cycle:${cycle}`}:${approval}:${blockers}`;
}

export function shouldSuppressTerminalAck(next: PingPongComment, recent: PingPongComment[]): boolean {
  const key = terminalAckKey(next);
  return !!key && recent.some((item) => terminalAckKey(item) === key);
}

export function shouldPendRepeatedWaiting(input: {
  next: PingPongComment; recent: PingPongComment[]; ticketDescription?: string; hasBaseRepo?: boolean;
}): boolean {
  if (input.next.author_type !== 'agent' || !WAIT_RE.test(input.next.content || '')) return false;
  if (input.hasBaseRepo || TARGET_RE.test(input.ticketDescription || '')) return false;
  return input.recent.filter((item) => item.author_type === 'agent' && WAIT_RE.test(item.content || '')).length >= 2;
}

export async function applyAgentCommentPingPongGuard(input: {
  ticket: { id: string; title: string; description?: string | null; base_repo_resource_id?: string | null; pending_user_action?: boolean };
  next: PingPongComment;
  recent: PingPongComment[];
  pend: () => Promise<void>;
}): Promise<{ suppressed: boolean; reason?: string; pending_user_action?: boolean }> {
  if (input.next.author_type !== 'agent') return { suppressed: false };
  if (input.ticket.pending_user_action) return { suppressed: true, reason: 'pending_user_action' };
  if (shouldSuppressTerminalAck(input.next, input.recent)) {
    return { suppressed: true, reason: 'duplicate_terminal_acknowledgement' };
  }
  if (shouldPendRepeatedWaiting({
    next: input.next,
    recent: input.recent,
    ticketDescription: `${input.ticket.title}\n${input.ticket.description || ''}`,
    hasBaseRepo: !!input.ticket.base_repo_resource_id,
  })) {
    await input.pend();
    return { suppressed: true, reason: 'repeated_waiting_without_work_target', pending_user_action: true };
  }
  return { suppressed: false };
}
