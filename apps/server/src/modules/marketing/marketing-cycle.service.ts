import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { MarketingCycle } from '../../entities/MarketingCycle';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingPost } from '../../entities/MarketingPost';
import { MarketingSpendRequest } from '../../entities/MarketingSpendRequest';
import { MarketingBudgetAllocation } from '../../entities/MarketingBudgetAllocation';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingAuditEvent } from '../../entities/MarketingAuditEvent';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { parseRuntimeSpec, runtimeIdentityKey } from '../../common/runtime-spec';
import { CYCLE_LEASE_MS, SYSTEM_MARKETING_ACTOR, type MarketingActor } from '../../common/marketing/marketing-constants';
import { buildCyclePrompt, type CyclePromptInput } from '../../common/marketing/cycle-prompt';
import { formatMinorAmount } from '../../common/marketing/money';
import { enforceRunBudget } from '../../common/run-budget-guard';
import { LogService } from '../../services/log.service';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { MarketingAuditService } from './marketing-audit.service';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { MarketingCampaignService } from './marketing-campaign.service';
import { MarketingAgentService, agentRules } from './marketing-agent.service';
import { MarketingAnalyticsService } from './marketing-analytics.service';
import { MarketingFeedbackService } from './marketing-feedback.service';
import { marketingError } from './marketing-errors';
import { computeNextCycleAt, resolveLimits } from './marketing-campaign.logic';
import { DIRECT_PAYMENT_PROVIDER_LABELS, DIRECT_PROVIDER_SPECS, isDirectPaymentProvider } from '../../common/marketing/payment-routes';

const DEFAULT_TICK_MS = 60_000;
const MIN_TICK_MS = 5_000;
const MAX_TICK_MS = 60 * 60_000;
const TICK_BATCH = 50;
const DECISION_ACTIONS = ['post.rejected', 'post.failed', 'spend.denied', 'spend.failed', 'spend.expired', 'channel.rejected', 'allocation.rejected'];
const DECISION_LABELS: Record<string, string> = {
  post: '게시물', spend_request: '지출 요청', channel: '채널', allocation: '편성',
};

function clampEnv(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(max, Math.max(min, raw));
}

/**
 * MarketingCycleService — 마케팅 루프(docs/marketing.md "루프").
 *
 * Automation Schedule 과 같은 cron 의미(qa-cron 헬퍼 · 발화 **전에** 커서 전진 · 놓친 회차는 한 번만)를 쓰되
 * 자기 tick 을 갖는다: 지시문이 발화 시점의 상태로 만들어져야 하고, 앞 사이클이 아직 돌면 건너뛰어야 하고,
 * 캠페인 정지가 곧 중단이어야 해서다. 디스패치는 QA/Automation 과 같은 "방을 열고 에이전트를 앉혀 첫 메시지를
 * 보낸다" 모양이라 agent-manager · SSE contract 변경이 없다. 계정 run budget 의 `marketing` 축으로 센다.
 */
