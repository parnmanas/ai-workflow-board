import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { Project } from '../../entities/Project';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { Credential } from '../../entities/Credential';
import { normalizeRuntimeSpec } from '../../common/runtime-spec';
import { normalizeCurrency, parseMinorAmount, MarketingMoneyError } from '../../common/marketing/money';
import { PAYMENT_PROVIDERS, type MarketingActor, type CampaignStatus } from '../../common/marketing/marketing-constants';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { marketingError } from './marketing-errors';
import { resolveMarketingSecret } from './marketing-credential';
import { readWebhookSecret } from './marketing-payments';
import {
  assertTransition,
  computeNextCycleAt,
  makeCampaignSlug,
  normalizeAllowedDomains,
  normalizeBudgetPeriod,
  normalizeCadence,
  normalizeCapabilities,
  normalizeDisclosure,
  normalizeFeedbackTicketStatus,
  normalizeLimits,
  normalizeLongText,
  normalizeName,
  normalizePayees,
  normalizeStatus,
} from './marketing-campaign.logic';

/** REST/MCP 의 snake_case 본문 그대로. 정의되지 않은 키는 건드리지 않는다. */
export type CampaignInput = Record<string, unknown>;

/** 이 키들은 감사 로그에 이전/이후 값을 그대로 남긴다(짧은 값). 긴 글은 "바뀜" 만 남긴다. */
const SCALAR_AUDIT_KEYS = [
  'name', 'project_id', 'capabilities', 'cycle_cron', 'cycle_interval_ms', 'currency', 'budget_total_minor',
  'budget_period', 'budget_period_minor', 'max_transaction_minor', 'dual_approval_threshold_minor', 'payees',
  'allowed_domains', 'disclosure', 'limits', 'feedback_ticket_status', 'agent_key', 'payment_provider',
  'payment_credential_id',
] as const;
const TEXT_AUDIT_KEYS = ['product_brief', 'goal', 'target_audience'] as const;

/**
 * MarketingCampaignService — 캠페인 CRUD 와 상태 전이(docs/marketing.md).
 *
 * 모든 입력은 marketing-campaign.logic.ts 의 순수 정규화를 지난다. 이 서비스가 더하는 것은
 * DB 를 봐야 아는 검사(같은 실행 키의 Project · 존재하는 Runtime Host · 원장이 생긴 뒤의 통화 고정)와
 * 감사 기록이다. 다른 마케팅 기능(지출 · 사이클 …)은 MarketingCampaignHooks 로 상태 전이에
 * 끼어든다 — 이 서비스가 그 서비스들을 직접 알면 순환 의존이 생긴다.
 */
@Injectable()
export class MarketingCampaignService {
  constructor(
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(Project) private readonly projectRepo: Repository<Project>,
    @InjectRepository(RuntimeHost) private readonly hostRepo: Repository<RuntimeHost>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: MarketingAuditService,
    private readonly hooks: MarketingCampaignHooks,
  ) {}

  async list(accountIds: string[]): Promise<MarketingCampaign[]> {
    if (!accountIds.length) return [];
    return this.campaignRepo.find({
      where: { account_id: In(accountIds) },
      order: { updated_at: 'DESC' },
    });
  }

  /** 실행 키(account_id)까지 맞아야 찾는다. 맞지 않으면 "없음" 과 구별하지 않는다. */
  async get(id: string, accountId: string): Promise<MarketingCampaign> {
    const row = id ? await this.campaignRepo.findOne({ where: { id } }) : null;
    if (!row || (!accountId || row.account_id !== accountId)) throw marketingError(404, 'campaign not found');
    return row;
  }

  /** MCP 용 — 계정 검사는 호출자가 캠페인의 account_id 로 한다. */
  async findById(id: string): Promise<MarketingCampaign | null> {
    if (!id) return null;
    return this.campaignRepo.findOne({ where: { id } });
  }

