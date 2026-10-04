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

export interface SessionReport {
  kind: SessionReportKind;
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
  if (lang === 'ko') {
    lines.push(`${OPERATOR_REPORT_PREFIX} 다른 세션 소식 ${reports.length}건입니다. 사용자에게 소리로 전할 요약을 1~2문장으로 답하세요 — 어느 장비의 어느 세션인지 이름으로 말하고, 입력이나 선택이 필요하면 무엇을 정해야 하는지 분명히. 여러 건이면 묶어서 짧게. 이 보고에는 [[sleep]] 을 붙이지 마세요.`);
  } else {
    lines.push(`${OPERATOR_REPORT_PREFIX} ${reports.length} update(s) from other sessions. Reply with a 1–2 sentence summary the user will hear — name the host and session, and if input or a choice is needed say exactly what. Keep several updates together and short. Do not add [[sleep]] to this reply.`);
  }
  reports.forEach((r, i) => {
    const s = r.session;
    const title = s.title ? (lang === 'ko' ? ` · '${s.title}'` : ` · "${s.title}"`) : '';
    lines.push('');
    lines.push(`${i + 1}. ${KIND_LABEL[lang][r.kind]} — ${s.manager_name} / ${s.cli_label}${title}${r.kind === 'finished' ? minutes(r.duration_ms, lang) : ''}`);
    if (s.cwd) lines.push(`   ${lang === 'ko' ? '작업 폴더' : 'Folder'}: ${s.cwd}`);
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
