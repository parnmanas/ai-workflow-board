import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingPost } from '../../entities/MarketingPost';
import { MarketingBudgetAllocation } from '../../entities/MarketingBudgetAllocation';
import { MarketingSpendRequest } from '../../entities/MarketingSpendRequest';
import { MarketingListHoldService } from './marketing-list-hold.service';

export interface InboxCounts {
  campaign_id: string;
  account_id: string;
  name: string;
  lists_held: number;
  channels_proposed: number;
  posts_draft: number;
  allocations_proposed: number;
  spend_pending: number;
  spend_unknown: number;
  manual_awaiting_payment: number;
}

/**
 * 사람의 결정을 기다리는 것의 수 — 사이드바 배지와 목록 화면이 캠페인마다 요청을 보내지 않고 한 번에 읽는다.
 * 테이블마다 GROUP BY 한 번(캠페인 수와 무관한 쿼리 수). 보관된 캠페인은 미결 결제(결과 불명 · 수동 결제 기록 대기)만 센다.
 */
@Injectable()
export class MarketingInboxService {
  constructor(
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingPost) private readonly postRepo: Repository<MarketingPost>,
    @InjectRepository(MarketingBudgetAllocation) private readonly allocationRepo: Repository<MarketingBudgetAllocation>,
    @InjectRepository(MarketingSpendRequest) private readonly spendRepo: Repository<MarketingSpendRequest>,
    private readonly listHolds: MarketingListHoldService,
  ) {}

  async counts(accountIds: string[]): Promise<InboxCounts[]> {
    if (!accountIds.length) return [];
    const campaigns = await this.campaignRepo.find({
      where: { account_id: In(accountIds) },
      select: ['id', 'account_id', 'name', 'status'],
    });
    if (!campaigns.length) return [];
    const ids = campaigns.map((c) => c.id);
    const grouped = async (repo: Repository<any>, statuses: string[], extra?: (qb: any) => void) => {
      const qb = repo.createQueryBuilder('t')
        .select('t.campaign_id', 'campaign_id')
        .addSelect('t.status', 'status')
        .addSelect('COUNT(*)', 'n')
        .where('t.campaign_id IN (:...ids)', { ids })
        .andWhere('t.status IN (:...statuses)', { statuses });
      if (extra) extra(qb);
      const rows = await qb.groupBy('t.campaign_id').addGroupBy('t.status').getRawMany();
      const out = new Map<string, Record<string, number>>();
      for (const r of rows) {
        const m = out.get(r.campaign_id) || {};
        m[r.status] = Number(r.n) || 0;
        out.set(r.campaign_id, m);
      }
      return out;
    };
    const [channels, posts, allocations, spend, manual, holds] = await Promise.all([
      grouped(this.channelRepo, ['proposed']),
      grouped(this.postRepo, ['draft', 'approved']),
      grouped(this.allocationRepo, ['proposed']),
      grouped(this.spendRepo, ['pending', 'unknown']),
      grouped(this.spendRepo, ['approved'], (qb) => qb.andWhere('t.provider = :p', { p: 'manual' })),
      this.listHolds.activeByCampaign(campaigns.filter((c) => c.status !== 'archived').map((c) => c.id)),
    ]);
    return campaigns.map((c) => ({
      campaign_id: c.id,
      account_id: c.account_id,
      name: c.name,
      lists_held: holds.get(c.id)?.length || 0,
      channels_proposed: c.status === 'archived' ? 0 : channels.get(c.id)?.proposed || 0,
      // approved 게시물은 manual 채널에서 사람이 올리고 링크를 기록하기를 기다린다.
      posts_draft: c.status === 'archived' ? 0 : (posts.get(c.id)?.draft || 0) + (posts.get(c.id)?.approved || 0),
      allocations_proposed: c.status === 'archived' ? 0 : allocations.get(c.id)?.proposed || 0,
      spend_pending: c.status === 'archived' ? 0 : spend.get(c.id)?.pending || 0,
      spend_unknown: spend.get(c.id)?.unknown || 0,
      manual_awaiting_payment: manual.get(c.id)?.approved || 0,
    }));
  }
}
