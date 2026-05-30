import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

// User-defined "Action": a saved prompt addressed to a target Agent. When a
// user (or scheduler) runs the action, AWB creates a fresh ChatRoom and posts
// the rendered prompt as the user's first message. The agent's reply lands in
// the room via the existing chat_room_message SSE flow — no new event type is
// needed because Run-as-chat-room reuses the room infrastructure verbatim.
//
// Scoping mirrors Resource: workspace_id is required, board_id is nullable
// (NULL = workspace-level). Sidebar surfaces both tiers separately.
@Entity('actions')
export class Action {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  // The prompt template that gets rendered with `{{var}}` substitutions and
  // sent to the target agent on each Run.
  @Column({ type: 'text', default: '' })
  prompt: string;

  // Required: which agent receives the rendered prompt on every Run. Per the
  // ticket-locked decision (Q1=a) Actions are pinned to one agent at create
  // time; the "pick agent at run time" alternative was rejected.
  @Column({ type: 'varchar' })
  target_agent_id: string;

  // Optional cron-style schedule. Empty string = manual-only. Format: a
  // simple subset (minute hour dom month dow with `*` and integer values).
  // The scheduler service polls every minute and dispatches Runs whose next
  // computed tick is due.
  @Column({ type: 'varchar', default: '' })
  schedule_cron: string;

  // Lifecycle trigger (ticket 16a6339c). Empty string = the legacy
  // cron/manual-only Action. `'on_ticket_done'` opts the Action into the
  // on-ticket-done hook: when a ticket lands on a terminal column (Done),
  // OnTicketDoneActionService dispatches a Run with the completed ticket as
  // context. Scope of "which finished tickets fire this Action" is the pair
  // (board_id, trigger_label):
  //   - board_id (the existing column) NULL → any board in the workspace;
  //     <uuid> → only tickets whose terminal column belongs to that board.
  //   - trigger_label empty → any label; non-empty → the finished ticket must
  //     carry that label.
  // `enabled=false` still skips the hook (manual run_action only) — same rule
  // the scheduler already honours.
  @Column({ type: 'varchar', default: '' })
  trigger: string;

  // Label-scope filter for `trigger='on_ticket_done'` (ticket 16a6339c). Empty
  // = no label requirement (board-wide). Non-empty = the finished ticket's
  // `labels` JSON array must include this exact string for the hook to fire.
  // Ignored when `trigger` is not 'on_ticket_done'.
  @Column({ type: 'varchar', default: '' })
  trigger_label: string;

  // Disable a recurring action without deleting it. Manual `run_action` calls
  // still work even when this is false — disabled only blocks the scheduler.
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // FIFO-prune budget: how many rooms (Runs) to keep per action. When a new
  // Run is dispatched and the count exceeds this, the oldest rooms (by
  // created_at) are deleted. Default 10 per ticket-locked decision (Q2=b).
  @Column({ type: 'int', default: 10 })
  max_runs: number;

  // Bookkeeping for the scheduler so it doesn't double-fire across restarts.
  @Column({ type: Date, nullable: true, default: null })
  last_run_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
