// 수신 동의 재확인 안내 화면의 규칙(docs/marketing.md "동의 재확인 안내").
//
// 서버가 정본이다(apps/server/src/common/marketing/consent-notice.ts · marketing-constants.ts). 화면이 저장 전에 보여 주는 판정
// (저장 버튼을 켤지, 무엇을 보낼지)이 서버와 갈라지면 실패한다 — 갈라지면 사람이 누른 저장이 400 으로 튕기거나, 서버가 받을
// 문구를 화면이 막는다.
//
// 실행: node --import tsx --test --test-force-exit test/marketing-consent-notice.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONSENT_NOTICE_BODY_MAX,
  CONSENT_NOTICE_LEAD_DAYS,
  CONSENT_NOTICE_PLACEHOLDERS,
  CONSENT_NOTICE_POLICIES,
  CONSENT_NOTICE_POLICY_LABELS,
  CONSENT_NOTICE_STATUSES,
  CONSENT_NOTICE_SUBJECT_MAX,
  consentNoticeCountItems,
  consentNoticeDraftFrom,
  consentNoticePayload,
  consentNoticeStatusView,
  consentNoticeSummary,
  contactConsentLine,
  unknownPlaceholders,
} from '../src/components/marketing/consentNotice.logic.ts';
import { CONSENT_METHOD_LABELS } from '../src/components/marketing/marketingContacts.logic.ts';
import * as serverConstants from '../../server/src/common/marketing/marketing-constants.ts';
import * as serverRules from '../../server/src/common/marketing/consent-notice.ts';

test('상수가 서버 원천과 같다 — 무응답 처리 · 발송 시점 범위 · 길이 · 자리표시자 · 상태', () => {
  assert.deepEqual(CONSENT_NOTICE_POLICIES, [...serverConstants.CONSENT_NOTICE_POLICIES]);
  assert.deepEqual({ ...CONSENT_NOTICE_LEAD_DAYS }, { ...serverConstants.CONSENT_NOTICE_LEAD_DAYS });
  assert.equal(CONSENT_NOTICE_SUBJECT_MAX, serverConstants.CONSENT_NOTICE_SUBJECT_MAX);
  assert.equal(CONSENT_NOTICE_BODY_MAX, serverConstants.CONSENT_NOTICE_BODY_MAX);
  assert.deepEqual([...CONSENT_NOTICE_PLACEHOLDERS], [...serverConstants.CONSENT_NOTICE_PLACEHOLDERS]);
  assert.deepEqual([...CONSENT_NOTICE_STATUSES], [...serverConstants.CONSENT_NOTICE_STATUSES]);
  for (const s of CONSENT_NOTICE_STATUSES) assert.notEqual(consentNoticeStatusView(s).label, s, `${s} 라벨`);
  for (const p of CONSENT_NOTICE_POLICIES) assert.ok(CONSENT_NOTICE_POLICY_LABELS[p].detail, `${p} 설명`);
  assert.ok(CONSENT_METHOD_LABELS[serverRules.RECONFIRM_CONSENT_METHOD], '유지 링크로 남은 동의의 방법도 라벨이 있다');
});

test('저장 전 판정이 서버 검증과 같다', () => {
  const settings = { ...serverRules.DEFAULT_CONSENT_NOTICE_SETTINGS, version: 0, updated_by_name: '', updated_at: null };
  const base = consentNoticeDraftFrom(settings);
  const cases = [
    {},
    { lead_days: '7' },
    { lead_days: '90' },
    { lead_days: '6' },
    { lead_days: '91' },
    { lead_days: '7.5' },
    { lead_days: ' 30 ' },
    { lead_days: '' },
    { subject: '' },
    { subject: '  ' },
    { subject: 'x'.repeat(200) },
    { subject: 'x'.repeat(201) },
    { subject: 'Line\nbreak' },
    { body: '' },
    { body: 'x'.repeat(5000) },
    { body: 'x'.repeat(5001) },
    { body: '{{name}}님 {{ sender }} {{consent_date}} {{due_date}}' },
    { body: '{{nmae}}님' },
    { subject: '[{{brand}}] 안내' },
    { on_no_response: 'lapse' },
    { enabled: true },
  ];
  for (const patch of cases) {
    const draft = { ...base, ...patch };
    const client = consentNoticePayload(draft);
    const server = serverRules.validateConsentNoticeSettings(
      { ...client.payload, lead_days: client.payload.lead_days ?? draft.lead_days },
      serverRules.DEFAULT_CONSENT_NOTICE_SETTINGS,
    );
    assert.equal(client.errors.length === 0, 'value' in server, `${JSON.stringify(patch)} — 화면 ${JSON.stringify(client.errors)} / 서버 ${JSON.stringify(server)}`);
    if ('value' in server) {
      assert.equal(server.value.subject, client.payload.subject);
      assert.equal(server.value.body, client.payload.body);
      assert.equal(server.value.lead_days, client.payload.lead_days);
    }
  }
  for (const text of ['{{name}} {{x}} {{ due_date }} {{}}', serverRules.DEFAULT_CONSENT_NOTICE_SUBJECT, '{{ nmae }}']) {
    assert.deepEqual(unknownPlaceholders(text), serverRules.unknownPlaceholders(text), text);
  }
});

