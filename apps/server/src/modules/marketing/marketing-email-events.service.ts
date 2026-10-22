import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { Credential } from '../../entities/Credential';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingContactConsent } from '../../entities/MarketingContactConsent';
import { MarketingContact } from '../../entities/MarketingContact';
import { MarketingEmailSend } from '../../entities/MarketingEmailSend';
import { MarketingConsentNotice } from '../../entities/MarketingConsentNotice';
import { MarketingPost } from '../../entities/MarketingPost';
import { emailHash } from '../../common/marketing/email';
import {
  parseMultipartFields,
  parseResendEvent,
  parseSendGridEvents,
  resendInboundEmail,
  sendGridInboundEmail,
  verifySendGridSignature,
  verifySvixSignature,
  type EmailProviderEvent,
  type InboundEmail,
  type ResendReceivedRef,
} from '../../common/marketing/email-events';
import { cleanReplyText, isAutoReply, isUnsubscribeRequest } from '../../common/marketing/email-reply';
import { EMAIL_PROVIDERS, type ContactStatus as AnyContactStatus, type MarketingActor } from '../../common/marketing/marketing-constants';
import { decryptStrict } from '../../services/encryption.service';
import { LogService } from '../../services/log.service';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingEmailService } from './marketing-email.service';
import { MarketingFeedbackService } from './marketing-feedback.service';
import { MarketingListHoldService } from './marketing-list-hold.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESEND_API = 'https://api.resend.com';
const FETCH_TIMEOUT_MS = 15_000;
/** 답장 하나가 어느 캠페인 메일에 대한 것인지 고를 때 보는 최근 발송 수. */
const REPLY_CANDIDATES = 20;

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

const REJECTED: WebhookResult = { status: 401, body: { error: 'invalid signature' } };

/** 메일 채널 화면이 보여 주는 webhook 설정 — 공급자에 붙여 넣을 주소와 서명 키가 있는지(키 값은 싣지 않는다). */
export interface EmailWebhookInfo {
  provider: string;
  /** 바운스 · 신고 · 수신거부 이벤트(Resend 는 받은 메일 email.received 도 여기로). AWB_PUBLIC_URL 이 없으면 null. */
  events_url: string | null;
  /** SendGrid Inbound Parse 주소. Resend 는 events_url 하나로 받으므로 null. */
  inbound_url: string | null;
  events_signing: boolean;
  inbound_signing: boolean;
}

type ContactStatus = Extract<AnyContactStatus, 'bounced' | 'complained' | 'unsubscribed'>;

/** 이 상태로 바꿀 수 있는 이전 상태 — 억제는 약해지지 않는다(신고 > 바운스, erased · unsubscribed 는 그대로). */
const SUPPRESS_FROM: Record<ContactStatus, string[]> = {
  bounced: ['subscribed'],
  complained: ['subscribed', 'bounced'],
  unsubscribed: ['subscribed'],
};

const SUPPRESS_SUMMARY: Record<ContactStatus, string> = {
  bounced: '메일 바운스 — 발송 대상에서 뺐습니다',
  complained: '스팸 신고 — 발송 대상에서 뺐습니다',
  unsubscribed: '수신거부',
};

function header(headers: WebhookRequest['headers'], name: string): string {
  const v = headers[name.toLowerCase()];
  return String(Array.isArray(v) ? v[0] ?? '' : v ?? '').trim();
}

function providerActor(provider: string): MarketingActor {
  return { type: 'system', id: `email:${provider}`, name: `${provider} webhook` };
}

