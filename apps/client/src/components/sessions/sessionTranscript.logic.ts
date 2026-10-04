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
 *   - `elicitation_decision` 은 같은 elicitation_id 의 elicitation(질문/폼) 블록에 흡수
 *   - `plan` 은 같은 turn 의 이전 plan 블록을 대체한다(에이전트가 진행 상태를 갱신하며 다시 보낸다)
 *   - `turn` started 는 블록을 만들지 않고, finished 는 stop_reason 이 end_turn 이
 *     아닐 때만 남긴다(취소/거절/오류를 사용자가 볼 수 있게)
 */
import type {
  AgentSessionAuth,
  AgentSessionCommand,
  AgentSessionEventRecord,
  AgentSessionLiveSnapshot,
  AgentSessionStatus,
} from '../../types';
import { cliLabel } from '../../cli/catalog';
import { splitSleepMarker, stripWakeNote } from '../../voice/wake.logic';
import { sessionActivity } from '../../activity';
import type { ActivityView } from '../../activity';

/**
 * 토큰 수를 짧게 — 12 / 1.2k / 35.8k / 1.05M. 전사의 usage 줄은 한 줄에 여러 값을
 * 담으므로 원본 숫자는 툴팁(title)이 맡는다.
 */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  // 10만 미만은 소수 한 자리까지 — 36.1k 와 35.8k 의 차이가 이 구간에서는 의미 있다.
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * usage 줄의 조각들. **측정되지 않은 값은 넣지 않는다** — 0 을 찍으면 "0 토큰 썼다"로
 * 읽혀 계측 실패와 구분되지 않는다(운영자가 CLI 별 차이를 오해한 지점이다).
 */
/**
 * usage 줄에 붙일 "언제 받은 응답인가". 오늘이면 시각만(`14:03:27`), 다른 날이면 날짜까지
 * (`10/1 14:03`) — 오래 띄워 둔 세션에서 어느 응답이 언제였는지를 줄 하나로 가늠하게 한다.
 * 시각을 모르면 ''(빈 칸을 그리지 않는다).
 */
