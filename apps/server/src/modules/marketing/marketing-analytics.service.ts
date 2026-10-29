import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, MoreThan, Repository } from 'typeorm';
import { MarketingLink } from '../../entities/MarketingLink';
import { MarketingMetric } from '../../entities/MarketingMetric';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { manualEngagementTarget } from '../../common/marketing/engagement-target';
import { MarketingPost } from '../../entities/MarketingPost';
import { MarketingLedgerEntry } from '../../entities/MarketingLedgerEntry';
import { MarketingBudgetAllocation } from '../../entities/MarketingBudgetAllocation';
import { OutreachInboundItem } from '../../entities/OutreachInboundItem';
import { MARKETING_METRICS, type MarketingActor } from '../../common/marketing/marketing-constants';
import { ENGAGEMENT_METRICS, ENGAGEMENT_MANUAL_ROWS, engagementCollected } from '../../common/marketing/engagement';
import { buildReport } from '../../common/marketing/report';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { marketingError } from './marketing-errors';
import { hostAllowed } from './marketing-campaign.logic';
import { normalizeHttpUrl } from './marketing-channel.logic';
import { publicBaseUrl } from '../../common/public-url';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 12;
const DEDUPE_MS = 30 * 60_000;
const DEDUPE_MAX = 50_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 120;
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|fetch|curl|wget|python-requests|httpclient|headless|monitor|scanner/i;
const MAX_OBSERVATIONS = 50;
const DAY_MS = 24 * 60 * 60_000;

export interface ClickContext {
  method: string;
  userAgent: string;
  clientKey: string;
  purpose: string;
}

/** 시간 버킷의 시작(UTC). */
export function hourStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
}

export function makeLinkCode(): string {
  const bytes = randomBytes(CODE_LENGTH * 2);
  let out = '';
  for (const b of bytes) {
    // 248 이상은 버려 62 로 나눈 나머지의 치우침을 없앤다.
    if (b >= 248) continue;
    out += BASE62[b % 62];
    if (out.length === CODE_LENGTH) break;
  }
  return out.length === CODE_LENGTH ? out : makeLinkCode();
}

