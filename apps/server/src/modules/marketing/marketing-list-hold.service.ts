import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MarketingListHold } from '../../entities/MarketingListHold';
import { MarketingEmailSend } from '../../entities/MarketingEmailSend';
import { MarketingChannel } from '../../entities/MarketingChannel';
import {
  COMPLAINT_HOLD_MIN,
  COMPLAINT_HOLD_RATE,
  COMPLAINT_WINDOW_MS,
  complaintRate,
  shouldHoldList,
  type ListMailStats,
} from '../../common/marketing/email';
import { SYSTEM_MARKETING_ACTOR, type MarketingActor } from '../../common/marketing/marketing-constants';
import { MarketingAuditService } from './marketing-audit.service';
import { marketingError } from './marketing-errors';

/** 멈춘 목록 때문에 보류한 발송 행의 error 앞머리 — 해제할 때 이것으로 찾아 바로 다시 보낸다. */
export const LIST_HOLD_DEFER_PREFIX = 'deferred: the list is on hold';

function percent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/**
 * MarketingListHoldService — 스팸 신고율이 높은 수신 목록의 발송 중지(docs/marketing.md "목록 발송 중지").
 *
 * 신고가 하나 들어올 때마다 그 목록의 기간 수치를 다시 센다: 같은 계정에서 그 목록을 쓰는 모든 메일 채널(캠페인 무관)이
 * 기간(30 일, 해제했으면 해제 이후)에 보낸 메일 · 그중 닿지 않은 것 · 그중 신고된 것. 기준(`shouldHoldList`)을 넘으면
 * 멈춘다. 멈춘 목록은 발송 큐가 보류하고(MarketingEmailService) 새 메일 승인이 거부된다. 해제는 사람만, 사유와 함께.
 */
@Injectable()
export class MarketingListHoldService {
  constructor(
    @InjectRepository(MarketingListHold) private readonly holdRepo: Repository<MarketingListHold>,
    @InjectRepository(MarketingEmailSend) private readonly sendRepo: Repository<MarketingEmailSend>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    private readonly audit: MarketingAuditService,
  ) {}

  async active(accountId: string, listName: string): Promise<MarketingListHold | null> {
    if (!accountId || !listName) return null;
    return this.holdRepo.findOne({ where: { account_id: accountId, list_name: listName, status: 'held' } });
  }

  /** 여러 목록의 지금 멈춤을 한 번에(목록 이름 → 멈춤). */
  async activeFor(accountId: string, listNames: string[]): Promise<Map<string, MarketingListHold>> {
    const names = [...new Set(listNames.filter(Boolean))];
    if (!accountId || !names.length) return new Map();
    const rows = await this.holdRepo.find({ where: { account_id: accountId, status: 'held', list_name: In(names) } });
    return new Map(rows.map((r) => [r.list_name, r]));
  }

