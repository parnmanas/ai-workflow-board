import { randomBytes } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import { MarketingConsentNotice } from '../../entities/MarketingConsentNotice';
import { MarketingConsentNoticeSetting } from '../../entities/MarketingConsentNoticeSetting';
import { MarketingContact } from '../../entities/MarketingContact';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingEmailSend } from '../../entities/MarketingEmailSend';
import { consentDeadline, consentFresh, isNightFor, nextSendableAt, type EmailSender } from '../../common/marketing/email';
import {
  CONSENT_KEEP_GRACE_MS,
  DEFAULT_CONSENT_NOTICE_SETTINGS,
  RECONFIRM_CONSENT_METHOD,
  composeConsentNotice,
  consentNoticeDueAt,
  sampleConsentNoticeContact,
  validateConsentNoticeSettings,
  type ConsentNoticeSettingsValue,
} from '../../common/marketing/consent-notice';
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
/** 줄 세우기(연락처 전체를 훑는다)는 이 간격으로만 — 보내기는 매 tick. */
const PLAN_EVERY_MS = 10 * 60_000;
const BATCH = 50;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 10 * 60_000;
/** 'sending' 으로 이만큼 남은 행은 프로세스가 결과를 기록하지 못한 것이다 — 다시 보내지 않고 failed 로 닫는다. */
const STUCK_SENDING_MS = 10 * 60_000;
/** 발신 채널이 없거나 안내가 꺼진 동안 미룬 행을 다시 볼 간격. */
const RECHECK_MS = 60 * 60_000;
const RECENT_MS = 30 * 24 * 60 * 60_000;
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

