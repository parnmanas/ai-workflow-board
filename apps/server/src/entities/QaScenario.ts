import { runtimeIdentityKey, parseRuntimeSpec } from '../common/runtime-spec';
import { AfterLoad, BeforeInsert, BeforeUpdate, Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { CheckoutMode, BuildMode, WorkspaceFolderRepoRef } from '../common/workspace-folder-options';

/**
 * QaScenario — a reusable, step-based QA scenario definition.
 *
 * Mirrors the `Action` entity (workspace scope + target_agent_id +
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
  @AfterLoad()
  @BeforeInsert()
  @BeforeUpdate()
  refreshRuntimeIdentity(): void {
    const spec = parseRuntimeSpec(this.target_runtime);
    this.target_agent_id = spec ? runtimeIdentityKey(spec) : '';
  }

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  // Ordered step definitions — each { idx, action, expect, mcp_tool?, params? }.
  // This is what the UI renders as the step flow / stepper.
  @Column({ type: 'simple-json', nullable: true, default: null })
  steps: QaScenarioStep[] | null;

  // The QA agent that runs this scenario (dispatched via ChatRoom, like Action).
  /** Computed dispatch keys. Runtime specs below are the persisted source of truth. */
  target_agent_id: string = '';

  @Column({ type: 'simple-json', nullable: true, default: null })
  target_runtime: Record<string, any> | null;

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

  // ── Working-folder options (QA/security workspace-folder feature, ticket 4c49f567) ──
  // Shared, identical field set with SecurityProfile. See
  // common/workspace-folder-options.ts for the types + the cold/warm decision.

  // working_dir-relative run folder under `.awb/qa/` (worktree 규약 ③). '' =
  // unset → deterministic default `.awb/qa/<scenario8>` resolved at prompt
  // render (resolveWorkspaceFolder).
  @Column({ type: 'varchar', default: '' })
  workspace_folder: string;

  // Repo to run against (`project_id` or a raw `url`). null = no repo — the
  // run folder is only created, nothing is cloned. simple-json (serializes
  // automatically); the create/update/projection paths still pass it through
  // explicitly.
  @Column({ type: 'simple-json', nullable: true, default: null })
  repo_ref: WorkspaceFolderRepoRef | null;

  // Build & Artifact Registry target (ticket 80d52250). Free-text platform/config
  // selector (e.g. `windows/Development`) that keys artifacts in the registry and
  // is rendered into the run prompt's "check the registry before you build" block.
  // '' = unset → the prompt falls back to `qa_driver` so the artifact share key
  // still stays stable per scenario. See common/build-artifact-options.ts.
  @Column({ type: 'varchar', default: '' })
  build_target: string;

  // How the working folder is prepared before a run. 'fresh' → wipe + re-checkout
  // (always cold). default 'reuse'.
  @Column({ type: 'varchar', default: 'reuse' })
  checkout_mode: CheckoutMode;

  // Build strategy across runs. default 'cold_then_warm' (cold until the first
  // recorded successful build, then warm).
  @Column({ type: 'varchar', default: 'cold_then_warm' })
  build_mode: BuildMode;

  // cold/warm state — the server is the authority (no agent-side marker). The
  // HEAD SHA of the most recent successful build; null until first built.
  // Advanced by the provisioner (ticket 4). Read by decideRunFreshness.
  @Column({ type: 'varchar', nullable: true, default: null })
  last_built_commit: string | null;

  // Timestamp of the most recent successful build (companion to
  // last_built_commit). null until first built.
  @Column({ type: Date, nullable: true, default: null })
  built_at: Date | null;

  // FIFO Run budget — keep at most this many QaRun rooms per scenario.
  @Column({ type: 'int', default: 20 })
  max_runs: number;

  // Per-scenario QaRun liveness policy (ticket 40010b25) — a LivenessPolicy
  // descriptor JSON. null = the built-in `zero_progress` default. Lets a
  // scenario opt into `heartbeat_deadline` (see qa-liveness-policy.ts).
  @Column({ type: 'text', nullable: true, default: null })
  liveness_policy: string | null;

  // Per-scenario QA phase model (multi-phase QA, ticket 90cc22f7) — a
  // QaPhasesConfig JSON. Lets a scenario define its own import→build→run stages
  // with their own timeouts. null = legacy single `running` phase. See
  // resolveQaPhases in modules/qa/qa-phases.ts (mirrors resolveLivenessPolicy).
  @Column({ type: 'text', nullable: true, default: null })
  qa_phases: string | null;

  // ── Deployment awareness (ticket 8ce72b18) ──────────────────────────────────
  // The logical environment this scenario validates — the join key into
  // `Deployment.environment` (e.g. 'awb-server', 'production', 'staging'). '' =
  // unset → the run is NOT gated on a deployment fact and no server-authoritative
  // `tested_commit` is recorded (legacy behaviour). When set:
  //   • startQaRun stamps the run's `tested_commit`/`tested_environment` with the
  //     environment's live deployed commit at dispatch (DoD item 4 — evidence).
  //   • QaRerunOnFixService gates a rerun on this environment's deployed_commit
  //     actually INCLUDING the fix commit (DoD item 3), instead of a fixed delay.
  @Column({ type: 'varchar', default: '' })
  target_environment: string;

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
 * in QaFailureTicketService (docs/tickets.md → "QA / Security failure tickets"):
 *   - status           → 'todo' ('backlog' parks it undispatched)
 *   - project_id       → none (the ticket is not tied to a repository)
 *   - priority         → "high"
 *   - assignee_runtime → scenario.target_runtime → the project's default_assignee
 *   - tags             → ['qa-failure','auto'] (stored `labels` still read)
 *   - dedupe           → 'per_open_ticket' (scenario-level; a flaky scenario converges to one ticket)
 */
export interface QaOnFailureTicketConfig {
  enabled: boolean;
  /** Project the fix ticket belongs to (also its default assignee source). */
  project_id?: string;
  /** Status the ticket is filed in. Default 'todo' (queued for its assignee). */
  status?: 'todo' | 'backlog';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assignee_runtime?: Record<string, any>;
  tags?: string[];
  /** @deprecated pre-board-removal name of `tags`; read as a fallback only. */
  labels?: string[];
  // Ticket-lifecycle dedupe (ticket 64b9cbaf). DEFAULT is 'per_open_ticket'.
  // 'per_open_ticket'— (DEFAULT) if an open qa-failure fix ticket for this
  //                    scenario already exists, append a recurrence comment (with
  //                    a running fail count) instead of filing a new one, so a
  //                    flaky scenario converges to ONE ticket. A subsequent green
  //                    run then auto-closes it and every open sibling
  //                    (QaFailureTicketService.maybeCloseSiblingsOnPass).
  // 'per_run'        — opt back into one ticket per failed run. The run_id
  //                    idempotency guard still prevents a re-finalize of the SAME
  //                    run from double-filing.
  dedupe?: 'per_run' | 'per_open_ticket';
  // Optional title override. `{{scenario.name}}` is substituted. Default
  // 'QA 실패: {{scenario.name}}'.
  title_template?: string;

  // ── QA → fix → QA closed-loop (ticket 467dbc7a) ──────────────────────────
  // Opt-in: when true, a fix ticket auto-filed by this policy that later reaches
  // `done` triggers QaRerunOnFixService to deterministically
  // re-run the SAME scenario (server-side startQaRun — no agent prompt parsing).
  // Default false (historic behaviour: filing the ticket is the end of the
  // loop). The rerun is strictly scoped to tickets carrying this policy's
  // markers (`qa-failure` + `auto` + `qa-scenario:<id>` tags), so a human
  // accidentally tagging a ticket can't trigger a run.
  rerun_on_fix?: boolean;
  // Convergence guard: the maximum number of automatic reruns before the loop
  // halts and posts a "human intervention needed" comment instead of re-running.
  // Counted via a `qa-rerun:<n>` generation label threaded fix-ticket → run →
  // next fix-ticket (a ticket tag). Default 3. <= 0 disables reruns (treated like opt-out).
  max_rerun_attempts?: number;
  // 배포 타이밍 게이트 (docs/qa-rerun-on-fix.md 의 "Deployment timing" 절 참고).
  // QA 시나리오는 **돌고 있는** AWB 서버를 친다. 배포 호스트가 `origin/main` 을 detached
  // 로 다시 체크아웃해 의존성 재설치·재빌드·재기동해야 그 커밋이 서빙되므로, main 머지
  // 직후의 즉시 재실행은 수정 전 코드를 검증할 수 있다.
  // This delays the rerun by N seconds (best-effort, in-process; not durable
  // across a server restart) so a deploy can land first. Default 0
  // (immediate). Set to your typical main→prod deploy lag to make Done≈deployed.
  //
  // ⚠️ Superseded (but retained as fallback) by `deployment_gate` below: a fixed
  // delay re-breaks whenever the real deploy time drifts. Prefer the fact-based
  // gate; keep this as a safety-net cap so a rerun still fires if the deployment
  // signal never arrives.
  rerun_delay_seconds?: number;

  // ── Deployment-fact gate (ticket 8ce72b18, DoD item 3) ───────────────────────
  // When true AND the scenario has a `target_environment`, QaRerunOnFixService
  // does NOT fire the rerun on the fix ticket's Done edge. It waits until that
  // environment's live deployment actually INCLUDES the fix commit (the deployed
  // commit itself, or a known ancestor of it — deploymentIncludesCommit) and
  // fires the instant a matching `report_deployment` / self-report lands. The fix
  // commit is read from a `fix-commit:<sha>` ticket tag (preferred, exact
  // ancestry) or, absent that, gated on `deployed_at >= terminal_entered_at`
  // (deploy-freshness ordering). `rerun_delay_seconds` still applies as a
  // best-effort fallback cap so the rerun is never stranded forever if no deploy
  // signal ever arrives. Default false (legacy: fire immediately / after delay).
  deployment_gate?: boolean;
}
