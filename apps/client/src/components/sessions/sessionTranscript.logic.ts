/**
 * Agent Session 트랜스크립트 순수 로직 — 서버의 append-only 이벤트 행을 화면
 * 블록으로 접는다. 컴포넌트/컨텍스트에서 분리해 node:test 로 직접 구동한다
 * (chat/utils/composerSend.ts 선례).
 *
 * 접기 규칙:
 *   - 같은 turn 의 연속된 `text` 행은 하나의 assistant 블록(스트리밍 청크 병합)
 *   - 연속된 `reasoning` 행도 하나의 블록
 *   - `tool_update` 는 같은 tool_call_id 의 tool 블록에 status/output 으로 흡수
 *   - `permission_decision` 은 같은 request_id 의 permission 블록에 decision 으로 흡수
 *   - `turn` started 는 블록을 만들지 않고, finished 는 stop_reason 이 end_turn 이
 *     아닐 때만 남긴다(취소/거절/오류를 사용자가 볼 수 있게)
 */
import type { AgentSessionEventRecord, AgentSessionSnapshot, AgentSessionStatus } from '../../types';

export interface PermissionOptionView {
  option_id: string;
  name: string;
  kind: string;
}

export interface PermissionDecisionView {
  outcome: 'selected' | 'cancelled' | string;
  option_id: string | null;
  decided_by: 'user' | 'policy' | 'timeout' | string;
}

export type TranscriptBlock =
  | { kind: 'prompt'; key: string; seq: number; turnId: string; text: string; createdAt: string }
  | { kind: 'assistant'; key: string; seq: number; turnId: string; text: string; createdAt: string }
  | { kind: 'reasoning'; key: string; seq: number; turnId: string; text: string }
  | {
      kind: 'tool';
      key: string;
      seq: number;
      turnId: string;
      toolCallId: string;
      title: string;
      toolKind: string;
      input: unknown;
      status: string;
      output: unknown;
      delegated: boolean;
    }
  | {
      kind: 'permission';
      key: string;
      seq: number;
      turnId: string;
      requestId: string;
      toolCallId: string;
      title: string;
      toolKind: string;
      options: PermissionOptionView[];
      rawInput: unknown;
      decision: PermissionDecisionView | null;
    }
  | { kind: 'usage'; key: string; seq: number; turnId: string; inputTokens: number; outputTokens: number; totalTokens: number }
  | { kind: 'turn'; key: string; seq: number; turnId: string; stopReason: string }
  | { kind: 'error'; key: string; seq: number; turnId: string; message: string; code: string | null }
  | { kind: 'system'; key: string; seq: number; text: string };

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function buildTranscript(events: AgentSessionEventRecord[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const toolIndex = new Map<string, number>();
  const permissionIndex = new Map<string, number>();
  for (const ev of events) {
    const p = ev.payload || {};
    const turnId = ev.turn_id || '';
    const last = blocks[blocks.length - 1];
    switch (ev.type) {
      case 'user_prompt':
        blocks.push({ kind: 'prompt', key: ev.id, seq: ev.seq, turnId, text: str(p.text), createdAt: ev.created_at });
        break;
      case 'text':
        if (last && last.kind === 'assistant' && last.turnId === turnId) {
          last.text += str(p.text);
        } else {
          blocks.push({ kind: 'assistant', key: ev.id, seq: ev.seq, turnId, text: str(p.text), createdAt: ev.created_at });
        }
        break;
      case 'reasoning':
        if (last && last.kind === 'reasoning' && last.turnId === turnId) {
          last.text += str(p.text);
        } else {
          blocks.push({ kind: 'reasoning', key: ev.id, seq: ev.seq, turnId, text: str(p.text) });
        }
        break;
      case 'tool_call': {
        const toolCallId = str(p.tool_call_id);
        blocks.push({
          kind: 'tool',
          key: ev.id,
          seq: ev.seq,
          turnId,
          toolCallId,
          title: str(p.title) || toolCallId || 'tool',
          toolKind: str(p.kind),
          input: p.input,
          status: 'in_progress',
          output: undefined,
          delegated: p.delegated === true,
        });
        if (toolCallId) toolIndex.set(toolCallId, blocks.length - 1);
        break;
      }
      case 'tool_update': {
        const toolCallId = str(p.tool_call_id);
        const idx = toolCallId ? toolIndex.get(toolCallId) : undefined;
        if (idx !== undefined && blocks[idx]?.kind === 'tool') {
          const block = blocks[idx] as Extract<TranscriptBlock, { kind: 'tool' }>;
          block.status = str(p.status) || block.status;
          if (p.output !== undefined) block.output = p.output;
        } else {
          blocks.push({
            kind: 'tool',
            key: ev.id,
            seq: ev.seq,
            turnId,
            toolCallId,
            title: toolCallId || 'tool',
            toolKind: '',
            input: undefined,
            status: str(p.status) || 'completed',
            output: p.output,
            delegated: false,
          });
          if (toolCallId) toolIndex.set(toolCallId, blocks.length - 1);
        }
        break;
      }
      case 'permission_request': {
        const requestId = str(p.request_id);
        const options = Array.isArray(p.options)
          ? p.options.map((o: any) => ({ option_id: str(o?.option_id), name: str(o?.name) || str(o?.option_id), kind: str(o?.kind) }))
          : [];
        blocks.push({
          kind: 'permission',
          key: ev.id,
          seq: ev.seq,
          turnId,
          requestId,
          toolCallId: str(p.tool_call_id),
          title: str(p.title) || 'Permission requested',
          toolKind: str(p.kind),
          options,
          rawInput: p.raw_input,
          decision: null,
        });
        if (requestId) permissionIndex.set(requestId, blocks.length - 1);
        break;
      }
      case 'permission_decision': {
        const requestId = str(p.request_id);
        const idx = requestId ? permissionIndex.get(requestId) : undefined;
        const decision: PermissionDecisionView = {
          outcome: str(p.outcome) || (p.option_id ? 'selected' : 'cancelled'),
          option_id: typeof p.option_id === 'string' ? p.option_id : null,
          decided_by: str(p.decided_by) || 'user',
        };
        if (idx !== undefined && blocks[idx]?.kind === 'permission') {
          (blocks[idx] as Extract<TranscriptBlock, { kind: 'permission' }>).decision = decision;
        } else {
          blocks.push({ kind: 'system', key: ev.id, seq: ev.seq, text: `Permission ${decision.outcome} (${decision.decided_by})` });
        }
        break;
      }
      case 'usage':
        blocks.push({
          kind: 'usage',
          key: ev.id,
          seq: ev.seq,
          turnId,
          inputTokens: num(p.input_tokens),
          outputTokens: num(p.output_tokens),
          totalTokens: num(p.total_tokens),
        });
        break;
      case 'turn': {
        if (p.phase !== 'finished') break;
        const stopReason = str(p.stop_reason) || 'end_turn';
        if (stopReason === 'end_turn') break;
        blocks.push({ kind: 'turn', key: ev.id, seq: ev.seq, turnId, stopReason });
        break;
      }
      case 'error':
        blocks.push({ kind: 'error', key: ev.id, seq: ev.seq, turnId, message: str(p.message) || 'Unknown error', code: p.code ? str(p.code) : null });
        break;
      case 'system':
        blocks.push({ kind: 'system', key: ev.id, seq: ev.seq, text: str(p.text) });
        break;
      default:
        break;
    }
  }
  return blocks;
}

/** SSE 로 도착한 행을 seq 순서로 끼워 넣는다 — 중복(같은 id/seq)은 무시. */
export function mergeIncomingEvent(
  events: AgentSessionEventRecord[],
  incoming: AgentSessionEventRecord,
): AgentSessionEventRecord[] {
  if (!incoming || typeof incoming.seq !== 'number') return events;
  if (events.some((e) => e.id === incoming.id || e.seq === incoming.seq)) return events;
  const last = events[events.length - 1];
  if (!last || last.seq < incoming.seq) return [...events, incoming];
  const next = [...events, incoming];
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

/** 아직 결정되지 않은 가장 최근 permission 블록. */
export function pendingPermission(blocks: TranscriptBlock[]): Extract<TranscriptBlock, { kind: 'permission' }> | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b.kind === 'permission') return b.decision ? null : b;
  }
  return null;
}