export function formatReceivedAt(iso: string, now: Date = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? `${time}:${pad(at.getSeconds())}` : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

export function usageSummaryParts(block: {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
}): string[] {
  const parts: string[] = [];
  if (block.totalTokens > 0) parts.push(`${compactTokens(block.totalTokens)} tokens`);
  const detail: string[] = [];
  if (block.inputTokens > 0) detail.push(`in ${compactTokens(block.inputTokens)}`);
  if (block.outputTokens > 0) detail.push(`out ${compactTokens(block.outputTokens)}`);
  const cache = block.cachedReadTokens + block.cacheWriteTokens;
  if (cache > 0) detail.push(`cache ${compactTokens(cache)}`);
  if (detail.length > 0) parts.push(`(${detail.join(' · ')})`);
  if (block.contextTokens > 0) {
    parts.push(block.contextWindow > 0
      ? `ctx ${compactTokens(block.contextTokens)}/${compactTokens(block.contextWindow)}`
      : `ctx ${compactTokens(block.contextTokens)}`);
  }
  if (block.costUsd > 0) {
    // 한 턴 비용은 보통 1센트 미만이라 소수 두 자리로는 전부 "$0.01" 이 된다.
    const cost = block.costUsd < 0.01
      ? block.costUsd.toFixed(4)
      : block.costUsd < 1
        ? block.costUsd.toFixed(3)
        : block.costUsd.toFixed(2);
    parts.push(`$${cost}`);
  }
  return parts;
}

export interface PermissionOptionView {
  option_id: string;
  name: string;
  kind: string;
}

export interface PermissionDecisionView {
  outcome: 'selected' | 'cancelled' | string;
  option_id: string | null;
  decided_by: 'user' | 'policy' | 'timeout' | 'system' | string;
}

/** ACP ElicitationPropertySchema 의 화면용 투영 — primitive 타입만(문자열/숫자/불리언/다중선택). */
export interface ElicitationFieldView {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | string;
  title: string;
  description: string;
  required: boolean;
  /** 단일 선택지(string + enum/oneOf) 또는 다중 선택지(array.items) */
  choices: Array<{ value: string; label: string }> | null;
  defaultValue: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
}

export interface ElicitationSchemaView {
  title: string;
  description: string;
  fields: ElicitationFieldView[];
}

export interface ElicitationDecisionView {
  action: 'accept' | 'decline' | 'cancel' | string;
  content: Record<string, unknown> | null;
  decided_by: 'user' | 'agent' | 'timeout' | 'system' | string;
}

export interface PlanEntryView {
  content: string;
  priority: 'high' | 'medium' | 'low' | string;
  status: 'pending' | 'in_progress' | 'completed' | string;
}

export type TranscriptBlock =
  /** `voice` — 이름을 불러 깨운 뒤의 첫 요청(앞에 붙은 음성 대화 안내 한 줄을 떼고 보여 준다). */
  | { kind: 'prompt'; key: string; seq: number; turnId: string; text: string; createdAt: string; voice?: boolean }
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
      description: string;
      toolKind: string;
      options: PermissionOptionView[];
      rawInput: unknown;
      decision: PermissionDecisionView | null;
    }
  | {
      kind: 'elicitation';
      key: string;
      seq: number;
      turnId: string;
      elicitationId: string;
      mode: 'form' | 'url' | string;
      message: string;
      schema: ElicitationSchemaView | null;
      url: string;
      toolCallId: string;
      decision: ElicitationDecisionView | null;
    }
  | { kind: 'plan'; key: string; seq: number; turnId: string; entries: PlanEntryView[] }
  /**
   * 한 턴의 토큰 사용량. **캐시를 따로 싣는 이유**: claude 의 `input_tokens` 는 캐시
   * 히트를 제외한 신규 입력이라 보통 한 자릿수다 — in/out 만 보여 주면 "2 토큰 썼다"가
   * 되어 실제 컨텍스트(수만 토큰)를 감춘다. 매니저가 CLI 별 차이를 정규화해 보내고
   * (agent-manager `session-usage.ts`), 화면은 받은 조각을 그대로 보여 준다.
   */
  | {
      kind: 'usage';
      key: string;
      seq: number;
      turnId: string;
      inputTokens: number;
      outputTokens: number;
      cachedReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      contextTokens: number;
      contextWindow: number;
      costUsd: number;
      /** 이 턴의 응답을 받은 시각 — 턴의 마지막 usage 가 도착한 때(ISO). 모르면 ''. */
      receivedAt: string;
    }
  | { kind: 'turn'; key: string; seq: number; turnId: string; stopReason: string }
  | { kind: 'error'; key: string; seq: number; turnId: string; message: string; code: string | null }
  /**
   * 에이전트가 내보낸 이미지 한 장. **바이트는 여기 없다** — `imageRef` 로 전용
   * 엔드포인트에서 받는다(이벤트에 base64 를 실으면 payload 상한에 걸려 조용히 사라진다).
   * `uri` 는 어댑터가 URL 로 준 경우(외부 이미지) — 그때는 ref 가 비어 있다.
   */
  | {
      kind: 'image';
      key: string;
      seq: number;
      turnId: string;
      imageRef: string;
      mimeType: string;
      size: number;
      uri: string;
    }
  | { kind: 'system'; key: string; seq: number; text: string };

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** ACP ElicitationSchema(JSON Schema, primitive 속성만) → 필드 목록. 모르는 타입은 문자열 입력으로 둔다. */
export function normalizeElicitationSchema(raw: unknown): ElicitationSchemaView | null {
  if (!raw || typeof raw !== 'object') return null;
  const schema = raw as Record<string, any>;
  const props = schema.properties && typeof schema.properties === 'object' ? (schema.properties as Record<string, any>) : {};
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required.filter((r: unknown) => typeof r === 'string') : []);
  const toChoices = (def: any): Array<{ value: string; label: string }> | null => {
    if (!def || typeof def !== 'object') return null;
    if (Array.isArray(def.oneOf) && def.oneOf.length) {
      return def.oneOf
        .map((o: any) => ({ value: str(o?.const ?? o?.value ?? o?.enum?.[0]), label: str(o?.title) || str(o?.const ?? o?.value ?? o?.enum?.[0]) }))
        .filter((o: { value: string }) => o.value);
    }
    if (Array.isArray(def.anyOf) && def.anyOf.length) {
      return def.anyOf
        .map((o: any) => ({ value: str(o?.const ?? o?.value), label: str(o?.title) || str(o?.const ?? o?.value) }))
        .filter((o: { value: string }) => o.value);
    }
    if (Array.isArray(def.enum) && def.enum.length) {
      return def.enum.map((v: unknown) => ({ value: str(v), label: str(v) })).filter((o: { value: string }) => o.value);
    }
    return null;
  };
  const fields: ElicitationFieldView[] = Object.entries(props).map(([name, def]) => {
    const d = def && typeof def === 'object' ? (def as Record<string, any>) : {};
    const type = typeof d.type === 'string' ? d.type : 'string';
    const choices = type === 'array' ? toChoices(d.items) : toChoices(d);
    return {
      name,
      type,
      title: str(d.title) || name,
      description: str(d.description),
      required: required.has(name),
      choices,
      defaultValue: d.default,
      ...(typeof d.minimum === 'number' ? { minimum: d.minimum } : {}),
      ...(typeof d.maximum === 'number' ? { maximum: d.maximum } : {}),
      ...(typeof d.minLength === 'number' ? { minLength: d.minLength } : {}),
      ...(typeof d.maxLength === 'number' ? { maxLength: d.maxLength } : {}),
      ...(typeof d.format === 'string' ? { format: d.format } : {}),
    };
  });
  return { title: str(schema.title), description: str(schema.description), fields };
}

