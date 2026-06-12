import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BoardColumn } from './BoardColumn';
import { Workspace } from './Workspace';

// workspace_id is filtered on every board listing (workspaces.controller,
// backlog-promotion, focus selector) but was unindexed — perf ticket b3812637.
@Entity('boards')
@Index('idx_boards_workspace', ['workspace_id'])
export class Board {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true })
  workspace_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar', default: '{}' })
  routing_config: string;  // JSON: { [columnName: string]: string[] }  e.g. { "review": ["assignee","reviewer"] }
                           // Keyed by lowercase column name. Each value is an array of roles to notify.

  @Column({ type: 'text', nullable: true, default: null })
  column_prompts: string | null;  // JSON: { [columnId: string]: promptTemplateId: string }
                                  // Keyed by BoardColumn.id. Template content is attached to agent_trigger SSE events
                                  // when a ticket moves into the mapped column.

  // Per-board agent harness override (ticket 7122600c). JSON text of
  // HarnessConfig (see common/harness-config.ts): { system_prompt_append?,
  // allowed_tools?, disallowed_tools?, model?, permission_mode? }. Resolved
  // against the workspace-level default via resolveHarnessConfig — board
  // keys override per key, unset keys inherit. null = no override (and with
  // the workspace also null, dispatch behaves exactly as before).
  @Column({ type: 'text', nullable: true, default: null })
  harness_config: string | null;

  // Per-board cap on how many distinct tickets a single agent can be
  // actively working on at once. Default 1 — same agent assigned to
  // multiple tickets would otherwise have parallel subagents stomping on
  // the same working_dir (git index, build artefacts, etc.). Tighter
  // boards bumping this to 2+ trade local-repo safety for throughput;
  // loose boards (e.g. read-only review queues) can set it higher
  // freely. Server-side trigger emission and manager-side dispatch
  // both honor this — server skips out-of-cap triggers with an activity
  // log entry, manager keeps a defensive drop in case two triggers
  // raced past the server gate.
  @Column({ type: 'int', default: 1 })
  max_concurrent_tickets_per_agent: number;

  // Auto-archive policy for Done-column tickets on this board. When non-null,
  // TicketArchiverService archives tickets whose terminal_entered_at is older
  // than `auto_archive_days` days. null = disabled (the default — opt-in only).
  // Server-side validation enforces null or 1..365 so an operator can't write
  // a 0/negative/365+ value that would either archive everything immediately
  // or never. Single-column representation (vs the spec's enabled+days pair)
  // makes enabled-without-days an impossible state and mirrors the existing
  // nullable-marker convention (paused_at, archived_at).
  @Column({ type: 'int', nullable: true, default: null })
  auto_archive_days: number | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @Column({ type: Date, nullable: true, default: null })
  archived_at: Date | null;

  // Board-wide soft pause. When non-null, every trigger emission for tickets
  // on this board is dropped (TriggerLoopService._emitTrigger checks this as
  // the first gate, covering activity-driven, supervisor, backlog-promotion,
  // and manual paths since they all funnel through that single chokepoint).
  // BacklogPromotionService.tryPromote also short-circuits so paused boards
  // don't silently shuffle tickets out of intake. The board UI still works
  // — humans can read, comment, drag tickets — only agent wake-ups stop.
  // Resume by clearing back to null. Mirrors the archived_at soft-flag
  // pattern: nullable timestamp, ISO date = paused-since.
  @Column({ type: Date, nullable: true, default: null })
  paused_at: Date | null;

  // Per-board self-improvement mode. When a ticket on this board lands on a
  // terminal column, TriggerLoopService inspects this field to decide whether
  // to dispatch a `trigger_source: 'ticket_done_review'` round to the
  // reviewer asking them to analyze the finished ticket and (optionally) file
  // a follow-up improvement ticket. Modes:
  //   - 'off'         (default) — no post-done dispatch
  //   - 'same_board'  — reviewer files improvements as new tickets on this
  //                     board's first non-terminal column
  //   - 'remote_awb'  — reviewer files improvements against the AWB instance
  //                     configured in admin SystemSetting (`self_improvement.*`)
  //   - 'both'        — reviewer may file in either target
  // Recursion guard: tickets already labeled `self-improvement` are skipped
  // even when this is non-off, so an improvement ticket landing on Done does
  // not spawn another improvement ticket.
  @Column({ type: 'varchar', default: 'off' })
  self_improvement_mode: string;

  // Per-board benchmark mode. Kept deliberately lightweight (a flag, not a new
  // board-type system) — mirrors `self_improvement_mode` above. When 'on', the
  // board hosts benchmark runs: a run is a parent ticket holding the task, its
  // candidate children are worked by distinct agents in isolated worktrees, and
  // when a candidate lands on a `review`-kind column TriggerLoopService wakes
  // the run's evaluator agents to score it (see _dispatchBenchmarkEvaluators).
  // The client renders the leaderboard panel only when this is 'on'. Modes:
  //   - 'off' (default) — ordinary board, no benchmark behavior
  //   - 'on'            — benchmark board: evaluator dispatch + leaderboard view
  @Column({ type: 'varchar', default: 'off' })
  benchmark_mode: string;

  @ManyToOne(() => Workspace, ws => ws.boards, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  @OneToMany(() => BoardColumn, col => col.board, { cascade: true, eager: true })
  columns: BoardColumn[];
}
