/**
 * MergeLeaseSweepService — 랜딩 lease 의 리퍼 · FIFO 부여 · 대기 상한
 * (ticket e630b530).
 *
 * `CiWaitResumeService` 와 같은 자리·같은 스켈레톤(setInterval + unref)이고,
 * 획득/해제 자체는 형제 서비스 `../tickets/merge-lease.service.ts` 가 맡는다 —
 * `CiWaitService` / `CiWaitResumeService` 분업과 동일하다.
 *
 * 한 tick 이 하는 일은 둘뿐이다:
 *
 *   Pass A — 죽은 홀더 회수. 판정은 `MergeLeaseService.reapStaleHolders` 가
 *            하며, `acquire` 도 **같은 함수**를 부르므로 두 경로가 liveness 에
 *            대해 서로 다른 답을 낼 수 없다. 리퍼는 진행 증거가 없을 때만
 *            회수한다 — CI 가 도는 동안(`pending_ci_wait` 미해소)은 아무리
 *            길어도 살아 있는 것으로 본다. 고정 예산으로 뺏으면 홀더가 그
 *            사실을 모른 채 push 로 진입해 없애려던 경쟁이 되살아난다.
 *
 *   Pass B — 대기자 처리. `decideWaiterOutcome` 의 판정에 따라
 *            - `grant`              → 승격 + 대기 플래그 해제 + 재개 디스패치
 *            - `fail_open_timeout`  → 대기 포기 + degraded 기록 + 재개 디스패치
 *            - `keep_waiting`       → 그대로 둔다
 *
 * ── fail-open 이 이 서비스의 안전장치다 ────────────────────────────────────
 * 대기 상한을 넘긴 티켓은 **lease 없이 진행**시킨다. 그 결과는 이 기능 도입
 * 전의 동작(= CI 재검증 루프를 다시 겪을 수 있음)이지, 랜딩 교착이 아니다.
 * AWB 는 자기 자신을 이 저장소로 배포하므로 랜딩 교착은 그 교착을 고치는
 * 수정까지 막는다 — 어떤 경우에도 만들어서는 안 되는 상태다.
 *
 * ── 크래시 자체 치유 ───────────────────────────────────────────────────────
 * 승격(원자적)과 전달(플래그 해제 + 코멘트, 한 트랜잭션) 사이에서 죽으면
 * "lease 는 쥐었는데 티켓은 아직 파킹된" 상태가 남는다. Pass B 는 그 조합을
 * 먼저 확인해 전달만 다시 수행한다 — 다음 tick 이 알아서 복구한다.
 */

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Comment } from '../../entities/Comment';
import { Ticket } from '../../entities/Ticket';
import { LogService } from '../../services/log.service';
import {
  MergeLeaseScope,
  MergeLeaseService,
} from '../tickets/merge-lease.service';
import { decideWaiterOutcome, parseMergeLeaseContext } from '../tickets/merge-lease';
import { resolveMergeLease } from '../../common/merge-lease-config';
import { TriggerLoopService } from './trigger-loop.service';

const DEFAULTS = {
  ENABLED: true,
  // 대기자가 실제로 파킹돼 있는 상태라 짧게 돈다. CiWaitResumeService 와 동일.
  SWEEP_MS: 60_000,
};

export interface MergeLeaseSweepConfig {
  enabled: boolean;
  sweepMs: number;
}

function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MergeLeaseSweepConfig {
  const parseIntEnv = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw == null) return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '') return fallback;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return true;
  };
  return {
    enabled: parseBool(env.MERGE_LEASE_SWEEP_ENABLED, DEFAULTS.ENABLED),
    sweepMs: parseIntEnv(env.MERGE_LEASE_SWEEP_MS, DEFAULTS.SWEEP_MS),
  };
}

export const __test__ = { readConfigFromEnv, DEFAULTS };

export interface MergeLeaseSweepStats {
  scopes: number;
  reaped: number;
  granted: number;
  failed_open: number;
  still_waiting: number;
  skipped_disabled: boolean;
}

