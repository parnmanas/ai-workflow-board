// Marketing 승인 대기 알림 — 순수 규칙(docs/marketing.md "승인 대기 알림").
//
// 고정하는 것:
//   1. 지출 요청의 알림 종류는 지금 상태로 정한다: 승인 없는 pending = 새 요청(요청한 사람 제외), 승인 있는 pending =
//      두 번째 승인(이미 승인한 사람 · 요청한 사람 제외), unknown = 결과 불명(아무도 빼지 않음). 만료가 지난 pending 과
//      끝난 요청은 알리지 않는다. 채널 · 게시물 · 편성은 사람이 만든 것이면 그 사람을 뺀다.
//   2. 묶음: 계정의 가장 새 항목 뒤로 2분 조용해야 보낸다. 사이클이 돌면 burst 종류는 기다린다. 결과 불명 · 두 번째 승인은
//      사이클도, 다른 항목의 묶음도 기다리지 않는다(생긴 지 2분이면 보낸다). 어떤 항목도 15분을 넘겨 기다리지 않는다.
//   3. 받는 사람: 그 결정의 권한(manage / approve_spend)이 있어야 하고, 빠진 사람은 받지 않는다.
//   4. 본문: 급한 순서, 금액 · 수취인 · 만료까지 남은 시간, 캠페인 링크. 넘치는 것은 "외 n" 으로 줄인다.
//
// 실행: node --test test/marketing-approval-notice-logic.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_NOTICE_KINDS,
  APPROVAL_NOTICE_MAX_WAIT_MS,
  APPROVAL_NOTICE_QUIET_MS,
  APPROVAL_NOTICE_RULES,
  approvalDigestDue,
  approvalNoticesFor,
  composeApprovalDigest,
  proposalNoticeCandidate,
  spendNoticeCandidate,
} from '../dist/common/marketing/approval-notice.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

function spendRow(over = {}) {
  return {
    id: 'sr1',
    account_id: 'acc',
    campaign_id: 'camp',
    status: 'pending',
    amount_minor: 50000,
    currency: 'KRW',
    payee: 'Ads Co',
    expires_at: new Date(NOW.getTime() + 71.5 * HOUR),
    approvals: [],
    requested_by_type: 'agent',
    requested_by_id: 'rt-agent',
    created_at: ago(10 * MIN),
    updated_at: ago(10 * MIN),
    ...over,
  };
}

function candidate(kind, over = {}) {
  return {
    kind,
    entity_id: `${kind}-${Math.random().toString(36).slice(2, 8)}`,
    account_id: 'acc',
    campaign_id: 'camp',
    at: ago(5 * MIN),
    exclude_user_ids: [],
    ...over,
  };
}

test('spend request kind comes from its current state', () => {
  const fresh = spendNoticeCandidate(spendRow(), NOW);
  assert.equal(fresh.kind, 'spend_pending');
  assert.deepEqual(fresh.exclude_user_ids, [], 'an agent requester is nobody to leave out');
  assert.equal(fresh.at.getTime(), ago(10 * MIN).getTime(), 'a new request is timed from its creation');
  assert.deepEqual(fresh.spend, { amount_minor: 50000, currency: 'KRW', payee: 'Ads Co', expires_at: spendRow().expires_at });

  const byPerson = spendNoticeCandidate(spendRow({ requested_by_type: 'user', requested_by_id: 'u-req' }), NOW);
  assert.deepEqual(byPerson.exclude_user_ids, ['u-req'], 'the requester cannot approve their own request');

  const firstApprovedAt = ago(3 * MIN).toISOString();
  const second = spendNoticeCandidate(spendRow({
    requested_by_type: 'user',
    requested_by_id: 'u-req',
    dual_required: true,
    approvals: [{ user_id: 'u-first', name: 'First', at: firstApprovedAt }],
    updated_at: ago(3 * MIN),
  }), NOW);
  assert.equal(second.kind, 'spend_second_approval');
  assert.deepEqual(second.exclude_user_ids.sort(), ['u-first', 'u-req']);
  assert.equal(second.at.toISOString(), firstApprovedAt, 'timed from the first approval');

  const unknown = spendNoticeCandidate(spendRow({
    status: 'unknown',
    requested_by_type: 'user',
    requested_by_id: 'u-req',
    approvals: [{ user_id: 'u-first', name: 'First', at: firstApprovedAt }],
    updated_at: ago(1 * MIN),
  }), NOW);
  assert.equal(unknown.kind, 'spend_unknown');
  assert.deepEqual(unknown.exclude_user_ids, [], 'everyone who approves spend can reconcile');
  assert.equal(unknown.at.getTime(), ago(1 * MIN).getTime(), 'timed from when it became unknown');
  assert.equal(unknown.spend.expires_at, null, 'an unknown payment has no approval deadline');

  assert.equal(spendNoticeCandidate(spendRow({ expires_at: ago(1) }), NOW), null, 'expired pending is the sweep\'s to close');
  for (const status of ['approved', 'executing', 'paid', 'failed', 'denied', 'expired', 'cancelled']) {
    assert.equal(spendNoticeCandidate(spendRow({ status }), NOW), null, `${status} needs no decision`);
  }
});

