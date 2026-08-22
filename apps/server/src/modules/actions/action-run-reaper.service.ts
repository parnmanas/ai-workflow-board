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
 * 스윕 후보는 (a) `source_ticket_id`가 있는 run 이거나 (b)
 * `completion_contract_injected=true`인 run으로 한정한다 (티켓 2fa5312b, b273d603
 * 후속). `dispatch()`는 이제 `sourceTicketId`가 없는 run(사람 UI 트리거·cron·
 * on-ticket-done)에도 완료 계약을 주입하고(재개/재시도 언급이 없는 standalone
 * 버전 — actions.service.ts의 `renderStandaloneCompletionContract` 참고) 그
 * 순간 `ActionRun.completion_contract_injected`를 무조건 true로 남긴다
 * (ActionRun.ts 참고). 이 플래그가 바로 (b) 조건이다 — `source_ticket_id`가
 * 없어도 이 플래그가 true면 대상 에이전트가 `complete_action_run`을 호출할
 * 방법을 실제로 받았다는 뜻이라 안전하게 스윕 대상에 넣을 수 있다.
 *
 * 이 플래그가 생기기 이전(= b273d603 배포 이전)에 디스패치돼 애초에 완료 계약을
 * 못 받은 채 `running`에 멈춰있는 기존 orphan run들은 컬럼 자체가 없던 시절에
 * 만들어졌으므로 스키마 기본값 false로 남는다 — 그래서 (b) 조건을 만족하지
 * 못하고 계속 스윕에서 제외된다(거짓 `failed` 오염 방지). `source_ticket_id`도
 * 없고 `completion_contract_injected`도 false인 run만 영구 보존 대상이다.
 *
 * (a) 조건을 통과하는 대상은 티켓 구동 run으로 좁혀지므로, 형제 리퍼(QA/Security
 * 6시간)보다 짧은 2시간 기본 TTL도 방어 가능하다고 판단했다 — zero-progress
 * 같은 빠른 퓨즈나 room 최근 메시지(`ChatRoom.last_message_at`) 기반 liveness
 * 신호는 넣지 않았다(over-eng 회피). TTL을 6시간으로 올리고 싶으면
 * `ACTION_RUN_TTL_MS`로 바로 조정 가능하다.
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
      // non-terminal인 ActionRun 상태는 'running' 하나뿐이다. 'succeeded'/
      // 'failed'는 terminal이라(ActionRun.status doc 코멘트 참고) 절대
      // 후보가 되지 않는다.
      // source_ticket_id도 없고 completion_contract_injected도 없는(class
      // doc + ActionRun.ts 참고), 즉 스스로는 절대 완료할 수 없는 run은 아래
      // 루프 안에서 skip하는 대신 바로 이 쿼리 단계에서 제외한다 — JS
      // 루프에서 skip해도 take(ACTION_RUN_REAPER_BATCH) 예산은 그대로
      // 소모되므로, 영원히 'running'인 계약 없는 row가 batch 크기를 넘어서는
      // 순간 created_at 오름차순 스윕이 전부 skip 대상으로만 채워져 정작
      // 진짜로 새로 생긴 좀비는 조용히 도달조차 못 하게 된다 — "reaped
      // stale runs" 로그는 실제로 뭔가 reap됐을 때만 찍히므로 이 상황은
      // 티도 안 난다. take() 이전에 필터링해두면 예산이 진짜 후보에만
      // 쓰인다. IS NOT NULL을 != '' 와 나란히 요구하는 이유는 Postgres의
      // 3진 NULL 비교 때문이다 — 안 그러면 legacy NULL row가 "티켓이 있음"
      // 쪽에서도 조용히 빠진다(같은 이유로 이 게이트를 처음 추가할 때
      // Not('')도 피했다).
      // 두 조건은 where() + andWhere(OR ...) 대신 하나의 where() 호출에 OR
      // 그룹 전체를 명시적 바깥 괄호로 묶어 합친다 — TypeORM은
      // `isolateWhereStatements` DataSource 옵션이 켜져 있을 때만 각
      // where()/andWhere() 절을 자동으로 괄호로 감싸는데(이 프로젝트는
      // 꺼져 있음 — db.ts 참고), `.where(status)` 뒤에 그냥
      // `.andWhere("A OR B")`를 붙이면 `status = ? AND A OR B`가 나가버린다
      // — SQL의 AND-먼저-OR-나중 우선순위 규칙상 이는
      // `(status = ? AND A) OR B`로 읽혀 B가 참이기만 하면 terminal
      // (succeeded/failed) row까지 조용히 들여보낸다. 전부 우리가 직접
      // 괄호를 넣은 문자열 하나로 합치면 이 모호함이 완전히 사라진다.
      const candidates = await this.runRepo
        .createQueryBuilder('r')
        .where(
          "r.status = :status AND ((r.source_ticket_id IS NOT NULL AND r.source_ticket_id != '') OR r.completion_contract_injected = :contractInjected)",
          { status: 'running', contractInjected: true },
        )
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