/** 목적지에 UTM 을 붙인다 — 이미 있는 utm_* 은 덮어쓰지 않는다(사람이 일부러 정한 값을 존중). */
export function withUtm(destination: string, utm: Record<string, string>): string {
  const url = new URL(destination);
  for (const [k, v] of Object.entries(utm)) {
    if (v && !url.searchParams.has(k)) url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * MarketingAnalyticsService — 추적 링크 · 지표 · 리포트(docs/marketing.md "분석").
 *
 * 클릭은 raw 다. HEAD · prefetch · 봇 UA · 같은 (클라이언트, 코드)의 30 분 내 반복 · 클라이언트당 분당 120 회 초과는
 * 세지 않는다(이동은 시킨다). 클라이언트 키는 IP + UA 의 해시만 메모리에 둔다(저장하지 않는다). 프록시 뒤에서는
 * X-Forwarded-For 를 쓰므로 조작될 수 있다 — 그래서 클릭만으로 돈을 쓰지 말라고 리포트가 적는다.
 */
@Injectable()
export class MarketingAnalyticsService {
  private readonly seen = new Map<string, number>();
  private readonly rate = new Map<string, { start: number; n: number }>();

  constructor(
    @InjectRepository(MarketingLink) private readonly linkRepo: Repository<MarketingLink>,
    @InjectRepository(MarketingMetric) private readonly metricRepo: Repository<MarketingMetric>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingPost) private readonly postRepo: Repository<MarketingPost>,
    @InjectRepository(MarketingLedgerEntry) private readonly ledgerRepo: Repository<MarketingLedgerEntry>,
    @InjectRepository(MarketingBudgetAllocation) private readonly allocationRepo: Repository<MarketingBudgetAllocation>,
    @InjectRepository(OutreachInboundItem) private readonly inboundRepo: Repository<OutreachInboundItem>,
    private readonly audit: MarketingAuditService,
    hooks: MarketingCampaignHooks,
  ) {
    hooks.onDeleteChildren(async (campaign, manager) => {
      await manager.getRepository(MarketingLink).delete({ campaign_id: campaign.id });
      await manager.getRepository(MarketingMetric).delete({ campaign_id: campaign.id });
    });
  }

  /** 추적 링크의 공개 주소. AWB_PUBLIC_URL 이 없으면 바깥에서 열 수 없는 링크가 되므로 만들지 않는다. */
  publicLinkUrl(code: string): string {
    const base = publicBaseUrl();
    if (!base) throw marketingError(409, 'The public address of this AWB is not known yet (open AWB once as an admin, or set Admin → Settings → Server address / AWB_PUBLIC_URL) — tracked links need its public address');
    return `${base}/api/m/${code}`;
  }

  async countLinksSince(campaignId: string, since: Date): Promise<number> {
    return this.linkRepo.count({ where: { campaign_id: campaignId, created_by_type: 'agent', created_at: MoreThan(since) } });
  }

  async countMetricsSince(campaignId: string, since: Date): Promise<number> {
    return this.metricRepo.count({ where: { campaign_id: campaignId, recorded_by_type: 'agent', created_at: MoreThan(since) } });
  }

  async listLinks(campaign: MarketingCampaign): Promise<MarketingLink[]> {
    return this.linkRepo.find({ where: { campaign_id: campaign.id }, order: { created_at: 'DESC' }, take: 500 });
  }

  async listMetrics(campaign: MarketingCampaign, limit = 200): Promise<MarketingMetric[]> {
    return this.metricRepo.find({ where: { campaign_id: campaign.id }, order: { bucket_start: 'DESC' }, take: Math.min(Math.max(limit, 1), 1000) });
  }

  async createLink(
    campaign: MarketingCampaign,
    channel: MarketingChannel,
    body: Record<string, unknown>,
    actor: MarketingActor,
  ): Promise<{ link: MarketingLink; url: string }> {
    // 공개 주소가 없으면 바깥에서 열 수 없는 링크다 — 행을 만들기 전에 거부한다.
    this.publicLinkUrl('check');
    const destination = normalizeHttpUrl(body.destination_url, 'destination_url');
    if (!destination) throw marketingError(400, 'destination_url is required');
    const host = new URL(destination).hostname;
    if (!hostAllowed(host, campaign.allowed_domains || [])) {
      throw marketingError(400, `destination host ${host} is not in the campaign allowed_domains (${(campaign.allowed_domains || []).join(', ') || 'none'}) — a human adds domains`);
    }
    let postId = '';
    if (body.post_id) {
      const post = await this.postRepo.findOne({ where: { id: String(body.post_id), campaign_id: campaign.id } });
      if (!post) throw marketingError(404, 'post not found in this campaign');
      postId = post.id;
    }
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 120) : '';
    let link: MarketingLink | null = null;
    for (let attempt = 0; attempt < 3 && !link; attempt++) {
      const code = makeLinkCode();
      const redirect = withUtm(destination, {
        utm_source: channel.platform,
        utm_medium: channel.kind === 'email' ? 'email' : 'community',
        utm_campaign: campaign.slug,
        utm_content: postId ? postId.slice(0, 8) : code,
      });
      try {
        link = await this.linkRepo.save(this.linkRepo.create({
          account_id: campaign.account_id,
          campaign_id: campaign.id,
          channel_id: channel.id,
          post_id: postId,
          code,
          destination_url: destination,
          redirect_url: redirect,
          label,
          clicks: 0,
          created_by_type: actor.type === 'agent' ? 'agent' : 'user',
          created_by_id: actor.id,
          created_by_name: actor.name,
        }));
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
    const url = this.publicLinkUrl(link!.code);
    await this.audit.record({
      accountId: campaign.account_id,
      campaignId: campaign.id,
      entityType: 'link',
      entityId: link!.id,
      action: 'link.created',
      actor,
      summary: `추적 링크: ${url} → ${destination}`,
      detail: { code: link!.code, channel_id: channel.id, destination },
    });
    return { link: link!, url };
  }

  /**
   * 공개 리다이렉트. 모르는 코드는 null(호출자가 같은 404 를 준다). 세는 것과 무관하게 이동은 언제나 시킨다.
   */
  async click(code: string, ctx: ClickContext, now: Date = new Date()): Promise<string | null> {
    if (!/^[A-Za-z0-9]{12}$/.test(code)) return null;
    const link = await this.linkRepo.findOne({ where: { code } });
    if (!link) return null;
    if (this.shouldCount(code, ctx, now.getTime())) {
      try {
        await this.countClick(link, now);
      } catch {
        // 세기 실패가 이동을 막지 않는다.
      }
    }
    return link.redirect_url;
  }

  async recordMetrics(
    campaign: MarketingCampaign,
    observations: unknown,
    actor: MarketingActor,
  ): Promise<MarketingMetric[]> {
    if (!Array.isArray(observations) || !observations.length) throw marketingError(400, 'observations must be a non-empty array');
    if (observations.length > MAX_OBSERVATIONS) throw marketingError(400, `at most ${MAX_OBSERVATIONS} observations per call`);
    const channels = new Map((await this.channelRepo.find({ where: { campaign_id: campaign.id }, select: ['id', 'account_id', 'kind', 'platform', 'status'] })).map((c) => [c.id, c]));
    const [published, outreach] = await Promise.all([
      this.postRepo.find({ where: { campaign_id: campaign.id, account_id: campaign.account_id, status: 'published' },
        select: ['id', 'account_id', 'channel_id', 'permalink', 'engagement', 'engagement_error'] }),
      this.channelRepo.manager.getRepository(OutreachChannel).find({ where: { account_id: campaign.account_id } }),
    ]);
    // Keep the guard after collection ends or its whitelist is removed: stored deltas still contribute to reports.
    const collectedManual = published.filter((p) => channels.get(p.channel_id)?.kind === 'manual'
      && (!!p.engagement?.read_at || (p.engagement_error !== ENGAGEMENT_MANUAL_ROWS && !!manualEngagementTarget(p, channels.get(p.channel_id), outreach))));
    const manualPosts = new Set(collectedManual.map((p) => p.id));
    const manualChannels = new Set(collectedManual.map((p) => p.channel_id));
    const rows = [] as MarketingMetric[];
    for (const [i, raw] of observations.entries()) {
      const o = (raw || {}) as Record<string, unknown>;
      const metric = typeof o.metric === 'string' ? o.metric.trim() : '';
      if (!(MARKETING_METRICS as readonly string[]).includes(metric)) {
        throw marketingError(400, `observations[${i}].metric must be one of: ${MARKETING_METRICS.join(', ')}`);
      }
      if (metric === 'clicks') throw marketingError(400, `observations[${i}]: clicks come from tracked links only`);
      const value = Number(o.value);
      if (!Number.isSafeInteger(value) || value < 0) throw marketingError(400, `observations[${i}].value must be a non-negative integer`);
      const channelId = typeof o.channel_id === 'string' ? o.channel_id : '';
      if (channelId && !channels.has(channelId)) throw marketingError(404, `observations[${i}]: channel not found in this campaign`);
      let postId = '';
      let postChannelId = '';
      if (o.post_id) {
        const post = await this.postRepo.findOne({ where: { id: String(o.post_id), campaign_id: campaign.id } });
        if (!post) throw marketingError(404, `observations[${i}]: post not found in this campaign`);
        postId = post.id;
        postChannelId = post.channel_id;
      }
      // 서버가 커넥터로 읽는 채널의 참여 · 답글을 손으로도 남기면 리포트가 두 번 센다(docs/marketing.md "참여 지표 자동 수집").
      // 채널도 글도 없는 캠페인 전체 값은 그 채널들의 몫을 다시 담을 수 있어, 그런 채널이 있는 캠페인에서는 채널을 정하게 한다.
      if ((ENGAGEMENT_METRICS as readonly string[]).includes(metric)) {
        const tracked = [channelId, postChannelId].some((id) => {
          const channel = id ? channels.get(id) : undefined;
          return !!channel && engagementCollected(channel);
        });
        if (tracked || manualPosts.has(postId) || manualChannels.has(channelId)) {
          throw marketingError(400, `observations[${i}]: ${metric} of automatically collected reddit/GitHub posts are read from the platform by the server (source connector) — do not record them`);
        }
        if (!channelId && !postChannelId && ([...channels.values()].some((c) => engagementCollected(c)) || manualPosts.size > 0)) {
          throw marketingError(400, `observations[${i}]: give ${metric} a channel — the server reads it for this campaign's reddit/GitHub posts, and a campaign-wide value would count those again`);
        }
      }
      let at = new Date();
      if (o.observed_at) {
        at = new Date(String(o.observed_at));
        if (Number.isNaN(at.getTime())) throw marketingError(400, `observations[${i}].observed_at must be a date`);
        if (at.getTime() > Date.now() + 5 * 60_000) throw marketingError(400, `observations[${i}].observed_at is in the future`);
      }
      rows.push(this.metricRepo.create({
        account_id: campaign.account_id,
        campaign_id: campaign.id,
        channel_id: channelId,
        post_id: postId,
        link_id: '',
        metric,
        value,
        source: actor.type === 'agent' ? 'agent' : 'user',
        bucket_start: at,
        note: typeof o.note === 'string' ? o.note.trim().slice(0, 500) : '',
        recorded_by_type: actor.type,
        recorded_by_id: actor.id,
        recorded_by_name: actor.name,
      }));
    }
    const saved = await this.metricRepo.save(rows);
    await this.audit.record({
      accountId: campaign.account_id,
      campaignId: campaign.id,
      entityType: 'metric',
      entityId: '',
      action: 'metrics.recorded',
      actor,
      summary: `지표 ${saved.length}건 기록: ${saved.map((m) => `${m.metric}=${m.value}`).slice(0, 6).join(', ')}${saved.length > 6 ? ' …' : ''}`,
    });
    this.audit.notify(campaign.account_id, campaign.id, 'metric', '', 'recorded');
    return saved;
  }

  /** 채널별 리포트. 기본 기간은 최근 30 일. */
  async report(campaign: MarketingCampaign, range: { since?: Date; until?: Date } = {}) {
    const until = range.until || new Date();
    const since = range.since || new Date(until.getTime() - 30 * DAY_MS);
    if (since.getTime() >= until.getTime()) throw marketingError(400, 'since must be before until');
    const [channels, posts, metrics, ledger, allocations] = await Promise.all([
      this.channelRepo.find({ where: { campaign_id: campaign.id }, order: { created_at: 'ASC' } }),
      this.postRepo.find({ where: { campaign_id: campaign.id, status: 'published' }, select: ['channel_id', 'status', 'published_at'] }),
      this.metricRepo.find({ where: { campaign_id: campaign.id, bucket_start: Between(since, until) } }),
      this.ledgerRepo.find({ where: { campaign_id: campaign.id } }),
      this.allocationRepo.find({ where: { campaign_id: campaign.id, status: 'active' } }),
    ]);
    const inbound = new Map<string, number>();
    for (const ch of channels) {
      if (!ch.outreach_channel_id) continue;
      const n = await this.inboundRepo.count({ where: { channel_id: ch.outreach_channel_id, collected_at: Between(since, until) } });
      if (n) inbound.set(ch.id, n);
    }
    const counts = await this.feedbackCounts(campaign, since, until);
    return buildReport({
      currency: campaign.currency,
      since,
      until,
      channels,
      posts,
      metrics,
      ledger,
      allocations: new Map(allocations.map((a) => [a.channel_id, a.amount_minor])),
      feedback: counts.feedback,
      inbound,
      tickets: counts.tickets,
    });
  }

  /** 피드백 기능이 자기 생성자에서 바꿔 끼운다(순환 의존을 피하려고). */
  feedbackCounts: (campaign: MarketingCampaign, since: Date, until: Date) => Promise<{ feedback: Map<string, number>; tickets: Map<string, number> }> =
    async () => ({ feedback: new Map(), tickets: new Map() });

  // ── internals ────────────────────────────────────────────────────────────

  private shouldCount(code: string, ctx: ClickContext, now: number): boolean {
    if (ctx.method !== 'GET') return false;
    if (/prefetch|prerender|preview/i.test(ctx.purpose)) return false;
    if (!ctx.userAgent || BOT_UA.test(ctx.userAgent)) return false;
    const client = createHash('sha256').update(ctx.clientKey).digest('hex').slice(0, 24);
    const bucket = this.rate.get(client);
    if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
      this.rate.set(client, { start: now, n: 1 });
    } else if (++bucket.n > RATE_MAX_PER_WINDOW) {
      return false;
    }
    const key = `${client}:${code}`;
    const last = this.seen.get(key);
    if (last && now - last < DEDUPE_MS) return false;
    this.seen.set(key, now);
    if (this.seen.size > DEDUPE_MAX) this.prune(now);
    if (this.rate.size > DEDUPE_MAX) this.rate.clear();
    return true;
  }

  private prune(now: number): void {
    for (const [k, t] of this.seen) {
      if (now - t >= DEDUPE_MS) this.seen.delete(k);
    }
    // 그래도 크면 오래된 것부터 지운다(Map 은 삽입 순서).
    while (this.seen.size > DEDUPE_MAX) {
      const first = this.seen.keys().next().value;
      if (first === undefined) break;
      this.seen.delete(first);
    }
  }

  private async countClick(link: MarketingLink, now: Date): Promise<void> {
    await this.linkRepo.createQueryBuilder().update(MarketingLink)
      .set({ clicks: () => 'clicks + 1' })
      .where('id = :id', { id: link.id })
      .execute();
    const bucket = hourStart(now);
    const bump = async () => {
      const existing = await this.metricRepo.findOne({ where: { link_id: link.id, metric: 'clicks', source: 'link', bucket_start: bucket } });
      if (!existing) return false;
      await this.metricRepo.createQueryBuilder().update(MarketingMetric)
        .set({ value: () => 'value + 1' })
        .where('id = :id', { id: existing.id })
        .execute();
      return true;
    };
    if (await bump()) return;
    try {
      await this.metricRepo.save(this.metricRepo.create({
        account_id: link.account_id,
        campaign_id: link.campaign_id,
        channel_id: link.channel_id,
        post_id: link.post_id,
        link_id: link.id,
        metric: 'clicks',
        value: 1,
        source: 'link',
        bucket_start: bucket,
        note: '',
        recorded_by_type: 'public',
        recorded_by_id: '',
        recorded_by_name: '',
      }));
    } catch {
      // 같은 시간 버킷의 첫 클릭 둘이 겹쳤다 — 유일 인덱스가 이긴 쪽을 남겼으니 그 행에 더한다.
      await bump();
    }
  }
}
