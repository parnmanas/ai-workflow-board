import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * QaScenario — a reusable, step-based QA scenario definition.
 *
 * Mirrors the `Action` entity (workspace/board scope + target_agent_id +
 * max_runs FIFO budget) but adds the scenario-specific pieces: an ordered
 * `steps[]` array (the source of the visualizer), a `qa_driver` selector and
 * its `qa_driver_config`, plus `tags`.
 *
 * JSON columns use TypeORM `simple-json` so they serialize/deserialize
 * automatically (same pattern as Agent.role_prompt_meta). A fresh entity gets
 * this for free — no manual parse/stringify touch points like the Ticket
 * JSON-string columns require. Reads still coalesce null → [] in the JSON
 * projection (qaScenarioToJson) so older rows render cleanly.
 */
@Entity('qa_scenarios')
export class QaScenario {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // null = workspace-scoped (applies to any board); <uuid> = pinned to a board.
  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  // Ordered step definitions — each { idx, action, expect, mcp_tool?, params? }.
  // This is what the UI renders as the step flow / stepper.
  @Column({ type: 'simple-json', nullable: true, default: null })
  steps: QaScenarioStep[] | null;

  // The QA agent that runs this scenario (dispatched via ChatRoom, like Action).
  @Column({ type: 'varchar' })
  target_agent_id: string;

  // Which driver/MCP set validates the feature, e.g. 'browser', 'game-client',
  // 'http-api'. Free-text so new drivers don't require a schema change.
  @Column({ type: 'varchar', default: '' })
  qa_driver: string;

  // Driver-specific config (start URL, executable/window title, base endpoint…).
  @Column({ type: 'simple-json', nullable: true, default: null })
  qa_driver_config: Record<string, any> | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'simple-json', nullable: true, default: null })
  tags: string[] | null;

  // On-failure auto-ticket policy. When `enabled`, a failed/errored QaRun of
  // this scenario auto-files a fix ticket (see QaFailureTicketService). null /
  // enabled=false = no side-effect (the historic behaviour). simple-json so it
  // serializes automatically; the MCP/REST create+update paths and
  // qaScenarioToJson must still pass it through explicitly.
  @Column({ type: 'simple-json', nullable: true, default: null })
  on_failure_ticket: QaOnFailureTicketConfig | null;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  // FIFO Run budget — keep at most this many QaRun rooms per scenario.
  @Column({ type: 'int', default: 20 })
  max_runs: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

export interface QaScenarioStep {
  idx: number;
  action: string;
  expect?: string;
  mcp_tool?: string;
  params?: Record<string, any>;
}

/**
 * On-failure auto-ticket config for a QaScenario.
 *
 * When `enabled`, a QaRun that finalizes as `failed` or `error` files a fix
 * ticket carrying the failure evidence (failed steps + logs + artifact links).
 * Every field except `enabled` is optional and resolved with a fallback chain
 * in QaFailureTicketService:
 *   - board_id    → run.board_id → scenario.board_id
 *   - column_name → "To Do" → the board's first non-terminal column
 *   - priority    → "high"
 *   - assignee_id → scenario.target_agent_id (also reporter/reviewer)
 *   - labels      → ['qa-failure','auto']
 *   - dedupe      → 'per_run'
 */
export interface QaOnFailureTicketConfig {
  enabled: boolean;
  board_id?: string;
  column_name?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assignee_id?: string;
  labels?: string[];
  // 'per_run'        — one ticket per failed run (default; the run_id idempotency
  //                    guard already prevents a re-finalize from double-filing).
  // 'per_open_ticket'— if an open qa-failure ticket for this scenario already
  //                    exists, append a recurrence comment instead of filing a
  //                    new one.
  dedupe?: 'per_run' | 'per_open_ticket';
  // Optional title override. `{{scenario.name}}` is substituted. Default
  // 'QA 실패: {{scenario.name}}'.
  title_template?: string;

  // ── QA → fix → QA closed-loop (ticket 467dbc7a) ──────────────────────────
  // Opt-in: when true, a fix ticket auto-filed by this policy that later reaches
  // a terminal (Done) column triggers QaRerunOnFixService to deterministically
  // re-run the SAME scenario (server-side startQaRun — no agent prompt parsing).
  // Default false (historic behaviour: filing the ticket is the end of the
  // loop). The rerun is strictly scoped to tickets carrying this policy's
  // markers (`qa-failure` + `auto` + `qa-scenario:<id>`), so a human accidentally
  // labelling a ticket can't trigger a run.
  rerun_on_fix?: boolean;
  // Convergence guard: the maximum number of automatic reruns before the loop
  // halts and posts a "human intervention needed" comment instead of re-running.
  // Counted via a `qa-rerun:<n>` generation label threaded fix-ticket → run →
  // next fix-ticket. Default 3. <= 0 disables reruns (treated like opt-out).
  max_rerun_attempts?: number;
  // Deployment-timing gate (see docs/qa-rerun-on-fix.md "Deployment timing").
  // QA scenarios hit the RUNNING AWB server, which auto-deploys from
  // `production.private` AFTER main merges — so an instant rerun can validate the
  // pre-fix code. This delays the rerun by N seconds (best-effort, in-process;
  // not durable across a server restart) so a deploy can land first. Default 0
  // (immediate). Set to your typical main→prod deploy lag to make Done≈deployed.
  rerun_delay_seconds?: number;
}
