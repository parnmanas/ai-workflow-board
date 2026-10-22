import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * MarketingListHold — 신고율 · 하드 바운스율이 높아 발송을 멈춘 수신 목록(docs/marketing.md "목록 발송 중지").
 *
 * 수신 목록은 계정의 연락처가 `lists` 로 나눠 갖는 이름이고, 여러 캠페인의 메일 채널이 같은 목록을 쓸 수 있다. 그래서
 * 멈춤도 (account_id, list_name) 단위다. `held` 인 목록으로는 메일을 보내지 않는다 — 큐의 메일은 버리지 않고 보류하고,
 * 새 메일은 승인되지 않는다. 사람이 사유를 적어 해제하면 `released` 가 되고, 신고율 · 하드 바운스율은 해제 이후의 것만 다시 센다.
 * 지난 행은 이력으로 남는다. (계정, 목록)마다 `held` 는 하나뿐이다(부분 유일 인덱스).
 */
@Entity('marketing_list_holds')
@Index('uq_marketing_list_holds_held', ['account_id', 'list_name'], { unique: true, where: "status = 'held'" })
@Index(['account_id', 'status'])
export class MarketingListHold {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  /** 소문자 목록 이름(연락처 lists · 채널 list_name 과 같은 규칙). */
  @Column({ type: 'varchar' })
  list_name: string;

  /** held | released */
  @Column({ type: 'varchar', default: 'held' })
  status: string;

  /** 멈춘 이유. complaint_rate | hard_bounce_rate. */
  @Column({ type: 'varchar', default: 'complaint_rate' })
  reason: string;

  /** 멈출 때의 수치 — since · sent · bounced · hard_bounced · complained · rate. */
  @Column({ type: 'simple-json', default: '{}' })
  stats: Record<string, unknown>;

  @Column({ type: 'varchar', default: '' })
  released_by: string;

  @Column({ type: 'varchar', default: '' })
  released_by_name: string;

  @Column({ type: Date, nullable: true, default: null })
  released_at: Date | null;

  @Column({ type: 'text', default: '' })
  release_note: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
