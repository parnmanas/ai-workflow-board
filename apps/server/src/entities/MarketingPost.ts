import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * MarketingPost — 채널로 나가는 글 하나(게시글 · 댓글 · 메일). docs/marketing.md "커뮤니케이션".
 *
 *   draft ─approve→ publishing → published | failed     (outreach: 서버가 커넥터로 게시)
 *         ─approve→ approved ─(사람이 올리고 기록)→ published   (manual)
 *         ─approve→ sending → published                 (email: 발송 큐가 다 돌면)
 *         ─reject→ rejected
 *
 * 에이전트는 draft 만 만든다. 승인할 때 사람이 고친 제목 · 본문은 상태 CAS 와 **같은 UPDATE** 에서 저장되고,
 * 그때 서버가 공개 문구를 붙인 `final_body` 를 확정한다 — 승인한 글과 나가는 글이 갈리지 않는다(outreach
 * 퍼블리셔의 "본문 수정 후 claim" 사이 틈을 따르지 않는다). `(campaign_id, dedupe_key)` 로 같은 초안이 두 번
 * 쌓이지 않는다.
 *
 * reddit · GitHub outreach 채널에 게시된 글은 게시 후 14 일 동안 서버가 참여를 읽는다(`engagement*`,
 * MarketingEngagementService — docs/marketing.md "참여 지표 자동 수집").
 */
@Entity('marketing_posts')
@Index(['campaign_id', 'status'])
@Index(['channel_id', 'status'])
@Index(['engagement_next_at'])
@Index('uq_marketing_posts_dedupe', ['campaign_id', 'dedupe_key'], { unique: true, where: "dedupe_key <> ''" })
export class MarketingPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  @Column({ type: 'varchar' })
  channel_id: string;

  /** post | reply | email */
  @Column({ type: 'varchar', default: 'post' })
  kind: string;

  @Column({ type: 'varchar', default: '' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  /** 승인 때 확정된 실제 발신 본문(공개 문구 포함). 메일은 수신자별 꼬리말이 발송 때 더해진다. */
  @Column({ type: 'text', default: '' })
  final_body: string;

  /** reply 의 대상(reddit fullname t3_/t1_, github issue:{owner}/{repo}#{n}). */
  @Column({ type: 'varchar', default: '' })
  reply_to: string;

  /**
   * reply 의 대상을 서버가 확인한 결과 { target, permalink, title } — 초안 때 커넥터의 describeThread 로 그 스레드가
   * 이 채널의 subreddit/repo 안인지 확인하고 남긴다. 승인 화면이 "어디에 답글이 달리는지" 를 보여 준다. title 은 외부 글.
   */
  @Column({ type: 'simple-json', default: '{}' })
  reply_context: Record<string, string>;

  /** 게시 대상(subreddit · owner/repo). 비면 채널의 target. */
  @Column({ type: 'varchar', default: '' })
  target: string;

  /** draft | approved | publishing | sending | published | rejected | failed */
  @Column({ type: 'varchar', default: 'draft' })
  status: string;

  @Column({ type: 'varchar', default: '' })
  dedupe_key: string;

  /** 에이전트가 왜 이 글을 이 채널에 쓰는지(승인 화면에 보인다). */
  @Column({ type: 'text', default: '' })
  rationale: string;

  @Column({ type: 'varchar', default: 'agent' })
  created_by_type: string;

  @Column({ type: 'varchar', default: '' })
  created_by_id: string;

  @Column({ type: 'varchar', default: '' })
  created_by_name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  cycle_id: string | null;

  @Column({ type: 'varchar', default: '' })
  decided_by: string;

  @Column({ type: 'varchar', default: '' })
  decided_by_name: string;

  @Column({ type: Date, nullable: true, default: null })
  decided_at: Date | null;

  @Column({ type: 'text', default: '' })
  decision_note: string;

  /** 승인한 사람이 제목 · 본문을 고쳤는가. */
  @Column({ type: 'boolean', default: false })
  edited: boolean;

  @Column({ type: 'varchar', default: '' })
  external_item_id: string;

  @Column({ type: 'varchar', default: '' })
  permalink: string;

  @Column({ type: Date, nullable: true, default: null })
  published_at: Date | null;

  @Column({ type: 'text', default: '' })
  error: string;

  /** 본문에 들어간 추적 링크 코드. */
  @Column({ type: 'simple-json', default: '[]' })
  link_codes: string[];

  /**
   * 마지막으로 읽은 참여 { engagements, replies, read_at } — reddit 은 score · 댓글 수, GitHub 은 반응 합계 · 댓글 수.
   * 답글(댓글)인 글은 댓글 수가 없다. MarketingMetric 의 connector 행은 이 값의 변화량이라, 그 합이 곧 이 값이다.
   */
  @Column({ type: 'simple-json', default: '{}' })
  engagement: { engagements?: number; replies?: number; read_at?: string };

  /** 다음에 참여를 읽을 시각. null = 읽지 않는다(서버가 게시한 글이 아님 · 기간이 끝남 · 멈춤). */
  @Column({ type: Date, nullable: true, default: null })
  engagement_next_at: Date | null;

  /** 수집기가 이 글을 맡을 때마다 오르는 CAS 카운터 — 서버가 둘이어도 한 번만 읽는다. 0 = 맡은 적 없음. */
  @Column({ type: 'int', default: 0 })
  engagement_rev: number;

  /** 마지막 읽기가 실패했거나 수집을 멈춘 이유(사람에게 보인다). 읽으면 지운다. */
  @Column({ type: 'text', default: '' })
  engagement_error: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
