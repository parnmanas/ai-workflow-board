import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingPost } from '../../entities/MarketingPost';
import { MarketingBudgetAllocation } from '../../entities/MarketingBudgetAllocation';
import { MarketingSpendRequest } from '../../entities/MarketingSpendRequest';

export interface InboxCounts {
  campaign_id: string;
  account_id: string;
  name: string;
  channels_proposed: number;
  posts_draft: number;
  allocations_proposed: number;
  spend_pending: number;
  spend_unknown: number;
  manual_awaiting_payment: number;
}

/**
 * 사람의 결정을 기다리는 것의 수 — 사이드바 배지와 목록 화면이 캠페인마다 요청을 보내지 않고 한 번에 읽는다.
 * 테이블마다 GROUP BY 한 번(캠페인 수와 무관한 쿼리 수). 보관된 캠페인은 세지 않는다.
 */
@Injectable()
export class MarketingInboxService {
  constructor(
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingPost) private readonly postRepo: Repository<MarketingPost>,
    @InjectRepository(MarketingBudgetAllocation) private readonly allocationRepo: Repository<MarketingBudgetAllocation>,
    @InjectRepository(MarketingSpendRequest) private readonly spendRepo: Repository<MarketingSpendRequest>,
  ) {}

  async counts(accountIds: string[]): Promise<InboxCounts[]> {
    if (!accountIds.length) return [];
    const campaigns = await this.campaignRepo.find({
      where: { account_id: In(accountIds), status: Not('archived') },
      select: ['id', 'account_id', 'name'],
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
    const [channels, posts, allocations, spend, manual] = await Promise.all([
      grouped(this.channelRepo, ['proposed']),
      grouped(this.postRepo, ['draft', 'approved']),
      grouped(this.allocationRepo, ['proposed']),
      grouped(this.spendRepo, ['pending', 'unknown']),
      grouped(this.spendRepo, ['approved'], (qb) => qb.andWhere('t.provider = :p', { p: 'manual' })),
    ]);
    return campaigns.map((c) => ({
      campaign_id: c.id,
      account_id: c.account_id,
      name: c.name,
      channels_proposed: channels.get(c.id)?.proposed || 0,
      // approved 게시물은 manual 채널에서 사람이 올리고 링크를 기록하기를 기다린다.
      posts_draft: (posts.get(c.id)?.draft || 0) + (posts.get(c.id)?.approved || 0),
      allocations_proposed: allocations.get(c.id)?.proposed || 0,
      spend_pending: spend.get(c.id)?.pending || 0,
      spend_unknown: spend.get(c.id)?.unknown || 0,
      manual_awaiting_payment: manual.get(c.id)?.approved || 0,
    }));
  }
}