test('요약 · 현황 · 연락처 한 줄', () => {
  const settings = { ...serverRules.DEFAULT_CONSENT_NOTICE_SETTINGS, version: 1, updated_by_name: 'Kim', updated_at: null };
  assert.match(consentNoticeSummary(settings), /^꺼짐/);
  assert.equal(consentNoticeSummary({ ...settings, enabled: true }), '켜짐 · 기한 30일 전 · 응답이 없으면 동의 유지');
  assert.equal(consentNoticeSummary({ ...settings, enabled: true, lead_days: 14, on_no_response: 'lapse' }), '켜짐 · 기한 14일 전 · 응답이 없으면 동의 철회');
  const items = consentNoticeCountItems({
    in_window: 3, not_yet_queued: 1, waiting: 2, waiting_no_sender: 1, sent_30d: 5, failed_30d: 0, failed_retryable: 1, skipped_30d: 1, kept_30d: 2, expired: 4,
  });
  assert.deepEqual(items.filter((i) => i.warn).map((i) => i.key), ['waiting_no_sender', 'failed_retryable', 'expired']);

  const now = new Date('2026-10-22T00:00:00Z');
  const contact = (overrides = {}) => ({
    id: 'ct-1', account_id: 'acc', email: 'kim@example.com', name: 'Kim', lists: ['newsletter'], status: 'subscribed',
    consent_method: 'signup_form', consent_source: 'https://ex.com', consent_at: '2024-11-01T00:00:00.000Z',
    consent_due_at: '2026-11-01T00:00:00.000Z', consent_text_version: '', night_consent: false, country: 'KR',
    timezone: 'Asia/Seoul', unsubscribed_at: null, unsubscribe_source: '', consent_notice: null,
    created_at: '2024-11-01T00:00:00.000Z', updated_at: '2024-11-01T00:00:00.000Z', ...overrides,
  });
  assert.deepEqual(contactConsentLine(contact(), now), { due: '2026-11-01', expired: false, notice: null });
  assert.equal(contactConsentLine(contact({ consent_due_at: '2026-10-01T00:00:00.000Z' }), now).expired, true);
  assert.equal(contactConsentLine(contact({ consent_due_at: '2026-10-01T00:00:00.000Z', status: 'unsubscribed' }), now).expired, false,
    '수신거부한 사람에게는 기한이 의미가 없다');
  const notice = { id: 'n-1', status: 'sent', due_at: '2026-11-01T00:00:00.000Z', policy: 'lapse', sent_at: '2026-10-02T03:00:00.000Z', kept_at: null };
  assert.match(contactConsentLine(contact({ consent_notice: notice }), now).notice, /^재확인 안내 2026-10-0\d 보냄 · 응답 없으면 철회$/);
  assert.match(contactConsentLine(contact({ consent_notice: { ...notice, policy: 'keep', kept_at: '2026-10-05T03:00:00.000Z' } }), now).notice,
    /응답 없으면 유지 · 2026-10-0\d 유지함$/);
  assert.match(contactConsentLine(contact({ consent_notice: { ...notice, policy: 'keep', renewed_at: '2026-11-01T00:00:00.000Z' } }), now).notice,
    /응답 없으면 유지 · 응답 없어 이어짐$/);
  assert.match(contactConsentLine(contact({ consent_notice: { ...notice, bounce_type: 'soft' } }), now).notice, / · 닿지 않음$/);
  assert.equal(contactConsentLine(contact({ consent_notice: { ...notice, status: 'deferred' } }), now).notice, '재확인 안내 보낼 예정');
  assert.equal(contactConsentLine(contact({ consent_notice: { ...notice, status: 'failed' } }), now).notice, '재확인 안내 실패');
  assert.equal(contactConsentLine(contact({ consent_notice: { ...notice, status: 'skipped' } }), now).notice, null);
});
