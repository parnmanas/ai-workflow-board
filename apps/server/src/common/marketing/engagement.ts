/**
 * 참여 지표 자동 수집의 순수 규칙 — docs/marketing.md "참여 지표 자동 수집".
 *
 * reddit · GitHub outreach 채널에 서버가 게시한 글의 참여를 게시 후 14 일 동안 커넥터로 읽는다. reddit score ·
 * GitHub 반응 합계는 `engagements`, 댓글 수는 `replies` 다. 플랫폼이 주는 값은 누적 수준값이라, 읽을 때마다 직전에
 * 읽은 값과의 **변화량**을 MarketingMetric(source `connector`)에 남긴다. 그 행들의 합이 플랫폼의 현재 값이고 기간
 * 합이 그 기간의 증가분이므로, 리포트의 누적형 합산(report.ts)을 그대로 탄다. 읽은 값 자체는 게시물
 * (`MarketingPost.engagement`)과 행 메모(`reddit score 45 → 57`)에 남는다.
 */
import { OUTREACH_PLATFORMS } from './marketing-constants';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** MarketingMetric.source — 서버가 커넥터로 읽은 값. */
export const ENGAGEMENT_SOURCE = 'connector';
/** 게시 후 이 기간 동안 읽는다. 마지막 읽기는 기간 끝에 맞춘다. */
export const ENGAGEMENT_WINDOW_MS = 14 * DAY_MS;
/** 게시 후 첫 읽기까지. */
export const ENGAGEMENT_FIRST_READ_MS = HOUR_MS;
/** 채널의 `rate_limit_per_hour` 가운데 수집이 쓰지 않고 남겨 두는 몫 — 게시 · 폴링이 쓴다. */
export const ENGAGEMENT_RESERVED_SHARE = 0.5;
/** 지금 읽지 못한 글(rate limit 에 몫이 없음 · 플랫폼 rate limit · 보관된 캠페인)을 다시 볼 때까지. */
export const ENGAGEMENT_DEFER_MS = 30 * 60_000;
/**
 * 한 요청에 여러 글을 읽는 채널(reddit)은 이만큼 안에 읽을 차례가 오는 글도 같은 요청에 싣는다. 글마다 따로 요청하지
 * 않게 되고, 같은 채널 글들의 일정이 한 시각으로 모인다.
 */
export const ENGAGEMENT_ALIGN_MS = 30 * 60_000;

export const ENGAGEMENT_METRICS = ['engagements', 'replies'] as const;
export type EngagementMetric = typeof ENGAGEMENT_METRICS[number];

/** 게시물에 남는 마지막 읽은 값. 답글(댓글)인 글은 댓글 수가 없어 `replies` 가 없다. */
export interface EngagementValue {
  engagements?: number;
  replies?: number;
  read_at?: string;
}

export interface EngagementReadingValue {
  reactions: number | null;
  comments: number | null;
}

export interface EngagementChange {
  metric: EngagementMetric;
  delta: number;
  note: string;
}

/** 행 메모에 쓰는 플랫폼 필드 이름. */
const FIELD_LABELS: Record<string, Record<EngagementMetric, string>> = {
  reddit: { engagements: 'reddit score', replies: 'reddit comments' },
  github: { engagements: 'GitHub reactions', replies: 'GitHub comments' },
};

/**
 * 이 채널의 글을 서버가 읽는가 — 커넥터로 게시하는 outreach 채널(reddit · github)만. 이 채널의 `engagements` ·
 * `replies` 는 사람 · 에이전트가 기록하지 못한다(두 번 세지 않게).
 */
export function engagementTracked(channel: { kind: string; platform: string }): boolean {
  return channel.kind === 'outreach' && !!OUTREACH_PLATFORMS[channel.platform as keyof typeof OUTREACH_PLATFORMS];
}

/** 글의 나이에 따른 읽기 간격 — 참여가 몰리는 첫날은 자주, 그 뒤로는 드물게. */
export function engagementIntervalMs(ageMs: number): number {
  if (ageMs < DAY_MS) return HOUR_MS;
  if (ageMs < 3 * DAY_MS) return 3 * HOUR_MS;
  return 12 * HOUR_MS;
}

export function firstEngagementReadAt(publishedAt: Date): Date {
  return new Date(publishedAt.getTime() + ENGAGEMENT_FIRST_READ_MS);
}

/**
 * 읽은(또는 읽으려다 실패한) 뒤의 다음 읽기 시각. 기간 끝을 넘기지 않고, 기간 끝에서 읽었으면 null(끝)이다.
 * 실패도 같은 간격을 따른다 — 막힌 채널을 몇 분마다 두드리지 않는다.
 */
export function nextEngagementReadAt(publishedAt: Date, now: Date): Date | null {
  const end = publishedAt.getTime() + ENGAGEMENT_WINDOW_MS;
  const t = now.getTime();
  if (t >= end) return null;
  return new Date(Math.min(t + engagementIntervalMs(t - publishedAt.getTime()), end));
}

/** 지금 읽지 못한 글을 다시 볼 시각 — 기간 끝을 넘기지 않고, 기간이 이미 끝났으면 null(끝). */
export function deferEngagementReadAt(publishedAt: Date, now: Date): Date | null {
  const end = publishedAt.getTime() + ENGAGEMENT_WINDOW_MS;
  const t = now.getTime();
  if (t >= end) return null;
  return new Date(Math.min(t + ENGAGEMENT_DEFER_MS, end));
}

/**
 * 이번 sweep 에 이 채널로 보낼 수 있는 요청 수. `rate_limit_per_hour` 가 없으면(0) 제한이 없다. 있으면 지난 한 시간에
 * 남은 수에서 `ENGAGEMENT_RESERVED_SHARE` 몫을 뺀다 — 수집 때문에 사람이 승인한 글이 rate limit 에 걸리지 않게.
 */
export function engagementRequestBudget(ratePerHour: number, remaining: number): number {
  if (!ratePerHour || ratePerHour <= 0) return Infinity;
  return Math.max(0, remaining - Math.ceil(ratePerHour * ENGAGEMENT_RESERVED_SHARE));
}

/**
 * 읽은 값 → 남길 변화량과 게시물의 새 값. 변화가 없으면 행도 없다. 플랫폼이 감춘 값(null)은 직전 값을 그대로 둔다.
 * 변화량은 음수일 수 있다(점수가 내려가거나 댓글이 지워진 경우) — 그래야 행의 합이 플랫폼의 현재 값과 같다.
 */
export function engagementChanges(
  platform: string,
  previous: EngagementValue | null | undefined,
  reading: EngagementReadingValue,
): { changes: EngagementChange[]; value: EngagementValue } {
  const labels = FIELD_LABELS[platform] || { engagements: `${platform} reactions`, replies: `${platform} comments` };
  const before = previous || {};
  const value: EngagementValue = {};
  if (typeof before.engagements === 'number') value.engagements = before.engagements;
  if (typeof before.replies === 'number') value.replies = before.replies;
  const changes: EngagementChange[] = [];
  const observe = (metric: EngagementMetric, next: number | null) => {
    if (next === null || !Number.isFinite(next)) return;
    const prev = typeof before[metric] === 'number' ? before[metric]! : 0;
    value[metric] = next;
    if (next !== prev) changes.push({ metric, delta: next - prev, note: `${labels[metric]} ${prev} → ${next}` });
  };
  observe('engagements', reading.reactions);
  observe('replies', reading.comments);
  return { changes, value };
}
