// Marketing 수신 동의 재확인 안내 — 순수 규칙(docs/marketing.md "동의 재확인 안내", 정보통신망법 §50⑧ · 시행령 §62의3).
//
// 고정하는 것:
//   1. 동의 기간: 기준점은 consent_at 과 consent_renewed_at 중 늦은 쪽, 기한은 거기서 730 일. 기한까지 유효하다.
//   2. 안내 창: 기한 lead_days 일 전부터 기한 전까지만 — 지난 기한의 동의는 안내로 되살리지 않는다.
//   3. 안내 메일: 운영자 문구 뒤에 서버가 법정 항목(보낸 곳 · 동의한 날짜 · 유지 · 철회 방법)과 무응답 처리를 붙인다.
//      광고 표기를 붙이지 않고, 날짜는 받는 사람의 시간대로 쓴다. 철회는 마케팅 메일과 같은 수신거부 링크 · One-Click.
//   4. 설정 검증: 발송 시점 범위, 무응답 처리, 제목 한 줄, 길이, 알 수 없는 자리표시자.
//
// 실행: node --test --test-force-exit test/marketing-consent-notice-logic.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSENT_MAX_AGE_MS, consentAnchor, consentDeadline, consentFresh, localDate,
} from '../dist/common/marketing/email.js';
import {
  DEFAULT_CONSENT_NOTICE_SETTINGS, composeConsentNotice, consentNoticeDueAt, renderConsentNoticeText,
  sampleConsentNoticeContact, unknownPlaceholders, validateConsentNoticeSettings,
} from '../dist/common/marketing/consent-notice.js';
import {
  CONSENT_NOTICE_LEAD_DAYS, CONSENT_NOTICE_PLACEHOLDERS, CONSENT_NOTICE_POLICIES,
} from '../dist/common/marketing/marketing-constants.js';

const DAY = 24 * 60 * 60_000;
const sender = {
  from_name: 'AWB Team', from_address: 'hello@awb.example.com', reply_to: '', postal_address: '1 Main St, Seoul',
  contact_email: 'help@awb.example.com', ad_label: '[Ad]',
};

test('consent period: the later of the consent and its renewal, valid for 730 days', () => {
  const consentAt = new Date('2024-11-01T03:00:00Z');
  assert.equal(consentDeadline({ consent_at: consentAt }).getTime(), consentAt.getTime() + CONSENT_MAX_AGE_MS);
  assert.equal(CONSENT_MAX_AGE_MS, 730 * DAY);
  const renewed = new Date(consentAt.getTime() + CONSENT_MAX_AGE_MS);
  assert.equal(consentAnchor({ consent_at: consentAt, consent_renewed_at: renewed }).getTime(), renewed.getTime());
  assert.equal(consentAnchor({ consent_at: consentAt, consent_renewed_at: null }).getTime(), consentAt.getTime());
  assert.equal(
    consentAnchor({ consent_at: '2026-01-01T00:00:00Z', consent_renewed_at: '2025-06-01T00:00:00Z' }).toISOString(),
    '2026-01-01T00:00:00.000Z', 'a newer consent wins over an older renewal',
  );
  const deadline = consentDeadline({ consent_at: consentAt });
  assert.equal(consentFresh({ consent_at: consentAt }, deadline), true, 'valid up to the deadline itself');
  assert.equal(consentFresh({ consent_at: consentAt }, new Date(deadline.getTime() + 1)), false);
  assert.equal(consentFresh({ consent_at: consentAt, consent_renewed_at: renewed }, new Date(deadline.getTime() + DAY)), true,
    'a renewed consent runs two more years from the old deadline');
  assert.equal(consentFresh(consentAt, new Date(deadline.getTime() + 1)), false, 'a bare consent date still works');
});

test('notice window: from lead_days before the deadline until the deadline, never after', () => {
  const c = { consent_at: new Date('2024-11-01T03:00:00Z') };
  const deadline = consentDeadline(c);
  assert.equal(consentNoticeDueAt(c, 30, new Date(deadline.getTime() - 30 * DAY - 1)), null, 'not yet');
  assert.equal(consentNoticeDueAt(c, 30, new Date(deadline.getTime() - 30 * DAY)).getTime(), deadline.getTime(), 'window opens');
  assert.equal(consentNoticeDueAt(c, 30, new Date(deadline.getTime() - 1)).getTime(), deadline.getTime());
  assert.equal(consentNoticeDueAt(c, 30, deadline), null, 'a lapsed consent is not revived by a notice');
  const renewed = { ...c, consent_renewed_at: deadline };
  assert.equal(consentNoticeDueAt(renewed, 30, new Date(deadline.getTime() - DAY)), null, 'the renewed cycle is not due again');
  assert.equal(consentNoticeDueAt(renewed, 30, new Date(deadline.getTime() + CONSENT_MAX_AGE_MS - DAY)).getTime(),
    deadline.getTime() + CONSENT_MAX_AGE_MS, 'the next cycle counts from the old deadline, not from the notice');
});

