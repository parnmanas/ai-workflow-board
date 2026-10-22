import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('marketing_contact_consents')
@Index('uq_marketing_consent_brand', ['account_id', 'contact_id', 'brand_id'], { unique: true })
@Index('uq_marketing_consent_token', ['unsubscribe_token'], { unique: true })
export class MarketingContactConsent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) contact_id: string;
  @Column({ type: 'varchar' }) brand_id: string;
  @Column({ type: 'varchar', default: 'subscribed' }) status: string;
  /** signup_form | checkout | event | import | other */
  @Column({ type: 'varchar' })
  consent_method: string;

  /** 동의를 받은 곳(가입 폼 URL · 행사 이름 · 가져온 파일 …). */
  @Column({ type: 'varchar' })
  consent_source: string;

  /** 동의한 시각(증거). 더 새로운 동의(가져오기 · 재확인 안내의 "유지" 링크)가 오면 바뀐다. */
  @Column({ type: Date })
  consent_at: Date;

  /**
   * 재확인 안내가 "응답이 없으면 유지" 로 나간 주기의 기한 — 동의는 이 시각부터 다시 2 년이다(docs/marketing.md
   * "동의 재확인 안내"). 기산일은 원래 동의일이라(시행령 §62의3) 안내를 보낸 날이 아니라 그 주기의 기한을 넣는다.
   * 동의 기간의 기준점은 consent_at 과 이것 중 늦은 쪽이다(`consentAnchor`).
   */
  @Column({ type: Date, nullable: true, default: null })
  consent_renewed_at: Date | null;

  @Column({ type: 'varchar', default: '' })
  consent_text_version: string;

  @Column({ type: 'varchar', default: '' })
  consent_ip: string;

  /** 야간(21–08시) 광고성 정보 수신 동의. */
  @Column({ type: 'boolean', default: false })
  night_consent: boolean;

  @Column({ type: 'varchar' })
  unsubscribe_token: string;

  @Column({ type: Date, nullable: true, default: null })
  unsubscribed_at: Date | null;

  /**
   * link | one_click | manual | mailto(List-Unsubscribe 메일 회신) | bounce | complaint | provider(공급자 쪽 수신거부).
   * bounce · complaint · provider 는 공급자 webhook 이 남긴다(docs/marketing.md "공급자 이벤트").
   */
  @Column({ type: 'varchar', default: '' })
  unsubscribe_source: string;

  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
