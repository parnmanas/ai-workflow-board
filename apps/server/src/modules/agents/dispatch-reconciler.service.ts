/**
 * DispatchReconcilerService — the durable dispatch backstop sweep (ticket e7c87517).
 *
 * Runs every `DISPATCH_RECONCILER_SWEEP_MS` (default 1 min) and re-derives every
 * OWED dispatch from the `dispatch_intents` table:
 *
 *   1. RESOLVE  — close intents whose ticket made real forward progress, or
 *                 reached a terminal / parked / unstaffed / unrouted state.
 *   2. DISPATCH — re-emit any still-owed intent past its backoff deadline,
 *                 claimed via a multi-instance-safe lease CAS so two server
 *                 instances never double-spawn. Force-respawn a wedged strand
 *                 after `forceAfterAttempts`.
 *   3. SEED     — for any routed ticket sitting idle past `seedAfterMs` with a
 *                 holder but NO open intent (the trigger was lost to a crash
 *                 between commit and emit, or an SSE gap), create a durable
 *                 intent so the dispatch is recovered. This is the self-healing
 *                 net that makes the guarantee hold even when the same-tx record
 *                 at the trigger source never ran. Skipped when the holder has
 *                 already responded (comment / claim) since entering the
 *                 CURRENT column — that proves the dispatch was NOT lost, so
 *                 the ticket's silence since then is a chosen pause, not a
 *                 stall (ticket fec25d90) — UNLESS the session that produced
 *                 that response was killed by a manager restart it did not
 *                 survive (ticket 4f1f33c6, see `decideRestartReseed`).
 *
 * Because every decision is re-derived from committed DB state, the guarantee
 * survives a process restart (the next sweep re-discovers all open intents) and
 * an SSE subscription gap, and it holds across multiple instances. Operator
 * escalation (the chat alert) is intentionally left to StuckTicketDetector's
 * no-progress path so a capacity-deferred (focus-gated) intent, which the
 * reconciler legitimately keeps retrying, does not spam the alerts room — the
 * reconciler's own escalation is an audit-only latch.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { ActivityLog } from '../../entities/ActivityLog';
import { Agent } from '../../entities/Agent';
import { BoardColumn, NON_TERMINAL_KINDS } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { Subagent } from '../../entities/Subagent';
import { Ticket } from '../../entities/Ticket';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { LogService } from '../../services/log.service';
import { InstanceRegistryService } from '../agent-manager/instance-registry.service';
import { AgentStatusService } from './agent-status.service';
import { TriggerLoopService } from './trigger-loop.service';
import {
  DispatchIntentService,
  DispatchReconcilerConfig,
  decideIntentReconcile,
  DISPATCH_RECONCILE_SOURCE,
} from './dispatch-intent.service';

function safeJsonParse<T = any>(val: string | null | undefined, fallback: T): T {
  try { return JSON.parse(val || JSON.stringify(fallback)) as T; }
  catch { return fallback; }
}

/**
 * 한 role holder가 이 티켓·role 로 마지막에 돌린 CLI 세션의 서버측 durable
 * 기록(`subagents` 행) 요약. `decideRestartReseed`가 순수 판정을 하도록
 * DataSource 의존을 걷어낸 형태다(ticket 4f1f33c6).
 */
export interface RoleSessionSnapshot {
  startedAtMs: number;
  /** null = manager가 종료를 보고하기 전에 사라진 세션(= 아직 열린 행). */
  endedAtMs: number | null;
  /** 'SIGTERM' | 'disappeared' | … — 정상 종료면 null. */
  signal: string | null;
  exitCode: number | null;
}

export interface RestartReseedDecision {
  reseed: boolean;
  reason: string;
  /** 판정 근거가 된 매니저 재시작 시각(epoch ms). 재시작이 없으면 0. */
  restartAtMs: number;
}

