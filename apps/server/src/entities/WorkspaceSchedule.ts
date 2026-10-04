import { runtimeIdentityKey, parseRuntimeSpec } from '../common/runtime-spec';
import { AfterLoad, BeforeInsert, BeforeUpdate, Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * WorkspaceSchedule — a general-purpose "do this task at this time" trigger for a
 * single agent (ticket 8845be79). Born from the floating `Ralf-QaRelay` Windows
 * Scheduled Task an agent had registered via host MCP: that need belongs INSIDE
 * AWB, so this generalizes the proven QA/Security scheduler template
 * (QaSchedule b6bb7efd / SecuritySchedule 7c07c19d) into a content-agnostic one.
 *
 * What it does: when a schedule comes due, the background WorkspaceScheduleService
 * opens a FRESH chat room each run, drops the `target_agent_id` in, and sends
 * `task_prompt` as the opening message — exactly the QA/Security RUN dispatch
 * shape (qa-run.service.ts:198-245: create room → add agent + synthetic 'system'
 * user → sendMessage). The scheduler owns only the "when"; the actual work runs
 * through the existing chat → agent-manager spawn path (no second dispatch route).
 *
 * Confirmed product decisions (2026-06-29):
 *   1. ONE target per schedule — a single `target_agent_id` + a single free-text
 *      `task_prompt`. No multi-target / task-list fan-out.
 *   2. NEW ROOM PER RUN — every tick creates a new chat room (`last_room_id`
 *      records the most recent one). No reused per-schedule room.
 *
 * **무엇을 할지는 두 형태다 — 정확히 하나만 설정된다** (ticket: Action cron 이관):
 *   (a) `task_prompt` — 이 스케줄이 직접 들고 있는 프롬프트. 위 1·2 그대로.
 *   (b) `action_id`   — 등록된 Action 을 실행한다. 대상 에이전트·작업 폴더·
 *       repo·승인(high_impact)·fan-out·run 기록은 전부 **Action 이 정의**하고,
 *       이 스케줄은 "언제"만 정한다. 그래서 (b) 에서는 `target_agent_id` 가
 *       비어 있고 방도 이 서비스가 만들지 않는다 — ActionsService.dispatch 가
 *       자기 파이프라인(ActionRun · batch · 승인 게이트)으로 처리한다.
 *
 * 이 분리의 이유: 예전에는 `actions.schedule_cron` 이 따로 있어 크론 구현이 두
 * 벌이었다. Action 쪽은 로컬시간 tick-match 라 그 1분에 서버가 죽어 있으면 그날
 * 실행이 조용히 사라졌고, 이쪽은 UTC + `next_run_at` 이라 따라잡았다. 한쪽으로
 * 모으면서 남긴 것은 따라잡는 쪽이다.
 *
 * Cadence: exactly one of `cron` (5-field UTC — see modules/qa/qa-cron.ts, reused)
 * or `interval_ms`. `next_run_at` is the precomputed next firing instant the tick
 * compares against; `last_run_at`/`last_room_id` record the most recent dispatch.
 *
 * Idempotency: `next_run_at` is advanced + persisted BEFORE the (async) dispatch,
 * so a re-entrant/overlapping tick sees the cursor already past `now` and no-ops
 * — the same ordering QaScheduleService uses. Unlike QA/Security there is no
 * batch/run lifecycle to poll, so there is no SKIP-if-running guard: a scheduled
 * task is fire-and-forget; the pre-advance is the sole duplicate-dispatch guarantee.
 *
 * Column types follow QaSchedule for SQLite/Postgres dual compat (varchar / int /
 * Date / boolean / text). No JSON-array columns here, so none of the
 * awb-field-wiring manual parse/stringify touch points apply.
 */
@Entity('workspace_schedules')
@Index(['workspace_id', 'enabled'])
export class WorkspaceSchedule {
  @AfterLoad()
  @BeforeInsert()
  @BeforeUpdate()
  refreshRuntimeIdentity(): void {
    const spec = parseRuntimeSpec(this.target_runtime);
    this.target_agent_id = spec ? runtimeIdentityKey(spec) : '';
  }

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  name: string;

  /** Computed dispatch keys. Runtime specs below are the persisted source of truth. */
  target_agent_id: string = '';

  @Column({ type: 'simple-json', nullable: true, default: null })
  target_runtime: Record<string, any> | null;

  // The free-text task message sent to the agent when the schedule fires. `text`
  // (not varchar) so long multi-line prompts are not truncated on either DB.
  // Action 형태에서는 비어 있다.
  @Column({ type: 'text', default: '' })
  task_prompt: string;

  // 실행할 Action. 설정되면 `task_prompt`/`target_agent_id` 대신 이쪽을 쓴다 —
  // 서비스가 "정확히 하나" 를 강제한다. Action 이 삭제되면 이 스케줄은 매 틱
  // 실패하는 대신 **스스로 비활성화**된다(서비스 `_dispatch` 참고): 없는 것을
  // 매일 호출해 로그만 쌓는 것보다 운영자가 목록에서 보고 지우는 편이 낫다.
  @Column({ type: 'varchar', nullable: true, default: null })
  action_id: string | null;

  // Exactly one cadence is set. cron is a 5-field UTC expression (qa-cron.ts);
  // interval_ms is a fixed gap in milliseconds. The service rejects "both"/"neither".
  @Column({ type: 'varchar', nullable: true, default: null })
  cron: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  interval_ms: number | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // Precomputed next firing instant the tick compares against. Recomputed after
  // every dispatch (and on enable/cadence change). null while disabled / unset.
  @Column({ type: Date, nullable: true, default: null })
  next_run_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_run_at: Date | null;

  // The most recent chat room this schedule opened — the client can deep-link to
  // it to see the last dispatched conversation.
  @Column({ type: 'varchar', nullable: true, default: null })
  last_room_id: string | null;

  @Column({ type: 'varchar', default: 'user' })
  triggered_by_type: string;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
