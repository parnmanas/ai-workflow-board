/**
 * ActionRunReaperService — 실행 에이전트가 죽어서 `complete_action_run`을
 * 영영 호출하지 못한 채 `status='running'`으로 남은 ActionRun을 종료 처리한다.
 *
 * 왜 필요한가: `ActionsService.dispatch()`는 ActionRun을 status='running'으로
 * 생성하고, 대상 에이전트가 `complete_action_run`을 호출해야만 terminal 상태로
 * 넘어간다. `action-scheduler.service.ts`의 `_tick()`은 cron 매칭 기반 디스패치
 * 전용이라 이미 디스패치된 run을 스윕하지 않는다 — 대상 에이전트가 도중에
 * 죽으면 아무도 감지하지 못한 채 영원히 `running`으로 남는다. `QaRunReaperService`
 * (qa-run-reaper.service.ts)·`SecurityRunReaperService`가 각자 도메인에서 닫는
 * 것과 동일한 부류의 좀비다.
 *
 * ActionRun의 상태 머신은 QaRun보다 단순하다 — non-terminal 상태가 'running'
 * 하나뿐이고(QaRun처럼 'pending' 단계가 없음), 진행률을 셀 step 같은 신호도
 * 없다. 그래서 이 리퍼는 QaRunReaperService의 zero-progress/6h-TTL 이중 퓨즈
 * 대신, age = now - created_at(ActionRun엔 started_at이 없음) 단일 age gate만
 * 사용한다.
 *
 * Reap = run row를 직접 mutate하지 않고 `ActionsService.completeRun()`으로
 * 정상 'failed' 완료를 보고한다. 이렇게 하면 completeRun이 이미 가진 안전장치를
 * 전부 그대로 재사용한다 — status='running' guard 위의 원자적 idempotent
 * 전이(진짜 살아있던 에이전트의 뒤늦은 complete_action_run과 경합해도 이중
 * 완료가 안 됨), non-high-impact Action의 bounded 자동 재시도(정지된 run도
 * 실제 실패와 동일한 재시도 체인을 탐), source ticket 감사 코멘트까지.
 *
 * `ActionRun`은 QaRun/SecurityRun/OrchestrationStep과 달리 "나를 디스패치한
 * 티켓을 재개시킨다"는 진짜 계약(`source_ticket_id` + completeRun의
 * `shouldResume`)을 갖는 유일한 Run 엔터티다. 그래서 다른 리퍼들과 달리
 * `shouldResume`이 true로 돌아오면 `TriggerLoopService.dispatchCurrentColumn`을
 * 호출해 소스 티켓을 재개시킨다 — `complete_action_run` MCP 툴
 * (action-tools.ts)이 에이전트가 직접 보고한 완료에 대해 하는 일을 리퍼
 * 컨텍스트에서 그대로 반복하는 것뿐이다. TriggerLoopService를 얻으려고
 * AgentsModule을 직접 import하는 것도 TicketsModule/FeaturesModule/
 * BenchmarksModule이 이미 쓰는 선례와 동일한 패턴이다(순환 의존 없음).
 *
 * 패턴은 형제 리퍼들과 동일: OnModuleInit이 평범한 setInterval을 심고(별도
 * 스케줄러 의존 없음), 부팅 즉시 1회 스윕, `runOnce()`는 수동/테스트 트리거용
 * public 메서드, destroy 시 타이머 해제.
 *
 * Env: ACTION_RUN_REAPER_ENABLED(기본 on), ACTION_RUN_REAPER_SWEEP_MS(기본
 * 15분, 1분~1시간 clamp), ACTION_RUN_TTL_MS(기본 2시간, 5분~24시간 clamp).
 *
 * 스윕 후보는 `source_ticket_id`가 있는 run으로 한정한다 —
 * `complete_action_run` 완료 계약은 `sourceTicketId`가 있을 때만 프롬프트에
 * 주입되므로(actions.service.ts renderPrompt), cron(action-scheduler.service.ts)·
 * 수동 UI 실행(actions.controller.ts)·on-ticket-done(on-ticket-done-action.
 * service.ts) 경로로 디스패치된 run은 대상 에이전트가 run_id 자체를 모른다.
 * 이런 run의 `status='running'`은 좀비가 아니라 이 run 타입의 영구적으로
 * 정상인 종착 상태이므로, 이 게이트 없이 스윕하면 정상 이력을 전부 거짓
 * failed로 오염시킨다. 이 게이트를 통과하는 대상은 티켓 구동 run으로
 * 좁혀지므로, 형제 리퍼(QA/Security 6시간)보다 짧은 2시간 기본 TTL도 방어
 * 가능하다고 판단했다 — zero-progress 같은 빠른 퓨즈나 room 최근 메시지
 * (`ChatRoom.last_message_at`) 기반 liveness 신호는 넣지 않았다(over-eng 회피).
 * TTL을 6시간으로 올리고 싶으면 `ACTION_RUN_TTL_MS`로 바로 조정 가능하다.
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActionRun } from '../../entities/ActionRun';
import { LogService } from '../../services/log.service';
import { ActionsService } from './actions.service';
import { TriggerLoopService } from '../agents/trigger-loop.service';

const DEFAULT_SWEEP_MS = 15 * 60_000; // 15 minutes
const MIN_SWEEP_MS = 60_000;          // 1 minute
const MAX_SWEEP_MS = 60 * 60_000;     // 1 hour
const DEFAULT_TTL_MS = 2 * 60 * 60_000; // 2 hours
const MIN_TTL_MS = 5 * 60_000;          // 5 minutes
const MAX_TTL_MS = 24 * 60 * 60_000;    // 24 hours
const ACTION_RUN_REAPER_BATCH = 200;

function clampEnv(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(max, Math.max(min, raw));
}

@Injectable()
export class ActionRunReaperService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: NodeJS.Timeout | null = null;
  private sweeping = false;

  private readonly sweepMs = clampEnv('ACTION_RUN_REAPER_SWEEP_MS', DEFAULT_SWEEP_MS, MIN_SWEEP_MS, MAX_SWEEP_MS);
  private readonly ttlMs = clampEnv('ACTION_RUN_TTL_MS', DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
  private readonly enabled = (process.env.ACTION_RUN_REAPER_ENABLED || 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(ActionRun) private readonly runRepo: Repository<ActionRun>,
    private readonly actionsService: ActionsService,
    private readonly triggerLoopService: TriggerLoopService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logService.info('ActionReaper', 'disabled via ACTION_RUN_REAPER_ENABLED=false');
      return;
    }
    this.tickHandle = setInterval(() => {
      this.runOnce().catch((e: unknown) => {
        this.logService.error('ActionReaper', 'tick failed', { err: String(e) });
      });
    }, this.sweepMs);
    // Don't keep the event loop alive on the timer alone (mirrors the other sweeps).
    this.tickHandle.unref?.();
    this.logService.info('ActionReaper', 'Service initialized', { sweep_ms: this.sweepMs, ttl_ms: this.ttlMs });
    // Immediate boot sweep: a deploy/restart clears standing phantoms within
    // seconds instead of idling up to a full sweep interval. Fire-and-forget so
    // a slow/failed first sweep never blocks module init.
    this.runOnce().catch((e: unknown) => {
      this.logService.error('ActionReaper', 'boot sweep failed', { err: String(e) });
    });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * One reap sweep. Public so a test / operator endpoint can drive it
   * deterministically. Safe to call concurrently — overlapping calls are
   * dropped (mirrors OrchestrationReaperService).
   */
  async runOnce(now: Date = new Date()): Promise<{
    reaped: string[];
    details: Array<{ id: string; age_min: number }>;
  }> {
    if (this.sweeping) return { reaped: [], details: [] };
    this.sweeping = true;
    try {
      // Only non-terminal ActionRun status: 'running'. 'succeeded'/'failed' are
      // terminal (see ActionRun.status doc comment) and never candidates.
      // source_ticket_id-less runs (cron/manual/on-ticket-done — see class doc)
      // are excluded HERE, at the query stage, rather than via a skip inside the
      // loop below: a JS-loop skip still spends its take(ACTION_RUN_REAPER_BATCH)
      // budget on them, so once permanently-'running' contract-less rows
      // outnumber the batch size, a created_at-ASC sweep fills entirely with
      // always-skipped rows and a real, newer zombie is never reached — silently,
      // since the "reaped stale runs" log only fires when something was actually
      // reaped. Filtering before take() keeps the budget scoped to real
      // candidates. IS NOT NULL is required alongside != '' because Postgres's
      // three-valued NULL comparison would otherwise silently drop legacy NULL
      // rows out of the "has a ticket" side too (Not('') was avoided for the
      // same reason when this gate was first added).
      const candidates = await this.runRepo
        .createQueryBuilder('r')
        .where('r.status = :status', { status: 'running' })
        .andWhere("r.source_ticket_id IS NOT NULL AND r.source_ticket_id != ''")
        .orderBy('r.created_at', 'ASC')
        .take(ACTION_RUN_REAPER_BATCH)
        .getMany();
      if (candidates.length === 0) return { reaped: [], details: [] };

      const reaped: string[] = [];
      const details: Array<{ id: string; age_min: number }> = [];
      for (const run of candidates) {
        const ageMs = now.getTime() - new Date(run.created_at).getTime();
        if (ageMs < this.ttlMs) continue;
        const ageMin = Math.round(ageMs / 60_000);
        try {
          const result = await this.actionsService.completeRun(run.id, run.workspace_id, {
            status: 'failed',
            summary:
              `[auto-reaped by ActionRunReaperService] no result was reported within ` +
              `${Math.round(this.ttlMs / 60_000)} minutes — the target agent most likely died before it ` +
              `could call complete_action_run.`,
            actorType: 'system',
            actorId: '',
            actorName: 'ActionRunReaper',
          });
          // A real complete_action_run (or a concurrent sweep) already closed this
          // run between our SELECT and this call — not something WE reaped.
          if (result.previouslyCompleted) continue;
          reaped.push(run.id);
          details.push({ id: run.id, age_min: ageMin });
          // ActionRun is the only Run-type entity with a real "resume the ticket
          // that dispatched me" contract. Mirrors what the complete_action_run
          // MCP tool does for an agent-reported completion (action-tools.ts).
          if (result.shouldResume && result.sourceTicketId) {
            await this.triggerLoopService
              .dispatchCurrentColumn(result.sourceTicketId, 'action_run_reaped', '')
              .catch((e: unknown) =>
                this.logService.warn('ActionReaper', 'resume dispatch failed (continuing)', {
                  err: String(e), run_id: run.id, ticket_id: result.sourceTicketId,
                }),
              );
          }
        } catch (e) {
          this.logService.warn('ActionReaper', 'per-run reap failed (continuing)', { err: String(e), run_id: run.id });
        }
      }

      if (reaped.length > 0) {
        this.logService.info('ActionReaper', 'reaped stale runs', { count: reaped.length, ttl_ms: this.ttlMs, details });
      }
      return { reaped, details };
    } finally {
      this.sweeping = false;
    }
  }
}
