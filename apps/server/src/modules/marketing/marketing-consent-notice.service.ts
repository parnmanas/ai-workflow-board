import { randomBytes } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import { MarketingConsentNotice } from '../../entities/MarketingConsentNotice';
import { MarketingConsentNoticeSetting } from '../../entities/MarketingConsentNoticeSetting';
import { MarketingBrand } from '../../entities/MarketingBrand';
import { MarketingContactConsent } from '../../entities/MarketingContactConsent';
import { MarketingContact } from '../../entities/MarketingContact';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingEmailSend } from '../../entities/MarketingEmailSend';
import { consentDeadline, consentFresh, isNightFor, nextSendableAt, type EmailSender } from '../../common/marketing/email';
import {
  CONSENT_KEEP_GRACE_MS,
  CONSENT_NOTICE_SEND_MARGIN_MS,
  DEFAULT_CONSENT_NOTICE_SETTINGS,
  RECONFIRM_CONSENT_METHOD,
  composeConsentNotice,
  consentNoticeDueAt,
  sameConsentCycle,
  sampleConsentNoticeContact,
  validateConsentNoticeSettings,
  type ConsentNoticeSettingsValue,
} from '../../common/marketing/consent-notice';
import { SEND_ID_TAG } from '../../common/marketing/email-events';
import {
  CONSENT_NOTICE_POLICIES,
  CONSENT_NOTICE_STATUSES,
  type ConsentNoticePolicy,
  type MarketingActor,
} from '../../common/marketing/marketing-constants';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { LogService } from '../../services/log.service';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingEmailService, unsubscribeUrlFor, type ChannelSender } from './marketing-email.service';
import { sendEmail, type EmailOutcome } from './marketing-email-providers';
import { marketingError } from './marketing-errors';

const TICK_MS = 60_000;
/** 줄 세우기(브랜드별 동의를 훑는다)는 이 간격으로만 — 보내기는 매 tick. */
const PLAN_EVERY_MS = 10 * 60_000;
const BATCH = 50;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 10 * 60_000;
/** 'sending' 으로 이만큼 남은 행은 프로세스가 결과를 기록하지 못한 것이다 — 다시 보내지 않고 failed 로 닫는다. */
const STUCK_SENDING_MS = 10 * 60_000;
/** 발신 채널이 없거나 안내가 꺼진 동안 미룬 행을 다시 볼 간격. */
const RECHECK_MS = 60 * 60_000;
const RECENT_MS = 30 * 24 * 60 * 60_000;
/** "응답이 없으면 유지" 안내의 기한이 이만큼 남으면 동의를 잇는다 — 기한이 지나는 순간 발송 대상에서 빠지는 틈이 없게. */
const RENEW_AHEAD_MS = 60 * 60_000;
/** 서버가 멈춰 기한을 넘겼어도 이 안이면 뒤늦게 잇는다. */
const RENEW_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const IN_CHUNK = 500;
/** 발신 채널이 없어 미룬 행의 error 앞머리 — 현황이 이것으로 센다. */
export const NO_SENDER_PREFIX = 'deferred: no email channel';

/** 이 안내의 "동의 유지" 링크(공개). AWB_PUBLIC_URL 이 없으면 안내를 보내지 않는다 — 유지 · 철회 방법은 법정 항목이다. */
export function consentKeepUrlFor(token: string): string {
  const base = (process.env.AWB_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!base) throw marketingError(409, 'AWB_PUBLIC_URL is not set — the consent notice needs working keep and unsubscribe links');
  return `${base}/api/m/c/${token}`;
}

function newNoticeToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 유지 링크를 받지 않는 경우 — 트랜잭션을 되돌리고 같은 거절 화면을 보인다. */
class KeepRefused extends Error {}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ConsentNoticeCounts {
  /** 지금 안내 창(기한 lead_days 일 전 ~ 기한) 안의 브랜드별 동의. */
  in_window: number;
  /** 그중 아직 안내 행이 없는 것 — 다음 줄 세우기가 넣는다. */
  not_yet_queued: number;
  /** 보내기를 기다리는 안내(queued · deferred · sending). */
  waiting: number;
  /** 그중 발신 채널이 없어 미룬 것. */
  waiting_no_sender: number;
  sent_30d: number;
  failed_30d: number;
  /** 실패했지만 기한 전이라 사람이 다시 보낼 수 있는 안내. */
  failed_retryable: number;
  skipped_30d: number;
  kept_30d: number;
  /** 기한이 이미 지나 안내로 이을 수 없는 브랜드별 동의(새 동의가 있어야 다시 보낸다). */
  expired: number;
}

interface SendContext {
  settings: Map<string, MarketingConsentNoticeSetting | null>;
  channels: Map<string, MarketingChannel[]>;
  senders: Map<string, ChannelSender | null>;
}

