import { setLocale } from '../src/i18n/core.ts';
// These fixtures check Korean copy while API identifiers remain unchanged.
await setLocale('ko', false);
// Marketing 화면의 규칙 — 상태 라벨 · 캠페인 전이 · 주기 · 설정 PATCH · 돈 설정 키 · 채널 승인 본문,
// 그리고 서버 원천(apps/server/src/common/marketing/*, modules/marketing/*.logic.ts)과의 일치.
//
// 서버가 정본이다. 이 테스트는 화면이 미리 보여 주는 판정(버튼을 켤지, 무엇을 보낼지)이 서버와 갈라지면
// 실패한다 — 갈라지면 사람이 누른 버튼이 409/403 으로 튕기거나, 보내지 말아야 할 돈 설정이 실린다.
//
// 실행: node --import tsx --test --test-force-exit test/marketing-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_LABELS,
  CHANNEL_PLATFORMS,
  CONTACT_STATUS_FILTERS,
  UNSUBSCRIBE_SOURCE_LABELS,
  DEFAULT_LIMITS,
  FEEDBACK_CATEGORIES,
  MARKETING_CAPABILITIES,
  MONEY_SETTING_KEYS,
  RECORDABLE_METRICS,
  CONNECTOR_METRICS,
  UNKNOWN_SPEND_MESSAGE,
  activationBlocker,
  engagementCollectedChannel,
  engagementSummary,
  engagementTrackedChannel,
  metricValueText,
  allocationStatusView,
  approvalModesFor,
  auditCursor,
  auditEventTone,
  buildChannelApproval,
  cadenceDraftFrom,
  cadencePayload,
  campaignPatch,
  campaignStatusActions,
  campaignStatusView,
  channelStatusView,
  contactStatusView,
  cycleStatusView,
  describeCadence,
  emailDraftFrom,
  emailWebhookSetup,
  isCampaignEvent,
  listHoldSummary,
  orderAllocationsForApproval,
  parseList,
  postStatusView,
  previewCommunityBody,
  reportRange,
  safeHttpUrl,
  sendOutcomeLine,
  spendStatusView,
  validateEmailDraft,
  withoutMoneySettings,
} from '../src/components/marketing/marketing.logic.ts';
import * as serverConstants from '../../server/src/common/marketing/marketing-constants.ts';
import * as serverCampaign from '../../server/src/modules/marketing/marketing-campaign.logic.ts';
import * as serverChannel from '../../server/src/modules/marketing/marketing-channel.logic.ts';
import * as serverEngagement from '../../server/src/common/marketing/engagement.ts';
import { MONEY_SETTING_KEYS as SERVER_MONEY_SETTING_KEYS } from '../../server/src/modules/marketing/marketing-http.ts';

const throws = (fn) => { try { fn(); return false; } catch { return true; } };

