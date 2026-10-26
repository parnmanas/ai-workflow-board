import { setLocale } from '../src/i18n/core.ts';
// These fixtures check Korean copy while API identifiers remain unchanged.
await setLocale('ko', false);
// 승인함(inbox) 모으기와 지출 승인 상태(docs/marketing.md) — buildInbox / spendApprovalState.
//
// 고정하는 계약:
//   1. 사람을 기다리는 것만 모은다: 제안된 채널 · 초안 · 제안된 편성 · 대기 지출 · 결과 불명 지출, 그리고
//      마무리할 일(연결 대기 채널 · 직접 게시할 승인 글 · AWB 밖에서 결제할 승인된 수동 지출).
//   2. 순서: 결과 불명 → 지출 → 편성 → 발신 → 채널 → 마무리. 지출은 먼저 만료되는 것부터.
//   3. 같은 행이 상태별 조회 여러 개에서 와도 하나로(가장 최근 updated_at).
//   4. 2인 승인은 요청에 찍힌 dual_required 가 기준이고, 서버처럼 지금 임계값과 더 엄격한 쪽을 쓴다.
//
// 실행: node --import tsx --test --test-force-exit test/marketing-inbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INBOX_SECTIONS,
  actionableInboxCount,
  buildInbox,
  inboxForViewer,
  canCancelSpend,
  canReconcileSpend,
  isSpendExpired,
  spendApprovalState,
} from '../src/components/marketing/marketing.logic.ts';

const T = (minute) => new Date(Date.UTC(2026, 9, 22, 0, minute)).toISOString();

const channel = (id, status, kind = 'manual', created = 0) => ({ id, status, kind, platform: 'forum', name: id, created_at: T(created), updated_at: T(created), decided_at: null });
const post = (id, status, channel_id, created = 0) => ({ id, status, channel_id, kind: 'post', created_at: T(created), updated_at: T(created), decided_at: null });
const allocation = (id, status, created = 0) => ({ id, status, channel_id: 'ch-a', amount_minor: 1000, created_at: T(created) });
const spend = (id, status, extra = {}) => ({
  id, status, provider: 'manual', amount_minor: 5000, approvals: [], created_at: T(0), updated_at: T(0),
  expires_at: T(600), decided_at: null, ...extra,
});

test('사람을 기다리는 것만 모으고, 섹션 순서대로 늘어놓는다', () => {
  const inbox = buildInbox({
    channels: [
      channel('ch-proposed', 'proposed', 'manual', 3),
      channel('ch-waiting', 'awaiting_credential', 'outreach', 4),
      channel('ch-active', 'active', 'manual'),
      channel('ch-outreach', 'active', 'outreach'),
      channel('ch-rejected', 'rejected'),
    ],
    posts: [
      post('p-draft', 'draft', 'ch-outreach', 2),
      post('p-manual-approved', 'approved', 'ch-active', 1),
      post('p-published', 'published', 'ch-active'),
      post('p-rejected', 'rejected', 'ch-active'),
      post('p-failed', 'failed', 'ch-outreach'),
    ],
    allocations: [allocation('al-proposed', 'proposed', 5), allocation('al-active', 'active'), allocation('al-old', 'superseded')],
    spendRequests: [
      spend('sp-pending', 'pending'),
      spend('sp-unknown', 'unknown', { provider: 'webhook' }),
      spend('sp-manual-approved', 'approved', { decided_at: T(9) }),
      spend('sp-webhook-approved', 'approved', { provider: 'webhook' }),
      spend('sp-paid', 'paid'),
      spend('sp-denied', 'denied'),
    ],
  });
  assert.deepEqual(inbox.items.map((i) => i.key), [
    'spend:sp-unknown',
    'spend:sp-pending',
    'allocation:al-proposed',
    'post:p-draft',
    'channel:ch-proposed',
    'post:p-manual-approved',
    'channel:ch-waiting',
    'spend:sp-manual-approved',
  ]);
  assert.deepEqual(inbox.counts, { spend_unknown: 1, spend_pending: 1, allocations: 1, posts: 1, channels: 1, follow_up: 3 });
  assert.equal(inbox.decisions, 5, '마무리할 일은 결정 수에 넣지 않는다');
  assert.equal(inbox.total, 8);
  assert.deepEqual(Object.keys(inbox.counts), INBOX_SECTIONS);
});

