import type { OperatorEntry } from './operator-config';
import type { AnnouncementLanguage } from './announcement-text';

/**
 * 작업 보고의 순수 규칙(docs/voice-operator.md "작업 보고"). AWB 를 거쳐 연결된 세션의 턴이 끝나거나
 * 사용자의 결정을 기다리면, AWB 가 그것을 알아채 **operator 에게 보고**하고, operator 가 쓴 요약이
 * 사용자에게 소리로 간다. 세션마다 따로 말하지 않는다 — 말하는 것은 operator 하나다.
 */

/**
 * 보고 프롬프트의 첫머리. 화면이 이 줄로 보고를 알아보고 접어 보여 준다
 * (`apps/client/src/components/sessions/sessionTranscript.logic.ts` — 같은 문자열을 계약 테스트가 고정한다).
 */
export const OPERATOR_REPORT_PREFIX = '[AWB 작업 보고]';

export type SessionReportKind = 'finished' | 'failed' | 'needs_permission' | 'needs_input';

export interface ReportedSession {
  manager_id: string;
  manager_name: string;
  cli: string;
  cli_label: string;
  session_id: string;
  title: string;
  cwd: string;
}

/** 승인·질문 보고에 싣는, 답을 전하는 데 필요한 것(요청 id · 선택지 · 칸). */
export interface ReportedRequest {
  kind: 'permission' | 'question';
  id: string;
  title: string;
  options: Array<{ option_id: string; name: string }>;
  fields: QuestionField[];
}

/** 턴 안에서 정해진 것 — 권한 요청의 선택 · 질문의 답(누가 정했는지 포함). 끝난 턴의 보고에 실린다. */
export interface ReportedDecision {
  kind: 'permission' | 'question';
  /** 요청 제목 · 질문 문장. */
  title: string;
  /** 고른 선택지 이름 · 답한 값 · 거절/취소. */
  outcome: string;
  /** 매니저의 decided_by — 'user'(화면 또는 operator 가 전한 사용자의 답) · 'timeout' · 'system' · 'agent'. */
  by: string;
}

export interface SessionReport {
  kind: SessionReportKind;
  /**
   * 그 일이 일어날 때 사용자가 그 세션 화면을 보고 있었다. 그래도 operator 에게는 보고한다(operator 가 사이트의
   * 흐름을 알게) — 다만 소리로는 전하지 않는다(사용자는 이미 보고 있다).
   */
  viewed?: boolean;
  /** 끝난 턴에서 정해진 것들(권한 선택 · 질문의 답). */
  decisions?: ReportedDecision[];
  /** 승인·질문이면 그 요청 — operator 가 선택지를 읽어 주고, 사용자가 고르면 이것으로 답을 전한다. */
  request?: ReportedRequest;
  /** 소식을 들을 사람 — 그 세션의 driver. */
  user_id: string;
  session: ReportedSession;
  /** 끝난 턴: 마지막 답 · 실패: 오류 문구 · 권한: 요청 제목과 선택지 · 질문: 질문. */
  detail: string;
  /** 끝난 턴의 길이(모르면 null). */
  duration_ms: number | null;
  at: number;
}

/** 사용자의 입력·선택을 기다리는 보고 — 오래 미루면 요청이 시간 초과로 취소된다(매니저 15분). */
export function isUrgentReport(report: SessionReport): boolean {
  return report.kind === 'needs_permission' || report.kind === 'needs_input';
}

/**
 * 보고 받을 operator 후보를 순서대로. **같은 호스트**의 operator 가 먼저(여럿이면 최근에 대화한 순), 없으면
 * **가장 최근에 대화한** operator. 대화 기록이 없으면 등록 순서다. 첫 후보에 닿지 못할 때(호스트 꺼짐)
 * 다음 후보로 넘어가려고 목록으로 돌려준다.
 */
export function routeOperators(operators: readonly OperatorEntry[], managerId: string, lastConversation: ReadonlyMap<string, number> = new Map()): OperatorEntry[] {
  const recency = (op: OperatorEntry) => Math.max(lastConversation.get(op.id) ?? 0, Date.parse(op.last_conversation_at || '') || 0);
  const ordered = operators
    .map((op, index) => ({ op, index, at: recency(op) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ op }) => op);
  return [...ordered.filter((op) => op.manager_id === managerId), ...ordered.filter((op) => op.manager_id !== managerId)];
}