function campaign(overrides = {}) {
  return {
    id: 'c-1', account_id: 'acc', project_id: null, name: 'Launch', slug: 'launch-ab12', status: 'draft',
    product_brief: '', goal: '', target_audience: '', capabilities: ['channel_discovery'], agent_runtime: null, agent_key: '',
    cycle_cron: null, cycle_interval_ms: null, next_cycle_at: null, last_cycle_at: null, cycle_count: 0,
    currency: 'KRW', budget_total_minor: 0, budget_period: 'month', budget_period_minor: 0, max_transaction_minor: 0,
    dual_approval_threshold_minor: 0, payment_provider: 'manual', payment_credential_id: null, payees: [], allowed_domains: [],
    disclosure: '— 공개 문구', limits: { ...DEFAULT_LIMITS }, limit_overrides: {}, feedback_ticket_status: 'backlog',
    improvement_assignee: null, created_by: 'u1', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

test('상수가 서버 원천과 같다 — 기능 · 라벨 · 플랫폼 · 상한 · 지표 · 피드백 분류', () => {
  assert.deepEqual(MARKETING_CAPABILITIES, [...serverConstants.MARKETING_CAPABILITIES]);
  assert.deepEqual(CAPABILITY_LABELS, serverConstants.MARKETING_CAPABILITY_LABELS);
  assert.deepEqual([...CHANNEL_PLATFORMS], [...serverConstants.CHANNEL_PLATFORMS]);
  assert.deepEqual(DEFAULT_LIMITS, { ...serverConstants.DEFAULT_MARKETING_LIMITS });
  assert.deepEqual([...RECORDABLE_METRICS].sort(), serverConstants.MARKETING_METRICS.filter((m) => m !== 'clicks').sort(), 'clicks 는 추적 링크에서만');
  assert.deepEqual([...FEEDBACK_CATEGORIES], [...serverConstants.FEEDBACK_CATEGORIES]);
});

test('참여 자동 수집 — 서버가 읽는 채널 · 지표 판정이 서버와 같고, 자동 수집 값은 부호가 붙는다', () => {
  // 화면이 미리 막는 "이 채널의 참여 · 답글은 기록하지 않는다" 가 서버의 거부(recordMetrics)와 갈라지지 않게.
  for (const platform of serverConstants.CHANNEL_PLATFORMS) {
    for (const kind of serverConstants.CHANNEL_KINDS) {
      assert.equal(engagementTrackedChannel({ kind, platform }), serverEngagement.engagementTracked({ kind, platform }), `${kind} · ${platform}`);
    }
  }
  assert.equal(engagementTrackedChannel(undefined), false);
  // 기록 폼이 막는 기준 — 연결된(active · paused) 채널만. 제안 · 연결 대기 · 거부된 채널은 서버가 읽지 않는다.
  for (const platform of serverConstants.CHANNEL_PLATFORMS) {
    for (const kind of serverConstants.CHANNEL_KINDS) {
      for (const status of serverConstants.CHANNEL_STATUSES) {
        assert.equal(engagementCollectedChannel({ kind, platform, status }), serverEngagement.engagementCollected({ kind, platform, status }), `${kind} · ${platform} · ${status}`);
      }
    }
  }
  assert.equal(engagementCollectedChannel({ kind: 'outreach', platform: 'reddit', status: 'proposed' }), false);
  assert.equal(engagementCollectedChannel({ kind: 'outreach', platform: 'reddit', status: 'paused' }), true);
  assert.deepEqual([...CONNECTOR_METRICS], [...serverEngagement.ENGAGEMENT_METRICS]);
  assert.equal(engagementSummary('reddit', { engagements: 1234, replies: 12 }), '점수 1,234 · 댓글 12');
  assert.equal(engagementSummary('github', { engagements: 5, replies: null }), '반응 5', '답글(댓글)인 글은 댓글 수가 없다');
  assert.equal(engagementSummary('reddit', null), '');
  assert.equal(metricValueText({ metric: 'engagements', value: 12, source: 'connector' }, 'USD'), '+12');
  assert.equal(metricValueText({ metric: 'engagements', value: -7, source: 'connector' }, 'USD'), '-7');
  assert.equal(metricValueText({ metric: 'engagements', value: 1200, source: 'agent' }, 'USD'), '1,200', '사람 · 에이전트 관측치는 그대로');
  assert.equal(metricValueText({ metric: 'revenue_minor', value: 1250, source: 'user' }, 'USD'), '12.50 USD');
});

test('돈 설정 키가 서버 MONEY_SETTING_KEYS 와 같다', () => {
  assert.deepEqual([...MONEY_SETTING_KEYS].sort(), [...SERVER_MONEY_SETTING_KEYS].sort());
});

test('상태마다 사람이 읽는 라벨이 있고, 사람을 기다리는 상태는 attention 이다', () => {
  for (const s of serverConstants.CAMPAIGN_STATUSES) assert.notEqual(campaignStatusView(s).label, s, `campaign ${s}`);
  for (const s of serverConstants.CHANNEL_STATUSES) assert.notEqual(channelStatusView(s).label, s, `channel ${s}`);
  for (const s of serverConstants.SPEND_STATUSES) assert.notEqual(spendStatusView(s).label, s, `spend ${s}`);
  for (const s of serverConstants.ALLOCATION_STATUSES) assert.notEqual(allocationStatusView(s).label, s, `allocation ${s}`);
  for (const s of ['draft', 'approved', 'publishing', 'sending', 'published', 'rejected', 'failed']) assert.notEqual(postStatusView(s).label, s, `post ${s}`);
  for (const s of ['running', 'completed', 'timed_out', 'cancelled', 'failed']) assert.notEqual(cycleStatusView(s).label, s, `cycle ${s}`);
  for (const s of serverConstants.CONTACT_STATUSES) assert.notEqual(contactStatusView(s).label, s, `contact ${s}`);
  assert.deepEqual([...CONTACT_STATUS_FILTERS], [...serverConstants.CONTACT_STATUSES], '연락처 상태 필터는 서버 상태 전부');
  assert.equal(contactStatusView('complained').tone, 'failed', '스팸 신고는 경보 색');
  assert.equal(channelStatusView('proposed').tone, 'attention');
  assert.equal(spendStatusView('pending').tone, 'attention');
  assert.equal(spendStatusView('unknown').tone, 'failed', '결과 불명은 경보 색');
  assert.equal(postStatusView('approved', 'manual').tone, 'attention', '수동 채널의 승인 글은 사람이 올려야 한다');
  assert.equal(postStatusView('approved', 'outreach').tone, 'queued');
  assert.equal(spendStatusView('mystery').label, 'mystery', '모르는 상태는 그대로 보여 준다');
  assert.match(UNKNOWN_SPEND_MESSAGE, /자동으로 다시 보내지 않습니다/);
});

test('캠페인 상태 버튼은 서버 전이 규칙과 같다(archived → active 는 한 번에 못 간다)', () => {
  for (const from of serverConstants.CAMPAIGN_STATUSES) {
    const offered = new Set(campaignStatusActions(from).map((a) => a.to));
    for (const to of serverConstants.CAMPAIGN_STATUSES) {
      if (to === from) continue;
      const serverAllows = !throws(() => serverCampaign.assertTransition(from, to));
      assert.equal(offered.has(to), serverAllows, `${from} → ${to}`);
    }
  }
  assert.deepEqual(campaignStatusActions('archived').map((a) => a.to), ['paused']);
});

test('시작을 막는 이유 — 에이전트 없음, 피드백 → 제품인데 Project 없음', () => {
  assert.match(activationBlocker(campaign()), /에이전트/);
  const agent = { manager_agent_id: 'h', cli: 'claude', working_dir: '/w' };
  assert.equal(activationBlocker(campaign({ agent_runtime: agent })), null);
  assert.match(activationBlocker(campaign({ agent_runtime: agent, capabilities: ['feedback_to_product'] })), /Project/);
  assert.equal(activationBlocker(campaign({ agent_runtime: agent, capabilities: ['feedback_to_product'], project_id: 'p' })), null);
});

test('주기 — 화면이 보내는 값을 서버 normalizeCadence 가 그대로 받는다', () => {
  const cases = [
    [{ kind: 'manual', hours: '24', cron: '' }, true],
    [{ kind: 'interval', hours: '24', cron: '' }, true],
    [{ kind: 'interval', hours: '0.5', cron: '' }, true],
    [{ kind: 'interval', hours: '0.1', cron: '' }, false],
    [{ kind: 'interval', hours: 'abc', cron: '' }, false],
    [{ kind: 'interval', hours: '600', cron: '' }, false],
    [{ kind: 'cron', hours: '', cron: '0 1 * * *' }, true],
    [{ kind: 'cron', hours: '', cron: '0 1 * *' }, false],
  ];
  for (const [draft, expected] of cases) {
    const out = cadencePayload(draft);
    assert.equal(out.ok, expected, `${JSON.stringify(draft)}: ${out.ok ? '' : out.error}`);
    if (out.ok) {
      const server = serverCampaign.normalizeCadence(out.cycle_cron, out.cycle_interval_ms);
      assert.deepEqual(server, { cron: out.cycle_cron, intervalMs: out.cycle_interval_ms }, '서버가 같은 값으로 정규화한다');
    }
  }
  assert.equal(cadencePayload({ kind: 'interval', hours: '0.5', cron: '' }).cycle_interval_ms, 1_800_000);
});

test('주기 — 표기와 편집 초기값', () => {
  assert.equal(describeCadence({ cycle_cron: '0 1 * * *', cycle_interval_ms: null }), 'cron 0 1 * * * (UTC)');
  assert.equal(describeCadence({ cycle_cron: null, cycle_interval_ms: 86_400_000 }), '24시간마다');
  assert.equal(describeCadence({ cycle_cron: null, cycle_interval_ms: 1_800_000 }), '30분마다');
  assert.equal(describeCadence({ cycle_cron: null, cycle_interval_ms: null }), '수동 실행만');
  assert.deepEqual(cadenceDraftFrom({ cycle_cron: null, cycle_interval_ms: 1_800_000 }).hours, '0.5');
  assert.equal(cadenceDraftFrom({ cycle_cron: '5 4 * * 1', cycle_interval_ms: null }).kind, 'cron');
  assert.equal(cadenceDraftFrom(null).kind, 'manual');
});

test('설정 PATCH — 바뀐 키만 싣고, 순서만 바뀐 목록 · 같은 상한은 보내지 않는다', () => {
  const original = campaign({ capabilities: ['analytics', 'email'], allowed_domains: ['a.com', 'b.com'], limit_overrides: { drafts_per_day: 5 } });
  const patch = campaignPatch(original, {
    name: 'Launch',
    goal: '가입 300명',
    capabilities: ['email', 'analytics'],
    allowed_domains: ['b.com', 'a.com'],
    limits: { drafts_per_day: 5 },
    project_id: null,
    agent_runtime: null,
  });
  assert.deepEqual(patch, { goal: '가입 300명' });
  assert.deepEqual(campaignPatch(original, { limits: {} }), { limits: {} }, '상한을 기본값으로 되돌리는 것도 변경이다');
  assert.deepEqual(campaignPatch(original, { project_id: '' }), {}, "'' 와 null 은 같은 '없음' 이다");
});

test('설정 PATCH — 돈 설정은 승인 권한이 있을 때만, 바뀌었을 때만 싣는다', () => {
  const original = campaign({ budget_total_minor: 100_000 });
  const draft = { goal: 'g', currency: 'KRW', budget_total_minor: 500_000, payees: [{ name: 'Reddit Ads' }], dual_approval_threshold_minor: 0 };
  assert.deepEqual(campaignPatch(original, draft), { goal: 'g' }, '기본은 돈 설정을 싣지 않는다');
  assert.deepEqual(campaignPatch(original, draft, { canEditMoney: false }), { goal: 'g' });
  assert.deepEqual(
    campaignPatch(original, draft, { canEditMoney: true }),
    { goal: 'g', budget_total_minor: 500_000, payees: [{ name: 'Reddit Ads' }] },
    '그대로인 통화 · 임계값은 승인자라도 다시 보내지 않는다',
  );
  const body = withoutMoneySettings({ name: 'n', currency: 'USD', payment_provider: 'webhook', capabilities: [] });
  assert.deepEqual(body, { name: 'n', capabilities: [] });
});

test('채널 승인 방식은 서버의 커넥터 · 메일 규칙과 같다', () => {
  for (const platform of serverConstants.CHANNEL_PLATFORMS) {
    const modes = approvalModesFor(platform);
    assert.ok(modes.includes('manual'), `${platform} 는 언제나 수동으로 열 수 있다`);
    assert.equal(modes.includes('outreach'), !!serverConstants.OUTREACH_PLATFORMS[platform], `${platform} outreach`);
    assert.equal(modes.includes('email'), platform === 'email' || platform === 'newsletter', `${platform} email`);
    assert.equal(modes[0], serverChannel.defaultKindFor(platform), `${platform} 의 첫 방식이 서버 기본 kind 다`);
  }
});

const goodEmail = {
  brand_id: 'brand-1', credential_id: 'cred-1', from_name: 'AWB', from_address: 'news@awb.dev', reply_to: '', postal_address: 'Seoul 1',
  contact_email: '', list_name: 'Newsletter', ad_label: '(광고)',
};

test('메일 설정 검증 — 법정 표기가 비면 거부한다(서버 normalizeEmailChannelConfig 와 같은 판정)', () => {
  const drafts = [
    goodEmail,
    { ...goodEmail, credential_id: '' },
    { ...goodEmail, brand_id: '' },
    { ...goodEmail, from_name: '  ' },
    { ...goodEmail, from_address: 'not-mail' },
    { ...goodEmail, reply_to: 'bad' },
    { ...goodEmail, contact_email: 'bad' },
    { ...goodEmail, postal_address: '' },
    { ...goodEmail, list_name: '' },
    { ...goodEmail, list_name: '뉴스' },
    { ...goodEmail, ad_label: '' },
  ];
  for (const draft of drafts) {
    const client = validateEmailDraft(draft) === null;
    const server = !throws(() => serverChannel.normalizeEmailChannelConfig(draft));
    assert.equal(client, server, JSON.stringify(draft));
  }
  assert.equal(validateEmailDraft(goodEmail), null);
  assert.deepEqual(emailDraftFrom(null).ad_label, '(광고)', '광고 표기 기본값');
});

test('채널 승인 본문 — 방식별로 서버가 받는 모양', () => {
  const base = { kind: 'manual', outreachChoice: 'create', outreachChannelId: '', credentialId: '', rateLimitPerHour: '2', collectFeedback: false, email: emailDraftFrom(null), note: '' };
  assert.deepEqual(buildChannelApproval(base), { ok: true, body: { mode: 'manual' } });
  assert.deepEqual(buildChannelApproval({ ...base, note: '  좋아요 ' }).body, { mode: 'manual', note: '좋아요' });

  const email = buildChannelApproval({ ...base, kind: 'email', email: goodEmail });
  assert.equal(email.ok, true);
  assert.equal(email.body.mode, 'email');
  assert.equal(email.body.email.list_name, 'newsletter', '목록 이름은 서버 규칙대로 소문자');
  assert.equal(buildChannelApproval({ ...base, kind: 'email', email: { ...goodEmail, postal_address: '' } }).ok, false);

  const existing = buildChannelApproval({ ...base, kind: 'outreach', outreachChoice: 'existing', outreachChannelId: 'oc-1' });
  assert.deepEqual(existing.body, { mode: 'outreach', outreach_channel_id: 'oc-1' });
  assert.equal(buildChannelApproval({ ...base, kind: 'outreach', outreachChoice: 'existing' }).ok, false);

  const create = buildChannelApproval({ ...base, kind: 'outreach', credentialId: 'cred', rateLimitPerHour: '3', collectFeedback: true });
  assert.deepEqual(create.body, { mode: 'outreach', create_outreach: { credential_id: 'cred', rate_limit_per_hour: 3, collect_feedback: true } });
  assert.equal(buildChannelApproval({ ...base, kind: 'outreach', credentialId: 'cred', rateLimitPerHour: '0' }).ok, false);
  assert.equal(buildChannelApproval({ ...base, kind: 'outreach', credentialId: '' }).ok, false);

  assert.deepEqual(buildChannelApproval({ ...base, kind: 'outreach', outreachChoice: 'later' }).body, { mode: 'outreach' }, '처음 승인은 연결을 미룰 수 있다');
  assert.equal(buildChannelApproval({ ...base, kind: 'outreach', outreachChoice: 'later' }, { connect: true }).ok, false, '연결할 때는 미룰 수 없다');
  assert.equal(buildChannelApproval(base, { connect: true }).ok, false, '연결은 Outreach 로만');
});

test('외부 링크는 http(s) 만 — javascript: · data: 는 링크가 되지 않는다', () => {
  assert.equal(safeHttpUrl('https://reddit.com/r/selfhosted'), 'https://reddit.com/r/selfhosted');
  assert.equal(safeHttpUrl(' http://example.com '), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,hi', 'mailto:a@b.c', 'ftp://x.y', '//evil.com', 'not a url', '', null, 42]) {
    assert.equal(safeHttpUrl(bad), null, String(bad));
  }
});

test('게시 미리보기 — 서버 composeCommunityBody 처럼 본문 끝에 공개 문구', () => {
  assert.equal(previewCommunityBody('Hello\r\nworld  \n', '— 공개 문구'), 'Hello\nworld\n\n— 공개 문구');
  assert.equal(previewCommunityBody('Hi', '   '), 'Hi');
});

test('실시간 갱신 · 감사 강조 · 목록 입력 · 리포트 기간', () => {
  assert.equal(isCampaignEvent({ campaign_id: 'c-1', kind: 'post' }, 'c-1'), true);
  assert.equal(isCampaignEvent({ campaign_id: 'c-2' }, 'c-1'), false);
  assert.equal(isCampaignEvent(null, 'c-1'), false);
  assert.equal(isCampaignEvent({ campaign_id: '' }, ''), false);

  assert.equal(auditEventTone('spend.late_result'), 'warning');
  assert.equal(auditEventTone('spend.unknown'), 'danger');
  assert.equal(auditEventTone('channel.approved'), 'normal');

  assert.deepEqual(parseList('a.com\n b.com , a.com\n\n'), ['a.com', 'b.com']);

  const now = new Date('2026-10-22T00:00:00.000Z');
  assert.deepEqual(reportRange(7, now), { since: '2026-10-15T00:00:00.000Z', until: '2026-10-22T00:00:00.000Z' });
});

test('주기 — 불러온 간격은 시간 칸을 고치지 않으면 그대로 보낸다(0.167h 로 줄였다가 601200ms 가 되지 않는다)', () => {
  for (const minutes of [10, 20, 25, 40, 50, 70, 1440]) {
    const ms = minutes * 60_000;
    const draft = cadenceDraftFrom({ cycle_cron: null, cycle_interval_ms: ms });
    const out = cadencePayload(draft);
    assert.equal(out.ok && out.cycle_interval_ms, ms, `${minutes}분`);
    // 그대로면 PATCH 에도 실리지 않는다 — 다음 사이클 시각을 다시 계산하지 않게.
    const original = campaign({ cycle_interval_ms: ms });
    assert.deepEqual(campaignPatch(original, { cycle_cron: out.cycle_cron, cycle_interval_ms: out.cycle_interval_ms }), {}, `${minutes}분`);
  }
  const edited = cadencePayload({ ...cadenceDraftFrom({ cycle_cron: null, cycle_interval_ms: 600_000 }), hours: '0.5' });
  assert.equal(edited.ok && edited.cycle_interval_ms, 1_800_000, '고친 값은 새로 계산한다');
  const switched = cadencePayload({ ...cadenceDraftFrom({ cycle_cron: null, cycle_interval_ms: 600_000 }), kind: 'manual' });
  assert.deepEqual(switched, { ok: true, cycle_cron: null, cycle_interval_ms: null });
});

test('직접 편성은 줄이는 것부터 보낸다 — 서버의 한 줄씩 승인(다른 active + 이 줄 ≤ 상한)을 끝 상태가 맞으면 통과한다', () => {
  const cap = 100;
  // 서버 MarketingBudgetService.approve 를 그대로 흉내 낸다: 차례로 한 줄씩, 그 채널의 이전 편성을 대체.
  const approveInOrder = (active, rows) => {
    const state = new Map(active);
    for (const row of rows) {
      const others = [...state].filter(([id]) => id !== row.channel_id).reduce((sum, [, v]) => sum + v, 0);
      if (others + row.amount_minor > cap) return { ok: false, at: row.channel_id };
      state.set(row.channel_id, row.amount_minor);
    }
    return { ok: true };
  };
  const active = new Map([['A', 60], ['B', 40]]);
  const asked = [{ channel_id: 'A', amount_minor: 70 }, { channel_id: 'B', amount_minor: 30 }];
  assert.deepEqual(approveInOrder(active, asked), { ok: false, at: 'A' }, '전제: 늘리는 줄이 먼저면 막힌다');
  const ordered = orderAllocationsForApproval(asked, active);
  assert.deepEqual(ordered.map((r) => r.channel_id), ['B', 'A']);
  assert.deepEqual(approveInOrder(active, ordered), { ok: true });

  const withNew = orderAllocationsForApproval(
    [{ channel_id: 'N', amount_minor: 10 }, { channel_id: 'A', amount_minor: 50 }, { channel_id: 'B', amount_minor: 40 }],
    new Map([['A', 60], ['B', 40], ['N', null]]),
  );
  assert.deepEqual(withNew.map((r) => r.channel_id), ['A', 'B', 'N'], '편성이 없던 채널은 0 에서 늘리는 것');
  assert.deepEqual(asked.map((r) => r.channel_id), ['A', 'B'], '입력 배열은 그대로 둔다');
});

test('감사 로그 커서 — 경계 밀리초의 행을 다시 받도록 1ms 뒤를 보낸다', () => {
  assert.equal(auditCursor('2026-10-22T01:02:03.123Z'), '2026-10-22T01:02:03.124Z');
  assert.equal(auditCursor('not-a-date'), 'not-a-date');
});

test('메일 공급자 이벤트 화면: 목록 발송 중지 요약 · 발송 결과 줄 · webhook 설정 안내 · 수신거부 출처', () => {
  assert.equal(listHoldSummary({ stats: { sent: 400, bounced: 0, complained: 2, rate: 0.005 } }), '스팸 신고율 0.50% — 신고 2 / 닿은 메일 400');
  assert.equal(listHoldSummary({ stats: {} }), '스팸 신고율 — — 신고 0 / 닿은 메일 0');
  assert.equal(sendOutcomeLine({ hard: 2, soft: 0, suppressed: 1, complained: 1 }), '바운스(영구) 2 · 공급자 억제 1 · 스팸 신고 1');
  assert.equal(sendOutcomeLine({ hard: 0, soft: 0, suppressed: 0, complained: 0 }), '');
  assert.equal(sendOutcomeLine(undefined), '');

  const resend = emailWebhookSetup({ provider: 'resend', events_url: 'https://awb.example.com/api/m/email/c1/events', inbound_url: null, events_signing: false, inbound_signing: false });
  assert.equal(resend.items.length, 1, 'Resend 는 받은 메일도 같은 webhook 으로 온다');
  assert.equal(resend.items[0].keyField, 'webhook_secret');
  assert.match(resend.items[0].events, /email\.bounced.*email\.complained.*email\.received/);
  const sendgrid = emailWebhookSetup({ provider: 'sendgrid', events_url: 'https://x/events', inbound_url: 'https://x/inbound', events_signing: true, inbound_signing: false });
  assert.deepEqual(sendgrid.items.map((i) => [i.keyField, i.signing]), [['webhook_public_key', true], ['inbound_public_key', false]]);
  assert.equal(emailWebhookSetup({ provider: 'resend', events_url: null, inbound_url: null, events_signing: false, inbound_signing: false }).missingUrl, true);

  // 서버가 남기는 수신거부 출처(연락처 엔티티 주석)마다 사람이 읽는 라벨이 있다.
  for (const source of ['link', 'one_click', 'manual', 'mailto', 'bounce', 'complaint', 'provider']) {
    assert.ok(UNSUBSCRIBE_SOURCE_LABELS[source], `source ${source}`);
  }
});


test('hard bounce hold summary uses the hold reason and accepted sends', () => {
  assert.equal(listHoldSummary({ reason: 'hard_bounce_rate', stats: { sent: 40, bounced: 10, hard_bounced: 2, rate: 0.05 } }), '하드 바운스율 5.00% — 영구 실패 2 / 발송 40');
});
