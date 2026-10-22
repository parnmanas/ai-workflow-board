import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, type FindOptionsWhere, type ObjectLiteral } from 'typeorm';
import { MarketingCampaign } from '../../entities/MarketingCampaign';
import { MarketingChannel } from '../../entities/MarketingChannel';
import { MarketingPost } from '../../entities/MarketingPost';
import { MarketingBudgetAllocation } from '../../entities/MarketingBudgetAllocation';
import { MarketingSpendRequest } from '../../entities/MarketingSpendRequest';
import { MarketingCycle } from '../../entities/MarketingCycle';
import { MarketingApprovalNotice } from '../../entities/MarketingApprovalNotice';
import type { User } from '../../entities/User';
import {
  approvalDigestDue,
  approvalNoticesFor,
  composeApprovalDigest,
  proposalNoticeCandidate,
  spendNoticeCandidate,
  type ApprovalNoticeCandidate,
  type ApprovalNoticeRecipient,
} from '../../common/marketing/approval-notice';
import { AccountAccessService } from '../../services/account-access.service';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { LogService } from '../../services/log.service';
import { UserChannelDispatcherService } from '../../services/notification-providers';
import { MarketingCampaignHooks } from './marketing-campaign-hooks';
import { MarketingListHoldService } from './marketing-list-hold.service';

const SWEEP_MS = 60_000;
/** 한 사람에게 보내는 것 전체의 상한. provider 는 요청마다 끊지만 바인딩 수 · 429 재시도만큼 길어진다. */
const SEND_TIMEOUT_MS = 30_000;
/** 선점 INSERT 한 번의 행 수. 큰 묶음도 바인드 변수 상한(sqlite · Postgres)을 넘지 않는다. */
const CLAIM_CHUNK = 500;

export interface ApprovalNoticeSweep {
  /** 이번에 선점해 보낸 계정 수 */
  accounts: number;
  /** 그 계정들의 알림 항목 수 */
  items: number;
  /** 한 통 이상 받을 사람 수 */
  recipients: number;
  /** provider 별 결과(바인딩 단위) */
  sent: number;
  failed: number;
}

function parsePermissions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  const value = error as {
    code?: string;
    errno?: number;
    message?: string;
    driverError?: { code?: string; errno?: number; message?: string };
  } | null;
  const driverError = value?.driverError;
  const code = driverError?.code ?? value?.code;
  const errno = driverError?.errno ?? value?.errno;
  const message = driverError?.message ?? value?.message ?? '';
  return code === '23505'
    || code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'ER_DUP_ENTRY'
    || errno === 1062
    || /unique constraint failed/i.test(message);
}

/**
 * provider 의 요청 단위 상한과 별개로 한 사람 몫 전체를 끊는다. 끊어도 보내던 것은 뒤에서 마저 간다 — sweep 만 기다리지
 * 않고 다음으로 넘어간다(선점은 이미 썼으니 다음 sweep 이 다시 보내지 않는다).
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`notification send timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const list = out.get(key(item));
    if (list) list.push(item);
    else out.set(key(item), [item]);
  }
  return out;
}

/**
 * 승인 대기 알림(docs/marketing.md "승인 대기 알림") — 사람의 결정을 기다리는 지출 요청 · 결과 불명 결제 · 두 번째 승인 ·
 * 편성 · 채널 · 게시물을 그 사람의 Discord/Slack/Telegram(UserChannel)으로 묶어 알린다. 규칙은 common/marketing/approval-notice.ts.
 *
 * ── 왜 전이 지점에서 보내지 않고 상태를 훑는가 ─────────────────────────────
 * 요청 · 제안 · 승인 · 결제 결과는 여러 서비스의 여러 경로에서 생긴다. 경로마다 보내면 하나를 빠뜨리는 순간 조용히
 * 알림이 사라지고, 알림 실패가 돈 · 게시 트랜잭션에 섞인다. 그래서 1분마다 승인함과 같은 기준으로 **지금 상태**를 읽는다.
 * 그 사이 이미 결정된 것은 저절로 빠지고, 재시작 동안 생긴 것은 다음 sweep 이 줍는다.
 *
 * ── 한 번만 ───────────────────────────────────────────────────────────────
 * (대상, 종류)마다 `marketing_approval_notices` 에 한 행을 발송 **전에** 쓴다(유일 인덱스). 계정 하나의 묶음은 한
 * 트랜잭션으로 선점한다. 서버가 둘이어도 진 쪽은 그 계정을 건너뛰고, 다음 sweep 이 남은 것을 다시 본다. 발송이 실패하면
 * 그 알림만 잃는다. 승인함과 사이드바 배지는 그대로 보인다. 오케스트레이션 confirm 알림과 같은 계약이다.
 *
 * ── 왜 `notify_mention` 인가 ──────────────────────────────────────────────
 * confirm 게이트 알림(OrchestrationConfirmNotifyService)과 같은 판단이다. 시스템이 **당신의** 결정을 요구하고, 결정 없이는
 * 일이 진행되지 않는다(지출 요청은 72시간 뒤 만료된다). 이 플래그는 기본값이 켜져 있어 실제로 사람에게 닿는다.
 *
 * sweep 은 던지지 않는다 — 알림이 마케팅의 다른 일을 막지 않는다.
 */
