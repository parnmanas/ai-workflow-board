import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, VersionColumn, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { Comment } from './Comment';
import type { TicketStatus } from '../common/ticket-status';

// A ticket lives in one workspace pool, classified by `tags` and an optional
// `project_id`, and is worked end-to-end by ONE assignee agent (docs/tickets.md).
// Indexes cover the hot reads: the Tickets page lists root tickets by
// (workspace_id, status), child lookups filter by parent_id, the dispatcher
// scans in_progress/todo per workspace, the archiver filters archived_at.
@Entity('tickets')
@Index('idx_tickets_ws_status', ['workspace_id', 'status'])
@Index('idx_tickets_parent', ['parent_id'])
@Index('idx_tickets_project', ['project_id'])
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

  // The one agent that does this ticket (RuntimeSpec, common/runtime-spec.ts).
  // null = unassigned — never dispatched. Identity for capacity/"my tickets"
  // is runtimeIdentityKey(assignee), denormalized into `assignee_key`.
  @Column({ type: 'simple-json', nullable: true, default: null })
  assignee: Record<string, any> | null;

  @Index('idx_tickets_assignee_key')
  @Column({ type: 'varchar', default: '' })
  assignee_key: string;

  @VersionColumn({ default: 1 })
  version: number;

  // JSON string array — free-form classification (kind, area, old board
  // name, …). The Tickets page filters on these (AND semantics).
  @Column({ type: 'varchar', default: '[]' })
  tags: string;

  @Column({ type: 'varchar', default: '[]' })
  channel_ids: string;

  @Column({ type: 'int', default: 0 })
  position: number;

  // Fixed lifecycle (common/ticket-status.ts): backlog → todo → in_progress →
  // review → done. Replaces board columns.
  @Column({ type: 'varchar', default: 'todo' })
  status: TicketStatus;

  // Project (repository) the work is about. null = not about a repo.
  @Column({ type: 'varchar', nullable: true, default: null })
  project_id: string | null;

  // Branch the work starts from. Empty falls back to the project's
  // default_branch, then origin/HEAD.
  @Column({ type: 'varchar', default: '' })
  base_branch: string;

  // Dispatcher bookkeeping (TicketDispatchService). `last_dispatched_at` is the
  // last agent_trigger sent for this ticket; `supervisor_redispatches` counts
  // supervisor re-sends since the last real progress (comment/move by the
  // agent) and bounds a dead-agent loop before the ticket is pended.
  @Column({ type: Date, nullable: true, default: null })
  last_dispatched_at: Date | null;

  @Column({ type: 'int', default: 0 })
  supervisor_redispatches: number;

  // Optional pointer to the next ticket to pick up once this one is done. When
  // this ticket enters `done`, TicketDispatchService moves a backlog next
  // ticket to `todo` (and so queues it for its assignee). Same-workspace +
  // no-self-link guarded at write time. Empty / null disables the chain.
  @Column({ type: 'varchar', nullable: true, default: null })
  next_ticket_id: string | null;

  // On-ticket-done Action hook — explicit per-ticket binding (ticket 16a6339c,
  // connection method "a"). JSON string array of Action ids to dispatch once
  // when this ticket enters `done`. Complementary to the
  // label-scoped `Action.trigger='on_ticket_done'` path (method "b") —
  // OnTicketDoneActionService takes the union of both, deduped by action id.
  // Empty '[]' disables the per-ticket binding. Stored as a JSON string like
  // `tags` / `channel_ids` for SQLite/Postgres parity.
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

  // User-intervention pending flag. When true the ticket is "parked" awaiting
  // a human decision: TicketDispatchService sends no agent_trigger for it and
  // it releases its assignee's capacity slot, and the UI surfaces it with a high-visibility badge plus a dedicated
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
  // dispatcher can auto-resume the moment every prereq is `done` — no human
  // unpend needed. Maintained by TicketPrerequisitesService:
  //   - `add_ticket_prerequisites` sets it true (when at least one not-yet-
  //     terminal prereq is attached) and persists a reason if the caller
  //     supplied one.
  //   - The auto-resume sweep flips it false when every attached prereq is
  //     `done`, then re-dispatches the dependent's assignee.
  // Any pending flag blocks dispatch (common/ticket-status.ts isTicketPending).
  @Column({ type: 'boolean', default: false })
  pending_on_tickets: boolean;

  // "Blocked on one external CI run" flag (ticket 778b6dc7). A THIRD pending
  // flavor alongside `pending_user_action` (human) and `pending_on_tickets`
  // (another ticket) — registered by the `await_ci_run` MCP tool, typically
  // from the Merging workflow's pre-landing `workflow_dispatch` check. The
  // assignee registers the wait and ends the turn; CiWaitResumeService polls
  // the recorded run server-side and auto-resumes the ticket (re-dispatches
  // its assignee) the instant the run reaches a terminal
  // conclusion, or after a bounded timeout if it never resolves — no session
  // has to stay alive across the run. That "stay alive across a long
  // external wait" shape is exactly what repeatedly killed sessions mid-wait
  // (ScheduleWakeup misuse, clean exits) and is what this flag exists to
  // remove. Checked everywhere `pending_on_tickets` is checked.
  @Column({ type: 'boolean', default: false })
  pending_ci_wait: boolean;

  // JSON context for the active CI wait: {owner, repo, run_id, head_sha,
  // html_url, registered_by, registered_at}. Empty string when
  // pending_ci_wait is false. Written by `await_ci_run` (CiWaitService),
  // read by CiWaitResumeService's sweep to know which run to poll, cleared
  // by `cancel_ci_wait` or by the sweep's atomic claim once the wait
  // resolves (success/failure/timeout). Stored as a JSON string rather than
  // a JSON-array column like `tags` — this is
  // always at most one object, never a list.
  @Column({ type: 'text', default: '' })
  ci_wait_context: string;

  // Soft-archive timestamp for the ticket. When non-null the ticket is
  // considered archived: excluded from the ticket list / dispatch by default, mutation paths
  // (move / update / add_comment / claim) reject with 409 ticket_archived,
  // and only the dedicated archive endpoints + delete remain. Cleared by
  // unarchive (which also resets terminal_entered_at so the ticket isn't
  // immediately re-eaten by the archiver tick).
  @Column({ type: Date, nullable: true, default: null })
  archived_at: Date | null;

  // Timestamp the ticket entered `done`. Written on every move into `done`;
  // nulled on any move out of it and on unarchive. TicketArchiverService treats this as one of the ticket's
  // activity signals: it archives only when the ticket has been idle for the
  // full window, i.e. GREATEST(terminal_entered_at, updated_at, newest
  // comment.created_at) <= now - auto_archive_days. A still-commented or
  // still-edited Done ticket therefore keeps resetting its archive clock.
  // Empty for tickets that haven't been done.
  @Column({ type: Date, nullable: true, default: null })
  terminal_entered_at: Date | null;

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

  @ManyToOne(() => Ticket, ticket => ticket.children, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: Ticket | null;

  @OneToMany(() => Ticket, ticket => ticket.parent, { cascade: true })
  children: Ticket[];

  @OneToMany(() => Comment, comment => comment.ticket, { cascade: true })
  comments: Comment[];
}
