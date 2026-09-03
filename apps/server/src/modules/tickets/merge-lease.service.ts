/**
 * MergeLeaseService — 저장소별 랜딩 lease 의 획득/해제/진행기록 (ticket e630b530).
 *
 * `CiWaitService`(대기 등록/해제)와 같은 자리에 있고, 스윕(리퍼·FIFO 부여)은
 * 형제 서비스 `../agents/merge-lease-sweep.service.ts` 가 맡는다 —
 * `CiWaitService` / `CiWaitResumeService` 와 정확히 같은 분업이다.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * Merging 은 최신 base 위로 rebase 한 SHA 의 초록 CI 를 요구한다. CI 가 도는
 * ~9분 동안 base 가 다시 전진하면 ff 가 실패하고, 다시 rebase 하면 SHA 가 바뀌어
 * 직전 초록 run 이 무효가 된다 — 같은 변경을 또 검증해야 한다. 실측된 사례에서
 * 내용 변경 없이 CI 를 3회 돌았고, 절차 자체에 반복 상한이 없다. 홀더가 그
 * 구간을 독점하면 그동안 base 가 전진하지 않으므로 루프가 유한하게 끝난다.
 *
 * ── 절대 하드 블록하지 않는다 (fail-open) ──────────────────────────────────
 * 이 서비스의 모든 실패 경로는 `degraded` 로 끝난다 = "lease 없이 그대로
 * 진행하라". 보드가 껐거나, 저장소를 해석 못 했거나, 여기서 예외가 났거나 —
 * 무엇이든 결과는 오늘 동작으로의 회귀이지 랜딩 교착이 아니다. AWB 는 자기
 * 자신을 이 저장소로 배포하므로, 랜딩 교착은 *그 교착을 고치는 수정까지* 막는다.
 *
 * ── 상호배제는 DB 가 한다 ──────────────────────────────────────────────────
 * `MergeLease` 의 `uniq_merge_lease_held_scope` 부분 UNIQUE 인덱스가 유일한
 * 중재자다. 획득은 그 인덱스를 향한 `INSERT … ON CONFLICT DO NOTHING`
 * (`.orIgnore()`) 이며, 진 쪽은 예외가 아니라 조용한 no-op 이라 호출자의
 * 트랜잭션을 오염시키지 않는다(DispatchIntent `_upsertOpenIntent` 와 같은 패턴).
 * 인프로세스 뮤텍스로는 다중 manager 를 막을 수 없다.
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { MergeLease } from '../../entities/MergeLease';
import { Resource } from '../../entities/Resource';
import { Ticket } from '../../entities/Ticket';
import { Workspace } from '../../entities/Workspace';
import { ActivityService } from '../../services/activity.service';
import { mergeEnvironmentConfig } from '../../common/environment-config';
import { pickBaseRepoResourceId, EnvRepoRef } from '../../common/base-repo-binding';
import { ResolvedMergeLease, resolveMergeLease } from '../../common/merge-lease-config';
import { releaseOpenLeaseRows } from '../mcp/shared/merge-lease-move';
import {
  decideLeaseLiveness,
  decideReverifyOutcome,
  MergeLeaseContext,
  parseMergeLeaseContext,
} from './merge-lease';

/**
 * FIFO 정렬 키 — **`_tryPromoteFifo` 의 원자 UPDATE 가 쓰는 순서와 반드시
 * 같아야 한다**(리뷰 3R). 조회는 `queued_at` 만 보고 승격 판정은
 * `(queued_at, id)` 를 보면, 같은 시각의 더 큰 id 가 먼저 반환될 때 스윕이
 * 그 행만 시도하고 UPDATE 는 거절 — 진짜 선두는 `i > 0` 이라 시도조차 되지
 * 않아 스윕만으로는 영원히 승격되지 않는다. 상수 하나로 묶어 드리프트를 막는다.
 */
export const FIFO_ORDER = { queued_at: 'ASC', id: 'ASC' } as const;

export interface MergeLeaseScope {
  repoResourceId: string;
  baseBranch: string;
}

export type AcquireOutcome = 'granted' | 'queued' | 'degraded';

export interface AcquireResult {
  outcome: AcquireOutcome;
  /** 부여/대기 중인 lease 행 id. degraded 면 없다. */
  lease_id?: string;
  /** 대기열에서의 1-기반 위치(자기 포함). `queued` 일 때만. */
  position?: number;
  /** 현재 홀더 티켓 id(관측성). `queued` 일 때만, 알 수 있으면. */
  ahead_ticket_id?: string;
  /** degraded 사유 — 'board_disabled' | 'repo_unresolved' | 'service_error'. */
  degrade_reason?: string;
  scope?: MergeLeaseScope;
  config?: ResolvedMergeLease;
  /**
   * 이 lease 를 쥐고 몇 번째 검증 시도인지(1-기반). 최초 획득이 1 이고, 홀더인
   * 채로 다시 획득하면(= ff 실패로 step 2 를 다시 도는 재검증 사이클) 증가한다.
   */
  attempt?: number;
  /** 허용 최대 시도 횟수. */
  max_attempts?: number;
  /**
   * 'continue' — 계속 진행해도 된다.
   * 'exhausted' — 상한 소진. 조용히 더 돌지 말고 **명시적 실패**로 끝내야 한다
   *   (완료 기준: "유한하게 랜딩하거나 명시적으로 실패한다").
   */
  budget?: 'continue' | 'exhausted';
}

