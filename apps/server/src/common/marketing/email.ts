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

export function consentFresh(consentAt: Date, now: Date): boolean {
  return now.getTime() - new Date(consentAt).getTime() <= CONSENT_MAX_AGE_MS;
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
    headers: {
      'List-Unsubscribe': `<${input.unsubscribeUrl}>, <mailto:${input.sender.contact_email}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