/**
 * MarketingConsentNoticeService — 수신 동의 재확인 안내(docs/marketing.md "동의 재확인 안내", 정보통신망법 §50⑧).
 *
 * 1. 줄 세우기: 안내를 켠 계정의 subscribed 연락처 가운데 동의 기한이 `lead_days` 일 안으로 들어온 브랜드별 동의마다 (연락처, 브랜드, 기한)
 *    한 행을 넣는다(유일 인덱스 — 서버가 둘이어도 한 번).
 * 2. 보내기: 보내기 직전에 다시 본다 — 그 사이 수신거부 · 새 동의(기한이 바뀜) · 기한 지남이면 보내지 않는다(skipped).
 *    발신자는 같은 브랜드의 채널이다(최근 받은 메일의 채널, 없으면 그 사람의 목록을 쓰는 채널). 수신자 현지
 *    야간이면 아침까지 미룬다(기한을 넘기게 되면 미루지 않는다). 일시 오류는 3 번까지 다시 시도한다. 공급자에 넘긴 뒤에는
 *    무슨 일이 있어도 다시 보내지 않는다(받았을 수 있는 법정 통지를 두 번 보내지 않게).
 * 3. 기한: 무응답이면 유지(`keep`)로 안내했고 그 사이 철회 · 새 동의 · 미도달(바운스)이 없으면 그 기한부터 동의를 잇는다
 *    (`consent_renewed_at`, 기한 직전에). `lapse` 면 그대로 — 유지 링크를 누르지 않은 사람은 기한에 발송에서 빠진다.
 * 4. 유지 링크(POST): 새 동의 — `consent_at` 이 그 시각, method `reconfirm`, 기간을 그때부터 다시 센다.
 *
 * 꺼진 계정 · `MARKETING_SCHEDULER_ENABLED=false` · 인스턴스 quiesce 중에는 보내지 않는다.
 */