@Injectable()
export class MarketingApprovalNotifyService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private readonly enabled = (process.env.MARKETING_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
  private sweeping = false;

  constructor(
    @InjectRepository(MarketingCampaign) private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectRepository(MarketingChannel) private readonly channelRepo: Repository<MarketingChannel>,
    @InjectRepository(MarketingPost) private readonly postRepo: Repository<MarketingPost>,
    @InjectRepository(MarketingBudgetAllocation) private readonly allocationRepo: Repository<MarketingBudgetAllocation>,
    @InjectRepository(MarketingSpendRequest) private readonly spendRepo: Repository<MarketingSpendRequest>,
    @InjectRepository(MarketingCycle) private readonly cycleRepo: Repository<MarketingCycle>,
    @InjectRepository(MarketingApprovalNotice) private readonly noticeRepo: Repository<MarketingApprovalNotice>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly dispatcher: UserChannelDispatcherService,
    private readonly accountAccess: AccountAccessService,
    private readonly instanceQuiesce: InstanceQuiesceService,
    private readonly logService: LogService,
    private readonly listHolds: MarketingListHoldService,
    hooks: MarketingCampaignHooks,
  ) {
    hooks.onDeleteChildren(async (campaign, manager) => {
      await manager.getRepository(MarketingApprovalNotice).delete({ campaign_id: campaign.id });
    });
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => { this.sweep().catch(() => {}); }, SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** sweep 한 번(테스트가 직접 부른다). 앞 sweep 이 아직 돌면 아무것도 하지 않는다. */
  async sweep(now: Date = new Date()): Promise<ApprovalNoticeSweep> {
    const out: ApprovalNoticeSweep = { accounts: 0, items: 0, recipients: 0, sent: 0, failed: 0 };
    if (this.sweeping) return out;
    this.sweeping = true;
    try {
      // 이관 직후의 도착지는 소스가 아직 살아 있다 — 둘이 같은 사람에게 같은 알림을 보내지 않게 한다.
      if (await this.instanceQuiesce.isQuiesced()) return out;
      const campaigns = await this.campaignRepo.find({ select: ['id', 'account_id', 'name', 'status'] });
      if (!campaigns.length) return out;
      // 승인함과 같다: 보관된 캠페인은 세지 않는다. 결과 불명 결제만은 예외다 — 결제가 나가던 중에 보관될 수 있고, 돈이
      // 나갔는지 모르는 채로 아무에게도 보이지 않으면 안 된다.
      const open = campaigns.filter((c) => c.status !== 'archived').map((c) => c.id);
      const candidates = await this.candidates(open, now);
      if (!candidates.length) return out;
      const running = new Set((await this.cycleRepo.find({
        where: { status: 'running', campaign_id: In([...new Set(candidates.map((c) => c.campaign_id))]) },
        select: ['campaign_id'],
      })).map((c) => c.campaign_id));

      const claimed: ApprovalNoticeCandidate[] = [];
      for (const [accountId, items] of groupBy(candidates, (c) => c.account_id)) {
        if (!approvalDigestDue(items, now, running)) continue;
        if (!(await this.claim(accountId, items))) continue;
        out.accounts += 1;
        claimed.push(...items);
      }
      out.items = claimed.length;
      if (claimed.length) await this.deliver(claimed, new Map(campaigns.map((c) => [c.id, c])), now, out);
    } catch (e: any) {
      this.logService.error('Marketing', `approval notice sweep failed: ${e?.message || e}`);
    } finally {
      this.sweeping = false;
    }
    return out;
  }

  /**
   * 아직 알리지 않은 대기 항목. 채널 · 게시물 · 편성은 결정 없이 쌓일 수 있으니 이미 알린 행을 DB 에서 거른다
   * (NOT EXISTS). 대기 중인 지출 요청은 72시간 만료와 일일 상한으로, 결과 불명은 드물어서 적다. 그래서 다 읽고, 종류는
   * 행마다 지금 상태로 정한다(새 요청 · 두 번째 승인 · 결과 불명). 결과 불명은 보관된 캠페인 것도 읽는다.
   */
  private async candidates(openCampaignIds: string[], now: Date): Promise<ApprovalNoticeCandidate[]> {
    const unannounced = <T extends ObjectLiteral>(
      repo: Repository<T>,
      status: string,
      kind: 'allocation_proposed' | 'channel_proposed' | 'post_draft',
      columns: string[],
    ): Promise<T[]> => (!openCampaignIds.length ? Promise.resolve([]) : repo.createQueryBuilder('t')
      .select(['t.id', 't.account_id', 't.campaign_id', 't.created_at', ...columns.map((c) => `t.${c}`)])
      .where('t.campaign_id IN (:...campaignIds)', { campaignIds: openCampaignIds })
      .andWhere('t.status = :status', { status })
      // Postgres 의 id 는 uuid, entity_id 는 varchar 다. 암묵 변환이 없어 cast 하지 않으면 sweep 마다 던진다.
      .andWhere((qb) => `NOT EXISTS ${qb.subQuery()
        .select('1')
        .from(MarketingApprovalNotice, 'n')
        .where('n.entity_id = CAST(t.id AS varchar)')
        .andWhere('n.kind = :kind')
        .getQuery()}`)
      .setParameter('kind', kind)
      .getMany());

    const spendWhere: FindOptionsWhere<MarketingSpendRequest>[] = [{ status: 'unknown' }];
    if (openCampaignIds.length) spendWhere.push({ campaign_id: In(openCampaignIds), status: 'pending' });

    const [channels, posts, allocations, spends, holds] = await Promise.all([
      unannounced(this.channelRepo, 'proposed', 'channel_proposed', ['platform', 'proposed_by_type', 'proposed_by_id']),
      unannounced(this.postRepo, 'draft', 'post_draft', ['created_by_type', 'created_by_id']),
      unannounced(this.allocationRepo, 'proposed', 'allocation_proposed', ['proposed_by_type', 'proposed_by_id']),
      this.spendRepo.find({
        where: spendWhere,
        select: [
          'id', 'account_id', 'campaign_id', 'status', 'amount_minor', 'currency', 'payee', 'expires_at', 'approvals',
          'requested_by_type', 'requested_by_id', 'created_at', 'updated_at',
        ],
      }),
      this.listHolds.activeByCampaign(openCampaignIds),
    ]);

    const spendCandidates = spends
      .map((row) => spendNoticeCandidate(row, now))
      .filter((c): c is ApprovalNoticeCandidate => !!c);
    // 한 중지를 여러 캠페인이 공유한다. 캠페인마다 한 번, 같은 캠페인의 채널 수와는 무관하다.
    const holdCandidates: ApprovalNoticeCandidate[] = [...holds].flatMap(([campaignId, rows]) => rows.map((hold) => ({
      kind: 'list_hold',
      entity_id: `${hold.id}:${campaignId}`,
      account_id: hold.account_id,
      campaign_id: campaignId,
      at: hold.created_at,
      exclude_user_ids: [],
      list_hold: { name: hold.list_name, rate: Number(hold.stats.rate) },
    })));
    const stateCandidates = [...spendCandidates, ...holdCandidates];
    const announced = stateCandidates.length
      ? await this.noticeRepo.find({ where: { entity_id: In(stateCandidates.map((c) => c.entity_id)) }, select: ['entity_id', 'kind'] })
      : [];
    const seen = new Set(announced.map((n) => `${n.entity_id}:${n.kind}`));

    return [
      ...stateCandidates.filter((c) => !seen.has(`${c.entity_id}:${c.kind}`)),
      ...allocations.map((r) => proposalNoticeCandidate('allocation_proposed', { ...r, by_type: r.proposed_by_type, by_id: r.proposed_by_id }, now)),
      ...channels.map((r) => proposalNoticeCandidate('channel_proposed', { ...r, by_type: r.proposed_by_type, by_id: r.proposed_by_id }, now)),
      ...posts.map((r) => proposalNoticeCandidate('post_draft', { ...r, by_type: r.created_by_type, by_id: r.created_by_id }, now)),
    ];
  }

  /**
   * 이 계정의 묶음을 선점한다. (대상, 종류) 행을 한 트랜잭션에 모두 넣는다. 다른 서버가 그중 하나라도 먼저 넣었으면
   * 유일 인덱스가 트랜잭션 전체를 되돌리고, 이 서버는 그 계정을 건너뛴다. 다음 sweep 은 남은 것만 다시 본다. 실패는 진
   * 것으로 본다. 이겼다고 추측하면 두 서버가 함께 보낸다. 유일 인덱스가 아닌 실패는 다음 sweep 에도 되풀이될 수 있으니
   * error 로 남긴다.
   */
  private async claim(accountId: string, items: ApprovalNoticeCandidate[]): Promise<boolean> {
    const rows = items.map((i) => ({ account_id: accountId, campaign_id: i.campaign_id, kind: i.kind, entity_id: i.entity_id }));
    try {
      await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(MarketingApprovalNotice);
        for (let i = 0; i < rows.length; i += CLAIM_CHUNK) await repo.insert(rows.slice(i, i + CLAIM_CHUNK));
      });
      return true;
    } catch (e: any) {
      if (isUniqueConstraintError(e)) {
        this.logService.info('Marketing', `approval notices for account ${accountId} were claimed by another sweep`);
      } else {
        this.logService.error('Marketing', `approval notice claim failed for account ${accountId}: ${e?.message || e}`);
      }
      return false;
    }
  }

  /**
   * 사람마다 한 통이다. 같은 사람이 여러 계정에 접근하면 그 계정들의 항목을 합친다. 받을 사람은 그 계정에 접근할 수 있는
   * 사용자 중 그 결정의 권한이 있는 사람이다(스스로 만들었거나 이미 승인한 항목은 빠진다). 채널 바인딩이 없는 사람에게는
   * `dispatchForUser` 가 아무것도 하지 않는다.
   */
  private async deliver(
    items: ApprovalNoticeCandidate[],
    campaigns: ReadonlyMap<string, { name: string }>,
    now: Date,
    out: ApprovalNoticeSweep,
  ): Promise<void> {
    const perUser = new Map<string, { user: ApprovalNoticeRecipient; items: ApprovalNoticeCandidate[] }>();
    for (const [accountId, list] of groupBy(items, (i) => i.account_id)) {
      let users: User[];
      try {
        users = await this.accountAccess.usersWithAccess(accountId);
      } catch (e: any) {
        this.logService.warn('Marketing', `approval notice recipients for account ${accountId} unavailable: ${e?.message || e}`);
        continue;
      }
      for (const user of users) {
        const recipient = { id: user.id, role: user.role, permissions: parsePermissions(user.permissions) };
        const mine = approvalNoticesFor(recipient, list);
        if (!mine.length) continue;
        const entry = perUser.get(user.id);
        if (entry) entry.items.push(...mine);
        else perUser.set(user.id, { user: recipient, items: mine });
      }
    }
    out.recipients = perUser.size;
    const baseUrl = process.env.AWB_PUBLIC_URL || '';
    await Promise.all([...perUser.values()].map(async ({ user, items: mine }) => {
      try {
        const payload = composeApprovalDigest(mine, campaigns, { now, baseUrl });
        const result = await withTimeout(this.dispatcher.dispatchForUser(user.id, 'notify_mention', payload), SEND_TIMEOUT_MS);
        out.sent += result.sent;
        out.failed += result.failed;
      } catch (e: any) {
        out.failed += 1;
        this.logService.warn('Marketing', `approval notice to user ${user.id} failed: ${e?.message || e}`);
      }
    }));
    this.logService.info(
      'Marketing',
      `approval notices: accounts=${out.accounts} items=${out.items} recipients=${out.recipients} sent=${out.sent} failed=${out.failed}`,
    );
  }
}