/**
 * "holder가 이미 응답했다"는 fec25d90 재시드 스킵을 **매니저 재시작 사실과
 * 교차**하는 순수 판정(ticket 4f1f33c6).
 *
 * 문제: self-update는 drain 상한을 넘기면 진행 중 세션을 `self_update_restart`
 * 로 SIGTERM한다. 이 보드의 관례상 담당자는 착수 직후 claim + "작업을
 * 시작합니다" 코멘트를 남기므로, 장시간 작업 중 그렇게 죽는 세션은 **정확히
 * 재시드가 억제되는 상태**에 놓인다 — 티켓이 조용히 멈춘다.
 *
 * 그렇다고 "재시작이 있었으면 무조건 재시드"로 열면 fec25d90 회귀다: 의도적으로
 * 대기 중인 holder까지 매 재시작마다 재디스패치되고, 그 holder는 (보드 지침상)
 * 같은 대기 코멘트를 반복하지 않으므로 재시드된 intent가 `progressed`로
 * 해소되지 못한 채 재디스패치·에스컬레이션 루프가 된다.
 *
 * 그래서 **재시작 사실 × 그 시점의 in-flight 증거** 두 조건을 모두 요구한다.
 * 재시작 사실은 "최신 인스턴스가 하나라도 있음"이 아니라 **live 인스턴스 전부가
 * holder 응답 이후에 부팅했음**으로 판정한다 — 한 agent identity를 여러 호스트가
 * 감독할 수 있어서, 존재 한정으로 열면 살아서 진행 중인 세션을 재시드한다
 * (아래 본문 주석 참고).
 * in-flight 증거는 in-memory 신호가 아니라 durable한 `subagents` 행이며, 그
 * 행의 종료 방식이 "턴을 마치고 끝난 세션"과 "턴 도중 죽은 세션"을 가른다:
 *
 *   - 열린 행(`endedAtMs === null`)          → manager가 종료를 보고하지 못하고
 *                                              사라진 것 = 재시작에 죽었다.
 *   - `signal` 있음 / exit code ≠ 0          → SIGTERM·SIGKILL·disappeared =
 *                                              턴을 마치지 못했다.
 *   - signal 없고 exit code 0/미보고         → idle 타이머 등으로 **정상 종료** =
 *                                              holder의 침묵은 선택된 대기다.
 *
 * 순수 함수라 `apps/server/test/dispatch-restart-reseed-decision.test.mjs`에서
 * DataSource 없이 전 분기를 직접 단언한다.
 */
export function decideRestartReseed(opts: {
  /** 이 role holder 본인의 최신 진행 신호 시각(epoch ms). */
  holderProgressMs: number;
  /** 이 holder를 감독 중인 live manager 인스턴스들의 프로세스 부팅 시각(epoch ms). */
  managerStartedAtMs: number[];
  /** 이 (ticket, holder, role)의 가장 최근 세션 기록. 없으면 null. */
  session: RoleSessionSnapshot | null;
}): RestartReseedDecision {
  // 이 agent를 감독 중인 live manager 인스턴스가 하나도 없으면 판정 근거가
  // 없다(서버 재시작 직후 레지스트리가 비어 있는 구간 포함) — 재시드하지 않는다.
  if (opts.managerStartedAtMs.length === 0) {
    return { reseed: false, reason: 'no_live_manager_instance', restartAtMs: 0 };
  }

  // **모든** live manager 인스턴스가 holder 응답 이후에 부팅했을 때에만 "그
  // 응답을 낸 세션은 지금 살아 있을 수 없다"가 성립한다.
  //
  // 존재 한정("하나라도 최신")으로 열면 거짓양성이 난다: `listForAgent()`는 같은
  // agent identity를 감독하는 **여러 호스트**의 인스턴스를 돌려주고(노트북+VM
  // 페어링, ST-5b 다중 agent 감독), supersede 제거는 같은 `agent_id + hostname`
  // 에만 적용된다. host A가 세션을 계속 돌리는 중에 host B가 새로 등록하면
  // host B의 부팅 시각을 host A의 살아 있는 세션과 잘못 교차해 **진행 중인**
  // holder를 재시드하게 된다 — 정확히 fec25d90이 막으려던 회귀다.
  //
  // 반대로 전 인스턴스가 응답 이후 부팅했다면, 응답 시점에 존재했던 매니저
  // 프로세스는 하나도 남아 있지 않다(살아 있었다면 하트비트로 등록돼 이 목록에
  // 있었을 것). 그 세션은 어떤 매니저의 감독도 받고 있지 않다. `subagents` 행에
  // manager instance_id 연계가 없어도 서버 단독으로 증명되는 형태라 SSE
  // contract를 건드리지 않는다.
  //
  // 기준 시각은 최댓값이 아니라 **최솟값**을 쓴다 — 가장 이른 부팅조차 응답보다
  // 나중이어야 위 논증이 성립하고, 아래 "재시작 이후 시작된 세션" 판정도 가장
  // 이른 부팅을 기준으로 해야 이미 재개된 작업을 다시 재시드하지 않는다.
  let restartAtMs = Number.POSITIVE_INFINITY;
  for (const ms of opts.managerStartedAtMs) {
    // 파싱 불가한 부팅 시각은 "응답 이후임을 증명하지 못함"으로 취급한다.
    if (!Number.isFinite(ms)) {
      return { reseed: false, reason: 'manager_instance_boot_time_unknown', restartAtMs: 0 };
    }
    // 응답 시점에 이미 떠 있던 매니저가 하나라도 살아 있다 = 그 프로세스가 아직
    // 그 세션을 안고 있을 수 있다 = 재시드 근거 없음.
    if (ms <= opts.holderProgressMs) {
      return { reseed: false, reason: 'manager_instance_predates_holder_response', restartAtMs: 0 };
    }
    if (ms < restartAtMs) restartAtMs = ms;
  }

  const s = opts.session;
  // 세션 기록 자체가 없으면 "재시작에 죽었다"고 말할 근거가 없다 — 재시드하지
  // 않는 쪽이 fec25d90 이전 동작과 같아 안전하다(subagent 모니터가 꺼진
  // 배포에서도 동작이 나빠지지 않는다).
  if (!s) return { reseed: false, reason: 'no_session_record_for_role', restartAtMs };

  // 재시작 이후에 시작된 세션이 이미 있다 = 작업이 이미 재개됐다.
  if (s.startedAtMs > restartAtMs) {
    return { reseed: false, reason: 'session_started_after_restart', restartAtMs };
  }
  // 가장 최근 세션이 holder의 마지막 응답보다 먼저 끝났다면 그 응답을 낸 세션이
  // 아니다 — 무엇이 응답을 냈는지 모르는 상태이므로 판단을 보류한다.
  if (s.endedAtMs !== null && s.endedAtMs < opts.holderProgressMs) {
    return { reseed: false, reason: 'session_predates_holder_response', restartAtMs };
  }
  // 정상 종료 = 턴을 마쳤다 = holder의 침묵은 선택된 대기(fec25d90).
  if (s.endedAtMs !== null && s.signal === null && (s.exitCode === 0 || s.exitCode === null)) {
    return { reseed: false, reason: 'session_completed_normally', restartAtMs };
  }
  return { reseed: true, reason: 'holder_session_lost_to_manager_restart', restartAtMs };
}

