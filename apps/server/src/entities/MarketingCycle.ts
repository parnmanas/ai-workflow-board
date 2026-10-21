import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * MarketingCycle — 루프 1회(docs/marketing.md "루프").
 *
 * 주기 tick(또는 사람이 누른 "지금 실행")이 행을 만들고 방을 열어 캠페인 에이전트에게 사이클 지시문을 보낸다.
 * 에이전트가 complete_marketing_cycle 로 요약 · 다음 행동을 남기면 completed. 6 시간 안에 끝나지 않으면
 * timed_out, 캠페인이 정지되면 cancelled. `untrusted_items` 는 지시문에 비신뢰 블록으로 실린 외부 글 수다.
 */
@Entity('marketing_cycles')
@Index('uq_marketing_cycles_no', ['campaign_id', 'cycle_no'], { unique: true })
@Index(['campaign_id', 'status'])
export class MarketingCycle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  @Column({ type: 'int' })
  cycle_no: number;

  /** running | completed | timed_out | cancelled | failed */
  @Column({ type: 'varchar', default: 'running' })
  status: string;

  /** schedule | manual */
  @Column({ type: 'varchar', default: 'schedule' })
  trigger: string;

  @Column({ type: 'varchar', default: '' })
  triggered_by: string;

  @Column({ type: 'varchar', default: '' })
  room_id: string;

  @Column({ type: 'varchar', default: '' })
  agent_key: string;

  @Column({ type: Date })
  started_at: Date;

  @Column({ type: Date, nullable: true, default: null })
  completed_at: Date | null;

  @Column({ type: 'text', default: '' })
  summary: string;

  @Column({ type: 'simple-json', default: '[]' })
  next_actions: string[];

  @Column({ type: 'int', default: 0 })
  untrusted_items: number;

  @Column({ type: 'text', default: '' })
  error: string;

  @CreateDateColumn()
  created_at: Date;
}
