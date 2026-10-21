import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { MarketingAuditEvent } from '../../entities/MarketingAuditEvent';
import { activityEvents } from '../../services/activity.service';
import {
  MARKETING_UPDATE_EVENT,
  type MarketingActor,
  type MarketingAuditEntityType,
} from '../../common/marketing/marketing-constants';

export interface MarketingAuditInput {
  accountId: string;
  campaignId: string;
  entityType: MarketingAuditEntityType;
  entityId: string;
  action: string;
  actor: MarketingActor;
  summary: string;
  detail?: Record<string, unknown>;
}

/**
 * 마케팅 감사 로그 + 화면 갱신 신호.
 *
 * `record` 는 넘겨받은 EntityManager(트랜잭션)가 있으면 그 안에서 쓴다 — 돈이 움직인 행과
 * 그 감사 행이 같은 커밋에 들어가야 "원장에는 있는데 누가 했는지 모르는" 상태가 생기지 않는다.
 * 이 서비스에는 감사 행을 고치거나 지우는 메서드가 없다(append-only).
 */
@Injectable()
export class MarketingAuditService {
  constructor(
    @InjectRepository(MarketingAuditEvent) private readonly auditRepo: Repository<MarketingAuditEvent>,
  ) {}

  async record(input: MarketingAuditInput, manager?: EntityManager): Promise<MarketingAuditEvent> {
    const repo = manager ? manager.getRepository(MarketingAuditEvent) : this.auditRepo;
    return repo.save(repo.create({
      account_id: input.accountId,
      campaign_id: input.campaignId || '',
      entity_type: input.entityType,
      entity_id: input.entityId || '',
      action: input.action,
      actor_type: input.actor.type,
      actor_id: input.actor.id || '',
      actor_name: input.actor.name || '',
      summary: input.summary.slice(0, 2000),
      detail: input.detail || {},
      ip: input.actor.ip || null,
    }));
  }

  async list(campaignId: string, accountId: string, opts: { limit?: number; before?: Date } = {}): Promise<MarketingAuditEvent[]> {
    const limit = Math.min(Math.max(opts.limit || 100, 1), 500);
    const qb = this.auditRepo.createQueryBuilder('e')
      .where('e.campaign_id = :campaignId', { campaignId })
      .andWhere('e.account_id = :accountId', { accountId })
      .orderBy('e.created_at', 'DESC')
      .take(limit);
    if (opts.before) qb.andWhere('e.created_at < :before', { before: opts.before });
    return qb.getMany();
  }

  /**
   * 화면에 "이 캠페인의 무언가가 바뀌었다" 를 알린다(UI 전용 SSE, user-only filter).
   * 내용은 싣지 않는다 — 화면이 REST 로 다시 읽는다. 커밋 뒤에 부를 것.
   */
  notify(accountId: string, campaignId: string, kind: MarketingAuditEntityType, entityId: string, action: string): void {
    activityEvents.emit(MARKETING_UPDATE_EVENT, {
      account_id: accountId,
      campaign_id: campaignId,
      kind,
      entity_id: entityId,
      action,
      timestamp: new Date().toISOString(),
    });
  }
}
