import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MINOR_AMOUNT_TRANSFORMER } from '../common/marketing/money';

/**
 * MarketingBudgetAllocation — 채널별 예산 편성 한 버전(docs/marketing.md "예산 편성").
 *
 * 에이전트가 성과를 근거로 제안하고(`proposed`) `marketing.approve_spend` 를 가진 사람이 승인하면
 * `active` 가 되고, 그 채널의 이전 active 는 `superseded` 가 된다. 금액은 고치지 않는다 — 새 편성은
 * 언제나 새 행이라 "언제 누가 얼마로 바꿨나" 가 그대로 남는다. 금액의 단위는 캠페인 budget_period 의
 * 한 기간(none 이면 캠페인 전체)이다. 편성이 없는 채널에는 지출할 수 없다.
 */
@Entity('marketing_budget_allocations')
@Index(['campaign_id', 'status'])
@Index(['campaign_id', 'channel_id'])
export class MarketingBudgetAllocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  @Column({ type: 'varchar' })
  channel_id: string;

  /** 한 번의 제안에 묶인 편성들(화면이 한 계획으로 보여 준다). */
  @Column({ type: 'varchar', default: '' })
  batch_id: string;

  @Column({ type: 'bigint', transformer: MINOR_AMOUNT_TRANSFORMER })
  amount_minor: number;

  @Column({ type: 'varchar' })
  currency: string;

  /** proposed | active | superseded | rejected */
  @Column({ type: 'varchar', default: 'proposed' })
  status: string;

  @Column({ type: 'text', default: '' })
  rationale: string;

  @Column({ type: 'varchar', default: 'agent' })
  proposed_by_type: string;

  @Column({ type: 'varchar', default: '' })
  proposed_by_id: string;

  @Column({ type: 'varchar', default: '' })
  proposed_by_name: string;

  @Column({ type: 'varchar', default: '' })
  decided_by: string;

  @Column({ type: 'varchar', default: '' })
  decided_by_name: string;

  @Column({ type: Date, nullable: true, default: null })
  decided_at: Date | null;

  @Column({ type: 'text', default: '' })
  decision_note: string;

  /** 이 편성이 대체한 이전 active 편성. */
  @Column({ type: 'varchar', nullable: true, default: null })
  supersedes_id: string | null;

  @CreateDateColumn()
  created_at: Date;
}