test('승인된 글이라도 자동 게시 · 메일 채널의 것은 사람이 마무리할 일이 아니다', () => {
  const inbox = buildInbox({
    channels: [channel('ch-out', 'active', 'outreach'), channel('ch-mail', 'active', 'email')],
    posts: [post('p1', 'approved', 'ch-out'), post('p2', 'approved', 'ch-mail'), post('p3', 'approved', 'ch-missing')],
    allocations: [],
    spendRequests: [],
  });
  assert.deepEqual(inbox.items.map((i) => i.key), ['post:p3'], '채널을 모르면(목록 밖) 수동으로 보고 남긴다');
});

test('대기 지출은 먼저 만료되는 것부터, 나머지는 오래 기다린 것부터', () => {
  const inbox = buildInbox({
    channels: [channel('c-late', 'proposed', 'manual', 30), channel('c-early', 'proposed', 'manual', 10)],
    posts: [],
    allocations: [],
    spendRequests: [
      spend('later', 'pending', { created_at: T(1), expires_at: T(900) }),
      spend('sooner', 'pending', { created_at: T(2), expires_at: T(100) }),
    ],
  });
  assert.deepEqual(inbox.items.map((i) => i.key), ['spend:sooner', 'spend:later', 'channel:c-early', 'channel:c-late']);
});

test('상태별 조회에서 겹친 행은 가장 최근 것 하나로 합친다', () => {
  const inbox = buildInbox({
    channels: [],
    posts: [],
    allocations: [],
    spendRequests: [
      spend('sp-1', 'pending', { updated_at: T(1) }),
      spend('sp-1', 'unknown', { updated_at: T(5) }),
      spend('sp-2', 'unknown', { updated_at: T(9) }),
      spend('sp-2', 'pending', { updated_at: T(3) }),
    ],
  });
  assert.deepEqual(inbox.items.map((i) => [i.key, i.section]), [['spend:sp-1', 'spend_unknown'], ['spend:sp-2', 'spend_unknown']]);
});

test('빈 캠페인의 승인함은 비어 있다', () => {
  const inbox = buildInbox({ channels: [], posts: [], allocations: [], spendRequests: [] });
  assert.equal(inbox.total, 0);
  assert.equal(inbox.decisions, 0);
  assert.deepEqual(inbox.items, []);
});

test('2인 승인 — 요청에 찍힌 dual_required 가 기준이다', () => {
  const s = spendApprovalState({ amount_minor: 100, approvals: [], dual_required: true }, 0, 'u1');
  assert.equal(s.required, 2, '임계값을 없앤 뒤에도 이미 들어온 큰 요청은 2인 승인이다');
  assert.equal(s.label, '2인 승인 필요');
  const raised = spendApprovalState({ amount_minor: 100, approvals: [], dual_required: true }, 1_000_000, 'u1');
  assert.equal(raised.required, 2, '임계값을 올려도 내려가지 않는다');
});

test('2인 승인 — 서버처럼 지금 임계값과 더 엄격한 쪽을 쓴다(구버전 응답은 임계값만)', () => {
  const lowered = spendApprovalState({ amount_minor: 50_000, approvals: [], dual_required: false }, 10_000, 'u1');
  assert.equal(lowered.required, 2, '요청 뒤 임계값을 낮춰 금액이 넘으면 서버가 2인을 요구한다');
  const legacy = spendApprovalState({ amount_minor: 50_000, approvals: [] }, 50_000, 'u1');
  assert.equal(legacy.required, 2, 'dual_required 가 없으면 임계값(이상)만 본다');
  const single = spendApprovalState({ amount_minor: 9_999, approvals: [], dual_required: false }, 10_000, 'u1');
  assert.equal(single.required, 1);
  assert.equal(single.label, null);
});

test('2인 승인 — 첫 승인이 기록되면 1/2, 내가 이미 승인했으면 mine', () => {
  const first = { amount_minor: 100, dual_required: true, approvals: [{ user_id: 'u1', name: 'Kim', at: T(1) }] };
  const mine = spendApprovalState(first, 0, 'u1');
  assert.equal(mine.label, '1/2 승인');
  assert.equal(mine.given, 1);
  assert.equal(mine.mine, true, '두 번째 승인은 다른 사람이 해야 한다');
  const other = spendApprovalState(first, 0, 'u2');
  assert.equal(other.mine, false);
  assert.equal(spendApprovalState(first, 0, '').mine, false, '사용자를 모르면 mine 이 아니다');
});

