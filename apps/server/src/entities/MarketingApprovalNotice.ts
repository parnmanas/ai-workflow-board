import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * MarketingApprovalNotice — 승인 대기 알림을 보냈다는 표시(docs/marketing.md "승인 대기 알림").
 *
 * (대상 행, 알림 종류) 하나에 한 행이다. 유일 인덱스가 곧 선점이다: 재시작한 뒤에도 다시 보내지 않고, 서버가 둘이어도
 * 한 번만 보낸다. 발송 **전에** 쓴다 — 발송이 실패하면 그 알림 한 번을 잃을 뿐이고, 그것이 중복 발송보다 낫다.
 * 상태 기계가 아니다. 무엇이 결정을 기다리는지는 언제나 원래 행(채널 · 게시물 · 편성 · 지출 요청)의 상태가 정한다.
 */
@Entity('marketing_approval_notices')
@Index('uq_marketing_approval_notices_entity_kind', ['entity_id', 'kind'], { unique: true })
export class MarketingApprovalNotice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  /** APPROVAL_NOTICE_KINDS(common/marketing/approval-notice.ts) */
  @Column({ type: 'varchar' })
  kind: string;

  /** 채널 · 게시물 · 편성 · 지출 요청의 id. list_hold는 중지 id:캠페인 id(kind 가 어느 테이블인지 정한다). */
  @Column({ type: 'varchar' })
  entity_id: string;

  @CreateDateColumn()
  created_at: Date;
}
