import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { MarketingPost } from '../../entities/MarketingPost';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { Credential } from '../../entities/Credential';
import { SYSTEM_MARKETING_ACTOR, type MarketingActor } from '../../common/marketing/marketing-constants';
import { resolveChannelConnector } from '../outreach/connector-resolver';
import type { OutreachConnector } from '../outreach/connectors/types';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { MarketingChannelService } from './marketing-channel.service';
import { marketingError } from './marketing-errors';

const MAX_TITLE = 300;
const MAX_BODY = 40_000;
const LINK_CODE_RE = /\/api\/m\/([A-Za-z0-9]{12})(?![A-Za-z0-9])/g;

export type ConnectorFactory = (channel: OutreachChannel, credentialRepo: Repository<Credential>) => Promise<OutreachConnector>;
type EmailApprovedHandler = (post: MarketingPost, channel: MarketingChannel, campaign: MarketingCampaign, actor: MarketingActor) => Promise<void>;

/** 커뮤니티 글의 실제 본문 — 본문 끝에 공개 문구를 붙인다(비울 수 없다). */
export function composeCommunityBody(body: string, disclosure: string): string {
  const d = (disclosure || '').trim();
  return d ? `${body.trimEnd()}\n\n${d}` : body.trimEnd();
}

export function extractLinkCodes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(LINK_CODE_RE)) out.add(m[1]);
  return [...out];
}

function str(value: unknown, label: string, max: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw marketingError(400, `${label} must be a string`);
  const v = value.trim();
  if (v.length > max) throw marketingError(400, `${label} must be at most ${max} characters`);
  return v;
}

/**
 * MarketingPostService — 채널로 나가는 글의 초안 · 승인 · 게시(docs/marketing.md "커뮤니케이션").
 *
 * outreach 채널은 OutreachChannel 의 커넥터(resolveChannelConnector — 화이트리스트 · rate limiter 포함)로
 * 서버가 게시한다. 게시는 자동 재시도하지 않는다 — 네트워크 실패 뒤에 실제로는 올라가 있을 수 있어서, 다시
 * 보낼지는 사람이 retry 로 정한다. manual 채널은 사람이 올리고 링크를 기록한다. email 채널의 승인은 메일 발송
 * 서비스가 등록한 훅이 받아 발송 큐를 만든다.
 */
@Injectable()
export class MarketingPostService {
  /** 테스트가 가짜 커넥터를 꽂을 수 있게. */
  connectorFactory: ConnectorFactory = resolveChannelConnector;
  private emailApproved: EmailApprovedHandler | null = null;

  constructor(
    @InjectRepository(MarketingPost) private readonly postRepo: Repository<MarketingPost>,
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(OutreachChannel) private readonly outreachRepo: Repository<OutreachChannel>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    private readonly channels: MarketingChannelService,
    private readonly audit: MarketingAuditService,
    hooks: MarketingCampaignHooks,
  ) {
    hooks.onDeleteChildren(async (campaign, manager) => {
      await manager.getRepository(MarketingPost).delete({ campaign_id: campaign.id });
    });
  }

  /** 메일 발송 서비스가 자기 생성자에서 등록한다(순환 의존을 피하려고). */
  onEmailApproved(fn: EmailApprovedHandler): void {
    this.emailApproved = fn;
  }

