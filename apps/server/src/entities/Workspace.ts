import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Board } from './Board';

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
  // Trigger-loop / supervisor / dispatch-queue cadence settings
  //
  // Workspace-scoped overrides for the three magic numbers that used to
  // be hardcoded constants in TicketSupervisorService and (implicitly,
  // unbounded) in TriggerLoopService. Defaults match the historical
  // constants so an unmigrated workspace keeps the prior behaviour.
  //
  // Operators bump these via a Workspace settings PATCH (REST/MCP) when
  // they need a different cadence — e.g. lower `supervisor_resend_ms`
  // for fast-paced demos, or a deeper `dispatch_queue_depth` for boards
  // that legitimately spike past the per-agent cap.
  // ─────────────────────────────────────────────────────────────────────

  /** Time-since-last-update before TicketSupervisor considers a (agent, ticket, role) pair stale. ms. Default: 30 min. */
  @Column({ type: 'int', default: 1800000 })
  supervisor_stale_ms: number;

  /** Cooldown between supervisor force-respawn re-pushes after the first stale emit. ms. Default: 5 min. */
  @Column({ type: 'int', default: 300000 })
  supervisor_resend_ms: number;

  /**
   * @deprecated since ticket 4a6cdfd7 (WorkflowFocusSelector). The
   * per-agent dispatch queue was removed when the cap model was
   * replaced with the focus selector — triggers are now either emitted
   * immediately (focus = ticket) or dropped silently (focus ≠ ticket).
   *
   * The column is kept on the entity / REST setter / MCP setter so
   * older clients setting `dispatch_queue_depth` still get HTTP 200
   * rather than 400; a follow-up cleanup ticket can drop the column
   * after one release cycle. No runtime code reads this value.
   */
  @Column({ type: 'int', default: 100 })
  dispatch_queue_depth: number;

  /**
   * Chat room to receive system alerts (e.g. stale-WAIT detector pings
   * from `StuckTicketDetectorService`, ticket 8e934802). Optional — when
   * null, the detector falls back to the workspace's oldest chat room
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

  /**
   * AWB 어시스턴트 에이전트 (에픽 bf65ca00 · S2). Chat-first 기본 진입 화면이 이
   * 에이전트와의 DM 프리셋으로 연결되어, 기존 chat-rooms DM auto-route
   * (`_handleDmAgentRequest`) 로 사용자 발화가 멘션 없이 어시스턴트에게 라우팅된다.
   *
   * null = 미지정. 기존 workspace 는 전부 null 로 시작하며(마이그레이션 0 — nullable
   * default null), Advanced/Board 흐름에는 어떤 동작 변화도 없다. 미지정일 때 클라이언트는
   * 임의 에이전트를 자동 선택하지 않고 "관리자가 어시스턴트를 지정" 하도록 안내하는 명시적
   * empty state 를 렌더한다.
   *
   * `alerts_chat_room_id` 와 동일한 soft pointer — FK 제약 없음. 지정된 에이전트가
   * 삭제·비활성·다른 workspace 로 이동해 유효하지 않으면 클라이언트가 동일한 안전
   * fallback(empty state)로 처리한다. 값 설정은 workspace PATCH 에서 관리자 권한 +
   * workspace 경계(활성 에이전트, 매니저 제외) 검증을 거친다.
   */
  @Column({ type: 'varchar', nullable: true, default: null })
  assistant_agent_id: string | null;

  // Workspace-wide default agent harness (ticket 7122600c). Same JSON shape
  // as Board.harness_config; boards override it per key via
  // resolveHarnessConfig (common/harness-config.ts). null = no default —
  // boards without their own harness keep the current dispatch behaviour.
  @Column({ type: 'text', nullable: true, default: null })
  harness_config: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  cli_runtime_profiles: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  default_cli_runtime_profile: string | null;

  // Global-registry selector. null inherits the instance default; "none"
  // explicitly selects the native Anthropic endpoint.
  @Column({ type: 'varchar', nullable: true, default: null })
  default_claude_backend_profile_id: string | null;

  // Distinguishes an intentionally empty registry allow-set from a database
  // that has not run the legacy JSON backfill yet.
  @Column({ type: 'boolean', default: false })
  claude_backend_profiles_migrated: boolean;

  // Workspace-wide default environment setup (ticket 354d336b). Same JSON shape
  // as Board.environment_config; boards override it per top-level key via
  // mergeEnvironmentConfig (common/environment-config.ts). null = no default —
  // boards without their own environment_config keep the current dispatch
  // behaviour (no provisioning step).
  @Column({ type: 'text', nullable: true, default: null })
  environment_config: string | null;

  // Workspace-wide default hard-budget ceiling (ticket a51ec6d9). Same JSON
  // shape as Board.hard_budget_config; boards override it per key via
  // resolveHardBudget (common/hard-budget-config.ts). Also the ONLY scope
  // axis for the QA/Action/Orchestration run-creation-rate ceiling
  // (common/run-budget-guard.ts) — those three entities have no board_id
  // (docs/catalog-scopes.md), so this column is their sole override point.
  // null = no default — boards/runs without a workspace override keep the
  // env-folded baseline.
  @Column({ type: 'text', nullable: true, default: null })
  hard_budget_config: string | null;

  // ─────────────────────────────────────────────────────────────────────
  // Claim-verification (ticket dcb9d661): detect assignees who post an
  // "I'm done" comment in an active column without actually pushing a
  // commit or calling move_ticket, and auto-park the ticket for human
  // review after a grace window. Off by default until per-workspace
  // tuning settles — flip on via Workspace settings PATCH.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Master switch for `ClaimVerificationService`. When 0 the sweep
   * skips this workspace entirely (no DB reads, no GitHub fetches,
   * no pend) so a disabled workspace has zero per-tick cost. int
   * (not boolean) for SQLite compat.
   */
  @Column({ type: 'int', default: 0 })
  claim_verification_enabled: number;

  /**
   * Grace window — milliseconds since the assignee's claim comment
   * during which a follow-up commit (snapshot SHA advances) or
   * move_ticket call cancels the pend. Default 10 minutes.
   */
  @Column({ type: 'int', default: 600000 })
  claim_verification_grace_ms: number;

  /**
   * ticket 9fd27487(비-티켓 실행 경로에는 workspace-folder 컨벤션이
   * 없었다)을 위한 opt-in 스위치다. 0(기본값)이면 일반 채팅방의 디스패치
   * cwd는 변경되지 않는다(에이전트 working_dir 루트 그대로) — manager
   * 에이전트 자신의 운영용 채팅을 포함해 오늘날의 동작을 그대로 보존한다.
   * 1이면 RoomMessagingService가 일반(Action도 mission도 아닌) 채팅방의
   * 디스패치도 `.awb/chat/<room8>`에 고정한다(기본적으로 repo checkout 없음
   * — common/workspace-folder-options.ts 참고). 위의
   * claim_verification_enabled와 마찬가지로 SQLite 호환을 위해 boolean이
   * 아니라 int를 쓴다. Action Run 방은 이 플래그의 영향을 받지 않는다 —
   * 항상 자신의 `.awb/act/<leaf>` 폴더를 그대로 받는다.
   */
  @Column({ type: 'int', default: 0 })
  chat_workspace_folder_enabled: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => Board, board => board.workspace, { cascade: true, eager: true })
  boards: Board[];
}
