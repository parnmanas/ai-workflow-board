import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MINOR_AMOUNT_TRANSFORMER } from '../common/marketing/money';

/**
 * MarketingMetric — 채널 · 게시물 지표 관측치 한 줄(docs/marketing.md "분석").
 *
 * 누적형(clicks · impressions · engagements · replies · signups · conversions · revenue_minor · views)은 기간 안의
 * 값을 더하고, 수준형(followers · subscribers)은 기간 안의 마지막 관측값을 쓴다(MARKETING_GAUGE_METRICS).
 * 추적 링크 클릭은 서버가 시간 버킷(`bucket_start`)마다 한 행에 더한다(source `link`). 그 밖은 에이전트 · 사람이
 * 관측한 값을 남긴다(source `agent` | `user`) — 누가 남겼는지가 같이 남는다.
 */
@Entity('marketing_metrics')
@Index(['campaign_id', 'bucket_start'])
@Index(['channel_id', 'metric'])
@Index('uq_marketing_metrics_link_bucket', ['link_id', 'metric', 'bucket_start'], { unique: true, where: "source = 'link'" })
export class MarketingMetric {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  /** '' = 캠페인 전체. */
  @Column({ type: 'varchar', default: '' })
  channel_id: string;

  @Column({ type: 'varchar', default: '' })
  post_id: string;

  @Column({ type: 'varchar', default: '' })
  link_id: string;

  /** MARKETING_METRICS */
  @Column({ type: 'varchar' })
  metric: string;

  @Column({ type: 'bigint', transformer: MINOR_AMOUNT_TRANSFORMER })
  value: number;

  /** link | agent | user */
  @Column({ type: 'varchar' })
  source: string;

  /** 관측 시각(링크 클릭은 그 시간의 시작). */
  @Column({ type: Date })
  bucket_start: Date;

  @Column({ type: 'text', default: '' })
  note: string;

  @Column({ type: 'varchar', default: '' })
  recorded_by_type: string;

  @Column({ type: 'varchar', default: '' })
  recorded_by_id: string;

  @Column({ type: 'varchar', default: '' })
  recorded_by_name: string;

  @CreateDateColumn()
  created_at: Date;
}
