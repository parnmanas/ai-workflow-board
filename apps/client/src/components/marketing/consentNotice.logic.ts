import { t as translate } from '../../i18n/core';
/**
 * 수신 동의 재확인 안내 화면의 규칙(docs/marketing.md "동의 재확인 안내", 정보통신망법 §50⑧).
 *
 * 서버(apps/server/src/common/marketing/consent-notice.ts · marketing-constants.ts)가 정본이다. 이 파일은 저장하기 전에
 * 같은 판정을 미리 보여 줄 뿐이다 — test/marketing-consent-notice.test.mjs 가 둘이 갈라지면 실패한다.
 */
import type {
  MarketingConsentNoticeCounts,
  MarketingConsentNoticePolicy,
  MarketingConsentNoticeSettings,
  MarketingConsentNoticeSettingsInput,
  MarketingContact,
} from '../../types';
import { formatCount, type StatusView } from './marketing.logic';

export const CONSENT_NOTICE_POLICIES: MarketingConsentNoticePolicy[] = ['keep', 'lapse'];
export const CONSENT_NOTICE_LEAD_DAYS = { min: 7, max: 90, default: 30 } as const;
export const CONSENT_NOTICE_SUBJECT_MAX = 200;
export const CONSENT_NOTICE_BODY_MAX = 5000;
export const CONSENT_NOTICE_PLACEHOLDERS = ['name', 'sender', 'consent_date', 'due_date'] as const;
export type ConsentNoticePlaceholder = (typeof CONSENT_NOTICE_PLACEHOLDERS)[number];
export const CONSENT_NOTICE_STATUSES = ['queued', 'deferred', 'sending', 'sent', 'failed', 'skipped'] as const;

/** 무응답 처리 — 안내가 무엇을 제시했느냐로 정해진다(KISA 해석). 받는 사람에게 실제로 그렇게 안내된다. */
export const CONSENT_NOTICE_POLICY_LABELS: Record<MarketingConsentNoticePolicy, { label: string; detail: string }> = {
  keep: {
    get label() { return translate('응답이 없으면 동의 유지'); },
    get detail() { return translate('안내에 철회 방법을 알립니다. 철회하지 않으면 동의가 이어지고, 원래 주기의 기한부터 다시 2년입니다. 유지 링크는 누르지 않아도 됩니다.'); },
  },
  lapse: {
    get label() { return translate('응답이 없으면 동의 철회'); },
    get detail() { return translate('안내에 유지 방법을 알립니다. 기한까지 유지 링크를 누른 사람에게만 계속 보내고, 누르지 않은 사람은 기한에 발송 대상에서 빠집니다.'); },
  },
};

export const CONSENT_NOTICE_PLACEHOLDER_LABELS: Record<ConsentNoticePlaceholder, string> = {
  get name() { return translate('받는 사람 이름(없으면 주소의 @ 앞)'); },
  get sender() { return translate('보내는 채널의 발신자 이름'); },
  get consent_date() { return translate('동의한 날짜'); },
  get due_date() { return translate('동의 기한'); },
};

const STATUS: Record<string, StatusView> = {
  queued: { get label() { return translate('보낼 예정'); }, tone: 'queued' },
  deferred: { get label() { return translate('미룸'); }, tone: 'stalled' },
  sending: { get label() { return translate('보내는 중'); }, tone: 'live' },
  sent: { get label() { return translate('보냄'); }, tone: 'done' },
  failed: { get label() { return translate('실패'); }, tone: 'failed' },
  skipped: { get label() { return translate('건너뜀'); }, tone: 'idle' },
};

export function consentNoticeStatusView(status: string): StatusView {
  return STATUS[status] || { label: status || '—', tone: 'idle' };
}

/** 그 사람 화면의 날짜(YYYY-MM-DD). */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface ConsentNoticeDraft {
  enabled: boolean;
  subject: string;
  body: string;
  /** 입력 칸 그대로(숫자 검증은 저장할 때). */
  lead_days: string;
  on_no_response: MarketingConsentNoticePolicy;
}

export function consentNoticeDraftFrom(settings: MarketingConsentNoticeSettings): ConsentNoticeDraft {
  return {
    enabled: settings.enabled,
    subject: settings.subject,
    body: settings.body,
    lead_days: String(settings.lead_days),
    on_no_response: settings.on_no_response,
  };
}

const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** 알 수 없는 자리표시자 — 서버가 400 으로 거부하는 오타. */
export function unknownPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!(CONSENT_NOTICE_PLACEHOLDERS as readonly string[]).includes(m[1])) out.add(m[0]);
  }
  return [...out];
}

