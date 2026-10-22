import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, In, IsNull, LessThanOrEqual, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { MarketingPost } from '../../entities/MarketingPost';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingMetric } from '../../entities/MarketingMetric';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { Credential } from '../../entities/Credential';
import {
  ENGAGEMENT_ALIGN_MS,
  ENGAGEMENT_METRICS,
  ENGAGEMENT_SOURCE,
  ENGAGEMENT_WINDOW_MS,
  deferEngagementReadAt,
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
export const MAX_REQUESTS_PER_SWEEP = 30;
/** 맡은 글을 읽다가 프로세스가 죽으면 이만큼 뒤에 다시 읽는다. */
const LEASE_MS = 15 * 60_000;
const MAX_ERROR = 500;
/** 수집기가 읽는 칸만 — 본문은 싣지 않는다. */
const POST_FIELDS: (keyof MarketingPost)[] = [
  'id', 'account_id', 'campaign_id', 'channel_id', 'status', 'external_item_id', 'published_at', 'created_at',
  'engagement', 'engagement_next_at', 'engagement_rev', 'engagement_error',
];

export const ENGAGEMENT_RATE_WAIT = 'waiting for room under the channel\'s rate limit';
export const ENGAGEMENT_ARCHIVED = 'campaign archived — not read while it is archived';
export const ENGAGEMENT_MANUAL_ROWS = 'not collected: engagements or replies were recorded by hand for it before automatic collection — reading it too would count them twice';

export interface EngagementSweepResult {
  /** 읽은 글. */
  read: number;
  /** 그중 값이 바뀌어 지표 행을 남긴 글. */
  changed: number;
  /** 읽지 못한 글 — 다음 간격에 다시 읽는다. */
  failed: number;
  /** 수집을 끝낸 글(서버가 게시한 글이 아님 · 읽을 수 없는 채널). */
  stopped: number;
  /** 지금은 읽지 않고 미룬 글 — rate limit 몫이 없거나, 플랫폼 rate limit · 차단이거나, 캠페인이 보관됨. */
  deferred: number;
}

function message(e: unknown): string {
  return String((e as any)?.message ?? e).slice(0, MAX_ERROR);
}

/**
 * 요청을 아예 못 했거나(채널 cap) 플랫폼이 rate limit 을 걸었다 — 읽기를 미룬다. GitHub 은 시간당 한도를 다 쓰면 Retry-After
 * 없는 403("API rate limit exceeded …")을 준다 — 권한 403 과는 본문으로 가른다.
 */
function rateLimited(e: unknown): boolean {
  return e instanceof OutreachChannelRateLimitedError || e instanceof RedditRateLimitError || e instanceof GitHubRateLimitError
    || (e instanceof GitHubForbiddenError && (e.retryAfterMs !== undefined || /rate limit/i.test(e.message)));
}

/** 이 오류면 이번 sweep 에 그 채널에 더 묻지 않는다 — 다음 글도 같은 답(rate limit · 차단)을 받는다. */
function channelWide(e: unknown): boolean {
  return rateLimited(e) || e instanceof RedditForbiddenError || e instanceof GitHubForbiddenError;
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
 *   - 일정: 게시 1 시간 뒤 첫 읽기, 그 뒤 글의 나이에 따라 1 · 3 · 12 시간 간격, 14 일째에 마지막으로 읽는다. 실패와 보관된
 *     캠페인의 글도 같은 간격을 따른다. rate limit 때문에 지금 읽지 못한 글은 30 분 뒤에 다시 본다 — 기간이 끝나면 그대로 끝.
 *   - rate limit: 연결된 OutreachChannel 의 `rate_limit_per_hour` 가운데 절반은 게시 · 폴링 몫으로 남긴다. 요청마다 리미터를
 *     다시 본다(커넥터의 재시도도 같은 cap 에 기록된다). reddit 은 한 요청에 100 개씩, 곧 차례가 올 글까지 같이 읽는다.
 *   - 한 번만: 모든 쓰기가 이 sweep 이 읽은 `engagement_rev` 그대로일 때만 쓰고 rev 를 올린다(CAS). 읽기 전에 그렇게 글을
 *     맡고(lease), 게시물의 값과 변화량 행은 한 트랜잭션에서 쓴다 — 서버가 둘이어도, 한쪽이 오래 걸려도 같은 변화를 두 번
 *     남기지 않고, 낡은 직전 값으로 변화량을 셈하지 않는다.
 *   - 보관된 캠페인의 글은 보관된 동안 읽지 않는다(되살리면 다시 읽는다). 일시정지된 캠페인 · 채널의 글은 계속 읽는다.
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
  /** sweep 한 번에 한 채널로 보내는 요청의 상한(테스트는 낮춘다). */
  maxRequestsPerSweep = MAX_REQUESTS_PER_SWEEP;

  constructor(
    @InjectRepository(MarketingPost) private readonly postRepo: Repository<MarketingPost>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(MarketingMetric) private readonly metricRepo: Repository<MarketingMetric>,
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
    // sweep 이 오래 걸려도 lease 는 글을 맡는 그 순간부터 센다.
    const started = Date.now();
    const clock = () => new Date(now.getTime() + Date.now() - started);
    const changedCampaigns = new Map<string, string>();
    try {
      if (await this.instanceQuiesce.isQuiesced()) return out;
      await this.scheduleUntracked(now);
      const due = await this.postRepo.find({
        where: { status: 'published', engagement_next_at: LessThanOrEqual(now) },
        select: POST_FIELDS,
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
        else if (!channel || channel.account_id !== post.account_id || !engagementTracked(channel)) stop = 'not a post on a reddit/GitHub outreach channel';
        else if (!post.external_item_id) stop = 'no platform id was recorded when it was published';
        if (stop) {
          if (await this.settle(post, { engagement_next_at: null, engagement_error: stop })) out.stopped++;
          continue;
        }
        if (campaign!.status === 'archived') {
          // 보관은 되돌릴 수 있다(archived → paused) — 끝내지 않고 읽는 간격대로 다시 본다. 기간이 끝나면 그대로 끝.
          if (await this.fail(post, now, ENGAGEMENT_ARCHIVED)) out.deferred++;
          continue;
        }
        if (!channel!.outreach_channel_id) {
          if (await this.fail(post, now, 'the channel has no outreach connection — reconnect it')) out.failed++;
          continue;
        }
        const group = byOutreach.get(channel!.outreach_channel_id) || [];
        group.push(post);
        byOutreach.set(channel!.outreach_channel_id, group);
      }
      for (const [outreachId, posts] of byOutreach) {
        await this.collectChannel(outreachId, posts, channelById, now, clock, out, changedCampaigns);
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

  /**
   * 한 OutreachChannel 로 읽는 글들 — 그 채널의 rate limit 몫 안에서, 커넥터가 한 요청에 받는 수씩. 요청마다 몫을 다시 본다.
   * 몫이 없으면 남은 글은 미룬다.
   */
  private async collectChannel(
    outreachId: string,
    posts: MarketingPost[],
    channels: Map<string, MarketingChannel>,
    now: Date,
    clock: () => Date,
    out: EngagementSweepResult,
    changedCampaigns: Map<string, string>,
  ): Promise<void> {
    const outreach = await this.outreachRepo.findOne({ where: { id: outreachId } });
    const usable = outreach ? posts.filter((p) => p.account_id === outreach.account_id) : [];
    for (const post of posts) {
      if (usable.includes(post)) continue;
      if (await this.fail(post, now, 'the channel\'s outreach connection is gone — reconnect it')) out.failed++;
    }
    if (!outreach || !usable.length) return;
    // 리미터는 실제 시각으로 기록되므로 sweep 의 now 가 아니라 지금을 기준으로 묻는다. 앞 요청의 재시도도 거기 들어 있다.
    const budget = () => engagementRequestBudget(outreach.rate_limit_per_hour, this.rateLimiter.remaining(outreach.id, outreach.rate_limit_per_hour));
    const deferRest = async (rest: MarketingPost[], reason: string) => {
      for (const post of rest) if (await this.defer(post, now, reason)) out.deferred++;
    };
    if (budget() <= 0) {
      await deferRest(usable, ENGAGEMENT_RATE_WAIT);
      return;
    }
    let connector: OutreachConnector;
    try {
      connector = await this.connectorFactory(outreach, this.credentialRepo);
    } catch (e) {
      for (const post of usable) if (await this.fail(post, now, `could not reach the channel: ${message(e)}`)) out.failed++;
      return;
    }
    if (!connector.readEngagement) {
      for (const post of usable) if (await this.settle(post, { engagement_next_at: null, engagement_error: 'this channel cannot read engagement' })) out.stopped++;
      return;
    }
    const perRequest = Math.max(1, Math.floor(connector.engagementRefsPerRequest || 1));
    // 한 요청에 여러 글을 읽는 채널이면 마지막 요청의 남는 자리를 곧 차례가 올 글로 채운다.
    const room = Math.ceil(usable.length / perRequest) * perRequest - usable.length;
    const early = room > 0 ? await this.upcoming(usable, now, room) : [];
    const queue = [...usable, ...early];
    let requests = 0;
    for (let i = 0; i < queue.length; i += perRequest) {
      const chunk = queue.slice(i, i + perRequest);
      const rest = () => queue.slice(i).filter((p) => !early.includes(p));
      if (requests >= this.maxRequestsPerSweep) {
        // rate limit 이 아니다 — 쓰지 않고 due 로 둔다. 다음 sweep(5 분 뒤)이 이어서 읽는다.
        out.deferred += rest().length;
        return;
      }
      if (budget() <= 0) {
        // 아직 차례가 아닌 글(early)은 그대로 둔다.
        await deferRest(rest(), ENGAGEMENT_RATE_WAIT);
        return;
      }
      const claimed: MarketingPost[] = [];
      for (const post of chunk) if (await this.claim(post, clock())) claimed.push(post);
      if (!claimed.length) continue;
      requests++;
      let readings: EngagementReading[];
      try {
        readings = await connector.readEngagement(claimed.map((p) => p.external_item_id));
      } catch (e) {
        if (rateLimited(e)) {
          // 읽지 못했다 — 실패로 한 간격(최대 12 시간)을 건너뛰지 않고 미룬다.
          await deferRest(claimed, `${ENGAGEMENT_RATE_WAIT}: ${message(e)}`);
        } else {
          for (const post of claimed) if (await this.fail(post, now, message(e))) out.failed++;
        }
        if (channelWide(e)) {
          const reason = rateLimited(e) ? ENGAGEMENT_RATE_WAIT : `not tried after the channel refused a request: ${message(e)}`;
          await deferRest(queue.slice(i + perRequest).filter((p) => !early.includes(p)), reason);
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

  /** 같은 채널들에서 `ENGAGEMENT_ALIGN_MS` 안에 차례가 오는 글 — 이번 요청에 같이 싣는다. */
  private async upcoming(due: MarketingPost[], now: Date, limit: number): Promise<MarketingPost[]> {
    const taken = new Set(due.map((p) => p.id));
    const rows = await this.postRepo.find({
      where: {
        status: 'published',
        channel_id: In([...new Set(due.map((p) => p.channel_id))]),
        external_item_id: Not(''),
        engagement_next_at: Between(now, new Date(now.getTime() + ENGAGEMENT_ALIGN_MS)),
      },
      select: POST_FIELDS,
      order: { engagement_next_at: 'ASC' },
      take: limit + taken.size,
    });
    return rows.filter((p) => !taken.has(p.id)).slice(0, limit);
  }

  /**
   * 이 기능 전에 게시된 글을 일정에 넣는다 — 기간 안이고 수집기가 맡은 적 없는(rev 0) 글. 새 글은 게시할 때 첫 읽기가
   * 잡히고, 수집기가 한 번이라도 쓴 글은 rev 가 올라 있어 다시 잡히지 않는다. 그 글 · 그 채널 · 그 캠페인 전체로 사람 ·
   * 에이전트가 손으로 남긴 참여 · 답글이 있으면 읽지 않는다 — 읽은 값 전체가 첫 변화량이 되어 손으로 남긴 값과 두 번 세어진다.
   */
  private async scheduleUntracked(now: Date): Promise<void> {
    const legacy = await this.postRepo.find({
      where: {
        status: 'published',
        external_item_id: Not(''),
        engagement_next_at: IsNull(),
        engagement_rev: 0,
        published_at: MoreThanOrEqual(new Date(now.getTime() - ENGAGEMENT_WINDOW_MS)),
      },
      select: POST_FIELDS,
      take: BATCH,
    });
    if (!legacy.length) return;
    const handRecorded = { metric: In([...ENGAGEMENT_METRICS]), source: Not(ENGAGEMENT_SOURCE) };
    const manual = await this.metricRepo.find({
      where: [
        { ...handRecorded, channel_id: In([...new Set(legacy.map((p) => p.channel_id))]) },
        { ...handRecorded, post_id: In(legacy.map((p) => p.id)) },
        // 캠페인 전체 값(채널도 글도 없음)은 캠페인 합계에서 겹친다.
        { ...handRecorded, campaign_id: In([...new Set(legacy.map((p) => p.campaign_id))]), channel_id: '', post_id: '' },
      ],
      select: ['campaign_id', 'channel_id', 'post_id'],
    });
    const manualChannels = new Set(manual.map((m) => m.channel_id).filter(Boolean));
    const manualPosts = new Set(manual.map((m) => m.post_id).filter(Boolean));
    const manualCampaigns = new Set(manual.filter((m) => !m.channel_id && !m.post_id).map((m) => m.campaign_id));
    for (const post of legacy) {
      const counted = manualChannels.has(post.channel_id) || manualPosts.has(post.id) || manualCampaigns.has(post.campaign_id);
      await this.settle(post, counted ? { engagement_error: ENGAGEMENT_MANUAL_ROWS } : { engagement_next_at: now });
    }
  }

  /**
   * 이 sweep 이 읽은 rev 그대로일 때만 쓰고 rev 를 올린다. 모든 쓰기가 이 규칙을 따르므로, 한 서버가 글을 맡거나 값을 쓴
   * 뒤에는 그 전에 글을 읽어 둔 다른 서버가 아무것도 쓰지 못한다 — 낡은 직전 값으로 변화량을 셈하지 않는다.
   */
  private async settle(post: MarketingPost, fields: Partial<MarketingPost>): Promise<boolean> {
    const won = await this.postRepo.createQueryBuilder().update(MarketingPost)
      .set({ ...fields, engagement_rev: post.engagement_rev + 1 })
      .where('id = :id AND engagement_rev = :rev', { id: post.id, rev: post.engagement_rev })
      .execute();
    if (!won.affected) return false;
    post.engagement_rev += 1;
    return true;
  }

  /** 읽기 전에 글을 맡는다 — 다음 읽기를 lease 만큼 민다. 다른 서버가 먼저 맡았으면 false. */
  private claim(post: MarketingPost, at: Date): Promise<boolean> {
    return this.settle(post, { engagement_next_at: new Date(at.getTime() + LEASE_MS) });
  }

  /** 읽지 못했다 — 다음 읽기는 성공과 같은 간격(기간이 끝났으면 끝). 직전 값은 그대로 둔다. */
  private fail(post: MarketingPost, now: Date, error: string): Promise<boolean> {
    return this.settle(post, { engagement_next_at: nextEngagementReadAt(publishedAt(post), now), engagement_error: error.slice(0, MAX_ERROR) });
  }

  /** 지금은 읽지 않는다 — 30 분 뒤에 다시 본다(기간이 끝났으면 끝). 미룬 글이 due 목록 앞을 계속 차지하지 않게 한다. */
  private defer(post: MarketingPost, now: Date, reason: string): Promise<boolean> {
    const next = deferEngagementReadAt(publishedAt(post), now);
    const error = next ? reason : `the 14-day window ended before it could be read again (${reason})`;
    return this.settle(post, { engagement_next_at: next, engagement_error: error.slice(0, MAX_ERROR) });
  }

  /**
   * 읽은 값을 남긴다 — 게시물의 값과 변화량 행을 한 트랜잭션에서, 맡은 rev 그대로일 때만(그리고 rev 를 올린다). 바뀐 것이
   * 있으면 true, 없으면 false, 그 사이 다른 서버가 맡았으면 null.
   */
  private async record(post: MarketingPost, channel: MarketingChannel, reading: EngagementReading, now: Date): Promise<boolean | null> {
    const { changes, value } = engagementChanges(channel.platform, post.engagement, reading);
    value.read_at = now.toISOString();
    return this.dataSource.transaction(async (manager) => {
      const won = await manager.createQueryBuilder().update(MarketingPost)
        .set({ engagement: value, engagement_next_at: nextEngagementReadAt(publishedAt(post), now), engagement_error: '', engagement_rev: post.engagement_rev + 1 })
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
