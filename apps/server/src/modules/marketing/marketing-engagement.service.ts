import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual, Repository } from 'typeorm';
import { MarketingPost } from '../../entities/MarketingPost';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingMetric } from '../../entities/MarketingMetric';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { Credential } from '../../entities/Credential';
import {
  ENGAGEMENT_SOURCE,
  ENGAGEMENT_WINDOW_MS,
  engagementChanges,
  engagementRequestBudget,
  engagementTracked,
  nextEngagementReadAt,
} from '../../common/marketing/engagement';
import { SYSTEM_MARKETING_ACTOR } from '../../common/marketing/marketing-constants';
import { GitHubForbiddenError, GitHubRateLimitError } from '../../services/github-connector.service';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { LogService } from '../../services/log.service';
import { resolveChannelConnector } from '../outreach/connector-resolver';
import { RedditForbiddenError, RedditRateLimitError } from '../outreach/connectors/reddit.connector';
import type { EngagementReading, OutreachConnector } from '../outreach/connectors/types';
import { OutreachChannelRateLimitedError, OutreachRateLimiter, sharedOutreachRateLimiter } from '../outreach/outreach-rate-limiter';
import { MarketingAuditService } from './marketing-audit.service';
import type { ConnectorFactory } from './marketing-post.service';

const TICK_MS = 5 * 60_000;
/** sweep 한 번에 보는 글 수. */
const BATCH = 500;
/** sweep 한 번에 한 채널로 보내는 요청의 상한 — rate limit 이 없는 채널(GitHub 토큰은 시간당 5,000)도 몰아 쓰지 않게. */
const MAX_REQUESTS_PER_SWEEP = 30;
/** 맡은 글을 읽다가 프로세스가 죽으면 이만큼 뒤에 다시 읽는다. */
const LEASE_MS = 15 * 60_000;
const MAX_ERROR = 500;

export interface EngagementSweepResult {
  /** 읽은 글. */
  read: number;
  /** 그중 값이 바뀌어 지표 행을 남긴 글. */
  changed: number;
  /** 읽지 못한 글 — 다음 간격에 다시 읽는다. */
  failed: number;
  /** 수집을 멈춘 글(보관된 캠페인 등). */
  stopped: number;
  /** 채널의 rate limit 몫이 없거나 채널이 막혀 다음 sweep 으로 미룬 글. */
  deferred: number;
}

function message(e: unknown): string {
  return String((e as any)?.message ?? e).slice(0, MAX_ERROR);
}

/** 이 오류면 이번 sweep 에 그 채널에 더 묻지 않는다 — 다음 글도 같은 답(rate limit · 차단)을 받는다. */
function channelWide(e: unknown): boolean {
  return e instanceof OutreachChannelRateLimitedError || e instanceof RedditRateLimitError || e instanceof RedditForbiddenError
    || e instanceof GitHubRateLimitError || e instanceof GitHubForbiddenError;
}

function publishedAt(post: MarketingPost): Date {
  return post.published_at || post.created_at;
}

