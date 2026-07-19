const SHA_RE = /\b[0-9a-f]{7,40}\b/i;
const APPROVAL_RE = /(?:승인|approved?|approval)/i;
const CLEAR_RE = /(?:blocker\s*(?:없|none|0)|no\s+blockers?|변경\s*요청\s*없)/i;
const WORK_RE = /(?:\?|질문|변경\s*요청|request(?:ed)?\s+changes?|handoff|인계|새\s*(?:작업|요청)|consensus|합의)/i;

export interface TerminalAckLike {
  actor_type?: string;
  content?: string;
  metadata?: Record<string, unknown> | string | null;
  terminal_ack?: boolean;
}

function metadataOf(value: TerminalAckLike['metadata']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

/** Conservative classifier: questions, change requests and handoffs always win. */
export function isAgentTerminalAcknowledgement(value: TerminalAckLike): boolean {
  if (value.actor_type !== 'agent') return false;
  const content = value.content || '';
  if (WORK_RE.test(content)) return false;
  const metadata = metadataOf(value.metadata);
  if (value.terminal_ack === true || metadata.terminal_ack === true) {
    return !!(
      metadata.sha || SHA_RE.test(content) || metadata.transition_id ||
      metadata.event_id || metadata.approval_cycle_id
    );
  }
  return SHA_RE.test(content) && APPROVAL_RE.test(content) && CLEAR_RE.test(content);
}