  async list(accountId: string, opts: { list?: string; status?: string; limit?: number } = {}): Promise<MarketingListHold[]> {
    return this.holdRepo.find({
      where: {
        account_id: accountId,
        ...(opts.list ? { list_name: opts.list.trim().toLowerCase() } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(opts.limit || 50, 1), 200),
    });
  }

  async get(id: string, accountId: string): Promise<MarketingListHold> {
    const row = id ? await this.holdRepo.findOne({ where: { id } }) : null;
    if (!row || !accountId || row.account_id !== accountId) throw marketingError(404, 'list hold not found');
    return row;
  }

  /** 계정에서 그 목록으로 보내는 메일 채널(모든 캠페인). */
  async channelsOf(accountId: string, listName: string): Promise<MarketingChannel[]> {
    const rows = await this.channelRepo.find({ where: { account_id: accountId, kind: 'email' } });
    return rows.filter((c) => String(c.config?.list_name || '') === listName);
  }

  /** 기간 수치 — 기간은 30 일, 그 안에 해제한 적이 있으면 해제 시각부터. */
  async stats(accountId: string, listName: string, now: Date = new Date()): Promise<{ since: Date; channels: MarketingChannel[]; stats: ListMailStats }> {
    let since = new Date(now.getTime() - COMPLAINT_WINDOW_MS);
    const released = await this.holdRepo.findOne({
      where: { account_id: accountId, list_name: listName, status: 'released' },
      order: { released_at: 'DESC' },
    });
    if (released?.released_at && new Date(released.released_at).getTime() > since.getTime()) since = new Date(released.released_at);
    const channels = await this.channelsOf(accountId, listName);
    const stats: ListMailStats = { sent: 0, bounced: 0, complained: 0 };
    if (!channels.length) return { since, channels, stats };
    const base = () => this.sendRepo.createQueryBuilder('s')
      .where('s.channel_id IN (:...ids)', { ids: channels.map((c) => c.id) })
      .andWhere('s.status = :sent', { sent: 'sent' })
      .andWhere('s.sent_at >= :since', { since });
    [stats.sent, stats.bounced, stats.complained] = await Promise.all([
      base().getCount(),
      base().andWhere('s.bounced_at IS NOT NULL').getCount(),
      base().andWhere('s.complained_at IS NOT NULL').getCount(),
    ]);
    return { since, channels, stats };
  }

  /**
   * 스팸 신고가 새로 기록된 뒤 부른다. 기준을 넘으면 목록을 멈추고 그 목록을 쓰는 캠페인마다 감사에 남긴다.
   * 이미 멈춰 있으면 그것을 돌려준다. 동시에 둘이 멈추려 하면 유일 인덱스가 하나만 남긴다.
   */
  async evaluate(accountId: string, listName: string, now: Date = new Date()): Promise<MarketingListHold | null> {
    if (!accountId || !listName) return null;
    const existing = await this.active(accountId, listName);
    if (existing) return existing;
    const { since, channels, stats } = await this.stats(accountId, listName, now);
    if (!shouldHoldList(stats)) return null;
    const rate = complaintRate(stats);
    let hold: MarketingListHold;
    try {
      hold = await this.holdRepo.save(this.holdRepo.create({
        account_id: accountId,
        list_name: listName,
        status: 'held',
        reason: 'complaint_rate',
        stats: { since: since.toISOString(), ...stats, rate, threshold: COMPLAINT_HOLD_RATE, min_complaints: COMPLAINT_HOLD_MIN },
      }));
    } catch {
      return this.active(accountId, listName);
    }
    const delivered = Math.max(stats.sent - stats.bounced, 0);
    const campaignIds = [...new Set(channels.map((c) => c.campaign_id))];
    for (const campaignId of campaignIds.length ? campaignIds : ['']) {
      await this.audit.record({
        accountId,
        campaignId,
        entityType: 'list',
        entityId: hold.id,
        action: 'list.held',
        actor: SYSTEM_MARKETING_ACTOR,
        summary: `메일 목록 "${listName}" 발송 중지 — 스팸 신고율 ${percent(rate)}(신고 ${stats.complained} / 닿은 메일 ${delivered}, 기준 ${percent(COMPLAINT_HOLD_RATE)}). 사람이 확인하고 해제할 때까지 이 목록으로 메일이 나가지 않습니다.`,
        detail: { list: listName, since: since.toISOString(), ...stats, rate },
      });
      this.audit.notify(accountId, campaignId, 'list', hold.id, 'held');
    }
    return hold;
  }

  /** 사람이 해제한다 — 무엇을 고쳤는지 사유가 필요하다. 보류해 둔 메일은 바로 다시 본다. */
  async release(id: string, accountId: string, actor: MarketingActor, noteRaw: unknown): Promise<MarketingListHold> {
    const note = typeof noteRaw === 'string' ? noteRaw.trim().slice(0, 1000) : '';
    if (!note) throw marketingError(400, 'note is required — what was checked or fixed before mailing this list again');
    const hold = await this.get(id, accountId);
    const releasedAt = new Date();
    const won = await this.holdRepo.createQueryBuilder().update(MarketingListHold)
      .set({ status: 'released', released_by: actor.id, released_by_name: actor.name, released_at: releasedAt, release_note: note })
      .where('id = :id AND status = :s', { id: hold.id, s: 'held' })
      .execute();
    if (!won.affected) throw marketingError(409, `the hold is already ${hold.status}`);
    const channels = await this.channelsOf(accountId, hold.list_name);
    if (channels.length) {
      await this.sendRepo.createQueryBuilder().update(MarketingEmailSend)
        .set({ next_attempt_at: releasedAt })
        .where('channel_id IN (:...ids)', { ids: channels.map((c) => c.id) })
        .andWhere('status = :s', { s: 'deferred' })
        .andWhere('error LIKE :prefix', { prefix: `${LIST_HOLD_DEFER_PREFIX}%` })
        .execute();
    }
    const campaignIds = [...new Set(channels.map((c) => c.campaign_id))];
    for (const campaignId of campaignIds.length ? campaignIds : ['']) {
      await this.audit.record({
        accountId,
        campaignId,
        entityType: 'list',
        entityId: hold.id,
        action: 'list.released',
        actor,
        summary: `메일 목록 "${hold.list_name}" 발송 재개`,
        detail: { list: hold.list_name, note },
      });
      this.audit.notify(accountId, campaignId, 'list', hold.id, 'released');
    }
    return this.get(hold.id, accountId);
  }
}