/**
 * MarketingEmailEventsService — 메일 공급자 webhook(docs/marketing.md "공급자 이벤트", "답장").
 *
 * 주소는 메일 credential 마다 하나다: `POST /api/m/email/<credential id>/events` · `/inbound`. 공급자는 한 계정의 모든
 * 메일 이벤트를 한 주소로 보내므로 채널이 아니라 credential(= 공급자 계정)이 단위다. 서명 키는 그 credential 에 있다
 * (Resend `webhook_secret`, SendGrid `webhook_public_key` · `inbound_public_key`) — 없거나 서명이 틀리면 아무것도 하지 않는다.
 *
 * 이벤트는 **그 credential 로 보낸 발송 행에만** 닿는다(행의 credential_id, 그 칸 이전 행은 채널의 지금 credential).
 * 발송 행은 보낼 때 실은 발송 행 id(Resend tag · SendGrid custom_args) → 공급자 message id → 수신 주소의 최근 발송 순으로
 * 찾는다. 처리는 상태 기반이라 공급자가 같은 이벤트를 다시 보내도 결과가 같다.
 *
 * 동의 재확인 안내(MarketingConsentNotice)도 같은 tag 에 안내 행 id 를 싣는다. 캠페인 메일을 받은 적 없는 연락처에게 간
 * 안내의 바운스 · 신고 · 수신거부(이벤트와 mailto 회신)도 그 연락처에 닿는다 — 안내 행에 미도달을 남기고 연락처를 억제한다.
 * 안내는 목록 발송이 아니라 목록의 신고율에는 세지 않는다.
 */
@Injectable()
export class MarketingEmailEventsService {
  /** 테스트가 Resend 받은 메일 API 호출을 가로챌 수 있게. */
  fetchImpl: typeof fetch | undefined;

  constructor(
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectRepository(MarketingEmailSend) private readonly sendRepo: Repository<MarketingEmailSend>,
    @InjectRepository(MarketingContact) private readonly contactRepo: Repository<MarketingContact>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(MarketingPost) private readonly postRepo: Repository<MarketingPost>,
    @InjectRepository(MarketingConsentNotice) private readonly noticeRepo: Repository<MarketingConsentNotice>,
    private readonly audit: MarketingAuditService,
    private readonly feedback: MarketingFeedbackService,
    private readonly listHolds: MarketingListHoldService,
    private readonly email: MarketingEmailService,
    private readonly logService: LogService,
  ) {}

  async webhookInfo(channel: MarketingChannel): Promise<EmailWebhookInfo | null> {
    if (channel.kind !== 'email') return null;
    const credentialId = String(channel.config?.credential_id || '');
    const cred = await this.webhookCredential(credentialId).catch(() => null);
    const provider = cred?.provider || String(channel.config?.provider || '');
    const base = (process.env.AWB_PUBLIC_URL || '').replace(/\/+$/, '');
    const url = (kind: 'events' | 'inbound') => (base && UUID_RE.test(credentialId) ? `${base}/api/m/email/${credentialId}/${kind}` : null);
    const resend = provider === 'resend';
    return {
      provider,
      events_url: url('events'),
      inbound_url: resend ? null : url('inbound'),
      events_signing: resend ? !!cred?.secret.webhook_secret : !!cred?.secret.webhook_public_key,
      inbound_signing: resend ? !!cred?.secret.webhook_secret : !!cred?.secret.inbound_public_key,
    };
  }