  async create(accountId: string, body: CampaignInput, actor: MarketingActor): Promise<MarketingCampaign> {
    if (!accountId) throw marketingError(400, 'account_id is required');
    const name = normalizeName(body.name);
    const row = this.campaignRepo.create({
      account_id: accountId,
      name,
      slug: makeCampaignSlug(name),
      status: 'draft',
      product_brief: '',
      goal: '',
      target_audience: '',
      capabilities: [],
      agent_runtime: null,
      cycle_cron: null,
      cycle_interval_ms: null,
      next_cycle_at: null,
      last_cycle_at: null,
      cycle_count: 0,
      currency: 'KRW',
      budget_total_minor: 0,
      budget_period: 'month',
      budget_period_minor: 0,
      max_transaction_minor: 0,
      dual_approval_threshold_minor: 0,
      spend_version: 0,
      payment_provider: 'manual',
      payment_credential_id: null,
      payees: [],
      allowed_domains: [],
      disclosure: normalizeDisclosure(''),
      limits: {},
      feedback_ticket_status: 'backlog',
      improvement_assignee: null,
      project_id: null,
      created_by: actor.id || '',
    });
    await this.applyInput(row, body, { creating: true });
    const saved = await this.campaignRepo.save(row);
    await this.audit.record({
      accountId,
      campaignId: saved.id,
      entityType: 'campaign',
      entityId: saved.id,
      action: 'campaign.created',
      actor,
      summary: `캠페인 "${saved.name}" 생성`,
      detail: { capabilities: saved.capabilities, currency: saved.currency },
    });
    this.audit.notify(accountId, saved.id, 'campaign', saved.id, 'created');
    return saved;
  }

  async update(id: string, accountId: string, body: CampaignInput, actor: MarketingActor): Promise<MarketingCampaign> {
    const row = await this.get(id, accountId);
    const before = snapshot(row);
    await this.applyInput(row, body, { creating: false });
    if (body.status !== undefined) {
      // 상태도 같은 PATCH 로 받지만 전이 규칙은 setStatus 와 같다.
      const status = normalizeStatus(body.status);
      if (status !== row.status) return this.setStatus(id, accountId, status, actor, row, before);
    }
    if (row.status === 'active') row.next_cycle_at = this.cursorAfterEdit(row, before);
    const saved = await this.campaignRepo.save(row);
    await this.recordUpdate(saved, before, actor);
    this.audit.notify(saved.account_id, saved.id, 'campaign', saved.id, 'updated');
    return saved;
  }

  async setStatus(
    id: string,
    accountId: string,
    status: CampaignStatus,
    actor: MarketingActor,
    preloaded?: MarketingCampaign,
    preloadedBefore?: ReturnType<typeof snapshot>,
  ): Promise<MarketingCampaign> {
    const row = preloaded || await this.get(id, accountId);
    const before = preloadedBefore || snapshot(row);
    const from = before.status as string;
    assertTransition(from, status);
    if (status === 'active') {
      if (!row.agent_runtime) throw marketingError(409, 'set agent_runtime before activating the campaign');
      if (row.capabilities.includes('feedback_to_product') && !row.project_id) {
        throw marketingError(409, 'feedback_to_product needs project_id (the product the feedback improves)');
      }
    }
    row.status = status;
    row.next_cycle_at = status === 'active' ? computeNextCycleAt(row, new Date()) : null;
    const saved = await this.campaignRepo.save(row);
    await this.recordUpdate(saved, before, actor);
    await this.audit.record({
      accountId: saved.account_id,
      campaignId: saved.id,
      entityType: 'campaign',
      entityId: saved.id,
      action: `campaign.${status}`,
      actor,
      summary: `캠페인 상태 ${from} → ${status}`,
      detail: { from, to: status },
    });
    if (status !== 'active') await this.hooks.campaignStopped(saved, actor);
    this.audit.notify(saved.account_id, saved.id, 'campaign', saved.id, `status:${status}`);
    return saved;
  }

  /**
   * 삭제는 돈이 한 번도 오가지 않은 캠페인만. 지출 요청이나 원장 행이 있으면 보관(archived)해야 한다 —
   * 결제 기록의 맥락(어느 캠페인의 무슨 목적이었나)이 사라지면 안 된다. 감사 로그는 남는다.
   */
  async remove(id: string, accountId: string, actor: MarketingActor): Promise<void> {
    const row = await this.get(id, accountId);
    const blocker = await this.hooks.deletionBlocker(row);
    if (blocker) throw marketingError(409, `${blocker} — archive the campaign instead`);
    await this.dataSource.transaction(async (manager) => {
      await this.hooks.deleteChildren(row, manager);
      await manager.getRepository(MarketingCampaign).delete({ id: row.id });
      await this.audit.record({
        accountId: row.account_id,
        campaignId: row.id,
        entityType: 'campaign',
        entityId: row.id,
        action: 'campaign.deleted',
        actor,
        summary: `캠페인 "${row.name}" 삭제`,
      }, manager);
    });
    this.audit.notify(row.account_id, row.id, 'campaign', row.id, 'deleted');
  }