test('dates in the notice are the recipient\'s dates', () => {
  assert.equal(localDate(new Date('2026-10-22T16:00:00Z'), 'Asia/Seoul'), '2026-10-23');
  assert.equal(localDate(new Date('2026-10-22T02:00:00Z'), 'America/New_York'), '2026-10-21');
  assert.equal(localDate(new Date('2026-10-22T16:00:00Z'), 'Not/AZone'), '2026-10-23', 'unknown zones fall back to Seoul');
});

test('settings: lead time range, no-response policy, one-line subject, sizes and placeholders', () => {
  const current = { ...DEFAULT_CONSENT_NOTICE_SETTINGS };
  assert.deepEqual(validateConsentNoticeSettings({}, current), { value: current }, 'missing keys keep the current values');
  assert.deepEqual(CONSENT_NOTICE_POLICIES, ['keep', 'lapse']);
  assert.equal(DEFAULT_CONSENT_NOTICE_SETTINGS.enabled, false, 'off until the operator turns it on');
  assert.equal(DEFAULT_CONSENT_NOTICE_SETTINGS.on_no_response, 'keep');
  assert.equal(DEFAULT_CONSENT_NOTICE_SETTINGS.lead_days, CONSENT_NOTICE_LEAD_DAYS.default);
  for (const lead_days of [CONSENT_NOTICE_LEAD_DAYS.min - 1, CONSENT_NOTICE_LEAD_DAYS.max + 1, 7.5, 'soon']) {
    assert.match(validateConsentNoticeSettings({ lead_days }, current).error, /lead_days/, String(lead_days));
  }
  assert.equal(validateConsentNoticeSettings({ lead_days: CONSENT_NOTICE_LEAD_DAYS.min }, current).value.lead_days, 7);
  assert.equal(validateConsentNoticeSettings({ lead_days: '90' }, current).value.lead_days, 90);
  assert.match(validateConsentNoticeSettings({ on_no_response: 'ignore' }, current).error, /on_no_response/);
  assert.equal(validateConsentNoticeSettings({ on_no_response: 'lapse' }, current).value.on_no_response, 'lapse');
  assert.match(validateConsentNoticeSettings({ enabled: 'yes' }, current).error, /enabled/);
  assert.match(validateConsentNoticeSettings({ subject: '   ' }, current).error, /subject is required/);
  assert.equal(validateConsentNoticeSettings({ subject: 'Line one\r\nBcc: x@example.com' }, current).value.subject, 'Line one Bcc: x@example.com',
    'a subject is one line');
  assert.match(validateConsentNoticeSettings({ subject: 'x'.repeat(201) }, current).error, /subject is longer/);
  assert.match(validateConsentNoticeSettings({ body: 'x'.repeat(5001) }, current).error, /body is longer/);
  assert.equal(validateConsentNoticeSettings({ body: '' }, current).value.body, '', 'the body may be empty — the legal items are added by the server');
  const typo = validateConsentNoticeSettings({ body: '안녕하세요 {{nmae}}님 {{ sender }}' }, current);
  assert.match(typo.error, /unknown placeholder \{\{nmae\}\}/);
  assert.match(typo.error, /\{\{name\}\}, \{\{sender\}\}, \{\{consent_date\}\}, \{\{due_date\}\}/);
  assert.deepEqual(CONSENT_NOTICE_PLACEHOLDERS, ['name', 'sender', 'consent_date', 'due_date']);
  assert.deepEqual(unknownPlaceholders('{{name}} {{ due_date }} {{x}} {{x}} {{}}'), ['{{x}}', '{{}}']);
  assert.deepEqual(unknownPlaceholders(DEFAULT_CONSENT_NOTICE_SETTINGS.subject + DEFAULT_CONSENT_NOTICE_SETTINGS.body), []);
});

