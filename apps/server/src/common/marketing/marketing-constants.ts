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
  links_per_day: 50,
  channel_proposals_per_day: 10,
  feedback_per_day: 100,
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

/** 메일 공급자(메일 credential 의 `provider` 필드). */
export const EMAIL_PROVIDERS = ['resend', 'sendgrid'] as const;
export type EmailProvider = typeof EMAIL_PROVIDERS[number];
export const DEFAULT_EMAIL_AD_LABEL = '(광고)';

/** 승인 대기 지출 요청의 기본 만료(결정이 없으면 거부). */
export const SPEND_REQUEST_TTL_MS = 72 * 60 * 60_000;

/** 사이클이 `running` 으로 남아 있을 수 있는 최대 시간. 넘으면 `timed_out`. */
export const CYCLE_LEASE_MS = 6 * 60 * 60_000;

export const MARKETING_AUDIT_ENTITY_TYPES = [
  'campaign', 'channel', 'post', 'email', 'contact', 'allocation', 'spend_request', 'ledger',
  'link', 'metric', 'feedback', 'cycle',
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