interface ReconcileStats {
  scanned: number;
  resolved: number;
  dispatched: number;
  deferred: number;
  seeded: number;
  skipped_disabled: boolean;
}

@Injectable()
export class DispatchReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly config: DispatchReconcilerConfig;
  private readonly instanceId = `reconciler-${randomUUID()}`;
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly intents: DispatchIntentService,
    private readonly triggerLoop: TriggerLoopService,
    private readonly agentStatus: AgentStatusService,
    // ticket 4f1f33c6 — 매니저 재시작 사실(인스턴스 프로세스 부팅 시각)을 읽어
    // 재시드 스킵과 교차한다. @Global() 이라(instance-registry.module.ts) 새
    // 모듈 import 없이 주입된다 — TriggerLoopService 와 같은 DI 형태.
    private readonly instanceRegistry: InstanceRegistryService,
  ) {
    this.config = this.intents.config;
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logService.info('DispatchReconciler', 'service disabled via DISPATCH_RECONCILER_ENABLED=false', {});
      return;
    }
    this.tickHandle = setInterval(() => {
      this.reconcile().catch((e: unknown) => {
        this.logService.error('DispatchReconciler', 'sweep failed', { err: String(e) });
      });
    }, this.config.sweepMs);
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
    this.logService.info('DispatchReconciler', 'sweep loop initialized', { config: this.config, instance: this.instanceId });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** One reconcile pass. Public so a spec can drive it deterministically. */
  async reconcile(now: Date = new Date()): Promise<ReconcileStats> {
    const stats: ReconcileStats = {
      scanned: 0, resolved: 0, dispatched: 0, deferred: 0, seeded: 0,
      skipped_disabled: !this.config.enabled,
    };
    if (!this.config.enabled) return stats;

    // ── Phase 1/2: resolve + dispatch every open intent. ──────────────────────
    const open = await this.intents.listOpen();
    for (const intent of open) {
      stats.scanned += 1;
      try {
        await this._reconcileOne(intent, now, stats);
      } catch (e) {
        this.logService.warn('DispatchReconciler', 'per-intent reconcile failed (continuing)', {
          err: String(e), intent_id: intent.id, ticket_id: intent.ticket_id,
        });
      }
    }

    // ── Phase 3: seed durable intents for routed-but-idle tickets. ────────────
    try {
      await this._seedMissingIntents(now, stats);
    } catch (e) {
      this.logService.warn('DispatchReconciler', 'seed pass failed (continuing)', { err: String(e) });
    }

    this.logService.info('DispatchReconciler', 'sweep complete', { stats });
    return stats;
  }

  private async _reconcileOne(intent: any, now: Date, stats: ReconcileStats): Promise<void> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: intent.ticket_id } });

    // Gather the resolution inputs from committed state.
    let archived = false;
    let terminalOrUnrouted = false;
    let parked = false;
    let unstaffed = false;
    let holderAgentId = '';
    let lastProgressAtMs = 0;

    if (ticket) {
      archived = !!ticket.archived_at;
      parked = !!(ticket.pending_user_action || ticket.pending_on_tickets || ticket.pending_ci_wait || ticket.pending_merge_lease);
      const col = ticket.column_id
        ? await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } })
        : null;
      if (!col) {
        terminalOrUnrouted = true;
      } else {
        const isTerminal = (col as any).is_terminal === true || (col as any).kind === 'terminal';
        const roles = safeJsonParse<string[]>((col as any).role_routing, []);
        if (isTerminal || !Array.isArray(roles) || !roles.includes(intent.role)) {
          terminalOrUnrouted = true;
        }
      }
      const holders = await this._resolveHolderAgentIds(ticket.workspace_id, ticket.id, intent.role);
      holderAgentId = holders[0] || intent.agent_id || '';
      unstaffed = holders.length === 0 && !intent.agent_id;
      lastProgressAtMs = await this._latestForwardProgressMs(ticket);
    }

    const decision = decideIntentReconcile({
      nowMs: now.getTime(),
      intentCreatedAtMs: new Date(intent.created_at).getTime(),
      nextAttemptAtMs: new Date(intent.next_attempt_at).getTime(),
      ticketMissing: !ticket,
      archived,
      terminalOrUnrouted,
      parked,
      unstaffed,
      lastProgressAtMs,
    });

    if (decision.action === 'resolve') {
      await this.intents.resolve(intent, decision.reason, now);
      stats.resolved += 1;
      return;
    }
    if (decision.action === 'defer') {
      stats.deferred += 1;
      return;
    }

    // action === 'dispatch'
    if (!holderAgentId) {
      // No servable holder despite the unstaffed check passing (race) — resolve
      // rather than spin; the seeder / no-progress detector re-surface it if the
      // ticket re-acquires a holder.
      await this.intents.resolve(intent, 'unstaffed', now);
      stats.resolved += 1;
      return;
    }
    const force = intent.attempts >= this.config.forceAfterAttempts;
    const claim = await this.intents.claimForDispatch(intent, { instanceId: this.instanceId, now, force });
    if (!claim.claimed) {
      // Another instance won the lease this tick — leave it to them.
      stats.deferred += 1;
      return;
    }

    // Audit-only escalation latch (no chat — StuckTicketDetector owns operator
    // alerting so a capacity-deferred intent doesn't double-notify).
    if (intent.attempts + 1 >= this.config.escalateAfterAttempts) {
      const newly = await this.intents.markEscalated(intent.id, now);
      if (newly) {
        const reason = intent.last_reason || 'repeated_redispatch_no_progress';
        await this._writeAudit(ticket, intent, 'dispatch_intent_escalated', {
          attempts: intent.attempts + 1,
          reason,
          recovery: this._buildEscalationRecovery(reason, intent),
        });
      }
    }

    let triggerId = '';
    try {
      triggerId = await this.triggerLoop.emitAgentTrigger(
        ticket!, holderAgentId, intent.role, DISPATCH_RECONCILE_SOURCE, 'system', { forceRespawn: force },
      );
    } catch (e) {
      this.logService.warn('DispatchReconciler', 'reconcile emit threw (intent stays open for next sweep)', {
        err: String(e), ticket_id: intent.ticket_id, role: intent.role,
      });
    }
    // Record the fresh trigger_id so a manager ack can be matched to THIS
    // dispatch (stale-ack guard). Empty triggerId means the emit was gated
    // (focus / in-flight strand / paused / pending) — the intent stays in_flight
    // and the next sweep reconsiders it; the gate itself already left an audit.
    await this.dataSource.getRepository('DispatchIntent').update(intent.id, {
      last_trigger_id: triggerId || intent.last_trigger_id || '',
      agent_id: holderAgentId,
    });
    await this._writeAudit(ticket, intent, 'dispatch_reconcile_redispatch', {
      generation: claim.generation,
      force,
      landed: !!triggerId,
      trigger_id: triggerId,
      next_attempt_at: claim.nextAttemptAt.toISOString(),
    });
    stats.dispatched += 1;
  }

  /**
   * Human-facing `recovery` guidance for a `dispatch_intent_escalated` audit
   * row (ticket d35b8ac8). The generic "verify agent online / worktree pool /
   * focus capacity" text is accurate for a capacity/reachability stall but
   * actively misdiagnoses the in-flight-strand case: all three incidents that
   * motivated this fix had an online agent, a healthy worktree pool, and no
   * pending gate — the actual blocker was a same-(agent, ticket, role) strand
   * still running as a process. When `reason` carries the
   * `inflight_strand_serialization` marker the in-flight gate stamps (see the
   * `recordOwed` call beside `agent_trigger_dropped_inflight_strand` in
   * trigger-loop.service.ts), name that cause explicitly — including the
   * blocking strand's identifier (Subagent.subagent_id, review blocker —
   * best-effort, may be absent) and start time when captured — instead of the
   * generic checklist. Pure string parsing, no I/O.
   */
  private _buildEscalationRecovery(reason: string, intent: { agent_id: string; role: string }): string {
    if (!reason.startsWith('inflight_strand_serialization')) {
      return 'reconciler keeps re-dispatching at capped backoff; verify agent online / worktree pool / focus capacity';
    }
    const idMatch = /\bstrand_id=(\S+)/.exec(reason);
    const sinceMatch = /\bstrand_live_since=(\S+)/.exec(reason);
    const details = [
      idMatch ? `strand ${idMatch[1]}` : '',
      sinceMatch ? `live since ${sinceMatch[1]}` : '',
    ].filter(Boolean).join(', ');
    const detailSuffix = details ? ` (${details})` : '';
    return `a preceding strand for agent=${intent.agent_id || '?'} role=${intent.role}${detailSuffix} is still running as a ` +
      'process — check whether it is genuinely stuck before force-respawning; this is NOT an agent-online / ' +
      'worktree-pool / focus-capacity issue';
  }

  /**
   * Seed durable intents for routed tickets sitting idle with a holder but no
   * open intent (ticket e7c87517). Scans the same candidate set as the stuck
   * detector — every NON-TERMINAL column (intake / active / review / merging),
   * not archived. review / merging were previously excluded (reviewer blocker
   * B1); without them a reviewer / merger trigger lost to a commit↔emit crash
   * would leave the ticket with no open intent AND no seed to re-derive one, so
   * the durable outbox self-heal never covered Review / Merging. A ticket that
   * has made forward progress within `seedAfterMs`, is parked, or already has an
   * open intent for the role is skipped.
   *
   * 이 role의 CURRENT holder 본인이 이번 컬럼 진입 이후 실제로 응답(코멘트/
   * 클레임/output-liveness)한 적이 있다면 — 그 뒤로 아무리 오래 idle이어도 —
   * 이 role만 재시드하지 않는다(ticket fec25d90). 재시드된 intent의 created_at
   * 은 그 응답보다 나중이라 decideIntentReconcile의 `progressed` 규칙이 다시는
   * 성립할 수 없고, 그 결과 "담당자가 의도적으로 대기 중"인 정상 상황이 영원히
   * 만족되지 않는 재디스패치·에스컬레이션 루프가 된다. 디스패치가 유실되지
   * 않았다는 증거(응답 자체)가 있으니 이 role의 이번 라우팅 사이클에 대해
   * reconciler가 할 일은 없다 — 장기 무진행 여부는 StuckTicketDetector가 훨씬
   * 긴 시간축에서 별도로 감시한다.
   *
   * 판단은 role별 holder로 한정한다(리뷰 지적) — reporter 등 제3자나 다른
   * role의 holder가 남긴 신호는 "이 role의 디스패치가 유실되지 않았다"는
   * 증거가 되지 못한다. 그 신호까지 합친 티켓 전체 `_latestForwardProgressMs`
   * 를 그대로 쓰면, assignee emit이 실제로 유실됐는데 reporter가 질문 코멘트만
   * 남긴 경우에도 영구히 재시드가 억제되는 정반대 방향의 회귀가 생긴다.
   *
   * 이 스킵은 다시 **매니저 재시작 사실과 교차**된다(ticket 4f1f33c6):
   * holder가 응답했더라도 그 응답을 낸 세션이 매니저 재시작에 죽었다면
   * (self-update의 `self_update_restart` SIGTERM 등) "디스패치가 유실되지
   * 않았다"는 근거가 무너지므로 재시드 대상으로 되돌린다. 판정 규칙과 그것이
   * fec25d90 회귀를 되살리지 않는 이유는 `decideRestartReseed` 참고.
   */
  private async _seedMissingIntents(now: Date, stats: ReconcileStats): Promise<void> {
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const candidateCols = await colRepo
      .createQueryBuilder('c')
      .where('c.kind IN (:...kinds)', { kinds: NON_TERMINAL_KINDS })
      .getMany();
    if (candidateCols.length === 0) return;
    const colById = new Map(candidateCols.map(c => [c.id, c]));
    const colIds = candidateCols.map(c => c.id);

    const tickets = await this.dataSource.getRepository(Ticket)
      .createQueryBuilder('t')
      .where('t.column_id IN (:...colIds)', { colIds })
      .andWhere('t.archived_at IS NULL')
      .getMany();

    for (const ticket of tickets) {
      if (ticket.pending_user_action || ticket.pending_on_tickets || ticket.pending_ci_wait || ticket.pending_merge_lease) continue;
      const col = colById.get(ticket.column_id as string);
      if (!col) continue;
      const roles = safeJsonParse<string[]>((col as any).role_routing, []);
      if (!Array.isArray(roles) || roles.length === 0) continue;

      const lastProgressMs = await this._latestForwardProgressMs(ticket);
      // Idle only: recently-progressed / just-dispatched tickets are being
      // served — no seed. Baseline is created_at (immutable), never updated_at.
      const idleMs = now.getTime() - Math.max(lastProgressMs, new Date(ticket.created_at).getTime());
      if (idleMs < this.config.seedAfterMs) continue;

      const enteredAtMs = await this._lastColumnEntryMs(ticket.id, new Date(ticket.created_at).getTime());

      for (const role of roles) {
        const existing = await this.intents.findOpenForTicketRole(ticket.id, role);
        if (existing) continue;
        const holders = await this._resolveHolderAgentIds(ticket.workspace_id, ticket.id, role);
        if (holders.length === 0) continue; // unstaffed → no dispatch owed

        // 이 role의 holder 본인이 컬럼 진입 이후 실제로 응답했다면 디스패치는
        // 유실되지 않은 것이다 — 이 role만 재시드 대상에서 제외한다(ticket
        // fec25d90, 위 docstring 참고). 다른 role holder/제3자의 신호는 넣지
        // 않는다 — 있어도 "이 role"의 유실 디스패치는 여전히 seed돼야 한다.
        const holderProgressMs = await this._holderProgressMs(ticket, role, holders);
        let seedReason = 'routed_ticket_idle_no_open_intent';
        let restartDecision: RestartReseedDecision | null = null;
        if (holderProgressMs > enteredAtMs) {
          // …단, 그 응답을 낸 세션이 매니저 재시작에 죽었다면 얘기가 다르다
          // (ticket 4f1f33c6). 재시작 사실과 durable in-flight 증거를 함께
          // 요구해 "의도적 대기"와 "재시작에 끊긴 작업"을 가른다.
          restartDecision = decideRestartReseed({
            holderProgressMs,
            managerStartedAtMs: this._managerStartedAtMs(holders),
            session: await this._latestRoleSession(ticket.id, role, holders),
          });
          if (!restartDecision.reseed) continue;
          seedReason = restartDecision.reason;
        }

        await this.intents.createSeed({
          workspaceId: ticket.workspace_id,
          boardId: col.board_id,
          ticketId: ticket.id,
          role,
          agentId: holders[0],
        });
        await this._writeAudit(ticket, { id: '', ticket_id: ticket.id, role, workspace_id: ticket.workspace_id, agent_id: holders[0], attempts: 0 } as any, 'dispatch_intent_seeded', {
          idle_ms: Math.round(idleMs),
          reason: seedReason,
          ...(restartDecision
            ? {
              holder_progress_at: new Date(holderProgressMs).toISOString(),
              manager_restarted_at: new Date(restartDecision.restartAtMs).toISOString(),
            }
            : {}),
          recovery: restartDecision
            ? 'the holder responded, but its session did not survive the manager restart — reconciler re-dispatches this role on the next pass'
            : 'reconciler will dispatch this seeded intent on the next pass',
        });
        stats.seeded += 1;
      }
    }
  }

  /**
   * Agent holders of `slug` on a ticket, earliest-first, managers excluded —
   * mirrors TriggerLoopService._resolveRoleHolders so the reconciler agrees with
   * the organic dispatch path on who is servable.
   */
  private async _resolveHolderAgentIds(workspaceId: string, ticketId: string, slug: string): Promise<string[]> {
    const role = await this.dataSource.getRepository(WorkspaceRole).findOne({
      where: { workspace_id: workspaceId, slug },
    });
    if (!role) return [];
    const rows = await this.dataSource.getRepository(TicketRoleAssignment).find({
      where: { ticket_id: ticketId, role_id: role.id },
      order: { created_at: 'ASC', id: 'ASC' },
    });
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const r of rows) {
      if (r.agent_id && !seen.has(r.agent_id)) { seen.add(r.agent_id); ids.push(r.agent_id); }
    }
    if (ids.length === 0) return [];
    const managers = await this.dataSource.getRepository(Agent).find({
      where: { id: In(ids), type: 'manager' }, select: ['id'],
    });
    if (managers.length === 0) return ids;
    const mgr = new Set(managers.map(a => a.id));
    return ids.filter(id => !mgr.has(id));
  }

  /**
   * Newest EXPLICIT forward-progress signal for a ticket (ticket e7c87517),
   * in epoch ms: the latest real (non-system) comment, the latest lifecycle
   * activity (column move / claim / release), and the latest output-liveness
   * across any strand on the ticket. Deliberately EXCLUDES ticket.updated_at —
   * a label/assignee/metadata edit is not forward progress (reviewer blocker #5).
   * Returns 0 when nothing has advanced the ticket.
   *
   * Uses ENTITY reads (findOne + order), not a raw `MAX(created_at)` aggregate,
   * on purpose: TypeORM hydrates a `@CreateDateColumn` to a TZ-correct Date on
   * every backend, whereas a raw sql.js aggregate hands back a naive
   * "YYYY-MM-DD HH:MM:SS" string that `new Date()` reparses in LOCAL time —
   * shifting a comment's timestamp under a non-UTC dev TZ and silently
   * mis-deciding `progressed`. The `progressed` comparison against the intent's
   * own (entity-hydrated) created_at must use the same clock.
   *
   * `id: 'DESC'` rides along as a deterministic tiebreaker (리뷰 지적, ticket
   * fec25d90) — `created_at` alone has no defined pick among rows sharing the
   * same stored timestamp (a same-second burst), which is the board runbook's
   * "created_at 단독 사용 금지" case. `id` is a random UUID, not a write
   * sequence, so it does not recover true insertion order within a tie — it
   * only makes the pick reproducible across runs/dialects instead of
   * implementation-defined, matching `_resolveHolderAgentIds`'s convention.
   */
  private async _latestForwardProgressMs(ticket: Ticket): Promise<number> {
    const latestComment = await this.dataSource.getRepository(Comment).findOne({
      where: { ticket_id: ticket.id, type: Not('system') },
      order: { created_at: 'DESC', id: 'DESC' },
      select: ['id', 'created_at'],
    });
    const commentMs = latestComment?.created_at ? new Date(latestComment.created_at).getTime() : 0;

    const latestLifecycle = await this.dataSource.getRepository(ActivityLog).findOne({
      where: [
        { ticket_id: ticket.id, action: 'moved', field_changed: 'column' },
        { ticket_id: ticket.id, action: 'updated', field_changed: 'locked_by_agent_id' },
      ],
      order: { created_at: 'DESC', id: 'DESC' },
      select: ['id', 'created_at'],
    });
    const lifecycleMs = latestLifecycle?.created_at ? new Date(latestLifecycle.created_at).getTime() : 0;

    const outputMs = this.agentStatus?.getLatestOutputLivenessForTicket?.(ticket.id) ?? 0;

    return Math.max(commentMs, lifecycleMs, outputMs);
  }

  /**
   * 티켓이 현재 컬럼에 가장 최근에 들어온 시각(epoch ms)을 구한다(ticket
   * fec25d90). 이 티켓의 최신 `moved`/`column` ActivityLog 행 시각을 쓰고,
   * 한 번도 이동한 적이 없다면(예: BacklogPromotionService가 직접 이 컬럼에
   * 만든 경우) `fallbackMs`(호출자가 넘기는 ticket.created_at)로 대체한다.
   * `_latestForwardProgressMs`의 lifecycle MAX와는 다르다 — 그쪽은 claim/release
   * 까지 함께 묶어 "가장 최근에 뭔가 있었던 시각"을 구하지만, 재시드 스킵
   * 판단에는 "이번 dwell이 시작된 시각" 그 자체가 필요하다. `id: 'DESC'`를
   * 결정적 타이브레이커로 함께 쓴다(리뷰 지적) — 동일 타임스탬프 move burst에서
   * `created_at` 단독 정렬은 어느 행을 고를지 정의돼 있지 않다.
   */
  private async _lastColumnEntryMs(ticketId: string, fallbackMs: number): Promise<number> {
    const latestMove = await this.dataSource.getRepository(ActivityLog).findOne({
      where: { ticket_id: ticketId, action: 'moved', field_changed: 'column' },
      order: { created_at: 'DESC', id: 'DESC' },
      select: ['id', 'created_at'],
    });
    return latestMove?.created_at ? new Date(latestMove.created_at).getTime() : fallbackMs;
  }

  /**
   * 이 role의 CURRENT holder(들) 본인이 낸 진행 신호(코멘트/락/output-liveness)
   * 의 최신 시각(epoch ms), 없으면 0(ticket fec25d90, 리뷰 지적 반영). 다른
   * role holder나 reporter 등 제3자의 신호는 "이 role에 대한 디스패치가
   * 유실되지 않았다"는 증거가 되지 못하므로 제외한다 — `_latestForwardProgressMs`
   * 는 티켓 전체의 신호를 합쳐 반환해 role을 구분하지 않으므로 재시드 스킵
   * 판단에는 쓸 수 없다.
   */
  private async _holderProgressMs(ticket: Ticket, role: string, holderAgentIds: string[]): Promise<number> {
    if (holderAgentIds.length === 0) return 0;

    const latestComment = await this.dataSource.getRepository(Comment).findOne({
      where: { ticket_id: ticket.id, type: Not('system'), author_id: In(holderAgentIds) },
      order: { created_at: 'DESC', id: 'DESC' },
      select: ['id', 'created_at'],
    });
    const commentMs = latestComment?.created_at ? new Date(latestComment.created_at).getTime() : 0;

    // 락은 티켓 단일 필드라 "지금 이 role의 holder가 쥐고 있을 때만" 응답
    // 신호로 인정한다 — 다른 role holder의 claim은 이 role에 대한 증거가 아니다.
    const lockMs = (ticket.locked_by_agent_id && ticket.locked_at && holderAgentIds.includes(ticket.locked_by_agent_id))
      ? new Date(ticket.locked_at).getTime()
      : 0;

    let outputMs = 0;
    for (const agentId of holderAgentIds) {
      const ts = this.agentStatus?.getOutputLivenessAt?.(agentId, ticket.id, role);
      if (ts !== undefined && ts > outputMs) outputMs = ts;
    }

    return Math.max(commentMs, lockMs, outputMs);
  }

  /**
   * 이 holder들을 감독 중인 live manager 인스턴스들의 **프로세스 부팅 시각**
   * (epoch ms) 목록(ticket 4f1f33c6). 매니저는 재시작할 때마다 새 instance_id
   * 와 새 `started_at`으로 등록한다(`InstanceHeartbeat`가 생성 시점에 한 번
   * 찍는 값).
   *
   * 목록을 **빠짐없이** 넘기는 것이 중요하다. `decideRestartReseed`는 이 중
   * 하나가 아니라 **전부**가 holder 응답 이후에 부팅했는지를 보고 판정하며
   * (같은 agent identity를 감독하는 호스트가 여럿일 수 있다 — 그 이유는 그쪽
   * docstring 참고), 여기서 항목을 빠뜨리면 "응답 시점부터 살아 있던 매니저"를
   * 못 보고 진행 중인 holder를 재시드하게 된다. 그래서 파싱 불가한
   * `started_at`도 버리지 않고 그대로 넘겨 판정 쪽에서 보수적으로 처리한다.
   *
   * 레지스트리는 in-memory 라 서버 재시작 직후에는 비어 있을 수 있지만, 값
   * 자체는 매니저가 다음 하트비트(기본 ≤30초)에 다시 실어 보내는 자기 부팅
   * 시각이라 복원된다. 비어 있는 동안에는 빈 배열 → 재시드 억제 유지(=기존
   * 동작)로 안전하게 축퇴한다.
   */
  private _managerStartedAtMs(holderAgentIds: string[]): number[] {
    const out: number[] = [];
    const seen = new Set<string>();
    for (const agentId of holderAgentIds) {
      for (const inst of this.instanceRegistry.listForAgent(agentId)) {
        if (seen.has(inst.instance_id)) continue;
        seen.add(inst.instance_id);
        // 파싱 불가여도 버리지 않는다 — 위 docstring 참고.
        out.push(new Date(inst.started_at).getTime());
      }
    }
    return out;
  }

  /**
   * 이 (ticket, holder, role)로 가장 최근에 돌았던 CLI 세션의 durable 기록
   * (ticket 4f1f33c6). `subagents` 테이블은 세션 생명주기를 프로세스 밖에
   * 보존하므로 — 열린 행 / `signal` / `exit_code` — "턴을 마치고 끝난 세션"과
   * "턴 도중 죽은 세션"을 서버 혼자 구분할 수 있는 유일한 durable 신호다.
   * output-liveness나 current_task 같은 in-memory 신호는 서버 재시작에 사라져
   * 이 판정에 쓸 수 없다.
   *
   * role을 정확히 일치시킨다 — 한 agent가 같은 티켓에서 여러 role을 겸할 수
   * 있어(이 보드에서 흔하다) role을 느슨하게 맞추면 다른 role의 세션 기록으로
   * 이 role의 재시드를 좌우하게 된다. role을 보고하지 않는 구버전 manager는
   * 매치가 없어 `null`이 되고, 판정은 "증거 없음 → 재시드 안 함"으로 안전하게
   * 축퇴한다.
   *
   * `subagent_id: 'DESC'`를 결정적 타이브레이커로 함께 쓴다 — 같은 초에 여러
   * 세션이 등록된 경우 `started_at` 단독 정렬은 어느 행을 고를지 정의돼 있지
   * 않다(보드 런북: "created_at 단독 사용 금지"). 상한 없는 `take`로 잘라
   * JS에서 다시 고르지 않고 DB가 한 행만 고르게 한다.
   */
  private async _latestRoleSession(
    ticketId: string,
    role: string,
    holderAgentIds: string[],
  ): Promise<RoleSessionSnapshot | null> {
    if (holderAgentIds.length === 0) return null;
    const row = await this.dataSource.getRepository(Subagent).findOne({
      where: { ticket_id: ticketId, agent_id: In(holderAgentIds), role },
      order: { started_at: 'DESC', subagent_id: 'DESC' },
      select: ['subagent_id', 'started_at', 'ended_at', 'signal', 'exit_code'],
    });
    if (!row) return null;
    return {
      startedAtMs: new Date(row.started_at).getTime(),
      endedAtMs: row.ended_at ? new Date(row.ended_at).getTime() : null,
      signal: row.signal ?? null,
      exitCode: row.exit_code ?? null,
    };
  }

  private async _writeAudit(ticket: Ticket | null, intent: any, action: string, extra: Record<string, unknown>): Promise<void> {
    try {
      const repo = this.dataSource.getRepository(ActivityLog);
      await repo.save(repo.create({
        workspace_id: (ticket?.workspace_id || intent.workspace_id) ?? '',
        entity_type: 'ticket',
        entity_id: intent.ticket_id,
        action,
        field_changed: 'dispatch_intent',
        old_value: '',
        new_value: JSON.stringify({ intent_id: intent.id, role: intent.role, agent_id: intent.agent_id, ...extra }),
        actor_id: 'system',
        actor_name: 'DispatchReconciler',
        ticket_id: intent.ticket_id,
        role: intent.role,
        trigger_source: 'dispatch_reconcile',
      }));
    } catch (e) {
      this.logService.warn('DispatchReconciler', 'audit write failed (continuing)', {
        err: String(e), ticket_id: intent.ticket_id, action,
      });
    }
  }
}

// TypeORM `In` / `Not` imported lazily to keep the holder + progress queries readable.
import { In, Not } from 'typeorm';
