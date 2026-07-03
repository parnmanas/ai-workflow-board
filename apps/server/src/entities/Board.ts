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

  // Per-board abstract "effort preset" catalog (ticket-level effort option).
  // JSON text of EffortPresetsConfig (see common/effort-presets.ts):
  // { default: <preset id>, presets: [{ id, label, claude?, codex?,
  // antigravity? }] }. A Ticket carries an ABSTRACT preset id (Ticket.
  // effort_preset); dispatch resolves it against this catalog via
  // resolveEffortPreset and ships the matched preset on the agent_trigger
  // payload, where agent-manager maps it onto per-CLI options (claude
  // --effort + the "ultracode" prompt keyword + --model; codex/antigravity
  // model-only). null = no stored catalog → the built-in catalog
  // (BUILTIN_EFFORT_PRESETS) is used.
  @Column({ type: 'text', nullable: true, default: null })
  effort_presets: string | null;

  // Per-board environment setup override (ticket 354d336b). JSON text of
  // EnvironmentConfig (see common/environment-config.ts): { repositories?,
  // env_vars?, setup_commands?, setup_timeout_seconds?, version? }. Resolved
  // against the workspace-level default via mergeEnvironmentConfig — board
  // keys override per top-level key, unset keys inherit. At dispatch
  // TriggerLoopService expands each repository's resource_id into a concrete
  // url/branch and ships the resolved config on the agent_trigger SSE payload;
  // agent-manager provisions the environment (clone/update repos, run setup
  // commands, inject env_vars, fingerprint marker) just before spawning the
  // subagent. null = no override (and with the workspace also null, dispatch
  // behaves exactly as before — no provisioning step).
  @Column({ type: 'text', nullable: true, default: null })
  environment_config: string | null;

  // Per-board merge/integration gate (ticket c806bad3). JSON text of
  // MergeGateConfig (see common/merge-gate-config.ts): { enabled?,
  // require_fresh_base?, require_full_merge? }. When a board opts in the
  // server mechanically verifies git invariants on the Merging column
  // boundary — Review→Merging is blocked when the ticket's feature branch is
  // BEHIND base (stale-base), Merging→Done is blocked when the feature branch
  // is not fully merged into base (partial-merge). null/disabled = no gate →
  // existing prompt-driven behaviour, no regression. The check degrades to a
  // pass (never blocks) when the repo/branch can't be resolved
  // (availability-first, same posture as the consensus gate's try/catch).
  @Column({ type: 'text', nullable: true, default: null })
  merge_gate_config: string | null;

  // Per-board output language (i18n, ticket ae28dcaf). A human-readable
  // language name (e.g. "Korean", "English", "日本語") that rides the existing
  // harness plumbing: at dispatch TriggerLoopService appends a "Respond in
  // <language>…" instruction onto harness_config.system_prompt_append, which
  // flows server→SSE→agent-manager→CLI --append-system-prompt. So every role's
  // subagent writes comments / chat / commit messages / code comments in this
  // language. null/empty = no override → agent default (English), behaviour
  // unchanged. A single varchar suffices (unlike harness/effort which are JSON).
  @Column({ type: 'varchar', nullable: true, default: null })
  language: string | null;

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

  // Per-board QaRun liveness policy (board-pluggable reaper, ticket 40010b25).
  // JSON text of a LivenessPolicy descriptor (see modules/qa/qa-liveness-policy.ts):
  //   { "type": "zero_progress", "deadline_sec"?: number }   (the default behavior)
  //   { "type": "heartbeat_deadline", "deadline_sec": number } (monotonic token must
  //                                                             advance within deadline)
  // The QaRunReaperService resolves this per run (scenario-level liveness_policy
  // overrides board-level, which overrides the built-in `zero_progress` default).
  // null = no override → every existing board keeps the exact pre-existing
  // zero_progress reap behavior (TTL age gate), so this is opt-in / regression-safe.
  // A new board "death signal" is added by registering a detector type in the
  // policy registry — the reaper core never changes.
  @Column({ type: 'text', nullable: true, default: null })
  liveness_policy: string | null;

  // Per-board QA phase model (multi-phase QA, ticket 90cc22f7). JSON text of a
  // QaPhasesConfig (see modules/qa/qa-phases.ts):
  //   { "phases": [ { "id": "import", "label": "Import", "timeout_sec": 600 },
  //                 { "id": "build",  "label": "Build",  "timeout_sec": 1800 } ] }
  // Array order = phase order. When set (and no explicit liveness_policy overrides
  // it), the reaper auto-selects the `phase_timeouts` detector so each phase is
  // judged against its own timeout_sec from current_phase_at. A scenario-level
  // qa_phases overrides this (resolveQaPhases). null = no phase model → legacy
  // single-running behavior (zero_progress / heartbeat_deadline unchanged), so
  // this is opt-in / regression-safe. Validated with fail-safe parse — a malformed
  // config falls back to null and never breaks the reaper sweep.
  @Column({ type: 'text', nullable: true, default: null })
  qa_phases: string | null;

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
