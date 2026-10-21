import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { MarketingCampaign } from '../../entities/MarketingCampaign';
import type { MarketingActor } from '../../common/marketing/marketing-constants';

type StoppedHandler = (campaign: MarketingCampaign, actor: MarketingActor) => Promise<void>;
type Blocker = (campaign: MarketingCampaign) => Promise<string | null>;
type ChildDeleter = (campaign: MarketingCampaign, manager: EntityManager) => Promise<void>;

/**
 * 캠페인 상태 전이에 다른 마케팅 기능이 끼어드는 자리.
 *
 * 캠페인 서비스가 지출 · 채널 · 사이클 서비스를 직접 알면 그 서비스들도 캠페인 서비스를
 * 필요로 해 순환 의존이 된다. 대신 각 기능이 자기 생성자에서 여기에 등록한다:
 *   - campaignStopped: 일시정지 · 보관 시(대기 중 지출 요청 취소, 사이클 중단 …)
 *   - deletionBlocker: 삭제를 막을 사유(지출 기록이 있으면 보관해야 한다)
 *   - deleteChildren: 삭제 트랜잭션 안에서 자식 행 정리
 *   - currencyChangeBlocker: 통화 변경을 막을 사유(원장이 생기면 통화는 고정)
 */
@Injectable()
export class MarketingCampaignHooks {
  private readonly stopped: StoppedHandler[] = [];
  private readonly deletionBlockers: Blocker[] = [];
  private readonly childDeleters: ChildDeleter[] = [];
  private readonly currencyBlockers: Blocker[] = [];

  onCampaignStopped(fn: StoppedHandler): void { this.stopped.push(fn); }
  onDeletionCheck(fn: Blocker): void { this.deletionBlockers.push(fn); }
  onDeleteChildren(fn: ChildDeleter): void { this.childDeleters.push(fn); }
  onCurrencyChangeCheck(fn: Blocker): void { this.currencyBlockers.push(fn); }

  async campaignStopped(campaign: MarketingCampaign, actor: MarketingActor): Promise<void> {
    for (const fn of this.stopped) await fn(campaign, actor);
  }

  async deletionBlocker(campaign: MarketingCampaign): Promise<string | null> {
    for (const fn of this.deletionBlockers) {
      const reason = await fn(campaign);
      if (reason) return reason;
    }
    return null;
  }

  async deleteChildren(campaign: MarketingCampaign, manager: EntityManager): Promise<void> {
    for (const fn of this.childDeleters) await fn(campaign, manager);
  }

  async currencyChangeBlocker(campaign: MarketingCampaign): Promise<string | null> {
    for (const fn of this.currencyBlockers) {
      const reason = await fn(campaign);
      if (reason) return reason;
    }
    return null;
  }
}