function cycleKey(contactId: string, dueAt: Date | string): string {
  return `${contactId}\n${new Date(dueAt).getTime()}`;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ConsentNoticeCounts {
  /** 지금 안내 창(기한 lead_days 일 전 ~ 기한) 안의 연락처. */
  in_window: number;
  /** 그중 아직 안내 행이 없는 것 — 다음 줄 세우기가 넣는다. */
  not_yet_queued: number;
  /** 보내기를 기다리는 안내(queued · deferred · sending). */
  waiting: number;
  /** 그중 발신 채널이 없어 미룬 것. */
  waiting_no_sender: number;
  sent_30d: number;
  failed_30d: number;
  skipped_30d: number;
  kept_30d: number;
  /** 기한이 이미 지나 안내로 이을 수 없는 연락처(새 동의가 있어야 다시 보낸다). */
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
 * 1. 줄 세우기: 안내를 켠 계정의 subscribed 연락처 가운데 동의 기한이 `lead_days` 일 안으로 들어온 사람마다 (연락처, 기한)
 *    한 행을 넣는다(유일 인덱스 — 서버가 둘이어도 한 번).
 * 2. 보내기: 보내기 직전에 다시 본다 — 그 사이 수신거부 · 새 동의(기한이 바뀜) · 기한 지남이면 보내지 않는다(skipped).
 *    발신자는 그 사람에게 메일을 보내는 채널이다(최근 받은 메일의 채널, 없으면 그 사람의 목록을 쓰는 채널). 수신자 현지
 *    야간이면 아침까지 미룬다(기한을 넘기게 되면 미루지 않는다). 일시 오류는 3 번까지 다시 시도한다.
 * 3. 보낸 뒤: 무응답이면 유지(`keep`)로 안내했으면 그 주기의 기한부터 다시 2 년(`consent_renewed_at`). `lapse` 면 그대로 —
 *    받은 사람이 유지 링크를 누르지 않으면 기한에 발송에서 빠진다.
 * 4. 유지 링크(POST): 새 동의 — `consent_at` 이 그 시각, method `reconfirm`, 2 년을 그때부터 다시 센다.
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
      sent_30d: 0, failed_30d: 0, skipped_30d: 0, kept_30d: 0, expired: 0,
    };
    if (!accountId) return { row, settings, counts };
    const contacts = await this.subscribedContacts(accountId);
    const due: Array<{ contactId: string; dueAt: Date }> = [];
    for (const c of contacts) {
      if (!consentFresh(c, now)) {
        counts.expired++;
        continue;
      }
      const dueAt = consentNoticeDueAt(c, settings.lead_days, now);
      if (dueAt) due.push({ contactId: c.id, dueAt });
    }
    counts.in_window = due.length;
    const have = await this.existingCycles(due);
    counts.not_yet_queued = due.filter((d) => !have.has(cycleKey(d.contactId, d.dueAt))).length;
    const since = new Date(now.getTime() - RECENT_MS);
    const base = () => this.noticeRepo.createQueryBuilder('n').where('n.account_id = :a', { a: accountId });
    [counts.waiting, counts.waiting_no_sender, counts.sent_30d, counts.failed_30d, counts.skipped_30d, counts.kept_30d] = await Promise.all([
      base().andWhere('n.status IN (:...s)', { s: ['queued', 'deferred', 'sending'] }).getCount(),
      base().andWhere('n.status IN (:...s)', { s: ['queued', 'deferred'] }).andWhere('n.error LIKE :p', { p: `${NO_SENDER_PREFIX}%` }).getCount(),
      base().andWhere('n.status = :s', { s: 'sent' }).andWhere('n.sent_at >= :since', { since }).getCount(),
      base().andWhere('n.status = :s', { s: 'failed' }).andWhere('n.updated_at >= :since', { since }).getCount(),
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
  async latestFor(accountId: string, contactIds: string[]): Promise<Map<string, MarketingConsentNotice>> {
    const out = new Map<string, MarketingConsentNotice>();
    const ids = [...new Set(contactIds.filter(Boolean))];
    if (!accountId || !ids.length) return out;
    for (const part of chunks(ids, IN_CHUNK)) {
      const rows = await this.noticeRepo.find({
        where: { account_id: accountId, contact_id: In(part) },
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
   * 눌러도 한 번이다. 보낸 안내의 링크만, 기한 뒤 30 일까지만 받고, 수신거부 · 바운스 · 삭제된 연락처는 되살리지 않는다.
   */
  async keep(token: string, now: Date = new Date()): Promise<{ kept: boolean; at: Date | null }> {
    const refused = { kept: false, at: null };
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token || '')) return refused;
    const notice = await this.noticeRepo.findOne({ where: { token } });
    if (!notice || notice.status !== 'sent') return refused;
    if (notice.kept_at) return { kept: true, at: notice.kept_at };
    if (now.getTime() > new Date(notice.due_at).getTime() + CONSENT_KEEP_GRACE_MS) return refused;
    const contact = await this.contactRepo.findOne({ where: { id: notice.contact_id } });
    if (!contact || contact.account_id !== notice.account_id || contact.status !== 'subscribed' || !contact.email) return refused;
    const updated = await this.contactRepo.createQueryBuilder().update(MarketingContact)
      .set({
        consent_at: now,
        consent_method: RECONFIRM_CONSENT_METHOD,
        consent_source: `consent-notice:${notice.id}`,
        consent_text_version: `consent-notice-v${notice.settings_version}`,
        // 공개 경로라 IP 원문은 남기지 않는다(docs/marketing.md "원칙").
        consent_ip: '',
        consent_renewed_at: null,
      })
      .where('id = :id AND status = :s', { id: contact.id, s: 'subscribed' })
      .execute();
    if (!updated.affected) return refused;
    const won = await this.noticeRepo.createQueryBuilder().update(MarketingConsentNotice)
      .set({ kept_at: now })
      .where('id = :id AND kept_at IS NULL', { id: notice.id })
      .execute();
    if (!won.affected) return { kept: true, at: (await this.noticeRepo.findOne({ where: { id: notice.id } }))?.kept_at || now };
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
        due_at: new Date(notice.due_at).toISOString(),
        previous: {
          consent_method: contact.consent_method,
          consent_source: contact.consent_source,
          consent_at: new Date(contact.consent_at).toISOString(),
          consent_text_version: contact.consent_text_version,
          consent_renewed_at: contact.consent_renewed_at ? new Date(contact.consent_renewed_at).toISOString() : null,
        },
      },
    });
    this.audit.notify(contact.account_id, '', 'contact', contact.id, 'consent_kept');
    return { kept: true, at: now };
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

  /** 보내기 한 번(테스트가 직접 부른다). 같은 프로세스에서 겹쳐 돌지 않는다. */
  async processQueue(now: Date = new Date()): Promise<{ sent: number; deferred: number; failed: number; skipped: number }> {
    const stats = { sent: 0, deferred: 0, failed: 0, skipped: 0 };
    if (this.running) return stats;
    this.running = true;
    try {
      await this.closeStuck(now);
      const due = await this.noticeRepo.find({
        where: { status: In(['queued', 'deferred']), next_attempt_at: LessThanOrEqual(now) },
        order: { next_attempt_at: 'ASC' },
        take: BATCH,
      });
      const ctx: SendContext = { settings: new Map(), channels: new Map(), senders: new Map() };
      for (const row of due) {
        const claim = await this.noticeRepo.createQueryBuilder().update(MarketingConsentNotice)
          .set({ status: 'sending' })
          .where('id = :id AND status IN (:...s)', { id: row.id, s: ['queued', 'deferred'] })
          .execute();
        if (!claim.affected) continue;
        let outcome: keyof typeof stats;
        try {
          outcome = await this.sendOne(row, now, ctx);
        } catch (e: any) {
          await this.noticeRepo.update({ id: row.id }, {
            status: 'deferred', next_attempt_at: new Date(now.getTime() + RECHECK_MS), error: `deferred: ${String(e?.message || e).slice(0, 300)}`,
          });
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

  private async subscribedContacts(accountId: string): Promise<MarketingContact[]> {
    const rows = await this.contactRepo.find({
      where: { account_id: accountId, status: 'subscribed' },
      select: ['id', 'email', 'consent_at', 'consent_renewed_at'],
    });
    return rows.filter((c) => !!c.email);
  }

  /** 이미 있는 (연락처, 기한) 안내. */
  private async existingCycles(due: Array<{ contactId: string; dueAt: Date }>): Promise<Set<string>> {
    const have = new Set<string>();
    const ids = [...new Set(due.map((d) => d.contactId))];
    for (const part of chunks(ids, IN_CHUNK)) {
      const rows = await this.noticeRepo.find({ where: { contact_id: In(part) }, select: ['id', 'contact_id', 'due_at'] });
      for (const r of rows) have.add(cycleKey(r.contact_id, r.due_at));
    }
    return have;
  }

  private async planAccount(settings: MarketingConsentNoticeSetting, now: Date): Promise<number> {
    const due: Array<{ contactId: string; dueAt: Date }> = [];
    for (const c of await this.subscribedContacts(settings.account_id)) {
      const dueAt = consentNoticeDueAt(c, settings.lead_days, now);
      if (dueAt) due.push({ contactId: c.id, dueAt });
    }
    if (!due.length) return 0;
    const have = await this.existingCycles(due);
    let queued = 0;
    for (const d of due) {
      if (have.has(cycleKey(d.contactId, d.dueAt))) continue;
      try {
        await this.noticeRepo.insert({
          account_id: settings.account_id,
          contact_id: d.contactId,
          due_at: d.dueAt,
          status: 'queued',
          attempts: 0,
          next_attempt_at: now,
          token: newNoticeToken(),
        });
        queued++;
      } catch (e) {
        // 다른 서버가 먼저 넣었다 — 유일 인덱스가 한 번을 보장한다. 그 밖의 실패는 던진다.
        const exists = await this.noticeRepo.findOne({ where: { contact_id: d.contactId, due_at: d.dueAt }, select: ['id'] });
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
   * 그 사람에게 보낼 발신자 — 그 사람이 마지막으로 마케팅 메일을 받은 채널(지금도 쓸 수 있으면), 없으면 그 사람의 목록을 쓰는
   * 채널. 동의를 받은 그 발신자의 이름으로 알리기 위해서다(법정 항목 "전송자의 명칭").
   */
  private async senderForContact(contact: MarketingContact, ctx: SendContext): Promise<{ channel: MarketingChannel; sender: ChannelSender } | null> {
    if (!ctx.channels.has(contact.account_id)) ctx.channels.set(contact.account_id, await this.candidateChannels(contact.account_id));
    const channels = ctx.channels.get(contact.account_id) || [];
    if (!channels.length) return null;
    const ordered: MarketingChannel[] = [];
    const last = await this.sendRepo.findOne({ where: { contact_id: contact.id, status: 'sent' }, order: { sent_at: 'DESC' }, select: ['id', 'channel_id'] });
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

  private async sendOne(row: MarketingConsentNotice, now: Date, ctx: SendContext): Promise<'sent' | 'deferred' | 'failed' | 'skipped'> {
    const finish = async (status: string, extra: Partial<MarketingConsentNotice>) => {
      await this.noticeRepo.update({ id: row.id }, { status, ...extra });
    };
    const defer = async (at: Date, error: string, extra: Partial<MarketingConsentNotice> = {}) => {
      await finish('deferred', { next_attempt_at: at, error, ...extra });
      return 'deferred' as const;
    };
    const skip = async (error: string) => {
      await finish('skipped', { error });
      return 'skipped' as const;
    };
    const contact = await this.contactRepo.findOne({ where: { id: row.contact_id } });
    if (!contact || contact.status !== 'subscribed' || !contact.email) return skip(`contact is ${contact?.status || 'gone'}`);
    const dueAt = new Date(row.due_at);
    // 그 사이 새 동의(가져오기 · 유지 링크)로 기한이 바뀌었으면 이 주기의 안내는 필요 없다.
    if (consentDeadline(contact).getTime() !== dueAt.getTime()) return skip('the consent was renewed meanwhile — this notice is no longer needed');
    // 기한이 지난 동의는 안내로 되살리지 않는다 — 동의를 다시 묻는 메일은 그 자체가 광고성 정보다.
    if (now.getTime() >= dueAt.getTime()) return skip('the deadline passed before the notice could be sent — the consent has lapsed');
    const settings = await this.settingsFor(row.account_id, ctx);
    if (!settings?.enabled) return defer(new Date(now.getTime() + RECHECK_MS), 'deferred: consent notices are turned off for this account');
    const tz = contact.timezone || 'Asia/Seoul';
    if (isNightFor(now, tz)) {
      // 광고가 아니어서 야간 제한 대상은 아니지만 아침에 보낸다 — 그러다 기한을 넘기게 되면 지금 보낸다.
      const morning = nextSendableAt(now, tz);
      if (morning.getTime() < dueAt.getTime()) return defer(morning, 'deferred: night hours in the recipient\'s timezone');
    }
    const pick = await this.senderForContact(contact, ctx);
    if (!pick) {
      return defer(
        new Date(Math.min(now.getTime() + RECHECK_MS, dueAt.getTime())),
        `${NO_SENDER_PREFIX} sends to this contact's lists — approve an email channel for one of them`,
      );
    }
    let keepUrl: string;
    let unsubscribeUrl: string;
    try {
      keepUrl = consentKeepUrlFor(row.token);
      unsubscribeUrl = unsubscribeUrlFor(contact.unsubscribe_token);
    } catch (e: any) {
      return defer(new Date(now.getTime() + RECHECK_MS), `deferred: ${e?.message || e}`);
    }
    const policy: ConsentNoticePolicy = settings.on_no_response === 'lapse' ? 'lapse' : 'keep';
    let outcome: EmailOutcome;
    try {
      const message = composeConsentNotice({
        sender: pick.sender.sender,
        subject: settings.subject,
        body: settings.body,
        policy,
        contact: { name: contact.name, email: contact.email, consent_at: contact.consent_at, timezone: tz },
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
    if (outcome.outcome === 'sent') {
      await finish('sent', { ...meta, sent_at: now, provider_message_id: outcome.message_id, error: '' });
      if (policy === 'keep') await this.renew(contact, dueAt);
      return 'sent';
    }
    if (outcome.outcome === 'retry' && row.attempts + 1 < MAX_ATTEMPTS) {
      const at = new Date(Math.min(now.getTime() + RETRY_MS * (row.attempts + 1), dueAt.getTime()));
      return defer(at, outcome.error, meta);
    }
    await finish('failed', { ...meta, error: outcome.error });
    return 'failed';
  }

  /**
   * "응답이 없으면 유지" 로 안내했다 — 동의는 이 주기의 기한부터 다시 2 년이다. 기산일은 원래 동의일이라 안내를 보낸 날이
   * 아니라 기한을 넣는다. 그 사이 수신거부했으면 바꾸지 않는다.
   */
  private async renew(contact: MarketingContact, dueAt: Date): Promise<void> {
    await this.contactRepo.createQueryBuilder().update(MarketingContact)
      .set({ consent_renewed_at: dueAt })
      .where('id = :id AND status = :s', { id: contact.id, s: 'subscribed' })
      .andWhere('(consent_renewed_at IS NULL OR consent_renewed_at < :due)', { due: dueAt })
      .execute();
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