/**
 * MarketingEngagementService — 참여 지표 자동 수집(docs/marketing.md "참여 지표 자동 수집", 규칙은
 * common/marketing/engagement.ts).
 *
 * reddit · GitHub outreach 채널에 서버가 게시한 글을 게시 후 14 일 동안 그 채널의 커넥터(`readEngagement`)로 읽고, 직전에
 * 읽은 값과의 변화량을 MarketingMetric(source `connector`)에 남긴다.
 *   - 일정: 게시 1 시간 뒤 첫 읽기, 그 뒤 글의 나이에 따라 1 · 3 · 12 시간 간격, 14 일째에 마지막으로 읽는다. 실패도 같은
 *     간격을 따른다.
 *   - rate limit: 연결된 OutreachChannel 의 `rate_limit_per_hour` 가운데 절반은 게시 · 폴링 몫으로 남긴다. 몫이 없으면 그
 *     채널의 글은 다음 sweep 으로 미룬다. reddit 은 한 요청에 100 개씩 읽는다.
 *   - 한 번만: 글을 맡을 때 `engagement_rev` 를 CAS 로 올리고 다음 읽기를 lease 만큼 민다. 게시물의 값과 변화량 행은 같은
 *     트랜잭션에서, 맡은 rev 가 그대로일 때만 쓴다 — 서버가 둘이어도 같은 변화를 두 번 남기지 않는다.
 *   - 보관된 캠페인의 글은 멈춘다. 일시정지된 캠페인 · 채널의 글은 계속 읽는다(읽기만 하고 아무것도 보내지 않는다).
 *   - `MARKETING_SCHEDULER_ENABLED=false` · 인스턴스 quiesce 중에는 읽지 않는다.
 * 채널 상태(OutreachChannel 의 blocked/rate-limited 표시)는 건드리지 않는다 — 읽기가 된다고 게시가 되는 것은 아니라서,
 * 여기서의 성공이 게시 경로가 남긴 차단 표시를 지우면 안 된다.
 */
