/**
 * 수신 동의 재확인 안내 — 순수 규칙(docs/marketing.md "동의 재확인 안내").
 *
 * 정보통신망법 §50⑧ · 시행령 §62의3: 광고성 정보 수신 동의를 받은 자는 그 동의일부터 2 년마다(2 년이 되는 날 전까지)
 * 받는 사람에게 (1) 전송자 명칭, (2) 수신 동의 사실과 동의한 날짜, (3) 유지 · 철회 의사를 표시하는 방법을 알려야 한다.
 *   - 기산일은 원래 동의일이다. 안내를 보낸 날부터 다시 세지 않는다 — "응답이 없으면 유지" 로 안내가 나간 연락처는 그
 *     주기의 기한부터 다시 2 년이다(`consent_renewed_at`).
 *   - 받은 사람이 유지 링크를 누르면 새 동의다 — `consent_at` 이 그 시각이 되고 2 년을 그때부터 다시 센다.
 *   - 무응답의 의미는 안내가 무엇을 제시했느냐로 정해진다(KISA 해석): 철회 방법을 안내했으면 유지(`keep`), 유지 방법을
 *     안내했으면 철회(`lapse`). 아래 고정 문단이 그 정책을 받는 사람에게 그대로 말한다.
 *   - 안내는 광고가 아니고 광고와 섞지 않는다 — 제목에 광고 표기를 붙이지 않는다.
 *   - 이미 지난 기한의 동의는 안내로 되살리지 않는다(동의를 다시 묻는 메일 자체가 광고성 정보다). 기한 전에만 보낸다.
 */
import {
  CONSENT_MAX_AGE_MS,
  consentDeadline,
  listUnsubscribeHeaders,
  localDate,
  type ComposedEmail,
  type ConsentPeriod,
  type EmailSender,
} from './email';
import {
  CONSENT_NOTICE_BODY_MAX,
  CONSENT_NOTICE_LEAD_DAYS,
  CONSENT_NOTICE_PLACEHOLDERS,
  CONSENT_NOTICE_POLICIES,
  CONSENT_NOTICE_SUBJECT_MAX,
  type ConsentNoticePlaceholder,
  type ConsentNoticePolicy,
} from './marketing-constants';

const DAY_MS = 24 * 60 * 60_000;

/** 유지 링크를 기한 뒤에도 이만큼 받는다 — 늦게 메일을 연 사람이 누른 "유지" 는 그 자체로 새 동의다. */
export const CONSENT_KEEP_GRACE_MS = 30 * DAY_MS;

/** 안내의 유지 링크로 남은 동의의 방법(연락처 consent_method). 가져오기의 방법 목록과 달리 서버만 쓴다. */
export const RECONFIRM_CONSENT_METHOD = 'reconfirm';

export const DEFAULT_CONSENT_NOTICE_SUBJECT = '[{{sender}}] 광고성 정보 수신 동의 확인 안내 / Your email consent';
export const DEFAULT_CONSENT_NOTICE_BODY = [
  '안녕하세요, {{name}}님. {{sender}}입니다.',
  '{{consent_date}}에 동의해 주신 광고성 정보(이메일) 수신 동의를 2년마다 확인해 알려 드립니다.',
  '',
  'Hello {{name}}, this is {{sender}}. Every two years we remind you of the consent you gave on {{consent_date}} to receive our marketing email.',
].join('\n');

export interface ConsentNoticeSettingsValue {
  enabled: boolean;
  subject: string;
  body: string;
  lead_days: number;
  on_no_response: ConsentNoticePolicy;
}

export const DEFAULT_CONSENT_NOTICE_SETTINGS: ConsentNoticeSettingsValue = {
  enabled: false,
  subject: DEFAULT_CONSENT_NOTICE_SUBJECT,
  body: DEFAULT_CONSENT_NOTICE_BODY,
  lead_days: CONSENT_NOTICE_LEAD_DAYS.default,
  on_no_response: 'keep',
};

/** 이번 주기의 안내를 보낼 때인가 — 기한 leadDays 일 전부터 기한 전까지면 그 기한, 아니면 null. */
export function consentNoticeDueAt(c: ConsentPeriod, leadDays: number, now: Date): Date | null {
  const deadline = consentDeadline(c).getTime();
  const t = now.getTime();
  if (t >= deadline || t < deadline - leadDays * DAY_MS) return null;
  return new Date(deadline);
}

const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

function isPlaceholder(key: string): key is ConsentNoticePlaceholder {
  return (CONSENT_NOTICE_PLACEHOLDERS as readonly string[]).includes(key);
}

/** 알 수 없는 자리표시자 — `{{nmae}}` 같은 오타가 받는 사람에게 그대로 가지 않게 저장할 때 거부한다. */
export function unknownPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!isPlaceholder(m[1])) out.add(m[0]);
  }
  return [...out];
}

export function renderConsentNoticeText(text: string, values: Record<ConsentNoticePlaceholder, string>): string {
  return text.replace(PLACEHOLDER_RE, (whole, key: string) => (isPlaceholder(key) ? values[key] : whole));
}