export function buildTranscript(events: AgentSessionEventRecord[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const toolIndex = new Map<string, number>();
  const permissionIndex = new Map<string, number>();
  const elicitationIndex = new Map<string, number>();
  const planIndex = new Map<string, number>();
  /** 턴 → 그 턴의 usage 블록(마지막 값). 흐름에 끼우지 않고 끝에서 배치한다. */
  const usageByTurn = new Map<string, Extract<TranscriptBlock, { kind: 'usage' }>>();
  for (const ev of events) {
    const p = ev.payload || {};
    const turnId = ev.turn_id || '';
    const last = blocks[blocks.length - 1];
    switch (ev.type) {
      case 'user_prompt': {
        const { text, noted } = stripWakeNote(str(p.text));
        blocks.push({ kind: 'prompt', key: ev.id, seq: ev.seq, turnId, text, createdAt: ev.created_at, ...(noted ? { voice: true } : {}) });
        break;
      }
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
          // codex-acp 의 `mcp_startup.<server>` 처럼 update 없이 처음부터 completed/failed 인 호출이 있다
          status: str(p.status) || 'in_progress',
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
          description: str(p.description),
          toolKind: str(p.kind),
          options,
          rawInput: p.raw_input,
          decision: null,
        });
        if (requestId) permissionIndex.set(requestId, blocks.length - 1);
        break;
      }
      case 'elicitation_request': {
        const elicitationId = str(p.elicitation_id);
        blocks.push({
          kind: 'elicitation',
          key: ev.id,
          seq: ev.seq,
          turnId,
          elicitationId,
          mode: str(p.mode) === 'url' ? 'url' : 'form',
          message: str(p.message),
          schema: normalizeElicitationSchema(p.schema),
          url: str(p.url),
          toolCallId: str(p.tool_call_id),
          decision: null,
        });
        if (elicitationId) elicitationIndex.set(elicitationId, blocks.length - 1);
        break;
      }
      case 'elicitation_decision': {
        const elicitationId = str(p.elicitation_id);
        const idx = elicitationId ? elicitationIndex.get(elicitationId) : undefined;
        const decision: ElicitationDecisionView = {
          action: str(p.action) || 'cancel',
          content: p.content && typeof p.content === 'object' && !Array.isArray(p.content) ? (p.content as Record<string, unknown>) : null,
          decided_by: str(p.decided_by) || 'user',
        };
        if (idx !== undefined && blocks[idx]?.kind === 'elicitation') {
          (blocks[idx] as Extract<TranscriptBlock, { kind: 'elicitation' }>).decision = decision;
        } else {
          blocks.push({ kind: 'system', key: ev.id, seq: ev.seq, text: `Input ${decision.action === 'accept' ? 'submitted' : decision.action === 'decline' ? 'declined' : 'cancelled'} (${decision.decided_by})` });
        }
        break;
      }
      case 'plan': {
        const entries: PlanEntryView[] = Array.isArray(p.entries)
          ? p.entries
            .filter((e: any) => e && typeof e === 'object')
            .map((e: any) => ({ content: str(e.content), priority: str(e.priority) || 'medium', status: str(e.status) || 'pending' }))
            .filter((e: PlanEntryView) => e.content)
          : [];
        const idx = planIndex.get(turnId);
        if (idx !== undefined && blocks[idx]?.kind === 'plan') {
          (blocks[idx] as Extract<TranscriptBlock, { kind: 'plan' }>).entries = entries;
        } else {
          blocks.push({ kind: 'plan', key: ev.id, seq: ev.seq, turnId, entries });
          planIndex.set(turnId, blocks.length - 1);
        }
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
      case 'image':
        blocks.push({
          kind: 'image',
          key: ev.id,
          seq: ev.seq,
          turnId,
          imageRef: str(p.image_ref),
          mimeType: str(p.mime_type) || 'application/octet-stream',
          size: num(p.size),
          uri: str(p.uri),
        });
        break;
      case 'usage':
        // **대화 흐름에 끼워 넣지 않는다.** usage 는 턴 단위 메타데이터인데, 예전에는
        // 도착 순서대로 블록을 push 했다. 그러면 스트리밍 중인 텍스트 사이에 끼어
        // `text` 병합 조건(직전 블록이 같은 턴의 assistant)을 깨뜨려 한 문장이 쪼개졌다
        // (실측: "이 세션이 끊" / "465k tokens" / "깁니다" — 한 턴에 usage 가 여러 번
        // 오므로 토큰 줄이 두 번 찍히기도 했다). 턴별로 **마지막 값 하나만** 들고
        // 있다가(usage 는 누적값이다) 아래에서 그 턴의 끝에 붙인다.
        usageByTurn.set(turnId, {
          kind: 'usage',
          key: ev.id,
          seq: ev.seq,
          turnId,
          // usage 는 턴이 끝날 때 오므로(누적값의 마지막) 그 시각이 곧 "응답을 받은 때" 다.
          receivedAt: ev.created_at || '',
          inputTokens: num(p.input_tokens),
          outputTokens: num(p.output_tokens),
          cachedReadTokens: num(p.cached_read_tokens),
          cacheWriteTokens: num(p.cache_write_tokens),
          // 예전 매니저는 total 을 안 실어 보내기도 했다 — 그때는 조각의 합이 답이다.
          totalTokens:
            num(p.total_tokens)
            || num(p.input_tokens) + num(p.output_tokens) + num(p.cached_read_tokens) + num(p.cache_write_tokens),
          contextTokens: num(p.context_tokens),
          contextWindow: num(p.context_window),
          costUsd: typeof p.cost_usd === 'number' && Number.isFinite(p.cost_usd) ? p.cost_usd : 0,
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
  if (usageByTurn.size === 0) return blocks;
  // usage 를 각 턴의 **마지막 블록 뒤에** 한 번만 놓는다. 흐름 중간에 끼우지 않으므로
  // 스트리밍 텍스트가 쪼개지지 않고, 턴당 하나뿐이라 토큰 줄이 중복되지 않는다.
  // operator 의 잠들기 표시는 화면이 읽는 신호다 — 보여 주지 않는다(docs/voice-operator.md "잠들기").
  for (const b of blocks) if (b.kind === 'assistant') b.text = splitSleepMarker(b.text).text;
  const turnOf = (b: TranscriptBlock): string => ('turnId' in b ? b.turnId : '');
  const lastIndexOfTurn = new Map<string, number>();
  blocks.forEach((b, i) => lastIndexOfTurn.set(turnOf(b), i));
  // 창 앞에서 본문이 잘리거나 표시할 본문이 없는 턴도 usage 는 남을 수 있다.
  // 이 줄을 맨 끝으로 보내면 과거 시각이 최신 응답의 시각처럼 보인다.
  // seq 는 history/live 간에 다른 번호 공간일 수 있으므로 입력 위치로 배치한다.
  const eventOrder = new Map(events.map((ev, i) => [ev.id, i]));
  const orphanUsage = [...usageByTurn.values()]
    .filter((usage) => !lastIndexOfTurn.has(usage.turnId))
    .sort((a, b) => eventOrder.get(a.key)! - eventOrder.get(b.key)!);
  let orphanIndex = 0;
  const out: TranscriptBlock[] = [];
  blocks.forEach((b, i) => {
    while (orphanIndex < orphanUsage.length && eventOrder.get(orphanUsage[orphanIndex].key)! < eventOrder.get(b.key)!) {
      out.push(orphanUsage[orphanIndex++]);
    }
    out.push(b);
    const turn = turnOf(b);
    if (lastIndexOfTurn.get(turn) === i) {
      const usage = usageByTurn.get(turn);
      if (usage) out.push(usage);
    }
  });
  out.push(...orphanUsage.slice(orphanIndex));
  return out;
}

/**
 * 화면이 들고 있는 트랜스크립트 행 수 상한. 매니저가 기록을 돌려줄 때 쓰는 창(4000)과 같은 크기다 —
 * 긴 세션은 어차피 최근 대화만 보게 되고, 넘치면 앞에서 버린다. 상한이 없으면 오래 켜 둔 세션에서
 * 배열이 무한히 자라고(메모리) 매 청크마다 전체를 다시 접느라(buildTranscript) 점점 느려진다.
 */
export const LIVE_EVENT_WINDOW = 4000;
const TRIM_MARKER_ID = 'live:trimmed';

function trimMarker(dropped: number, firstKept: AgentSessionEventRecord | undefined): AgentSessionEventRecord {
  return {
    id: TRIM_MARKER_ID,
    seq: 0,
    turn_id: '',
    type: 'system',
    payload: { text: `Earlier messages trimmed (${dropped} events).`, dropped },
    created_at: firstKept?.created_at ?? new Date().toISOString(),
  };
}

/**
 * 라이브 스트림 행을 트랜스크립트 끝에 붙인다. 기록(history)의 seq 와 라이브 seq 는
 * 서로 다른 번호 공간이라(라이브는 프로세스마다 1 부터) 도착 순서대로 이어 붙이고,
 * id 로만 중복을 거른다. 표시용 seq 는 마지막 값 + 1 로 다시 매긴다.
 * 상한(`LIVE_EVENT_WINDOW`)을 넘으면 앞에서 버리고, 몇 건이 사라졌는지 한 줄로 남긴다
 * (기록 쪽의 "Earlier history omitted" 와 같은 규약).
 */
export function appendLiveEvent(
  events: AgentSessionEventRecord[],
  incoming: AgentSessionEventRecord,
  limit: number = LIVE_EVENT_WINDOW,
): AgentSessionEventRecord[] {
  if (!incoming || !incoming.id) return events;
  if (events.some((e) => e.id === incoming.id)) return events;
  const last = events[events.length - 1];
  const next = [...events, { ...incoming, seq: (last?.seq ?? 0) + 1 }];
  const hasMarker = next[0]?.id === TRIM_MARKER_ID;
  const body = hasMarker ? next.slice(1) : next;
  if (limit <= 0 || body.length <= limit) return next;
  const overflow = body.length - limit;
  const kept = body.slice(overflow);
  const priorDropped = hasMarker ? Number((next[0].payload as { dropped?: unknown })?.dropped) || 0 : 0;
  return [trimMarker(priorDropped + overflow, kept[0]), ...kept];
}

/** 아직 결정되지 않은 가장 최근 permission 블록. */
export function pendingPermission(blocks: TranscriptBlock[]): Extract<TranscriptBlock, { kind: 'permission' }> | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b.kind === 'permission') return b.decision ? null : b;
  }
  return null;
}

