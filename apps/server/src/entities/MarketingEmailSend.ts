import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * MarketingEmailSend — 메일 한 통 = (게시물 × 연락처). 발송 큐이자 기록(docs/marketing.md "메일").
 *
 *   queued → sent | failed | suppressed      deferred(야간 보류 · 일시 오류 재시도 · 정지) → queued 와 같이 처리
 *
 * `(post_id, contact_id)` 가 유일해 같은 메일이 같은 사람에게 두 번 나가지 않는다. 보낼 때마다 연락처의 현재 상태를
 * 다시 본다 — 큐에 들어간 뒤 수신거부한 사람에게는 보내지 않는다(suppressed).
 *
 * 보낸 뒤 공급자 webhook 이 알려 오는 바운스 · 스팸 신고는 `bounce_type` · `bounced_at` · `complained_at` 에 남는다
 * (docs/marketing.md "공급자 이벤트"). 목록의 스팸 신고율은 이 칸으로 센다.
 */
@Entity('marketing_email_sends')
@Index('uq_marketing_email_sends_post_contact', ['post_id', 'contact_id'], { unique: true })
@Index(['status', 'next_attempt_at'])
@Index(['contact_id', 'created_at'])
@Index(['provider_message_id'])
@Index(['channel_id', 'sent_at'])
export class MarketingEmailSend {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  @Column({ type: 'varchar' })
  channel_id: string;

  @Column({ type: 'varchar' })
  post_id: string;

  @Column({ type: 'varchar' })
  contact_id: string;

  /** queued | deferred | sent | failed | suppressed */
  @Column({ type: 'varchar', default: 'queued' })
  status: string;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: Date })
  next_attempt_at: Date;

  @Column({ type: 'varchar', default: '' })
  provider_message_id: string;

  /**
   * 이 메일을 보낸 메일 credential(= 공급자 계정). 그 credential 의 webhook 이벤트만 이 행을 바꾼다.
   * 이 칸이 생기기 전에 보낸 행은 '' 이고, 그때는 채널의 지금 credential 로 찾는다.
   */
  @Column({ type: 'varchar', default: '' })
  credential_id: string;

  @Column({ type: 'text', default: '' })
  error: string;

  @Column({ type: Date, nullable: true, default: null })
  sent_at: Date | null;

  /** '' | hard | soft | suppressed(공급자가 예전 바운스 · 신고 때문에 보내지 않음) — 공급자가 알려 온 미도달. */
  @Column({ type: 'varchar', default: '' })
  bounce_type: string;

  @Column({ type: Date, nullable: true, default: null })
  bounced_at: Date | null;

  /** 받은 사람이 스팸으로 신고한 시각. 목록의 신고율에 센다. */
  @Column({ type: Date, nullable: true, default: null })
  complained_at: Date | null;

  /** 공급자가 준 마지막 사유(수신 서버 응답 — 사람에게만 보이고 잘라서 둔다). */
  @Column({ type: 'text', default: '' })
  event_note: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