@Injectable()
export class MarketingEngagementService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly enabled = (process.env.MARKETING_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
  /** 테스트가 가짜 커넥터를 꽂을 수 있게. */
  connectorFactory: ConnectorFactory = resolveChannelConnector;
  /** 실제 커넥터가 요청마다 기록하는 공용 리미터(테스트는 바꿔 낀다). */
  rateLimiter: OutreachRateLimiter = sharedOutreachRateLimiter;

  constructor(
    @InjectRepository(MarketingPost) private readonly postRepo: Repository<MarketingPost>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(OutreachChannel) private readonly outreachRepo: Repository<OutreachChannel>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: MarketingAuditService,
    private readonly instanceQuiesce: InstanceQuiesceService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => { void this.sweep(); }, TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** tick 한 번(테스트가 직접 부른다). 던지지 않는다 — 수집이 마케팅의 다른 일을 막지 않는다. */
  async sweep(now: Date = new Date()): Promise<EngagementSweepResult> {
    const out: EngagementSweepResult = { read: 0, changed: 0, failed: 0, stopped: 0, deferred: 0 };
    if (this.running) return out;
    this.running = true;
    const changedCampaigns = new Map<string, string>();
    try {
      if (await this.instanceQuiesce.isQuiesced()) return out;
      await this.scheduleUntracked(now);
      const due = await this.postRepo.find({
        where: { status: 'published', engagement_next_at: LessThanOrEqual(now) },
        order: { engagement_next_at: 'ASC' },
        take: BATCH,
      });
      if (!due.length) return out;
      const [channels, campaigns] = await Promise.all([
        this.channelRepo.find({ where: { id: In([...new Set(due.map((p) => p.channel_id))]) } }),
        this.campaignRepo.find({ where: { id: In([...new Set(due.map((p) => p.campaign_id))]) } }),
      ]);
      const channelById = new Map(channels.map((c) => [c.id, c]));
      const campaignById = new Map(campaigns.map((c) => [c.id, c]));
      const byOutreach = new Map<string, MarketingPost[]>();
      for (const post of due) {
        const channel = channelById.get(post.channel_id);
        const campaign = campaignById.get(post.campaign_id);
        let stop = '';
        if (!campaign || campaign.account_id !== post.account_id) stop = 'campaign not found';
        else if (campaign.status === 'archived') stop = 'campaign archived';
        else if (!channel || channel.account_id !== post.account_id || !engagementTracked(channel)) stop = 'not a post on a reddit/GitHub outreach channel';
        else if (!post.external_item_id) stop = 'no platform id was recorded when it was published';
        if (stop) {
          if (await this.stop(post, now, stop)) out.stopped++;
          continue;
        }
        if (!channel!.outreach_channel_id) {
          if (await this.failUnclaimed(post, now, 'the channel has no outreach connection — reconnect it')) out.failed++;
          continue;
        }
        const group = byOutreach.get(channel!.outreach_channel_id) || [];
        group.push(post);
        byOutreach.set(channel!.outreach_channel_id, group);
      }
      for (const [outreachId, posts] of byOutreach) {
        await this.collectChannel(outreachId, posts, channelById, now, out, changedCampaigns);
      }
    } catch (e) {
      this.logService.warn('Marketing', 'engagement sweep failed', { err: message(e) });
    } finally {
      this.running = false;
      for (const [campaignId, accountId] of changedCampaigns) this.audit.notify(accountId, campaignId, 'metric', '', 'collected');
    }
    return out;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** 한 OutreachChannel 로 읽는 글들 — 그 채널의 rate limit 몫 안에서, 커넥터가 한 요청에 받는 수씩. */
  private async collectChannel(
    outreachId: string,
    posts: MarketingPost[],
    channels: Map<string, MarketingChannel>,
    now: Date,
    out: EngagementSweepResult,
    changedCampaigns: Map<string, string>,
  ): Promise<void> {
    const outreach = await this.outreachRepo.findOne({ where: { id: outreachId } });
    const usable = outreach ? posts.filter((p) => p.account_id === outreach.account_id) : [];
    for (const post of posts) {
      if (usable.includes(post)) continue;
      if (await this.failUnclaimed(post, now, 'the channel\'s outreach connection is gone — reconnect it')) out.failed++;
    }
    if (!outreach || !usable.length) return;
    // 리미터는 실제 시각으로 기록되므로 sweep 의 now 가 아니라 지금을 기준으로 묻는다.
    let budget = Math.min(
      engagementRequestBudget(outreach.rate_limit_per_hour, this.rateLimiter.remaining(outreach.id, outreach.rate_limit_per_hour)),
      MAX_REQUESTS_PER_SWEEP,
    );
    if (budget <= 0) {
      out.deferred += usable.length;
      return;
    }
    let connector: OutreachConnector;
    try {
      connector = await this.connectorFactory(outreach, this.credentialRepo);
    } catch (e) {
      for (const post of usable) if (await this.failUnclaimed(post, now, `could not reach the channel: ${message(e)}`)) out.failed++;
      return;
    }
    if (!connector.readEngagement) {
      for (const post of usable) if (await this.stop(post, now, 'this channel cannot read engagement')) out.stopped++;
      return;
    }
    const perRequest = Math.max(1, Math.floor(connector.engagementRefsPerRequest || 1));
    for (let i = 0; i < usable.length; i += perRequest) {
      if (budget <= 0) {
        out.deferred += usable.length - i;
        return;
      }
      const claimed: MarketingPost[] = [];
      for (const post of usable.slice(i, i + perRequest)) if (await this.claim(post, now)) claimed.push(post);
      if (!claimed.length) continue;
      budget--;
      let readings: EngagementReading[];
      try {
        readings = await connector.readEngagement(claimed.map((p) => p.external_item_id));
      } catch (e) {
        for (const post of claimed) if (await this.fail(post, now, message(e))) out.failed++;
        if (channelWide(e)) {
          out.deferred += Math.max(0, usable.length - i - perRequest);
          return;
        }
        continue;
      }
      const byRef = new Map(readings.map((r) => [r.ref, r]));
      for (const post of claimed) {
        const reading = byRef.get(post.external_item_id);
        if (!reading) {
          if (await this.fail(post, now, 'the platform did not return it (deleted, removed, or outside the channel whitelist)')) out.failed++;
          continue;
        }
        const changed = await this.record(post, channels.get(post.channel_id)!, reading, now);
        if (changed === null) continue;
        out.read++;
        if (changed) {
          out.changed++;
          changedCampaigns.set(post.campaign_id, post.account_id);
        }
      }
    }
  }

  /**
   * 이 기능 전에 게시된 글을 일정에 넣는다 — 기간 안이고 수집기가 맡은 적 없는(rev 0) 글. 새 글은 게시할 때 첫 읽기가
   * 잡히고, 수집기가 멈추거나 끝낸 글은 rev 가 올라 있어 다시 잡히지 않는다.
   */
  private async scheduleUntracked(now: Date): Promise<void> {
    await this.postRepo.createQueryBuilder().update(MarketingPost)
      .set({ engagement_next_at: now })
      .where('status = :status', { status: 'published' })
      .andWhere("external_item_id <> ''")
      .andWhere('engagement_next_at IS NULL')
      .andWhere('engagement_rev = 0')
      .andWhere('published_at >= :since', { since: new Date(now.getTime() - ENGAGEMENT_WINDOW_MS) })
      .execute();
  }

  /** 글을 맡는다 — rev 를 올리고 다음 읽기를 lease 만큼 민다. 다른 서버가 먼저 맡았으면 false. */
  private async claim(post: MarketingPost, now: Date): Promise<boolean> {
    const won = await this.postRepo.createQueryBuilder().update(MarketingPost)
      .set({ engagement_rev: post.engagement_rev + 1, engagement_next_at: new Date(now.getTime() + LEASE_MS) })
      .where('id = :id AND engagement_rev = :rev', { id: post.id, rev: post.engagement_rev })
      .execute();
    if (!won.affected) return false;
    post.engagement_rev += 1;
    return true;
  }

  /** 맡은 글에만 쓴다. */
  private async write(post: MarketingPost, fields: Partial<MarketingPost>): Promise<boolean> {
    const won = await this.postRepo.createQueryBuilder().update(MarketingPost)
      .set(fields)
      .where('id = :id AND engagement_rev = :rev', { id: post.id, rev: post.engagement_rev })
      .execute();
    return !!won.affected;
  }

  /** 맡은 글을 읽지 못했다 — 다음 읽기는 성공과 같은 간격(기간이 끝났으면 멈춤). 직전 값은 그대로 둔다. */
  private fail(post: MarketingPost, now: Date, error: string): Promise<boolean> {
    return this.write(post, { engagement_next_at: nextEngagementReadAt(publishedAt(post), now), engagement_error: error.slice(0, MAX_ERROR) });
  }

  private async failUnclaimed(post: MarketingPost, now: Date, error: string): Promise<boolean> {
    return (await this.claim(post, now)) && this.fail(post, now, error);
  }

  private async stop(post: MarketingPost, now: Date, reason: string): Promise<boolean> {
    return (await this.claim(post, now)) && this.write(post, { engagement_next_at: null, engagement_error: reason });
  }

  /**
   * 읽은 값을 남긴다 — 게시물의 값과 변화량 행을 한 트랜잭션에서, 맡은 rev 가 그대로일 때만. 바뀐 것이 있으면 true,
   * 없으면 false, 그 사이 다른 서버가 맡았으면 null.
   */
  private async record(post: MarketingPost, channel: MarketingChannel, reading: EngagementReading, now: Date): Promise<boolean | null> {
    const { changes, value } = engagementChanges(channel.platform, post.engagement, reading);
    value.read_at = now.toISOString();
    return this.dataSource.transaction(async (manager) => {
      const won = await manager.createQueryBuilder().update(MarketingPost)
        .set({ engagement: value, engagement_next_at: nextEngagementReadAt(publishedAt(post), now), engagement_error: '' })
        .where('id = :id AND engagement_rev = :rev', { id: post.id, rev: post.engagement_rev })
        .execute();
      if (!won.affected) return null;
      if (changes.length) {
        const repo = manager.getRepository(MarketingMetric);
        await repo.save(changes.map((c) => repo.create({
          account_id: post.account_id,
          campaign_id: post.campaign_id,
          channel_id: post.channel_id,
          post_id: post.id,
          link_id: '',
          metric: c.metric,
          value: c.delta,
          source: ENGAGEMENT_SOURCE,
          bucket_start: now,
          note: c.note,
          recorded_by_type: SYSTEM_MARKETING_ACTOR.type,
          recorded_by_id: '',
          recorded_by_name: SYSTEM_MARKETING_ACTOR.name,
        })));
      }
      return changes.length > 0;
    });
  }
}