export type PendingInteraction =
  | Extract<TranscriptBlock, { kind: 'permission' }>
  | Extract<TranscriptBlock, { kind: 'elicitation' }>;

/** 사용자의 답을 기다리는 가장 최근 카드 — permission 이든 질문/폼(form elicitation)이든. url 은 기다리지 않는다. */
export function pendingInteraction(blocks: TranscriptBlock[]): PendingInteraction | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b.kind === 'permission') return b.decision ? null : b;
    if (b.kind === 'elicitation' && b.mode === 'form') return b.decision ? null : b;
  }
  return null;
}

/**
 * 컴포저의 slash command 자동완성. 텍스트가 `/` 로 시작하고 아직 첫 토큰(명령 이름)을
 * 치는 중일 때만 활성이다 — 이름 뒤에 공백이 오면 인자 입력 중이므로 닫는다.
 */
export function matchSlashCommands(text: string, commands: AgentSessionCommand[]): { active: boolean; query: string; matches: AgentSessionCommand[] } {
  const m = /^\/([^\s/]*)$/.exec(text);
  if (!m || commands.length === 0) return { active: false, query: '', matches: [] };
  const query = m[1].toLowerCase();
  const matches = commands
    .filter((c) => c.name.toLowerCase().startsWith(query))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { active: true, query, matches };
}

