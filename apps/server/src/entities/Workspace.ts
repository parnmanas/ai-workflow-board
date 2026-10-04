import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('workspaces')
export class Workspace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  // int type for SQLite compat (no native boolean in sql.js)
  @Column({ type: 'int', default: 0 })
  is_public: number; // 0=private, 1=public

  // URL-safe slug for workspace; nullable until backfill migration (Plan 02) sets defaults
  @Column({ type: 'varchar', unique: true, nullable: true })
  slug: string | null;

  // ─────────────────────────────────────────────────────────────────────
  // Ticket dispatch settings (docs/tickets.md). These used to live on each
  // Board; with boards gone the workspace is the only scope a ticket has.
  // ─────────────────────────────────────────────────────────────────────

  /** An in_progress ticket with no live agent and no activity for this long is re-dispatched by the supervisor. ms. Default: 30 min. */
  @Column({ type: 'int', default: 1800000 })
  supervisor_stale_ms: number;

  /** Cooldown between supervisor re-dispatches of the same ticket. ms. Default: 5 min. */
  @Column({ type: 'int', default: 300000 })
  supervisor_resend_ms: number;

  /** Distinct non-pending in_progress tickets one agent identity works at once. */
  @Column({ type: 'int', default: 1 })
  max_concurrent_tickets_per_agent: number;

  /** Non-null = ticket dispatch is paused for the whole workspace (humans can still edit/move). */
  @Column({ type: Date, nullable: true, default: null })
  dispatch_paused_at: Date | null;

  // Output language for every agent working a ticket here ("Korean", "English",
  // …). Appended to the harness system prompt at dispatch. null = agent default.
  @Column({ type: 'varchar', nullable: true, default: null })
  language: string | null;

  // Done tickets idle for this many days are archived by TicketArchiverService.
  // null = disabled. 1..365 enforced on write.
  @Column({ type: 'int', nullable: true, default: null })
  auto_archive_days: number | null;

  /**
   * Chat room to receive system alerts (e.g. CI-red pings from
   * `CiHealthMonitorService`). Optional — when null, the sender falls back to the workspace's oldest chat room
   * (`created_at ASC`) so an unconfigured workspace still surfaces the
   * alert somewhere visible. Operators set this via the workspace
   * settings PATCH when they want a dedicated #alerts room.
   *
   * No FK constraint — the column is a soft pointer so deleting the
   * chat room doesn't fail the cascade; the detector tolerates a stale
   * id by falling through to the oldest-room lookup.
   */
  @Column({ type: 'varchar', nullable: true, default: null })
  alerts_chat_room_id: string | null;

  // Workspace-wide agent harness (ticket 7122600c, common/harness-config.ts),
  // shipped on every ticket dispatch. null = no harness override.
  @Column({ type: 'text', nullable: true, default: null })
  harness_config: string | null;

  // dormant, no reader (티켓 e616dbfc) — Claude backend profile 이 인스턴스
  // 전역 단일 스코프로 확정되면서 이 두 레거시 컬럼을 읽거나 쓰는 코드는
  // 전부 사라졌다. 그럼에도 컬럼을 남기는 이유는 synchronize 가 하드코딩으로
  // 켜져 있어(db.ts D-01) 엔티티에서 지우는 순간 다음 부팅에 즉시·불가역으로
  // DROP 되는데, 이 JSON 이 마이그레이션 1760000000066(보드 제거 때 코드에서
  // 삭제 — 운영 DB 는 실행 완료) 을 거치지 않은 DB 에서는 레거시 프로필
  // 페이로드의 유일한 사본이기 때문이다. 실제 제거는
  // 그 백필이 전 환경에서 완료됐음을 확인한 뒤 별도 티켓에서 판단한다.
  @Column({ type: 'text', nullable: true, default: null })
  cli_runtime_profiles: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  default_cli_runtime_profile: string | null;

  // Workspace-wide environment setup (ticket 354d336b,
  // common/environment-config.ts) — env vars for ticket subagents. null = none.
  @Column({ type: 'text', nullable: true, default: null })
  environment_config: string | null;

  // Workspace hard-budget ceiling (ticket a51ec6d9, common/hard-budget-config.ts)
  // for the QA/Action/Orchestration run-creation-rate guard
  // (common/run-budget-guard.ts). null = the env-folded baseline.
  @Column({ type: 'text', nullable: true, default: null })
  hard_budget_config: string | null;

  // Workspace-wide default repository clone policy (ticket bddb63ee). Same JSON
  // shape as Project.clone_policy; a Project overrides it per key via
  // resolveClonePolicy (common/clone-policy.ts). null = no default — repos
  // without their own policy fall through to the system defaults (clone
  // timeout 60분).
  @Column({ type: 'text', nullable: true, default: null })
  clone_policy: string | null;

  /**
   * ticket 9fd27487(비-티켓 실행 경로에는 workspace-folder 컨벤션이
   * 없었다)을 위한 opt-in 스위치다. 0(기본값)이면 일반 채팅방의 디스패치
   * cwd는 변경되지 않는다(에이전트 working_dir 루트 그대로) — manager
   * 에이전트 자신의 운영용 채팅을 포함해 오늘날의 동작을 그대로 보존한다.
   * 1이면 RoomMessagingService가 일반(Action도 mission도 아닌) 채팅방의
   * 디스패치도 `.awb/chat/<room8>`에 고정한다(기본적으로 repo checkout 없음
   * — common/workspace-folder-options.ts 참고). SQLite 호환을 위해 boolean이
   * 아니라 int를 쓴다. Action Run 방은 이 플래그의 영향을 받지 않는다 —
   * 항상 자신의 `.awb/act/<leaf>` 폴더를 그대로 받는다.
   */
  @Column({ type: 'int', default: 0 })
  chat_workspace_folder_enabled: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
