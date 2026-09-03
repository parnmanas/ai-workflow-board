/**
 * OrchestrationReaperService — the safety net that keeps a mission from sitting
 * "in progress" forever when an agent dies without reporting.
 *
 * Three rots this closes, all observed on every other dispatch surface in this
 * codebase (QaRunReaperService, StuckTicketDetectorService):
 *
 *   1. A dispatched step whose subagent died before calling
 *      `report_orchestration_step`. Nothing else will ever move it — its
 *      dependents stay pending and the mission looks alive while doing nothing.
 *      Past `mission.step_timeout_minutes` it is failed, which runs the normal
 *      downstream handling (block dependents, dispatch what became ready, wake
 *      the orchestrator to decide).
 *
 *   2. A mission stuck in `planning` because the orchestrator never submitted a
 *      plan. It is re-briefed up to PLANNING_NUDGE_LIMIT times (the count is
 *      read back off the timeline, so it survives a restart) and only then
 *      failed — a silent auto-fail on the first timeout would throw away
 *      recoverable missions whose orchestrator was merely offline.
 *
 *   3. A mission stuck `running` with zero in-flight steps because every step
 *      reached a terminal status (or was never assigned) but the orchestrator
 *      never called `complete_orchestration_mission`. `decideWake` already
 *      posts a wake the moment this happens, but that wake is one-shot and
 *      best-effort — if it goes unanswered nothing else ever revisits the
 *      mission, so it sits `running` forever and keeps occupying the team's
 *      open-mission slot. Re-briefed up to RUNNING_STALL_NUDGE_LIMIT times via
 *      the same timeline bookkeeping as (2), then failed.
 *
 * Pattern matches the sibling reapers exactly: OnModuleInit plants a plain
 * setInterval (no @Cron / scheduler dependency), one immediate sweep at boot so
 * a restart clears standing phantoms within seconds, and `runOnce()` is public
 * so an operator can force a sweep over REST.
 *
 * Env: ORCHESTRATION_LEASE_GRACE_MS (default 5m, clamped 10s..1h),
 *      ORCHESTRATION_REAPER_ENABLED (default on),
 *      ORCHESTRATION_REAPER_SWEEP_MS (default 5m, clamped 30s..1h),
 *      ORCHESTRATION_PLANNING_TIMEOUT_MS (default 20m, clamped 1m..24h),
 *      ORCHESTRATION_RUNNING_STALL_TIMEOUT_MS (default 20m, clamped 1m..24h).
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { OrchestrationStep } from '../../entities/OrchestrationStep';
import { OrchestrationEvent } from '../../entities/OrchestrationEvent';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { LogService } from '../../services/log.service';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { OrchestrationMissionService } from './orchestration-mission.service';
import { OrchestrationRunnerService } from './orchestration-runner.service';
import { IN_FLIGHT_STEP_STATUSES, isAwaitingUser, isInFlight } from './orchestration.constants';
import { OrchestrationConfirmNotifyService } from './orchestration-confirm-notify.service';

const PLANNING_NUDGE_LIMIT = 2;
const RUNNING_STALL_NUDGE_LIMIT = 2;

function envMs(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

@Injectable()
export class OrchestrationReaperService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  private readonly sweepMs = envMs('ORCHESTRATION_REAPER_SWEEP_MS', 5 * 60_000, 30_000, 60 * 60_000);
  private readonly planningTimeoutMs = envMs(
    'ORCHESTRATION_PLANNING_TIMEOUT_MS',
    20 * 60_000,
    60_000,
    24 * 60 * 60_000,
  );
  /**
   * lease 만료를 관측한 뒤 새 attempt 를 띄우기까지 기다리는 유예(티켓 4d065f82).
   * 이 창 안에 작업자가 heartbeat 를 하나라도 보내면 lease 가 그대로 되살아난다.
   */
  private readonly leaseGraceMs = envMs('ORCHESTRATION_LEASE_GRACE_MS', 5 * 60_000, 10_000, 60 * 60_000);

  private readonly runningStallTimeoutMs = envMs(
    'ORCHESTRATION_RUNNING_STALL_TIMEOUT_MS',
    20 * 60_000,
    60_000,
    24 * 60 * 60_000,
  );

  /**
   * confirm 게이트가 답을 못 받은 채 이만큼 지나면 **1회** 리마인더를 보낸다
   * (티켓 a78cb566, 요구사항 5). 0 = 리마인더 끄기.
   *
   * 이건 타임아웃이 **아니다**. 리퍼가 confirm 대기 미션을 죽이지 않는다는 계약
   * (`reapStalledRunning` 의 `isAwaitingUser` 가드)은 그대로다 — 이 스윕은 알림만
   * 보내고 미션·step 의 상태를 한 글자도 바꾸지 않는다. 사람이 답할 때까지 미션은
   * 계속 기다린다.
   */
  private readonly confirmReminderAfterMs = envMs(
    'ORCHESTRATION_CONFIRM_REMINDER_MS',
    24 * 60 * 60_000,
    0,
    30 * 24 * 60 * 60_000,
  );

  constructor(
    @InjectRepository(OrchestrationMission) private readonly missionRepo: Repository<OrchestrationMission>,
    @InjectRepository(OrchestrationStep) private readonly stepRepo: Repository<OrchestrationStep>,
    @InjectRepository(OrchestrationEvent) private readonly eventRepo: Repository<OrchestrationEvent>,
    @InjectRepository(OrchestrationTeam) private readonly teamRepo: Repository<OrchestrationTeam>,
    private readonly missions: OrchestrationMissionService,
    private readonly runner: OrchestrationRunnerService,
    private readonly logService: LogService,
    // ticket 0f638509 — instance-wide fleet quiesce. @Global() (see
    // shared-services.module.ts), cycle-free.
    private readonly instanceQuiesce: InstanceQuiesceService,
    // 장기 미응답 confirm 게이트 리마인더(티켓 a78cb566).
    private readonly confirmNotify: OrchestrationConfirmNotifyService,
  ) {}

  onModuleInit(): void {
    if (process.env.ORCHESTRATION_REAPER_ENABLED === 'false') {
      this.logService.info('Orchestration', 'reaper disabled via ORCHESTRATION_REAPER_ENABLED=false');
      return;
    }
    void this.runOnce();
    this.tickHandle = setInterval(() => {
      void this.runOnce();
    }, this.sweepMs);
    this.tickHandle.unref?.();
  }

  onModuleDestroy(): void {
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = null;
  }

  /** One sweep. Safe to call concurrently — overlapping calls are dropped. */
  async runOnce(
    now: Date = new Date(),
  ): Promise<{ steps_failed: number; missions_nudged: number; missions_failed: number; post_actions_recovered: number; confirm_reminders: number }> {
    // Instance-wide quiesce gate (ticket 0f638509 — live pull import). See
    // QaScheduleService.runOnce's identical gate for the full rationale — the
    // 3 reap* methods below all end up dispatching via
    // OrchestrationRunnerService (failStepExternally/nudgeOrchestrator/
    // recoverPostActions → sendMessage), independent of _emitTrigger.
    if (await this.instanceQuiesce.isQuiesced()) {
      return { steps_failed: 0, missions_nudged: 0, missions_failed: 0, post_actions_recovered: 0, confirm_reminders: 0 };
    }
    if (this.sweeping) return { steps_failed: 0, missions_nudged: 0, missions_failed: 0, post_actions_recovered: 0, confirm_reminders: 0 };
    this.sweeping = true;
    try {
      const stepsFailed = await this.reapStuckSteps(now);
      const planning = await this.reapStalledPlanning(now);
      const running = await this.reapStalledRunning(now);
      const postActionsRecovered = await this.reapPendingPostActions(now);
      const confirmReminders = await this.remindAwaitingConfirm(now);
      const nudged = planning.nudged + running.nudged;
      const failed = planning.failed + running.failed;
      if (stepsFailed || nudged || failed || postActionsRecovered || confirmReminders) {
        this.logService.info(
          'Orchestration',
          `reaper sweep: ${stepsFailed} step(s) timed out, ${nudged} mission(s) re-briefed, ${failed} failed, ` +
            `${postActionsRecovered} mission(s)' post-actions recovered, ` +
            `${confirmReminders} confirm gate(s) reminded`,
        );
      }
      return {
        steps_failed: stepsFailed,
        missions_nudged: nudged,
        missions_failed: failed,
        post_actions_recovered: postActionsRecovered,
        confirm_reminders: confirmReminders,
      };
    } catch (e: any) {
      this.logService.error('Orchestration', `reaper sweep failed: ${e?.message || e}`);
      return { steps_failed: 0, missions_nudged: 0, missions_failed: 0, post_actions_recovered: 0, confirm_reminders: 0 };
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * 크래시로 중단된 post_actions를 이어받는다(리뷰 지적 반영, 티켓 2dc3c62f)
   * — completeMission()이 terminal status를 저장한 직후, 또는 개별
   * post-action dispatch() 도중에 프로세스가 죽으면 `pending`/`in_flight`
   * 항목이 그대로 남을 수 있다. `runPostActions` 자체가 resumable이므로
   * (이미 확정된 항목은 건드리지 않고, in_flight는 절대 재시도하지 않음)
   * 반복 호출은 안전하다.
   *
   * **리뷰 2라운드 지적 반영** — 예전엔 `finished_at DESC, take:100`으로
   * "최근 종료된 미션"만 훑었는데, 이러면 terminal 미션이 100개를 넘는
   * 순간 그보다 오래된 미확정 미션은 최신 미션들에 밀려 이 스윕이 영원히
   * 찾지 못하는 기아(starvation)가 생긴다. `post_actions_pending`은
   * post_actions 배열 내용과 항상 동기화되는 색인 가능한 불리언 컬럼이므로
   * (OrchestrationMission.post_actions_pending 문서 참고), 이제 그 컬럼을
   * 직접 필터링해 "미확정 항목이 있는 미션"을 recency와 무관하게 전부
   * 찾아낸다. `take`는 한 스윕이 한 번에 처리하는 상한일 뿐 선택 기준이
   * 아니다 — 남은 건 다음 스윕(주기적 setInterval)이 이어받는다.
   */
  private async reapPendingPostActions(now: Date): Promise<number> {
    const candidates = await this.missionRepo.find({
      where: { status: In(['completed', 'failed']), post_actions_pending: true },
      take: 200,
    });
    if (candidates.length === 0) return 0;

    let recovered = 0;
    for (const mission of candidates) {
      try {
        await this.runner.recoverPostActions(mission.id);
        recovered += 1;
      } catch (e: any) {
        this.logService.warn(
          'Orchestration',
          `post-action recovery failed for mission ${mission.id}: ${e?.message || e}`,
        );
      }
    }
    return recovered;
  }

  private async reapStuckSteps(now: Date): Promise<number> {
    const inFlight = await this.stepRepo.find({
      where: { status: In(IN_FLIGHT_STEP_STATUSES as unknown as string[]) },
      order: { dispatched_at: 'ASC' },
      take: 200,
    });
    if (inFlight.length === 0) return 0;

    const missions = await this.missionRepo.find({
      where: { id: In(Array.from(new Set(inFlight.map((s) => s.mission_id)))) },
    });
    const missionById = new Map(missions.map((m) => [m.id, m]));
    const nowMs = now.getTime();
    let failed = 0;

    for (const step of inFlight) {
      const mission = missionById.get(step.mission_id);
      // `running` only: a paused mission's in-flight steps are still legitimately
      // executing and their operator deliberately stopped the clock on new work,
      // so timing them out would punish the pause.
      if (!mission || mission.status !== 'running') continue;
      const timeoutMs = mission.step_timeout_minutes * 60_000;
      if (timeoutMs <= 0) continue;
      // 마지막 생존 신호부터 잰다(티켓 4d065f82). `last_heartbeat_at` 은 progress 보고
      // **매 호출**마다 갱신되므로 이제 heartbeat 가 실제로 시계를 되돌린다.
      //
      // 이전에는 `started_at ?? dispatched_at` 이었는데, `started_at` 은 최초 progress
      // 호출에서 한 번만 찍히고 이후 갱신되지 않는다 — 즉 "progress 를 보고하면 살아남는다"는
      // 계약이 두 번째 호출부터 거짓이었고, 1분마다 살아있다고 알리는 step 도 타임아웃에
      // 걸려 죽었다. 세 값을 모두 fallback 으로 남겨 heartbeat 를 한 번도 안 보낸
      // step(=디스패치 직후 죽은 경우)도 예전과 똑같이 잡힌다.
      const baseline = step.last_heartbeat_at ?? step.started_at ?? step.dispatched_at;
      if (!baseline) continue;
      // 유예 중인 step 은 아직 타임아웃 창 안이 아니어도 재평가해야 한다 — 유예 만료
      // 판정이 runner 쪽에 있기 때문이다. 그 외에는 종전처럼 창 안이면 건너뛴다.
      if (!step.lease_stale_since && nowMs - new Date(baseline).getTime() < timeoutMs) continue;

      // 즉시 죽이지 않는다(리뷰 라운드1 P0-1). 이 한 메서드가 관측 → 재연결 요청 →
      // 유예 → 새 attempt 자동 재디스패치 → (불가 시) 종결까지 전부 담당한다. 부팅
      // 스윕과 주기 스윕이 같은 메서드를 부르므로 장애 감지와 재시작 복구가 하나의
      // reconciliation 경로다.
      const outcome = await this.runner.reconcileStaleLease(
        step.id,
        now,
        this.leaseGraceMs,
        mission.step_timeout_minutes,
      );
      if (outcome === 'terminal' || outcome === 'redispatched') failed += 1;
    }
    return failed;
  }

  private async reapStalledPlanning(now: Date): Promise<{ nudged: number; failed: number }> {
    const planning = await this.missionRepo.find({ where: { status: 'planning' }, take: 100 });
    if (planning.length === 0) return { nudged: 0, failed: 0 };

    const nowMs = now.getTime();
    let nudged = 0;
    let failed = 0;

    for (const mission of planning) {
      const baseline = mission.started_at ?? mission.created_at;
      if (!baseline || nowMs - new Date(baseline).getTime() < this.planningTimeoutMs) continue;

      // Attempt bookkeeping lives in the timeline so it survives a restart and
      // needs no extra column. `data.reason` is read rather than the event type
      // because an OPERATOR nudge writes the same type — counting those as
      // reaper attempts would fail a mission the reaper never actually
      // re-briefed. (data is a simple-json column; on sqlite it round-trips as
      // an object, so filter in memory rather than with a JSON predicate that
      // differs per backend.) `type:'error'` rows are pulled in too so a nudge
      // that failed to send (room deleted, sender participant gone — see the
      // catch below) still counts as an attempt; a reason filter keeps out any
      // unrelated error event (e.g. a failed initial mission briefing).
      const wakeEvents = await this.eventRepo.find({
        where: { mission_id: mission.id, type: In(['orchestrator_woken', 'error']) },
        order: { created_at: 'DESC' },
        take: 20,
      });
      const planningAttempts = wakeEvents.filter(
        (e) => e.type === 'orchestrator_woken' || e.data?.reason === 'planning_timeout_nudge_failed',
      );
      const priorPlanningNudges = planningAttempts.filter(
        (e) => e.data?.reason === 'planning_timeout' || e.data?.reason === 'planning_timeout_nudge_failed',
      ).length;

      // Back off a full timeout window from the LAST attempt of any kind,
      // delivered or failed — an operator who just nudged, or a reaper attempt
      // that merely couldn't be delivered, both deserve a chance to be
      // answered before the reaper piles another brief on top.
      const lastWake = planningAttempts[0];
      if (lastWake && nowMs - new Date(lastWake.created_at).getTime() < this.planningTimeoutMs) continue;

      if (priorPlanningNudges >= PLANNING_NUDGE_LIMIT) {
        // failMissionExternally 내부의 withMissionLock 안에서 재검증된다 — 이
        // 스냅샷과 give-up 결정 사이에 submit_orchestration_plan 호출이 끼어들
        // 수 있으므로, 위에서 읽은 `planning` 상태를 그대로 믿고 승격하면 안
        // 된다. 티켓 bf350dc8 참고.
        const wasFailed = await this.runner.failMissionExternally(
          mission.id,
          'planning',
          `orchestrator never submitted a plan — re-briefed ${priorPlanningNudges} time(s) without a ` +
            `submit_orchestration_plan call`,
          now,
        );
        if (wasFailed) failed += 1;
        continue;
      }

      const team = await this.teamRepo.findOne({ where: { id: mission.team_id } });
      try {
        await this.runner.nudgeOrchestrator(
          mission.id,
          mission.workspace_id,
          { type: 'system', id: '', name: 'Reaper' },
          `No plan has been submitted for this mission yet (${Math.round(
            (nowMs - new Date(baseline).getTime()) / 60_000,
          )} minutes since it was briefed). Team: ${team?.name ?? 'unknown'}. Submit a plan with ` +
            `submit_orchestration_plan, or complete the mission as failed if it cannot be planned.`,
          'planning_timeout',
        );
        nudged += 1;
      } catch (e: any) {
        this.logService.warn(
          'Orchestration',
          `planning nudge failed for mission ${mission.id}: ${e?.message || e}`,
        );
        await this.missions.recordEvent(mission, {
          type: 'error',
          message: `Could not re-brief the orchestrator for planning (${e?.message || e}). The mission needs operator attention.`,
          actor_type: 'system',
          data: { reason: 'planning_timeout_nudge_failed' },
        });
      }
    }
    return { nudged, failed };
  }

  /**
   * A mission stuck `running` with nothing in flight: every step reached a
   * terminal status (or none is assigned), so `reapStuckSteps` has nothing to
   * time out, yet the orchestrator never called `complete_orchestration_mission`
   * to close the mission out. `decideWake` already posted a wake the instant
   * this happened — this only fires once that wake has gone unanswered for a
   * full timeout window, then re-briefs, then gives up, mirroring
   * `reapStalledPlanning` exactly (same timeline-bookkeeping trick, same
   * back-off-from-last-wake rule, same nudge-limit-then-fail escalation).
   */
  private async reapStalledRunning(now: Date): Promise<{ nudged: number; failed: number }> {
    const running = await this.missionRepo.find({ where: { status: 'running' }, take: 100 });
    if (running.length === 0) return { nudged: 0, failed: 0 };

    const nowMs = now.getTime();
    let nudged = 0;
    let failed = 0;

    for (const mission of running) {
      const steps = await this.stepRepo.find({ where: { mission_id: mission.id } });
      // Legitimately busy — reapStuckSteps owns timing these out.
      if (steps.some((s) => isInFlight(s.status))) continue;
      // 사람의 confirm 판정을 기다리는 중이면 정지가 아니다(티켓 5dbe4aa2). 이 가드가
      // 없으면 리퍼가 사용자를 재촉하는 대신 **오케스트레이터**를 nudge 하고, 상한에
      // 도달하면 미션 자체를 failed 로 확정한다 — 사람이 답할 시간을 주려고 만든
      // durable pause 가 정확히 그 대기 시간 때문에 미션을 죽인다. `awaiting_user` 는
      // IN_FLIGHT_STEP_STATUSES 에 없으므로 위 검사만으로는 걸러지지 않는다.
      if (steps.some((s) => isAwaitingUser(s.status))) continue;

      // Baseline is the last time any step finished; if none ever has (every
      // step is still unassigned, say) fall back to when the mission started —
      // submitPlan always requires a non-empty plan, so a `running` mission has
      // always been briefed.
      const lastFinishedMs = steps.reduce((max, s) => {
        const t = s.finished_at ? new Date(s.finished_at).getTime() : 0;
        return t > max ? t : max;
      }, 0);
      const baselineMs = lastFinishedMs || (mission.started_at ? new Date(mission.started_at).getTime() : 0);
      if (!baselineMs || nowMs - baselineMs < this.runningStallTimeoutMs) continue;

      // Same bookkeeping as reapStalledPlanning: count prior reaper attempts off
      // the timeline (`data.reason`) rather than a column, and back off a full
      // window from the LAST wake of any kind (including decideWake's own
      // 'stalled' / 'all_steps_terminal' wakes, and the reaper's own failed
      // attempts — see the catch below) so a fresh wake gets its own chance to
      // be answered before the reaper piles another one on top.
      const wakeEvents = await this.eventRepo.find({
        where: { mission_id: mission.id, type: In(['orchestrator_woken', 'error']) },
        order: { created_at: 'DESC' },
        take: 20,
      });
      const stallAttempts = wakeEvents.filter(
        (e) => e.type === 'orchestrator_woken' || e.data?.reason === 'running_stall_nudge_failed',
      );
      const priorStallNudges = stallAttempts.filter(
        (e) => e.data?.reason === 'running_stall' || e.data?.reason === 'running_stall_nudge_failed',
      ).length;

      const lastWake = stallAttempts[0];
      if (lastWake && nowMs - new Date(lastWake.created_at).getTime() < this.runningStallTimeoutMs) continue;

      if (priorStallNudges >= RUNNING_STALL_NUDGE_LIMIT) {
        // failMissionExternally 내부의 withMissionLock 안에서 재검증된다 —
        // 타임아웃 직전에 응답된 nudge 가 이 스냅샷과 give-up 결정 사이에
        // replan/dispatch 로 새 스텝을 만들 수 있으므로, 위에서 읽은
        // "in-flight 없음" 을 그대로 믿고 승격하면 안 된다. 티켓 bf350dc8 참고.
        const wasFailed = await this.runner.failMissionExternally(
          mission.id,
          'running',
          `mission stalled in running with no in-flight work — re-briefed ${priorStallNudges} time(s) without a ` +
            `complete_orchestration_mission call`,
          now,
        );
        if (wasFailed) failed += 1;
        continue;
      }

      try {
        await this.runner.nudgeOrchestrator(
          mission.id,
          mission.workspace_id,
          { type: 'system', id: '', name: 'Reaper' },
          `No step has been in flight for ${Math.round(
            (nowMs - baselineMs) / 60_000,
          )} minutes and the mission is still running. Review the plan and either add more work with ` +
            `submit_orchestration_plan, or finish the mission with complete_orchestration_mission.`,
          'running_stall',
        );
        nudged += 1;
      } catch (e: any) {
        this.logService.warn(
          'Orchestration',
          `running-stall nudge failed for mission ${mission.id}: ${e?.message || e}`,
        );
        await this.missions.recordEvent(mission, {
          type: 'error',
          message: `Could not re-brief the orchestrator for the running stall (${e?.message || e}). The mission needs operator attention.`,
          actor_type: 'system',
          data: { reason: 'running_stall_nudge_failed' },
        });
      }
    }
    return { nudged, failed };
  }

  /**
   * 답을 오래 못 받은 confirm 게이트에 리마인더를 **1회** 보낸다(티켓 a78cb566, 요구사항 5).
   *
   * 이 스윕은 다른 reap* 들과 성질이 정반대다: **아무 상태도 바꾸지 않는다.** 미션도
   * step 도 건드리지 않고 알림만 내보내며, 유일한 쓰기는 "리마인더를 보냈다"는
   * `confirm_notice.reminded_at` 이다. `reapStalledRunning` 의 `isAwaitingUser` 가드가
   * 보장하는 계약 — 리퍼는 confirm 대기 미션을 죽이지 않는다 — 은 그대로 유지된다.
   * 재알림은 상태 전이가 아니라 알림이다.
   *
   * 대기 기준 시각은 최초 알림 시각이되, 그게 없으면(이 기능 이전에 열린 게이트이거나
   * 최초 발송 기록이 유실된 경우) 게이트가 열린 `dispatched_at` 으로 떨어진다 — 최초
   * 알림이 유실된 게이트야말로 리마인더가 가장 필요한 경우라 여기서 끊으면 안 된다.
   */
  private async remindAwaitingConfirm(now: Date): Promise<number> {
    if (this.confirmReminderAfterMs <= 0) return 0;
    const running = await this.missionRepo.find({ where: { status: 'running' }, take: 100 });
    if (running.length === 0) return 0;

    const nowMs = now.getTime();
    let reminded = 0;

    for (const mission of running) {
      const steps = await this.stepRepo.find({ where: { mission_id: mission.id } });
      for (const step of steps) {
        if (!isAwaitingUser(step.status)) continue;

        const visit = step.visit ?? 1;
        const notice = step.confirm_notice;
        const noticeIsForThisPass = !!notice && notice.visit === visit;
        // pass 당 1회. loop 로 다음 pass 가 열리면 visit 이 달라져 다시 자격이 생긴다.
        if (noticeIsForThisPass && notice!.reminded_at) continue;

        const anchor = noticeIsForThisPass && notice!.notified_at
          ? new Date(notice!.notified_at).getTime()
          : step.dispatched_at
            ? new Date(step.dispatched_at).getTime()
            : 0;
        if (!Number.isFinite(anchor) || anchor <= 0) continue;

        const waitedMs = nowMs - anchor;
        if (waitedMs < this.confirmReminderAfterMs) continue;

        // sendReminder 는 던지지 않는다(서비스 계약). 상한도 걸려 있어 스윕이 매달리지 않는다.
        await this.confirmNotify.sendReminder(mission, step, waitedMs);
        reminded += 1;
      }
    }
    return reminded;
  }

}
