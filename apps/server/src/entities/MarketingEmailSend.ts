import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * MarketingEmailSend — 메일 한 통 = (게시물 × 연락처). 발송 큐이자 기록(docs/marketing.md "메일").
 *
 *   queued → sent | failed | suppressed      deferred(야간 보류 · 일시 오류 재시도) → queued 와 같이 처리
 *
 * `(post_id, contact_id)` 가 유일해 같은 메일이 같은 사람에게 두 번 나가지 않는다. 보낼 때마다 연락처의 현재 상태를
 * 다시 본다 — 큐에 들어간 뒤 수신거부한 사람에게는 보내지 않는다(suppressed).
 */
@Entity('marketing_email_sends')
@Index('uq_marketing_email_sends_post_contact', ['post_id', 'contact_id'], { unique: true })
@Index(['status', 'next_attempt_at'])
@Index(['contact_id', 'created_at'])
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

  @Column({ type: 'text', default: '' })
  error: string;

  @Column({ type: Date, nullable: true, default: null })
  sent_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