/** 목록에서 seq 갭이 있으면(SSE 유실) true — 페이지가 재조회한다. */
export function hasSeqGap(events: AgentSessionEventRecord[]): boolean {
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].seq !== events[i - 1].seq + 1) return true;
  }
  return false;
}

export interface StatusView {
  label: string;
  tone: 'muted' | 'accent' | 'success' | 'warning' | 'danger';
  live: boolean;
}

export function describeSessionStatus(status: AgentSessionStatus | string): StatusView {
  switch (status) {
    case 'starting':
      return { label: 'Starting', tone: 'accent', live: true };
    case 'ready':
      return { label: 'Ready', tone: 'success', live: true };
    case 'busy':
      return { label: 'Working', tone: 'accent', live: true };
    case 'awaiting_permission':
      return { label: 'Needs your approval', tone: 'warning', live: true };
    case 'suspended':
      return { label: 'Suspended', tone: 'muted', live: false };
    case 'closed':
      return { label: 'Closed', tone: 'muted', live: false };
    case 'error':
      return { label: 'Error', tone: 'danger', live: false };
    default:
      return { label: String(status || 'Unknown'), tone: 'muted', live: false };
  }
}

export function sessionDisplayTitle(session: Pick<AgentSessionSnapshot, 'title' | 'agent_name' | 'runtime'>): string {
  const title = (session.title || '').trim();
  if (title) return title;
  return `${session.agent_name || 'Agent'} · ${session.runtime || 'session'}`;
}

/** 프롬프트 전송 가능 여부 — 서버 규칙(closed 불가, 진행 중 불가)의 UI 거울. */
export function canPrompt(status: AgentSessionStatus | string): boolean {
  return status !== 'closed' && status !== 'busy' && status !== 'awaiting_permission';
}

export function runtimeLabel(runtime: string): string {
  switch (runtime) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'hermes':
      return 'Hermes';
    case 'deepseek':
      return 'DeepSeek (Claude CLI)';
    default:
      return runtime || 'CLI';
  }
}