function oneLine(v: string): string {
  return v.replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * 설정 저장 본문 검증. 빠진 키는 지금 값을 쓴다. 제목은 한 줄, 본문은 비워도 된다 — 법이 요구하는 항목은 서버가 붙이는
 * 고정 문단에 다 들어 있다.
 */
export function validateConsentNoticeSettings(
  body: Record<string, unknown>,
  current: ConsentNoticeSettingsValue,
): { value: ConsentNoticeSettingsValue } | { error: string } {
  const value: ConsentNoticeSettingsValue = { ...current };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be true or false' };
    value.enabled = body.enabled;
  }
  if (body.subject !== undefined) {
    if (typeof body.subject !== 'string') return { error: 'subject must be a string' };
    value.subject = oneLine(body.subject);
  }
  if (body.body !== undefined) {
    if (typeof body.body !== 'string') return { error: 'body must be a string' };
    value.body = body.body.replace(/\r\n?/g, '\n').trimEnd();
  }
  if (body.lead_days !== undefined) {
    const n = Number(body.lead_days);
    if (!Number.isInteger(n) || n < CONSENT_NOTICE_LEAD_DAYS.min || n > CONSENT_NOTICE_LEAD_DAYS.max) {
      return { error: `lead_days must be a whole number of days between ${CONSENT_NOTICE_LEAD_DAYS.min} and ${CONSENT_NOTICE_LEAD_DAYS.max}` };
    }
    value.lead_days = n;
  }
  if (body.on_no_response !== undefined) {
    if (!(CONSENT_NOTICE_POLICIES as readonly unknown[]).includes(body.on_no_response)) {
      return { error: `on_no_response must be one of: ${CONSENT_NOTICE_POLICIES.join(', ')}` };
    }
    value.on_no_response = body.on_no_response as ConsentNoticePolicy;
  }
  if (!value.subject) return { error: 'subject is required' };
  if (value.subject.length > CONSENT_NOTICE_SUBJECT_MAX) return { error: `subject is longer than ${CONSENT_NOTICE_SUBJECT_MAX} characters` };
  if (value.body.length > CONSENT_NOTICE_BODY_MAX) return { error: `body is longer than ${CONSENT_NOTICE_BODY_MAX} characters` };
  const unknown = unknownPlaceholders(`${value.subject}\n${value.body}`);
  if (unknown.length) {
    return { error: `unknown placeholder ${unknown.join(', ')} — use ${CONSENT_NOTICE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}` };
  }
  return { value };
}

export interface ConsentNoticeContact {
  name: string;
  email: string;
  consent_at: Date | string;
  timezone: string;
}

/**
 * 안내 메일 한 통. 운영자의 제목 · 본문 뒤에 서버가 고정 문단을 붙인다: 보낸 곳, 동의한 날짜, 유지 방법(정책대로 무응답이면
 * 어떻게 되는지까지), 철회(수신거부) 방법, 발신자 연락처. 철회는 마케팅 메일과 같은 수신거부 링크 · One-Click 헤더다.
 * 날짜는 받는 사람의 시간대로 쓴다.
 */
export function composeConsentNotice(input: {
  sender: EmailSender;
  subject: string;
  body: string;
  policy: ConsentNoticePolicy;
  contact: ConsentNoticeContact;
  dueAt: Date;
  keepUrl: string;
  unsubscribeUrl: string;
}): ComposedEmail {
  const tz = input.contact.timezone || 'Asia/Seoul';
  const consentDate = localDate(input.contact.consent_at, tz);
  const dueDate = localDate(input.dueAt, tz);
  const sender = oneLine(input.sender.from_name) || input.sender.from_address;
  const values: Record<ConsentNoticePlaceholder, string> = {
    name: oneLine(input.contact.name) || input.contact.email.split('@')[0],
    sender,
    consent_date: consentDate,
    due_date: dueDate,
  };
  const keep = input.policy === 'keep'
    ? [
      `· 계속 받으시려면 아무것도 하지 않으셔도 됩니다 — 동의가 그대로 유지됩니다. 유지 의사를 직접 남기시려면: ${input.keepUrl}`,
      `  To keep receiving it, you need not do anything — your consent stays. To confirm it anyway: ${input.keepUrl}`,
    ]
    : [
      `· 계속 받으시려면 ${dueDate}까지 동의를 유지해 주세요: ${input.keepUrl}`,
      `  유지하지 않으시면 ${dueDate}부터 이 주소로 광고성 메일을 보내지 않습니다.`,
      `  To keep receiving it, confirm by ${dueDate}: ${input.keepUrl}`,
      `  Otherwise we stop sending marketing email to this address on ${dueDate}.`,
    ];
  const block = [
    '--',
    '[광고성 정보 수신 동의 확인 / Marketing email consent check]',
    `· 보낸 곳 / Sender: ${sender}`,
    `· ${consentDate}에 ${sender}의 광고성 정보(이메일) 수신에 동의하셨습니다.`,
    `  You agreed on ${consentDate} to receive marketing email from ${sender}.`,
    ...keep,
    `· 그만 받으시려면(동의 철회, 무료): ${input.unsubscribeUrl}`,
    `  To stop receiving it (withdraw your consent, free): ${input.unsubscribeUrl}`,
    '',
    '이 메일은 정보통신망법 제50조제8항에 따라 수신 동의 여부를 확인하는 안내이며 광고가 아닙니다.',
    'This is a consent check required by law, not an advertisement.',
    `${input.sender.from_name} · ${input.sender.postal_address} · ${input.sender.contact_email}`,
  ].join('\n');
  const body = renderConsentNoticeText(input.body, values).trim();
  return {
    subject: oneLine(renderConsentNoticeText(input.subject, values)),
    text: body ? `${body}\n\n${block}` : block,
    headers: listUnsubscribeHeaders(input.sender, input.unsubscribeUrl),
  };
}

/** 미리보기의 예시 받는 사람 — 기한이 지금부터 leadDays 일 뒤인 연락처. */
export function sampleConsentNoticeContact(now: Date, leadDays: number): ConsentNoticeContact & { dueAt: Date } {
  const dueAt = new Date(now.getTime() + leadDays * DAY_MS);
  return {
    name: '홍길동',
    email: 'gildong@example.com',
    consent_at: new Date(dueAt.getTime() - CONSENT_MAX_AGE_MS),
    timezone: 'Asia/Seoul',
    dueAt,
  };
}