test('proposals leave out the person who made them', () => {
  const row = { id: 'c1', account_id: 'acc', campaign_id: 'camp', created_at: ago(4 * MIN), platform: 'reddit' };
  const byAgent = proposalNoticeCandidate('channel_proposed', { ...row, by_type: 'agent', by_id: 'rt-agent' }, NOW);
  assert.deepEqual(byAgent.exclude_user_ids, []);
  assert.equal(byAgent.platform, 'reddit');
  assert.equal(byAgent.at.getTime(), ago(4 * MIN).getTime());
  const byPerson = proposalNoticeCandidate('post_draft', { ...row, platform: undefined, by_type: 'user', by_id: 'u1' }, NOW);
  assert.deepEqual(byPerson.exclude_user_ids, ['u1']);
  assert.equal('platform' in byPerson, false);
  const broken = proposalNoticeCandidate('allocation_proposed', { ...row, created_at: 'not a date', by_type: 'agent', by_id: '' }, NOW);
  assert.equal(broken.at.getTime(), NOW.getTime(), 'an unreadable time never becomes NaN');
});

test('digests wait for a quiet account, for a running cycle, but never past the cap', () => {
  const none = new Set();
  assert.equal(approvalDigestDue([], NOW, none), false);
  assert.equal(approvalDigestDue([candidate('post_draft', { at: ago(APPROVAL_NOTICE_QUIET_MS - 1) })], NOW, none), false, 'still arriving');
  assert.equal(approvalDigestDue([candidate('post_draft', { at: ago(APPROVAL_NOTICE_QUIET_MS) })], NOW, none), true, 'quiet for 2 minutes');
  assert.equal(
    approvalDigestDue([candidate('post_draft', { at: ago(10 * MIN) }), candidate('channel_proposed', { at: ago(30 * 1000) })], NOW, none),
    false,
    'the newest item in the account restarts the quiet window',
  );

  const cycle = new Set(['camp']);
  assert.equal(approvalDigestDue([candidate('post_draft', { at: ago(5 * MIN) })], NOW, cycle), false, 'the agent is still working');
  assert.equal(
    approvalDigestDue([candidate('post_draft', { at: ago(5 * MIN), campaign_id: 'other' })], NOW, cycle),
    true,
    'only the campaign whose cycle is running waits',
  );
  for (const kind of ['spend_unknown', 'spend_second_approval']) {
    assert.equal(APPROVAL_NOTICE_RULES[kind].burst, false);
    assert.equal(approvalDigestDue([candidate(kind, { at: ago(3 * MIN) })], NOW, cycle), true, `${kind} does not wait for the cycle`);
    assert.equal(approvalDigestDue([candidate(kind, { at: ago(APPROVAL_NOTICE_QUIET_MS - 1) })], NOW, none), false,
      `${kind} still gathers others of its kind for 2 minutes`);
    // 다른 캠페인 · 같은 캠페인의 사이클이 초안을 계속 쏟아내도 기다리지 않는다(리뷰 지적).
    const burst = [candidate('post_draft', { at: ago(10 * 1000), campaign_id: 'other' }), candidate('post_draft', { at: ago(5 * 1000) })];
    assert.equal(approvalDigestDue([candidate(kind, { at: ago(APPROVAL_NOTICE_QUIET_MS) }), ...burst], NOW, cycle), true,
      `${kind} goes out in the middle of an agent's burst`);
    assert.equal(approvalDigestDue([candidate(kind, { at: ago(APPROVAL_NOTICE_QUIET_MS - 1) }), ...burst], NOW, none), false);
  }
  for (const kind of ['spend_pending', 'allocation_proposed', 'channel_proposed', 'post_draft']) {
    assert.equal(APPROVAL_NOTICE_RULES[kind].burst, true, `${kind} is produced in bursts`);
  }
  assert.equal(
    approvalDigestDue([candidate('post_draft', { at: ago(APPROVAL_NOTICE_MAX_WAIT_MS) }), candidate('post_draft', { at: ago(10 * 1000) })], NOW, cycle),
    true,
    'nothing waits longer than 15 minutes, even mid-burst and mid-cycle',
  );
});

