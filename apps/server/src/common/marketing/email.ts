/**
 * 마케팅 메일 규칙 — 순수 함수(docs/marketing.md "메일").
 *
 * 한국 정보통신망법 §50 과 CAN-SPAM 이 요구하는 것을 발송 경로가 **강제로** 붙인다. 에이전트가 쓴 본문이 무엇이든
 * 제목 앞 광고 표기, 발신자 이름 · 주소 · 연락처, 무료 수신거부 링크, List-Unsubscribe(One-Click) 헤더가 빠지지
 * 않는다. 수신자 국가를 모르면 한국 규칙을 적용한다(가장 엄격한 쪽).
 */
import { createHash } from 'node:crypto';
import { DEFAULT_EMAIL_AD_LABEL } from './marketing-constants';

export const CONSENT_MAX_AGE_MS = 730 * 24 * 60 * 60_000;
const NIGHT_START_HOUR = 21;
const NIGHT_END_HOUR = 8;

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localHour(at: Date, timezone: string): number {
  const text = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(at);
  return Number.parseInt(text, 10) % 24;
}

/** 수신자 현지 21:00–08:00 이면 true. */
export function isNightFor(at: Date, timezone: string): boolean {
  const h = localHour(at, timezone);
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

/** 야간이 끝나는 가장 가까운 시각(15 분 단위로 찾는다). 야간이 아니면 그대로. */
export function nextSendableAt(at: Date, timezone: string): Date {
  let t = new Date(at.getTime());
  for (let i = 0; i < 24 * 4 + 1 && isNightFor(t, timezone); i++) {
    t = new Date(Math.floor(t.getTime() / 900_000) * 900_000 + 900_000);
  }
  return t;
}

/**
 * 연락처의 동의 기간(docs/marketing.md "동의 재확인 안내"). `consent_at` 은 동의한 시각(증거)이고, `consent_renewed_at` 은
 * "응답이 없으면 유지" 로 재확인 안내가 나간 주기의 기한이다 — 동의는 둘 중 늦은 시각부터 2 년이다.
 */
export interface ConsentPeriod {
  consent_at: Date | string;
  consent_renewed_at?: Date | string | null;
}

export function consentAnchor(c: ConsentPeriod): Date {
  const at = new Date(c.consent_at).getTime();
  const renewed = c.consent_renewed_at ? new Date(c.consent_renewed_at).getTime() : Number.NaN;
  return new Date(Number.isFinite(renewed) && renewed > at ? renewed : at);
}

/** 이 시각까지 동의가 유효하다 — 재확인 안내는 이 시각 **전에** 보내야 한다(시행령 §62의3). */
export function consentDeadline(c: ConsentPeriod): Date {
  return new Date(consentAnchor(c).getTime() + CONSENT_MAX_AGE_MS);
}

/** 동의 2 년 이내인가. 시각 하나(동의 시각)나 연락처의 동의 기간을 받는다. */
export function consentFresh(consent: Date | string | ConsentPeriod, now: Date): boolean {
  const deadline = consent instanceof Date || typeof consent === 'string'
    ? new Date(consent).getTime() + CONSENT_MAX_AGE_MS
    : consentDeadline(consent).getTime();
  return now.getTime() <= deadline;
}

/** 그 시간대의 날짜(YYYY-MM-DD) — 법정 통지의 "동의한 날짜" 는 받는 사람의 날짜로 쓴다. 모르는 시간대는 서울. */
export function localDate(at: Date | string, timezone: string): string {
  const d = new Date(at);
  const tz = timezone && isValidTimezone(timezone) ? timezone : 'Asia/Seoul';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * 스팸 신고율 안전장치(docs/marketing.md "목록 발송 중지"). Gmail · Yahoo 의 대량 발신자 기준은 신고율 0.1% 미만 유지,
 * 0.3% 에는 닿지 말 것이다 — 닿은 목록은 그 발신 도메인 전체의 평판을 깎으므로 사람이 볼 때까지 그 목록의 발송을 멈춘다.
 */
export const COMPLAINT_HOLD_RATE = 0.003;
/** 이보다 적은 신고로는 멈추지 않는다 — 작은 목록에서는 한 사람의 신고만으로 비율을 넘는다. */
export const COMPLAINT_HOLD_MIN = 2;
/** 신고율을 세는 기간: 이 기간에 보낸 메일과 그 메일의 신고. 해제한 목록은 해제 이후만 센다. */
export const COMPLAINT_WINDOW_MS = 30 * 24 * 60 * 60_000;

export interface ListMailStats {
  /** 기간에 공급자가 받은 메일 수. */
  sent: number;
  /** 그중 닿지 않은 것(바운스 · 공급자 억제). */
  bounced: number;
  /** 그중 스팸 신고된 것. */
  complained: number;
}

/** 신고율 = 신고 ÷ 닿은 메일. */
export function complaintRate(stats: ListMailStats): number {
  const delivered = Math.max(stats.sent - stats.bounced, 0);
  if (delivered <= 0) return stats.complained > 0 ? 1 : 0;
  return stats.complained / delivered;
}

export function shouldHoldList(stats: ListMailStats): boolean {
  return stats.complained >= COMPLAINT_HOLD_MIN && complaintRate(stats) >= COMPLAINT_HOLD_RATE;
}

/** 한국 수신자(또는 국가를 모르는 수신자)는 언제나 "(광고)" 로 시작한다. */
export function adLabelFor(channelLabel: string, country: string): string {
  const c = (country || '').toUpperCase();
  if (!c || c === 'KR') return DEFAULT_EMAIL_AD_LABEL;
  return (channelLabel || '').trim() || DEFAULT_EMAIL_AD_LABEL;
}

export function subjectWithLabel(label: string, title: string): string {
  const t = title.trim();
  return t.startsWith(label) ? t : `${label} ${t}`;
}

export interface EmailSender {
  from_name: string;
  from_address: string;
  reply_to: string;
  postal_address: string;
  contact_email: string;
  ad_label: string;
}

export function emailFooter(sender: EmailSender, unsubscribeUrl: string, consentAt: Date): string {
  const consentDate = new Date(consentAt).toISOString().slice(0, 10);
  return [
    '',
    '--',
    `${sender.from_name} · ${sender.postal_address} · ${sender.contact_email}`,
    `수신을 원하지 않으시면 무료로 수신거부할 수 있습니다: ${unsubscribeUrl}`,
    `To stop receiving these emails (free): ${unsubscribeUrl}`,
    `수신 동의일 / Consent date: ${consentDate}`,
  ].join('\n');
}

export interface ComposedEmail {
  subject: string;
  text: string;
  headers: Record<string, string>;
}

/** 메일 앱의 수신거부(RFC 8058 One-Click) — 마케팅 메일과 동의 재확인 안내가 같이 쓴다. */
export function listUnsubscribeHeaders(sender: EmailSender, unsubscribeUrl: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:${sender.contact_email}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export function composeMarketingEmail(input: {
  sender: EmailSender;
  title: string;
  body: string;
  unsubscribeUrl: string;
  contact: { country: string; consent_at: Date };
}): ComposedEmail {
  const label = adLabelFor(input.sender.ad_label, input.contact.country);
  return {
    subject: subjectWithLabel(label, input.title),
    text: `${input.body.trimEnd()}\n${emailFooter(input.sender, input.unsubscribeUrl, input.contact.consent_at)}`,
    headers: listUnsubscribeHeaders(input.sender, input.unsubscribeUrl),
  };
}
