import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, MoreThan, Repository } from 'typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingBudgetAllocation } from '../../entities/MarketingBudgetAllocation';
import { MarketingLedgerEntry } from '../../entities/MarketingLedgerEntry';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingSpendRequest } from '../../entities/MarketingSpendRequest';
import { budgetSnapshot, periodBounds, usageOf } from '../../common/marketing/budget';
import { formatMinorAmount, parseMinorAmount, MarketingMoneyError } from '../../common/marketing/money';
import type { MarketingActor } from '../../common/marketing/marketing-constants';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { marketingError } from './marketing-errors';
import { lockCampaign } from './marketing-ledger';

const MAX_ALLOCATIONS_PER_PROPOSAL = 20;

/**
 * MarketingBudgetService — 채널별 예산 편성과 예산 요약(docs/marketing.md "예산 편성").
 *
 * 편성은 에이전트(또는 사람)가 제안하고 marketing.approve_spend 가 승인한다. 승인은 지출 승인과 같은
 * 캠페인 잠금 안에서 "active 편성 합 ≤ 기간 상한(없으면 총 상한)" 을 검사한다. 같은 채널에 새 제안이 들어오면
 * 아직 결정되지 않은 이전 제안은 superseded 로 정리된다 — 사람에게 낡은 계획이 쌓이지 않게.
 */
