import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * MarketingAuditEvent — 마케팅의 append-only 감사 로그(docs/marketing.md).
 *
 * 모든 결정(승인 · 거부 · 수정) · 외부 발신 · 결제 호출과 그 응답 · 동의 변경 · 설정 변경이
 * 한 줄씩 남는다. 이 테이블을 UPDATE/DELETE 하는 코드 경로는 없고, ActivityLog 와 달리
 * db-retention.service.ts 의 정리 대상이 아니다 — 돈과 외부 발신의 기록은 30 일 뒤에
 * 사라지면 안 된다. 캠페인을 지워도 이 행은 남는다.
 */
@Entity('marketing_audit_events')
@Index(['campaign_id', 'created_at'])
@Index(['account_id', 'created_at'])
export class MarketingAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar', default: '' })
  campaign_id: string;

  /** MARKETING_AUDIT_ENTITY_TYPES */
  @Column({ type: 'varchar' })
  entity_type: string;

  @Column({ type: 'varchar', default: '' })
  entity_id: string;

  /** 점 표기 동작 이름(예: campaign.created, spend.approved, post.published). */
  @Column({ type: 'varchar' })
  action: string;

  /** user | agent | system | public */
  @Column({ type: 'varchar' })
  actor_type: string;

  @Column({ type: 'varchar', default: '' })
  actor_id: string;

  @Column({ type: 'varchar', default: '' })
  actor_name: string;

  /** 사람이 읽는 한 줄 요약. */
  @Column({ type: 'text', default: '' })
  summary: string;

  /** 구조화된 세부(금액 · 이전/이후 값 · 응답 상태 · 해시 …). 비밀 값은 넣지 않는다. */
  @Column({ type: 'simple-json', default: '{}' })
  detail: Record<string, unknown>;

  @Column({ type: 'varchar', nullable: true, default: null })
  ip: string | null;

  @CreateDateColumn()
  created_at: Date;
}
