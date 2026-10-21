/**
 * 원장 쓰기의 공통 규칙 — 트랜잭션 안에서만 부른다(docs/marketing.md "원장 계산").
 *
 * lockCampaign: 캠페인 행의 spend_version 을 UPDATE 해 행 잠금을 잡는다. Postgres 에서는 같은 캠페인의
 *   승인 · 결제 기록 · 환불 · 편성 승인이 이 잠금에서 줄을 서고, 앞 트랜잭션이 커밋한 원장 행을 다음 트랜잭션이
 *   (READ COMMITTED 의 문장 단위 스냅샷으로) 본 뒤에 한도를 계산한다. sql.js 는 serializeSqljsTransactions 가
 *   트랜잭션 자체를 직렬화한다 — 그래서 원장 계산 · 쓰기는 반드시 넘겨받은 manager 로만 한다(바깥 repository 로
 *   읽으면 그 보장 밖이다).
 * appendLedger: 요청별 불변식(release ≤ reserve, capture ≤ reserve, refund ≤ capture)을 쓰기 전에 검사한다.
 *   행을 고치거나 지우는 함수는 없다.
 */
import type { EntityManager } from 'typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingLedgerEntry } from '../../entities/MarketingLedgerEntry';
import { MarketingBudgetAllocation } from '../../entities/MarketingBudgetAllocation';
import { requestTotals, type LedgerKind, type LedgerRow } from '../../common/marketing/budget';
import type { MarketingActor } from '../../common/marketing/marketing-constants';
import { marketingError } from './marketing-errors';

export async function lockCampaign(manager: EntityManager, campaignId: string): Promise<MarketingCampaign> {
  const res = await manager.createQueryBuilder()
    .update(MarketingCampaign)
    .set({ spend_version: () => 'spend_version + 1' })
    .where('id = :id', { id: campaignId })
    .execute();
  if (!res.affected) throw marketingError(404, 'campaign not found');
  const row = await manager.getRepository(MarketingCampaign).findOne({ where: { id: campaignId } });
  if (!row) throw marketingError(404, 'campaign not found');
  return row;
}

export async function loadLedger(manager: EntityManager, campaignId: string): Promise<MarketingLedgerEntry[]> {
  return manager.getRepository(MarketingLedgerEntry).find({ where: { campaign_id: campaignId }, order: { created_at: 'ASC' } });
}

export async function activeAllocation(
  manager: EntityManager,
  campaignId: string,
  channelId: string,
): Promise<MarketingBudgetAllocation | null> {
  return manager.getRepository(MarketingBudgetAllocation).findOne({
    where: { campaign_id: campaignId, channel_id: channelId, status: 'active' },
    order: { created_at: 'DESC' },
  });
}

export interface LedgerWrite {
  kind: LedgerKind;
  amount_minor: number;
  note?: string;
}

export async function appendLedger(
  manager: EntityManager,
  existing: LedgerRow[],
  base: {
    account_id: string;
    campaign_id: string;
    channel_id: string;
    spend_request_id: string;
    currency: string;
    period_key: string;
  },
  writes: LedgerWrite[],
  actor: MarketingActor,
): Promise<MarketingLedgerEntry[]> {
  const totals = requestTotals(existing, base.spend_request_id);
  for (const w of writes) {
    if (!Number.isSafeInteger(w.amount_minor) || w.amount_minor <= 0) throw marketingError(500, `invalid ledger amount for ${w.kind}`);
    totals[w.kind] += w.amount_minor;
  }
  if (totals.release > totals.reserve) throw marketingError(409, 'ledger invariant: release would exceed reserve');
  if (totals.capture > totals.reserve) throw marketingError(409, 'ledger invariant: capture would exceed the approved amount');
  if (totals.refund > totals.capture) throw marketingError(409, 'ledger invariant: refund would exceed what was paid');
  const repo = manager.getRepository(MarketingLedgerEntry);
  const rows = writes.map((w) => repo.create({
    ...base,
    kind: w.kind,
    amount_minor: w.amount_minor,
    actor_type: actor.type,
    actor_id: actor.id || '',
    actor_name: actor.name || '',
    note: (w.note || '').slice(0, 2000),
  }));
  return repo.save(rows);
}
