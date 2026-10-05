import { runtimeIdentityKey, parseRuntimeSpec } from '../common/runtime-spec';
import { AfterLoad, BeforeInsert, BeforeUpdate, Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { CheckoutMode, WorkspaceFolderRepoRef } from '../common/workspace-folder-options';

// User-defined "Action": a saved prompt addressed to a target Agent. When a
// user (or scheduler) runs the action, AWB creates a fresh ChatRoom and posts
// the rendered prompt as the user's first message. The agent's reply lands in
// the room via the existing chat_room_message SSE flow — no new event type is
// needed because Run-as-chat-room reuses the room infrastructure verbatim.
//
// account_id is required.
@Entity('actions')
export class Action {
  @AfterLoad()
  @BeforeInsert()
  @BeforeUpdate()
  refreshRuntimeIdentity(): void {
    const ids = (this.target_runtimes || []).map(parseRuntimeSpec).filter((spec) => spec !== null).map(runtimeIdentityKey);
    this.target_agent_ids = JSON.stringify(ids);
    this.target_agent_id = ids[0] || '';
  }

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  // The prompt template that gets rendered with `{{var}}` substitutions and
  // sent to the target agent on each Run.
  @Column({ type: 'text', default: '' })
  prompt: string;

  /** Computed dispatch keys. Runtime specs below are the persisted source of truth. */
  target_agent_id: string = '';
  target_agent_ids: string = '[]';

  @Column({ type: 'simple-json', nullable: true, default: null })
  target_runtimes: Array<Record<string, any>> | null;

  /**
   * @deprecated 크론은 Account Schedule 로 옮겼다 — `automation_schedules.action_id`
   * 가 이 Action 을 가리키고 "언제" 는 그쪽이 정한다. 이유는
   * `entities/AutomationSchedule.ts` 헤더 참조(구현이 두 벌이었고 이쪽은 로컬시간
   * tick-match 라 서버가 그 1분에 죽어 있으면 실행이 조용히 사라졌다).
   *
   * 컬럼은 **이번 릴리스에서 아직 지우지 않는다.** `synchronize: true` 가 마이그레이션
   * 보다 먼저 도므로, 엔티티에서 빼면 이관 마이그레이션이 읽기도 전에 컬럼이
   * 사라진다. 이관이 끝난 다음 릴리스에서 컬럼째 제거할 것.
   *
   * 읽는 곳도 쓰는 곳도 없다 — 저장을 시도하면 ActionsService 가 400 으로 거부하고
   * 갈 곳을 알려 준다.
   */
  @Column({ type: 'varchar', default: '' })
  schedule_cron: string;

  // Lifecycle trigger (ticket 16a6339c). Empty string = the legacy
  // cron/manual-only Action. `'on_ticket_done'` opts the Action into the
  // on-ticket-done hook: when a ticket enters `done`,
  // OnTicketDoneActionService dispatches a Run with the completed ticket as
  // context, applied workspace-wide. trigger_label optionally narrows the
  // policy further:
  //   - trigger_label empty → any ticket; non-empty → the finished ticket must
  //     carry that tag.
  // `enabled=false` still skips the hook (manual run_action only) — same rule
  // the scheduler already honours.
  @Column({ type: 'varchar', default: '' })
  trigger: string;

  // Tag-scope filter for `trigger='on_ticket_done'` (ticket 16a6339c). Empty
  // = no tag requirement (workspace-wide). Non-empty = the finished ticket's
  // `tags` must include this exact string for the hook to fire. (The column
  // predates tags — they replaced ticket labels with the same encoding.)
  // Ignored when `trigger` is not 'on_ticket_done'.
  @Column({ type: 'varchar', default: '' })
  trigger_label: string;

  // Disable a recurring action without deleting it. Manual `run_action` calls
  // still work even when this is false — disabled only blocks the scheduler.
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // High-impact classification (ticket 524bb434, scope 5). Marks an Action
  // whose failure does NOT reliably mean "the external operation did not run"
  // — deploy, publish, release. For these the server does NOT auto-retry a
  // failed ticket-driven run (a bounded retry is not operation idempotency; a
  // blind re-run of a half-completed deploy can double the external effect).
  // Instead the failure surfaces immediately back to the source ticket so a
  // human decides whether the operation actually landed. Non-high-impact
  // Actions keep the bounded auto-retry. Pairs with ActionRun.idempotency_key,
  // which is carried verbatim across retries so the target operation can dedupe.
  @Column({ type: 'boolean', default: false })
  high_impact: boolean;

  // FIFO-prune budget: how many rooms (Runs) to keep per action. When a new
  // Run is dispatched and the count exceeds this, the oldest rooms (by
  // created_at) are deleted. Default 10 per ticket-locked decision (Q2=b).
  @Column({ type: 'int', default: 10 })
  max_runs: number;

  // Bookkeeping for the scheduler so it doesn't double-fire across restarts.
  @Column({ type: Date, nullable: true, default: null })
  last_run_at: Date | null;

  // ── 작업폴더 옵션 (ticket 9fd27487) ──────────────────────────────────────
  // QaScenario/SecurityProfile과 동일한 필드 구성 + 정규화 방식이다(참고:
  // common/workspace-folder-options.ts). Run은 `.awb/act/<leaf>`로
  // 디스패치된다(run-keyed가 아니라 action-keyed — 이 Action의 모든 Run이
  // 같은 폴더를 재사용해서 warm checkout이 run 사이에도 유지된다).

  // `.awb/act/` 아래의 working_dir-relative run 폴더다(worktree 규약 ③의
  // action 버전). '' = 미설정 → 디스패치 시점에 결정론적 기본값
  // `.awb/act/<action8>`로 해석된다(resolveWorkspaceFolder).
  @Column({ type: 'varchar', default: '' })
  workspace_folder: string;

  // 실행 대상 repo. null = clone 없음 — provisioner는 폴더 존재만 보장한다
  // (대부분의 Action은 특정 repo checkout이 아니라 운영용 스크립트이기
  // 때문이다). simple-json(자동으로 직렬화된다).
  @Column({ type: 'simple-json', nullable: true, default: null })
  repo_ref: WorkspaceFolderRepoRef | null;

  // run 전에 working folder를 어떻게 준비할지. 기본값 'reuse'.
  @Column({ type: 'varchar', default: 'reuse' })
  checkout_mode: CheckoutMode;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
