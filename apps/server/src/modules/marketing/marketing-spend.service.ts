import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, MoreThan, Repository, type EntityManager } from 'typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingSpendRequest } from '../../entities/MarketingSpendRequest';
import { MarketingLedgerEntry } from '../../entities/MarketingLedgerEntry';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { Credential } from '../../entities/Credential';
import { canonicalJson, periodKey, requestTotals, spendPayloadHash, spendViolations } from '../../common/marketing/budget';
import { formatMinorAmount, normalizeCurrency, parseMinorAmount, MarketingMoneyError } from '../../common/marketing/money';
import {
  SPEND_REQUEST_TTL_MS,
  SYSTEM_MARKETING_ACTOR,
  type MarketingActor,
} from '../../common/marketing/marketing-constants';
import { flushSqljs } from '../../db';
import { LogService } from '../../services/log.service';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { MarketingChannelService } from './marketing-channel.service';
import { MarketingBudgetService } from './marketing-budget.service';
import { marketingError } from './marketing-errors';
import { findPayee, type MarketingPayee } from './marketing-campaign.logic';
import { activeAllocation, appendLedger, loadLedger, lockCampaign } from './marketing-ledger';
import { credentialFingerprint, resolveDirectPaymentCredential, resolveMarketingSecret } from './marketing-credential';
import {
  PaymentNotSentError,
  PaymentReadError,
  executeWebhookPayment,
  readWebhookSecret,
  type PaymentOutcome,
} from './marketing-payments';
import { DIRECT_PAYMENT_ADAPTERS, type DirectAdapterContext, type DirectInspection, type TargetReport } from './marketing-payment-adapters';
import type { IssuedCardView } from './marketing-payment-stripe';
import {
  DIRECT_FAIL_GRACE_MS,
  DIRECT_PAYMENT_PROVIDERS,
  DIRECT_PAYMENT_PROVIDER_LABELS,
  DIRECT_PROVIDER_SPECS,
  PaymentRuleError,
  directPayeeProblem,
  directPlanProblems,
  directTargetKey,
  isAutomaticPaymentProvider,
  isDirectPaymentProvider,
  isExclusiveTargetProvider,
  payeeRoute,
  sameRoute,
  type CardPlan,
  type CeilingPlan,
  type DirectPaymentProvider,
  type DirectPlan,
  type PaymentRoute,
} from '../../common/marketing/payment-routes';

const MAX_PAYLOAD_BYTES = 8 * 1024;
const SWEEP_MS = 5 * 60_000;
/** executing 이 이보다 오래 남아 있으면(프로세스가 응답을 기록하지 못했다) unknown 으로 돌린다. */
const STUCK_EXECUTING_MS = 10 * 60_000;
/** approved 인 자동 실행 요청이 이만큼 지나도 실행되지 않았으면(승인 직후 프로세스가 죽었다) 지금 실행한다. */
const STRANDED_APPROVED_MS = 60_000;
/** 승인되면 서버가 스스로 실행하는 결제 방식. */
const AUTOMATIC_PROVIDERS = ['webhook', ...DIRECT_PAYMENT_PROVIDERS];
/**
 * 직접 공급자의 승인이 이보다 오래되면 실행하지 않는다 — 장애 · 복구 · 인스턴스 이관 뒤에 며칠 묵은 승인이 실행되지 않게.
 * 보통은 승인 직후, 늦어도 sweep(5분)이 실행한다.
 */
const DIRECT_APPROVAL_MAX_AGE_MS = 60 * 60_000;
/** 직접 공급자의 대상에 열린 요청이 있다고 보는 상태(uq_marketing_spend_open_target 과 같다). */
const OPEN_TARGET_STATUSES = ['pending', 'approved', 'executing', 'unknown'];
/** 요청 때 공급자 확인이 실패한 대상은 이만큼 다시 묻지 않는다 — 에이전트의 반복 요청이 공급자 호출로 번지지 않게. */
const PROVIDER_BACKOFF_MS = 10 * 60_000;
/**
 * 공급자를 읽은 뒤 금액 때문에 거절된 대상(계정 최소 상한 · 청구 단위 · 상한 최대값)은 이만큼 쉰다 — 금액을 고쳐 다시 물을 수 있게
 * 짧게, 그러나 금액만 바꿔 되풀이해도 그때마다 공급자를 읽지는 않게.
 */
const AMOUNT_RETRY_MS = 60_000;

export interface PayeePaymentCheck extends TargetReport {
  payee: string;
  provider: DirectPaymentProvider;
  ref: string;
  credential_id: string;
  /** 이 대상에 열린 지출 요청(상한 공급자 — 대상마다 하나). 다른 계정의 것이면 `{ id: '', status: 'other_account' }`. 카드 공급자는 null. */
  open_request: { id: string; status: string } | null;
  /** 읽기가 실패했을 때 공급자가 준 글(정리 · 비밀 지움) — 사람이 보는 연결 확인에만 싣는다. */
  provider_message_untrusted?: string;
}

export interface PaymentCheckResult {
  checked_at: string;
  payees: PayeePaymentCheck[];
}

/** 요청별 공급자 확인 — 판정이 아니라 대조를 돕는 표시다. 상한은 지금 값의 위치, 카드는 이 요청의 카드. */
export type SpendInspection =
  | {
    kind: 'ceiling';
    spend_request_id: string;
    status: string;
    from: string;
    to: string;
    from_minor: number;
    to_minor: number;
    /** 지금 상한(공급자 단위), 없으면 null. */
    observed: string | null;
    observed_minor: number | null;
    /** 지금 상한이 계획의 어디에 있나. */
    position: 'at_target' | 'at_from' | 'other' | 'no_ceiling';
    report: TargetReport;
    checked_at: string;
  }
  | {
    kind: 'card';
    spend_request_id: string;
    status: string;
    limit_minor: number;
    /** found: 이 요청의 카드가 있다 · none: 실행 시각 ±1일 범위를 다 봤고 없다 · incomplete: 다 보지 못했다(없음이 아니다). */
    result: 'found' | 'none' | 'incomplete';
    cards: IssuedCardView[];
    api_version: string;
    checked_at: string;
  };

export interface SpendDecision {
  request: MarketingSpendRequest;
  /** 2인 규칙에서 첫 승인만 기록되고 아직 pending 이면 false. */
  final: boolean;
}

/**
 * MarketingSpendService — 지출 요청의 상태 기계(docs/marketing.md "예산 편성 · 집행 · 결제").
 *
 * 돈이 움직이는 모든 전이(승인 → reserve, 결제 → release+capture, 실패 → release, 환불 → refund)는
 * lockCampaign 트랜잭션 안에서 상태 CAS 와 원장 쓰기와 감사 기록을 한 커밋으로 한다. 사람만 승인하고
 * (REST + marketing.approve_spend), 승인자 identity 는 로그인 세션에서만 온다. 이 서비스에는 에이전트가
 * 승인하는 경로가 없다.
 *
 * webhook 실행 순서: approved → (CAS) executing 커밋 · sql.js 즉시 flush → payload 해시 재확인 → 외부 호출 →
 * 결과 커밋. executing 은 절대 다시 보내지 않는다 — 재시작 시 unknown 으로 돌려 사람이 대조한다.
 */