test('recipients need the permission of the decision and are not left out', () => {
  const items = [
    candidate('spend_unknown'),
    candidate('spend_second_approval', { exclude_user_ids: ['u-first'] }),
    candidate('allocation_proposed'),
    candidate('channel_proposed'),
    candidate('post_draft', { exclude_user_ids: ['u-manager'] }),
  ];
  const kinds = (user) => approvalNoticesFor(user, items).map((i) => i.kind);
  assert.deepEqual(kinds({ id: 'u-admin', role: 'admin', permissions: [] }),
    ['spend_unknown', 'spend_second_approval', 'allocation_proposed', 'channel_proposed', 'post_draft']);
  assert.deepEqual(kinds({ id: 'u-manager', role: 'user', permissions: ['marketing.manage'] }), ['channel_proposed'],
    'manage decides channels and posts — not the one it drafted itself');
  assert.deepEqual(kinds({ id: 'u-first', role: 'user', permissions: ['marketing.approve_spend'] }), ['spend_unknown', 'allocation_proposed'],
    'approve_spend decides money — but not a second approval of its own first approval');
  assert.deepEqual(kinds({ id: 'u-plain', role: 'user', permissions: ['tickets.create'] }), []);
});

test('digest body: urgent first, amounts and deadlines, campaign link', () => {
  const campaigns = new Map([['camp', { name: 'AWB  Launch\n' }], ['other', { name: 'Docs' }]]);
  const items = [
    candidate('post_draft'),
    candidate('post_draft'),
    candidate('channel_proposed', { platform: 'reddit' }),
    candidate('channel_proposed', { platform: 'github' }),
    candidate('channel_proposed', { platform: 'reddit' }),
    candidate('spend_pending', { spend: { amount_minor: 50000, currency: 'KRW', payee: 'Ads Co', expires_at: new Date(NOW.getTime() + 71.5 * HOUR) } }),
    candidate('spend_unknown', { spend: { amount_minor: 1999, currency: 'USD', payee: 'Ads Co', expires_at: null } }),
  ];
  const digest = composeApprovalDigest(items, campaigns, { now: NOW, baseUrl: 'https://awb.example/' });
  assert.equal(digest.title, '마케팅 결정 대기 7건 — AWB Launch');
  assert.equal(digest.url, 'https://awb.example/marketing/camp');
  const lines = digest.body.split('\n');
  assert.deepEqual(lines, [
    'AWB Launch',
    '• 결제 결과 불명 1건: 19.99 USD → Ads Co — 결제됐는지 확인해 결과를 기록하세요',
    '• 지출 요청 1건: 50,000 KRW → Ads Co (만료까지 71시간)',
    '• 채널 제안 3건 (reddit, github)',
    '• 게시물 초안 2건',
  ]);

  const two = composeApprovalDigest([
    candidate('post_draft', { campaign_id: 'other' }),
    candidate('spend_second_approval', { spend: { amount_minor: 900000, currency: 'KRW', payee: 'Ads Co', expires_at: new Date(NOW.getTime() + 20 * MIN) } }),
  ], campaigns, { now: NOW, baseUrl: 'https://awb.example' });
  assert.equal(two.title, '마케팅 결정 대기 2건 (캠페인 2개)');
  assert.equal(two.url, 'https://awb.example/marketing', 'several campaigns link to the list');
  assert.deepEqual(two.body.split('\n\n'), [
    'AWB Launch\n• 두 번째 승인 대기 1건: 900,000 KRW → Ads Co (1시간 안에 만료) — 2인 승인 대상이라 다른 승인자가 필요합니다',
    'Docs\n• 게시물 초안 1건',
  ], 'the campaign with the most urgent item comes first');

  assert.equal(composeApprovalDigest(items, campaigns, { now: NOW }).url, undefined, 'no AWB_PUBLIC_URL, no link');
  assert.equal(composeApprovalDigest([candidate('post_draft', { campaign_id: 'gone' })], campaigns, { now: NOW }).body,
    '(이름 없는 캠페인)\n• 게시물 초안 1건');
});

