import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * MarketingFeedback — 에이전트 · 사람이 기록한 피드백 한 건(docs/marketing.md "피드백 → 제품").
 *
 * 연결된 OutreachChannel 이 폴링으로 모은 글은 outreach_inbound_items 에 남고(그쪽 ingest 가 분류 · 티켓을 맡는다),
 * 여기는 그 밖의 것 — manual 채널의 댓글, 메일 답장, 에이전트가 읽고 옮긴 글 — 이다. `content` 와 `author` 는
 * **외부인이 쓴 글**이라 사이클 지시문 · MCP 응답에서 비신뢰 데이터로 표시된다. `(campaign_id, source_key)` 로
 * 같은 출처를 두 번 기록하지 않는다.
 */
@Entity('marketing_feedback')
@Index(['campaign_id', 'created_at'])
@Index('uq_marketing_feedback_source', ['campaign_id', 'source_key'], { unique: true, where: "source_key <> ''" })
export class MarketingFeedback {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  @Column({ type: 'varchar', default: '' })
  channel_id: string;

  @Column({ type: 'varchar', default: '' })
  post_id: string;

  /**
   * 메일 답장이면 보낸 연락처. 사람용 REST 만 이것으로 주소를 보여 준다 — 에이전트 응답 · 사이클 지시문에는 싣지 않는다
   * (에이전트는 연락처를 보지 못한다).
   */
  @Column({ type: 'varchar', default: '' })
  contact_id: string;

  @Column({ type: 'varchar', default: '' })
  source_url: string;

  /** 중복 판단 키(정규화한 source_url). */
  @Column({ type: 'varchar', default: '' })
  source_key: string;

  @Column({ type: 'varchar', default: '' })
  author: string;

  @Column({ type: 'text' })
  content: string;

  /** 에이전트가 붙인 한 줄 요약(티켓 제목). */
  @Column({ type: 'varchar', default: '' })
  summary: string;

  /** bug | feature_request | question | praise | complaint | other */
  @Column({ type: 'varchar' })
  category: string;

  /** positive | neutral | negative */
  @Column({ type: 'varchar', default: 'neutral' })
  sentiment: string;

  /** recorded | ticketed | capped */
  @Column({ type: 'varchar', default: 'recorded' })
  status: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  ticket_id: string | null;

  @Column({ type: 'varchar', default: 'agent' })
  recorded_by_type: string;

  @Column({ type: 'varchar', default: '' })
  recorded_by_id: string;

  @Column({ type: 'varchar', default: '' })
  recorded_by_name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  cycle_id: string | null;

  @CreateDateColumn()
  created_at: Date;
}
