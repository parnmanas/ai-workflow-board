import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MINOR_AMOUNT_TRANSFORMER } from '../common/marketing/money';

/**
 * MarketingLedgerEntry — 마케팅 돈의 append-only 원장(docs/marketing.md "원장 계산").
 *
 *   reserve  승인으로 예산을 묶었다            release  묶은 것을 풀었다(결제 실패 · 결제 완료 시 capture 로 전환)
 *   capture  실제로 나갔다                     refund   나간 것이 돌아왔다
 *
 * 금액은 언제나 양수이고 의미는 kind 가 정한다. 이 테이블을 UPDATE/DELETE 하는 코드 경로는 없다 —
 * 정정은 반대 방향의 새 행이다. period_key 는 그 지출 요청이 승인된 예산 기간이다(common/marketing/budget.ts).
 * 요청별로 release ≤ reserve, refund ≤ capture 를 쓰기 전에 검사한다.
 */
@Entity('marketing_ledger_entries')
@Index(['campaign_id', 'created_at'])
@Index(['spend_request_id'])
export class MarketingLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  @Column({ type: 'varchar' })
  channel_id: string;

  @Column({ type: 'varchar' })
  spend_request_id: string;

  /** reserve | release | capture | refund */
  @Column({ type: 'varchar' })
  kind: string;

  @Column({ type: 'bigint', transformer: MINOR_AMOUNT_TRANSFORMER })
  amount_minor: number;

  @Column({ type: 'varchar' })
  currency: string;

  @Column({ type: 'varchar' })
  period_key: string;

  @Column({ type: 'varchar' })
  actor_type: string;

  @Column({ type: 'varchar', default: '' })
  actor_id: string;

  @Column({ type: 'varchar', default: '' })
  actor_name: string;

  @Column({ type: 'text', default: '' })
  note: string;

  @CreateDateColumn()
  created_at: Date;
}