  async list(campaign: MarketingCampaign, status?: string, limit = 100): Promise<MarketingPost[]> {
    return this.postRepo.find({
      where: { campaign_id: campaign.id, ...(status ? { status } : {}) },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async get(id: string, accountId: string): Promise<MarketingPost> {
    const row = id ? await this.postRepo.findOne({ where: { id } }) : null;
    if (!row || (accountId && row.account_id !== accountId)) throw marketingError(404, 'post not found');
    return row;
  }

  async countDraftedSince(campaignId: string, since: Date): Promise<number> {
    return this.postRepo.count({ where: { campaign_id: campaignId, created_by_type: 'agent', created_at: MoreThan(since) } });
  }

  /** 승인 화면이 보여 줄 실제 본문 — 공개 문구(커뮤니티) 또는 꼬리말 자리(메일)까지. */
  preview(post: MarketingPost, campaign: MarketingCampaign): string {
    if (post.final_body) return post.final_body;
    if (post.kind === 'email') return post.body;
    return composeCommunityBody(post.body, campaign.disclosure);
  }

  async draft(
    campaign: MarketingCampaign,
    channel: MarketingChannel,
    body: Record<string, unknown>,
    actor: MarketingActor,
    opts: { cycleId?: string | null } = {},
  ): Promise<{ post: MarketingPost; duplicate: boolean }> {
    this.channels.assertUsable(channel);
    const dedupeKey = str(body.dedupe_key, 'dedupe_key', 120);
    if (dedupeKey && !/^[A-Za-z0-9:_.-]+$/.test(dedupeKey)) throw marketingError(400, 'dedupe_key must be letters, digits, ":", "_", ".", "-"');
    if (dedupeKey) {
      const existing = await this.postRepo.findOne({ where: { campaign_id: campaign.id, dedupe_key: dedupeKey } });
      if (existing) return { post: existing, duplicate: true };
    }
    const title = str(body.title, 'title', MAX_TITLE);
    const text = typeof body.body === 'string' ? body.body.replace(/\r\n/g, '\n').trim() : '';
    if (!text) throw marketingError(400, 'body is required');
    if (text.length > MAX_BODY) throw marketingError(400, `body must be at most ${MAX_BODY} characters`);
    const replyTo = str(body.reply_to, 'reply_to', 200);
    let kind: 'post' | 'reply' | 'email';
    if (channel.kind === 'email') {
      if (replyTo) throw marketingError(400, 'email drafts cannot reply to a thread');
      if (!title) throw marketingError(400, 'title is required for email (it is the subject line)');
      if (title.length > 200) throw marketingError(400, 'email subject must be at most 200 characters');
      kind = 'email';
    } else if (replyTo) {
      if (channel.platform === 'reddit' && !/^t[13]_[a-z0-9]+$/.test(replyTo)) {
        throw marketingError(400, 'reddit reply_to must be a fullname (t3_… for a post, t1_… for a comment)');
      }
      if (channel.platform === 'github' && !/^issue:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#\d+$/.test(replyTo)) {
        throw marketingError(400, 'github reply_to must be "issue:{owner}/{repo}#{number}"');
      }
      kind = 'reply';
    } else {
      if (channel.kind === 'outreach' && !title) throw marketingError(400, 'title is required for a new post');
      kind = 'post';
    }
    // 글은 자기 채널의 대상으로만 간다 — 다른 subreddit/repo 로 새는 길을 만들지 않는다.
    const target = channel.target;
    const rationale = str(body.rationale, 'rationale', 4000);
    if (actor.type === 'agent' && !rationale) throw marketingError(400, 'rationale is required — why this message, for this channel, now');
    let saved: MarketingPost;
    try {
      saved = await this.postRepo.save(this.postRepo.create({
        account_id: campaign.account_id,
        campaign_id: campaign.id,
        channel_id: channel.id,
        kind,
        title,
        body: text,
        final_body: '',
        reply_to: replyTo,
        target,
        status: 'draft',
        dedupe_key: dedupeKey,
        rationale,
        created_by_type: actor.type === 'agent' ? 'agent' : 'user',
        created_by_id: actor.id,
        created_by_name: actor.name,
        cycle_id: opts.cycleId || null,
        link_codes: extractLinkCodes(`${title}\n${text}`),
      }));
    } catch (e) {
      if (dedupeKey) {
        const winner = await this.postRepo.findOne({ where: { campaign_id: campaign.id, dedupe_key: dedupeKey } });
        if (winner) return { post: winner, duplicate: true };
      }
      throw e;
    }
    await this.audit.record({
      accountId: campaign.account_id,
      campaignId: campaign.id,
      entityType: 'post',
      entityId: saved.id,
      action: 'post.drafted',
      actor,
      summary: `초안(${kind}) — ${channel.name}: ${(title || text).slice(0, 100)}`,
      detail: { channel_id: channel.id, kind, reply_to: replyTo, link_codes: saved.link_codes },
    });
    this.audit.notify(campaign.account_id, campaign.id, 'post', saved.id, 'drafted');
    return { post: saved, duplicate: false };
  }

  /**
   * 승인 — 사람이 고친 제목 · 본문과 확정 본문을 상태 CAS 와 한 UPDATE 로 저장한 뒤, 채널 종류에 따라
   * 게시(outreach) · 기록 대기(manual) · 발송 큐(email)로 넘긴다.
   */
  async approve(
    id: string,
    accountId: string,
    actor: MarketingActor,
    edits: { title?: unknown; body?: unknown; note?: unknown } = {},
  ): Promise<MarketingPost> {
    const post = await this.get(id, accountId);
    if (post.status !== 'draft') throw marketingError(409, `post is ${post.status}, not draft`);
    const campaign = await this.campaignRepo.findOne({ where: { id: post.campaign_id } });
    if (!campaign) throw marketingError(404, 'campaign not found');
    if (campaign.status !== 'active') throw marketingError(409, `campaign is ${campaign.status} — resume it before sending anything`);
    const channel = await this.channels.get(post.channel_id, accountId);
    this.channels.assertUsable(channel);

    let title = post.title;
    let body = post.body;
    let edited = false;
    if (edits.title !== undefined) {
      const t = str(edits.title, 'title', post.kind === 'email' ? 200 : MAX_TITLE);
      if (t !== title) { title = t; edited = true; }
    }
    if (edits.body !== undefined) {
      const b = typeof edits.body === 'string' ? edits.body.replace(/\r\n/g, '\n').trim() : '';
      if (!b) throw marketingError(400, 'body cannot be empty');
      if (b.length > MAX_BODY) throw marketingError(400, `body must be at most ${MAX_BODY} characters`);
      if (b !== body) { body = b; edited = true; }
    }
    if ((post.kind === 'email' || (post.kind === 'post' && channel.kind === 'outreach')) && !title) {
      throw marketingError(400, 'title is required');
    }
    const finalBody = post.kind === 'email' ? body : composeCommunityBody(body, campaign.disclosure);
    const next = channel.kind === 'outreach' ? 'publishing' : channel.kind === 'email' ? 'sending' : 'approved';
    if (next === 'sending' && !this.emailApproved) throw marketingError(503, 'email sending is not available on this server');
    const note = typeof edits.note === 'string' ? edits.note.trim().slice(0, 1000) : '';
    const won = await this.postRepo.createQueryBuilder().update(MarketingPost)
      .set({
        status: next,
        title,
        body,
        final_body: finalBody,
        edited,
        decided_by: actor.id,
        decided_by_name: actor.name,
        decided_at: new Date(),
        decision_note: note,
        link_codes: extractLinkCodes(`${title}\n${body}`),
      })
      .where('id = :id AND status = :s', { id, s: 'draft' })
      .execute();
    if (!won.affected) throw marketingError(409, 'post was decided concurrently');
    await this.audit.record({
      accountId: post.account_id,
      campaignId: post.campaign_id,
      entityType: 'post',
      entityId: id,
      action: 'post.approved',
      actor,
      summary: `발신 승인(${channel.kind}) — ${channel.name}: ${(title || body).slice(0, 100)}${edited ? ' (수정됨)' : ''}`,
      detail: { channel_id: channel.id, edited, note },
    });
    this.audit.notify(post.account_id, post.campaign_id, 'post', id, 'approved');
    const approved = await this.get(id, accountId);
    if (next === 'publishing') return this.publish(approved, channel);
    if (next === 'sending') {
      await this.emailApproved!(approved, channel, campaign, actor);
      return this.get(id, accountId);
    }
    return approved;
  }

  async reject(id: string, accountId: string, actor: MarketingActor, note = ''): Promise<MarketingPost> {
    const post = await this.get(id, accountId);
    const won = await this.postRepo.createQueryBuilder().update(MarketingPost)
      .set({ status: 'rejected', decided_by: actor.id, decided_by_name: actor.name, decided_at: new Date(), decision_note: note.slice(0, 1000) })
      .where('id = :id AND status = :s', { id, s: 'draft' })
      .execute();
    if (!won.affected) throw marketingError(409, `post is ${post.status}, not draft`);
    await this.audit.record({
      accountId: post.account_id, campaignId: post.campaign_id, entityType: 'post', entityId: id, action: 'post.rejected', actor,
      summary: `발신 거부: ${(post.title || post.body).slice(0, 100)}`, detail: { note },
    });
    this.audit.notify(post.account_id, post.campaign_id, 'post', id, 'rejected');
    return this.get(id, accountId);
  }

  /** 실패한 게시를 다시 보낸다 — 사람만. 앞 시도가 실제로는 올라갔을 수 있으니 확인하고 누르라고 화면이 말한다. */
  async retry(id: string, accountId: string, actor: MarketingActor): Promise<MarketingPost> {
    const post = await this.get(id, accountId);
    const channel = await this.channels.get(post.channel_id, accountId);
    this.channels.assertUsable(channel, ['outreach']);
    const won = await this.postRepo.createQueryBuilder().update(MarketingPost)
      .set({ status: 'publishing', error: '' })
      .where('id = :id AND status = :s', { id, s: 'failed' })
      .execute();
    if (!won.affected) throw marketingError(409, `post is ${post.status}, not failed`);
    await this.audit.record({
      accountId: post.account_id, campaignId: post.campaign_id, entityType: 'post', entityId: id, action: 'post.retried', actor,
      summary: `게시 재시도: ${(post.title || post.body).slice(0, 100)}`,
    });
    return this.publish(await this.get(id, accountId), channel);
  }

  /** manual 채널: 사람이 직접 올린 뒤 링크를 기록한다. */
  async markPublished(id: string, accountId: string, actor: MarketingActor, permalink: unknown): Promise<MarketingPost> {
    const post = await this.get(id, accountId);
    const link = typeof permalink === 'string' ? permalink.trim() : '';
    if (!/^https?:\/\/\S+$/.test(link) || link.length > 1000) throw marketingError(400, 'permalink must be the http(s) URL of the published post');
    const won = await this.postRepo.createQueryBuilder().update(MarketingPost)
      .set({ status: 'published', permalink: link, published_at: new Date() })
      .where('id = :id AND status = :s', { id, s: 'approved' })
      .execute();
    if (!won.affected) throw marketingError(409, `post is ${post.status}, not approved (manual)`);
    await this.audit.record({
      accountId: post.account_id, campaignId: post.campaign_id, entityType: 'post', entityId: id, action: 'post.published', actor,
      summary: `게시 기록(manual): ${link}`, detail: { permalink: link },
    });
    this.audit.notify(post.account_id, post.campaign_id, 'post', id, 'published');
    return this.get(id, accountId);
  }

  /** 메일 발송 서비스가 큐를 다 돌았을 때. */
  async markSent(post: MarketingPost, summary: { sent: number; failed: number; suppressed: number }): Promise<void> {
    const won = await this.postRepo.createQueryBuilder().update(MarketingPost)
      .set({ status: 'published', published_at: new Date(), error: summary.failed ? `${summary.failed} message(s) failed` : '' })
      .where('id = :id AND status = :s', { id: post.id, s: 'sending' })
      .execute();
    if (!won.affected) return;
    await this.audit.record({
      accountId: post.account_id, campaignId: post.campaign_id, entityType: 'post', entityId: post.id, action: 'post.sent',
      actor: SYSTEM_MARKETING_ACTOR,
      summary: `메일 발송 완료: ${summary.sent}통 발송, ${summary.failed}통 실패, ${summary.suppressed}통 제외`,
      detail: summary,
    });
    this.audit.notify(post.account_id, post.campaign_id, 'post', post.id, 'sent');
  }

  private async publish(post: MarketingPost, channel: MarketingChannel): Promise<MarketingPost> {
    let result: { external_item_id: string; permalink: string } | null = null;
    let error = '';
    try {
      const outreach = channel.outreach_channel_id ? await this.outreachRepo.findOne({ where: { id: channel.outreach_channel_id } }) : null;
      if (!outreach || outreach.account_id !== post.account_id) throw new Error('the channel\'s outreach connection is gone — reconnect it');
      const connector = await this.connectorFactory(outreach, this.credentialRepo);
      result = post.kind === 'reply'
        ? await connector.reply(post.reply_to, post.final_body)
        : await connector.publish({ target: post.target || channel.target, title: post.title, body: post.final_body });
    } catch (e: any) {
      error = String(e?.message || e).slice(0, 2000);
    }
    if (result) {
      await this.postRepo.createQueryBuilder().update(MarketingPost)
        .set({ status: 'published', external_item_id: String(result.external_item_id || '').slice(0, 300), permalink: String(result.permalink || '').slice(0, 1000), published_at: new Date(), error: '' })
        .where('id = :id AND status = :s', { id: post.id, s: 'publishing' })
        .execute();
      await this.audit.record({
        accountId: post.account_id, campaignId: post.campaign_id, entityType: 'post', entityId: post.id, action: 'post.published',
        actor: SYSTEM_MARKETING_ACTOR, summary: `게시됨 — ${channel.name}: ${result.permalink}`, detail: { permalink: result.permalink, external_item_id: result.external_item_id },
      });
    } else {
      await this.postRepo.createQueryBuilder().update(MarketingPost)
        .set({ status: 'failed', error })
        .where('id = :id AND status = :s', { id: post.id, s: 'publishing' })
        .execute();
      await this.audit.record({
        accountId: post.account_id, campaignId: post.campaign_id, entityType: 'post', entityId: post.id, action: 'post.failed',
        actor: SYSTEM_MARKETING_ACTOR, summary: `게시 실패 — ${channel.name}: ${error}`, detail: { error },
      });
    }
    this.audit.notify(post.account_id, post.campaign_id, 'post', post.id, result ? 'published' : 'failed');
    return this.get(post.id, post.account_id);
  }
}
