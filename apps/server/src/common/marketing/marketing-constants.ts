/**
 * Marketing(에이전트 기반 제품 마케팅 루프) 상수의 단일 원천 — docs/marketing.md.
 * 서버 서비스 · MCP 툴 · 사이클 지시문이 같은 이름을 쓰도록 문자열을 여기서만 정의한다.
 */

/** 캠페인이 골라 켜는 기능. 꺼진 기능의 MCP 툴은 그 캠페인에 대해 거부된다. */
export const MARKETING_CAPABILITIES = [
  'channel_discovery',
  'community_post',
  'email',
  'feedback_collect',
  'feedback_to_product',
  'analytics',
  'paid_spend',
] as const;
export type MarketingCapability = typeof MARKETING_CAPABILITIES[number];

export const MARKETING_CAPABILITY_LABELS: Record<MarketingCapability, string> = {
  channel_discovery: '채널 탐색',
  community_post: '커뮤니티 게시',
  email: '메일 발송',
  feedback_collect: '피드백 수집',
  feedback_to_product: '피드백 → 제품 개선',
  analytics: '채널별 성과 분석',
  paid_spend: '예산 집행 · 결제',
};

export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type CampaignStatus = typeof CAMPAIGN_STATUSES[number];

export const BUDGET_PERIODS = ['none', 'week', 'month'] as const;
export type BudgetPeriod = typeof BUDGET_PERIODS[number];

/** 피드백 티켓이 들어갈 상태. `todo` + assignee 면 일반 dispatch 루프가 이어받는다. */
export const FEEDBACK_TICKET_STATUSES = ['backlog', 'todo'] as const;
export type FeedbackTicketStatus = typeof FEEDBACK_TICKET_STATUSES[number];

/**
 * 에이전트 행동의 일일 상한(최근 24시간 생성 수). 사이클이 폭주하거나 주입된 지시를 따르더라도
 * 사람에게 올라오는 요청의 양이 이 선을 넘지 않는다. 캠페인 `limits` 로 낮추거나 올린다.
 */
export const DEFAULT_MARKETING_LIMITS = {
  drafts_per_day: 20,
  spend_requests_per_day: 5,
  allocation_proposals_per_day: 3,
  links_per_day: 50,
  channel_proposals_per_day: 10,
  feedback_per_day: 100,
  metrics_per_day: 500,
  feedback_tickets_per_day: 3,
  open_feedback_tickets: 10,
} as const;
export type MarketingLimits = { -readonly [K in keyof typeof DEFAULT_MARKETING_LIMITS]: number };
export const MARKETING_LIMIT_MAX = 1000;

/** 서버가 모든 커뮤니티 게시물 끝에 붙이는 공개 문구(비울 수 없다). */
export const DEFAULT_MARKETING_DISCLOSURE = '— 이 글은 제품 제작자가 작성했으며 AI 의 도움을 받았습니다.';

/** 사이클 cadence 하한 — 에이전트를 몇 분마다 깨우는 실수를 막는다. */
export const MIN_CYCLE_INTERVAL_MS = 10 * 60_000;

/**
 * 채널 플랫폼. reddit · github 는 outreach 커넥터가 있어 서버가 직접 게시할 수 있고(kind `outreach`),
 * email 은 메일 발송 채널(kind `email`), 나머지는 사람이 게시하고 링크를 기록한다(kind `manual`).
 */
export const CHANNEL_PLATFORMS = [
  'reddit', 'github', 'hacker_news', 'product_hunt', 'x', 'linkedin', 'discord', 'slack', 'forum',
  'blog', 'newsletter', 'youtube', 'email', 'other',
] as const;
export type ChannelPlatform = typeof CHANNEL_PLATFORMS[number];

/** outreach 커넥터가 있는 플랫폼 → OutreachChannel.kind */
export const OUTREACH_PLATFORMS: Partial<Record<ChannelPlatform, 'reddit' | 'github'>> = { reddit: 'reddit', github: 'github' };

export const CHANNEL_KINDS = ['outreach', 'email', 'manual'] as const;
export type ChannelKind = typeof CHANNEL_KINDS[number];

/** proposed → active | awaiting_credential | rejected, active ↔ paused */
export const CHANNEL_STATUSES = ['proposed', 'awaiting_credential', 'active', 'paused', 'rejected'] as const;
export type ChannelStatus = typeof CHANNEL_STATUSES[number];

/**
 * 연락처 상태. `subscribed` 에게만 보낸다 — 나머지는 모두 억제다: 수신거부, 공급자가 알려 온 바운스 · 스팸 신고
 * (docs/marketing.md "공급자 이벤트"), 삭제(주소는 지우고 해시만).
 */
export const CONTACT_STATUSES = ['subscribed', 'unsubscribed', 'bounced', 'complained', 'erased'] as const;
export type ContactStatus = typeof CONTACT_STATUSES[number];