@Injectable()
export class MarketingCycleService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private readonly tickMs = clampEnv('MARKETING_SCHEDULER_TICK_MS', DEFAULT_TICK_MS, MIN_TICK_MS, MAX_TICK_MS);
  private readonly enabled = (process.env.MARKETING_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(MarketingCycle) private readonly cycleRepo: Repository<MarketingCycle>,
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(MarketingPost) private readonly postRepo: Repository<MarketingPost>,
    @InjectRepository(MarketingSpendRequest) private readonly spendRepo: Repository<MarketingSpendRequest>,
    @InjectRepository(MarketingBudgetAllocation) private readonly allocationRepo: Repository<MarketingBudgetAllocation>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingAuditEvent) private readonly auditRepo: Repository<MarketingAuditEvent>,
    @InjectRepository(ChatRoom) private readonly roomRepo: Repository<ChatRoom>,
    @InjectRepository(ChatRoomParticipant) private readonly participantRepo: Repository<ChatRoomParticipant>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly messaging: RoomMessagingService,
    private readonly logService: LogService,
    private readonly instanceQuiesce: InstanceQuiesceService,
    private readonly campaigns: MarketingCampaignService,
    private readonly agent: MarketingAgentService,
    private readonly analytics: MarketingAnalyticsService,
    private readonly feedback: MarketingFeedbackService,
    private readonly audit: MarketingAuditService,
    hooks: MarketingCampaignHooks,
  ) {
    hooks.onCampaignStopped(async (campaign, actor) => {
      const running = await this.cycleRepo.find({ where: { campaign_id: campaign.id, status: 'running' } });
      for (const c of running) await this.close(c, 'cancelled', actor, `campaign ${campaign.status}`);
    });
    hooks.onDeleteChildren(async (campaign, manager) => {
      await manager.getRepository(MarketingCycle).delete({ campaign_id: campaign.id });
    });
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => { this.runOnce().catch(() => {}); }, this.tickMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async list(campaign: MarketingCampaign, limit = 50): Promise<MarketingCycle[]> {
    return this.cycleRepo.find({ where: { campaign_id: campaign.id }, order: { cycle_no: 'DESC' }, take: Math.min(Math.max(limit, 1), 200) });
  }

  async get(id: string, accountId: string): Promise<MarketingCycle> {
    const row = id ? await this.cycleRepo.findOne({ where: { id } }) : null;
    if (!row || (!accountId || row.account_id !== accountId)) throw marketingError(404, 'cycle not found');
    return row;
  }

  /** 예약 tick 한 번(테스트가 직접 부른다). */
  async runOnce(now: Date = new Date()): Promise<{ dispatched: string[]; skipped: string[] }> {
    const out = { dispatched: [] as string[], skipped: [] as string[] };
    if (await this.instanceQuiesce.isQuiesced()) return out;
    const stale = await this.cycleRepo.find({ where: { status: 'running', started_at: LessThan(new Date(now.getTime() - CYCLE_LEASE_MS)) }, take: 200 });
    for (const c of stale) await this.close(c, 'timed_out', SYSTEM_MARKETING_ACTOR, 'not completed within 6 hours');

    const due = await this.campaignRepo.find({
      where: { status: 'active', next_cycle_at: LessThanOrEqual(now) },
      order: { next_cycle_at: 'ASC' },
      take: TICK_BATCH,
    });
    for (const campaign of due) {
      // 발화 전에 커서를 옮긴다 — 겹친 tick 은 아무것도 하지 않고, 서버가 오래 꺼져 있었어도 한 번만 돈다.
      campaign.next_cycle_at = computeNextCycleAt(campaign, now);
      await this.campaigns.saveCursor(campaign);
      try {
        const cycle = await this.dispatch(campaign, 'schedule', SYSTEM_MARKETING_ACTOR, now);
        out.dispatched.push(cycle.id);
      } catch (e: any) {
        out.skipped.push(campaign.id);
        this.logService.warn('Marketing', 'cycle not started', { campaign_id: campaign.id, err: e?.message || String(e) });
      }
    }
    return out;
  }

  /** 사람이 누르는 "지금 실행" — 예약과 같은 경로. 커서는 건드리지 않는다. */
  async runNow(campaignId: string, accountId: string, actor: MarketingActor): Promise<MarketingCycle> {
    const campaign = await this.campaigns.get(campaignId, accountId);
    return this.dispatch(campaign, 'manual', actor, new Date());
  }

  async complete(cycle: MarketingCycle, actor: MarketingActor, body: { summary?: unknown; next_actions?: unknown }): Promise<MarketingCycle> {
    const summary = typeof body.summary === 'string' ? body.summary.trim().slice(0, 8000) : '';
    if (!summary) throw marketingError(400, 'summary is required — what you did, what is waiting for people, what you learned');
    const raw = Array.isArray(body.next_actions) ? body.next_actions : [];
    const nextActions = raw.filter((a) => typeof a === 'string' && a.trim()).slice(0, 20).map((a) => (a as string).trim().slice(0, 500));
    const won = await this.cycleRepo.createQueryBuilder().update(MarketingCycle)
      .set({ status: 'completed', completed_at: new Date(), summary, next_actions: nextActions })
      .where('id = :id AND status = :s', { id: cycle.id, s: 'running' })
      .execute();
    if (!won.affected) throw marketingError(409, `cycle is ${cycle.status}, not running`);
    await this.audit.record({
      accountId: cycle.account_id, campaignId: cycle.campaign_id, entityType: 'cycle', entityId: cycle.id, action: 'cycle.completed', actor,
      summary: `사이클 #${cycle.cycle_no} 완료: ${summary.slice(0, 160)}`, detail: { next_actions: nextActions },
    });
    this.audit.notify(cycle.account_id, cycle.campaign_id, 'cycle', cycle.id, 'completed');
    return (await this.cycleRepo.findOne({ where: { id: cycle.id } }))!;
  }

  async findById(id: string): Promise<MarketingCycle | null> {
    return id ? this.cycleRepo.findOne({ where: { id } }) : null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async dispatch(campaign: MarketingCampaign, trigger: 'schedule' | 'manual', actor: MarketingActor, now: Date): Promise<MarketingCycle> {
    // 방 · 사이클 행을 만들기 전에 — 계정 run budget(`marketing` 축)이 폭주를 막는다.
    await enforceRunBudget({ dataSource: this.dataSource, roomMessagingService: this.messaging, logger: this.logService }, 'marketing', campaign.account_id);
    if (campaign.status !== 'active') throw marketingError(409, `campaign is ${campaign.status} — activate it to run cycles`);
    const spec = parseRuntimeSpec(campaign.agent_runtime);
    if (!spec) throw marketingError(409, 'the campaign has no agent');
    const running = await this.cycleRepo.findOne({ where: { campaign_id: campaign.id, status: 'running' }, order: { started_at: 'DESC' } });
    if (running) {
      if (now.getTime() - new Date(running.started_at).getTime() < CYCLE_LEASE_MS) {
        throw marketingError(409, `cycle #${running.cycle_no} is still running — it must complete (or time out) first`);
      }
      await this.close(running, 'timed_out', SYSTEM_MARKETING_ACTOR, 'not completed within 6 hours');
    }
    const last = await this.cycleRepo.findOne({ where: { campaign_id: campaign.id }, order: { cycle_no: 'DESC' } });
    const cycleNo = (last?.cycle_no || 0) + 1;
    const agentKey = runtimeIdentityKey(spec);
    let cycle: MarketingCycle;
    try {
      cycle = await this.cycleRepo.save(this.cycleRepo.create({
        account_id: campaign.account_id,
        campaign_id: campaign.id,
        cycle_no: cycleNo,
        status: 'running',
        trigger,
        triggered_by: actor.type === 'user' ? actor.id : '',
        room_id: '',
        agent_key: agentKey,
        started_at: now,
        next_actions: [],
      }));
    } catch {
      throw marketingError(409, 'another cycle started at the same moment');
    }
    try {
      const { input, untrusted } = await this.collectState(campaign, cycle);
      const prompt = buildCyclePrompt(input);
      const room = await this.roomRepo.save(this.roomRepo.create({
        account_id: campaign.account_id,
        type: 'group',
        name: `Marketing: ${campaign.name} #${cycleNo}`.slice(0, 200),
        last_message_at: null,
      }));
      const joinedAt = new Date();
      await this.participantRepo.save([
        this.participantRepo.create({
          room_id: room.id, participant_type: 'agent', participant_id: agentKey, runtime_spec: { ...spec }, last_read_at: joinedAt, left_at: null,
        }),
        this.participantRepo.create({
          room_id: room.id, participant_type: 'user', participant_id: 'system', last_read_at: joinedAt, left_at: null,
        }),
      ]);
      await this.cycleRepo.update({ id: cycle.id }, { room_id: room.id, untrusted_items: untrusted });
      campaign.last_cycle_at = now;
      campaign.cycle_count = cycleNo;
      await this.campaigns.saveCursor(campaign);
      await this.messaging.sendMessage(room.id, campaign.account_id, 'user', 'system', 'Marketing', prompt);
      await this.audit.record({
        accountId: campaign.account_id, campaignId: campaign.id, entityType: 'cycle', entityId: cycle.id, action: 'cycle.started', actor,
        summary: `사이클 #${cycleNo} 시작(${trigger === 'manual' ? '수동' : '예약'})${untrusted ? ` — 외부 글 ${untrusted}건 비신뢰 블록` : ''}`,
        detail: { room_id: room.id, agent_key: agentKey, untrusted_items: untrusted },
      });
      this.audit.notify(campaign.account_id, campaign.id, 'cycle', cycle.id, 'started');
      return (await this.cycleRepo.findOne({ where: { id: cycle.id } }))!;
    } catch (e: any) {
      await this.cycleRepo.update({ id: cycle.id }, { status: 'failed', error: String(e?.message || e).slice(0, 2000), completed_at: new Date() });
      throw e;
    }
  }

  /** 지시문에 실을 상태. 외부 글은 직전 사이클 이후(없으면 최근 7 일) 것만. */
  private async collectState(campaign: MarketingCampaign, cycle: MarketingCycle): Promise<{ input: CyclePromptInput; untrusted: number }> {
    const previous = await this.cycleRepo.findOne({
      where: { campaign_id: campaign.id, cycle_no: LessThan(cycle.cycle_no) },
      order: { cycle_no: 'DESC' },
    });
    // sql.js 의 생성 시각은 초 단위라 같은 초에 남은 결정이 빠지지 않게 초로 내리고 ">=" 로 비교한다
    // (같은 초의 글이 두 사이클에 한 번 더 실릴 수는 있다 — 빠지는 것보다 낫다).
    const since = previous
      ? new Date(Math.floor(new Date(previous.started_at).getTime() / 1000) * 1000)
      : new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const [overview, report, recorded, collected, drafts, spend, allocations, proposedChannels, decisions, stoppedPosts] = await Promise.all([
      this.agent.overview(campaign),
      this.analytics.report(campaign).catch(() => null),
      this.feedback.list(campaign, { since, limit: 15 }),
      this.feedback.collected(campaign, { since, limit: 10 }),
      this.postRepo.count({ where: { campaign_id: campaign.id, status: 'draft' } }),
      this.spendRepo.count({ where: { campaign_id: campaign.id, status: 'pending' } }),
      this.allocationRepo.count({ where: { campaign_id: campaign.id, status: 'proposed' } }),
      this.channelRepo.count({ where: { campaign_id: campaign.id, status: 'proposed' } }),
      this.auditRepo.find({ where: { campaign_id: campaign.id, action: In(DECISION_ACTIONS), created_at: MoreThanOrEqual(since) }, order: { created_at: 'DESC' }, take: 10 }),
      this.postRepo.find({
        where: { account_id: campaign.account_id, campaign_id: campaign.id, status: 'published', engagement_next_at: IsNull(), updated_at: MoreThanOrEqual(since) },
        select: ['id', 'channel_id', 'engagement'],
        order: { updated_at: 'DESC' },
      }),
    ]);
    const channelNames = new Map(overview.channels.map((c: any) => [c.id, c.name]));
    const untrusted = [
      ...recorded.map((f) => ({
        source: `${String(channelNames.get(f.channel_id) || 'feedback')}${f.contact_id ? ' · 메일 답장' : ''}`,
        author: f.author,
        category: f.category,
        text: f.content,
      })),
      ...collected.map(({ item, channel }) => ({ source: channel.name, author: item.author, category: item.classification, text: `(collected item, status ${item.status})` })),
    ];
    const budget = overview.budget;
    const input: CyclePromptInput = {
      cycle: { id: cycle.id, cycle_no: cycle.cycle_no, trigger: cycle.trigger },
      campaign: {
        id: campaign.id,
        name: campaign.name,
        product_brief: campaign.product_brief,
        goal: campaign.goal,
        target_audience: campaign.target_audience,
        capabilities: campaign.capabilities || [],
        currency: campaign.currency,
        allowed_domains: campaign.allowed_domains || [],
        payees: (campaign.payees || []).map((p) => p.name),
        direct_payees: (campaign.payees || []).flatMap((p) => (isDirectPaymentProvider(p.provider)
          ? [{
            name: p.name,
            provider: DIRECT_PAYMENT_PROVIDER_LABELS[p.provider],
            effect: DIRECT_PROVIDER_SPECS[p.provider].kind === 'card'
              ? 'amount_minor 한도의 가상 카드 발급'
              : '광고 캠페인 지출 상한을 amount_minor 만큼 올림',
          }]
          : [])),
      },
      rules: agentRules(campaign),
      limits: resolveLimits(campaign),
      // 가이드 · 규칙 문장은 사람이 승인한(active · paused) 채널 것만 싣는다. 제안 단계의 문장은 에이전트가 외부 페이지를
      // 읽고 옮긴 것이라 지시문의 신뢰 구역(비신뢰 블록 밖)에 둘 수 없다.
      channels: overview.channels.map((c: any) => {
        const reviewed = c.status === 'active' || c.status === 'paused';
        return {
          id: c.id, name: c.name, platform: c.platform, kind: c.kind, status: c.status, target: c.target,
          guidelines: reviewed ? c.guidelines : '', rules_summary: reviewed ? c.rules_summary : '', audience_count: c.audience_count,
          on_hold: c.list_on_hold === true,
        };
      }),
      budget: [
        budget.text.total,
        budget.text.period,
        ...budget.channels.filter((c: any) => c.allocation_minor !== null).map((c: any) => {
          const fmt = (n: number) => formatMinorAmount(n, budget.currency);
          return `${c.name}: 편성 ${fmt(c.allocation_minor)}, 이번 기간 지출 ${fmt(c.period_spent_minor)} + 보류 ${fmt(c.period_held_minor)}, 남음 ${fmt(c.period_available_minor ?? 0)}`;
        }),
        `결제 방식(경로가 없는 수취인): ${budget.payment_provider}`,
      ],
      pending: { drafts, spend, allocations, channels: proposedChannels },
      // 결정은 "무엇(종류 · id) · 결과 · 사람의 사유" 만 — 감사 요약에는 에이전트가 쓴 제목이 섞여 있어 싣지 않는다.
      decisions: decisions.map((d) => ({
        what: `${DECISION_LABELS[d.entity_type] || d.entity_type} ${d.entity_id.slice(0, 8)}`,
        status: d.action,
        note: String((d.detail as any)?.note || (d.detail as any)?.error || ''),
      })),
      unavailable_posts: stoppedPosts.filter((p) => p.engagement?.availability
        && Date.parse(p.engagement.availability_checked_at || '') >= since.getTime()).slice(0, 15).map((p) => ({
        id: p.id, channel_id: p.channel_id, availability: p.engagement.availability,
        checked_at: p.engagement.availability_checked_at!,
      })),
      // 성과 줄도 사람이 승인한 채널 것만(제안 단계 채널의 이름은 에이전트가 쓴 글이다).
      report: report
        ? report.channels.map((c, i) => ({ c, line: report.lines[i] }))
          .filter(({ c }) => c.status === 'active' || c.status === 'paused')
          .map(({ line }) => line)
        : [],
      previous: previous ? { cycle_no: previous.cycle_no, status: previous.status, summary: previous.summary, next_actions: previous.next_actions || [] } : null,
      untrusted,
    };
    return { input, untrusted: Math.min(untrusted.length, 15) };
  }

  private async close(cycle: MarketingCycle, status: 'timed_out' | 'cancelled', actor: MarketingActor, reason: string): Promise<void> {
    const won = await this.cycleRepo.createQueryBuilder().update(MarketingCycle)
      .set({ status, completed_at: new Date(), error: reason })
      .where('id = :id AND status = :s', { id: cycle.id, s: 'running' })
      .execute();
    if (!won.affected) return;
    await this.audit.record({
      accountId: cycle.account_id, campaignId: cycle.campaign_id, entityType: 'cycle', entityId: cycle.id, action: `cycle.${status}`, actor,
      summary: `사이클 #${cycle.cycle_no} ${status === 'timed_out' ? '시간 초과' : '취소'}: ${reason}`,
    });
    this.audit.notify(cycle.account_id, cycle.campaign_id, 'cycle', cycle.id, status);
  }
}
