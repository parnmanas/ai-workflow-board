import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * MarketingLink — 추적 링크(docs/marketing.md "분석").
 *
 * 공개 `GET /api/m/:code` 가 저장된 `redirect_url` 로만 302 한다 — 목적지를 요청 쿼리에서 받지 않고, 만들 때
 * 캠페인 allowed_domains 안인지 검사하므로 오픈 리다이렉트가 되지 않는다. code 는 12자 base62 난수.
 * `clicks` 는 raw 클릭 수(봇 · HEAD · prefetch · 30 분 내 반복 제외)의 빠른 합계이고, 시간대별 값은
 * marketing_metrics 에 있다.
 */
@Entity('marketing_links')
@Index('uq_marketing_links_code', ['code'], { unique: true })
@Index(['campaign_id', 'channel_id'])
export class MarketingLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  @Column({ type: 'varchar' })
  channel_id: string;

  @Column({ type: 'varchar', default: '' })
  post_id: string;

  @Column({ type: 'varchar' })
  code: string;

  /** 에이전트/사람이 준 목적지(허용 도메인 안). */
  @Column({ type: 'text' })
  destination_url: string;

  /** UTM 을 붙인 실제 이동 주소. */
  @Column({ type: 'text' })
  redirect_url: string;

  @Column({ type: 'varchar', default: '' })
  label: string;

  @Column({ type: 'int', default: 0 })
  clicks: number;

  @Column({ type: 'varchar', default: 'agent' })
  created_by_type: string;

  @Column({ type: 'varchar', default: '' })
  created_by_id: string;

  @Column({ type: 'varchar', default: '' })
  created_by_name: string;

  @CreateDateColumn()
  created_at: Date;
}