test('digest body stays short: overflow becomes "외 n"', () => {
  const spends = Array.from({ length: 5 }, (_, i) => candidate('spend_pending', {
    spend: { amount_minor: 1000 * (i + 1), currency: 'KRW', payee: 'Ads Co', expires_at: new Date(NOW.getTime() + 2 * HOUR) },
  }));
  const body = composeApprovalDigest(spends, new Map([['camp', { name: 'A' }]]), { now: NOW }).body;
  assert.match(body, /• 지출 요청 5건: 1,000 KRW → Ads Co \(만료까지 2시간\), 2,000 KRW → Ads Co \(만료까지 2시간\), 3,000 KRW → Ads Co \(만료까지 2시간\) 외 2건$/);

  const platforms = ['reddit', 'github', 'hacker_news', 'product_hunt', 'x', 'linkedin', 'discord'];
  const channelBody = composeApprovalDigest(platforms.map((platform) => candidate('channel_proposed', { platform })), new Map(), { now: NOW }).body;
  assert.match(channelBody, /• 채널 제안 7건 \(reddit, github, hacker_news, product_hunt, x 외 2\)$/);

  const many = new Map();
  const manyItems = [];
  for (let i = 0; i < 7; i++) {
    many.set(`c${i}`, { name: `Campaign ${i}` });
    manyItems.push(candidate('post_draft', { campaign_id: `c${i}` }));
  }
  const crowded = composeApprovalDigest(manyItems, many, { now: NOW });
  assert.equal(crowded.title, '마케팅 결정 대기 7건 (캠페인 7개)');
  assert.equal(crowded.body.split('\n\n').length, 6, 'five campaigns and a remainder line');
  assert.match(crowded.body, /외 캠페인 2개$/);

  const longName = new Map([['camp', { name: 'x'.repeat(500) }]]);
  const kinds = APPROVAL_NOTICE_KINDS.flatMap((kind) => Array.from({ length: 40 }, () => candidate(kind, {
    platform: kind === 'channel_proposed' ? 'reddit' : undefined,
    spend: kind.startsWith('spend_') ? { amount_minor: 123456789, currency: 'KRW', payee: 'p'.repeat(300), expires_at: null } : undefined,
  })));
  const huge = composeApprovalDigest(kinds, longName, { now: NOW });
  assert.ok(huge.body.length <= 1500 + 2, `body is bounded (${huge.body.length})`);
  assert.ok(huge.title.length < 120, 'campaign names are clipped in the title');
});