/** 선택한 명령을 입력창 텍스트로 — 인자를 받는 명령이면 뒤에 공백을 둬 바로 이어 칠 수 있게 한다. */
export function applySlashCommand(command: AgentSessionCommand): string {
  return `/${command.name}${command.input_hint ? ' ' : ''}`;
}

/** 목록에서 seq 갭이 있으면(SSE 유실) true — 페이지가 재조회한다. */
/**
 * 라이브 스냅샷 머지 — **과거가 현재를 덮지 못하게 한다.**
 *
 * 세션 상태는 서로 지연이 다른 세 경로로 들어온다: SSE 패치(즉시) · 하트비트 스냅샷
 * (30초 주기) · RPC 응답(`history`/`open`/`prompt` … 최대 120초). 예전에는 7곳의
 * `setLive(...)` 가 전부 무조건 덮어써서, 느린 RPC 응답이 **더 최신인 SSE 패치를 과거
 * 상태로 되돌렸다.** 서버의 재조정은 edge-triggered 라("보고된 상태 == 내 상태면 그냥
 * 반환") 한 번 틀어지면 교정 SSE 가 오지 않아 그대로 고착된다 — 그래서 "대화는 끝났는데
 * working", "돌고 있는데 ready" 가 둘 다 나왔다. busy 에 고착되면 입력한 프롬프트가
 * 전송되지 않고 조용히 큐에 쌓이므로 증상보다 더 아프다.
 *
 * 스냅샷은 이미 `updated_at` 을 싣고 있었다 — 비교하는 쪽이 없었을 뿐이다.
 *
 * 규칙:
 *   - `next` 가 null 이면 그대로(명시적 초기화는 존중한다).
 *   - 들고 있는 것이 없으면 그대로 채택.
 *   - **다른 세션**의 스냅샷이면 비교하지 않고 교체한다(세션 전환은 시간 역행이 아니다).
 *   - 같은 세션인데 `updated_at` 이 더 과거면 **버린다**.
 *   - 시각을 파싱할 수 없으면(구버전 서버 등) 예전처럼 채택한다 — 순서를 모를 때
 *     멈춰 있는 것보다 최신일 가능성에 거는 편이 낫다.
 */
