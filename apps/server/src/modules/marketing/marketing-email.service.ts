import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import { MarketingEmailSend } from '../../entities/MarketingEmailSend';
import { MarketingContact } from '../../entities/MarketingContact';
import { MarketingPost } from '../../entities/MarketingPost';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { Credential } from '../../entities/Credential';
import { composeMarketingEmail, consentFresh, isNightFor, nextSendableAt, type EmailSender } from '../../common/marketing/email';
import { SYSTEM_MARKETING_ACTOR, type MarketingActor } from '../../common/marketing/marketing-constants';
import { LogService } from '../../services/log.service';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { MarketingContactService } from './marketing-contact.service';
import { MarketingPostService } from './marketing-post.service';
import { marketingError } from './marketing-errors';
import { resolveMarketingSecret } from './marketing-credential';
import { sendEmail } from './marketing-email-providers';

export const MAX_RECIPIENTS_PER_POST = 10_000;
const BATCH = 50;
const TICK_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 10 * 60_000;
/** 'sending' 으로 이만큼 남은 행은 프로세스가 결과를 기록하지 못한 것이다 — 다시 보내지 않고 failed 로 닫는다. */
const STUCK_SENDING_MS = 10 * 60_000;
/** 캠페인 · 채널이 일시정지된 동안 보류한 메일을 다시 볼 간격. */
const PAUSE_RECHECK_MS = 60 * 60_000;

/** 수신거부 링크(공개). AWB_PUBLIC_URL 이 없으면 메일을 보내지 않는다 — 수신거부 링크 없는 광고 메일은 불법이다. */
export function unsubscribeUrlFor(token: string): string {
  const base = (process.env.AWB_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!base) throw marketingError(409, 'AWB_PUBLIC_URL is not set — marketing email needs a working unsubscribe link');
  return `${base}/api/m/u/${token}`;
}

/**
 * MarketingEmailService — 승인된 메일 게시물의 발송 큐(docs/marketing.md "메일").
 *
 * 승인 → 그 채널 목록의 발송 대상(subscribed · 동의 2 년 이내)마다 send 행 → 주기 처리(배치 50). 보내기 직전에
 * 연락처를 다시 본다(그 사이 수신거부 → suppressed). 수신자 현지 야간이고 야간 동의가 없으면 deferred 로 아침까지
 * 미룬다. 일시 오류는 3 번까지 다시 시도하고, 보내던 중 죽은 행은 다시 보내지 않는다(중복 발송보다 누락이 낫다).
 */