/**
 * 동의 재확인 안내(docs/marketing.md "동의 재확인 안내")에 받은 사람이 응답하지 않으면 어떻게 되는가 — 안내가 무엇을
 * 제시했느냐로 정해진다(KISA 해석). `keep`: 철회 방법을 안내했으니 무응답은 유지. `lapse`: 유지 방법을 안내했으니
 * 무응답은 철회 — 기한이 지나면 보내지 않는다.
 */
export const CONSENT_NOTICE_POLICIES = ['keep', 'lapse'] as const;
export type ConsentNoticePolicy = typeof CONSENT_NOTICE_POLICIES[number];

/** queued → sending → sent | failed | skipped. deferred(야간 · 발신 채널 없음 · 꺼짐 · 일시 오류)는 queued 와 같이 처리. */
export const CONSENT_NOTICE_STATUSES = ['queued', 'deferred', 'sending', 'sent', 'failed', 'skipped'] as const;
export type ConsentNoticeStatus = typeof CONSENT_NOTICE_STATUSES[number];

/** 안내를 기한 며칠 전에 보내는가 — 운영자가 정한다. 이 범위 밖은 거부한다. */
export const CONSENT_NOTICE_LEAD_DAYS = { min: 7, max: 90, default: 30 } as const;
export const CONSENT_NOTICE_SUBJECT_MAX = 200;
export const CONSENT_NOTICE_BODY_MAX = 5000;
/** 운영자 문구에 쓸 수 있는 자리표시자(`{{name}}` …). 그 밖의 `{{…}}` 는 오타로 보고 거부한다. */
export const CONSENT_NOTICE_PLACEHOLDERS = ['name', 'sender', 'consent_date', 'due_date'] as const;
export type ConsentNoticePlaceholder = typeof CONSENT_NOTICE_PLACEHOLDERS[number];

/** 메일 공급자(메일 credential 의 `provider` 필드). */
export const EMAIL_PROVIDERS = ['resend', 'sendgrid'] as const;
export type EmailProvider = typeof EMAIL_PROVIDERS[number];
export const DEFAULT_EMAIL_AD_LABEL = '(광고)';

export const PAYMENT_PROVIDERS = ['manual', 'webhook'] as const;
export type PaymentProvider = typeof PAYMENT_PROVIDERS[number];

export const SPEND_STATUSES = ['pending', 'approved', 'executing', 'paid', 'failed', 'unknown', 'denied', 'expired', 'cancelled'] as const;
export type SpendStatus = typeof SPEND_STATUSES[number];

export const ALLOCATION_STATUSES = ['proposed', 'active', 'superseded', 'rejected'] as const;

/** 기간 안의 값을 더하는 지표. */
export const MARKETING_COUNTER_METRICS = [
  'clicks', 'impressions', 'views', 'engagements', 'replies', 'signups', 'conversions', 'revenue_minor',
] as const;
/** 기간 안의 마지막 관측값을 쓰는 지표(수준). */
export const MARKETING_GAUGE_METRICS = ['followers', 'subscribers'] as const;
export const MARKETING_METRICS = [...MARKETING_COUNTER_METRICS, ...MARKETING_GAUGE_METRICS] as const;
export type MarketingMetricName = typeof MARKETING_METRICS[number];

export const FEEDBACK_CATEGORIES = ['bug', 'feature_request', 'question', 'praise', 'complaint', 'other'] as const;
export type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number];
/** 제품 Project 티켓이 되는 분류. */
export const TICKETABLE_FEEDBACK: readonly FeedbackCategory[] = ['bug', 'feature_request'];
export const FEEDBACK_SENTIMENTS = ['positive', 'neutral', 'negative'] as const;

/** 승인 대기 지출 요청의 기본 만료(결정이 없으면 거부). */
export const SPEND_REQUEST_TTL_MS = 72 * 60 * 60_000;

/** 사이클이 `running` 으로 남아 있을 수 있는 최대 시간. 넘으면 `timed_out`. */
export const CYCLE_LEASE_MS = 6 * 60 * 60_000;

export const MARKETING_AUDIT_ENTITY_TYPES = [
  'campaign', 'channel', 'post', 'email', 'contact', 'allocation', 'spend_request', 'ledger',
  'link', 'metric', 'feedback', 'cycle', 'list', 'consent_notice',
] as const;
export type MarketingAuditEntityType = typeof MARKETING_AUDIT_ENTITY_TYPES[number];

export type MarketingActorType = 'user' | 'agent' | 'system' | 'public';

export interface MarketingActor {
  type: MarketingActorType;
  id: string;
  name: string;
  /** 사람 행동의 출처 IP(있으면). 공개 엔드포인트는 해시만 남긴다. */
  ip?: string | null;
}

export const SYSTEM_MARKETING_ACTOR: MarketingActor = { type: 'system', id: 'system', name: 'Marketing' };

/** UI 전용 SSE 이벤트 이름(user-only filter) — event-registry 와 client 가 같은 이름을 본다. */
export const MARKETING_UPDATE_EVENT = 'marketing_update';