export function mergeLiveSnapshot(
  prev: AgentSessionLiveSnapshot | null,
  next: AgentSessionLiveSnapshot | null,
): AgentSessionLiveSnapshot | null {
  if (!next) return next;
  if (!prev) return next;
  if (
    prev.session_id !== next.session_id ||
    prev.manager_id !== next.manager_id ||
    prev.cli !== next.cli
  ) {
    return next;
  }
  const prevAt = Date.parse(prev.updated_at);
  const nextAt = Date.parse(next.updated_at);
  if (!Number.isFinite(prevAt) || !Number.isFinite(nextAt)) return next;
  return nextAt < prevAt ? prev : next;
}

export function hasSeqGap(events: AgentSessionEventRecord[]): boolean {
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].seq !== events[i - 1].seq + 1) return true;
  }
  return false;
}

/**
 * 세션 상태 → 공용 진행 어휘(src/activity.ts). 라벨·색·애니메이션 규칙은 네 표면이
 * 공유하므로 여기서 따로 정의하지 않는다 — 예전에는 이 파일에 tone 표가 따로 있어
 * 같은 "작업 중"이 세션에선 보라, 미션에선 파랑으로 나왔다.
 */
export type StatusView = ActivityView;

export function describeSessionStatus(status: AgentSessionStatus | string | null | undefined): ActivityView {
  return sessionActivity(status);
}

