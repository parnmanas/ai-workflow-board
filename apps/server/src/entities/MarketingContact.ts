import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * MarketingContact — 마케팅 메일 수신자와 그 동의 증거(docs/marketing.md "메일").
 *
 * 설치 전체의 한 목록이다(여러 캠페인의 메일 채널이 `lists` 로 골라 쓴다). **사람만** 넣는다 — 에이전트에게는 연락처를
 * 추가하는 경로가 없다(수집한 주소로 스팸을 보내는 길을 막는다). 동의 증거(방법 · 시각 · 출처 · 문구 버전 · IP)를
 * 같이 받고, 동의가 2 년을 넘으면 재확인 전까지 발송에서 빠진다(정보통신망법 §50). 야간(수신자 현지 21–08시)
 * 수신은 `night_consent` 가 있어야 한다.
 *
 * 수신거부 · 삭제 후에도 `email_hash` 는 남는다(억제 목록) — 같은 주소를 다시 가져와도 되살아나지 않는다.
 * 삭제(erase)는 주소 · 이름을 지우고 해시만 남긴다.
 */
@Entity('marketing_contacts')
@Index('uq_marketing_contacts_email', ['account_id', 'email_hash'], { unique: true })
@Index('uq_marketing_contacts_token', ['unsubscribe_token'], { unique: true })
@Index(['account_id', 'status'])
export class MarketingContact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  /** 소문자 주소. 삭제(erase)되면 null. */
  @Column({ type: 'varchar', nullable: true, default: null })
  email: string | null;

  /** sha256(소문자 주소) — 억제 목록 키. */
  @Column({ type: 'varchar' })
  email_hash: string;

  @Column({ type: 'varchar', default: '' })
  name: string;

  /** 수신 목록 이름(소문자). */
  @Column({ type: 'simple-json', default: '[]' })
  lists: string[];

  /** subscribed | unsubscribed | bounced | complained | erased */
  @Column({ type: 'varchar', default: 'subscribed' })
  status: string;

  /** signup_form | checkout | event | import | other */
  @Column({ type: 'varchar' })
  consent_method: string;

  /** 동의를 받은 곳(가입 폼 URL · 행사 이름 · 가져온 파일 …). */
  @Column({ type: 'varchar' })
  consent_source: string;

  @Column({ type: Date })
  consent_at: Date;

  @Column({ type: 'varchar', default: '' })
  consent_text_version: string;

  @Column({ type: 'varchar', default: '' })
  consent_ip: string;

  /** 야간(21–08시) 광고성 정보 수신 동의. */
  @Column({ type: 'boolean', default: false })
  night_consent: boolean;

  /** ISO 3166-1 alpha-2. '' = 모름(한국 규칙을 적용한다). */
  @Column({ type: 'varchar', default: '' })
  country: string;

  /** IANA 시간대. 야간 판단에 쓴다. */
  @Column({ type: 'varchar', default: 'Asia/Seoul' })
  timezone: string;

  @Column({ type: 'varchar' })
  unsubscribe_token: string;

  @Column({ type: Date, nullable: true, default: null })
  unsubscribed_at: Date | null;

  /** link | one_click | manual | bounce | complaint */
  @Column({ type: 'varchar', default: '' })
  unsubscribe_source: string;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
