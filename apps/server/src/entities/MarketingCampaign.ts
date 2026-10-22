import { AfterLoad, BeforeInsert, BeforeUpdate, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { parseRuntimeSpec, runtimeIdentityKey } from '../common/runtime-spec';
import { MINOR_AMOUNT_TRANSFORMER } from '../common/marketing/money';

/**
 * MarketingCampaign — 제품 하나를 알리는 에이전트 마케팅 루프의 단위(docs/marketing.md).
 *
 * 캠페인은 "무엇을(브리프·목표) · 누가(agent_runtime) · 언제(cycle cadence) · 어디까지
 * (capabilities · 예산 한도 · 일일 상한)" 를 정한다. 실제 행동(채널 · 게시 · 지출 · 지표 · 피드백)은
 * 각자의 테이블에 campaign_id 로 붙는다.
 *
 * 예산 칼럼은 **한도**일 뿐 잔액이 아니다 — 사용액 · 보류액은 항상 append-only
 * marketing_ledger_entries 의 합으로 계산한다. `spend_version` 은 승인 트랜잭션이 이 행을
 * UPDATE 해 행 잠금을 잡는 용도다(Postgres 의 동시 승인 직렬화). 값 자체에는 의미가 없다.
 */
@Entity('marketing_campaigns')
@Index(['account_id', 'status'])
export class MarketingCampaign {
  @AfterLoad()
  @BeforeInsert()
  @BeforeUpdate()
  refreshRuntimeIdentity(): void {
    const spec = parseRuntimeSpec(this.agent_runtime);
    this.agent_key = spec ? runtimeIdentityKey(spec) : '';
  }

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  /** 알리는 제품의 Project. 피드백 티켓이 여기로 들어간다. */
  @Column({ type: 'varchar', nullable: true, default: null })
  project_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  /** UTM `utm_campaign` 과 티켓 tag `campaign:<slug>` 에 쓰는 고정 식별자(이름을 바꿔도 유지). */
  @Column({ type: 'varchar' })
  slug: string;

  /** draft | active | paused | archived */
  @Column({ type: 'varchar', default: 'draft' })
  status: string;

  /** 제품 설명 — 무엇인지, 누구를 위한지, 핵심 가치, 링크. 사이클 지시문의 머리. */
  @Column({ type: 'text', default: '' })
  product_brief: string;

  @Column({ type: 'text', default: '' })
  goal: string;

  @Column({ type: 'text', default: '' })
  target_audience: string;

  /** 켜진 기능(MARKETING_CAPABILITIES 의 부분집합). */
  @Column({ type: 'simple-json', default: '[]' })
  capabilities: string[];

  /** 캠페인 에이전트(RuntimeSpec). 사이클마다 이 실행이 깨어난다. */
  @Column({ type: 'simple-json', nullable: true, default: null })
  agent_runtime: Record<string, any> | null;

  /** agent_runtime 의 runtime identity key(계산값, 저장하지 않는다). */
  agent_key: string = '';

  @Column({ type: 'varchar', nullable: true, default: null })
  cycle_cron: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  cycle_interval_ms: number | null;

  @Column({ type: Date, nullable: true, default: null })
  next_cycle_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_cycle_at: Date | null;

  @Column({ type: 'int', default: 0 })
  cycle_count: number;

  /** 캠페인의 유일한 통화(ISO 4217). 지출 요청 통화가 다르면 거부된다. */
  @Column({ type: 'varchar', default: 'KRW' })
  currency: string;

  /** 캠페인 전체 지출 상한. 0 = 지출 불가. */
  @Column({ type: 'bigint', default: 0, transformer: MINOR_AMOUNT_TRANSFORMER })
  budget_total_minor: number;

  /** none | week | month (UTC) */
  @Column({ type: 'varchar', default: 'month' })
  budget_period: string;

  /** 기간 상한. budget_period 가 none 이면 무시. 0 = 기간 상한 없음(총 상한만). */
  @Column({ type: 'bigint', default: 0, transformer: MINOR_AMOUNT_TRANSFORMER })
  budget_period_minor: number;

  /** 건당 상한. 0 = 건당 상한 없음(다른 한도만). */
  @Column({ type: 'bigint', default: 0, transformer: MINOR_AMOUNT_TRANSFORMER })
  max_transaction_minor: number;

  /** 이 금액 이상이면 서로 다른 두 사람의 승인이 필요하다. 0 = 끔. */
  @Column({ type: 'bigint', default: 0, transformer: MINOR_AMOUNT_TRANSFORMER })
  dual_approval_threshold_minor: number;

  /** 승인 트랜잭션의 행 잠금용 카운터(의미 없는 값). */
  @Column({ type: 'int', default: 0 })
  spend_version: number;

  /**
   * 결제 방식 — manual(사람이 AWB 밖에서 결제하고 기록) | webhook(운영자 결제 엔드포인트로 서명된 실행 지시).
   * 직접 공급자(Meta Ads · Google Ads)는 캠페인이 아니라 수취인마다 정한다(payees[].provider) — 이 값은 경로가 없는
   * 수취인의 기본값이다. 에이전트가 고르지 않는다. 바꾸려면 marketing.approve_spend 가 필요하다.
   */
  @Column({ type: 'varchar', default: 'manual' })
  payment_provider: string;

  /** webhook 결제의 credential(webhook_url + secret). 서버만 복호화한다. */
  @Column({ type: 'varchar', nullable: true, default: null })
  payment_credential_id: string | null;

  /**
   * 지출 수취인 허용 목록 — 사람만 고친다. [{ name, ref?, note?, provider?, credential_id?, card_* ? }]
   * provider(meta_ads · google_ads · stripe_issuing)가 있는 수취인은 그 공급자의 대상(ref — 광고 캠페인 상한 · 카드 소지자)으로만
   * 돈이 간다(docs/marketing.md "직접 결제 어댑터"). card_single_use · card_categories · card_max_minor 는 stripe_issuing 수취인의
   * 카드 통제다. provider 가 없으면 위의 결제 방식(manual · webhook)을 쓴다.
   */
  @Column({ type: 'simple-json', default: '[]' })
  payees: Array<{
    name: string;
    ref?: string;
    note?: string;
    provider?: 'meta_ads' | 'google_ads' | 'stripe_issuing';
    credential_id?: string;
    card_single_use?: boolean;
    card_id?: string;
    card_categories?: string[];
    card_max_minor?: number;
  }>;

  /** 추적 링크 목적지로 허용하는 도메인(오픈 리다이렉트 방지). */
  @Column({ type: 'simple-json', default: '[]' })
  allowed_domains: string[];

  /** 모든 커뮤니티 게시물 끝에 서버가 붙이는 공개 문구. */
  @Column({ type: 'text', default: '' })
  disclosure: string;

  /** DEFAULT_MARKETING_LIMITS 의 부분 덮어쓰기. */
  @Column({ type: 'simple-json', default: '{}' })
  limits: Record<string, number>;

  /** backlog | todo */
  @Column({ type: 'varchar', default: 'backlog' })
  feedback_ticket_status: string;

  /** 피드백 티켓의 assignee(RuntimeSpec). 없으면 Project 기본 assignee. */
  @Column({ type: 'simple-json', nullable: true, default: null })
  improvement_assignee: Record<string, any> | null;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