@Injectable()
export class MergeLeaseSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly config: MergeLeaseSweepConfig;
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly mergeLeaseService: MergeLeaseService,
    private readonly triggerLoopService: TriggerLoopService,
  ) {
    this.config = readConfigFromEnv();
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logService.info('MCP', 'MergeLeaseSweepService disabled via MERGE_LEASE_SWEEP_ENABLED=false', {
        config: this.config,
      });
      return;
    }
    this.tickHandle = setInterval(() => {
      this.sweep().catch((e: unknown) => {
        this.logService.error('MCP', 'merge-lease sweep failed', { err: String(e) });
      });
    }, this.config.sweepMs);
    // 형제 폴러들과 같은 unref 규율 — 이 인터벌이 프로세스를 살려두면
    // `--test-force-exit` 없는 테스트 실행이 hang 한다.
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
    this.logService.info('MCP', 'merge lease sweep loop initialized', { config: this.config });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** 테스트 헬퍼 — env 파싱 결과를 단언할 수 있게 노출. */
  getConfig(): MergeLeaseSweepConfig {
    return { ...this.config };
  }

  /** 공개 테스트 훅 — 내부 루프 1 tick 과 동등하다. */
  async sweep(): Promise<MergeLeaseSweepStats> {
    const stats: MergeLeaseSweepStats = {
      scopes: 0, reaped: 0, granted: 0, failed_open: 0, still_waiting: 0,
      skipped_disabled: !this.config.enabled,
    };
    if (!this.config.enabled) return stats;

    const scopes = await this.mergeLeaseService.listOpenScopes();
    const now = new Date();
    for (const scope of scopes) {
      stats.scopes++;
      try {
        await this._sweepScope(scope, now, stats);
      } catch (e) {
        this.logService.warn('MCP', 'merge-lease per-scope sweep failed (continuing)', {
          err: String(e), repo_resource_id: scope.repoResourceId, base_branch: scope.baseBranch,
        });
      }
    }
    return stats;
  }

  private async _sweepScope(scope: MergeLeaseScope, now: Date, stats: MergeLeaseSweepStats): Promise<void> {
    // 설정은 홀더/대기자의 보드에서 읽는다. 스코프에 티켓이 하나도 없으면
    // 기본값(활성)으로 떨어지지만, 그 경우 처리할 행도 없다.
    const waiters = await this.mergeLeaseService.listWaiters(scope);
    const holder = await this.mergeLeaseService.findHolder(scope);
    const anchorTicketId = holder?.ticket_id || waiters[0]?.ticket_id || '';
    const anchor = anchorTicketId
      ? await this.dataSource.getRepository(Ticket).findOne({ where: { id: anchorTicketId } })
      : null;
    const config = anchor
      ? await this.mergeLeaseService.resolveConfigForTicket(anchor)
      : resolveMergeLease(null);

    // ── Pass A — 죽은 홀더 회수 ─────────────────────────────────────────
    stats.reaped += await this.mergeLeaseService.reapStaleHolders(scope, config, now);

    // ── Pass B — 대기자 처리 ────────────────────────────────────────────
    // 회수 뒤 스코프가 비었는지 다시 본다.
    const liveHolder = await this.mergeLeaseService.findHolder(scope);
    const scopeFree = !liveHolder;

    for (let i = 0; i < waiters.length; i++) {
      const waiter = waiters[i];
      // 이 tick 안에서 앞선 대기자가 승격됐다면 스코프는 더 이상 비어 있지 않다.
      const currentHolder = await this.mergeLeaseService.findHolder(scope);
      const verdict = decideWaiterOutcome({
        queuedAtMs: new Date(waiter.queued_at).getTime(),
        nowMs: now.getTime(),
        maxWaitMs: config.maxWaitMs,
        isFifoHead: i === 0,
        scopeFree: scopeFree && !currentHolder,
      });

      if (verdict === 'keep_waiting') {
        stats.still_waiting++;
        continue;
      }

      const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: waiter.ticket_id } });
      if (!ticket) continue;

      if (verdict === 'grant') {
        if (!(await this.mergeLeaseService.promoteWaiter(waiter.id, now))) {
          // 승격 경쟁에서 짐 — 다음 tick 에 다시 본다.
          stats.still_waiting++;
          continue;
        }
        if (await this._deliver(ticket, 'granted', config.maxWaitMs)) stats.granted++;
        continue;
      }

      // fail_open_timeout — lease 없이 진행시킨다.
      if (await this._deliver(ticket, 'failed_open', config.maxWaitMs, waiter.id)) stats.failed_open++;
    }

    // 크래시 자체 치유: 승격은 됐는데 전달 전에 죽어 "홀더인데 아직 파킹" 인
    // 티켓을 찾아 전달만 다시 수행한다.
    if (liveHolder) {
      const holderTicket = await this.dataSource
        .getRepository(Ticket)
        .findOne({ where: { id: liveHolder.ticket_id } });
      if (holderTicket?.pending_merge_lease) {
        if (await this._deliver(holderTicket, 'granted', config.maxWaitMs)) stats.granted++;
      }
    }
  }

  /**
   * 대기 해소를 전달한다: 대기 플래그 해제 + 해소 코멘트를 **한 트랜잭션**으로
   * 쓰고(부분 실패 창 없음), 그 뒤에 재개 디스패치를 best-effort 로 던진다.
   *
   * 디스패치가 트랜잭션 밖인 이유는 `CiWaitResumeService._deliver` 와 같다:
   * SSE 로 나가는 in-process emit 이라 DB 트랜잭션에 참여할 수 없고,
   * `dispatchCurrentColumn` 자체가 아직 파킹된 티켓에 대해서는 emit 을 거부하
   * 므로 반드시 플래그 해제 **뒤에** 불러야 한다. 여기서 실패해도 잃는 것은
   * 없다 — `DispatchReconcilerService` 의 idle-seed 스윕이 독립적으로 이
   * 티켓을 다시 디스패치한다.
   */
  private async _deliver(
    ticket: Ticket,
    kind: 'granted' | 'failed_open',
    maxWaitMs: number,
    failOpenLeaseId?: string,
  ): Promise<boolean> {
    const rawContext = ticket.merge_lease_context || '';
    const ctx = parseMergeLeaseContext(rawContext);
    const waitedMs = ctx?.queued_at ? Date.now() - new Date(ctx.queued_at).getTime() : 0;
    const waitedMin = Math.max(0, Math.round(waitedMs / 60_000));

    const content = kind === 'granted'
      ? [
          '🔓 **랜딩 lease 확보 — Merging 을 계속 진행하세요**',
          '',
          `이 티켓이 \`${ctx?.base_branch || 'base'}\` 랜딩 구간을 독점합니다. 대기 시간 약 ${waitedMin}분.`,
          '',
          '지금부터 rebase → CI dispatch → ff push 까지, 같은 저장소의 다른 AWB 티켓은 랜딩하지 않습니다.',
          '따라서 CI 가 도는 동안 base 가 전진해 SHA 가 무효화되는 재검증 루프가 발생하지 않습니다.',
          'Done 이동 · In Progress 바운스 · pend 시 서버가 lease 를 자동 해제합니다.',
        ].join('\n')
      : [
          '⚠️ **랜딩 lease 대기 상한 초과 — lease 없이 진행합니다 (fail-open)**',
          '',
          `약 ${waitedMin}분 대기했으나 (상한 ${Math.round(maxWaitMs / 60_000)}분) 랜딩 구간을 확보하지 못했습니다.`,
          '',
          '대기를 무한정 늘리는 대신 **lease 없이** 그대로 진행시킵니다 — 기아를 만들지 않기 위한 의도된 동작입니다.',
          '이 상태의 Merging 은 이 기능 도입 이전과 동일합니다: base 가 전진하면 rebase → CI 재검증 루프를 겪을 수 있습니다.',
          '`merging_workflow` 의 CI dispatch 절차를 그대로 따르되, 반복이 길어지면 코멘트로 상황을 남기세요.',
        ].join('\n');

    const dedupeKey = `merge-lease-${kind}:${ticket.id}:${ctx?.lease_id || 'none'}`;

    let claimed: boolean;
    try {
      claimed = await this.mergeLeaseService.claimWaiterDelivery(ticket.id, rawContext, async (manager) => {
        if (failOpenLeaseId) {
          await this.mergeLeaseService.failOpenWithinTx(manager, failOpenLeaseId, 'max_wait_exceeded');
        }
        await manager.getRepository(Comment)
          .createQueryBuilder()
          .insert()
          .into(Comment)
          .values({
            ticket_id: ticket.id,
            workspace_id: ticket.workspace_id || '',
            author_type: 'system',
            author_id: '',
            author: 'MergeLease',
            content,
            type: 'note',
            operational_recurrence_key: dedupeKey,
          })
          .orIgnore()
          .execute();
      });
    } catch (e) {
      this.logService.warn('MCP', 'merge-lease delivery transaction failed — left parked, retried next sweep', {
        err: String(e), ticket_id: ticket.id, kind,
      });
      return false;
    }
    if (!claimed) return false;

    this.logService.info('MCP', 'merge lease wait resolved', {
      ticket_id: ticket.id, kind, waited_minutes: waitedMin, lease_id: ctx?.lease_id || '',
    });

    try {
      await this.triggerLoopService.dispatchCurrentColumn(ticket.id, `merge_lease_${kind}`, 'system');
    } catch (e) {
      this.logService.warn('MCP', 'merge-lease resume dispatch failed — flag already cleared; DispatchReconciler idle-seed will still resume the ticket', {
        err: String(e), ticket_id: ticket.id,
      });
    }
    return true;
  }
}