/** 같은 세션의 보고가 쌓이면 새것이 옛것을 대신한다(끝난 뒤의 "대기" 보고는 의미가 없다). */
export function mergeReport(queue: readonly SessionReport[], next: SessionReport): SessionReport[] {
  const same = (r: SessionReport) => r.session.manager_id === next.session.manager_id
    && r.session.cli === next.session.cli && r.session.session_id === next.session.session_id;
  return [...queue.filter((r) => !same(r)), next];
}

/** 보고 한 건에 싣는 상세의 상한 — operator 가 요약할 거리는 되지만 프롬프트를 덮지는 않게. */
export const REPORT_DETAIL_CHARS = 1500;
/** 한 번에 묶어 보내는 보고 수. */
export const MAX_REPORTS_PER_PROMPT = 6;

function clip(text: string, max: number, lang: AnnouncementLanguage): string {
  const t = (text || '').trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()} …(${lang === 'ko' ? '생략' : 'truncated'})`;
}

function minutes(ms: number | null, lang: AnnouncementLanguage): string {
  if (ms === null) return '';
  const min = Math.round(ms / 60_000);
  if (lang === 'ko') return min >= 1 ? ` · ${min}분` : ` · ${Math.max(1, Math.round(ms / 1000))}초`;
  return min >= 1 ? ` · ${min} min` : ` · ${Math.max(1, Math.round(ms / 1000))} s`;
}

const KIND_LABEL: Record<AnnouncementLanguage, Record<SessionReportKind, string>> = {
  ko: { finished: '완료', failed: '오류', needs_permission: '승인 필요', needs_input: '답변 필요' },
  en: { finished: 'finished', failed: 'failed', needs_permission: 'needs approval', needs_input: 'needs an answer' },
};

const DETAIL_LABEL: Record<AnnouncementLanguage, Record<SessionReportKind, string>> = {
  ko: { finished: '마지막 답', failed: '오류', needs_permission: '요청', needs_input: '질문' },
  en: { finished: 'Last answer', failed: 'Error', needs_permission: 'Request', needs_input: 'Question' },
};

/**
 * operator 에게 보내는 보고 프롬프트. 첫 줄의 지시는 지침(`operatorBrief`)과 같은 말을 되풀이한다 — 긴
 * operator 세션에서 지침이 요약돼 흐려져도 보고 하나하나가 무엇을 해야 하는지 스스로 말하게.
 */
export function composeReportPrompt(reports: readonly SessionReport[], lang: AnnouncementLanguage): string {
  const lines: string[] = [];
  const spoken = reports.filter((r) => !r.viewed);
  const decisions = spoken.some((r) => r.request);
  if (!spoken.length) {
    // 사용자가 모두 화면에서 보고 있었다 — 소리로 전하지 않는다. operator 는 흐름만 알면 된다.
    lines.push(lang === 'ko'
      ? `${OPERATOR_REPORT_PREFIX} 다른 세션 소식 ${reports.length}건입니다. 모두 사용자가 그 세션 화면에서 보고 있던 것이라 소리로 전하지 않습니다 — 기록으로만 알아 두고, 한 문장으로 짧게 확인만 답하세요. 승인이나 답은 사용자가 화면에서 직접 합니다. 이 보고에는 [[sleep]] 을 붙이지 마세요.`
      : `${OPERATOR_REPORT_PREFIX} ${reports.length} update(s) from other sessions. The user was looking at all of them, so nothing is spoken — just take note and acknowledge in one short sentence. The user answers any request on screen. Do not add [[sleep]] to this reply.`);
  } else if (lang === 'ko') {
    lines.push(`${OPERATOR_REPORT_PREFIX} 다른 세션 소식 ${reports.length}건입니다. AWB가 사용자에게 알림음만 보냅니다. 이 보고는 문맥에 기억하고 화면용 요약을 1~2문장으로 답하세요. 사용자가 "무슨 일이야", "자세히 알려줘"처럼 물으면 그때 어느 장비의 어느 세션이 어떻게 됐는지 설명하세요. 이 보고에는 [[sleep]] 을 붙이지 마세요.`
      + (spoken.length < reports.length ? ' "보고 있음" 표시가 붙은 건은 사용자가 이미 화면에서 보고 있으니 요약에서 빼세요(기록으로만 알아 두면 됩니다).' : '')
      + (decisions ? ' 사용자가 상세를 요청하면 무엇을 정해야 하는지와 번호 붙은 선택지를 설명하세요. 이 보고에서는 아무것도 승인하거나 답하지 마세요. 선택지를 아직 설명하지 않았는데 숫자만 들으면 먼저 선택지를 설명하고 확인하세요. 사용자가 명시적으로 고른 뒤 그 사용자 턴에서 "답 전하기" 도구로 전합니다(보고 턴에서는 AWB가 거절합니다).' : ''));
  } else {
    lines.push(`${OPERATOR_REPORT_PREFIX} ${reports.length} update(s) from other sessions. AWB sends only a notification sound. Remember these reports and acknowledge with a short on-screen summary. Explain the host, session and result only when the user asks what happened or requests details. Do not add [[sleep]] to this reply.`
      + (spoken.length < reports.length ? ' Leave out the ones marked "viewed" — the user already sees them on screen (just take note).' : '')
      + (decisions ? ' When asked for details, explain what needs a decision and the numbered choices. Do not approve or answer anything in this report. If the user gives only a number before hearing the choices, explain them and confirm first. Pass an explicit user choice on in that user turn with the tool under "Answer with" (AWB refuses it in this report turn).' : ''));
  }
  reports.forEach((r, i) => {
    const s = r.session;
    const title = s.title ? (lang === 'ko' ? ` · '${s.title}'` : ` · "${s.title}"`) : '';
    lines.push('');
    const viewed = r.viewed ? (lang === 'ko' ? ' · 보고 있음' : ' · viewed') : '';
    lines.push(`${i + 1}. ${KIND_LABEL[lang][r.kind]} — ${s.manager_name} / ${s.cli_label}${title}${r.kind === 'finished' ? minutes(r.duration_ms, lang) : ''}${viewed}`);
    if (s.cwd) lines.push(`   ${lang === 'ko' ? '작업 폴더' : 'Folder'}: ${s.cwd}`);
    if (r.request) {
      lines.push(...requestLines(r, lang));
      return;
    }
    if (r.decisions?.length) {
      lines.push(`   ${lang === 'ko' ? '이 턴에서 정해진 것' : 'Decided in this turn'}:`);
      for (const d of r.decisions) lines.push(`   - ${decisionLine(d, lang)}`);
    }
    const detail = clip(r.detail, REPORT_DETAIL_CHARS, lang);
    if (detail) {
      lines.push(`   ${DETAIL_LABEL[lang][r.kind]}:`);
      lines.push('   """');
      for (const line of detail.split('\n')) lines.push(`   ${line}`);
      lines.push('   """');
    }
  });
  return lines.join('\n');
}

const DECIDED_BY: Record<AnnouncementLanguage, Record<string, string>> = {
  ko: { user: '사용자', timeout: '시간 초과', system: '중단', agent: '에이전트' },
  en: { user: 'the user', timeout: 'timed out', system: 'interrupted', agent: 'the agent' },
};

/** "'Run npm publish' → Allow once (사용자)". */
export function decisionLine(d: ReportedDecision, lang: AnnouncementLanguage): string {
  const by = DECIDED_BY[lang][d.by] || d.by;
  return `'${clip(d.title, 160, lang) || (lang === 'ko' ? '(제목 없음)' : '(untitled)')}' → ${clip(d.outcome, 200, lang)}${by ? ` (${by})` : ''}`;
}

const numbered = (items: string[]) => items.map((item, i) => `${i + 1}) ${item}`).join('  ');

/** 승인·질문 — 무엇을 정해야 하는지, 번호 붙은 선택지, 그리고 답을 전할 도구 호출에 들어갈 값. */
function requestLines(r: SessionReport, lang: AnnouncementLanguage): string[] {
  const q = r.request!;
  const s = r.session;
  const where = `manager_id="${s.manager_id}", cli="${s.cli}", session_id="${s.session_id}"`;
  const out: string[] = [];
  const ko = lang === 'ko';
  if (q.kind === 'permission') {
    out.push(`   ${ko ? '요청' : 'Request'}: ${clip(q.title, 300, lang) || (ko ? '(제목 없음)' : '(untitled)')}`);
    if (q.options.length) out.push(`   ${ko ? '선택지' : 'Choices'}: ${numbered(q.options.map((o) => o.name))}`);
    out.push(`   ${ko ? '답 전하기' : 'Answer with'}: answer_session_permission(${where}, request_id="${q.id}", option_id=${q.options.map((o, i) => `${i + 1})"${o.option_id}"`).join(' ') || '?'})`);
    return out;
  }
  out.push(`   ${ko ? '질문' : 'Question'}: ${clip(q.title, 600, lang) || (ko ? '(질문 문장 없음)' : '(no text)')}`);
  for (const f of q.fields) {
    const choices = f.choices.length
      ? numbered(f.choices.map((c) => (c.label === c.value ? c.value : `${c.label} ["${c.value}"]`)))
      : (ko ? '자유 입력' : 'free text');
    out.push(`   - ${f.title}${f.title === f.name ? '' : ` (${f.name})`}${f.multiple ? (ko ? ' · 여러 개' : ' · several') : ''}${f.required ? '' : (ko ? ' · 선택' : ' · optional')}: ${choices}`);
  }
  out.push(`   ${ko ? '답 전하기' : 'Answer with'}: answer_session_question(${where}, elicitation_id="${q.id}", action="accept", content={${q.fields.map((f) => `"${f.name}": …`).join(', ')}})`);
  return out;
}

// ─── 질문(elicitation form) 읽기 ─────────────────────────────────────────

export interface QuestionField {
  name: string;
  title: string;
  type: string;
  required: boolean;
  /** 여러 개를 고르는 칸(array). */
  multiple: boolean;
  /** 고를 수 있는 값 — 없으면 자유 입력. */
  choices: Array<{ value: string; label: string }>;
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

function choicesOf(def: any): Array<{ value: string; label: string }> {
  if (!def || typeof def !== 'object') return [];
  const list = Array.isArray(def.oneOf) && def.oneOf.length ? def.oneOf
    : Array.isArray(def.anyOf) && def.anyOf.length ? def.anyOf : null;
  if (list) {
    return list
      .map((o: any) => ({ value: str(o?.const ?? o?.value ?? o?.enum?.[0]), label: str(o?.title) || str(o?.const ?? o?.value ?? o?.enum?.[0]) }))
      .filter((o: { value: string }) => o.value);
  }
  if (Array.isArray(def.enum)) return def.enum.map((v: unknown) => ({ value: str(v), label: str(v) })).filter((o: { value: string }) => o.value);
  return [];
}

/**
 * 질문의 JSON Schema → 칸 목록(화면 `sessionTranscript.logic.ts` `elicitationFormView` 와 같은 규칙: enum ·
 * oneOf/anyOf 의 const+title, 배열이면 items 의 선택지). operator 가 선택지를 읽어 주고 고른 값을 그대로 보낸다.
 */
export function questionFields(schema: unknown): QuestionField[] {
  const s: any = schema && typeof schema === 'object' ? schema : {};
  const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
  return Object.entries(props).map(([name, def]: [string, any]) => {
    const type = typeof def?.type === 'string' ? def.type : 'string';
    const multiple = type === 'array';
    return {
      name,
      title: str(def?.title) || name,
      type,
      required: required.has(name),
      multiple,
      choices: multiple ? choicesOf(def?.items) : choicesOf(def),
    };
  });
}

/** 권한 요청 이벤트 → 보고 상세("Run npm publish — 선택지: Allow / Reject"). */
export function permissionDetail(payload: any, lang: AnnouncementLanguage): string {
  const title = String(payload?.title || '').trim();
  const description = String(payload?.description || '').trim();
  const options = Array.isArray(payload?.options) ? payload.options.map((o: any) => String(o?.name || o?.option_id || '').trim()).filter(Boolean) : [];
  const parts = [title, description].filter(Boolean).join(' — ');
  const choice = options.length ? `${lang === 'ko' ? '선택지' : 'Options'}: ${options.join(' / ')}` : '';
  return [parts, choice].filter(Boolean).join('\n');
}

/** 질문(elicitation) 이벤트 → 보고 상세. 폼이면 받을 칸 이름도 함께. */
export function elicitationDetail(payload: any, lang: AnnouncementLanguage): string {
  const message = String(payload?.message || '').trim();
  const props = payload?.schema && typeof payload.schema === 'object' ? payload.schema.properties : null;
  const fields = props && typeof props === 'object'
    ? Object.entries(props).map(([key, def]: [string, any]) => String(def?.title || key)).filter(Boolean)
    : [];
  const asked = fields.length ? `${lang === 'ko' ? '입력 칸' : 'Fields'}: ${fields.join(', ')}` : '';
  return [message, asked].filter(Boolean).join('\n');
}