export interface ReleaseResult {
  released: boolean;
  reason: string;
}

/** 스코프 리소스 해석에 필요한 최소 정보. */
interface TicketScopeParts {
  ticket: Ticket;
  board: Board | null;
}

@Injectable()
export class MergeLeaseService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
  ) {}

  // ── 설정 · 스코프 해석 ────────────────────────────────────────────────────

  /**
   * 티켓의 보드 설정을 해석한다. 보드를 못 찾으면 기본값(= 활성)으로 떨어진다 —
   * 설정을 못 읽었다는 이유로 조용히 꺼지면 루프가 그대로 되살아난다.
   */
  async resolveConfigForTicket(ticket: Ticket): Promise<ResolvedMergeLease> {
    const board = await this._loadBoard(ticket);
    return resolveMergeLease(board?.merge_lease_config ?? null);
  }

  /**
   * 티켓이 랜딩할 저장소 스코프. 티켓의 `base_repo_resource_id` 우선, 없으면
   * 보드 환경 저장소로 폴백한다(`pickBaseRepoResourceId` — 디스패치가 쓰는 것과
   * 같은 헬퍼라 어느 저장소인지에 대해 서로 다른 답을 낼 수 없다).
   * 어느 쪽으로도 해석되지 않으면 null → 호출자는 degraded 로 통과시킨다.
   */
  async resolveScope(ticket: Ticket): Promise<MergeLeaseScope | null> {
    if (!ticket.workspace_id) return null;
    const parts = await this._loadScopeParts(ticket);
    const envRepos = await this._boardEnvRepositories(parts);
    const picked = pickBaseRepoResourceId(ticket.base_repo_resource_id, envRepos);
    if (!picked.resourceId) return null;
    const resource = await this.dataSource
      .getRepository(Resource)
      .findOne({ where: { id: picked.resourceId } });
    // 워크스페이스 경계를 넘는 리소스는 이 티켓의 것이 아니다.
    if (resource && resource.workspace_id !== null && resource.workspace_id !== ticket.workspace_id) return null;
    const baseBranch = ticket.base_branch || resource?.default_branch || '';
    if (!baseBranch) return null;
    return { repoResourceId: picked.resourceId, baseBranch };
  }

  // ── 획득 ──────────────────────────────────────────────────────────────────

  /**
   * 랜딩 lease 를 획득하거나 FIFO 큐에 등록한다.
   *
   * 재진입 안전: 이미 이 티켓이 홀더면 같은 lease 를 그대로 돌려주고 진행 시각만
   * 민다(`await_ci_run` 으로 턴이 끊긴 뒤 재개된 세션이 다시 부르는 정상 경로).
   *
   * 어떤 실패도 throw 하지 않는다 — 전부 `degraded` 로 접어서 호출자가 lease 없이
   * 진행하게 한다.
   */
  async acquire(
    ticketId: string,
    opts: { actorId?: string; actorName?: string } = {},
  ): Promise<AcquireResult> {
    try {
      const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
      if (!ticket) return { outcome: 'degraded', degrade_reason: 'ticket_not_found' };

      const config = await this.resolveConfigForTicket(ticket);
      // 보드가 껐으면 기능 도입 이전 동작으로 완전히 되돌린다 — 예산도 세지
      // 않는다(킬 스위치의 의미가 "아무것도 하지 않는다" 여야 한다).
      if (!config.enabled) {
        return { outcome: 'degraded', degrade_reason: 'board_disabled', config };
      }

      const scope = await this.resolveScope(ticket);
      if (!scope) {
        return this._degradedWithBudget(ticketId, 'repo_unresolved', config, undefined);
      }

      // 이 에피소드는 이미 대기 상한을 넘겨 lease 없이 진행하기로 확정됐다.
      // 다시 줄을 세우면 방금 내린 fail-open 이 무효화되고 "대기 → 상한 →
      // fail-open → 재대기" 가 예산을 한 칸도 쓰지 않은 채 무한히 돈다.
      if (ticket.merge_lease_degraded) {
        return this._degradedWithBudget(ticketId, 'wait_timeout', config, scope);
      }

      const leaseRepo = this.dataSource.getRepository(MergeLease);
      const now = new Date();

      // (1) 이미 홀더인가 — 재진입/재개 경로. ff 실패로 step 2 를 다시 도는
      //     재검증 사이클이므로 여기서도 에피소드 예산을 깎는다.
      const mine = await leaseRepo.findOne({ where: { ticket_id: ticketId, released_at: IsNull() } });
      if (mine?.state === 'held') {
        // 홀더인데 파킹돼 있는 조합(승격 뒤 전달 전 크래시)이면 여기서도 푼다 —
        // 스윕의 자체 복구를 기다리지 않고 즉시 정상화한다.
        await this._unparkTicket(ticketId);
        await leaseRepo.update(
          { id: mine.id },
          { last_progress_at: now, progress_note: 'reacquired' },
        );
        return this._grantedWithBudget(ticketId, mine.id, scope, config);
      }

      // (2) 스코프의 죽은 홀더를 먼저 회수한다 — 같은 판정 규칙을 스윕과 공유한다.
      await this.reapStaleHolders(scope, config, now);

      // (3) 내 대기 행을 **먼저** 확보한다. 이것이 FIFO 순서를 정하는 유일한
      //     기준(`queued_at`)이고, 여기서 줄을 서야 뒤에 오는 티켓이 나를
      //     추월할 수 없다.
      //
      //     ★ 리뷰 2R: 예전에는 "홀더가 없으면 곧장 held 를 INSERT" 하는
      //     빠른 경로가 따로 있었다. 그 경로는 **기존 대기자 존재 여부를 보지
      //     않아**, 홀더 해제 직후 도착한 신규 티켓이 줄 전체를 추월했다.
      //     같은 이유로 뒤쪽 대기자의 재획득도 무조건 승격을 시도했다.
      //     지금은 부여 경로가 `_tryPromoteFifo` **하나뿐**이고, 그 안에서만
      //     "열린 대기자 중 내가 선두인가" 를 확인한다.
      const waiter = mine || await this._ensureWaiterRow(ticket, scope, now, opts);
      if (!waiter) {
        // 삽입도 조회도 실패 — 알 수 없는 상태라 통과시킨다(fail-open).
        return this._degradedWithBudget(ticketId, 'service_error', config, scope);
      }

      // (4) FIFO 선두일 때만 승격한다.
      if (await this._tryPromoteFifo(scope, waiter.id, waiter.queued_at, now)) {
        await this._unparkTicket(ticketId);
        await this._logLeaseActivity(ticket, 'granted', waiter.id, opts);
        return this._grantedWithBudget(ticketId, waiter.id, scope, config);
      }

      // (5) 아직 차례가 아니다. 파킹이 풀려 있었다면(재디스패치로 되살아난
      //     경우) 다시 파킹해 재디스패치 루프를 막는다. 대기는 예산을 쓰지
      //     않는다 — CI 를 돌리지 않고 턴을 끝내기 때문이다.
      const queued = await this._describeQueue(scope, waiter);
      await this._parkTicket(ticket, waiter, scope, queued.ahead_ticket_id || '', opts);
      await this._logLeaseActivity(ticket, 'queued', waiter.id, opts);
      return { outcome: 'queued', lease_id: waiter.id, scope, config, ...queued };
    } catch (e) {
      // fail-open 이되 **예산은 반드시 쓴다**(리뷰 3R). 여기서 예산 없이
      // degraded 를 돌려주면, 파킹·활동기록 등에서 반복 예외가 나는 동안
      // 에이전트가 상한 없이 계속 진행해 유한 종료 계약이 다시 깨진다.
      return this._degradedAfterThrow(ticketId);
    }
  }

  /**
   * 예기치 못한 예외 뒤의 fail-open. 예산을 쓸 수 있으면 쓰고 그 결과를 붙인다.
   *
   * **예산 기록 자체가 실패한 경계의 정책(리뷰 3R):** 카운터를 못 쓰면 반복
   * 횟수를 셀 수 없고, 셀 수 없으면 "유한하게 끝난다" 를 약속할 수 없다.
   * 그래서 이때는 진행 허가를 주지 않고 `budget: 'exhausted'` +
   * `degrade_reason: 'budget_unavailable'` 로 **명시적 실패**를 지시한다.
   * 이것은 하드 블록이 아니다 — 도구는 git 을 막지 못하며, 에이전트는 여전히
   * 코멘트를 남기고 바운스·pend 하거나 사람이 개입할 수 있다. 무한 루프와
   * 명시적 실패 중 하나를 골라야 한다면 후자가 옳다.
   */
  private async _degradedAfterThrow(ticketId: string): Promise<AcquireResult> {
    try {
      const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
      const config = ticket ? await this.resolveConfigForTicket(ticket) : resolveMergeLease(null);
      const budget = await this._spendAttempt(ticketId, config);
      return { outcome: 'degraded', degrade_reason: 'service_error', config, ...budget };
    } catch {
      return {
        outcome: 'degraded',
        degrade_reason: 'budget_unavailable',
        attempt: 0,
        max_attempts: 0,
        budget: 'exhausted',
      };
    }
  }

  /**
   * 이 티켓의 열린 대기 행을 보장한다(없으면 생성). 티켓당 열린 행 1개를
   * 강제하는 부분 UNIQUE 인덱스 덕분에 동시 호출 중 하나만 삽입에 성공하고,
   * 진 쪽은 조용한 no-op 뒤 재조회로 같은 행을 얻는다.
   */
  private async _ensureWaiterRow(
    ticket: Ticket,
    scope: MergeLeaseScope,
    now: Date,
    opts: { actorId?: string; actorName?: string },
  ): Promise<MergeLease | null> {
    const leaseRepo = this.dataSource.getRepository(MergeLease);
    await leaseRepo
      .createQueryBuilder()
      .insert()
      .into(MergeLease)
      .values({
        id: randomUUID(),
        workspace_id: ticket.workspace_id || '',
        board_id: (await this._loadBoard(ticket))?.id || '',
        repo_resource_id: scope.repoResourceId,
        base_branch: scope.baseBranch,
        ticket_id: ticket.id,
        holder_agent_id: opts.actorId || '',
        state: 'waiting',
        queued_at: now,
        last_progress_at: now,
        progress_note: 'queued',
      })
      .orIgnore()
      .execute();
    return leaseRepo.findOne({ where: { ticket_id: ticket.id, released_at: IsNull() } });
  }

  /**
   * **유일한 부여 경로.** 한 트랜잭션 안에서
   *   (a) 스코프에 살아 있는 홀더가 없고,
   *   (b) 열린 행들 중 `queued_at` 오름차순 선두가 나일 때
   * 에만 `waiting -> held` 로 승격한다. 동점은 `id` 로 결정론적으로 깨서
   * 다중 manager 가 같은 밀리초에 들어와도 서로 다른 선두를 고르지 않는다.
   *
   * 안전(스코프당 홀더 1명)은 부분 UNIQUE 인덱스가 담보하고, 이 함수는 그
   * 위에 **공정성(FIFO)** 을 얹는다. 둘을 분리해 두면 인덱스가 막아주지 못하는
   * 추월(홀더가 없는 순간의 신규 도착·뒤쪽 대기자)이 그대로 통과한다.
   *
   * `acquire` 와 스윕이 **같은** 이 함수를 부르므로 두 경로가 순서에 대해
   * 서로 다른 답을 낼 수 없다.
   */
  private async _tryPromoteFifo(
    scope: MergeLeaseScope,
    myLeaseId: string,
    myQueuedAt: Date,
    now: Date,
  ): Promise<boolean> {
    try {
      // 읽고-나서-쓰는 두 단계가 아니라 **단일 원자 UPDATE** 다. 두 단계로
      // 하면 (a) 트랜잭션 격리 수준에 의존하게 되고, (b) sql.js 처럼 진짜
      // 동시 트랜잭션이 없는 백엔드에서는 겹친 트랜잭션 자체가 실패해 조용히
      // "승격 실패" 로 퇴화한다(실제로 그렇게 만들었다가 동시 획득 5건이 전부
      // queued 로 떨어지는 것을 테스트가 잡았다). WHERE 절에 조건을 전부
      // 넣으면 백엔드와 무관하게 DB 가 한 문장으로 중재한다.
      //
      // 조건 셋:
      //   1. 내 행이 아직 열린 waiting 이다.
      //   2. 이 스코프에 살아 있는 홀더가 없다.
      //   3. 나보다 먼저 줄 선 열린 행이 없다 — (queued_at, id) 사전순 비교.
      //      id 동점 처리는 같은 밀리초에 도착한 다중 manager 가 서로 다른
      //      선두를 고르지 않게 하는 결정론 장치다.
      const res = await this.dataSource
        .getRepository(MergeLease)
        .createQueryBuilder()
        .update(MergeLease)
        .set({ state: 'held', acquired_at: now, last_progress_at: now, progress_note: 'granted' })
        .where('id = :myId', { myId: myLeaseId })
        .andWhere("state = 'waiting'")
        .andWhere('released_at IS NULL')
        .andWhere(
          'NOT EXISTS (SELECT 1 FROM merge_leases h WHERE h.repo_resource_id = :repo'
          + " AND h.base_branch = :branch AND h.state = 'held' AND h.released_at IS NULL)",
          { repo: scope.repoResourceId, branch: scope.baseBranch },
        )
        .andWhere(
          'NOT EXISTS (SELECT 1 FROM merge_leases w WHERE w.repo_resource_id = :repo'
          + ' AND w.base_branch = :branch AND w.released_at IS NULL'
          + ' AND (w.queued_at < :myQueuedAt OR (w.queued_at = :myQueuedAt AND w.id < :myId)))',
          { myQueuedAt },
        )
        .execute();
      return (res.affected || 0) > 0;
    } catch {
      // 유니크 인덱스 충돌 등 = 그 사이 다른 티켓이 홀더가 됐다. 계속 대기.
      return false;
    }
  }

  /**
   * 에피소드 예산을 한 칸 쓰고 그 결과를 붙인다.
   *
   * 카운터는 **티켓** 위에 있다(`Ticket.merge_landing_attempts`). lease 행에
   * 두면 대기 상한 초과로 fail-open 하며 행이 released 되는 순간 예산이 함께
   * 사라져, 다음 호출이 새 행 + 새 예산을 받아 무한 재시도가 된다(리뷰 2R).
   */
  private async _spendAttempt(ticketId: string, config: ResolvedMergeLease): Promise<{
    attempt: number; max_attempts: number; budget: 'continue' | 'exhausted';
  }> {
    const tRepo = this.dataSource.getRepository(Ticket);
    await tRepo.increment({ id: ticketId }, 'merge_landing_attempts', 1);
    const fresh = await tRepo.findOne({ where: { id: ticketId } });
    const attempt = fresh?.merge_landing_attempts ?? 1;
    return {
      attempt,
      max_attempts: config.maxReverifyAttempts,
      budget: decideReverifyOutcome(attempt - 1, config.maxReverifyAttempts),
    };
  }

  private async _grantedWithBudget(
    ticketId: string,
    leaseId: string,
    scope: MergeLeaseScope,
    config: ResolvedMergeLease,
  ): Promise<AcquireResult> {
    const budget = await this._spendAttempt(ticketId, config);
    // 관측성: 재검증 횟수는 lease 행에도 미러링한다(에피소드 전체 값).
    await this.dataSource.getRepository(MergeLease).update(
      { id: leaseId },
      { reverify_count: budget.attempt },
    );
    return { outcome: 'granted', lease_id: leaseId, scope, config, ...budget };
  }

  /**
   * lease 없이 진행시키되 **예산은 그대로 쓴다**. degraded 가 예산 면제가 되면
   * "붐비는 큐 → 대기 상한 fail-open → main 지속 전진" 경로에서 유한 종료
   * 보장이 사라진다(리뷰 2R의 핵심 지적).
   */
  private async _degradedWithBudget(
    ticketId: string,
    reason: string,
    config: ResolvedMergeLease,
    scope: MergeLeaseScope | undefined,
  ): Promise<AcquireResult> {
    const budget = await this._spendAttempt(ticketId, config);
    return { outcome: 'degraded', degrade_reason: reason, config, scope, ...budget };
  }

  // ── 해제 ──────────────────────────────────────────────────────────────────

  /**
   * lease 를 해제한다(스탠드얼론 경로 — MCP 툴, 스윕).
   * 컬럼 이동과 함께 해제해야 하는 경로는 `releaseWithinTx` 를 쓸 것.
   */
  async release(
    ticketId: string,
    reason: string,
    opts: { actorId?: string; actorName?: string } = {},
  ): Promise<ReleaseResult> {
    try {
      const released = await this.dataSource.transaction(async (manager) =>
        this.releaseWithinTx(manager, ticketId, reason),
      );
      if (released) {
        const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
        if (ticket) await this._logLeaseActivity(ticket, `released:${reason}`, '', opts);
      }
      return { released, reason };
    } catch {
      return { released: false, reason };
    }
  }

  /**
   * 컬럼 이동 트랜잭션 **안에서** 해제한다 (설계 보정 D).
   *
   * Merging 이탈(Done 랜딩 / In Progress 바운스 / pend)과 해제가 원자적이어야
   * 한다. 둘을 따로 쓰면 그 사이에서 크래시했을 때 lease 가 절대 상한까지 새고,
   * 그동안 그 저장소의 다른 티켓이 전부 대기한다.
   *
   * 티켓의 대기 플래그도 같은 트랜잭션에서 함께 내린다 — 이동한 티켓이 lease
   * 대기 상태로 남아 트리거가 계속 드롭되는 것을 막는다.
   */
  async releaseWithinTx(manager: EntityManager, ticketId: string, reason: string): Promise<boolean> {
    // 이동 경로와 **같은 구현**을 쓴다 — 두 벌로 갈라지면 한쪽만 고쳐 서로
    // 다르게 동작하는 것이 이 종류 버그의 단골이다.
    return releaseOpenLeaseRows(manager, ticketId, reason);
  }

  /**
   * 대기 해소(부여 또는 fail-open)의 **원자적 전달**. `CiWaitService.
   * claimDelivery` 와 같은 이유로 하나의 트랜잭션이다:
   *   1. `pending_merge_lease: true -> false` 를 CAS 한다. 조건에 정확한
   *      `merge_lease_context` 를 함께 걸어, 그 사이 취소·재등록으로 새로 생긴
   *      대기를 옛 전달이 잘못 지우지 못하게 한다.
   *   2. CAS 가 이겼을 때만 호출자의 부작용(해소 코멘트 삽입)을 **같은**
   *      트랜잭션 매니저로 실행한다.
   * 부작용이 던지면 CAS 까지 통째로 롤백되므로 다음 스윕이 처음부터 안전하게
   * 다시 시도한다 — "코멘트는 남았는데 플래그는 안 내려갔다" 는 창이 없다.
   */
  async claimWaiterDelivery(
    ticketId: string,
    expectedContext: string,
    withinTx: (manager: EntityManager) => Promise<void>,
  ): Promise<boolean> {
    let claimed = false;
    await this.dataSource.transaction(async (manager) => {
      const result = await manager.getRepository(Ticket).update(
        { id: ticketId, pending_merge_lease: true, merge_lease_context: expectedContext } as any,
        { pending_merge_lease: false, merge_lease_context: '' },
      );
      if ((result.affected || 0) === 0) return; // 경쟁에서 짐 / 이미 전달됨 — no-op 커밋
      await withinTx(manager);
      claimed = true;
    });
    return claimed;
  }

  /** 대기 행을 fail-open 으로 접는다(대기 상한 초과). 같은 트랜잭션 안에서 쓴다. */
  async failOpenWithinTx(manager: EntityManager, leaseId: string, reason: string): Promise<void> {
    const now = new Date();
    await manager.getRepository(MergeLease).update(
      { id: leaseId, released_at: IsNull() } as any,
      {
        released_at: now,
        release_reason: 'wait_timeout',
        degraded: true,
        degrade_reason: reason,
        last_progress_at: now,
        progress_note: 'wait_timeout',
      },
    );
  }

  /** 스윕이 훑을 대상 — 열린 lease 행이 있는 모든 스코프. */
  async listOpenScopes(): Promise<MergeLeaseScope[]> {
    // `.select('DISTINCT …')` + `.addSelect(…)` 로 쓰면 TypeORM 이 컬럼 순서를
    // 재배치해 `SELECT a, DISTINCT b` 라는 무효 SQL 을 만든다(sql.js 에서
    // syntax error). DISTINCT 는 반드시 `.distinct(true)` 로 표현할 것 —
    // 이 스윕 전체가 첫 tick 에서 죽던 실제 회귀다.
    const rows = await this.dataSource
      .getRepository(MergeLease)
      .createQueryBuilder('l')
      .select('l.repo_resource_id', 'repo_resource_id')
      .addSelect('l.base_branch', 'base_branch')
      .distinct(true)
      .where('l.released_at IS NULL')
      .getRawMany<{ repo_resource_id: string; base_branch: string }>();
    return rows.map((r) => ({ repoResourceId: r.repo_resource_id, baseBranch: r.base_branch }));
  }

  /** 스코프의 현재 홀더(살아 있든 아니든). 없으면 null. */
  async findHolder(scope: MergeLeaseScope): Promise<MergeLease | null> {
    return this.dataSource.getRepository(MergeLease).findOne({
      where: {
        repo_resource_id: scope.repoResourceId,
        base_branch: scope.baseBranch,
        state: 'held',
        released_at: IsNull(),
      },
    });
  }

  /** 스코프의 FIFO 대기열(queued_at 오름차순). */
  async listWaiters(scope: MergeLeaseScope): Promise<MergeLease[]> {
    return this.dataSource.getRepository(MergeLease).find({
      where: {
        repo_resource_id: scope.repoResourceId,
        base_branch: scope.baseBranch,
        state: 'waiting',
        released_at: IsNull(),
      },
      order: FIFO_ORDER,
    });
  }

  /** 티켓의 열린 lease 행(홀더든 대기자든). */
  async findOpenForTicket(ticketId: string): Promise<MergeLease | null> {
    return this.dataSource
      .getRepository(MergeLease)
      .findOne({ where: { ticket_id: ticketId, released_at: IsNull() } });
  }

  /**
   * 스윕의 부여 경로 — `acquire` 와 **같은** FIFO 판정을 쓴다. 두 경로가 서로
   * 다른 순서 규칙을 갖는 것이 이 종류 버그의 단골이라 프리미티브를 하나로
   * 묶었다. 경쟁에서 지거나 선두가 아니면 false.
   */
  async promoteWaiter(scope: MergeLeaseScope, lease: MergeLease, now: Date): Promise<boolean> {
    return this._tryPromoteFifo(scope, lease.id, lease.queued_at, now);
  }

  // ── 진행 기록 · 재검증 예산 ──────────────────────────────────────────────

  /**
   * 홀더의 진행을 기록한다(liveness 갱신). 리퍼가 진행 중인 홀더를 뺏지 않도록
   * 하는 쪽의 입력이다.
   */
  async noteProgress(ticketId: string, note: string): Promise<void> {
    try {
      const now = new Date();
      await this.dataSource.getRepository(MergeLease).update(
        { ticket_id: ticketId, state: 'held', released_at: IsNull() } as any,
        { last_progress_at: now, progress_note: note.slice(0, 200) },
      );
    } catch {
      /* liveness 갱신 실패가 랜딩을 막아서는 안 된다. */
    }
  }

  // ── 리퍼(공유 규칙) ───────────────────────────────────────────────────────

  /**
   * 한 스코프의 죽은 홀더를 회수한다. `acquire` 와 스윕이 **같은 함수**를 부르므로
   * 두 경로가 liveness 에 대해 서로 다른 판정을 낼 수 없다.
   *
   * 회수된 lease 수를 돌려준다.
   */
  async reapStaleHolders(
    scope: MergeLeaseScope,
    config: ResolvedMergeLease,
    now: Date,
  ): Promise<number> {
    const leaseRepo = this.dataSource.getRepository(MergeLease);
    const holders = await leaseRepo.find({
      where: {
        repo_resource_id: scope.repoResourceId,
        base_branch: scope.baseBranch,
        state: 'held',
        released_at: IsNull(),
      },
    });
    let reaped = 0;
    for (const lease of holders) {
      const verdict = await this.judgeHolder(lease, config, now);
      if (verdict === 'alive') continue;
      // ★ 리뷰 2R — 조건부 해제. 판정과 해제 사이에 홀더가 진행을 기록하면
      //   (예: `await_ci_run` 등록, 재획득) 이 회수는 **취소돼야** 한다.
      //   무조건 해제하면 판정 직후 살아난 홀더의 lease 를 뺏고, 홀더는 그
      //   사실을 모른 채 push 로 진입해 두 홀더 동시 랜딩이 된다 — liveness
      //   규칙을 아무리 정교하게 만들어도 이 창이 열려 있으면 무의미하다.
      //   `last_progress_at` 을 CAS 조건으로 걸어 그 창을 닫는다.
      if (await this._releaseIfUnchanged(lease, verdict)) reaped++;
    }
    return reaped;
  }

  /**
   * 판정 시점의 `last_progress_at` 이 그대로일 때만 해제한다. 0행이면 그 사이
   * 진행이 기록됐거나 이미 해제된 것이므로 **회수를 포기**하고 다음 스윕에
   * 다시 판정한다(보수적 — 살아 있는 홀더를 잘못 뺏는 것보다 한 tick 늦게
   * 회수하는 편이 안전하다).
   *
   * 티켓의 대기 플래그는 CAS 를 이긴 경우에만 정리한다 — 진 경우에 건드리면
   * 방금 진행한 홀더의 상태를 망친다.
   */
  private async _releaseIfUnchanged(lease: MergeLease, reason: string): Promise<boolean> {
    try {
      let won = false;
      let ticketForLog: Ticket | null = null;

      // CAS 와 티켓 정리는 **한 트랜잭션**이다(리뷰 3R). 둘을 따로 커밋하면
      // 사이에서 죽었을 때 "released lease + 영구 파킹된 티켓" 이 남고, 그
      // 티켓의 트리거는 영원히 드롭된다.
      await this.dataSource.transaction(async (manager) => {
        const res = await manager.getRepository(MergeLease).update(
          {
            id: lease.id,
            released_at: IsNull(),
            last_progress_at: lease.last_progress_at,
          } as any,
          {
            released_at: new Date(),
            release_reason: reason,
            progress_note: `released:${reason}`,
          },
        );
        if ((res.affected || 0) === 0) return; // 진행이 기록됨 / 이미 해제됨 — 회수 포기
        won = true;

        // 티켓 정리는 **이 lease 를 가리키고 있을 때만** 한다. 회수 판정 이후
        // 같은 티켓이 새 waiting 행을 만들어 다시 파킹됐다면, 옛 리퍼가 그
        // 새 컨텍스트를 지워 대기자를 잘못 깨우는 일이 생긴다(리뷰 3R).
        const tRepo = manager.getRepository(Ticket);
        const ticket = await tRepo.findOne({ where: { id: lease.ticket_id } });
        ticketForLog = ticket;
        if (!ticket?.pending_merge_lease) return;
        const ctx = parseMergeLeaseContext(ticket.merge_lease_context);
        if (ctx && ctx.lease_id !== lease.id) return; // 새 대기 — 건드리지 않는다
        await tRepo.update(
          { id: lease.ticket_id, pending_merge_lease: true } as any,
          { pending_merge_lease: false, merge_lease_context: '' },
        );
      });

      if (!won) return false;
      if (ticketForLog) await this._logLeaseActivity(ticketForLog, `released:${reason}`, lease.id, {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 홀더 한 명의 liveness 판정. DB 에서 진행 증거를 모아 순수 함수에 넘긴다.
   * 판정 자체의 진실표는 `decideLeaseLiveness` 가 갖고 있어 단위 테스트가
   * DB 없이 전수로 훑을 수 있다.
   */
  async judgeHolder(
    lease: MergeLease,
    config: ResolvedMergeLease,
    now: Date,
  ): Promise<'alive' | 'reap_not_merging' | 'reap_blocked' | 'reap_max_hold' | 'reap_idle'> {
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: lease.ticket_id } });
    if (!ticket) return 'reap_not_merging';
    const column = ticket.column_id
      ? await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } })
      : null;
    return decideLeaseLiveness({
      inMergingColumn: (column as any)?.kind === 'merging',
      hasActiveCiWait: hasUnresolvedCiWait(ticket),
      blockedOnOther: !!ticket.pending_user_action || !!ticket.pending_on_tickets,
      acquiredAtMs: lease.acquired_at ? new Date(lease.acquired_at).getTime() : null,
      lastProgressAtMs: new Date(lease.last_progress_at).getTime(),
      nowMs: now.getTime(),
      idleTimeoutMs: config.idleTimeoutMs,
      maxHoldMs: config.maxHoldMs,
    });
  }

  // ── 내부 헬퍼 ────────────────────────────────────────────────────────────

  /** 대기열 위치와 앞선 홀더를 계산(관측성). */
  private async _describeQueue(
    scope: MergeLeaseScope,
    mine: MergeLease,
  ): Promise<{ position: number; ahead_ticket_id: string }> {
    const leaseRepo = this.dataSource.getRepository(MergeLease);
    const [holder, waiters] = await Promise.all([
      leaseRepo.findOne({
        where: {
          repo_resource_id: scope.repoResourceId,
          base_branch: scope.baseBranch,
          state: 'held',
          released_at: IsNull(),
        },
      }),
      leaseRepo.find({
        where: {
          repo_resource_id: scope.repoResourceId,
          base_branch: scope.baseBranch,
          state: 'waiting',
          released_at: IsNull(),
        },
        order: FIFO_ORDER,
      }),
    ]);
    const idx = waiters.findIndex((w) => w.id === mine.id);
    return {
      position: idx >= 0 ? idx + 1 : waiters.length + 1,
      ahead_ticket_id: holder?.ticket_id || '',
    };
  }

  /**
   * 파킹을 푼다. lease 를 부여받은 티켓이 파킹된 채로 남으면 트리거 게이트가
   * 이후 모든 wake-up 을 드롭해 티켓이 조용히 멈춘다 — granted 를 돌려주는
   * **모든** 경로가 이것을 통과해야 한다.
   */
  private async _unparkTicket(ticketId: string): Promise<void> {
    await this.dataSource.getRepository(Ticket).update(
      { id: ticketId, pending_merge_lease: true } as any,
      { pending_merge_lease: false, merge_lease_context: '' },
    );
  }

  /** 티켓을 lease 대기로 파킹한다(네 번째 pending flavor). */
  private async _parkTicket(
    ticket: Ticket,
    lease: MergeLease,
    scope: MergeLeaseScope,
    aheadTicketId: string,
    opts: { actorId?: string; actorName?: string },
  ): Promise<void> {
    const ctx: MergeLeaseContext = {
      lease_id: lease.id,
      repo_resource_id: scope.repoResourceId,
      base_branch: scope.baseBranch,
      queued_at: new Date(lease.queued_at).toISOString(),
      requested_by: opts.actorName || '',
      ahead_ticket_id: aheadTicketId,
    };
    const tRepo = this.dataSource.getRepository(Ticket);
    const patch: Partial<Ticket> = {
      pending_merge_lease: true,
      merge_lease_context: JSON.stringify(ctx),
    };
    // `pending_reason` 은 비어 있을 때만 채운다 — 손으로 쓴 pend 사유를 덮지
    // 않는다(TicketPrerequisitesService / CiWaitService 와 같은 관례).
    if (!ticket.pending_reason) {
      (patch as any).pending_reason =
        `랜딩 lease 대기 중 — ${scope.baseBranch} 랜딩 구간을 다른 티켓이 점유 중` +
        (aheadTicketId ? ` (${aheadTicketId.slice(0, 8)})` : '');
    }
    await tRepo.update({ id: ticket.id }, patch);
  }

  private async _logLeaseActivity(
    ticket: Ticket,
    newValue: string,
    leaseId: string,
    opts: { actorId?: string; actorName?: string },
  ): Promise<void> {
    try {
      await this.activityService.logActivity({
        entity_type: 'ticket',
        entity_id: ticket.id,
        ticket_id: ticket.id,
        action: 'updated',
        field_changed: 'merge_lease',
        old_value: leaseId,
        new_value: newValue,
        actor_id: opts.actorId,
        actor_name: opts.actorName || '',
      });
    } catch {
      /* 감사 로그 실패가 랜딩을 막아서는 안 된다. */
    }
  }

  private async _loadScopeParts(ticket: Ticket): Promise<TicketScopeParts> {
    return { ticket, board: await this._loadBoard(ticket) };
  }

  private async _loadBoard(ticket: Ticket): Promise<Board | null> {
    if (!ticket.column_id) return null;
    const col = await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } });
    if (!col?.board_id) return null;
    return this.dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
  }

  /**
   * 보드 환경 저장소 목록 — 티켓이 자기 `base_repo_resource_id` 를 갖지 않을 때
   * `pickBaseRepoResourceId` 가 참고하는 폴백 소스. `CiWaitResumeService.
   * _resolveBoardEnvRepositories` 와 같은 구성(워크스페이스 기본 ⊕ 보드 오버라이드)
   * 이라 어느 저장소인지에 대해 두 서비스가 다른 답을 낼 수 없다.
   */
  private async _boardEnvRepositories(parts: TicketScopeParts): Promise<EnvRepoRef[]> {
    const workspace = parts.ticket.workspace_id
      ? await this.dataSource.getRepository(Workspace).findOne({ where: { id: parts.ticket.workspace_id } })
      : null;
    const mergedEnv = mergeEnvironmentConfig(workspace?.environment_config, parts.board?.environment_config);
    return mergedEnv?.repositories || [];
  }
}

/**
 * 티켓이 **미해소** CI run 에 파킹돼 있는가 — liveness 의 가장 강한 진행 증거.
 *
 * `pending_ci_wait` 플래그만 보지 않고 컨텍스트에 `outcome` 이 아직 없는지까지
 * 확인한다: CiWaitResumeService 는 결과를 먼저 기록하고(phase 1) 전달을 나중에
 * 하므로(phase 2), 그 사이의 티켓은 플래그가 켜져 있어도 실질적으로는 더 이상
 * 진행 중이 아니다.
 */
export function hasUnresolvedCiWait(ticket: Pick<Ticket, 'pending_ci_wait' | 'ci_wait_context'>): boolean {
  if (!ticket.pending_ci_wait) return false;
  try {
    const parsed = JSON.parse(ticket.ci_wait_context || '{}');
    return !parsed?.outcome;
  } catch {
    // 컨텍스트를 못 읽으면 플래그를 믿는다 — 살아 있는 홀더를 잘못 뺏는 쪽보다
    // 조금 늦게 회수하는 쪽이 안전하다.
    return true;
  }
}

export { parseMergeLeaseContext };