  /** 사이클 서비스가 커서를 옮길 때 — 감사할 사용자 변경이 아니라 시스템 상태다. */
  async saveCursor(row: MarketingCampaign): Promise<void> {
    await this.campaignRepo.update({ id: row.id }, {
      next_cycle_at: row.next_cycle_at,
      last_cycle_at: row.last_cycle_at,
      cycle_count: row.cycle_count,
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async applyInput(row: MarketingCampaign, body: CampaignInput, opts: { creating: boolean }): Promise<void> {
    try {
      if (!opts.creating && body.name !== undefined) row.name = normalizeName(body.name);
      if (body.product_brief !== undefined) row.product_brief = normalizeLongText(body.product_brief, 'product_brief');
      if (body.goal !== undefined) row.goal = normalizeLongText(body.goal, 'goal');
      if (body.target_audience !== undefined) row.target_audience = normalizeLongText(body.target_audience, 'target_audience');
      if (body.capabilities !== undefined) row.capabilities = normalizeCapabilities(body.capabilities);
      if (body.cycle_cron !== undefined || body.cycle_interval_ms !== undefined) {
        const cadence = normalizeCadence(
          body.cycle_cron !== undefined ? body.cycle_cron : row.cycle_cron,
          body.cycle_interval_ms !== undefined ? body.cycle_interval_ms : row.cycle_interval_ms,
        );
        row.cycle_cron = cadence.cron;
        row.cycle_interval_ms = cadence.intervalMs;
      }
      if (body.currency !== undefined) {
        const currency = normalizeCurrency(body.currency);
        if (currency !== row.currency && !opts.creating) {
          const blocker = await this.hooks.currencyChangeBlocker(row);
          if (blocker) throw marketingError(409, blocker);
        }
        row.currency = currency;
      }
      if (body.budget_total_minor !== undefined) row.budget_total_minor = parseMinorAmount(body.budget_total_minor, 'budget_total_minor', { allowZero: true });
      if (body.budget_period !== undefined) row.budget_period = normalizeBudgetPeriod(body.budget_period);
      if (body.budget_period_minor !== undefined) row.budget_period_minor = parseMinorAmount(body.budget_period_minor, 'budget_period_minor', { allowZero: true });
      if (body.max_transaction_minor !== undefined) row.max_transaction_minor = parseMinorAmount(body.max_transaction_minor, 'max_transaction_minor', { allowZero: true });
      if (body.dual_approval_threshold_minor !== undefined) {
        row.dual_approval_threshold_minor = parseMinorAmount(body.dual_approval_threshold_minor, 'dual_approval_threshold_minor', { allowZero: true });
      }
      if (body.payees !== undefined) row.payees = normalizePayees(body.payees);
      if (body.allowed_domains !== undefined) row.allowed_domains = normalizeAllowedDomains(body.allowed_domains);
      if (body.disclosure !== undefined) row.disclosure = normalizeDisclosure(body.disclosure);
      if (body.limits !== undefined) row.limits = normalizeLimits(body.limits);
      if (body.feedback_ticket_status !== undefined) row.feedback_ticket_status = normalizeFeedbackTicketStatus(body.feedback_ticket_status);
    } catch (e) {
      if (e instanceof MarketingMoneyError) throw marketingError(400, e.message);
      throw e;
    }

    if (body.project_id !== undefined) {
      const projectId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
      if (projectId) {
        const project = await this.projectRepo.findOne({ where: { id: projectId }, select: ['id', 'account_id'] });
        if (!project || project.account_id !== row.account_id) {
          throw marketingError(400, 'project_id must be a project in the same account');
        }
        row.project_id = project.id;
      } else {
        row.project_id = null;
      }
    }
    if (body.payment_provider !== undefined || body.payment_credential_id !== undefined) {
      const provider = body.payment_provider !== undefined ? String(body.payment_provider || '').trim() : row.payment_provider;
      if (!(PAYMENT_PROVIDERS as readonly string[]).includes(provider)) {
        throw marketingError(400, `payment_provider must be one of: ${PAYMENT_PROVIDERS.join(', ')}`);
      }
      const credentialId = body.payment_credential_id !== undefined
        ? (typeof body.payment_credential_id === 'string' ? body.payment_credential_id.trim() : '') || null
        : row.payment_credential_id;
      if (provider === 'webhook') {
        if (!credentialId) throw marketingError(400, 'payment_provider webhook needs payment_credential_id (webhook_url + secret)');
        // 지금 읽을 수 있고 모양이 맞는지 저장 시점에 확인한다 — 승인 순간에 처음 알게 되면 늦다.
        readWebhookSecret(await resolveMarketingSecret(this.credentialRepo, credentialId, row.account_id));
      }
      row.payment_provider = provider;
      row.payment_credential_id = provider === 'webhook' ? credentialId : null;
    }
    if (body.agent_runtime !== undefined) {
      row.agent_runtime = await this.normalizeSpec(body.agent_runtime, 'agent_runtime', row.account_id);
      row.refreshRuntimeIdentity();
    }
    if (body.improvement_assignee !== undefined) {
      row.improvement_assignee = await this.normalizeSpec(body.improvement_assignee, 'improvement_assignee', row.account_id);
    }
    if (row.capabilities.includes('feedback_to_product') && !row.project_id && row.status === 'active') {
      throw marketingError(400, 'feedback_to_product needs project_id (the product the feedback improves)');
    }
    if (row.status === 'active' && !row.agent_runtime) {
      throw marketingError(400, 'an active campaign needs agent_runtime — pause it first to clear the agent');
    }
  }

  private async normalizeSpec(value: unknown, label: string, accountId: string): Promise<Record<string, any> | null> {
    if (value === null || value === '') return null;
    let spec;
    try {
      spec = normalizeRuntimeSpec(value, label);
    } catch (e: any) {
      throw marketingError(400, e?.message || `invalid ${label}`);
    }
    const host = await this.hostRepo.findOne({ where: { id: spec.manager_agent_id } });
    if (!host?.is_active || host.account_id !== accountId) {
      throw marketingError(400, `${label} references an unavailable Runtime Host of this account`);
    }
    if (spec.credential_id) {
      // 실행 키가 다른 credential 은 저장 때 거부한다 — 실행 순간(매니저의 credential 조회)에 403 으로 늦게 터지지 않게.
      const cred = await this.credentialRepo.findOne({ where: { id: spec.credential_id }, select: ['id', 'account_id'] });
      if (!cred || (cred.account_id !== null && cred.account_id !== accountId)) {
        throw marketingError(400, `${label}.credential_id is not a credential of this account`);
      }
    }
    return { ...spec };
  }

  /** active 캠페인의 cadence 가 바뀌었으면 지금부터 다시 센다. 그대로면 기존 커서를 지킨다. */
  private cursorAfterEdit(row: MarketingCampaign, before: ReturnType<typeof snapshot>): Date | null {
    const cadenceChanged = row.cycle_cron !== before.cycle_cron || row.cycle_interval_ms !== before.cycle_interval_ms;
    if (cadenceChanged || !row.next_cycle_at) return computeNextCycleAt(row, new Date());
    return row.next_cycle_at;
  }

  private async recordUpdate(row: MarketingCampaign, before: ReturnType<typeof snapshot>, actor: MarketingActor): Promise<void> {
    const after = snapshot(row);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of SCALAR_AUDIT_KEYS) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { from: before[key], to: after[key] };
    }
    const textChanged = TEXT_AUDIT_KEYS.filter((key) => before[key] !== after[key]);
    if (!Object.keys(changes).length && !textChanged.length) return;
    await this.audit.record({
      accountId: row.account_id,
      campaignId: row.id,
      entityType: 'campaign',
      entityId: row.id,
      action: 'campaign.updated',
      actor,
      summary: `캠페인 설정 변경: ${[...Object.keys(changes), ...textChanged].join(', ')}`,
      detail: { changes, text_changed: textChanged },
    });
  }
}

function snapshot(row: MarketingCampaign) {
  return {
    status: row.status,
    name: row.name,
    project_id: row.project_id,
    capabilities: [...(row.capabilities || [])],
    cycle_cron: row.cycle_cron,
    cycle_interval_ms: row.cycle_interval_ms,
    currency: row.currency,
    budget_total_minor: row.budget_total_minor,
    budget_period: row.budget_period,
    budget_period_minor: row.budget_period_minor,
    max_transaction_minor: row.max_transaction_minor,
    dual_approval_threshold_minor: row.dual_approval_threshold_minor,
    payees: JSON.parse(JSON.stringify(row.payees || [])),
    allowed_domains: [...(row.allowed_domains || [])],
    disclosure: row.disclosure,
    limits: { ...(row.limits || {}) },
    feedback_ticket_status: row.feedback_ticket_status,
    agent_key: row.agent_key,
    payment_provider: row.payment_provider,
    payment_credential_id: row.payment_credential_id,
    product_brief: row.product_brief,
    goal: row.goal,
    target_audience: row.target_audience,
  };
}