  /** 공급자 이벤트(Resend 의 모든 webhook · SendGrid Event Webhook). */
  async handleEvents(credentialId: string, req: WebhookRequest, now: Date = new Date()): Promise<WebhookResult> {
    const cred = await this.webhookCredential(credentialId);
    if (!cred) return REJECTED;
    if (cred.provider === 'resend') return this.handleResend(cred, req, now);
    const verified = verifySendGridSignature({
      publicKey: cred.secret.webhook_public_key || '',
      signature: header(req.headers, 'x-twilio-email-event-webhook-signature'),
      timestamp: header(req.headers, 'x-twilio-email-event-webhook-timestamp'),
      body: req.body,
      now,
    });
    if (!verified) return REJECTED;
    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'body is not JSON' } };
    }
    return { status: 200, body: { ok: true, ...(await this.applyAll(cred.id, 'sendgrid', parseSendGridEvents(payload, now))) } };
  }

  /** 받은 메일(SendGrid Inbound Parse). Resend 는 받은 메일도 같은 webhook(`email.received`)으로 오므로 events 와 같다. */
  async handleInbound(credentialId: string, req: WebhookRequest, now: Date = new Date()): Promise<WebhookResult> {
    const cred = await this.webhookCredential(credentialId);
    if (!cred) return REJECTED;
    if (cred.provider === 'resend') return this.handleResend(cred, req, now);
    const verified = verifySendGridSignature({
      publicKey: cred.secret.inbound_public_key || '',
      signature: header(req.headers, 'x-twilio-email-event-webhook-signature'),
      timestamp: header(req.headers, 'x-twilio-email-event-webhook-timestamp'),
      body: req.body,
      now,
    });
    if (!verified) return REJECTED;
    const fields = parseMultipartFields(req.body, header(req.headers, 'content-type'));
    const outcome = await this.handleReply(cred.id, 'sendgrid', sendGridInboundEmail(fields));
    return { status: 200, body: { ok: true, reply: outcome } };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async handleResend(cred: { id: string; secret: Record<string, string> }, req: WebhookRequest, now: Date): Promise<WebhookResult> {
    const verified = verifySvixSignature({
      secret: cred.secret.webhook_secret || '',
      id: header(req.headers, 'svix-id'),
      timestamp: header(req.headers, 'svix-timestamp'),
      signature: header(req.headers, 'svix-signature'),
      body: req.body,
      now,
    });
    if (!verified) return REJECTED;
    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'body is not JSON' } };
    }
    const parsed = parseResendEvent(payload, now);
    if (parsed.received) {
      const outcome = await this.handleResendReceived(cred, parsed.received);
      // 본문을 아직 못 읽었다(일시 오류) — 5xx 면 Svix 가 나중에 다시 보낸다.
      if (outcome === 'retry') return { status: 503, body: { error: 'could not read the received email yet — retry later' } };
      return { status: 200, body: { ok: true, reply: outcome } };
    }
    return { status: 200, body: { ok: true, type: parsed.type, ...(await this.applyAll(cred.id, 'resend', parsed.events)) } };
  }

  /**
   * webhook 의 credential — 메일 공급자 credential 이어야 하고, 에이전트 환경 변수로 나가는 credential 은 받지 않는다
   * (그 값은 에이전트가 이미 쥐고 있다). 무엇이 틀렸든 호출자에게는 같은 401 이다.
   */
  private async webhookCredential(credentialId: string): Promise<{ id: string; provider: string; secret: Record<string, string> } | null> {
    if (!UUID_RE.test(credentialId || '')) return null;
    const cred = await this.credentialRepo.findOne({ where: { id: credentialId } });
    if (!cred || cred.agent_env) return null;
    let data: unknown;
    try {
      data = JSON.parse(decryptStrict(cred.encrypted_data));
    } catch {
      return null;
    }
    const secret: Record<string, string> = {};
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) secret[key] = value.trim();
      }
    }
    const provider = (secret.provider || '').toLowerCase();
    if (!(EMAIL_PROVIDERS as readonly string[]).includes(provider)) return null;
    return { id: cred.id, provider, secret };
  }

  /** 이 칸이 생기기 전에 보낸 발송 행(credential_id '')은 채널의 지금 credential 로 범위를 정한다. */
  private async legacyChannelIds(credentialId: string): Promise<string[]> {
    const channels = await this.channelRepo.find({ where: { kind: 'email' }, select: ['id', 'config'] });
    return channels.filter((c) => String(c.config?.credential_id || '') === credentialId).map((c) => c.id);
  }

  private inScope(row: MarketingEmailSend | null, credentialId: string, legacy: string[]): row is MarketingEmailSend {
    return !!row && (row.credential_id === credentialId || (!row.credential_id && legacy.includes(row.channel_id)));
  }

  /** 그 주소로(이 credential 을 거쳐) 보낸 최근 발송들 — 최신순. */
  private async recentSendsTo(credentialId: string, legacy: string[], address: string, take: number): Promise<MarketingEmailSend[]> {
    if (!address) return [];
    const contacts = await this.contactRepo.find({ where: { email_hash: emailHash(address) }, select: ['id'] });
    if (!contacts.length) return [];
    return this.sendRepo.createQueryBuilder('s')
      .where('s.contact_id IN (:...cids)', { cids: contacts.map((c) => c.id) })
      .andWhere('s.status = :sent', { sent: 'sent' })
      .andWhere(new Brackets((q) => {
        q.where('s.credential_id = :cred', { cred: credentialId });
        if (legacy.length) q.orWhere("(s.credential_id = '' AND s.channel_id IN (:...legacy))", { legacy });
      }))
      .orderBy('s.sent_at', 'DESC')
      .take(take)
      .getMany();
  }

  /** 그 주소로(이 credential 을 거쳐) 간 가장 최근 재확인 안내 — 캠페인 메일을 받은 적 없는 연락처도 안내는 받았을 수 있다. */
  private async recentNoticeTo(credentialId: string, address: string): Promise<MarketingConsentNotice | null> {
    if (!address) return null;
    const contacts = await this.contactRepo.find({ where: { email_hash: emailHash(address) }, select: ['id'] });
    if (!contacts.length) return null;
    return this.noticeRepo.findOne({
      where: { contact_id: In(contacts.map((c) => c.id)), credential_id: credentialId, status: In(['sent', 'failed']) },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * 이벤트가 가리키는 메일 — 캠페인 발송 행이나 재확인 안내 행. 실어 보낸 id → 공급자 message id → 수신 주소 순으로 찾고,
   * 주소로 찾을 때는 캠페인 메일이 먼저다. 둘 다 그 credential 로 보낸 것만이다.
   */
  private async findTarget(credentialId: string, legacy: string[], ev: EmailProviderEvent): Promise<
    { kind: 'send'; row: MarketingEmailSend } | { kind: 'notice'; row: MarketingConsentNotice } | null
  > {
    if (ev.send_id) {
      const row = await this.sendRepo.findOne({ where: { id: ev.send_id } });
      if (this.inScope(row, credentialId, legacy)) return { kind: 'send', row };
      const notice = await this.noticeRepo.findOne({ where: { id: ev.send_id } });
      if (notice && notice.credential_id === credentialId) return { kind: 'notice', row: notice };
    }
    if (ev.provider_message_id) {
      const rows = await this.sendRepo.find({ where: { provider_message_id: ev.provider_message_id }, take: 5 });
      const row = rows.find((r) => this.inScope(r, credentialId, legacy));
      if (row) return { kind: 'send', row };
      const notice = await this.noticeRepo.findOne({ where: { provider_message_id: ev.provider_message_id, credential_id: credentialId } });
      if (notice) return { kind: 'notice', row: notice };
    }
    if (ev.kind === 'unsubscribe') {
      const sends = await this.recentSendsTo(credentialId, legacy, ev.recipient, 10000);
      const contacts = ev.recipient ? await this.contactRepo.find({ where: { email_hash: emailHash(ev.recipient) } }) : [];
      const notices = contacts.length ? await this.noticeRepo.find({ where: { contact_id: In(contacts.map(c => c.id)), credential_id: credentialId, status: In(['sent', 'failed']) } }) : [];
      const brands = new Set([...sends, ...notices].map(r => r.brand_id || ''));
      if (brands.size !== 1 || sends.length === 10000) return null;
      return sends[0] ? { kind: 'send', row: sends[0] } : notices[0] ? { kind: 'notice', row: notices[0] } : null;
    }
    const recent = (await this.recentSendsTo(credentialId, legacy, ev.recipient, 1))[0];
    if (recent) return { kind: 'send', row: recent };
    const notice = await this.recentNoticeTo(credentialId, ev.recipient);
    return notice ? { kind: 'notice', row: notice } : null;
  }

  private async applyAll(credentialId: string, provider: string, events: EmailProviderEvent[]) {
    const counts = { received: events.length, applied: 0, unchanged: 0, unmatched: 0 };
    if (!events.length) return counts;
    const legacy = await this.legacyChannelIds(credentialId);
    for (const ev of events) {
      const target = await this.findTarget(credentialId, legacy, ev);
      if (!target) {
        counts.unmatched++;
        continue;
      }
      const changed = target.kind === 'send' ? await this.apply(provider, ev, target.row) : await this.applyNotice(provider, ev, target.row);
      if (changed) counts.applied++;
      else counts.unchanged++;
    }
    return counts;
  }

  /**
   * 재확인 안내에 온 이벤트 — 안내 행에 미도달을 남기고(닿지 않은 안내로는 동의를 잇지 않는다), 연락처를 캠페인 메일과 같은
   * 규칙으로 억제한다. 목록 신고율에는 세지 않는다(안내는 목록 발송이 아니다).
   */
  private async applyNotice(provider: string, ev: EmailProviderEvent, notice: MarketingConsentNotice): Promise<boolean> {
    let rowChanged = false;
    const undelivered = ev.kind === 'bounce' || ev.kind === 'soft_bounce' || ev.repeat;
    if (undelivered) {
      const type = ev.repeat ? 'suppressed' : ev.kind === 'soft_bounce' ? 'soft' : 'hard';
      const won = await this.noticeRepo.createQueryBuilder().update(MarketingConsentNotice)
        .set({ bounce_type: type, event_note: ev.detail })
        .where('id = :id', { id: notice.id })
        .andWhere('bounce_type IN (:...from)', { from: type === 'soft' ? [''] : ['', 'soft'] })
        .execute();
      rowChanged = !!won.affected;
    } else if (ev.kind === 'complaint' && notice.event_note !== ev.detail) {
      await this.noticeRepo.update({ id: notice.id }, { event_note: ev.detail });
      rowChanged = true;
    }
    let contactChanged = false;
    if (ev.kind !== 'soft_bounce') {
      const status: ContactStatus = ev.kind === 'bounce' ? 'bounced' : ev.kind === 'complaint' ? 'complained' : 'unsubscribed';
      contactChanged = await this.suppressContact(notice.contact_id, status, ev.kind === 'unsubscribe' ? 'provider' : ev.kind, providerActor(provider), {
        campaignId: '', sendId: '', postId: '', noticeId: notice.id, brandId: notice.brand_id, detail: ev.detail, repeat: ev.repeat,
      });
    }
    return rowChanged || contactChanged;
  }

  /** 이벤트 하나를 발송 행 · 연락처에. 무엇이 바뀌었으면 true. */
  private async apply(provider: string, ev: EmailProviderEvent, row: MarketingEmailSend): Promise<boolean> {
    let rowChanged = false;
    const undelivered = ev.kind === 'bounce' || ev.kind === 'soft_bounce' || ev.repeat;
    if (undelivered) {
      const type = ev.repeat ? 'suppressed' : ev.kind === 'soft_bounce' ? 'soft' : 'hard';
      // soft 는 hard · suppressed 를 덮지 않는다.
      const won = await this.sendRepo.createQueryBuilder().update(MarketingEmailSend)
        .set({ bounce_type: type, bounced_at: ev.occurred_at, event_note: ev.detail })
        .where('id = :id', { id: row.id })
        .andWhere('bounce_type IN (:...from)', { from: type === 'soft' ? [''] : ['', 'soft'] })
        .execute();
      rowChanged = !!won.affected;
    }
    let newComplaint = false;
    if (ev.kind === 'complaint' && !ev.repeat) {
      const won = await this.sendRepo.createQueryBuilder().update(MarketingEmailSend)
        .set({ complained_at: ev.occurred_at, event_note: ev.detail })
        .where('id = :id AND complained_at IS NULL', { id: row.id })
        .execute();
      newComplaint = !!won.affected;
      rowChanged = rowChanged || newComplaint;
    }
    let contactChanged = false;
    if (ev.kind !== 'soft_bounce') {
      const status: ContactStatus = ev.kind === 'bounce' ? 'bounced' : ev.kind === 'complaint' ? 'complained' : 'unsubscribed';
      contactChanged = await this.suppressContact(row.contact_id, status, ev.kind === 'unsubscribe' ? 'provider' : ev.kind, providerActor(provider), {
        campaignId: row.campaign_id, sendId: row.id, postId: row.post_id, brandId: row.brand_id, detail: ev.detail, repeat: ev.repeat,
      });
    }
    if (newComplaint || (rowChanged && ev.kind === 'bounce' && !ev.repeat)) {
      const channel = await this.channelRepo.findOne({ where: { id: row.channel_id } });
      const listName = String(channel?.config?.list_name || '');
      if (channel && listName) await this.listHolds.evaluate(channel.account_id, listName);
    }
    return rowChanged || contactChanged;
  }

  /** 연락처를 억제 상태로 — 이전 상태가 맞을 때만(CAS). 바뀌었으면 감사에 남기고 true. */
  private async suppressContact(
    contactId: string,
    status: ContactStatus,
    source: string,
    actor: MarketingActor,
    ctx: { campaignId: string; sendId: string; postId: string; noticeId?: string; brandId?: string; detail: string; repeat?: boolean },
  ): Promise<boolean> {
    const contact = contactId ? await this.contactRepo.findOne({ where: { id: contactId } }) : null;
    if (!contact) return false;
    const scoped = status === 'unsubscribed' && !!ctx.brandId;
    const consent = scoped ? await this.contactRepo.manager.getRepository(MarketingContactConsent).findOneBy({ contact_id: contact.id, account_id: contact.account_id, brand_id: ctx.brandId }) : null;
    if (scoped && !consent) return false;
    const won = await this.contactRepo.manager.createQueryBuilder().update(scoped ? MarketingContactConsent : MarketingContact)
      .set({ status, unsubscribed_at: new Date(), unsubscribe_source: source })
      .where('id = :id AND status IN (:...from)', { id: consent?.id || contact.id, from: SUPPRESS_FROM[status] })
      .execute();
    if (!won.affected) return false;
    await this.audit.record({
      accountId: contact.account_id,
      campaignId: ctx.campaignId,
      entityType: 'contact',
      entityId: contact.id,
      action: `contact.${status}`,
      actor,
      summary: `${SUPPRESS_SUMMARY[status]}(${source === 'provider' ? '공급자' : source === 'mailto' ? '메일 회신' : actor.name})${ctx.repeat ? ' — 공급자가 예전 기록으로 이번 메일을 보내지 않음' : ''}`,
      detail: {
        source, brand_id: ctx.brandId || '', send_id: ctx.sendId, post_id: ctx.postId, ...(ctx.noticeId ? { consent_notice_id: ctx.noticeId } : {}),
        provider_detail: ctx.detail, previous_status: contact.status,
      },
    });
    this.audit.notify(contact.account_id, ctx.campaignId, 'contact', contact.id, status);
    return true;
  }

  /** Resend `email.received` — 우리 메일을 받은 사람이 보낸 것일 때만 본문을 읽는다(그 밖의 메일은 열지 않는다). */
  private async handleResendReceived(
    cred: { id: string; secret: Record<string, string> },
    ref: ResendReceivedRef,
  ): Promise<'recorded' | 'unsubscribed' | 'ignored' | 'duplicate' | 'retry'> {
    const legacy = await this.legacyChannelIds(cred.id);
    // 우리 메일(캠페인 메일이나 재확인 안내)을 받은 사람이 보낸 것만 연다.
    if (!(await this.recentSendsTo(cred.id, legacy, ref.from, 1)).length && !(await this.recentNoticeTo(cred.id, ref.from))) return 'ignored';
    const fetchImpl = this.fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let email: InboundEmail;
    try {
      const res = await fetchImpl(`${RESEND_API}/emails/receiving/${encodeURIComponent(ref.email_id)}`, {
        headers: { authorization: `Bearer ${cred.secret.api_key || ''}` },
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) return 'retry';
      if (res.status < 200 || res.status >= 300) {
        // 키에 읽기 권한이 없는 등 다시 보내도 같은 결과 — 답장이 왔다는 사실은 사람에게 남긴다.
        this.logService.warn('Marketing', 'received email could not be read', { status: res.status });
        email = {
          from: ref.from, to: ref.to, subject: ref.subject, headers: {}, html: '', message_id: ref.message_id, auth_failed: false,
          text: `(본문을 읽지 못했습니다 — Resend 받은 메일 API 가 HTTP ${res.status} 로 거절했습니다. 메일 credential 의 api_key 에 받은 메일을 읽을 권한(full access)이 필요합니다.)`,
        };
      } else {
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { body = null; }
        email = resendInboundEmail(ref, body);
      }
    } catch {
      return 'retry';
    } finally {
      clearTimeout(timer);
    }
    return this.handleReply(cred.id, 'resend', { ...email, message_id: email.message_id || `resend:${ref.email_id}` });
  }

  /**
   * 받은 메일 한 통 → 답장 기록(또는 mailto 수신거부). 보낸 사람이 이 credential 로 메일을 받은 연락처가 아니면 무시한다 —
   * 회신 주소로 오는 아무 메일이나 피드백이 되지 않게. 자동 응답과, 공급자가 보낸 사람 인증 실패(사칭)라고 알린 메일도 버린다.
   */
  private async unsubscribeReplyToken(credentialId: string, provider: string, email: InboundEmail, token: string): Promise<'unsubscribed' | 'ignored' | 'duplicate'> {
    if (isAutoReply(email.headers, email.subject)) return 'ignored';
    const consent = await this.contactRepo.manager.getRepository(MarketingContactConsent).findOneBy({ unsubscribe_token: token });
    if (!consent) return 'ignored';
    const contact = await this.contactRepo.findOneBy({ id: consent.contact_id, account_id: consent.account_id, email_hash: emailHash(email.from) });
    if (!contact) return 'ignored';
    const scope = { contact_id: contact.id, account_id: contact.account_id, brand_id: consent.brand_id, credential_id: credentialId };
    const send = await this.sendRepo.findOneBy({ ...scope, status: 'sent' });
    const notice = send ? null : await this.noticeRepo.findOneBy({ ...scope, status: 'sent' });
    if (!send && !notice) return 'ignored';
    const changed = await this.suppressContact(contact.id, 'unsubscribed', 'mailto', providerActor(provider), {
      campaignId: send?.campaign_id || '', sendId: send?.id || '', postId: send?.post_id || '',
      noticeId: notice?.id, brandId: consent.brand_id, detail: '',
    });
    if (changed) void this.email.sendUnsubscribeNotice({ ...contact, brand_id: consent.brand_id });
    return changed ? 'unsubscribed' : 'duplicate';
  }

  private async handleReply(credentialId: string, provider: string, email: InboundEmail): Promise<'recorded' | 'unsubscribed' | 'ignored' | 'duplicate'> {
    if (!email.from || email.auth_failed) return 'ignored';
    const token = /^(?:re:\s*)?unsubscribe ([A-Za-z0-9_-]{40,64})$/i.exec(email.subject.trim())?.[1];
    if (token) return this.unsubscribeReplyToken(credentialId, provider, email, token);
    const legacy = await this.legacyChannelIds(credentialId);
    const candidates = await this.recentSendsTo(credentialId, legacy, email.from, REPLY_CANDIDATES);
    if (!candidates.length) return this.handleNoticeReply(credentialId, provider, email);
    if (isAutoReply(email.headers, email.subject)) return 'ignored';
    // 여러 캠페인의 메일을 받은 사람이면, 회신 주소가 이 메일의 받는 주소인 채널의 최근 발송을 고른다.
    const channels = await this.channelRepo.find({ where: { id: In([...new Set(candidates.map((r) => r.channel_id))]) } });
    const byId = new Map(channels.map((c) => [c.id, c]));
    const to = new Set(email.to);
    const row = candidates.find((r) => {
      const config = byId.get(r.channel_id)?.config || {};
      return to.has(String(config.reply_to || config.from_address || '').toLowerCase());
    }) || candidates[0];
    const actor: MarketingActor = { type: 'system', id: `email-reply:${provider}`, name: '메일 답장' };

    if (isUnsubscribeRequest(email.subject)) {
      if (row.brand_id) return 'ignored';
      const changed = await this.suppressContact(row.contact_id, 'unsubscribed', 'mailto', actor, {
        campaignId: row.campaign_id, sendId: row.id, postId: row.post_id, brandId: row.brand_id, detail: '',
      });
      if (!changed) return 'duplicate';
      const contact = await this.contactRepo.findOne({ where: { id: row.contact_id } });
      if (contact) void this.email.sendUnsubscribeNotice({ ...contact, brand_id: row.brand_id });
      return 'unsubscribed';
    }

    const content = cleanReplyText({ text: email.text, html: email.html });
    if (!content) return 'ignored';
    const campaign = await this.campaignRepo.findOne({ where: { id: row.campaign_id } });
    if (!campaign) return 'ignored';
    const post = await this.postRepo.findOne({ where: { id: row.post_id } });
    const id = email.message_id
      || createHash('sha256').update(`${email.from}\n${email.subject}\n${content}`, 'utf8').digest('hex').slice(0, 40);
    const { duplicate } = await this.feedback.recordReply(campaign, {
      channelId: row.channel_id,
      postId: row.post_id,
      contactId: row.contact_id,
      content,
      summary: `메일 답장 — ${post?.title || '(제목 없음)'}`,
      sourceKey: `email-reply:${provider}:${id.toLowerCase()}`.slice(0, 250),
    }, actor);
    return duplicate ? 'duplicate' : 'recorded';
  }

  /**
   * 캠페인 메일은 받지 않았지만 재확인 안내를 받은 사람의 회신. 제목이 수신거부(List-Unsubscribe 의 mailto)면 수신거부로
   * 처리하고 안내 메일을 보낸다 — 철회를 놓치지 않게. 그 밖의 글은 이을 캠페인이 없어 기록하지 않는다.
   */
  private async handleNoticeReply(credentialId: string, provider: string, email: InboundEmail): Promise<'unsubscribed' | 'ignored' | 'duplicate'> {
    const notice = await this.recentNoticeTo(credentialId, email.from);
    if (!notice || notice.brand_id || isAutoReply(email.headers, email.subject) || !isUnsubscribeRequest(email.subject)) return 'ignored';
    const actor: MarketingActor = { type: 'system', id: `email-reply:${provider}`, name: '메일 답장' };
    const changed = await this.suppressContact(notice.contact_id, 'unsubscribed', 'mailto', actor, {
      campaignId: '', sendId: '', postId: '', noticeId: notice.id, brandId: notice.brand_id, detail: '',
    });
    if (!changed) return 'duplicate';
    const contact = await this.contactRepo.findOne({ where: { id: notice.contact_id } });
    if (contact) void this.email.sendUnsubscribeNotice({ ...contact, brand_id: notice.brand_id });
    return 'unsubscribed';
  }
}