@Injectable()
export class MarketingSpendService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private readonly enabled = (process.env.MARKETING_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
  /** 테스트가 결제 엔드포인트 · 공급자 호출을 가로챌 수 있게(기본은 전역 fetch). */
  fetchImpl: typeof fetch | undefined;
  /**
   * 요청 때 공급자를 읽은 뒤 거절된 (캠페인, 대상, credential 지문) → 다시 묻지 않을 때까지. 수취인 · credential 을 고치면 키가 바뀐다.
   * `openTarget` 은 다른 계정의 열린 요청 때문에 쉬는 것 — 그 요청이 닫히면(DB 로 본다) 바로 풀린다.
   */
  private readonly providerBackoff = new Map<string, { until: number; reason: string; status: number; openTarget?: boolean }>();

  constructor(
    @InjectRepository(MarketingSpendRequest) private readonly spendRepo: Repository<MarketingSpendRequest>,
    @InjectRepository(MarketingLedgerEntry) private readonly ledgerRepo: Repository<MarketingLedgerEntry>,
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly channels: MarketingChannelService,
    private readonly budget: MarketingBudgetService,
    private readonly audit: MarketingAuditService,
    private readonly logService: LogService,
    hooks: MarketingCampaignHooks,
  ) {
    hooks.onCampaignStopped(async (campaign, actor) => {
      await this.cancelPending(campaign, actor, `campaign ${campaign.status}`);
    });
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    const bootedAt = new Date();
    // 부팅 직후 한 번: 이전 프로세스가 결제를 보내던 중에 죽은 요청은 결과를 모른다(unknown) — 다시 보내지 않는다.
    setTimeout(() => {
      this.recoverInterrupted(bootedAt).then(() => this.sweep()).catch(() => {});
    }, 5_000).unref();
    this.timer = setInterval(() => { this.sweep().catch(() => {}); }, SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── 조회 ────────────────────────────────────────────────────────────────

  async get(id: string, accountId: string): Promise<MarketingSpendRequest> {
    const row = id ? await this.spendRepo.findOne({ where: { id } }) : null;
    if (!row || (!accountId || row.account_id !== accountId)) throw marketingError(404, 'spend request not found');
    return row;
  }

  async list(campaign: MarketingCampaign, status?: string, limit = 100): Promise<MarketingSpendRequest[]> {
    return this.spendRepo.find({
      where: { campaign_id: campaign.id, ...(status ? { status } : {}) },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async ledgerFor(requestId: string): Promise<MarketingLedgerEntry[]> {
    return this.ledgerRepo.find({ where: { spend_request_id: requestId }, order: { created_at: 'ASC' } });
  }

  async countRequestedSince(campaignId: string, since: Date): Promise<number> {
    return this.spendRepo.count({ where: { campaign_id: campaignId, created_at: MoreThan(since) } });
  }

  // ── 요청 ────────────────────────────────────────────────────────────────

  /**
   * 요청 — 한도 · 통화 · 허용 수취인 · 채널 편성을 미리 검사해 넘으면 저장하지 않고 거부한다(사유는 감사 로그에
   * 남는다). dedupe_key 가 같으면 기존 요청을 돌려준다.
   */
  async request(
    campaign: MarketingCampaign,
    body: Record<string, unknown>,
    actor: MarketingActor,
    opts: { cycleId?: string | null } = {},
  ): Promise<{ request: MarketingSpendRequest; duplicate: boolean }> {
    if (campaign.status !== 'active') throw marketingError(409, `campaign is ${campaign.status} — spend can be requested only on an active campaign`);
    const dedupeKey = typeof body.dedupe_key === 'string' ? body.dedupe_key.trim() : '';
    if (dedupeKey && !/^[A-Za-z0-9:_.-]{1,120}$/.test(dedupeKey)) throw marketingError(400, 'dedupe_key must be 1-120 chars of letters, digits, ":", "_", ".", "-"');
    if (dedupeKey) {
      const existing = await this.spendRepo.findOne({ where: { campaign_id: campaign.id, dedupe_key: dedupeKey } });
      if (existing) return { request: existing, duplicate: true };
    }
    const channel = await this.channels.getInCampaign(campaign, String(body.channel_id || ''));
    this.channels.assertUsable(channel);
    let amount: number;
    let currency: string;
    try {
      amount = parseMinorAmount(body.amount_minor, 'amount_minor');
      currency = normalizeCurrency(body.currency ?? campaign.currency);
    } catch (e) {
      if (e instanceof MarketingMoneyError) throw marketingError(400, e.message);
      throw e;
    }
    const payeeName = typeof body.payee === 'string' ? body.payee.trim() : '';
    const payee = payeeName ? findPayee(campaign, payeeName) : null;
    if (!payee) {
      throw marketingError(400, `payee "${payeeName}" is not on the campaign's payee allowlist (${(campaign.payees || []).map((p) => p.name).join(', ') || 'empty'}) — a human adds payees`);
    }
    const route = payeeRoute(campaign, payee);
    const direct = isDirectPaymentProvider(route.provider) ? route.provider : null;
    const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : '';
    if (!purpose || purpose.length > 2000) throw marketingError(400, 'purpose is required (max 2000 characters)');
    const expected = typeof body.expected_outcome === 'string' ? body.expected_outcome.trim() : '';
    if (expected.length > 2000) throw marketingError(400, 'expected_outcome must be at most 2000 characters');
    if (actor.type === 'agent' && !expected) throw marketingError(400, 'expected_outcome is required — say what this spend should achieve and how you will measure it');
    const payload = body.payload === undefined || body.payload === null ? {} : body.payload;
    if (typeof payload !== 'object' || Array.isArray(payload)) throw marketingError(400, 'payload must be a JSON object');
    if (Buffer.byteLength(canonicalJson(payload), 'utf8') > MAX_PAYLOAD_BYTES) throw marketingError(400, `payload must be at most ${MAX_PAYLOAD_BYTES} bytes`);
    if (direct && Object.keys(payload).length) {
      throw marketingError(400, `payee "${payee.name}" is paid through ${DIRECT_PAYMENT_PROVIDER_LABELS[direct]} — omit payload; the server reads the target and builds the exact change people approve`);
    }

    const now = new Date();
    const [ledger, allocation] = await Promise.all([
      this.ledgerRepo.find({ where: { campaign_id: campaign.id } }),
      this.budget.activeFor(campaign.id, channel.id),
    ]);
    const violations = spendViolations(campaign, ledger, now, { amount_minor: amount, currency, channel_id: channel.id }, allocation ? allocation.amount_minor : null);
    if (violations.length) {
      await this.audit.record({
        accountId: campaign.account_id,
        campaignId: campaign.id,
        entityType: 'spend_request',
        entityId: '',
        action: 'spend.refused',
        actor,
        summary: `지출 요청 거부(한도): ${formatMinorAmount(amount, currency)} → ${payee.name}`,
        detail: { channel_id: channel.id, amount_minor: amount, currency, violations },
      });
      throw marketingError(409, `spend request refused: ${violations.join('; ')}`);
    }

    // 직접 공급자: 한도 검사(로컬)를 통과한 뒤에만 공급자를 읽는다 — 거절될 요청이 공급자 호출을 쓰지 않게.
    const prepared = direct ? await this.prepareDirect(campaign, payee, route, direct, amount, currency, actor) : null;

    const fields = {
      campaign_id: campaign.id,
      channel_id: channel.id,
      amount_minor: amount,
      currency,
      payee: payee.name,
      payee_ref: route.ref,
      purpose,
      provider: route.provider,
      provider_credential_id: route.credential_id,
      payload: (prepared ? prepared.plan : payload) as Record<string, unknown>,
    };
    let saved: MarketingSpendRequest;
    try {
      saved = await this.spendRepo.save(this.spendRepo.create({
        account_id: campaign.account_id,
        ...fields,
        target_key: prepared ? prepared.targetKey : '',
        expected_outcome: expected,
        payload_sha256: spendPayloadHash(fields),
        dual_required: campaign.dual_approval_threshold_minor > 0 && amount >= campaign.dual_approval_threshold_minor,
        status: 'pending',
        dedupe_key: dedupeKey,
        requested_by_type: actor.type === 'agent' ? 'agent' : 'user',
        requested_by_id: actor.id,
        requested_by_name: actor.name,
        cycle_id: opts.cycleId || null,
        approvals: [],
        expires_at: new Date(now.getTime() + SPEND_REQUEST_TTL_MS),
      }));
    } catch (e) {
      if (dedupeKey) {
        const winner = await this.spendRepo.findOne({ where: { campaign_id: campaign.id, dedupe_key: dedupeKey } });
        if (winner) return { request: winner, duplicate: true };
      }
      if (prepared && prepared.targetKey) {
        // 같은 대상에 열린 요청이 그 사이 생겼다(uq_marketing_spend_open_target). 다시 볼 때 이미 닫혔을 수도 있다 — 그래도 DB 오류
        // 문구를 그대로 내보내지 않는다.
        const open = await this.openRequestForTarget(prepared.targetKey);
        if (open) throw marketingError(409, this.openTargetMessage(open, campaign.account_id));
        if (/unique|duplicate key|23505/i.test(String((e as any)?.message || '') + String((e as any)?.code || ''))) {
          throw marketingError(409, 'another spend request for this ad campaign was opened at the same moment — check its state and try again');
        }
      }
      throw e;
    }
    await this.audit.record({
      accountId: campaign.account_id,
      campaignId: campaign.id,
      entityType: 'spend_request',
      entityId: saved.id,
      action: 'spend.requested',
      actor,
      summary: `지출 요청: ${formatMinorAmount(amount, currency)} → ${payee.name} (${channel.name}) — ${purpose.slice(0, 120)}`,
      detail: {
        channel_id: channel.id, amount_minor: amount, currency, payee: payee.name, provider: saved.provider, payload_sha256: saved.payload_sha256,
        ...(prepared
          ? {
            target_key: prepared.targetKey,
            ...(prepared.plan.plan === 'raise_ceiling'
              ? { from_minor: prepared.plan.from_minor, to_minor: prepared.plan.to_minor }
              : { limit_minor: prepared.plan.limit_minor, single_use: prepared.plan.single_use }),
          }
          : {}),
      },
    });
    this.audit.notify(campaign.account_id, campaign.id, 'spend_request', saved.id, 'requested');
    return { request: saved, duplicate: false };
  }

  /**
   * 직접 공급자의 요청 준비 — 대상에 열린 요청이 없는지, credential 이 이 계정의 그 공급자 것인지 본 뒤 대상을 읽어 실행 계획을
   * 만든다(쓰기 없음). 공급자 확인이 실패하면 저장하지 않고 거부하며(감사 `spend.refused`), 그 대상은 잠시 다시 묻지 않는다.
   * 거부 문구는 "사람이 고쳐야 한다" 와 "다음 사이클에 다시" 를 구분한다 — 에이전트가 헛되이 되풀이하지 않게.
   */
  private async prepareDirect(
    campaign: MarketingCampaign,
    payee: MarketingPayee,
    route: PaymentRoute,
    provider: DirectPaymentProvider,
    amount: number,
    currency: string,
    actor: MarketingActor,
  ): Promise<{ plan: DirectPlan; targetKey: string }> {
    const label = DIRECT_PAYMENT_PROVIDER_LABELS[provider];
    let targetKey: string;
    try {
      targetKey = directTargetKey(provider, route.ref);
    } catch (e: any) {
      throw marketingError(400, `payee "${payee.name}": ${e?.message || e} — a person fixes the payee ref`);
    }
    // 상한 공급자만 대상마다 열린 요청이 하나다(카드는 서로 영향이 없다). 같은 계정의 열린 요청은 공급자를 읽기 전에 바로 알린다.
    // 다른 계정의 것은 이 credential 이 그 대상을 실제로 읽을 수 있음을(계획이 만들어짐을) 확인한 뒤에만, id · 상태 없이 알린다 —
    // 대상 ref 를 짐작해 다른 계정의 지출을 엿보지 못하게.
    const exclusive = isExclusiveTargetProvider(provider);
    const open = exclusive ? await this.openRequestForTarget(targetKey) : null;
    if (open && open.account_id === campaign.account_id) throw marketingError(409, this.openTargetMessage(open, campaign.account_id));
    const { fields, fingerprint } = await resolveDirectPaymentCredential(this.credentialRepo, provider, route.credential_id || '', campaign.account_id);
    DIRECT_PAYMENT_ADAPTERS[provider].checkCredential(fields);
    const backoffKey = `${campaign.id}\u0000${targetKey}\u0000${fingerprint}`;
    /**
     * 거절 — 감사(`spend.refused`)에 남기고 던질 오류를 돌려준다. 문구는 "다음 사이클에 다시" · "금액을 바꾼다" · "사람이 고쳐야 한다" 를
     * 나눈다. 공급자를 읽은 뒤의 거절이면 그 (캠페인, 대상, credential) 을 쉬게 한다: 대상 · 인증 문제는 10분, 금액에 달린 것은 1분.
     */
    const refuse = async (e: PaymentRuleError | PaymentReadError, afterRead: boolean): Promise<Error> => {
      const retryable = e instanceof PaymentReadError && e.retryable;
      const amountProblem = !retryable && e.status === 400;
      const status = retryable ? 502 : amountProblem ? 400 : 409;
      const reason = `${label} check for payee "${payee.name}" failed: ${e.message} — ${retryable
        ? 'the platform may be unavailable; try again in a later cycle'
        : amountProblem ? 'change the amount or ask a person' : 'a person must fix the payee, its credential, the campaign currency or the ad campaign on the platform; do not retry'}`;
      if (afterRead) this.providerBackoff.set(backoffKey, { until: Date.now() + (amountProblem ? AMOUNT_RETRY_MS : PROVIDER_BACKOFF_MS), reason, status });
      await this.audit.record({
        accountId: campaign.account_id,
        campaignId: campaign.id,
        entityType: 'spend_request',
        entityId: '',
        action: 'spend.refused',
        actor,
        summary: `지출 요청 거부(${label} 확인): ${formatMinorAmount(amount, currency)} → ${payee.name}`,
        detail: {
          provider, target_key: targetKey, amount_minor: amount, currency, error: e.message, retryable,
          ...(e instanceof PaymentReadError && e.providerMessage ? { provider_message_untrusted: e.providerMessage } : {}),
        },
      });
      return marketingError(status, reason);
    };
    // 금액 · 통화(단위 변환)는 공급자를 읽기 전에 본다 — 공급자 호출 없이 거절하고 쉬게 하지 않는다(금액을 고쳐 바로 다시 물을 수 있다).
    try {
      DIRECT_PAYMENT_ADAPTERS[provider].checkAmount(amount, currency, payee);
    } catch (e: any) {
      if (e instanceof PaymentRuleError) throw await refuse(e, false);
      throw e;
    }
    const now = Date.now();
    for (const [key, entry] of this.providerBackoff) if (entry.until <= now) this.providerBackoff.delete(key);
    const held = this.providerBackoff.get(backoffKey);
    if (held && held.openTarget && !open) this.providerBackoff.delete(backoffKey);
    else if (held) {
      throw marketingError(held.status, `${held.reason} (not asking ${label} again before ${new Date(held.until).toISOString()} — wait until then${held.openTarget ? ' or until that request is decided' : ''}${held.status === 400 ? ', then ask once with an amount that fits' : ''})`);
    }
    let plan: DirectPlan;
    try {
      plan = await DIRECT_PAYMENT_ADAPTERS[provider].plan({ ref: route.ref, fields, fingerprint, amountMinor: amount, currency, payee, ctx: this.adapterContext() });
    } catch (e: any) {
      if (e instanceof PaymentRuleError || e instanceof PaymentReadError) throw await refuse(e, true);
      throw e;
    }
    this.providerBackoff.delete(backoffKey);
    if (open) {
      // 다른 계정의 열린 요청 — 이것도 공급자를 읽은 뒤의 거절이라 쉬게 한다(되풀이할 때마다 남의 광고 계정을 읽지 않게). 이 credential 이
      // 대상을 읽을 수 있음은 방금 확인했으니 쉬는 동안 같은 문장을 보여도 된다. 그 요청이 닫히면 위에서 바로 푼다.
      const reason = this.openTargetMessage(open, campaign.account_id);
      this.providerBackoff.set(backoffKey, { until: Date.now() + PROVIDER_BACKOFF_MS, reason, status: 409, openTarget: true });
      throw marketingError(409, reason);
    }
    return { plan, targetKey: exclusive ? targetKey : '' };
  }

  private async openRequestForTarget(targetKey: string): Promise<MarketingSpendRequest | null> {
    // '' 는 manual · webhook · 카드 요청 모두의 기본값이다 — 대상이 아니다.
    if (!targetKey) return null;
    return this.spendRepo.findOne({ where: { target_key: targetKey, status: In(OPEN_TARGET_STATUSES) } });
  }

  private openTargetMessage(open: MarketingSpendRequest, accountId: string): string {
    if (open.account_id !== accountId) {
      return 'this ad campaign already has an open spend request in another account — only one open request per ad campaign; wait until it is decided';
    }
    return `another spend request for this target is still open (${open.status}, ${open.id}) — wait until it is decided or reconciled; only one open request per ad campaign`;
  }

  private adapterContext(): DirectAdapterContext {
    return { fetchImpl: this.fetchImpl, env: process.env };
  }

  // ── 사람의 결정 ──────────────────────────────────────────────────────────

  /**
   * 승인. `payloadSha256` 은 승인자가 화면에서 본 해시다 — 저장된 해시와 다르면(다른 요청을 보고 눌렀거나
   * 내용이 바뀌었으면) 거부한다. 2인 규칙 대상이면 첫 승인은 기록만 하고 pending 으로 둔다.
   */
  async approve(id: string, accountId: string, actor: MarketingActor, payloadSha256: string, note = ''): Promise<SpendDecision> {
    if (actor.type !== 'user' || !actor.id) throw marketingError(403, 'only a signed-in person can approve spend');
    const pre = await this.get(id, accountId);
    const decision = await this.dataSource.transaction(async (manager) => {
      const campaign = await lockCampaign(manager, pre.campaign_id);
      const repo = manager.getRepository(MarketingSpendRequest);
      const row = await repo.findOne({ where: { id } });
      if (!row) throw marketingError(404, 'spend request not found');
      if (row.status !== 'pending') throw marketingError(409, `spend request is ${row.status}, not pending`);
      const now = new Date();
      if (row.expires_at.getTime() <= now.getTime()) throw marketingError(409, 'spend request has expired');
      if (!payloadSha256 || payloadSha256 !== row.payload_sha256) {
        throw marketingError(409, 'payload_sha256 does not match this request — reload and review it again');
      }
      if (spendPayloadHash(row) !== row.payload_sha256) throw marketingError(409, 'stored request does not match its hash — refusing to approve');
      if (campaign.status !== 'active') throw marketingError(409, `campaign is ${campaign.status}`);
      if (row.requested_by_type === 'user' && row.requested_by_id === actor.id) {
        throw marketingError(403, 'the person who requested a spend cannot approve it');
      }
      const approvals = Array.isArray(row.approvals) ? [...row.approvals] : [];
      if (approvals.some((a) => a.user_id === actor.id)) throw marketingError(409, 'you have already approved this request — a different person must give the second approval');
      approvals.push({ user_id: actor.id, name: actor.name, at: now.toISOString() });
      const dual = row.dual_required
        || (campaign.dual_approval_threshold_minor > 0 && row.amount_minor >= campaign.dual_approval_threshold_minor);
      const routeProblem = this.routeProblem(campaign, row);
      if (routeProblem) throw marketingError(409, routeProblem);
      if (isDirectPaymentProvider(row.provider)) {
        const planProblem = await this.directPlanProblem(manager, row);
        if (planProblem) throw marketingError(409, `cannot approve: ${planProblem}`);
      }
      const channel = await manager.getRepository(MarketingChannel).findOne({ where: { id: row.channel_id } });
      if (!channel || channel.status !== 'active') throw marketingError(409, `the channel is ${channel?.status || 'gone'} — only active channels can be paid for`);

      const ledger = await loadLedger(manager, campaign.id);
      const allocation = await activeAllocation(manager, campaign.id, row.channel_id);
      const violations = spendViolations(campaign, ledger, now, row, allocation ? allocation.amount_minor : null);
      if (violations.length) throw marketingError(409, `cannot approve: ${violations.join('; ')}`);

      if (dual && approvals.length < 2) {
        const won = await repo.createQueryBuilder().update(MarketingSpendRequest)
          .set({ approvals })
          .where('id = :id AND status = :s', { id, s: 'pending' })
          .execute();
        if (!won.affected) throw marketingError(409, 'spend request was decided concurrently');
        await this.audit.record({
          accountId: campaign.account_id,
          campaignId: campaign.id,
          entityType: 'spend_request',
          entityId: id,
          action: 'spend.first_approval',
          actor,
          summary: `지출 1차 승인(2인 규칙): ${formatMinorAmount(row.amount_minor, row.currency)} → ${row.payee}`,
          detail: { amount_minor: row.amount_minor, threshold_minor: campaign.dual_approval_threshold_minor, note },
        }, manager);
        return { final: false };
      }

      const key = periodKey(campaign.budget_period, now);
      const won = await repo.createQueryBuilder().update(MarketingSpendRequest)
        .set({
          status: 'approved',
          approvals,
          decided_by: actor.id,
          decided_by_name: actor.name,
          decided_at: now,
          decision_note: note.slice(0, 1000),
          period_key: key,
        })
        .where('id = :id AND status = :s', { id, s: 'pending' })
        .execute();
      if (!won.affected) throw marketingError(409, 'spend request was decided concurrently');
      await appendLedger(manager, ledger, this.ledgerBase(row, key), [{ kind: 'reserve', amount_minor: row.amount_minor, note: 'approved' }], actor);
      await this.audit.record({
        accountId: campaign.account_id,
        campaignId: campaign.id,
        entityType: 'spend_request',
        entityId: id,
        action: 'spend.approved',
        actor,
        summary: `지출 승인: ${formatMinorAmount(row.amount_minor, row.currency)} → ${row.payee} (${row.provider})`,
        detail: { amount_minor: row.amount_minor, approvals, period_key: key, payload_sha256: row.payload_sha256, note },
      }, manager);
      return { final: true };
    });
    this.audit.notify(pre.account_id, pre.campaign_id, 'spend_request', id, decision.final ? 'approved' : 'first_approval');
    let request = await this.get(id, accountId);
    if (decision.final && isAutomaticPaymentProvider(request.provider)) request = await this.execute(id);
    return { request, final: decision.final };
  }

  async deny(id: string, accountId: string, actor: MarketingActor, note = ''): Promise<MarketingSpendRequest> {
    return this.closePending(id, accountId, actor, 'denied', note, 'spend.denied', '지출 거부');
  }

  /**
   * 취소 — pending 은 그대로 닫고, 승인됐지만 아직 보내지 않은(approved) 요청은 보류한 예산을 풀며 닫는다.
   * executing 이후는 이미 나갔을 수 있으니 취소가 아니라 대조(결제 완료 · 실패 기록)의 일이다.
   */
  async cancel(id: string, accountId: string, actor: MarketingActor, note = ''): Promise<MarketingSpendRequest> {
    const pre = await this.get(id, accountId);
    if (pre.status !== 'approved') return this.closePending(id, accountId, actor, 'cancelled', note, 'spend.cancelled', '지출 요청 취소');
    await this.dataSource.transaction(async (manager) => {
      await lockCampaign(manager, pre.campaign_id);
      const repo = manager.getRepository(MarketingSpendRequest);
      const row = await repo.findOne({ where: { id } });
      if (!row || row.status !== 'approved') throw marketingError(409, `spend request is ${row?.status || 'gone'} — it can no longer be cancelled`);
      const won = await repo.createQueryBuilder().update(MarketingSpendRequest)
        .set({ status: 'cancelled', error: `cancelled after approval by ${actor.name || actor.id}${note ? `: ${note.slice(0, 500)}` : ''}` })
        .where('id = :id AND status = :s', { id, s: 'approved' })
        .execute();
      if (!won.affected) throw marketingError(409, 'spend request changed concurrently');
      const ledger = await loadLedger(manager, row.campaign_id);
      const totals = requestTotals(ledger, row.id);
      const held = totals.reserve - totals.release;
      if (held > 0) await appendLedger(manager, ledger, this.ledgerBase(row, row.period_key), [{ kind: 'release', amount_minor: held, note: 'cancelled before sending' }], actor);
      await this.audit.record({
        accountId: row.account_id, campaignId: row.campaign_id, entityType: 'spend_request', entityId: id, action: 'spend.cancelled', actor,
        summary: `승인된 지출 취소(보내기 전): ${formatMinorAmount(row.amount_minor, row.currency)} → ${row.payee}`, detail: { note, from: 'approved' },
      }, manager);
    });
    this.audit.notify(pre.account_id, pre.campaign_id, 'spend_request', id, 'cancelled');
    return this.get(id, accountId);
  }

  /**
   * 결제 기록(사람) — manual 공급자의 approved, 또는 결과가 모호한 unknown 을 닫는다. 거래 id 는 필수다:
   * 나중에 대조할 수 없는 "결제 완료" 는 기록이 아니다.
   */
  async markPaid(
    id: string,
    accountId: string,
    actor: MarketingActor,
    body: { provider_ref?: unknown; receipt_url?: unknown; note?: unknown },
  ): Promise<MarketingSpendRequest> {
    const providerRef = typeof body.provider_ref === 'string' ? body.provider_ref.trim().slice(0, 200) : '';
    if (!providerRef) throw marketingError(400, 'provider_ref (the payment/transaction id) is required');
    const receipt = typeof body.receipt_url === 'string' ? body.receipt_url.trim() : '';
    if (receipt && !/^https?:\/\//.test(receipt)) throw marketingError(400, 'receipt_url must be an http(s) URL');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
    const pre = await this.get(id, accountId);
    await this.dataSource.transaction(async (manager) => {
      await lockCampaign(manager, pre.campaign_id);
      const row = await manager.getRepository(MarketingSpendRequest).findOne({ where: { id } });
      if (!row) throw marketingError(404, 'spend request not found');
      this.assertReconcilable(row);
      await this.settle(manager, row, 'paid', actor, { provider_ref: providerRef, receipt_url: receipt.slice(0, 1000), note, from: row.status });
    });
    this.audit.notify(pre.account_id, pre.campaign_id, 'spend_request', id, 'paid');
    return this.get(id, accountId);
  }

  async markFailed(
    id: string,
    accountId: string,
    actor: MarketingActor,
    note = '',
    opts: { confirmNoSpend?: boolean } = {},
  ): Promise<MarketingSpendRequest> {
    const pre = await this.get(id, accountId);
    // 카드 공급자의 결과 불명: 이 요청의 카드가 있는지 Stripe 에서 먼저 찾는다(읽기 — 잠금을 쥔 채 네트워크를 부르지 않게 밖에서).
    let cardCheck: Record<string, unknown> | null = null;
    if (pre.status === 'unknown' && isDirectPaymentProvider(pre.provider) && DIRECT_PROVIDER_SPECS[pre.provider].kind === 'card') {
      this.assertFailureRecordable(pre, new Date());
      cardCheck = await this.cardFailureCheck(pre, opts.confirmNoSpend === true);
    }
    await this.dataSource.transaction(async (manager) => {
      await lockCampaign(manager, pre.campaign_id);
      const row = await manager.getRepository(MarketingSpendRequest).findOne({ where: { id } });
      if (!row) throw marketingError(404, 'spend request not found');
      this.assertReconcilable(row);
      // 잠금 안에서 다시 읽은 행으로 본다 — 실행 중(executing)에 들어온 요청이, 그 사이 결과 불명이 된 행을 유예 없이 닫지 않게.
      this.assertFailureRecordable(row, new Date());
      if (isDirectPaymentProvider(row.provider) && DIRECT_PROVIDER_SPECS[row.provider].kind === 'card' && !cardCheck) {
        throw marketingError(409, 'the request changed while its card was being checked — reload and try again');
      }
      await this.settle(manager, row, 'failed', actor, {
        error: note || 'marked failed by a person', note, from: row.status, ...(cardCheck ? { detail: { card_check: cardCheck } } : {}),
      });
    });
    this.audit.notify(pre.account_id, pre.campaign_id, 'spend_request', id, 'failed');
    return this.get(id, accountId);
  }

  /** 환불(사람) — 결제된 금액 안에서만. 요청은 paid 로 남는다(다시 열리지 않는다). */
  async refund(
    id: string,
    accountId: string,
    actor: MarketingActor,
    body: { amount_minor?: unknown; note?: unknown; provider_ref?: unknown },
  ): Promise<MarketingSpendRequest> {
    let amount: number;
    try {
      amount = parseMinorAmount(body.amount_minor, 'amount_minor');
    } catch (e) {
      if (e instanceof MarketingMoneyError) throw marketingError(400, e.message);
      throw e;
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
    if (!note) throw marketingError(400, 'note is required (why the money came back)');
    const ref = typeof body.provider_ref === 'string' ? body.provider_ref.trim().slice(0, 200) : '';
    const pre = await this.get(id, accountId);
    if (isDirectPaymentProvider(pre.provider)) {
      // 직접 공급자의 결제 = 광고 플랫폼의 상한을 올렸거나 그 한도의 카드를 만든 것. 상한 · 카드가 그대로인데 "미사용분" 을 돌려받았다고
      // 적으면 그 돈은 아직 쓰일 수 있는데 원장은 덜 센다 — 상한을 낮추거나 카드를 해지하고 쓴 돈을 대조하는 기능과 함께 후속으로 둔다
      // (docs/marketing.md "직접 결제 어댑터").
      const label = DIRECT_PAYMENT_PROVIDER_LABELS[pre.provider];
      throw marketingError(409, DIRECT_PROVIDER_SPECS[pre.provider].kind === 'card'
        ? `${label} issued a card with that limit — returning unused budget needs the card to be canceled and its spending reconciled, which AWB does not do yet; the ledger keeps the full approved amount`
        : `${label} raised a spending ceiling — returning unused budget needs the ceiling to be lowered first, which AWB does not do yet; the ledger keeps the full approved amount`);
    }
    await this.dataSource.transaction(async (manager) => {
      const campaign = await lockCampaign(manager, pre.campaign_id);
      const row = await manager.getRepository(MarketingSpendRequest).findOne({ where: { id } });
      if (!row || row.status !== 'paid') throw marketingError(409, `only paid requests can be refunded (this one is ${row?.status || 'gone'})`);
      const ledger = await loadLedger(manager, campaign.id);
      const totals = requestTotals(ledger, id);
      if (amount > totals.capture - totals.refund) {
        throw marketingError(409, `refund ${formatMinorAmount(amount, row.currency)} exceeds what is left to refund ${formatMinorAmount(totals.capture - totals.refund, row.currency)}`);
      }
      await appendLedger(manager, ledger, this.ledgerBase(row, row.period_key), [{ kind: 'refund', amount_minor: amount, note: `${note}${ref ? ` (ref ${ref})` : ''}` }], actor);
      await this.audit.record({
        accountId: row.account_id,
        campaignId: row.campaign_id,
        entityType: 'spend_request',
        entityId: id,
        action: 'spend.refunded',
        actor,
        summary: `환불 기록: ${formatMinorAmount(amount, row.currency)} ← ${row.payee}`,
        detail: { amount_minor: amount, provider_ref: ref, note },
      }, manager);
    });
    this.audit.notify(pre.account_id, pre.campaign_id, 'spend_request', id, 'refunded');
    return this.get(id, accountId);
  }

  // ── 실행(webhook) ────────────────────────────────────────────────────────

  /**
   * webhook 실행. 승인 직후와, 승인 뒤 실행되지 못하고 남은 요청(sweep)에서 부른다. executing CAS 에서 이긴 쪽만
   * 외부로 보낸다 — 같은 요청을 두 번 보내는 경로는 없다.
   */
  async execute(id: string): Promise<MarketingSpendRequest> {
    const pre = await this.spendRepo.findOne({ where: { id } });
    if (!pre) throw marketingError(404, 'spend request not found');
    if (!isAutomaticPaymentProvider(pre.provider)) return pre;

    // 1. 잠금 안에서: 지금도 보내도 되는가. 승인 뒤에 캠페인이 정지됐거나 수취인이 허용 목록에서 빠졌거나 채널이
    //    멈췄으면 보내지 않고 failed(예산 해제)로 닫는다 — 승인 직후 프로세스가 죽어 sweep 이 나중에 실행하는 경우에도
    //    사람이 그 사이에 바꾼 결정이 이긴다. 통과하면 같은 트랜잭션에서 approved → executing.
    const claim = await this.dataSource.transaction(async (manager) => {
      const campaign = await lockCampaign(manager, pre.campaign_id);
      const repo = manager.getRepository(MarketingSpendRequest);
      const row = await repo.findOne({ where: { id } });
      if (!row || row.status !== 'approved') return null;
      const channel = await manager.getRepository(MarketingChannel).findOne({ where: { id: row.channel_id } });
      let blocker: string | null = campaign.status !== 'active' ? `the campaign is ${campaign.status}` : this.routeProblem(campaign, row);
      if (!blocker && (!channel || channel.status !== 'active')) blocker = `the channel is ${channel?.status || 'gone'}`;
      if (!blocker && spendPayloadHash(row) !== row.payload_sha256) blocker = 'the stored request no longer matches the approved hash';
      if (!blocker && isDirectPaymentProvider(row.provider)) {
        blocker = await this.directPlanProblem(manager, row);
        if (!blocker && (!row.decided_at || Date.now() - row.decided_at.getTime() > DIRECT_APPROVAL_MAX_AGE_MS)) {
          blocker = 'it was approved more than an hour ago — a stale approval is not executed; ask for a new request';
        }
      }
      if (blocker) {
        await this.settle(manager, row, 'failed', SYSTEM_MARKETING_ACTOR, { error: `not sent: ${blocker}`, from: 'approved' });
        return null;
      }
      const executingAt = new Date();
      const won = await repo.createQueryBuilder().update(MarketingSpendRequest)
        .set({ status: 'executing', executing_at: executingAt })
        .where('id = :id AND status = :s', { id, s: 'approved' })
        .execute();
      if (!won.affected) return null;
      row.executing_at = executingAt;
      await this.audit.record({
        accountId: row.account_id,
        campaignId: row.campaign_id,
        entityType: 'spend_request',
        entityId: id,
        action: 'spend.executing',
        actor: SYSTEM_MARKETING_ACTOR,
        summary: `결제 실행 시작(${row.provider}): ${formatMinorAmount(row.amount_minor, row.currency)} → ${row.payee}`,
        detail: { payload_sha256: row.payload_sha256 },
      }, manager);
      return { row, campaign, channel: channel! };
    });
    if (!claim) {
      this.audit.notify(pre.account_id, pre.campaign_id, 'spend_request', id, 'executed');
      return (await this.spendRepo.findOne({ where: { id } }))!;
    }
    const { row, campaign, channel } = claim;

    // 2. sql.js 는 주기적으로만 파일에 쓴다 — "보내기 시작했다" 가 디스크에 없는 채로 죽으면 재시작 뒤 다시 보낼 수 있다.
    //    외부 호출 전에 강제로 내려 쓰고(트랜잭션 큐 뒤에서 — export 는 연결을 닫았다 열어 진행 중 트랜잭션을 끊는다),
    //    내려 쓰지 못하면 보내지 않는다. 아무것도 나가지 않았으니 failed 로 닫아도 이중 지출이 없다.
    try {
      await this.persistNow();
    } catch (e: any) {
      await this.dataSource.transaction(async (manager) => {
        await lockCampaign(manager, row.campaign_id);
        const current = await manager.getRepository(MarketingSpendRequest).findOne({ where: { id } });
        if (current?.status === 'executing') {
          await this.settle(manager, current, 'failed', SYSTEM_MARKETING_ACTOR, {
            error: `not sent: could not persist the executing state (${String(e?.message || e).slice(0, 200)})`, from: 'executing',
          });
        }
      });
      this.audit.notify(row.account_id, row.campaign_id, 'spend_request', id, 'executed');
      return (await this.spendRepo.findOne({ where: { id } }))!;
    }

    // 3. 보낸다. 보내기 전의 실패는 PaymentNotSentError 로만 알린다 — 그것만 failed(예산 해제)이고, 그 밖의 예외는 이미 나갔을 수 있어
    //    unknown 이다(사람이 대조).
    let outcome: PaymentOutcome;
    try {
      outcome = row.provider === 'webhook' ? await this.sendWebhook(row, campaign, channel) : await this.sendDirect(row);
    } catch (e: any) {
      const message = String(e?.message || e).slice(0, 300);
      outcome = e instanceof PaymentNotSentError
        ? { outcome: 'failed', error: `not sent: ${message}`, response: e.providerMessage ? { sent: false, message_untrusted: e.providerMessage } : { sent: false } }
        : { outcome: 'unknown', error: `the payment step stopped unexpectedly and may already have been sent: ${message}`, response: {} };
    }

    // 4. 결과를 기록한다.
    await this.recordOutcome(row, outcome);
    await this.persistNow().catch(() => {});
    this.audit.notify(row.account_id, row.campaign_id, 'spend_request', id, 'executed');
    return (await this.spendRepo.findOne({ where: { id } }))!;
  }

  private async sendWebhook(row: MarketingSpendRequest, campaign: MarketingCampaign, channel: MarketingChannel): Promise<PaymentOutcome> {
    let secret: ReturnType<typeof readWebhookSecret>;
    try {
      secret = readWebhookSecret(await resolveMarketingSecret(this.credentialRepo, row.provider_credential_id || '', row.account_id));
    } catch (e: any) {
      throw new PaymentNotSentError(String(e?.message || e));
    }
    const body = canonicalJson({
      type: 'marketing.spend.execute',
      spend_request_id: row.id,
      campaign: { id: row.campaign_id, name: campaign.name, slug: campaign.slug },
      channel: { id: row.channel_id, platform: channel.platform, target: channel.target },
      amount_minor: row.amount_minor,
      currency: row.currency,
      payee: row.payee,
      payee_ref: row.payee_ref,
      purpose: row.purpose,
      payload: row.payload || {},
      payload_sha256: row.payload_sha256,
      approved_by: (row.approvals || []).map((a) => ({ name: a.name, at: a.at })),
      issued_at: new Date().toISOString(),
    });
    return executeWebhookPayment({ secret, body, idempotencyKey: row.id, fetchImpl: this.fetchImpl });
  }

  /** 직접 공급자 — 실행 계획만 실행한다. credential 은 요청 때와 같은 지문이어야 한다(그 사이 키를 바꾸면 보내지 않는다). */
  private async sendDirect(row: MarketingSpendRequest): Promise<PaymentOutcome> {
    const provider = row.provider as DirectPaymentProvider;
    const plan = row.payload as DirectPlan;
    let resolved: Awaited<ReturnType<typeof resolveDirectPaymentCredential>>;
    try {
      resolved = await resolveDirectPaymentCredential(this.credentialRepo, provider, row.provider_credential_id || '', row.account_id);
    } catch (e: any) {
      throw new PaymentNotSentError(String(e?.message || e));
    }
    if (resolved.fingerprint !== plan.credential_fingerprint) throw new PaymentNotSentError('the payment credential changed since the request');
    return DIRECT_PAYMENT_ADAPTERS[provider].execute({
      plan, fields: resolved.fields, fingerprint: resolved.fingerprint, requestId: row.id, startedAt: row.executing_at || new Date(), ctx: this.adapterContext(),
    });
  }

  /**
   * 실행 결과를 기록한다. 보통은 executing 에서 닫는다. 그 사이 시스템이 unknown 으로 돌렸으면(다른 서버의 부팅 · 10분 넘은 실행)
   * 확정 결과(paid · failed)로 그 unknown 을 닫는다 — 아직 아무도 대조하지 않았으니 이 결과가 가장 정확하다. 사람이 이미
   * 대조했으면 결과를 버리지 않고 감사에 남긴다.
   */
  private async recordOutcome(row: MarketingSpendRequest, outcome: PaymentOutcome): Promise<void> {
    const id = row.id;
    await this.dataSource.transaction(async (manager) => {
      await lockCampaign(manager, row.campaign_id);
      const current = await manager.getRepository(MarketingSpendRequest).findOne({ where: { id } });
      const lateSettle = current?.status === 'unknown' && outcome.outcome !== 'unknown';
      if (!current || (current.status !== 'executing' && !lateSettle)) {
        // 그 사이 사람이 대조했다(executing 이 오래 걸려 unknown 이 된 뒤 등). 결과를 버리지 말고 감사에 남겨
        // 사람이 자기 기록과 맞춰 볼 수 있게 한다.
        await this.audit.record({
          accountId: row.account_id, campaignId: row.campaign_id, entityType: 'spend_request', entityId: id,
          action: 'spend.late_result', actor: SYSTEM_MARKETING_ACTOR,
          summary: `결제 응답이 늦게 도착함(${outcome.outcome}${outcome.outcome === 'paid' ? `, 거래 ${outcome.transaction_id}` : ''}) — 현재 상태 ${current?.status || '없음'}, 기록과 대조하세요`,
          detail: { outcome: outcome.outcome, transaction_id: outcome.outcome === 'paid' ? outcome.transaction_id : '', response: outcome.response },
        }, manager);
        return;
      }
      const note = lateSettle ? 'the result arrived after the request had been marked unknown' : '';
      if (outcome.outcome === 'paid') {
        await this.settle(manager, current, 'paid', SYSTEM_MARKETING_ACTOR, {
          provider_ref: outcome.transaction_id, receipt_url: outcome.receipt_url, response: outcome.response, from: current.status, note,
        });
      } else if (outcome.outcome === 'failed') {
        await this.settle(manager, current, 'failed', SYSTEM_MARKETING_ACTOR, { error: outcome.error, response: outcome.response, from: current.status, note });
      } else {
        const won = await manager.getRepository(MarketingSpendRequest).createQueryBuilder().update(MarketingSpendRequest)
          .set({ status: 'unknown', error: outcome.error, provider_response: outcome.response })
          .where('id = :id AND status = :s', { id, s: 'executing' })
          .execute();
        if (won.affected) {
          await this.audit.record({
            accountId: current.account_id,
            campaignId: current.campaign_id,
            entityType: 'spend_request',
            entityId: id,
            action: 'spend.unknown',
            actor: SYSTEM_MARKETING_ACTOR,
            summary: `결제 결과 불명 — 사람이 대조해야 함: ${outcome.error}`,
            detail: { response: outcome.response },
          }, manager);
        }
      }
    });
  }

  /** sql.js 를 지금 파일로 내려 쓴다(Postgres 는 no-op). flushSqljs 가 진행 중인 트랜잭션이 끝난 뒤에 쓴다 — export 가 연결을 다시 연다. */
  private persistNow(): Promise<boolean> {
    return flushSqljs(this.dataSource, true);
  }

  // ── 공급자 확인(읽기 전용) ───────────────────────────────────────────────

  /**
   * 연결 확인 — 직접 공급자 경로가 있는 수취인마다 credential 과 대상(광고 캠페인)을 읽어 지금 상태를 보고한다. 아무것도 쓰지 않는다.
   * 요청 · 실행과 같은 읽기 코드와 규칙을 쓴다. 운영자가 실제(또는 테스트) 계정을 돈을 움직이지 않고 검증하는 길이다.
   * 문제가 없는 대상은 요청 백오프를 푼다(사람이 고쳤다는 뜻이다).
   */
  async checkPayments(campaign: MarketingCampaign, actor: MarketingActor): Promise<PaymentCheckResult> {
    const results: PayeePaymentCheck[] = [];
    for (const payee of campaign.payees || []) {
      if (!isDirectPaymentProvider(payee.provider)) continue;
      const provider = payee.provider;
      const base = { payee: payee.name, provider, ref: payee.ref || '', credential_id: payee.credential_id || '' };
      try {
        const targetKey = directTargetKey(provider, payee.ref || '');
        const { fields, fingerprint } = await resolveDirectPaymentCredential(this.credentialRepo, provider, payee.credential_id || '', campaign.account_id);
        DIRECT_PAYMENT_ADAPTERS[provider].checkCredential(fields);
        const report = await DIRECT_PAYMENT_ADAPTERS[provider].report({ ref: payee.ref || '', fields, fingerprint, currency: campaign.currency, ctx: this.adapterContext() });
        const open = isExclusiveTargetProvider(provider) ? await this.openRequestForTarget(targetKey) : null;
        if (report.ok) {
          for (const key of [...this.providerBackoff.keys()]) {
            if (key.startsWith(`${campaign.id}\u0000${targetKey}\u0000`)) this.providerBackoff.delete(key);
          }
        }
        // 다른 계정의 요청은 있다는 것만(id · 상태 없이) — 이 credential 로 그 대상을 읽을 수 있음은 방금 확인했다.
        const openRequest = !open ? null : open.account_id === campaign.account_id ? { id: open.id, status: open.status } : { id: '', status: 'other_account' };
        results.push({ ...base, ...report, open_request: openRequest });
      } catch (e: any) {
        const message = String(e?.message || e).slice(0, 500);
        results.push({
          ...base, ok: false, problems: [message], ceiling_minor: null, ceiling_text: '', ceiling_units: null,
          target_name_untrusted: '', facts: {}, api_version: '', open_request: null,
          ...(e instanceof PaymentReadError && e.providerMessage ? { provider_message_untrusted: e.providerMessage } : {}),
        });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    await this.audit.record({
      accountId: campaign.account_id,
      campaignId: campaign.id,
      entityType: 'campaign',
      entityId: campaign.id,
      action: 'payment.checked',
      actor,
      summary: `결제 연결 확인: ${results.length}곳 중 ${okCount}곳 정상`,
      detail: {
        results: results.map((r) => ({
          payee: r.payee, provider: r.provider, ok: r.ok, problems: r.problems,
          ...(r.provider_message_untrusted ? { provider_message_untrusted: r.provider_message_untrusted } : {}),
        })),
      },
    });
    return { checked_at: new Date().toISOString(), payees: results };
  }

  /**
   * 요청별 공급자 확인 — 직접 공급자 요청의 대상을 지금 읽어 상한이 from · to 중 어디에 있는지 보여 준다(쓰기 없음). 결과 불명을
   * 대조하는 사람이 "이미 올라갔는가" 를 공급자 화면을 열지 않고 볼 수 있게. 판정은 하지 않는다 — 기록은 사람이 한다.
   */
  async inspect(id: string, accountId: string): Promise<SpendInspection> {
    const row = await this.get(id, accountId);
    if (!isDirectPaymentProvider(row.provider)) throw marketingError(409, 'only direct payment providers (Meta Ads, Google Ads, Stripe Issuing) can be inspected');
    const plan = row.payload as DirectPlan;
    const { fields, fingerprint } = await resolveDirectPaymentCredential(this.credentialRepo, row.provider, row.provider_credential_id || '', row.account_id);
    let found: DirectInspection;
    try {
      found = await DIRECT_PAYMENT_ADAPTERS[row.provider].inspect({
        plan, ref: row.payee_ref, fields, fingerprint, currency: row.currency, requestId: row.id, around: this.executionTime(row),
        response: row.provider_response, ctx: this.adapterContext(),
      });
    } catch (e: any) {
      // 사람만 부르는 확인이라(approve_spend) 공급자가 준 글도 덧붙인다 — 이 문장은 에이전트에게 가지 않는다.
      if (e instanceof PaymentReadError) throw marketingError(e.status, e.providerMessage ? `${e.message} — provider says (untrusted): ${e.providerMessage}` : e.message);
      if (e instanceof PaymentRuleError) throw marketingError(e.status, e.message);
      if (e instanceof PaymentNotSentError) throw marketingError(409, e.message);
      throw e;
    }
    const checkedAt = new Date().toISOString();
    if (found.kind === 'card') {
      return {
        kind: 'card', spend_request_id: row.id, status: row.status, limit_minor: (plan as CardPlan).limit_minor,
        result: found.result, cards: found.cards, api_version: found.api_version, checked_at: checkedAt,
      };
    }
    const ceiling = plan as CeilingPlan;
    return {
      kind: 'ceiling',
      spend_request_id: row.id,
      status: row.status,
      from: ceiling.from,
      to: ceiling.to,
      from_minor: ceiling.from_minor,
      to_minor: ceiling.to_minor,
      observed: found.observed,
      observed_minor: found.observed_minor,
      position: found.position,
      report: found.report,
      checked_at: checkedAt,
    };
  }

  /** 요청이 공급자에 닿았을 시각 — 실행 시작, 없으면 승인, 없으면 요청. 카드 찾기의 범위가 이 시각 ±1일이다. */
  private executionTime(row: MarketingSpendRequest): Date {
    return row.executing_at || row.decided_at || row.created_at;
  }

  /**
   * 카드 공급자의 결과 불명을 실패로 기록하기 전 — 이 요청의 카드를 Stripe 에서 찾는다(읽기만). 카드가 해지되지 않은 채 있으면 실패로
   * 기록하지 않는다(그 카드로 돈이 나갈 수 있다 — 결제 완료로 기록하거나 사람이 먼저 해지한다). 해지된 카드만 있거나, 찾지 못했거나
   * (읽기 실패 · 범위를 다 보지 못함), 사람이 Stripe 대시보드에서 쓴 돈이 없음을 확인했다고 밝혀야(`confirm_no_spend`) 기록한다 —
   * 그 확인은 감사에 남는다. 카드가 없음이 분명하면 그대로 기록한다.
   */
  private async cardFailureCheck(row: MarketingSpendRequest, confirmNoSpend: boolean): Promise<Record<string, unknown>> {
    let scan: DirectInspection | null = null;
    let problem = '';
    try {
      const provider = row.provider as DirectPaymentProvider;
      const { fields, fingerprint } = await resolveDirectPaymentCredential(this.credentialRepo, provider, row.provider_credential_id || '', row.account_id);
      scan = await DIRECT_PAYMENT_ADAPTERS[provider].inspect({
        plan: row.payload as DirectPlan, ref: row.payee_ref, fields, fingerprint, currency: row.currency, requestId: row.id,
        around: this.executionTime(row), response: row.provider_response, ctx: this.adapterContext(),
      });
    } catch (e: any) {
      problem = String(e?.message || e).slice(0, 300);
    }
    if (scan && scan.kind === 'card') {
      if (scan.result === 'none') return { result: 'none' };
      const live = scan.cards.filter((c) => c.status !== 'canceled');
      if (live.length) {
        // 활성화되지 않은 카드는 AWB 가 살리지 않은 카드다 — 결제 완료로 이끌지 않는다(쓸 수 없는 카드에 예산 전체가 묶인다).
        const card = live.find((c) => c.status === 'active') || live[0];
        throw marketingError(409, card.status === 'active'
          ? `an active card for this request exists (${card.id}) — record "paid" with its id, or cancel the card in the Stripe Dashboard first`
          : `a card for this request exists but was never activated (${card.id}, ${card.status || 'status unknown'}) — cancel it in the Stripe Dashboard and record the failure with confirm_no_spend, or activate it there and record "paid" with its id`);
      }
      const ids = scan.cards.map((c) => c.id);
      if (!confirmNoSpend) {
        throw marketingError(409, scan.result === 'found'
          ? `only canceled cards were found for this request (${ids.join(', ')}) — confirm in the Stripe Dashboard that nothing was spent on them, then record the failure with confirm_no_spend`
          : 'could not look through all of this cardholder\'s cards — check the Stripe Dashboard and, if no card was issued for this request, record the failure with confirm_no_spend');
      }
      return { result: scan.result, cards: ids, confirmed_no_spend: true };
    }
    if (!confirmNoSpend) {
      throw marketingError(409, `could not check Stripe for this request's card (${problem || 'no answer'}) — check the Stripe Dashboard and, if no card was issued, record the failure with confirm_no_spend`);
    }
    return { result: 'unchecked', error: problem, confirmed_no_spend: true };
  }

  // ── 주기 정리 ────────────────────────────────────────────────────────────

  /** 만료 · 끊긴 실행 정리 · 승인 뒤 실행되지 못한 webhook 요청 실행. 테스트가 직접 부른다. */
  async sweep(now: Date = new Date()): Promise<{ expired: number; unknown: number; executed: number }> {
    const result = { expired: 0, unknown: 0, executed: 0 };
    const expired = await this.spendRepo.find({ where: { status: 'pending', expires_at: LessThan(now) }, take: 200 });
    for (const row of expired) {
      const won = await this.spendRepo.createQueryBuilder().update(MarketingSpendRequest)
        .set({ status: 'expired', decided_at: now, decision_note: 'no decision before expiry' })
        .where('id = :id AND status = :s', { id: row.id, s: 'pending' })
        .execute();
      if (!won.affected) continue;
      result.expired++;
      await this.audit.record({
        accountId: row.account_id, campaignId: row.campaign_id, entityType: 'spend_request', entityId: row.id,
        action: 'spend.expired', actor: SYSTEM_MARKETING_ACTOR,
        summary: `지출 요청 만료(결정 없음 = 거부): ${formatMinorAmount(row.amount_minor, row.currency)} → ${row.payee}`,
      });
      this.audit.notify(row.account_id, row.campaign_id, 'spend_request', row.id, 'expired');
    }
    const stuck = await this.spendRepo.find({ where: { status: 'executing', executing_at: LessThan(new Date(now.getTime() - STUCK_EXECUTING_MS)) }, take: 200 });
    for (const row of stuck) {
      if (await this.markInterrupted(row, 'execution did not record a result (process restarted or hung) — the payment may or may not have happened')) result.unknown++;
    }
    const stranded = await this.spendRepo.find({
      where: { status: 'approved', provider: In(AUTOMATIC_PROVIDERS), decided_at: LessThan(new Date(now.getTime() - STRANDED_APPROVED_MS)) },
      take: 50,
    });
    for (const row of stranded) {
      try {
        await this.execute(row.id);
        result.executed++;
      } catch (e: any) {
        this.logService.warn('Marketing', 'stranded spend execution failed', { id: row.id, err: e?.message || String(e) });
      }
    }
    return result;
  }

  /** 부팅 시: 이 프로세스가 시작되기 전부터 executing 인 요청은 결과를 모른다. */
  async recoverInterrupted(bootedAt: Date = new Date()): Promise<number> {
    const rows = await this.spendRepo.find({ where: { status: 'executing', executing_at: LessThan(bootedAt) } });
    let n = 0;
    for (const row of rows) {
      if (await this.markInterrupted(row, 'the server restarted while this payment was being sent — the payment may or may not have happened')) n++;
    }
    return n;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * executing → unknown. 캠페인 잠금 안에서 한다 — 다른 서버의 실행이 결과를 기록하는 트랜잭션(recordOutcome)과 줄을 서서, 그쪽이
   * executing 을 읽은 뒤 여기서 바뀌어 결과가 사라지는 일이 없게(그쪽은 unknown 을 보고 확정 결과로 닫는다).
   */
  private async markInterrupted(row: MarketingSpendRequest, error: string): Promise<boolean> {
    const won = await this.dataSource.transaction(async (manager) => {
      await lockCampaign(manager, row.campaign_id);
      const changed = await manager.getRepository(MarketingSpendRequest).createQueryBuilder().update(MarketingSpendRequest)
        .set({ status: 'unknown', error })
        .where('id = :id AND status = :s', { id: row.id, s: 'executing' })
        .execute();
      if (!changed.affected) return false;
      await this.audit.record({
        accountId: row.account_id, campaignId: row.campaign_id, entityType: 'spend_request', entityId: row.id,
        action: 'spend.unknown', actor: SYSTEM_MARKETING_ACTOR, summary: `결제 결과 불명 — 사람이 대조해야 함: ${error}`,
      }, manager);
      return true;
    });
    if (won) this.audit.notify(row.account_id, row.campaign_id, 'spend_request', row.id, 'unknown');
    return won;
  }

  /**
   * 수취인이 아직 허용 목록에 있고, 요청 때와 같은 경로(결제 방식 · credential · 대상)인가 — 아니면 그 이유. 사람이 수취인을 다른
   * 광고 캠페인으로 돌렸거나 결제 방식을 바꿨으면 예전 경로의 요청은 승인 · 실행되지 않는다(이름만 보면 그대로 통과한다).
   */
  private routeProblem(campaign: MarketingCampaign, row: MarketingSpendRequest): string | null {
    const payee = findPayee(campaign, row.payee);
    if (!payee) return `payee "${row.payee}" is no longer on the campaign allowlist`;
    if (!sameRoute(row, payeeRoute(campaign, payee))) {
      return `payee "${row.payee}" now has a different payment method, credential or target than when this was requested — ask for a new request`;
    }
    return directPayeeProblem(row, payee);
  }

  /** 직접 공급자: 저장된 계획이 그 요청과 맞고(단위 · to − from = 금액 · 대상), credential 이 요청 때와 같은가. */
  private async directPlanProblem(manager: EntityManager, row: MarketingSpendRequest): Promise<string | null> {
    const problems = directPlanProblems(row);
    if (problems.length) return `the execution plan is invalid (${problems.join('; ')})`;
    const cred = row.provider_credential_id ? await manager.getRepository(Credential).findOne({ where: { id: row.provider_credential_id } }) : null;
    if (!cred) return 'the payment credential is gone';
    let fingerprint: string;
    try {
      fingerprint = credentialFingerprint(cred);
    } catch {
      return 'the payment credential is unreadable';
    }
    if (fingerprint !== (row.payload as DirectPlan).credential_fingerprint) {
      return 'the payment credential changed since this request — ask for a new request';
    }
    return null;
  }

  /**
   * 직접 결제의 결과 불명은 실행 뒤 DIRECT_FAIL_GRACE_MS 가 지나야 실패로 기록한다 — 공급자 반영이 늦을 수 있어서, 그 전에 "아직 안
   * 바뀌었다" 를 보고 닫으면 나중에 반영된 상한이 원장 밖에 남는다. "결제 완료" 는 바로 기록할 수 있다(원장을 더 세는 쪽).
   */
  private assertFailureRecordable(row: MarketingSpendRequest, now: Date): void {
    if (row.status !== 'unknown' || !isDirectPaymentProvider(row.provider) || !row.executing_at) return;
    const allowedAt = row.executing_at.getTime() + DIRECT_FAIL_GRACE_MS;
    if (now.getTime() >= allowedAt) return;
    const label = DIRECT_PAYMENT_PROVIDER_LABELS[row.provider];
    const at = new Date(allowedAt).toISOString();
    throw marketingError(409, DIRECT_PROVIDER_SPECS[row.provider].kind === 'card'
      ? `a card request without a clear answer can still show up at ${label} — record a failure after ${at}, once "inspect" finds no card for this request (record "paid" now if it shows the card)`
      : `a ceiling change can take up to ${DIRECT_FAIL_GRACE_MS / 60_000} minutes to show on ${label} — record a failure after ${at}, once "inspect" still shows the old value (record "paid" now if it already shows the new one)`);
  }

  private assertReconcilable(row: MarketingSpendRequest): void {
    const ok = row.status === 'unknown' || (row.status === 'approved' && row.provider === 'manual');
    if (!ok) {
      throw marketingError(409, row.status === 'approved'
        ? 'this request is executed by the server — wait for its result (or reconcile it once it is unknown)'
        : `spend request is ${row.status} — only approved (manual) or unknown requests can be reconciled`);
    }
  }

  /** paid → release + capture, failed → release. 상태 CAS 와 원장과 감사가 한 트랜잭션. */
  private async settle(
    manager: import('typeorm').EntityManager,
    row: MarketingSpendRequest,
    to: 'paid' | 'failed',
    actor: MarketingActor,
    info: { provider_ref?: string; receipt_url?: string; error?: string; note?: string; response?: Record<string, any>; from: string; detail?: Record<string, unknown> },
  ): Promise<void> {
    const repo = manager.getRepository(MarketingSpendRequest);
    const now = new Date();
    const won = await repo.createQueryBuilder().update(MarketingSpendRequest)
      .set(to === 'paid'
        ? { status: 'paid', paid_at: now, provider_ref: info.provider_ref || '', receipt_url: info.receipt_url || '', provider_response: info.response || {}, error: '' }
        : { status: 'failed', error: (info.error || '').slice(0, 2000), provider_response: info.response || {} })
      .where('id = :id AND status = :s', { id: row.id, s: info.from })
      .execute();
    if (!won.affected) throw marketingError(409, 'spend request changed concurrently');
    const ledger = await loadLedger(manager, row.campaign_id);
    const totals = requestTotals(ledger, row.id);
    const held = totals.reserve - totals.release;
    const writes = [] as Array<{ kind: 'release' | 'capture'; amount_minor: number; note: string }>;
    if (held > 0) writes.push({ kind: 'release', amount_minor: held, note: to === 'paid' ? 'converted to capture' : 'payment failed' });
    if (to === 'paid') writes.push({ kind: 'capture', amount_minor: row.amount_minor, note: info.provider_ref ? `txn ${info.provider_ref}` : 'paid' });
    if (writes.length) await appendLedger(manager, ledger, this.ledgerBase(row, row.period_key), writes, actor);
    await this.audit.record({
      accountId: row.account_id,
      campaignId: row.campaign_id,
      entityType: 'spend_request',
      entityId: row.id,
      action: to === 'paid' ? 'spend.paid' : 'spend.failed',
      actor,
      summary: to === 'paid'
        ? `결제 완료: ${formatMinorAmount(row.amount_minor, row.currency)} → ${row.payee} (거래 ${info.provider_ref})`
        : `결제 실패: ${formatMinorAmount(row.amount_minor, row.currency)} → ${row.payee} — ${info.error || ''}`,
      detail: {
        from: info.from, provider_ref: info.provider_ref || '', receipt_url: info.receipt_url || '', note: info.note || '', response_status: info.response?.status ?? null,
        ...(info.detail || {}),
      },
    }, manager);
  }

  private async closePending(
    id: string,
    accountId: string,
    actor: MarketingActor,
    to: 'denied' | 'cancelled',
    note: string,
    action: string,
    label: string,
  ): Promise<MarketingSpendRequest> {
    const row = await this.get(id, accountId);
    const won = await this.spendRepo.createQueryBuilder().update(MarketingSpendRequest)
      .set({ status: to, decided_by: actor.id, decided_by_name: actor.name, decided_at: new Date(), decision_note: (note || '').slice(0, 1000) })
      .where('id = :id AND status = :s', { id, s: 'pending' })
      .execute();
    if (!won.affected) throw marketingError(409, `spend request is ${row.status}, not pending`);
    await this.audit.record({
      accountId: row.account_id, campaignId: row.campaign_id, entityType: 'spend_request', entityId: id,
      action, actor, summary: `${label}: ${formatMinorAmount(row.amount_minor, row.currency)} → ${row.payee}`, detail: { note },
    });
    this.audit.notify(row.account_id, row.campaign_id, 'spend_request', id, to);
    return this.get(id, accountId);
  }

  private async cancelPending(campaign: MarketingCampaign, actor: MarketingActor, reason: string): Promise<void> {
    const pending = await this.spendRepo.find({ where: { campaign_id: campaign.id, status: In(['pending']) } });
    for (const row of pending) {
      try {
        await this.closePending(row.id, row.account_id, actor, 'cancelled', reason, 'spend.cancelled', '지출 요청 취소(캠페인 정지)');
      } catch {
        /* 그 사이 결정됐다 */
      }
    }
  }

  private ledgerBase(row: MarketingSpendRequest, key: string) {
    return {
      account_id: row.account_id,
      campaign_id: row.campaign_id,
      channel_id: row.channel_id,
      spend_request_id: row.id,
      currency: row.currency,
      period_key: key,
    };
  }
}
