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
import type { AgentSessionAuth, AgentSessionCommand, AgentSessionEventRecord, AgentSessionStatus } from '../../types';

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
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 12);
  return { active: true, query, matches };
}

/** 선택한 명령을 입력창 텍스트로 — 인자를 받는 명령이면 뒤에 공백을 둬 바로 이어 칠 수 있게 한다. */
export function applySlashCommand(command: AgentSessionCommand): string {
  return `/${command.name}${command.input_hint ? ' ' : ''}`;
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

export function describeSessionStatus(status: AgentSessionStatus | string | null | undefined): StatusView {
  switch (status) {
    case 'idle':
      return { label: 'Idle', tone: 'muted', live: false };
    case 'starting':
      return { label: 'Starting', tone: 'accent', live: true };
    case 'ready':
      return { label: 'Ready', tone: 'success', live: true };
    case 'busy':
      return { label: 'Working', tone: 'accent', live: true };
    case 'awaiting_permission':
      return { label: 'Needs your approval', tone: 'warning', live: true };
    case 'awaiting_input':
      return { label: 'Needs your input', tone: 'warning', live: true };
    case 'closed':
      return { label: 'Closed', tone: 'muted', live: false };
    case 'error':
      return { label: 'Error', tone: 'danger', live: false };
    default:
      return { label: String(status || 'Unknown'), tone: 'muted', live: false };
  }
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
