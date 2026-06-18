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
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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
  // --model; codex/antigravity model-only).
  @Column({ type: 'varchar', nullable: true, default: null })
  effort_preset: string | null;

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