@Injectable()
export class MarketingConsentNoticeService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPlanAt = 0;
  private readonly enabled = (process.env.MARKETING_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
  /** 테스트가 공급자 호출을 가로챌 수 있게. */
  fetchImpl: typeof fetch | undefined;

  constructor(
    @InjectRepository(MarketingConsentNotice) private readonly noticeRepo: Repository<MarketingConsentNotice>,
    @InjectRepository(MarketingConsentNoticeSetting) private readonly settingsRepo: Repository<MarketingConsentNoticeSetting>,
    @InjectRepository(MarketingContact) private readonly contactRepo: Repository<MarketingContact>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(MarketingEmailSend) private readonly sendRepo: Repository<MarketingEmailSend>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly email: MarketingEmailService,
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

  /** tick 한 번. 던지지 않는다 — 안내가 마케팅의 다른 일을 막지 않는다. */
  async sweep(now: Date = new Date()): Promise<void> {
    try {
      if (await this.instanceQuiesce.isQuiesced()) return;
      if (now.getTime() - this.lastPlanAt >= PLAN_EVERY_MS) {
        this.lastPlanAt = now.getTime();
        await this.plan(now);
        await this.renewDue(now);
      }
      await this.processQueue(now);
    } catch (e: any) {
      this.logService.warn('Marketing', 'consent notice sweep failed', { err: e?.message || String(e) });
    }
  }

  // ── 설정 · 현황 ───────────────────────────────────────────────────────────

  async settingsRow(accountId: string): Promise<MarketingConsentNoticeSetting | null> {
    return accountId ? this.settingsRepo.findOne({ where: { account_id: accountId } }) : null;
  }

  settingsValue(row: MarketingConsentNoticeSetting | null): ConsentNoticeSettingsValue {
    if (!row) return { ...DEFAULT_CONSENT_NOTICE_SETTINGS };
    return {
      enabled: !!row.enabled,
      subject: row.subject,
      body: row.body,
      lead_days: row.lead_days,
      on_no_response: (CONSENT_NOTICE_POLICIES as readonly string[]).includes(row.on_no_response)
        ? row.on_no_response as ConsentNoticePolicy
        : DEFAULT_CONSENT_NOTICE_SETTINGS.on_no_response,
    };
  }

  /**
   * 운영자가 문구 · 발송 시점 · 무응답 처리 · 켜기를 정한다. 문구나 무응답 처리가 바뀌면 version 이 오른다.
   * 켜려면 AWB_PUBLIC_URL 이 있어야 한다(유지 · 철회 링크).
   */
  async saveSettings(accountId: string, body: Record<string, unknown>, actor: MarketingActor): Promise<MarketingConsentNoticeSetting> {
    if (!accountId) throw marketingError(400, 'account is required');
    const row = await this.settingsRow(accountId);
    const before = this.settingsValue(row);
    const result = validateConsentNoticeSettings(body || {}, before);
    if ('error' in result) throw marketingError(400, result.error);
    const next = result.value;
    if (next.enabled) consentKeepUrlFor('check');
    const textChanged = !row || next.subject !== row.subject || next.body !== row.body || next.on_no_response !== row.on_no_response;
    const fields = { ...next, updated_by: actor.id, updated_by_name: actor.name };
    let saved: MarketingConsentNoticeSetting;
    if (row) {
      saved = await this.settingsRepo.save(Object.assign(row, fields, { version: textChanged ? row.version + 1 : row.version }));
    } else {
      try {
        saved = await this.settingsRepo.save(this.settingsRepo.create({ account_id: accountId, ...fields, version: 1 }));
      } catch (e) {
        // 처음 저장이 동시에 둘 — 유일 인덱스가 하나만 남긴다. 진 쪽은 다시 시도하면 된다.
        if (await this.settingsRow(accountId)) throw marketingError(409, 'the settings were saved by someone else just now — reload and try again');
        throw e;
      }
    }
    const describe = (v: ConsentNoticeSettingsValue) =>
      `${v.enabled ? '켬' : '끔'} · 기한 ${v.lead_days}일 전 · 무응답 ${v.on_no_response === 'keep' ? '유지' : '철회'}`;
    await this.audit.record({
      accountId,
      campaignId: '',
      entityType: 'consent_notice',
      entityId: saved.id,
      action: 'consent_notice.settings',
      actor,
      summary: `동의 재확인 안내 설정: ${describe(next)}${textChanged && row ? ' · 문구 변경' : ''}`,
      detail: {
        before: { enabled: before.enabled, lead_days: before.lead_days, on_no_response: before.on_no_response },
        after: { enabled: next.enabled, lead_days: next.lead_days, on_no_response: next.on_no_response },
        version: saved.version,
        text_changed: textChanged,
        // 보낸 안내 · 유지 기록은 버전만 가리킨다 — 그 버전의 문구를 여기(append-only)에 남긴다.
        subject: next.subject,
        body: next.body,
      },
    });
    this.audit.notify(accountId, '', 'consent_notice', saved.id, 'settings');
    return saved;
  }

  /** 설정 화면의 현황 — 무엇이 곧 나가고, 무엇이 나갔고, 누가 이미 늦었는가. */
  async overview(accountId: string, now: Date = new Date()): Promise<{ row: MarketingConsentNoticeSetting | null; settings: ConsentNoticeSettingsValue; counts: ConsentNoticeCounts }> {
    const row = await this.settingsRow(accountId);
    const settings = this.settingsValue(row);
    const counts: ConsentNoticeCounts = {
      in_window: 0, not_yet_queued: 0, waiting: 0, waiting_no_sender: 0,
      sent_30d: 0, failed_30d: 0, failed_retryable: 0, skipped_30d: 0, kept_30d: 0, expired: 0,
    };
    if (!accountId) return { row, settings, counts };
    const contacts = await this.subscribedContacts(accountId);
    const due: Array<{ contactId: string; consentId: string; brandId: string; dueAt: Date }> = [];
    for (const c of contacts) {
      if (!consentFresh(c, now)) {
        counts.expired++;
        continue;
      }
      const dueAt = consentNoticeDueAt(c, settings.lead_days, now);
      if (dueAt) due.push({ contactId: c.contact_id, consentId: c.id, brandId: c.brand_id, dueAt });
    }
    counts.in_window = due.length;
    const have = await this.existingCycles(due.map((d) => d.consentId));
    counts.not_yet_queued = due.filter((d) => !(have.get(d.consentId) || []).some((at) => sameConsentCycle(at, d.dueAt))).length;
    const since = new Date(now.getTime() - RECENT_MS);
    const base = () => this.noticeRepo.createQueryBuilder('n').where('n.account_id = :a', { a: accountId });
    [counts.waiting, counts.waiting_no_sender, counts.sent_30d, counts.failed_30d, counts.failed_retryable, counts.skipped_30d, counts.kept_30d] = await Promise.all([
      base().andWhere('n.status IN (:...s)', { s: ['queued', 'deferred', 'sending'] }).getCount(),
      base().andWhere('n.status IN (:...s)', { s: ['queued', 'deferred'] }).andWhere('n.error LIKE :p', { p: `${NO_SENDER_PREFIX}%` }).getCount(),
      base().andWhere('n.status = :s', { s: 'sent' }).andWhere('n.sent_at >= :since', { since }).getCount(),
      base().andWhere('n.status = :s', { s: 'failed' }).andWhere('n.updated_at >= :since', { since }).getCount(),
      base().andWhere('n.status = :s', { s: 'failed' }).andWhere('n.due_at > :t', { t: new Date(now.getTime() + CONSENT_NOTICE_SEND_MARGIN_MS) }).getCount(),
      base().andWhere('n.status = :s', { s: 'skipped' }).andWhere('n.updated_at >= :since', { since }).getCount(),
      base().andWhere('n.kept_at >= :since', { since }).getCount(),
    ]);
    return { row, settings, counts };
  }

  /** 최근 안내(사람용) — 받은 사람의 주소는 사람용 REST 에만 싣는다. */
  async list(accountId: string, opts: { status?: string; limit?: number } = {}): Promise<Array<{ notice: MarketingConsentNotice; contact: MarketingContact | null }>> {
    if (opts.status && !(CONSENT_NOTICE_STATUSES as readonly string[]).includes(opts.status)) {
      throw marketingError(400, `status must be one of: ${CONSENT_NOTICE_STATUSES.join(', ')}`);
    }
    const rows = await this.noticeRepo.find({
      where: { account_id: accountId, ...(opts.status ? { status: opts.status } : {}) },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(opts.limit || 50, 1), 200),
    });
    const ids = [...new Set(rows.map((r) => r.contact_id))];
    const contacts = ids.length
      ? await this.contactRepo.find({ where: { account_id: accountId, id: In(ids) }, select: ['id', 'email', 'name', 'status'] })
      : [];
    const byId = new Map(contacts.map((c) => [c.id, c]));
    return rows.map((notice) => ({ notice, contact: byId.get(notice.contact_id) || null }));
  }

  /** 연락처마다 가장 최근 주기의 안내(연락처 목록이 동의 기한 옆에 보여 준다). */
  async latestFor(accountId: string, contactIds: string[], brandId?: string): Promise<Map<string, MarketingConsentNotice>> {
    const out = new Map<string, MarketingConsentNotice>();
    const ids = [...new Set(contactIds.filter(Boolean))];
    if (!accountId || !ids.length) return out;
    for (const part of chunks(ids, IN_CHUNK)) {
      const rows = await this.noticeRepo.find({
        where: { account_id: accountId, contact_id: In(part), ...(brandId ? { brand_id: brandId } : {}) },
        order: { due_at: 'DESC', created_at: 'DESC' },
      });
      for (const r of rows) if (!out.has(r.contact_id)) out.set(r.contact_id, r);
    }
    return out;
  }

  /**
   * 저장하기 전의 문구를 실제로 나갈 모양으로 — 예시 받는 사람(기한이 lead_days 일 뒤)과 이 계정에서 보낼 수 있는 첫 메일
   * 채널의 발신자로 조립한다. 키 값은 싣지 않는다.
   */
  async preview(accountId: string, body: Record<string, unknown>, now: Date = new Date()) {
    const result = validateConsentNoticeSettings(body || {}, this.settingsValue(await this.settingsRow(accountId)));
    if ('error' in result) throw marketingError(400, result.error);
    const value = result.value;
    const warnings: string[] = [];
    let picked: { channel: MarketingChannel; sender: EmailSender } | null = null;
    for (const channel of await this.candidateChannels(accountId)) {
      const s = await this.email.senderFor(channel).catch(() => null);
      if (s) {
        picked = { channel, sender: s.sender };
        break;
      }
    }
    if (!picked) warnings.push('no email channel can send this notice yet — approve an email channel for the lists your contacts are on');
    const base = (process.env.AWB_PUBLIC_URL || '').replace(/\/+$/, '');
    if (!base) warnings.push('AWB_PUBLIC_URL is not set — notices cannot carry keep and unsubscribe links until it is');
    const link = (kind: 'c' | 'u') => `${base || 'https://<AWB_PUBLIC_URL>'}/api/m/${kind}/…`;
    const sample = sampleConsentNoticeContact(now, value.lead_days);
    const message = composeConsentNotice({
      sender: picked?.sender || {
        from_name: '(sender name)', from_address: 'sender@example.com', reply_to: '', postal_address: '(postal address)',
        contact_email: 'contact@example.com', ad_label: '',
      },
      subject: value.subject,
      body: value.body,
      policy: value.on_no_response,
      contact: sample,
      dueAt: sample.dueAt,
      keepUrl: link('c'),
      unsubscribeUrl: link('u'),
    });
    return {
      subject: message.subject,
      text: message.text,
      sender: picked
        ? { channel_id: picked.channel.id, campaign_id: picked.channel.campaign_id, channel_name: picked.channel.name, from_name: picked.sender.from_name, from_address: picked.sender.from_address }
        : null,
      warnings,
    };
  }

  // ── 유지 링크(공개) ──────────────────────────────────────────────────────

  /**
   * 받은 사람이 안내의 유지 링크로 POST 했다 — 새 동의로 기록한다(consent_at = 지금, method reconfirm). 같은 안내로 두 번
   * 눌러도 한 번이다. 기한 뒤 30 일까지만 받고, 수신거부 · 바운스 · 삭제된 연락처는 되살리지 않는다.
   *
   * 토큰은 안내 메일에만 있다 — 쥐고 있으면 그 메일을 받은 것이다. 그래서 행이 failed("닿았을 수 있음")여도 받는다.
   * 안내 표시(kept_at) · 연락처 · 감사는 한 트랜잭션이다: 먼저 안내를 선점해 동시에 두 번 눌러도 한 번만 바꾸고, 연락처를
   * 못 바꾸면 선점까지 되돌린다(이전 동의 증거가 감사에 남기 전에 덮이지 않게).
   */
  async keep(token: string, now: Date = new Date()): Promise<{ kept: boolean; at: Date | null }> {
    const refused = { kept: false, at: null };
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token || '')) return refused;
    const notice = await this.noticeRepo.findOne({ where: { token } });
    if (!notice || !await this.consentForNotice(notice)) return refused;
    try {
      const result = await this.dataSource.transaction(async (m) => {
        const contacts = m.getRepository(MarketingContact);
        const noticeRepo = m.getRepository(MarketingConsentNotice);
        const contact = await contacts.findOne({ where: { id: notice.contact_id } });
        if (!contact || contact.account_id !== notice.account_id || contact.status !== 'subscribed' || !contact.email) throw new KeepRefused();
        const consent = await m.getRepository(MarketingContactConsent).findOneBy({
          id: notice.consent_id, account_id: notice.account_id, contact_id: contact.id, brand_id: notice.brand_id, status: 'subscribed',
        });
        if (!consent) throw new KeepRefused();
        const current = await noticeRepo.findOne({ where: { id: notice.id } });
        if (current?.kept_at) return { at: current.kept_at, changed: null };
        if (!sameConsentCycle(consentDeadline(consent), notice.due_at)
          && !(consent.consent_renewed_at && sameConsentCycle(consent.consent_renewed_at, notice.due_at))) throw new KeepRefused();
        if (now.getTime() > new Date(notice.due_at).getTime() + CONSENT_KEEP_GRACE_MS) throw new KeepRefused();
        const claim = await m.createQueryBuilder().update(MarketingConsentNotice)
          .set({ kept_at: now })
          .where('id = :id AND kept_at IS NULL', { id: notice.id })
          .execute();
        if (!claim.affected) return { at: (await noticeRepo.findOne({ where: { id: notice.id } }))?.kept_at || now, changed: null };
        const updated = await m.createQueryBuilder().update(MarketingContactConsent)
          .set({
            consent_at: now,
            consent_method: RECONFIRM_CONSENT_METHOD,
            consent_source: `consent-notice:${notice.id}`,
            consent_text_version: `consent-notice-v${notice.settings_version}`,
            // 공개 경로라 IP 원문은 남기지 않는다(docs/marketing.md "원칙").
            consent_ip: '',
            consent_renewed_at: null,
          })
          .where('id = :id AND status = :s', { id: consent.id, s: 'subscribed' })
          .andWhere('consent_at = :original', { original: consent.consent_at })
          .andWhere(consent.consent_renewed_at ? 'consent_renewed_at = :renewed' : 'consent_renewed_at IS NULL', { renewed: consent.consent_renewed_at })
          .andWhere("EXISTS (SELECT 1 FROM marketing_contacts c WHERE c.id = :contact AND c.account_id = :account AND c.status = 'subscribed' AND c.email IS NOT NULL)", { contact: contact.id, account: notice.account_id })
          .execute();
        if (!updated.affected) throw new KeepRefused();
        await this.audit.record({
          accountId: contact.account_id,
          campaignId: '',
          entityType: 'contact',
          entityId: contact.id,
          action: 'contact.consent_kept',
          actor: { type: 'public', id: '', name: 'recipient' },
          summary: '수신 동의 유지(재확인 안내의 유지 링크) — 동의일을 오늘로 갱신',
          detail: {
            notice_id: notice.id,
            brand_id: notice.brand_id,
            consent_id: notice.consent_id,
            due_at: new Date(notice.due_at).toISOString(),
            previous: {
              consent_method: consent.consent_method,
              consent_source: consent.consent_source,
              consent_at: new Date(consent.consent_at).toISOString(),
              consent_text_version: consent.consent_text_version,
              consent_renewed_at: consent.consent_renewed_at ? new Date(consent.consent_renewed_at).toISOString() : null,
            },
          },
        }, m);
        return { at: now, changed: contact };
      });
      if (result.changed) this.audit.notify(result.changed.account_id, '', 'contact', result.changed.id, 'consent_kept');
      return { kept: true, at: result.at };
    } catch (e) {
      if (e instanceof KeepRefused) return refused;
      throw e;
    }
  }

  /**
   * 실패한 안내를 사람이 다시 보낸다 — 기한 전인 것만. 공급자 설정(키 · 도메인)을 고친 뒤에 쓴다. SendGrid 의 시간 초과처럼
   * "닿았을 수 있음" 으로 닫힌 안내는 두 번 받을 수 있다(화면이 알린다). 다시 줄 세운 수.
   */
  async retryFailed(accountId: string, actor: MarketingActor, now: Date = new Date()): Promise<number> {
    if (!accountId) throw marketingError(400, 'account is required');
    const res = await this.noticeRepo.createQueryBuilder().update(MarketingConsentNotice)
      .set({ status: 'queued', attempts: 0, next_attempt_at: now, error: '' })
      .where('account_id = :a AND status = :s AND due_at > :t', {
        a: accountId, s: 'failed', t: new Date(now.getTime() + CONSENT_NOTICE_SEND_MARGIN_MS),
      })
      .execute();
    const requeued = res.affected || 0;
    if (requeued) {
      await this.audit.record({
        accountId,
        campaignId: '',
        entityType: 'consent_notice',
        entityId: '',
        action: 'consent_notice.retry',
        actor,
        summary: `실패한 동의 재확인 안내 ${requeued}통을 다시 보냅니다`,
        detail: { requeued },
      });
      this.audit.notify(accountId, '', 'consent_notice', '', 'retry');
    }
    return requeued;
  }

  /**
   * "응답이 없으면 유지" 로 나간 안내의 기한이 왔다 — 그 사이 철회 · 새 동의(기한이 바뀜) · 미도달이 없으면 동의를 그 기한부터
   * 잇는다. 보낼 때가 아니라 기한에 잇는 것은, 안내 기간 중에 들어온 새 동의가 그것대로 다음 주기를 정하게 하기 위해서다.
   * 기한 1 시간 전부터 이어 발송 대상에서 빠지는 틈이 없게 하고, 서버가 멈춰 지나쳤으면 30 일 안에 뒤늦게 잇는다. 이은 수.
   */
  async renewDue(now: Date = new Date()): Promise<number> {
    const rows = await this.noticeRepo.createQueryBuilder('n')
      .where('n.status = :s', { s: 'sent' })
      .andWhere('n.policy = :p', { p: 'keep' })
      .andWhere("n.brand_id <> '' AND n.consent_id <> ''")
      .andWhere('n.renewed_at IS NULL')
      .andWhere('n.kept_at IS NULL')
      .andWhere("n.bounce_type = ''")
      .andWhere('n.due_at <= :ahead', { ahead: new Date(now.getTime() + RENEW_AHEAD_MS) })
      .andWhere('n.due_at > :since', { since: new Date(now.getTime() - RENEW_LOOKBACK_MS) })
      .orderBy('n.due_at', 'ASC')
      .take(500)
      .getMany();
    let renewed = 0;
    for (const row of rows) {
      const contact = await this.contactRepo.findOne({
        where: { id: row.contact_id, account_id: row.account_id },
        select: ['id', 'status', 'email'],
      });
      if (!contact || contact.status !== 'subscribed' || !contact.email) continue;
      const consent = await this.consentForNotice(row);
      if (!consent || !sameConsentCycle(consentDeadline(consent), row.due_at)) continue;
      const won = await this.dataSource.getRepository(MarketingContactConsent).createQueryBuilder().update(MarketingContactConsent)
        .set({ consent_renewed_at: row.due_at })
        .where('id = :id AND status = :s', { id: consent.id, s: 'subscribed' })
        .andWhere('consent_at = :original', { original: consent.consent_at })
        .andWhere(consent.consent_renewed_at ? 'consent_renewed_at = :renewed' : 'consent_renewed_at IS NULL', { renewed: consent.consent_renewed_at })
        .andWhere("EXISTS (SELECT 1 FROM marketing_contacts c WHERE c.id = :contact AND c.account_id = :account AND c.status = 'subscribed' AND c.email IS NOT NULL)", { contact: contact.id, account: row.account_id })
        .execute();
      await this.noticeRepo.update({ id: row.id }, { renewed_at: now });
      if (won.affected) renewed++;
    }
    return renewed;
  }

  // ── 줄 세우기 · 보내기 ────────────────────────────────────────────────────

  /** 켠 계정마다, 안내 창에 든 연락처의 이번 주기 안내를 넣는다. 넣은 수. */
  async plan(now: Date = new Date()): Promise<number> {
    const enabled = await this.settingsRepo.find({ where: { enabled: true } });
    let queued = 0;
    for (const settings of enabled) {
      try {
        queued += await this.planAccount(settings, now);
      } catch (e: any) {
        this.logService.warn('Marketing', 'consent notice planning failed', { account_id: settings.account_id, err: e?.message || String(e) });
      }
    }
    return queued;
  }

  /**
   * 보내기 한 번(테스트가 직접 부른다). 같은 프로세스에서 겹쳐 돌지 않는다. 기한이 가까운 것부터 보낸다. 한 번에 50 통이고
   * 통마다 공급자 호출이 길 수 있어, 기한 · 야간 판단과 기록 시각은 그 행을 다루는 시각(`now` + 지난 시간)으로 한다.
   */
  async processQueue(now: Date = new Date()): Promise<{ sent: number; deferred: number; failed: number; skipped: number }> {
    const stats = { sent: 0, deferred: 0, failed: 0, skipped: 0 };
    if (this.running) return stats;
    this.running = true;
    const started = Date.now();
    const clock = () => new Date(now.getTime() + Math.max(Date.now() - started, 0));
    try {
      await this.closeStuck(now);
      const due = await this.noticeRepo.find({
        where: { status: In(['queued', 'deferred']), next_attempt_at: LessThanOrEqual(now) },
        order: { due_at: 'ASC' },
        take: BATCH,
      });
      const ctx: SendContext = { settings: new Map(), channels: new Map(), senders: new Map() };
      for (const candidate of due) {
        const t = clock();
        // 다른 서버가 그 사이 이 행을 다뤄 뒤로 미뤘으면(next_attempt_at) 선점하지 않는다 — 재시도 간격을 건너뛰지 않게.
        const claim = await this.noticeRepo.createQueryBuilder().update(MarketingConsentNotice)
          .set({ status: 'sending' })
          .where('id = :id AND status IN (:...s) AND next_attempt_at <= :t', { id: candidate.id, s: ['queued', 'deferred'], t })
          .execute();
        if (!claim.affected) continue;
        const row = await this.noticeRepo.findOne({ where: { id: candidate.id } });
        if (!row) continue;
        let outcome: keyof typeof stats;
        try {
          outcome = await this.sendOne(row, clock, ctx);
        } catch (e: any) {
          // sendOne 은 공급자에 넘긴 뒤에는 던지지 않는다 — 여기 오는 것은 보내기 전의 실패라 미뤄도 두 번 가지 않는다.
          await this.noticeRepo.createQueryBuilder().update(MarketingConsentNotice)
            .set({ status: 'deferred', next_attempt_at: new Date(t.getTime() + RECHECK_MS), error: `deferred: ${String(e?.message || e).slice(0, 300)}` })
            .where('id = :id AND status = :s', { id: row.id, s: 'sending' })
            .execute()
            .catch(() => undefined);
          outcome = 'deferred';
        }
        stats[outcome]++;
      }
    } finally {
      this.running = false;
    }
    return stats;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async subscribedContacts(accountId: string): Promise<MarketingContactConsent[]> {
    const contacts = await this.contactRepo.find({
      where: { account_id: accountId, status: 'subscribed' }, select: ['id', 'email'],
    });
    const ids = contacts.filter((c) => !!c.email).map((c) => c.id);
    const rows: MarketingContactConsent[] = [];
    const brands = new Set((await this.dataSource.getRepository(MarketingBrand).find({
      where: { account_id: accountId }, select: ['id'],
    })).map((b) => b.id));
    for (const part of chunks(ids, IN_CHUNK)) {
      rows.push(...await this.dataSource.getRepository(MarketingContactConsent).find({
        where: { account_id: accountId, contact_id: In(part), status: 'subscribed' },
      }));
    }
    return rows.filter((c) => brands.has(c.brand_id));
  }

  private async existingCycles(consentIds: string[]): Promise<Map<string, Date[]>> {
    const have = new Map<string, Date[]>();
    for (const part of chunks([...new Set(consentIds)], IN_CHUNK)) {
      const rows = await this.noticeRepo.find({ where: { consent_id: In(part) }, select: ['id', 'consent_id', 'due_at'] });
      for (const r of rows) have.set(r.consent_id, [...(have.get(r.consent_id) || []), new Date(r.due_at)]);
    }
    return have;
  }

  private async consentForNotice(row: MarketingConsentNotice): Promise<MarketingContactConsent | null> {
    if (!row.brand_id || !row.consent_id) return null;
    const brand = await this.dataSource.getRepository(MarketingBrand).findOneBy({ id: row.brand_id, account_id: row.account_id });
    if (!brand) return null;
    return this.dataSource.getRepository(MarketingContactConsent).findOneBy({
      id: row.consent_id, account_id: row.account_id, contact_id: row.contact_id, brand_id: row.brand_id, status: 'subscribed',
    });
  }

  async keepBrand(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token || '')) return null;
    const notice = await this.noticeRepo.findOneBy({ token });
    if (!notice || !await this.consentForNotice(notice)) return null;
    return (await this.dataSource.getRepository(MarketingBrand).findOneBy({
      id: notice.brand_id, account_id: notice.account_id,
    }))?.name || null;
  }

  private async planAccount(settings: MarketingConsentNoticeSetting, now: Date): Promise<number> {
    const due: Array<{ contactId: string; consentId: string; brandId: string; dueAt: Date }> = [];
    for (const c of await this.subscribedContacts(settings.account_id)) {
      const dueAt = consentNoticeDueAt(c, settings.lead_days, now);
      if (dueAt) due.push({ contactId: c.contact_id, consentId: c.id, brandId: c.brand_id, dueAt });
    }
    if (!due.length) return 0;
    const have = await this.existingCycles(due.map((d) => d.consentId));
    let queued = 0;
    for (const d of due) {
      if ((have.get(d.consentId) || []).some((at) => sameConsentCycle(at, d.dueAt))) continue;
      try {
        await this.noticeRepo.insert({
          account_id: settings.account_id,
          contact_id: d.contactId,
          consent_id: d.consentId,
          brand_id: d.brandId,
          due_at: d.dueAt,
          status: 'queued',
          attempts: 0,
          next_attempt_at: now,
          token: newNoticeToken(),
        });
        queued++;
      } catch (e) {
        // 다른 서버가 먼저 넣었다 — 유일 인덱스가 한 번을 보장한다. 그 밖의 실패는 던진다.
        const exists = await this.noticeRepo.findOne({ where: { contact_id: d.contactId, brand_id: d.brandId, due_at: d.dueAt }, select: ['id'] });
        if (!exists) throw e;
      }
    }
    return queued;
  }

  private async settingsFor(accountId: string, ctx: SendContext): Promise<MarketingConsentNoticeSetting | null> {
    if (!ctx.settings.has(accountId)) ctx.settings.set(accountId, await this.settingsRow(accountId));
    return ctx.settings.get(accountId) || null;
  }

  /** 안내를 보낼 수 있는 메일 채널 — 승인된(active · paused) 메일 채널, 보관되지 않은 캠페인의 것, 먼저 만든 순. */
  private async candidateChannels(accountId: string): Promise<MarketingChannel[]> {
    if (!accountId) return [];
    const rows = await this.channelRepo.find({
      where: { account_id: accountId, kind: 'email', status: In(['active', 'paused']) },
      order: { created_at: 'ASC' },
    });
    const campaignIds = [...new Set(rows.map((c) => c.campaign_id))];
    if (!campaignIds.length) return [];
    const campaigns = await this.campaignRepo.find({ where: { id: In(campaignIds) }, select: ['id', 'status'] });
    const live = new Set(campaigns.filter((c) => c.status !== 'archived').map((c) => c.id));
    return rows.filter((c) => live.has(c.campaign_id));
  }

  /**
   * 같은 브랜드 안에서 그 사람에게 보낼 발신자 — 그 사람이 마지막으로 마케팅 메일을 받은 채널(지금도 쓸 수 있으면), 없으면 그 사람의 목록을 쓰는
   * 채널. 동의를 받은 그 발신자의 이름으로 알리기 위해서다(법정 항목 "전송자의 명칭").
   */
  private async senderForContact(contact: MarketingContact, brandId: string, ctx: SendContext): Promise<{ channel: MarketingChannel; sender: ChannelSender } | null> {
    if (!ctx.channels.has(contact.account_id)) ctx.channels.set(contact.account_id, await this.candidateChannels(contact.account_id));
    const channels = (ctx.channels.get(contact.account_id) || []).filter((c) => c.config?.brand_id === brandId);
    if (!channels.length) return null;
    const ordered: MarketingChannel[] = [];
    const last = await this.sendRepo.findOne({ where: { contact_id: contact.id, account_id: contact.account_id, brand_id: brandId, status: 'sent' }, order: { sent_at: 'DESC' }, select: ['id', 'channel_id'] });
    const lastChannel = last ? channels.find((c) => c.id === last.channel_id) : undefined;
    if (lastChannel) ordered.push(lastChannel);
    const lists = new Set(contact.lists || []);
    for (const c of channels) {
      if (c !== lastChannel && lists.has(String(c.config?.list_name || ''))) ordered.push(c);
    }
    for (const channel of ordered) {
      if (!ctx.senders.has(channel.id)) ctx.senders.set(channel.id, await this.email.senderFor(channel).catch(() => null));
      const sender = ctx.senders.get(channel.id);
      if (sender) return { channel, sender };
    }
    return null;
  }

  private async sendOne(row: MarketingConsentNotice, clock: () => Date, ctx: SendContext): Promise<'sent' | 'deferred' | 'failed' | 'skipped'> {
    const finish = async (status: string, extra: Partial<MarketingConsentNotice>) => {
      await this.noticeRepo.update({ id: row.id }, { status, ...extra });
    };
    const defer = async (at: Date, error: string) => {
      await finish('deferred', { next_attempt_at: at, error });
      return 'deferred' as const;
    };
    const skip = async (error: string) => {
      await finish('skipped', { error });
      return 'skipped' as const;
    };
    const t = clock();
    const contact = await this.contactRepo.findOne({ where: { id: row.contact_id } });
    if (!contact || contact.account_id !== row.account_id || contact.status !== 'subscribed' || !contact.email) return skip(`contact is ${contact?.status || 'gone'}`);
    const consent = await this.consentForNotice(row);
    if (!consent) return skip('brand consent is absent or withdrawn');
    const dueAt = new Date(row.due_at);
    // 그 사이 새 동의(가져오기 · 유지 링크)로 기한이 바뀌었으면 이 주기의 안내는 필요 없다.
    if (!sameConsentCycle(consentDeadline(consent), dueAt)) return skip('the consent was renewed meanwhile — this notice is no longer needed');
    // 기한이 지난 동의는 안내로 되살리지 않는다 — 동의를 다시 묻는 메일은 그 자체가 광고성 정보다.
    const lastSend = dueAt.getTime() - CONSENT_NOTICE_SEND_MARGIN_MS;
    if (t.getTime() >= lastSend) return skip('the deadline passed before the notice could be sent — the consent has lapsed');
    const settings = await this.settingsFor(row.account_id, ctx);
    if (!settings?.enabled) return defer(new Date(t.getTime() + RECHECK_MS), 'deferred: consent notices are turned off for this account');
    const tz = contact.timezone || 'Asia/Seoul';
    if (isNightFor(t, tz)) {
      // 광고가 아니어서 야간 제한 대상은 아니지만 아침에 보낸다 — 그러다 기한을 넘기게 되면 지금 보낸다.
      const morning = nextSendableAt(t, tz);
      if (morning.getTime() < lastSend) return defer(morning, 'deferred: night hours in the recipient\'s timezone');
    }
    const pick = await this.senderForContact(contact, row.brand_id, ctx);
    if (!pick) {
      return defer(
        new Date(Math.min(t.getTime() + RECHECK_MS, lastSend)),
        `${NO_SENDER_PREFIX} sends to this contact's lists — approve an email channel for one of them`,
      );
    }
    let keepUrl: string;
    let unsubscribeUrl: string;
    try {
      keepUrl = consentKeepUrlFor(row.token);
      unsubscribeUrl = unsubscribeUrlFor(consent.unsubscribe_token);
    } catch (e: any) {
      return defer(new Date(t.getTime() + RECHECK_MS), `deferred: ${e?.message || e}`);
    }
    const policy: ConsentNoticePolicy = settings.on_no_response === 'lapse' ? 'lapse' : 'keep';

    // ── 여기서 공급자에 넘긴다. 이 뒤로는 던지지 않는다 — 받았을 수 있는 메일을 미뤄 다시 보내는 일이 없게. ──
    let outcome: EmailOutcome;
    try {
      const message = composeConsentNotice({
        sender: pick.sender.sender,
        subject: settings.subject,
        body: settings.body,
        policy,
        contact: { name: contact.name, email: contact.email, consent_at: consent.consent_at, timezone: tz },
        dueAt,
        keepUrl,
        unsubscribeUrl,
      });
      outcome = await sendEmail({
        provider: pick.sender.provider,
        apiKey: pick.sender.apiKey,
        sender: pick.sender.sender,
        to: { email: contact.email, name: contact.name },
        message,
        idempotencyKey: row.id,
        // 공급자가 이 안내의 바운스 · 신고에 이 id 를 돌려준다(MarketingEmailEventsService 가 안내 행으로 잇는다).
        tags: { [SEND_ID_TAG]: row.id },
        fetchImpl: this.fetchImpl,
      });
    } catch (e: any) {
      outcome = { outcome: 'failed', error: String(e?.message || e).slice(0, 500) };
    }
    const meta: Partial<MarketingConsentNotice> = {
      channel_id: pick.channel.id,
      credential_id: pick.sender.credentialId,
      policy,
      settings_version: settings.version,
      attempts: row.attempts + 1,
    };
    // 결과를 못 쓰면 행은 'sending' 으로 남고 closeStuck 이 failed("닿았을 수 있음")로 닫는다 — 다시 보내지 않는다.
    const record = async (status: string, extra: Partial<MarketingConsentNotice>) => {
      try {
        await finish(status, { ...meta, ...extra });
      } catch (e: any) {
        this.logService.error('Marketing', 'consent notice result could not be recorded', { notice_id: row.id, status, err: e?.message || String(e) });
      }
    };
    if (outcome.outcome === 'sent') {
      await record('sent', { sent_at: clock(), provider_message_id: outcome.message_id, error: '' });
      return 'sent';
    }
    if (outcome.outcome === 'retry' && row.attempts + 1 < MAX_ATTEMPTS) {
      const at = Math.min(t.getTime() + RETRY_MS * (row.attempts + 1), lastSend);
      await record('deferred', { next_attempt_at: new Date(at), error: outcome.error });
      return 'deferred';
    }
    await record('failed', { error: outcome.error });
    return 'failed';
  }

  private async closeStuck(now: Date): Promise<void> {
    const stuck = await this.noticeRepo.find({
      where: { status: 'sending', updated_at: LessThan(new Date(now.getTime() - STUCK_SENDING_MS)) },
      take: 500,
    });
    for (const row of stuck) {
      await this.noticeRepo.update({ id: row.id, status: 'sending' }, { status: 'failed', error: 'interrupted while sending — not retried (it may have been delivered)' });
    }
  }
}