/** 저장 · 미리보기 본문과 서버가 거부할 사유(있으면). */
export function consentNoticePayload(draft: ConsentNoticeDraft): { payload: MarketingConsentNoticeSettingsInput; errors: string[] } {
  const errors: string[] = [];
  const subject = draft.subject.replace(/[\r\n\t]+/g, ' ').trim();
  const body = draft.body.replace(/\r\n?/g, '\n').trimEnd();
  const leadText = draft.lead_days.trim();
  const lead = /^\d+$/.test(leadText) ? Number(leadText) : Number.NaN;
  if (!Number.isInteger(lead) || lead < CONSENT_NOTICE_LEAD_DAYS.min || lead > CONSENT_NOTICE_LEAD_DAYS.max) {
    errors.push(translate('발송 시점은 기한 {0}–{1}일 전 사이의 정수여야 합니다', { 0: CONSENT_NOTICE_LEAD_DAYS.min, 1: CONSENT_NOTICE_LEAD_DAYS.max }));
  }
  if (!subject) errors.push(translate('제목을 적어 주세요'));
  if (subject.length > CONSENT_NOTICE_SUBJECT_MAX) errors.push(translate('제목은 {0}자까지입니다', { 0: CONSENT_NOTICE_SUBJECT_MAX }));
  if (body.length > CONSENT_NOTICE_BODY_MAX) errors.push(translate('본문은 {0}자까지입니다', { 0: CONSENT_NOTICE_BODY_MAX }));
  const unknown = unknownPlaceholders(`${subject}\n${body}`);
  if (unknown.length) {
    errors.push(translate('모르는 자리표시자: {0} — {1} 만 쓸 수 있습니다', { 0: unknown.join(', '), 1: CONSENT_NOTICE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ') }));
  }
  return {
    payload: {
      enabled: draft.enabled,
      subject,
      body,
      lead_days: Number.isInteger(lead) ? lead : undefined,
      on_no_response: draft.on_no_response,
    },
    errors,
  };
}

/** 연락처 화면 위 한 줄 — 켜졌는지 · 언제 · 무응답이면 어떻게. */
export function consentNoticeSummary(settings: MarketingConsentNoticeSettings): string {
  if (!settings.enabled) return translate('꺼짐 — 동의 2년이 지난 연락처는 발송에서 빠지기만 합니다');
  return translate('켜짐 · 기한 {0}일 전 · {1}', { 0: settings.lead_days, 1: CONSENT_NOTICE_POLICY_LABELS[settings.on_no_response]?.label || settings.on_no_response });
}

/** 현황 숫자(0 이어도 보여 준다 — 무엇을 세는지가 설명이다). */
export function consentNoticeCountItems(counts: MarketingConsentNoticeCounts): Array<{ key: string; label: string; value: string; warn?: boolean }> {
  return [
    { key: 'in_window', label: translate('안내 기간에 든 브랜드 동의'), value: formatCount(counts.in_window) },
    { key: 'waiting', label: translate('보낼 예정 · 미룸'), value: formatCount(counts.waiting) },
    {
      key: 'waiting_no_sender',
      label: translate('그중 보낼 메일 채널 없음'),
      value: formatCount(counts.waiting_no_sender),
      warn: counts.waiting_no_sender > 0,
    },
    { key: 'sent_30d', label: translate('최근 30일 보냄'), value: formatCount(counts.sent_30d) },
    { key: 'kept_30d', label: translate('최근 30일 유지 클릭'), value: formatCount(counts.kept_30d) },
    { key: 'failed_30d', label: translate('최근 30일 실패'), value: formatCount(counts.failed_30d), warn: counts.failed_30d > 0 },
    {
      key: 'failed_retryable',
      label: translate('실패 — 기한 전이라 다시 보낼 수 있음'),
      value: formatCount(counts.failed_retryable),
      warn: counts.failed_retryable > 0,
    },
    { key: 'expired', label: translate('기한이 이미 지난 브랜드 동의'), value: formatCount(counts.expired), warn: counts.expired > 0 },
  ];
}

/**
 * 연락처 한 명의 동의 기한과 재확인 안내 상태 — 표의 "동의 증거" 칸 아래 줄.
 * 기한이 지난 subscribed 연락처는 새 동의가 있어야 다시 받는다(안내로 되살리지 않는다).
 */
export function contactConsentLine(contact: MarketingContact, now: Date = new Date()): { due: string; expired: boolean; notice: string | null } {
  const dueAt = contact.consent_due_at ? new Date(contact.consent_due_at) : null;
  const expired = !!dueAt && contact.status === 'subscribed' && dueAt.getTime() < now.getTime();
  const n = contact.consent_notice;
  let notice: string | null = null;
  if (n) {
    if (n.status === 'sent') {
      notice = translate('재확인 안내 {0} 보냄 · {1}', { 0: formatDay(n.sent_at), 1: n.policy === 'lapse' ? translate('응답 없으면 철회') : translate('응답 없으면 유지') });
      if (n.bounce_type) notice += translate(' · 닿지 않음');
      if (n.kept_at) notice += translate(' · {0} 유지함', { 0: formatDay(n.kept_at) });
      else if (n.renewed_at) notice += translate(' · 응답 없어 이어짐');
    } else if (n.status === 'queued' || n.status === 'deferred' || n.status === 'sending') {
      notice = translate('재확인 안내 보낼 예정');
    } else if (n.status === 'failed') {
      notice = translate('재확인 안내 실패');
    }
  }
  return { due: formatDay(contact.consent_due_at), expired, notice };
}
