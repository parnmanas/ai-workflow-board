/**
 * Per-channel proactive HTTP-request cap (ticket d86d0c24 review fix #1 —
 * "OutreachChannel.rate_limit_per_hour는 CRUD 저장/검증만 되고... 어느 요청
 * 경로에서도 읽히지 않습니다"). A NEW RedditConnector is constructed per call
 * site (connector-resolver.ts — OutreachPollingService/OutreachPublisherService/
 * OutreachResolveNotifierService each resolve a fresh instance per poll/publish),
 * so this counter cannot live on the connector itself; it lives here, in a
 * single process-wide instance shared by every connector for the same
 * channel_id (see `sharedOutreachRateLimiter` below).
 *
 * This is independent of Reddit's OWN live rate limit (RedditConnector's
 * response-header-driven reactive/proactive backoff) — `rate_limit_per_hour`
 * is an operator-configured self-throttle (e.g. community self-promotion
 * norms), not a Reddit-imposed constraint.
 */
export class OutreachChannelRateLimitedError extends Error {
  readonly code = 'channel_rate_limited';
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
  }
}

const WINDOW_MS = 60 * 60 * 1000;

export class OutreachRateLimiter {
  private readonly callTimestamps = new Map<string, number[]>();

  /** Throws OutreachChannelRateLimitedError WITHOUT recording a call when
   *  `ratePerHour` (<=0 = unlimited, matches OutreachChannel.rate_limit_per_hour's
   *  documented default) would be exceeded; otherwise records this call's
   *  timestamp and returns normally. */
  checkAndRecord(channelId: string, ratePerHour: number, now: number = Date.now()): void {
    if (!ratePerHour || ratePerHour <= 0) return;
    const windowStart = now - WINDOW_MS;
    const recent = (this.callTimestamps.get(channelId) || []).filter((t) => t > windowStart);
    if (recent.length >= ratePerHour) {
      const retryAfterMs = recent[0] + WINDOW_MS - now;
      throw new OutreachChannelRateLimitedError(
        `channel ${channelId} exceeded its configured rate_limit_per_hour=${ratePerHour}`,
        Math.max(0, retryAfterMs),
      );
    }
    recent.push(now);
    this.callTimestamps.set(channelId, recent);
  }
}

// Process-wide singleton every production RedditConnector instance shares
// (see class docstring). Tests inject their own fresh OutreachRateLimiter via
// RedditConnectorOptions.rateLimiter instead of touching this singleton, so
// parallel test files never interfere with each other's channel_id counters.
export const sharedOutreachRateLimiter = new OutreachRateLimiter();