@Injectable()
export class MarketingBudgetService {
  constructor(
    @InjectRepository(MarketingBudgetAllocation) private readonly allocationRepo: Repository<MarketingBudgetAllocation>,
    @InjectRepository(MarketingLedgerEntry) private readonly ledgerRepo: Repository<MarketingLedgerEntry>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingSpendRequest) private readonly spendRepo: Repository<MarketingSpendRequest>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: MarketingAuditService,
    hooks: MarketingCampaignHooks,
  ) {
    hooks.onDeletionCheck(async (campaign) => {
      const ledger = await this.ledgerRepo.count({ where: { campaign_id: campaign.id } });
      if (ledger) return 'the campaign has payment ledger entries';
      const requests = await this.spendRepo.count({ where: { campaign_id: campaign.id } });
      return requests ? 'the campaign has spend requests' : null;
    });
    hooks.onCurrencyChangeCheck(async (campaign) => {
      const ledger = await this.ledgerRepo.count({ where: { campaign_id: campaign.id } });
      const live = await this.spendRepo.count({ where: { campaign_id: campaign.id, status: In(['pending', 'approved', 'executing', 'unknown']) } });
      return ledger || live ? 'the currency is fixed once money has been requested or moved' : null;
    });
    hooks.onDeleteChildren(async (campaign, manager) => {
      await manager.getRepository(MarketingBudgetAllocation).delete({ campaign_id: campaign.id });
    });
  }

  async listAllocations(campaign: MarketingCampaign): Promise<MarketingBudgetAllocation[]> {
    return this.allocationRepo.find({ where: { campaign_id: campaign.id }, order: { created_at: 'DESC' }, take: 200 });
  }

  async getAllocation(id: string, accountId: string): Promise<MarketingBudgetAllocation> {
    const row = id ? await this.allocationRepo.findOne({ where: { id } }) : null;
    if (!row || (!accountId || row.account_id !== accountId)) throw marketingError(404, 'allocation not found');
    return row;
  }

  /** 최근 에이전트 편성 제안 수(채널 수가 아니라 제안 묶음 수). */
  async countProposedSince(campaignId: string, since: Date): Promise<number> {
    const rows = await this.allocationRepo.find({
      where: { campaign_id: campaignId, proposed_by_type: 'agent', created_at: MoreThan(since) },
      select: ['batch_id'],
    });
    return new Set(rows.map((r) => r.batch_id)).size;
  }

  async listLedger(campaign: MarketingCampaign, limit = 200): Promise<MarketingLedgerEntry[]> {
    return this.ledgerRepo.find({ where: { campaign_id: campaign.id }, order: { created_at: 'DESC' }, take: Math.min(Math.max(limit, 1), 1000) });
  }

  /** 예산 요약 — 화면 · get_marketing_campaign · 사이클 지시문이 같은 숫자를 본다. */
  async summary(campaign: MarketingCampaign, now: Date = new Date()) {
    const [ledger, channels, active, pending] = await Promise.all([
      this.ledgerRepo.find({ where: { campaign_id: campaign.id } }),
      this.channelRepo.find({ where: { campaign_id: campaign.id }, order: { created_at: 'ASC' } }),
      this.allocationRepo.find({ where: { campaign_id: campaign.id, status: 'active' } }),
      this.allocationRepo.count({ where: { campaign_id: campaign.id, status: 'proposed' } }),
    ]);
    const byChannel = new Map(active.map((a) => [a.channel_id, a]));
    const snap = budgetSnapshot(campaign, ledger, now);
    const bounds = periodBounds(campaign.budget_period, now);
    const fmt = (n: number) => formatMinorAmount(n, campaign.currency);
    const spendCounts = await this.spendRepo
      .createQueryBuilder('r')
      .select('r.status', 'status')
      .addSelect('COUNT(*)', 'n')
      .where('r.campaign_id = :id', { id: campaign.id })
      .groupBy('r.status')
      .getRawMany();
    const counts: Record<string, number> = {};
    for (const row of spendCounts) counts[row.status] = Number(row.n) || 0;
    return {
      currency: campaign.currency,
      payment_provider: campaign.payment_provider,
      caps: {
        budget_total_minor: campaign.budget_total_minor,
        budget_period: campaign.budget_period,
        budget_period_minor: campaign.budget_period_minor,
        max_transaction_minor: campaign.max_transaction_minor,
        dual_approval_threshold_minor: campaign.dual_approval_threshold_minor,
      },
      period: {
        key: snap.period_key,
        start: bounds?.start ?? null,
        end: bounds?.end ?? null,
      },
      total: snap.total,
      period_usage: snap.period,
      allocated_total_minor: active.reduce((sum, a) => sum + a.amount_minor, 0),
      pending_allocations: pending,
      spend_counts: counts,
      channels: channels.map((ch) => {
        const allocation = byChannel.get(ch.id) || null;
        const used = usageOf(ledger, (r) => r.channel_id === ch.id && r.period_key === snap.period_key);
        const allTime = usageOf(ledger, (r) => r.channel_id === ch.id);
        return {
          channel_id: ch.id,
          name: ch.name,
          platform: ch.platform,
          status: ch.status,
          allocation_minor: allocation ? allocation.amount_minor : null,
          allocation_id: allocation ? allocation.id : null,
          period_held_minor: used.held,
          period_spent_minor: used.spent,
          period_available_minor: allocation ? Math.max(0, allocation.amount_minor - used.held - used.spent) : null,
          spent_all_time_minor: allTime.spent,
        };
      }),
      text: {
        total: `spent ${fmt(snap.total.spent)} + held ${fmt(snap.total.held)} of ${fmt(snap.total.cap)} (available ${fmt(snap.total.available)})`,
        period: snap.period.cap === null
          ? `no ${campaign.budget_period} cap`
          : `${snap.period_key}: spent ${fmt(snap.period.spent)} + held ${fmt(snap.period.held)} of ${fmt(snap.period.cap)}`,
      },
    };
  }

  /** 편성 제안 — 채널마다 한 행, 같은 batch. 같은 채널의 결정 안 된 이전 제안은 superseded. */
  async propose(
    campaign: MarketingCampaign,
    body: Record<string, unknown>,
    actor: MarketingActor,
  ): Promise<MarketingBudgetAllocation[]> {
    const list = body.allocations;
    if (!Array.isArray(list) || !list.length) throw marketingError(400, 'allocations must be a non-empty array of { channel_id, amount_minor }');
    if (list.length > MAX_ALLOCATIONS_PER_PROPOSAL) throw marketingError(400, `at most ${MAX_ALLOCATIONS_PER_PROPOSAL} allocations per proposal`);
    const rationale = typeof body.rationale === 'string' ? body.rationale.trim().slice(0, 4000) : '';
    if (actor.type === 'agent' && !rationale) throw marketingError(400, 'rationale is required — cite the results that justify this allocation');
    const seen = new Set<string>();
    const parsed: Array<{ channel: MarketingChannel; amount: number }> = [];
    for (const [i, raw] of list.entries()) {
      const entry = (raw || {}) as Record<string, unknown>;
      const channelId = typeof entry.channel_id === 'string' ? entry.channel_id : '';
      if (seen.has(channelId)) throw marketingError(400, `allocations[${i}]: channel listed twice`);
      seen.add(channelId);
      const channel = channelId ? await this.channelRepo.findOne({ where: { id: channelId, campaign_id: campaign.id } }) : null;
      if (!channel) throw marketingError(404, `allocations[${i}]: channel not found in this campaign`);
      if (channel.status !== 'active' && channel.status !== 'paused') {
        throw marketingError(409, `allocations[${i}]: channel "${channel.name}" is ${channel.status} — only approved channels get budget`);
      }
      let amount: number;
      try {
        amount = parseMinorAmount(entry.amount_minor, `allocations[${i}].amount_minor`, { allowZero: true });
      } catch (e) {
        if (e instanceof MarketingMoneyError) throw marketingError(400, e.message);
        throw e;
      }
      parsed.push({ channel, amount });
    }
    const batchId = randomUUID();
    const saved = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(MarketingBudgetAllocation);
      await repo.update(
        { campaign_id: campaign.id, channel_id: In(parsed.map((p) => p.channel.id)), status: 'proposed' },
        { status: 'superseded' },
      );
      const rows = await repo.save(parsed.map((p) => repo.create({
        account_id: campaign.account_id,
        campaign_id: campaign.id,
        channel_id: p.channel.id,
        batch_id: batchId,
        amount_minor: p.amount,
        currency: campaign.currency,
        status: 'proposed',
        rationale,
        proposed_by_type: actor.type === 'agent' ? 'agent' : 'user',
        proposed_by_id: actor.id,
        proposed_by_name: actor.name,
      })));
      await this.audit.record({
        accountId: campaign.account_id,
        campaignId: campaign.id,
        entityType: 'allocation',
        entityId: batchId,
        action: 'allocation.proposed',
        actor,
        summary: `예산 편성 제안: ${parsed.map((p) => `${p.channel.name} ${formatMinorAmount(p.amount, campaign.currency)}`).join(', ')}`,
        detail: { batch_id: batchId, allocations: rows.map((r) => ({ id: r.id, channel_id: r.channel_id, amount_minor: r.amount_minor })), rationale },
      }, manager);
      return rows;
    });
    this.audit.notify(campaign.account_id, campaign.id, 'allocation', batchId, 'proposed');
    return saved;
  }

  /**
   * 편성 승인 — 캠페인 잠금 안에서 그 채널의 이전 active 를 superseded 로, 이것을 active 로.
   * active 편성 합이 기간 상한(기간 상한이 없으면 총 상한)을 넘으면 거부한다.
   */
  async approve(id: string, accountId: string, actor: MarketingActor, note = ''): Promise<MarketingBudgetAllocation> {
    const pre = await this.getAllocation(id, accountId);
    const result = await this.dataSource.transaction(async (manager) => {
      const campaign = await lockCampaign(manager, pre.campaign_id);
      const repo = manager.getRepository(MarketingBudgetAllocation);
      const row = await repo.findOne({ where: { id } });
      if (!row || row.status !== 'proposed') throw marketingError(409, `allocation is ${row?.status || 'gone'}, not proposed`);
      if (row.currency !== campaign.currency) throw marketingError(409, 'allocation currency no longer matches the campaign');
      const channel = await manager.getRepository(MarketingChannel).findOne({ where: { id: row.channel_id } });
      if (!channel || (channel.status !== 'active' && channel.status !== 'paused')) {
        throw marketingError(409, 'the channel is no longer approved');
      }
      const others = await repo.find({ where: { campaign_id: campaign.id, status: 'active' } });
      const previous = others.find((a) => a.channel_id === row.channel_id) || null;
      const sum = others.filter((a) => a.channel_id !== row.channel_id).reduce((s, a) => s + a.amount_minor, 0) + row.amount_minor;
      const periodCap = campaign.budget_period !== 'none' && campaign.budget_period_minor > 0 ? campaign.budget_period_minor : 0;
      const cap = periodCap || campaign.budget_total_minor;
      const fmt = (n: number) => formatMinorAmount(n, campaign.currency);
      if (cap > 0 && sum > cap) {
        throw marketingError(409, `allocations would total ${fmt(sum)}, above the ${periodCap ? `${campaign.budget_period} cap` : 'campaign budget'} ${fmt(cap)}`);
      }
      if (cap === 0 && row.amount_minor > 0) throw marketingError(409, 'the campaign has no budget — set budget_total_minor first');
      const won = await repo.createQueryBuilder().update(MarketingBudgetAllocation)
        .set({ status: 'active', decided_by: actor.id, decided_by_name: actor.name, decided_at: new Date(), decision_note: note.slice(0, 1000), supersedes_id: previous?.id || null })
        .where('id = :id AND status = :s', { id, s: 'proposed' })
        .execute();
      if (!won.affected) throw marketingError(409, 'allocation was decided concurrently');
      if (previous) await repo.update({ id: previous.id, status: 'active' }, { status: 'superseded' });
      await this.audit.record({
        accountId: campaign.account_id,
        campaignId: campaign.id,
        entityType: 'allocation',
        entityId: id,
        action: 'allocation.approved',
        actor,
        summary: `예산 편성 승인: ${channel.name} ${fmt(row.amount_minor)}${previous ? ` (이전 ${fmt(previous.amount_minor)})` : ''}`,
        detail: { channel_id: row.channel_id, amount_minor: row.amount_minor, previous_id: previous?.id || null, previous_amount_minor: previous?.amount_minor ?? null, note },
      }, manager);
      return repo.findOne({ where: { id } });
    });
    this.audit.notify(pre.account_id, pre.campaign_id, 'allocation', id, 'approved');
    return result!;
  }

  async reject(id: string, accountId: string, actor: MarketingActor, note = ''): Promise<MarketingBudgetAllocation> {
    const row = await this.getAllocation(id, accountId);
    const won = await this.allocationRepo.createQueryBuilder().update(MarketingBudgetAllocation)
      .set({ status: 'rejected', decided_by: actor.id, decided_by_name: actor.name, decided_at: new Date(), decision_note: note.slice(0, 1000) })
      .where('id = :id AND status = :s', { id, s: 'proposed' })
      .execute();
    if (!won.affected) throw marketingError(409, `allocation is ${row.status}, not proposed`);
    await this.audit.record({
      accountId: row.account_id,
      campaignId: row.campaign_id,
      entityType: 'allocation',
      entityId: id,
      action: 'allocation.rejected',
      actor,
      summary: `예산 편성 거부: ${formatMinorAmount(row.amount_minor, row.currency)}`,
      detail: { channel_id: row.channel_id, note },
    });
    this.audit.notify(row.account_id, row.campaign_id, 'allocation', id, 'rejected');
    return (await this.allocationRepo.findOne({ where: { id } }))!;
  }

  /** 다른 서비스(지출)용 — 트랜잭션 밖 사전 검사에서 그 채널의 active 편성. */
  async activeFor(campaignId: string, channelId: string): Promise<MarketingBudgetAllocation | null> {
    return this.allocationRepo.findOne({ where: { campaign_id: campaignId, channel_id: channelId, status: 'active' }, order: { created_at: 'DESC' } });
  }
}