export function sessionDisplayTitle(session: { title?: string | null; cli?: string; session_id?: string }): string {
  const title = (session.title || '').trim();
  if (title) return title;
  const id = session.session_id ? session.session_id.slice(0, 8) : '';
  return `${runtimeLabel(session.cli || '')}${id ? ` · ${id}` : ' session'}`;
}

/** 프롬프트 전송 가능 여부 — 서버 규칙(진행 중만 불가; idle/closed 는 재오픈)의 UI 거울. */
export function canPrompt(status: AgentSessionStatus | string | null | undefined): boolean {
  return status !== 'busy' && status !== 'awaiting_permission' && status !== 'awaiting_input' && status !== 'starting';
}

export interface SessionAuthView {
  /** 한 줄 표시: "Claude Max · parn@example.com". */
  text: string;
  /** 자격증명이 어디서 왔는지 — 화면에서는 tooltip 으로만 보여 준다. */
  title: string;
  /** 로그아웃 상태만 눈에 띄게 한다 — 나머지는 조용한 정보다. */
  tone: 'muted' | 'danger';
}

/**
 * 세션 헤더에 쓸 계정 한 줄. 어댑터가 신원을 알려 주지 않으면(=null) 아무것도 그리지 않는다 —
 * "모른다" 를 "로그아웃" 처럼 보이게 하면 안 된다. 두 번째 줄은 `detail` 우선, 없으면 이메일.
 * `credentialName` 은 CLI 설정에 묶인 Credential 이름(서버는 id 만 주므로 화면이 합친다).
 */
export function describeSessionAuth(auth: AgentSessionAuth | null | undefined, credentialName?: string | null): SessionAuthView | null {
  if (!auth) return null;
  const primary = auth.label || auth.kind || 'Unknown account';
  const secondary = auth.detail || auth.account?.email || '';
  const org = auth.account?.organization;
  return {
    text: [primary, secondary].filter(Boolean).join(' · '),
    title: auth.source === 'credential'
      ? `Signed in with the workspace credential${credentialName ? ` "${credentialName}"` : ''}${org ? ` (${org})` : ''}`
      : `Uses the Runtime Host's own CLI login${org ? ` (${org})` : ''}`,
    tone: auth.kind === 'none' ? 'danger' : 'muted',
  };
}

/** 사용자 결정을 기다리는 상태(permission / 질문·폼). */
export function isWaitingStatus(status: AgentSessionStatus | string | null | undefined): boolean {
  return status === 'awaiting_permission' || status === 'awaiting_input';
}

/**
 * 세션 페이지에 들어왔을 때 자동으로 연결(session/load)할지. 프로세스가 없는 `idle` 만 —
 * 모델·모드 같은 설정 목록은 어댑터가 살아 있어야 오기 때문이다. `closed` 는 사용자가 일부러
 * 멈춘 것이고 `error` 는 원인을 보여 줘야 하므로 Connect 버튼으로만 다시 연다.
 */
export function shouldAutoConnect(status: AgentSessionStatus | string | null | undefined): boolean {
  return status === 'idle';
}

/** 수동 Connect 버튼을 보일 상태 — 프로세스가 없거나 죽은 상태 전부. */
export function canConnect(status: AgentSessionStatus | string | null | undefined): boolean {
  return status === 'idle' || status === 'closed' || status === 'error';
}

/** Display label for a CLI id — the catalog label, the raw id for ids the
 *  catalog doesn't know, 'CLI' when empty. Kept under this name because the
 *  sessions surface (and its tests) import it everywhere. */
export function runtimeLabel(runtime: string): string {
  return runtime ? cliLabel(runtime) : 'CLI';
}
