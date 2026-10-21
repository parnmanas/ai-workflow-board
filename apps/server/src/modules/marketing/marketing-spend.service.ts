import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, MoreThan, Repository } from 'typeorm';
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
import { afterSqljsTransactions, flushSqljs } from '../../db';
import { LogService } from '../../services/log.service';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { MarketingChannelService } from './marketing-channel.service';
import { MarketingBudgetService } from './marketing-budget.service';
import { marketingError } from './marketing-errors';
import { findPayee } from './marketing-campaign.logic';
import { activeAllocation, appendLedger, loadLedger, lockCampaign } from './marketing-ledger';
import { resolveMarketingSecret } from './marketing-credential';
import { executeWebhookPayment, readWebhookSecret, type PaymentOutcome } from './marketing-payments';

const MAX_PAYLOAD_BYTES = 8 * 1024;
const SWEEP_MS = 5 * 60_000;
/** executing 이 이보다 오래 남아 있으면(프로세스가 응답을 기록하지 못했다) unknown 으로 돌린다. */
const STUCK_EXECUTING_MS = 10 * 60_000;
/** approved 인 webhook 요청이 이만큼 지나도 실행되지 않았으면(승인 직후 프로세스가 죽었다) 지금 실행한다. */
const STRANDED_APPROVED_MS = 60_000;

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
  /** 테스트가 결제 엔드포인트 호출을 가로챌 수 있게(기본은 전역 fetch). */
  fetchImpl: typeof fetch | undefined;

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
    if (!row || (accountId && row.account_id !== accountId)) throw marketingError(404, 'spend request not found');
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
    const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : '';
    if (!purpose || purpose.length > 2000) throw marketingError(400, 'purpose is required (max 2000 characters)');
    const expected = typeof body.expected_outcome === 'string' ? body.expected_outcome.trim() : '';
    if (expected.length > 2000) throw marketingError(400, 'expected_outcome must be at most 2000 characters');
    if (actor.type === 'agent' && !expected) throw marketingError(400, 'expected_outcome is required — say what this spend should achieve and how you will measure it');
    const payload = body.payload === undefined || body.payload === null ? {} : body.payload;
    if (typeof payload !== 'object' || Array.isArray(payload)) throw marketingError(400, 'payload must be a JSON object');
    if (Buffer.byteLength(canonicalJson(payload), 'utf8') > MAX_PAYLOAD_BYTES) throw marketingError(400, `payload must be at most ${MAX_PAYLOAD_BYTES} bytes`);

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

    const fields = {
      campaign_id: campaign.id,
      channel_id: channel.id,
      amount_minor: amount,
      currency,
      payee: payee.name,
      payee_ref: payee.ref || '',
      purpose,
      provider: campaign.payment_provider || 'manual',
      provider_credential_id: campaign.payment_provider === 'webhook' ? campaign.payment_credential_id : null,
      payload: payload as Record<string, unknown>,
    };
    let saved: MarketingSpendRequest;
    try {
      saved = await this.spendRepo.save(this.spendRepo.create({
        account_id: campaign.account_id,
        ...fields,
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
      detail: { channel_id: channel.id, amount_minor: amount, currency, payee: payee.name, provider: saved.provider, payload_sha256: saved.payload_sha256 },
    });
    this.audit.notify(campaign.account_id, campaign.id, 'spend_request', saved.id, 'requested');
    return { request: saved, duplicate: false };
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
      if (!findPayee(campaign, row.payee)) throw marketingError(409, `payee "${row.payee}" is no longer on the campaign allowlist`);
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
    if (decision.final && request.provider === 'webhook') request = await this.execute(id);
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

  async markFailed(id: string, accountId: string, actor: MarketingActor, note = ''): Promise<MarketingSpendRequest> {
    const pre = await this.get(id, accountId);
    await this.dataSource.transaction(async (manager) => {
      await lockCampaign(manager, pre.campaign_id);
      const row = await manager.getRepository(MarketingSpendRequest).findOne({ where: { id } });
      if (!row) throw marketingError(404, 'spend request not found');
      this.assertReconcilable(row);
      await this.settle(manager, row, 'failed', actor, { error: note || 'marked failed by a person', note, from: row.status });
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
    if (pre.provider !== 'webhook') return pre;

    // 1. 잠금 안에서: 지금도 보내도 되는가. 승인 뒤에 캠페인이 정지됐거나 수취인이 허용 목록에서 빠졌거나 채널이
    //    멈췄으면 보내지 않고 failed(예산 해제)로 닫는다 — 승인 직후 프로세스가 죽어 sweep 이 나중에 실행하는 경우에도
    //    사람이 그 사이에 바꾼 결정이 이긴다. 통과하면 같은 트랜잭션에서 approved → executing.
    const claim = await this.dataSource.transaction(async (manager) => {
      const campaign = await lockCampaign(manager, pre.campaign_id);
      const repo = manager.getRepository(MarketingSpendRequest);
      const row = await repo.findOne({ where: { id } });
      if (!row || row.status !== 'approved') return null;
      const channel = await manager.getRepository(MarketingChannel).findOne({ where: { id: row.channel_id } });
      const blocker = campaign.status !== 'active' ? `the campaign is ${campaign.status}`
        : !findPayee(campaign, row.payee) ? `payee "${row.payee}" is no longer on the campaign allowlist`
          : !channel || channel.status !== 'active' ? `the channel is ${channel?.status || 'gone'}`
            : spendPayloadHash(row) !== row.payload_sha256 ? 'the stored request no longer matches the approved hash' : null;
      if (blocker) {
        await this.settle(manager, row, 'failed', SYSTEM_MARKETING_ACTOR, { error: `not sent: ${blocker}`, from: 'approved' });
        return null;
      }
      const won = await repo.createQueryBuilder().update(MarketingSpendRequest)
        .set({ status: 'executing', executing_at: new Date() })
        .where('id = :id AND status = :s', { id, s: 'approved' })
        .execute();
      if (!won.affected) return null;
      await this.audit.record({
        accountId: row.account_id,
        campaignId: row.campaign_id,
        entityType: 'spend_request',
        entityId: id,
        action: 'spend.executing',
        actor: SYSTEM_MARKETING_ACTOR,
        summary: `결제 실행 시작(webhook): ${formatMinorAmount(row.amount_minor, row.currency)} → ${row.payee}`,
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

    // 3. 보낸다.
    let outcome: PaymentOutcome;
    try {
      const secret = readWebhookSecret(await resolveMarketingSecret(this.credentialRepo, row.provider_credential_id || '', row.account_id));
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
      outcome = await executeWebhookPayment({ secret, body, idempotencyKey: row.id, fetchImpl: this.fetchImpl });
    } catch (e: any) {
      // 보내기 전의 실패(credential 을 못 읽음 등) — 아무것도 나가지 않았으니 failed 로 닫아도 이중 지출이 없다.
      outcome = { outcome: 'failed', error: `not sent: ${String(e?.message || e).slice(0, 300)}`, response: {} };
    }

    // 4. 결과를 기록한다.
    await this.dataSource.transaction(async (manager) => {
      await lockCampaign(manager, row.campaign_id);
      const current = await manager.getRepository(MarketingSpendRequest).findOne({ where: { id } });
      if (!current || current.status !== 'executing') {
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
      if (outcome.outcome === 'paid') {
        await this.settle(manager, current, 'paid', SYSTEM_MARKETING_ACTOR, {
          provider_ref: outcome.transaction_id, receipt_url: outcome.receipt_url, response: outcome.response, from: 'executing',
        });
      } else if (outcome.outcome === 'failed') {
        await this.settle(manager, current, 'failed', SYSTEM_MARKETING_ACTOR, { error: outcome.error, response: outcome.response, from: 'executing' });
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
    await this.persistNow().catch(() => {});
    this.audit.notify(row.account_id, row.campaign_id, 'spend_request', id, 'executed');
    return (await this.spendRepo.findOne({ where: { id } }))!;
  }

  /** sql.js 를 지금 파일로 내려 쓴다(Postgres 는 no-op). 진행 중인 트랜잭션이 끝난 뒤에 — export 가 연결을 다시 연다. */
  private persistNow(): Promise<boolean> {
    return afterSqljsTransactions(this.dataSource, () => flushSqljs(this.dataSource, true));
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
      where: { status: 'approved', provider: 'webhook', decided_at: LessThan(new Date(now.getTime() - STRANDED_APPROVED_MS)) },
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

  private async markInterrupted(row: MarketingSpendRequest, error: string): Promise<boolean> {
    const won = await this.spendRepo.createQueryBuilder().update(MarketingSpendRequest)
      .set({ status: 'unknown', error })
      .where('id = :id AND status = :s', { id: row.id, s: 'executing' })
      .execute();
    if (!won.affected) return false;
    await this.audit.record({
      accountId: row.account_id, campaignId: row.campaign_id, entityType: 'spend_request', entityId: row.id,
      action: 'spend.unknown', actor: SYSTEM_MARKETING_ACTOR, summary: `결제 결과 불명 — 사람이 대조해야 함: ${error}`,
    });
    this.audit.notify(row.account_id, row.campaign_id, 'spend_request', row.id, 'unknown');
    return true;
  }

  private assertReconcilable(row: MarketingSpendRequest): void {
    const ok = row.status === 'unknown' || (row.status === 'approved' && row.provider === 'manual');
    if (!ok) {
      throw marketingError(409, row.status === 'approved'
        ? 'this request is executed by the payment webhook — wait for its result (or reconcile it once it is unknown)'
        : `spend request is ${row.status} — only approved (manual) or unknown requests can be reconciled`);
    }
  }

  /** paid → release + capture, failed → release. 상태 CAS 와 원장과 감사가 한 트랜잭션. */
  private async settle(
    manager: import('typeorm').EntityManager,
    row: MarketingSpendRequest,
    to: 'paid' | 'failed',
    actor: MarketingActor,
    info: { provider_ref?: string; receipt_url?: string; error?: string; note?: string; response?: Record<string, any>; from: string },
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
      detail: { from: info.from, provider_ref: info.provider_ref || '', receipt_url: info.receipt_url || '', note: info.note || '', response_status: info.response?.status ?? null },
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