test('지출 상태별로 할 수 있는 일 — 만료 · 대조 · 취소', () => {
  const now = new Date('2026-10-22T05:00:00.000Z');
  assert.equal(isSpendExpired({ status: 'pending', expires_at: '2026-10-22T04:59:59.000Z' }, now), true);
  assert.equal(isSpendExpired({ status: 'pending', expires_at: '2026-10-22T05:00:01.000Z' }, now), false);
  assert.equal(isSpendExpired({ status: 'approved', expires_at: '2026-10-22T04:00:00.000Z' }, now), false, '대기 중일 때만 만료를 말한다');

  assert.equal(canReconcileSpend({ status: 'unknown', provider: 'webhook' }), true);
  assert.equal(canReconcileSpend({ status: 'approved', provider: 'manual' }), true);
  assert.equal(canReconcileSpend({ status: 'approved', provider: 'webhook' }), false, 'webhook 의 approved 는 실행이 결과를 낸다');
  assert.equal(canReconcileSpend({ status: 'executing', provider: 'webhook' }), false);

  assert.equal(canCancelSpend({ status: 'pending' }), true);
  assert.equal(canCancelSpend({ status: 'approved' }), true, '보내기 전의 승인 건은 취소하며 보류를 푼다');
  for (const status of ['executing', 'paid', 'failed', 'unknown', 'denied', 'expired', 'cancelled']) {
    assert.equal(canCancelSpend({ status }), false, status);
  }
});

test('처리할 수 있는 수는 서버 /marketing/inbox 의 actionable 과 같은 규칙이다', () => {
  const inbox = buildInbox({
    channels: [channel('c-prop', 'proposed'), channel('c-wait', 'awaiting_credential', 'outreach'), channel('c-man', 'active', 'manual')],
    posts: [post('p-draft', 'draft', 'c-man'), post('p-approved', 'approved', 'c-man')],
    allocations: [allocation('a-1', 'proposed')],
    spendRequests: [spend('s-p1', 'pending'), spend('s-p2', 'pending'), spend('s-u', 'unknown'), spend('s-m', 'approved')],
  });
  // 서버: manage → channels_proposed + posts_draft(초안 + 승인 글), approve_spend → 편성 + 대기 + 결과 불명 + 수동 결제 기록 대기.
  const server = { channels_proposed: 1, posts_draft: 2, allocations_proposed: 1, spend_pending: 2, spend_unknown: 1, manual_awaiting_payment: 1 };
  const serverActionable = (manage, money) => (manage ? server.channels_proposed + server.posts_draft : 0)
    + (money ? server.allocations_proposed + server.spend_pending + server.spend_unknown + server.manual_awaiting_payment : 0);
  for (const [canManage, canApproveSpend] of [[true, true], [true, false], [false, true], [false, false]]) {
    assert.equal(actionableInboxCount(inbox, { canManage, canApproveSpend }), serverActionable(canManage, canApproveSpend), `manage=${canManage} money=${canApproveSpend}`);
  }
  assert.equal(inbox.counts.follow_up, 3, '연결 대기 채널은 승인함에는 보이지만(마무리할 일) 수에는 넣지 않는다');
});

test('지출 승인 권한만 있으면 승인함에 돈 항목만 남긴다(운영 권한이면 그대로)', () => {
  const inbox = buildInbox({
    channels: [channel('c-prop', 'proposed'), channel('c-man', 'active', 'manual')],
    posts: [post('p-draft', 'draft', 'c-man')],
    allocations: [allocation('a-1', 'proposed')],
    spendRequests: [spend('s-u', 'unknown'), spend('s-m', 'approved')],
  });
  const money = inboxForViewer(inbox, { canManage: false, canApproveSpend: true });
  assert.deepEqual(money.items.map((i) => i.key), ['spend:s-u', 'allocation:a-1', 'spend:s-m']);
  assert.deepEqual(money.counts, { spend_unknown: 1, spend_pending: 0, allocations: 1, posts: 0, channels: 0, follow_up: 1 });
  assert.equal(money.decisions, 2);
  assert.equal(money.total, 3);
  assert.equal(inboxForViewer(inbox, { canManage: true, canApproveSpend: false }), inbox, '운영 권한은 돈 항목도 읽기 전용으로 본다');
});