@Injectable()
export class MarketingEmailService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly enabled = (process.env.MARKETING_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
  /** 테스트가 공급자 호출을 가로챌 수 있게. */
  fetchImpl: typeof fetch | undefined;

  constructor(
    @InjectRepository(MarketingEmailSend) private readonly sendRepo: Repository<MarketingEmailSend>,
    @InjectRepository(MarketingContact) private readonly contactRepo: Repository<MarketingContact>,
    @InjectRepository(MarketingPost) private readonly postRepo: Repository<MarketingPost>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    private readonly contacts: MarketingContactService,
    private readonly posts: MarketingPostService,
    private readonly audit: MarketingAuditService,
    private readonly logService: LogService,
    hooks: MarketingCampaignHooks,
  ) {
    posts.onEmailApproved(
      (post, channel, campaign) => this.preflight(post, channel, campaign),
      (post, channel, campaign, actor) => this.enqueue(post, channel, campaign, actor),
    );
    hooks.onDeleteChildren(async (campaign, manager) => {
      await manager.getRepository(MarketingEmailSend).delete({ campaign_id: campaign.id });
    });
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => { this.processQueue().catch(() => {}); }, TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async countEligible(accountId: string, listName: string): Promise<number> {
    return (await this.contacts.eligible(accountId, listName)).contacts.length;
  }

  async listSends(post: MarketingPost, limit = 200): Promise<MarketingEmailSend[]> {
    return this.sendRepo.find({ where: { post_id: post.id }, order: { created_at: 'ASC' }, take: Math.min(Math.max(limit, 1), 1000) });
  }

  async sendCounts(postId: string): Promise<Record<string, number>> {
    const rows = await this.sendRepo.createQueryBuilder('s').select('s.status', 'status').addSelect('COUNT(*)', 'n')
      .where('s.post_id = :p', { p: postId }).groupBy('s.status').getRawMany();
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.n) || 0;
    return out;
  }

  /** 승인 전에: 보낼 수 있는가. 못 보내면 글은 draft 로 남는다. */
  private async preflight(post: MarketingPost, channel: MarketingChannel, campaign: MarketingCampaign): Promise<void> {
    unsubscribeUrlFor('preflight');
    const config = channel.config || {};
    if (!config.list_name || !config.from_address || !config.postal_address || !config.from_name) {
      throw marketingError(409, 'the email channel is missing its sender settings — edit the channel');
    }
    const secret = await resolveMarketingSecret(this.credentialRepo, String(config.credential_id || ''), campaign.account_id);
    if (!secret.api_key) throw marketingError(409, 'the email credential has no api_key');
    const { contacts } = await this.contacts.eligible(campaign.account_id, String(config.list_name));
    if (contacts.length > MAX_RECIPIENTS_PER_POST) {
      throw marketingError(409, `the list has ${contacts.length} recipients — more than ${MAX_RECIPIENTS_PER_POST} per email; split the list`);
    }
    if (!post.title) throw marketingError(400, 'an email needs a subject (title)');
  }

  private async enqueue(post: MarketingPost, channel: MarketingChannel, campaign: MarketingCampaign, actor: MarketingActor): Promise<void> {
    const listName = String(channel.config?.list_name || '');
    const { contacts, excluded } = await this.contacts.eligible(campaign.account_id, listName);
    const now = new Date();
    for (let i = 0; i < contacts.length; i += 200) {
      const chunk = contacts.slice(i, i + 200).map((c) => this.sendRepo.create({
        account_id: post.account_id,
        campaign_id: post.campaign_id,
        channel_id: channel.id,
        post_id: post.id,
        contact_id: c.id,
        status: 'queued',
        attempts: 0,
        next_attempt_at: now,
      }));
      await this.sendRepo.save(chunk);
    }
    await this.audit.record({
      accountId: post.account_id,
      campaignId: post.campaign_id,
      entityType: 'email',
      entityId: post.id,
      action: 'email.queued',
      actor,
      summary: `메일 발송 대기: ${contacts.length}명(목록 ${listName}) — 제외: 수신거부·삭제 ${excluded.not_subscribed}, 동의 2년 경과 ${excluded.consent_expired}`,
      detail: { list: listName, recipients: contacts.length, excluded },
    });
    if (!contacts.length) await this.posts.markSent(post, { sent: 0, failed: 0, suppressed: 0 });
  }

  /** 큐 처리 한 번(테스트가 직접 부른다). 같은 프로세스에서 겹쳐 돌지 않는다. */
  async processQueue(now: Date = new Date()): Promise<{ sent: number; deferred: number; failed: number; suppressed: number }> {
    const stats = { sent: 0, deferred: 0, failed: 0, suppressed: 0 };
    if (this.running) return stats;
    this.running = true;
    try {
      await this.closeStuck(now);
      const due = await this.sendRepo.find({
        where: { status: In(['queued', 'deferred']), next_attempt_at: LessThanOrEqual(now) },
        order: { next_attempt_at: 'ASC' },
        take: BATCH,
      });
      const senders = new Map<string, { sender: EmailSender; provider: string; apiKey: string } | null>();
      const postCache = new Map<string, MarketingPost | null>();
      const campaigns = new Map<string, MarketingCampaign | null>();
      const channels = new Map<string, MarketingChannel | null>();
      const touched = new Set<string>();
      for (const row of due) {
        const claim = await this.sendRepo.createQueryBuilder().update(MarketingEmailSend)
          .set({ status: 'sending' })
          .where('id = :id AND status IN (:...s)', { id: row.id, s: ['queued', 'deferred'] })
          .execute();
        if (!claim.affected) continue;
        touched.add(row.post_id);
        const outcome = await this.sendOne(row, now, senders, postCache, campaigns, channels);
        stats[outcome]++;
      }
      for (const postId of touched) await this.finishIfDone(postId);
    } finally {
      this.running = false;
    }
    return stats;
  }

  /** 수신거부 처리 안내(법정 통지) — 그 사람에게 마지막으로 메일을 보낸 채널로, 광고 표기 없이. 실패해도 수신거부는 이미 처리됐다. */
  async sendUnsubscribeNotice(contact: MarketingContact): Promise<boolean> {
    try {
      const last = await this.sendRepo.findOne({ where: { contact_id: contact.id, status: 'sent' }, order: { sent_at: 'DESC' } });
      if (!last) return false;
      const channel = await this.channelRepo.findOne({ where: { id: last.channel_id } });
      const sender = channel ? await this.senderFor(channel) : null;
      if (!sender || !contact.email) return false;
      const date = (contact.unsubscribed_at || new Date()).toISOString().slice(0, 10);
      const outcome = await sendEmail({
        provider: sender.provider,
        apiKey: sender.apiKey,
        sender: sender.sender,
        to: { email: contact.email, name: contact.name },
        message: {
          subject: '수신거부 처리 안내 / Unsubscribe confirmed',
          text: [
            `${date}에 광고성 정보 수신거부가 처리되었습니다. 앞으로 이 주소로 마케팅 메일을 보내지 않습니다.`,
            `Your unsubscribe request was processed on ${date}. You will not receive marketing email from us at this address.`,
            '',
            `${sender.sender.from_name} · ${sender.sender.postal_address} · ${sender.sender.contact_email}`,
          ].join('\n'),
          headers: {},
        },
        idempotencyKey: `unsubscribe-notice-${contact.id}-${date}`,
        fetchImpl: this.fetchImpl,
      });
      return outcome.outcome === 'sent';
    } catch (e: any) {
      this.logService.warn('Marketing', 'unsubscribe notice failed', { err: e?.message || String(e) });
      return false;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async sendOne(
    row: MarketingEmailSend,
    now: Date,
    senders: Map<string, { sender: EmailSender; provider: string; apiKey: string } | null>,
    postCache: Map<string, MarketingPost | null>,
    campaigns: Map<string, MarketingCampaign | null>,
    channels: Map<string, MarketingChannel | null>,
  ): Promise<'sent' | 'deferred' | 'failed' | 'suppressed'> {
    const finish = async (status: string, extra: Partial<MarketingEmailSend>) => {
      await this.sendRepo.update({ id: row.id }, { status, ...extra });
    };
    const contact = await this.contactRepo.findOne({ where: { id: row.contact_id } });
    if (!contact || contact.status !== 'subscribed' || !contact.email) {
      await finish('suppressed', { error: `contact is ${contact?.status || 'gone'}` });
      return 'suppressed';
    }
    if (!consentFresh(contact.consent_at, now)) {
      await finish('suppressed', { error: 'consent is older than 2 years — reconfirm before sending' });
      return 'suppressed';
    }
    if (!contact.night_consent && isNightFor(now, contact.timezone || 'Asia/Seoul')) {
      await finish('deferred', { next_attempt_at: nextSendableAt(now, contact.timezone || 'Asia/Seoul'), error: 'deferred: night hours in the recipient\'s timezone' });
      return 'deferred';
    }
    if (!postCache.has(row.post_id)) postCache.set(row.post_id, await this.postRepo.findOne({ where: { id: row.post_id } }));
    const post = postCache.get(row.post_id);
    if (!post || post.status !== 'sending') {
      await finish('suppressed', { error: `post is ${post?.status || 'gone'}` });
      return 'suppressed';
    }
    if (!campaigns.has(row.campaign_id)) campaigns.set(row.campaign_id, await this.campaignRepo.findOne({ where: { id: row.campaign_id } }));
    const campaign = campaigns.get(row.campaign_id);
    if (!campaign || campaign.status === 'archived') {
      await finish('suppressed', { error: `the campaign is ${campaign ? 'archived' : 'gone'}` });
      return 'suppressed';
    }
    if (!channels.has(row.channel_id)) channels.set(row.channel_id, await this.channelRepo.findOne({ where: { id: row.channel_id } }));
    const channel = channels.get(row.channel_id);
    // 일시정지는 "멈춤" 이지 "버림" 이 아니다 — 재개하면 이어서 보낸다.
    if (campaign.status !== 'active' || channel?.status === 'paused') {
      await finish('deferred', {
        next_attempt_at: new Date(now.getTime() + PAUSE_RECHECK_MS),
        error: campaign.status !== 'active' ? `deferred: the campaign is ${campaign.status}` : 'deferred: the channel is paused',
      });
      return 'deferred';
    }
    if (!senders.has(row.channel_id)) {
      senders.set(row.channel_id, channel && channel.status === 'active' ? await this.senderFor(channel).catch(() => null) : null);
    }
    const sender = senders.get(row.channel_id);
    if (!sender) {
      await finish('failed', { error: 'the email channel is gone or misconfigured' });
      return 'failed';
    }
    let outcome;
    try {
      const message = composeMarketingEmail({
        sender: sender.sender,
        title: post.title,
        body: post.final_body || post.body,
        unsubscribeUrl: unsubscribeUrlFor(contact.unsubscribe_token),
        contact,
      });
      outcome = await sendEmail({
        provider: sender.provider, apiKey: sender.apiKey, sender: sender.sender, to: { email: contact.email, name: contact.name },
        message, idempotencyKey: row.id, fetchImpl: this.fetchImpl,
      });
    } catch (e: any) {
      outcome = { outcome: 'failed' as const, error: String(e?.message || e).slice(0, 500) };
    }
    if (outcome.outcome === 'sent') {
      await finish('sent', { sent_at: new Date(), provider_message_id: outcome.message_id, error: '', attempts: row.attempts + 1 });
      return 'sent';
    }
    if (outcome.outcome === 'retry' && row.attempts + 1 < MAX_ATTEMPTS) {
      await finish('deferred', { attempts: row.attempts + 1, next_attempt_at: new Date(now.getTime() + RETRY_MS * (row.attempts + 1)), error: outcome.error });
      return 'deferred';
    }
    await finish('failed', { attempts: row.attempts + 1, error: outcome.error });
    return 'failed';
  }

  private async senderFor(channel: MarketingChannel): Promise<{ sender: EmailSender; provider: string; apiKey: string } | null> {
    const config = channel.config || {};
    const secret = await resolveMarketingSecret(this.credentialRepo, String(config.credential_id || ''), channel.account_id);
    const provider = String(secret.provider || config.provider || '').toLowerCase();
    if (!secret.api_key || !provider) return null;
    return {
      provider,
      apiKey: secret.api_key,
      sender: {
        from_name: String(config.from_name || ''),
        from_address: String(config.from_address || ''),
        reply_to: String(config.reply_to || ''),
        postal_address: String(config.postal_address || ''),
        contact_email: String(config.contact_email || config.from_address || ''),
        ad_label: String(config.ad_label || ''),
      },
    };
  }

  private async closeStuck(now: Date): Promise<void> {
    const stuck = await this.sendRepo.find({ where: { status: 'sending', updated_at: LessThan(new Date(now.getTime() - STUCK_SENDING_MS)) }, take: 500 });
    for (const row of stuck) {
      await this.sendRepo.update({ id: row.id, status: 'sending' }, { status: 'failed', error: 'interrupted while sending — not retried (it may have been delivered)' });
    }
  }

  private async finishIfDone(postId: string): Promise<void> {
    const counts = await this.sendCounts(postId);
    if ((counts.queued || 0) + (counts.deferred || 0) + (counts.sending || 0) > 0) return;
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post || post.status !== 'sending') return;
    await this.posts.markSent(post, { sent: counts.sent || 0, failed: counts.failed || 0, suppressed: counts.suppressed || 0 });
    await this.audit.record({
      accountId: post.account_id, campaignId: post.campaign_id, entityType: 'email', entityId: post.id, action: 'email.completed',
      actor: SYSTEM_MARKETING_ACTOR, summary: `메일 큐 완료: 발송 ${counts.sent || 0}, 실패 ${counts.failed || 0}, 제외 ${counts.suppressed || 0}`, detail: counts,
    });
  }
}
