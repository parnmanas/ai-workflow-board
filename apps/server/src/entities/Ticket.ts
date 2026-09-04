import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, VersionColumn, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BoardColumn } from './BoardColumn';
import { Comment } from './Comment';

// Indexes cover the hottest filter patterns on this table (perf ticket
// b3812637). The board GET loads root tickets per column via
// (column_id, parent_id IS NULL); child lookups filter by parent_id alone;
// the trigger loop / focus selector / archiver filter by workspace_id and
// archived_at. None of these were indexed, so every such read degraded to a
// full table scan once the table grew. SQLite (dev) builds these from the
// decorators on synchronize; Postgres (prod) gets the same shapes via
// migration 1760000000028-AddHotPathIndices.
@Entity('tickets')
@Index('idx_tickets_column_parent', ['column_id', 'parent_id'])
@Index('idx_tickets_parent', ['parent_id'])
@Index('idx_tickets_workspace', ['workspace_id'])
@Index('idx_tickets_archived', ['archived_at'])
@Index('idx_tickets_canonical', ['canonical_ticket_id'])
@Index('idx_tickets_chat_source', ['workspace_id', 'source_kind', 'source_chat_room_id'])
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('uq_tickets_operational_dedupe_open', { unique: true })
  @Column({ type: 'varchar', nullable: true, default: null })
  operational_dedupe_key: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  canonical_ticket_id: string | null;

  @Column({ type: 'varchar', default: '' })
  source_kind: string;

  @Column({ type: 'varchar', default: '' })
  source_chat_room_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  related_ticket_id: string | null;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar', nullable: true })
  column_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  parent_id: string | null;

  @Column({ type: 'int', default: 0 })
  depth: number;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'text', default: '' })
  prompt_text: string;

  @Column({ type: 'varchar', default: 'medium' })
  priority: string;

  // Abstract "effort preset" id (NOT a CLI flag). References one of the
  // board's EffortPresetsConfig.presets[].id (see common/effort-presets.ts).
  // Empty/null = use the board catalog's default preset. Dispatch resolves
  // this against the board's `effort_presets` via resolveEffortPreset and
  // ships the matched preset on the agent_trigger payload; agent-manager maps
  // it onto per-CLI options at spawn (claude --effort + ultracode keyword +
  // --model; codex/antigravity/pi model-only).
  @Column({ type: 'varchar', nullable: true, default: null })
  effort_preset: string | null;

  // Per-execution Claude backend override. null inherits Agent/Board/
  // Workspace/Global; "none" explicitly uses native Anthropic.
  @Column({ type: 'varchar', nullable: true, default: null })
  cli_runtime_profile: string | null;

  @Column({ type: 'varchar', default: '' })
  assignee: string;

  @Column({ type: 'varchar', default: '' })
  reporter: string;

  @Column({ type: 'varchar', default: '' })
  assignee_id: string;

  @Column({ type: 'varchar', default: '' })
  reporter_id: string;

  @Column({ type: 'varchar', default: '' })
  reviewer_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  locked_by_agent_id: string | null;

  @Column({ type: Date, nullable: true, default: null })
  locked_at: Date | null;

  @VersionColumn({ default: 1 })
  version: number;

  @Column({ type: 'varchar', default: '[]' })
  labels: string;

  @Column({ type: 'varchar', default: '[]' })
  channel_ids: string;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'varchar', default: 'todo' })
  status: string;

  // Repository resource the ticket builds against. Empty when the ticket is
  // pure-discussion / non-code. UI sources the picker from workspace+board
  // resources of type='repository'; the agent uses this id (plus base_branch)
  // to locate the clone URL and pull the latest before branching.
  @Column({ type: 'varchar', default: '' })
  base_repo_resource_id: string;

  // Branch the agent should treat as the base when starting work — the feature
  // branch is cut from this. Empty falls back to the repository's default
  // branch (Resource.default_branch, then origin/HEAD).
  @Column({ type: 'varchar', default: '' })
  base_branch: string;

  // Optional pointer to the next ticket the team wants picked up automatically
  // once this one finishes. When this ticket lands on a terminal column,
  // TriggerLoopService dispatches a `trigger_source: 'next_ticket'` round
  // for the linked ticket's current column's routing roles. Same-workspace +
  // no-self-link guarded at write time. Empty / null disables the chain.
  @Column({ type: 'varchar', nullable: true, default: null })
  next_ticket_id: string | null;

  // On-ticket-done Action hook — explicit per-ticket binding (ticket 16a6339c,
  // connection method "a"). JSON string array of Action ids to dispatch once
  // when this ticket lands on a terminal column. Complementary to the
  // board/label-scoped `Action.trigger='on_ticket_done'` path (method "b") —
  // OnTicketDoneActionService takes the union of both, deduped by action id.
  // Empty '[]' disables the per-ticket binding. Stored as a JSON string like
  // `labels` / `channel_ids` for SQLite/Postgres parity.
  @Column({ type: 'varchar', default: '[]' })
  on_done_action_ids: string;

  // Idempotency stamp for the on-ticket-done hook (ticket 16a6339c). Set to the
  // dispatch time the moment OnTicketDoneActionService fires the hook for this
  // ticket's CURRENT terminal entry. The service only dispatches when
  // `terminal_entered_at` is set AND (`on_done_dispatched_at` is null OR
  // `on_done_dispatched_at < terminal_entered_at`) — so each distinct terminal
  // entry fires at most once, but a ticket that leaves Done and re-enters
  // (which re-stamps `terminal_entered_at` to a newer time) fires again. The
  // claim is an atomic conditional UPDATE so concurrent 'moved' activities for
  // the same entry can't double-dispatch. Null until the hook first fires.
  @Column({ type: Date, nullable: true, default: null })
  on_done_dispatched_at: Date | null;

  // Idempotency stamp for the QA rerun-on-fix hook (ticket 467dbc7a). A SEPARATE
  // stamp from `on_done_dispatched_at` on purpose: both the OnTicketDoneAction
  // hook and QaRerunOnFixService subscribe to the same terminal-entry stream, so
  // sharing one claim column would let whichever fires first starve the other.
  // QaRerunOnFixService claims this the moment it re-runs the failed scenario for
  // a fix ticket's CURRENT terminal entry, with the same edge-claim predicate the
  // on-done hook uses (`terminal_entered_at` set AND (stamp IS NULL OR
  // stamp < terminal_entered_at)). Null until the QA rerun hook first fires.
  @Column({ type: Date, nullable: true, default: null })
  qa_rerun_dispatched_at: Date | null;

  // Cross-board handoff pipeline (ticket ac21a745). JSON string describing the
  // relay this ticket kicks off when it lands on a terminal column:
  // `{ hops: [{ target_board_id, target_column_name?, title_template?, ... }] }`
  // (see common/handoff-spec-config.ts). HandoffService pops the first hop,
  // creates a follow-up ticket on that board carrying this ticket's deliverable
  // context, and passes the REMAINING hops down to the follow-up's own
  // handoff_spec — so one spec drives a multi-board relay (기획→그래픽→클라→QA).
  // '' / '{}' = no handoff (the default). Stored as a JSON string like
  // `labels` / `on_done_action_ids` for SQLite/Postgres parity.
  @Column({ type: 'varchar', default: '' })
  handoff_spec: string;

  // Idempotency stamp for the handoff relay (ticket ac21a745). A SEPARATE stamp
  // from `on_done_dispatched_at` / `qa_rerun_dispatched_at` on purpose: all
  // three hooks subscribe to the same terminal-entry stream, so sharing one
  // claim column would let whichever fires first starve the others. HandoffService
  // claims this the moment it dispatches the relay for this ticket's CURRENT
  // terminal entry, with the same edge-claim predicate the on-done hook uses
  // (`terminal_entered_at` set AND (stamp IS NULL OR stamp < terminal_entered_at)).
  // Null until the handoff relay first fires.
  @Column({ type: Date, nullable: true, default: null })
  handoff_dispatched_at: Date | null;

  // Relay lineage back-pointer (ticket ac21a745). Set on a ticket that was
  // AUTO-CREATED as a handoff follow-up: points at the source ticket whose
  // completion produced it. Empty for tickets not born from a handoff. Powers
  // (a) reverse rejection — `reject_handoff` files the defect ticket back on the
  // source's board, and (b) the pipeline rollup — walking source→follow-up links
  // reconstructs the whole relay across boards.
  @Column({ type: 'varchar', default: '' })
  handoff_source_ticket_id: string;

  // User-intervention pending flag. When true the ticket is "parked" awaiting
  // a human decision: TriggerLoopService drops every agent_trigger for it
  // (so the agent's focus moves to another ticket), the auto-advance cascade
  // skips it, AgentWorkloadService.getFocusTicket excludes it from candidates,
  // and the UI surfaces it with a high-visibility badge plus a dedicated
  // "User" tab on the ticket detail panel. Cleared via the same `update_ticket`
  // / REST PATCH path that sets it — usually after the user answers the
  // question or splits the work into a follow-up ticket.
  @Column({ type: 'boolean', default: false })
  pending_user_action: boolean;

  // Free-text reason the agent (or user) gave when flipping pending_user_action
  // on. Rendered verbatim on the User tab so the human walking up to the
  // ticket sees "why am I being asked to step in?" without reading the comment
  // log. Empty when pending_user_action is false.
  @Column({ type: 'text', default: '' })
  pending_reason: string;

  // Timestamp pending_user_action was last flipped to true. Used by the UI to
  // show "pending for 3h" so a stale pending ticket is obvious. Null when
  // pending_user_action has never been set, or after it's cleared.
  @Column({ type: Date, nullable: true, default: null })
  pending_set_at: Date | null;

  // Display name of the actor (agent or user) that flipped the pending flag.
  // Stored as a string rather than an id because the source can be either an
  // Agent or a User row and the User tab only needs the label.
  @Column({ type: 'varchar', default: '' })
  pending_set_by: string;

  // "Blocked by another ticket" flag (ticket 48d14fff). Distinct from
  // `pending_user_action` so the UI can render two different badges and the
  // trigger loop can auto-resume the moment every prereq lands on a terminal
  // column — no human unpend needed. Maintained by TicketPrerequisitesService:
  //   - `add_ticket_prerequisites` sets it true (when at least one not-yet-
  //     terminal prereq is attached) and persists a reason if the caller
  //     supplied one.
  //   - The auto-resume sweep flips it false when every attached prereq sits
  //     on a terminal column, then dispatches the dependent's current-column
  //     role-routing via `TriggerLoopService.dispatchCurrentColumn`.
  // Combined gate `is_pending = pending_user_action || pending_on_tickets` —
  // both flags drop agent_triggers via `_emitTrigger`'s pending check, and
  // either flag keeps focus selector / backlog promotion off the ticket.
  @Column({ type: 'boolean', default: false })
  pending_on_tickets: boolean;

  // "Blocked on one external CI run" flag (ticket 778b6dc7). A THIRD pending
  // flavor alongside `pending_user_action` (human) and `pending_on_tickets`
  // (another ticket) — registered by the `await_ci_run` MCP tool, typically
  // from the Merging workflow's pre-landing `workflow_dispatch` check. The
  // assignee registers the wait and ends the turn; CiWaitResumeService polls
  // the recorded run server-side and auto-resumes the ticket (re-dispatches
  // its current-column role holders) the instant the run reaches a terminal
  // conclusion, or after a bounded timeout if it never resolves — no session
  // has to stay alive across the run. That "stay alive across a long
  // external wait" shape is exactly what repeatedly killed sessions mid-wait
  // (ScheduleWakeup misuse, clean exits) and is what this flag exists to
  // remove. Checked everywhere `pending_on_tickets` is checked (trigger gate,
  // focus selector, allocation, backlog promotion, dispatch reconciler,
  // stuck detector) — see those call sites for the exact parity.
  @Column({ type: 'boolean', default: false })
  pending_ci_wait: boolean;

  // JSON context for the active CI wait: {owner, repo, run_id, head_sha,
  // html_url, registered_by, registered_at}. Empty string when
  // pending_ci_wait is false. Written by `await_ci_run` (CiWaitService),
  // read by CiWaitResumeService's sweep to know which run to poll, cleared
  // by `cancel_ci_wait` or by the sweep's atomic claim once the wait
  // resolves (success/failure/timeout). Stored as a JSON string like
  // `handoff_spec` rather than a JSON-array column like `labels` — this is
  // always at most one object, never a list.
  @Column({ type: 'text', default: '' })
  ci_wait_context: string;

  // "저장소 랜딩 lease 대기" 플래그 (ticket e630b530). `pending_user_action`
  // (사람) / `pending_on_tickets`(다른 티켓) / `pending_ci_wait`(외부 CI run)
  // 에 이은 **네 번째** pending flavor — 같은 저장소의 다른 티켓이 랜딩 구간을
  // 점유하고 있어 이 티켓의 Merging 진행을 미룬 상태다. `await_merge_lease`
  // MCP 툴이 세우고, MergeLeaseService 의 스윕이 FIFO 순서로 lease 를 부여하며
  // 내린 뒤 현재 컬럼 role holder 를 재디스패치한다.
  //
  // 이 플래그는 무한정 유지되지 않는다: 대기 상한(기본 45분)을 넘기면 스윕이
  // **fail-open** 으로 플래그를 내리고 lease 없이 진행시킨다 — 기아가 아니라
  // "오늘 동작으로 회귀" 가 최악의 결과가 되도록.
  //
  // `pending_on_tickets` 가 검사되는 모든 곳(트리거 게이트, focus selector,
  // allocation, backlog promotion, dispatch reconciler, stuck detector)에서
  // 함께 검사된다 — 정확한 parity 는 그 호출부들 참고.
  @Column({ type: 'boolean', default: false })
  pending_merge_lease: boolean;

  // 활성 lease 대기의 JSON 컨텍스트: {lease_id, repo_resource_id, base_branch,
  // queued_at, requested_by, ahead_ticket_id}. pending_merge_lease 가 false 면
  // 빈 문자열. `ci_wait_context` 와 같은 이유로 JSON-배열 컬럼이 아니라 JSON
  // 문자열이다 — 항상 최대 한 객체이지 목록이 아니다.
  @Column({ type: 'text', default: '' })
  merge_lease_context: string;

  // 이 티켓의 **랜딩 에피소드** 단위 재검증 시도 횟수 (ticket e630b530, 리뷰 2R).
  //
  // 원래는 이 카운터가 MergeLease 행 위에 있었는데, 그러면 대기 상한 초과로
  // fail-open 하며 행이 released 되는 순간 예산이 함께 사라졌다 — 이후
  // `await_merge_lease` 를 다시 부르면 새 행 + 새 예산이 생겨 "유한하게
  // 랜딩하거나 명시적으로 실패한다" 는 보장이 무너졌다. lease 행은 경합에 따라
  // 몇 번이든 생겼다 사라지지만 **랜딩 에피소드는 티켓 하나**이므로, 카운터의
  // 올바른 수명은 lease 가 아니라 티켓이다.
  //
  // 증가 시점: 에이전트가 실제로 진행 허가를 받은 순간(`granted` 또는 lease
  // 없이 진행하는 `degraded`). `queued` 는 CI 를 돌리지 않고 턴을 끝내므로
  // 세지 않는다. 보드가 기능을 끈 경우(`board_disabled`)도 세지 않는다 —
  // 킬 스위치는 기능 도입 이전 동작으로 완전히 되돌린다는 뜻이다.
  //
  // 리셋 시점: Merging 을 떠날 때(Done 랜딩 / 바운스 / 다른 컬럼)뿐이다.
  // 리퍼의 lease 회수나 pend 차단은 같은 에피소드가 계속되는 것이므로 리셋하지
  // 않는다.
  @Column({ type: 'int', default: 0 })
  merge_landing_attempts: number;

  // 이 랜딩 에피소드가 이미 **lease 없이 진행**하기로 확정됐는가 (ticket
  // e630b530, 리뷰 2R). 대기 상한을 넘겨 fail-open 된 순간 켜진다.
  //
  // 왜 sticky 여야 하는가: 이 플래그가 없으면 fail-open 직후 에이전트가
  // `await_merge_lease` 를 다시 부를 때 스코프가 여전히 붐비므로 **다시
  // 큐에 들어가** 파킹된다 — 방금 내린 fail-open 결정이 즉시 무효화되고,
  // "대기 → 상한 → fail-open → 재대기" 가 무한히 돌면서 예산은 한 칸도
  // 쓰이지 않는다(진행 허가를 받은 적이 없으므로). 에피소드 단위로 붙여야
  // 매 사이클이 degraded 로 통과하며 예산을 쓰고, 결국 명시적 실패로 닫힌다.
  //
  // `merge_landing_attempts` 와 정확히 같은 수명 — Merging 을 떠날 때만
  // 리셋된다.
  @Column({ type: 'boolean', default: false })
  merge_lease_degraded: boolean;

  // Soft-archive timestamp for the ticket. When non-null the ticket is
  // considered archived: excluded from board GET / SSE payloads / supervisor
  // re-push / backlog promotion / focus selector by default, mutation paths
  // (move / update / add_comment / claim) reject with 409 ticket_archived,
  // and only the dedicated archive endpoints + delete remain. Cleared by
  // unarchive (which also resets terminal_entered_at so the ticket isn't
  // immediately re-eaten by the archiver tick).
  @Column({ type: Date, nullable: true, default: null })
  archived_at: Date | null;

  // Timestamp the ticket entered its current terminal column (kind='terminal'
  // or is_terminal=true). Written by move_ticket / REST PATCH-move when the
  // destination column is terminal; nulled on any move out of terminal and on
  // unarchive. TicketArchiverService treats this as one of the ticket's
  // activity signals: it archives only when the ticket has been idle for the
  // full window, i.e. GREATEST(terminal_entered_at, updated_at, newest
  // comment.created_at) <= now - auto_archive_days. A still-commented or
  // still-edited Done ticket therefore keeps resetting its archive clock.
  // Empty for tickets that haven't touched a terminal column.
  @Column({ type: Date, nullable: true, default: null })
  terminal_entered_at: Date | null;

  // Claim-verification snapshot (ticket dcb9d661). Written by
  // TriggerLoopService when an assignee trigger lands on an active column
  // and the workspace has `claim_verification_enabled=1`. Records the
  // remote branch tip the agent is being woken on top of. The sweep in
  // ClaimVerificationService compares this against the latest assignee
  // comment to enrich the pend-reason with concrete "branch unchanged"
  // evidence. Best-effort: an empty string means the GitHub lookup
  // failed (no credential, network, etc.) and the sweep falls back to
  // ActivityLog-only gating. Cleared along with snapshot_at on any
  // column move (move_ticket / REST move).
  @Column({ type: 'varchar', default: '' })
  branch_tip_sha_at_trigger: string;

  // Timestamp `branch_tip_sha_at_trigger` was written. Used by the sweep
  // to confirm the SHA snapshot was taken BEFORE the assignee's claim
  // comment — a snapshot taken after the comment is stale evidence and
  // gets ignored.
  @Column({ type: Date, nullable: true, default: null })
  branch_tip_snapshot_at: Date | null;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @Column({ type: 'varchar', default: '' })
  created_by_type: string; // 'user' | 'agent'

  @Column({ type: 'varchar', default: '' })
  created_by_id: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => BoardColumn, col => col.tickets, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'column_id' })
  column: BoardColumn;

  @ManyToOne(() => Ticket, ticket => ticket.children, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: Ticket | null;

  @OneToMany(() => Ticket, ticket => ticket.parent, { cascade: true })
  children: Ticket[];

  @OneToMany(() => Comment, comment => comment.ticket, { cascade: true })
  comments: Comment[];
}
