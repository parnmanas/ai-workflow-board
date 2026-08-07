/**
 * Reflects a connector call's outcome onto OutreachChannel's health fields
 * (ticket d86d0c24 review fix #2 — "커넥터가 RedditForbiddenError를 구분해
 * 던지는 데까지만 구현됐고... 채널 상태에 기록되지 않습니다"). Free functions
 * (not OutreachChannelService methods) so every call site — OutreachPollingService,
 * OutreachPublisherService — can call them without a circular DI dependency:
 * OutreachChannelService itself already depends on OutreachPollingService
 * (for computeNextPoll), so the reverse edge isn't available. Same reasoning
 * connector-resolver.ts's resolveChannelConnector already documents for being
 * a free function instead of a service method.
 *
 * Clear-on-success policy: recordChannelSuccess wipes ALL FIVE fields, so
 * OutreachChannelService.status() always reflects the MOST RECENT outcome —
 * an operator never has to manually clear a stale blocked/rate-limited flag
 * after the underlying problem resolves itself.
 */
import { Repository } from 'typeorm';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { RedditForbiddenError, RedditRateLimitError } from './connectors/reddit.connector';
import { OutreachChannelRateLimitedError } from './outreach-rate-limiter';

export async function recordChannelSuccess(channelRepo: Repository<OutreachChannel>, channel: OutreachChannel): Promise<void> {
  if (!channel.blocked_at && !channel.rate_limited_until && !channel.last_error) return; // already healthy — skip the write
  channel.blocked_at = null;
  channel.blocked_reason = '';
  channel.rate_limited_until = null;
  channel.last_error = '';
  channel.last_error_at = null;
  await channelRepo.save(channel);
}

export async function recordChannelFailure(channelRepo: Repository<OutreachChannel>, channel: OutreachChannel, error: unknown, now: Date = new Date()): Promise<void> {
  const message = String((error as any)?.message ?? error).slice(0, 500);
  channel.last_error = message;
  channel.last_error_at = now;
  if (error instanceof RedditForbiddenError) {
    channel.blocked_at = now;
    channel.blocked_reason = message;
  } else if (error instanceof RedditRateLimitError || error instanceof OutreachChannelRateLimitedError) {
    const retryAfterMs = (error as RedditRateLimitError | OutreachChannelRateLimitedError).retryAfterMs;
    channel.rate_limited_until = new Date(now.getTime() + (Number.isFinite(retryAfterMs) ? retryAfterMs : 60_000));
  }
  await channelRepo.save(channel);
}
