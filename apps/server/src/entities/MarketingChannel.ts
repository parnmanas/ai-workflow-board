import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * MarketingChannel — 캠페인이 말을 거는 곳 하나(docs/marketing.md "채널 탐색").
 *
 * 에이전트가 근거와 함께 제안하고(`proposed`) 사람이 승인해야 쓴다. 승인할 때 사람이 방식을 정한다:
 *   - kind `outreach` — 연결된 OutreachChannel 의 커넥터로 서버가 게시한다(reddit · github).
 *     연결할 credential 이 아직 없으면 `awaiting_credential`.
 *   - kind `email` — 메일 발송 채널. 발신자 · 주소 · 수신 목록 · 메일 credential 은 `config` 에.
 *   - kind `manual` — 승인된 글을 사람이 직접 올리고 permalink 를 기록한다.
 *
 * 이것은 연결 테이블이다 — 게시 대상 화이트리스트 · 토큰 · rate limit 은 OutreachChannel 의 것을
 * 그대로 쓴다(같은 subreddit 을 여러 캠페인이 공유할 수 있다). `(campaign_id, platform, target_key)` 가
 * 유일해 같은 채널을 두 번 제안하지 못한다.
 */
@Entity('marketing_channels')
@Index(['campaign_id', 'status'])
@Index('uq_marketing_channels_target', ['campaign_id', 'platform', 'target_key'], { unique: true })
export class MarketingChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  /** CHANNEL_PLATFORMS */
  @Column({ type: 'varchar' })
  platform: string;

  /** outreach | email | manual — 승인 때 정해진다. 제안 단계에서는 플랫폼의 기본값. */
  @Column({ type: 'varchar', default: 'manual' })
  kind: string;

  @Column({ type: 'varchar' })
  name: string;

  /** subreddit 이름 · owner/repo · URL · 수신 목록 이름. */
  @Column({ type: 'varchar' })
  target: string;

  /** 중복 판단용 정규화 키(소문자). */
  @Column({ type: 'varchar' })
  target_key: string;

  /** CHANNEL_STATUSES */
  @Column({ type: 'varchar', default: 'proposed' })
  status: string;

  /** 왜 이 채널인가. */
  @Column({ type: 'text', default: '' })
  rationale: string;

  /** 청중이 제품과 어떻게 맞는가. */
  @Column({ type: 'text', default: '' })
  audience_fit: string;

  @Column({ type: 'int', nullable: true, default: null })
  audience_size: number | null;

  @Column({ type: Date, nullable: true, default: null })
  audience_observed_at: Date | null;

  /** 에이전트가 실제로 열어 본 근거 URL. */
  @Column({ type: 'simple-json', default: '[]' })
  evidence_urls: string[];

  /** 그 커뮤니티의 홍보 규칙 요약(인용)과 출처. 승인 화면에 같이 보인다. */
  @Column({ type: 'text', default: '' })
  rules_summary: string;

  @Column({ type: 'varchar', default: '' })
  rules_url: string;

  /** 이 채널에서의 톤 · 빈도 · 하지 말 것. 사이클 지시문에 실린다. */
  @Column({ type: 'text', default: '' })
  guidelines: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  outreach_channel_id: string | null;

  /** kind 별 설정(email: credential_id · from_name · from_address · reply_to · postal_address · contact_email · ad_label · list_name). */
  @Column({ type: 'simple-json', default: '{}' })
  config: Record<string, any>;

  /** agent | user */
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

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