test('notice (keep): operator text first, then the legal items — sender, consent date, keep and withdraw — no ad label', () => {
  const dueAt = new Date('2026-11-30T15:30:00Z'); // 2026-12-01 00:30 KST
  const mail = composeConsentNotice({
    sender,
    subject: DEFAULT_CONSENT_NOTICE_SETTINGS.subject,
    body: '{{name}}님, {{sender}}입니다. {{consent_date}} 동의 · 기한 {{due_date}}',
    policy: 'keep',
    contact: { name: '김민지', email: 'kim@example.com', consent_at: new Date('2024-11-30T16:00:00Z'), timezone: 'Asia/Seoul' },
    dueAt,
    keepUrl: 'https://awb.example.com/api/m/c/KEEP',
    unsubscribeUrl: 'https://awb.example.com/api/m/u/UNSUB',
  });
  assert.equal(mail.subject, '[AWB Team] 광고성 정보 수신 동의 확인 안내 / Your email consent');
  assert.ok(!mail.subject.includes('(광고)') && !mail.subject.includes('[Ad]'), 'a legal notice is not an advertisement');
  assert.ok(mail.text.startsWith('김민지님, AWB Team입니다. 2024-12-01 동의 · 기한 2026-12-01\n\n--\n'), mail.text);
  assert.match(mail.text, /보낸 곳 \/ Sender: AWB Team/);
  assert.match(mail.text, /2024-12-01에 AWB Team의 광고성 정보\(이메일\) 수신에 동의하셨습니다/, 'the consent date in the recipient\'s zone');
  assert.match(mail.text, /아무것도 하지 않으셔도 됩니다 — 동의가 그대로 유지됩니다\. 유지 의사를 직접 남기시려면: https:\/\/awb\.example\.com\/api\/m\/c\/KEEP/);
  assert.doesNotMatch(mail.text, /까지 동의를 유지해 주세요/);
  assert.match(mail.text, /그만 받으시려면\(동의 철회, 무료\): https:\/\/awb\.example\.com\/api\/m\/u\/UNSUB/);
  assert.match(mail.text, /광고가 아닙니다/);
  assert.match(mail.text, /AWB Team · 1 Main St, Seoul · help@awb\.example\.com$/);
  assert.deepEqual(mail.headers, {
    'List-Unsubscribe': '<https://awb.example.com/api/m/u/UNSUB>, <mailto:help@awb.example.com?subject=unsubscribe>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
});

test('notice (lapse): says the consent ends on the deadline unless kept', () => {
  const mail = composeConsentNotice({
    sender,
    subject: 'Consent check',
    body: '',
    policy: 'lapse',
    contact: { name: '', email: 'bob@example.com', consent_at: new Date('2024-11-30T12:00:00Z'), timezone: 'America/New_York' },
    dueAt: new Date('2026-11-30T12:00:00Z'),
    keepUrl: 'https://awb.example.com/api/m/c/KEEP',
    unsubscribeUrl: 'https://awb.example.com/api/m/u/UNSUB',
  });
  assert.ok(mail.text.startsWith('--\n'), 'an empty body leaves only the legal block');
  assert.match(mail.text, /계속 받으시려면 2026-11-30까지 동의를 유지해 주세요: https:\/\/awb\.example\.com\/api\/m\/c\/KEEP/);
  assert.match(mail.text, /유지하지 않으시면 2026-11-30부터 이 주소로 광고성 메일을 보내지 않습니다/);
  assert.match(mail.text, /Otherwise we stop sending marketing email to this address on 2026-11-30/);
  assert.doesNotMatch(mail.text, /아무것도 하지 않으셔도/);
  assert.equal(renderConsentNoticeText('{{name}}', { name: 'bob', sender: '', consent_date: '', due_date: '' }), 'bob');
  const noName = composeConsentNotice({
    sender, subject: 'Hi {{name}}', body: 'Hi {{name}}', policy: 'lapse',
    contact: { name: 'Line\nBreak', email: 'bob@example.com', consent_at: new Date(), timezone: 'Asia/Seoul' },
    dueAt: new Date(), keepUrl: 'k', unsubscribeUrl: 'u',
  });
  assert.equal(noName.subject, 'Hi Line Break', 'names cannot break the subject line');
  const fallback = composeConsentNotice({
    sender, subject: 'Hi {{name}}', body: '', policy: 'keep',
    contact: { name: '  ', email: 'bob@example.com', consent_at: new Date(), timezone: 'Asia/Seoul' },
    dueAt: new Date(), keepUrl: 'k', unsubscribeUrl: 'u',
  });
  assert.equal(fallback.subject, 'Hi bob', 'no name → the address before @');
});

test('preview sample: a recipient whose deadline is lead_days away', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  const sample = sampleConsentNoticeContact(now, 30);
  assert.equal(sample.dueAt.getTime(), now.getTime() + 30 * DAY);
  assert.equal(consentDeadline(sample).getTime(), sample.dueAt.getTime());
  assert.equal(consentNoticeDueAt(sample, 30, now).getTime(), sample.dueAt.getTime(), 'it is due right now');
});
