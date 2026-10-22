import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * MarketingConsentNotice — 수신 동의 재확인 안내 한 통(docs/marketing.md "동의 재확인 안내").
 *
 * 정보통신망법 §50⑧ · 시행령 §62의3 은 동의일부터 2 년마다(2 년이 되는 날 전까지) 받는 사람에게 동의 사실을 알리게
 * 한다. (연락처, 기한)마다 한 행이라 같은 주기에 두 번 보내지 않는다. 보낸 행은 법정 통지를 했다는 기록이다:
 * 언제 · 어느 채널(발신자)로 · 어느 공급자 message id 로 · 무응답을 무엇으로 안내했는지(`policy`).
 *
 *   queued → sending → sent | failed | skipped      deferred(야간 · 발신 채널 없음 · 꺼짐 · 일시 오류) → queued 와 같이 처리
 *
 * `token` 은 이 안내의 "동의 유지" 링크다(256-bit, REST 응답에 나가지 않는다). 철회는 연락처의 수신거부 링크를 그대로 쓴다.
 * 공급자가 알려 온 바운스 · 스팸 신고는 `bounce_type` · `event_note` 에 남고, 닿지 않은 안내로는 동의를 잇지 않는다.
 */
@Entity('marketing_consent_notices')
@Index('uq_marketing_consent_notices_cycle', ['contact_id', 'due_at'], { unique: true })
@Index('uq_marketing_consent_notices_token', ['token'], { unique: true })
@Index(['status', 'next_attempt_at'])
@Index(['status', 'due_at'])
@Index(['account_id', 'created_at'])
@Index(['provider_message_id'])
export class MarketingConsentNotice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  contact_id: string;

  /** 이 안내가 확인하는 동의의 기한(기준점 + 2 년). 이 시각 전에 보내야 한다 — 지나면 보내지 않는다(skipped). */
  @Column({ type: Date })
  due_at: Date;

  /** queued | deferred | sending | sent | failed | skipped */
  @Column({ type: 'varchar', default: 'queued' })
  status: string;

  /** 보낼 때 안내한 무응답 처리: keep(유지) | lapse(철회). 보내기 전에는 ''. */
  @Column({ type: 'varchar', default: '' })
  policy: string;

  /** 보낼 때 쓴 문구의 버전(MarketingConsentNoticeSetting.version). */
  @Column({ type: 'int', default: 0 })
  settings_version: number;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: Date })
  next_attempt_at: Date;

  /** 발신자로 쓴 메일 채널 · credential. */
  @Column({ type: 'varchar', default: '' })
  channel_id: string;

  @Column({ type: 'varchar', default: '' })
  credential_id: string;

  @Column({ type: 'varchar', default: '' })
  provider_message_id: string;

  @Column({ type: 'varchar' })
  token: string;

  @Column({ type: Date, nullable: true, default: null })
  sent_at: Date | null;

  /** 받은 사람이 이 안내의 유지 링크로 동의를 유지한 시각. */
  @Column({ type: Date, nullable: true, default: null })
  kept_at: Date | null;

  /** "응답이 없으면 유지" 로 나간 안내의 기한이 와서 동의를 그 기한부터 이어 준 시각(연락처 consent_renewed_at). */
  @Column({ type: Date, nullable: true, default: null })
  renewed_at: Date | null;

  /** '' | hard | soft | suppressed — 공급자가 알려 온 미도달. 닿지 않은 안내로는 동의를 잇지 않는다. */
  @Column({ type: 'varchar', default: '' })
  bounce_type: string;

  /** 공급자가 알려 온 마지막 사유(바운스 · 스팸 신고 — 사람에게만 보이고 잘라서 둔다). */
  @Column({ type: 'text', default: '' })
  event_note: string;

  /** 마지막 사유(미룬 이유 · 공급자 거절 · 건너뛴 이유). */
  @Column({ type: 'text', default: '' })
  error: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
