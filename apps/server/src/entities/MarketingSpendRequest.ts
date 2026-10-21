import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { MINOR_AMOUNT_TRANSFORMER } from '../common/marketing/money';

/**
 * MarketingSpendRequest — 에이전트의 지출 요청과 그 상태 기계(docs/marketing.md "상태 기계").
 *
 *   pending ─approve→ approved ─execute→ executing → paid | failed | unknown
 *      ├─deny→ denied   ├─expire→ expired   └─cancel→ cancelled
 *   manual 공급자: approved 에서 사람이 "결제 완료"(paid) 또는 "실패"(failed)를 기록한다.
 *   unknown: 결과가 모호하다(타임아웃 · 5xx · 재시작). 다시 보내지 않고 사람이 대조해 paid | failed 로 닫는다.
 *
 * 금액 · 통화 · 수취인 · 목적 · 공급자 · payload 는 pending 을 떠나면 바뀌지 않고, 그 정규화 해시
 * (`payload_sha256`)를 승인 화면이 보여 주고 승인 요청이 그대로 돌려보내며 실행 직전에 다시 계산한다 —
 * 사람이 본 것과 실행되는 것이 갈리면 실행하지 않는다.
 */
@Entity('marketing_spend_requests')
@Index(['campaign_id', 'status'])
@Index(['status', 'expires_at'])
@Index('uq_marketing_spend_dedupe', ['campaign_id', 'dedupe_key'], { unique: true, where: "dedupe_key <> ''" })
export class MarketingSpendRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  campaign_id: string;

  @Column({ type: 'varchar' })
  channel_id: string;

  @Column({ type: 'bigint', transformer: MINOR_AMOUNT_TRANSFORMER })
  amount_minor: number;

  @Column({ type: 'varchar' })
  currency: string;

  /** 캠페인 허용 목록의 이름(요청 시점 스냅샷). */
  @Column({ type: 'varchar' })
  payee: string;

  /** 허용 목록 항목의 ref(광고 계정 id 등) 스냅샷. */
  @Column({ type: 'varchar', default: '' })
  payee_ref: string;

  @Column({ type: 'text' })
  purpose: string;

  @Column({ type: 'text', default: '' })
  expected_outcome: string;

  /** manual | webhook — 요청 시점 캠페인 설정의 스냅샷. 에이전트가 고르지 않는다. */
  @Column({ type: 'varchar' })
  provider: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  provider_credential_id: string | null;

  /** 실행 세부(에이전트 제공, 공급자에게 그대로 전달). */
  @Column({ type: 'simple-json', default: '{}' })
  payload: Record<string, any>;

  @Column({ type: 'varchar' })
  payload_sha256: string;

  /** pending | approved | executing | paid | failed | unknown | denied | expired | cancelled */
  @Column({ type: 'varchar', default: 'pending' })
  status: string;

  /** 요청자가 정한 멱등 키('' = 없음). 같은 캠페인에서 유일. */
  @Column({ type: 'varchar', default: '' })
  dedupe_key: string;

  @Column({ type: 'varchar', default: 'agent' })
  requested_by_type: string;

  @Column({ type: 'varchar', default: '' })
  requested_by_id: string;

  @Column({ type: 'varchar', default: '' })
  requested_by_name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  cycle_id: string | null;

  /**
   * 요청 시점에 2인 승인 대상이었는가. 승인 때는 이것과 그때의 임계값 중 **더 엄격한 쪽**을 쓴다 — 요청이 들어온 뒤
   * 임계값을 올리거나 없애도 이미 들어온 큰 요청이 한 사람 승인으로 내려가지 않는다.
   */
  @Column({ type: 'boolean', default: false })
  dual_required: boolean;

  /** 승인 기록 [{ user_id, name, at }] — 2인 규칙이면 둘. */
  @Column({ type: 'simple-json', default: '[]' })
  approvals: Array<{ user_id: string; name: string; at: string }>;

  @Column({ type: 'varchar', default: '' })
  decided_by: string;

  @Column({ type: 'varchar', default: '' })
  decided_by_name: string;

  @Column({ type: Date, nullable: true, default: null })
  decided_at: Date | null;

  @Column({ type: 'text', default: '' })
  decision_note: string;

  /** 이 시각이 지나도록 결정이 없으면 expired(= 거부). */
  @Column({ type: Date })
  expires_at: Date;

  /** 승인으로 reserve 가 묶인 예산 기간(원장 period_key). */
  @Column({ type: 'varchar', default: '' })
  period_key: string;

  @Column({ type: Date, nullable: true, default: null })
  executing_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  paid_at: Date | null;

  /** 공급자 거래 id. */
  @Column({ type: 'varchar', default: '' })
  provider_ref: string;

  @Column({ type: 'varchar', default: '' })
  receipt_url: string;

  /** 공급자 응답 요약(상태 코드 · 잘린 본문). 비밀 값은 넣지 않는다. */
  @Column({ type: 'simple-json', default: '{}' })
  provider_response: Record<string, any>;

  @Column({ type: 'text', default: '' })
  error: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
