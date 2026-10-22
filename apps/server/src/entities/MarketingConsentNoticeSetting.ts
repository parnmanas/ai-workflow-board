import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * MarketingConsentNoticeSetting — 계정의 수신 동의 재확인 안내 설정(docs/marketing.md "동의 재확인 안내").
 *
 * 연락처가 계정 단위라 설정도 계정마다 하나다. 문구(제목 · 본문)와 발송 시점(기한 `lead_days` 일 전), 무응답 처리는
 * 운영자가 정한다. 기본은 꺼져 있다 — 켜기 전에는 지금처럼 2 년이 지난 동의가 발송에서 빠지기만 한다.
 * `version` 은 문구 · 무응답 처리가 바뀔 때마다 오른다(보낸 안내 · 유지 기록이 어느 문구였는지 남는다).
 */
@Entity('marketing_consent_notice_settings')
@Index('uq_marketing_consent_notice_settings_account', ['account_id'], { unique: true })
export class MarketingConsentNoticeSetting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  @Column({ type: 'varchar', default: '' })
  subject: string;

  @Column({ type: 'text', default: '' })
  body: string;

  /** 기한 며칠 전에 보내는가. */
  @Column({ type: 'int', default: 30 })
  lead_days: number;

  /** keep(무응답이면 유지) | lapse(무응답이면 철회) */
  @Column({ type: 'varchar', default: 'keep' })
  on_no_response: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'varchar', default: '' })
  updated_by: string;

  @Column({ type: 'varchar', default: '' })
  updated_by_name: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
