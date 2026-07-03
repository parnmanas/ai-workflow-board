/**
 * Scenario-based QA MCP tools (QaScenario / QaRun).
 *
 * A QaScenario is a reusable, step-based QA definition addressed to a target
 * QA agent. Starting a run dispatches the rendered step prompt into a fresh
 * ChatRoom (same pipeline as Actions). The QA agent then drives its QA driver
 * MCP step by step, recording pass/fail + screenshot Resources via
 * record_qa_step, and finishes with complete_qa_run. Re-running a scenario is
 * just another start_qa_run → a fresh QaRun, so history accumulates.
 *
 * Tools:
 *   Scenarios: create_qa_scenario / update_qa_scenario / list_qa_scenarios /
 *              get_qa_scenario / delete_qa_scenario
 *   Runs:      start_qa_run / record_qa_step / attach_qa_artifact /
 *              complete_qa_run
 *   Batches:   start_qa_batch / get_qa_batch (sequential multi-scenario runs —
 *              scenario N+1 dispatches only after run N terminates)
 *   Reads:     list_qa_runs / get_qa_run
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { QaScenario } from '../../../entities/QaScenario';
import { QaRun } from '../../../entities/QaRun';
import { QaRunBatch } from '../../../entities/QaRunBatch';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import {
  LivenessPolicySchema,
  serializeLivenessPolicy,
  parseLivenessPolicy,
} from '../../qa/qa-liveness-policy';
import {
  QaPhasesSchema,
  serializeQaPhases,
  parseQaPhases,
} from '../../qa/qa-phases';
import {
  repoRefSchema,
  checkoutModeSchema,
  buildModeSchema,
} from '../../../common/workspace-folder-options';
import type { ToolContext } from './context';

function scenarioToJson(s: QaScenario) {
  return {
    id: s.id,
    workspace_id: s.workspace_id,
    board_id: s.board_id,
    name: s.name,
    description: s.description,
    steps: s.steps ?? [],
    target_agent_id: s.target_agent_id,
    qa_driver: s.qa_driver,
    qa_driver_config: s.qa_driver_config ?? null,
    enabled: s.enabled,
    tags: s.tags ?? [],
    on_failure_ticket: s.on_failure_ticket ?? null,
    created_by: s.created_by,
    max_runs: s.max_runs,
    // Working-folder options (shared with security profiles, ticket 4c49f567).
    workspace_folder: s.workspace_folder ?? '',
    // Build & Artifact Registry target (ticket 80d52250).
    build_target: s.build_target ?? '',
    // Deployment-awareness target environment (ticket 8ce72b18).
    target_environment: s.target_environment ?? '',
    repo_ref: s.repo_ref ?? null,
    checkout_mode: s.checkout_mode,
    build_mode: s.build_mode,
    last_built_commit: s.last_built_commit ?? null,
    built_at: s.built_at ?? null,
    // Normalized policy object (or null) so the client never sees raw JSON text.
    liveness_policy: parseLivenessPolicy(s.liveness_policy),
    // Normalized phase model object (or null) — scenario override of the board's
    // qa_phases (multi-phase QA, ticket 90cc22f7).
    qa_phases: parseQaPhases(s.qa_phases),
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

function runToJson(r: QaRun) {
  return {
    id: r.id,
    scenario_id: r.scenario_id,
    workspace_id: r.workspace_id,
    board_id: r.board_id,
    status: r.status,
    room_id: r.room_id,
    step_results: r.step_results ?? [],
    artifact_resource_ids: r.artifact_resource_ids ?? [],
    summary: r.summary,
    // Warm-build provenance (ticket be2f998a): the repo HEAD SHA this run
    // built/tested. On a PASS it advanced the scenario's last_built_commit.
    built_commit: r.built_commit,
    // Deployment awareness (ticket 8ce72b18): SERVER-authoritative live commit of
    // the scenario's target environment at dispatch — the "tested against" evidence.
    tested_commit: r.tested_commit ?? '',
    tested_environment: r.tested_environment ?? '',
    auto_ticket_id: r.auto_ticket_id ?? null,
    rerun_generation: r.rerun_generation ?? 0,
    triggered_by_type: r.triggered_by_type,
    triggered_by_id: r.triggered_by_id,
    batch_id: r.batch_id ?? null,
    batch_index: r.batch_index ?? null,
    started_at: r.started_at,
    finished_at: r.finished_at,
    // Liveness heartbeat state (ticket 40010b25): the high-water progress token
    // and the time it last STRICTLY advanced (the deadline baseline).
    liveness_token: r.liveness_token ?? null,
    liveness_token_at: r.liveness_token_at ?? null,
    // Multi-phase QA state (ticket 90cc22f7): the active phase id, the instant it
    // was entered (the phase_timeouts deadline baseline), and the ordered
    // transition log for the RunDetail timeline. null on legacy single-running runs.
    current_phase: r.current_phase ?? null,
    current_phase_at: r.current_phase_at ?? null,
    phase_history: r.phase_history ?? [],
    created_at: r.created_at,
  };
}

function batchToJson(b: QaRunBatch) {
  const ids = b.scenario_ids ?? [];
  return {
    id: b.id,
    workspace_id: b.workspace_id,
    board_id: b.board_id,
    scenario_ids: ids,
    run_ids: b.run_ids ?? [],
    current_index: b.current_index,
    total: ids.length,
    status: b.status,
    stop_on_fail: b.stop_on_fail,
    passed: b.passed,
    failed: b.failed,
    errored: b.errored,
    triggered_by_type: b.triggered_by_type,
    triggered_by_id: b.triggered_by_id,
    finished_at: b.finished_at,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

const stepSchema = z.object({
  idx: z.number().describe('Ordinal index of the step (0-based)'),
  action: z.string().describe('What the QA driver should do this step (click/fill/navigate/API call…)'),
  expect: z.string().optional().describe('Expected observable outcome to assert'),
  mcp_tool: z.string().optional().describe('Optional driver MCP tool name to invoke for this step'),
  params: z.record(z.string(), z.any()).optional().describe('Optional params passed to the driver action'),
});

// On-failure auto-ticket policy. When enabled, a failed/errored QaRun of the
// scenario auto-files a fix ticket carrying the failure evidence. Pass null to
// clear. Optional fields fall back at dispatch (board → run/scenario board,
// column → "To Do", priority → "high", assignee → scenario.target_agent_id,
// labels → ['qa-failure','auto'], dedupe → 'per_run').
const onFailureTicketSchema = z.object({
  enabled: z.boolean().describe('Master switch — when false (or the whole object null) no ticket is filed'),
  board_id: z.string().optional().describe('Board to file on; default run.board_id → scenario.board_id'),
  column_name: z.string().optional().describe('Target column (default "To Do" — an active assignee-routed column)'),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Ticket priority (default high)'),
  assignee_id: z.string().optional().describe('Agent for all 3 roles (default scenario.target_agent_id)'),
  labels: z.array(z.string()).optional().describe("Ticket labels (default ['qa-failure','auto'])"),
  dedupe: z.enum(['per_run', 'per_open_ticket']).optional().describe('per_run = 1 ticket per failed run (default); per_open_ticket = comment on the scenario\'s existing open ticket instead'),
  title_template: z.string().optional().describe('Title override; {{scenario.name}} is substituted (default "QA 실패: {{scenario.name}}")'),
  rerun_on_fix: z.boolean().optional().describe('Opt-in: when the auto-filed fix ticket reaches Done, the server re-runs THIS scenario (QA→fix→QA closed loop). Default false. Scoped to tickets carrying the qa-failure/auto/qa-scenario markers.'),
  max_rerun_attempts: z.number().optional().describe('Convergence cap: max automatic reruns before the loop halts with a "human intervention needed" comment (default 3; 0 disables reruns)'),
  rerun_delay_seconds: z.number().optional().describe('Deploy-timing gate: delay each rerun by N seconds (best-effort, in-process) so a main→prod auto-deploy can land before re-validating. Default 0 (immediate). See docs/qa-rerun-on-fix.md.'),
  deployment_gate: z.boolean().optional().describe('Deployment-FACT gate (ticket 8ce72b18): when true AND the scenario has a target_environment, a rerun waits until that environment actually deploys the fix commit (deployed_commit includes it, or deployed_at ≥ the fix Done when no fix-commit label) and fires the instant a matching report_deployment lands — instead of a fixed time delay. rerun_delay_seconds still applies as a best-effort fallback cap. Default false.'),
}).nullable();

export function registerQaTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, qaService, qaRunService } = ctx;

  // ── Scenario CRUD ─────────────────────────────────────────────────────────

  server.tool(
    'list_qa_scenarios',
    'List QA scenarios in a workspace. Scope rule mirrors list_actions: omit board_id → ALL ' +
    '(workspace+board); pass board_id="" → workspace-scope only (board_id IS NULL); ' +
    'pass board_id=<uuid> → that board only.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('"" → workspace-scope, <uuid> → board-scope, omit → all'),
    },
    async ({ workspace_id, board_id }) => {
      const repo = dataSource.getRepository(QaScenario);
      const qb = repo.createQueryBuilder('s').where('s.workspace_id = :ws', { ws: workspace_id });
      if (board_id !== undefined) {
        if (board_id) qb.andWhere('s.board_id = :bid', { bid: board_id });
        else qb.andWhere('s.board_id IS NULL');
      }
      const rows = await qb.orderBy('s.name', 'ASC').getMany();
      return ok(rows.map(scenarioToJson));
    },
  );

  server.tool(
    'get_qa_scenario',
    'Get a single QA scenario by id (includes its step definitions).',
    { scenario_id: z.string().describe('QaScenario ID') },
    async ({ scenario_id }) => {
      const repo = dataSource.getRepository(QaScenario);
      const row = await repo.findOne({ where: { id: scenario_id } });
      if (!row) return err('QA scenario not found');
      return ok(scenarioToJson(row));
    },
  );

  server.tool(
    'create_qa_scenario',
    'Create a QA scenario. `steps` is the ordered list the visualizer renders and the run ' +
    'prompt is built from. `qa_driver` selects which QA driver MCP validates the feature ' +
    '(e.g. "browser", "game-client", "http-api"); `qa_driver_config` holds driver settings ' +
    '(start URL, window title, base endpoint…). See docs/qa-driver-guide.md.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('Board ID to pin to, or omit/"" for workspace scope'),
      name: z.string().describe('Scenario name (required)'),
      description: z.string().optional(),
      steps: z.array(stepSchema).optional().describe('Ordered step definitions'),
      target_agent_id: z.string().describe('Agent that runs this scenario (required)'),
      qa_driver: z.string().optional().describe('Driver selector, e.g. browser / game-client / http-api'),
      qa_driver_config: z.record(z.string(), z.any()).optional().describe('Driver-specific config object'),
      enabled: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      on_failure_ticket: onFailureTicketSchema.optional().describe('On-failure auto-ticket policy (see schema). Omit/null to disable.'),
      max_runs: z.number().optional().describe('FIFO run-history budget per scenario (default 20)'),
      workspace_folder: z.string().optional().describe('agent-home-relative working folder. Omit/"" → deterministic default qa/<scenario_id>.'),
      build_target: z.string().optional().describe('Build & Artifact Registry target — free-text platform/config selector (e.g. "windows/Development"). Keys artifacts in the registry and renders into the run prompt\'s "check the registry before you build" block. Omit/"" → falls back to qa_driver.'),
      target_environment: z.string().optional().describe('Deployment-awareness target environment (ticket 8ce72b18) — the Deployment.environment name this scenario validates (e.g. "awb-server", "production"). When set, each run records the environment\'s live deployed commit as tested_commit, and (with on_failure_ticket.deployment_gate) reruns wait until that environment actually deploys the fix commit. Omit/"" = not env-bound.'),
      repo_ref: repoRefSchema.nullable().optional(),
      checkout_mode: checkoutModeSchema.optional(),
      build_mode: buildModeSchema.optional(),
      liveness_policy: LivenessPolicySchema.nullable().optional()
        .describe('Reaper liveness policy override for this scenario\'s runs. ' +
          '{ "type": "zero_progress", "deadline_sec"?: N } (default: reap when run age > deadline, default the global TTL) or ' +
          '{ "type": "heartbeat_deadline", "deadline_sec": N } (reap only when the monotonic qa_run_heartbeat token has not strictly advanced within N seconds). ' +
          'Overrides the board policy; omit/null to inherit the board (then the built-in zero_progress default).'),
      qa_phases: QaPhasesSchema.nullable().optional()
        .describe('QA multi-phase model override for this scenario: { "phases": [ { "id": "import", "label"?: "Import", "timeout_sec": 600 }, ... ] }. ' +
          'Array order = phase order; ids unique; timeout_sec a positive integer. Overrides the board qa_phases; omit/null to inherit the board (then legacy single-running). ' +
          'Drives the phase_timeouts reaper detector — each phase is judged against its own timeout_sec from when the run entered it (set_qa_phase).'),
    },
    async (args, extra: { sessionId?: string }) => {
      if (!qaService) return err('QA service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const row = await qaService.create({
          workspace_id: args.workspace_id,
          board_id: args.board_id ?? null,
          name: args.name,
          description: args.description,
          steps: args.steps,
          target_agent_id: args.target_agent_id,
          qa_driver: args.qa_driver,
          qa_driver_config: args.qa_driver_config ?? null,
          enabled: args.enabled,
          tags: args.tags,
          on_failure_ticket: args.on_failure_ticket,
          created_by: caller?.agentId ?? '',
          max_runs: args.max_runs,
          workspace_folder: args.workspace_folder,
          build_target: args.build_target,
          target_environment: args.target_environment,
          repo_ref: args.repo_ref ?? null,
          checkout_mode: args.checkout_mode,
          build_mode: args.build_mode,
          liveness_policy: args.liveness_policy === undefined ? undefined : serializeLivenessPolicy(args.liveness_policy),
          qa_phases: args.qa_phases === undefined ? undefined : serializeQaPhases(args.qa_phases),
        });
        return ok(scenarioToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to create QA scenario');
      }
    },
  );

  server.tool(
    'update_qa_scenario',
    'Update a QA scenario. Only the provided fields change. `workspace_id` is required for scope safety.',
    {
      scenario_id: z.string().describe('QaScenario ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      board_id: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      steps: z.array(stepSchema).optional(),
      target_agent_id: z.string().optional(),
      qa_driver: z.string().optional(),
      qa_driver_config: z.record(z.string(), z.any()).optional(),
      enabled: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      on_failure_ticket: onFailureTicketSchema.optional().describe('On-failure auto-ticket policy (see create_qa_scenario). Pass null to clear, omit to leave unchanged.'),
      max_runs: z.number().optional(),
      workspace_folder: z.string().optional().describe('agent-home-relative working folder (see create_qa_scenario). "" resets to the qa/<scenario_id> default.'),
      build_target: z.string().optional().describe('Build & Artifact Registry target (see create_qa_scenario). "" resets to the qa_driver fallback.'),
      target_environment: z.string().optional().describe('Deployment-awareness target environment (see create_qa_scenario). "" clears the env binding.'),
      repo_ref: repoRefSchema.nullable().optional().describe('Repo to run against (see create_qa_scenario). Pass null to clear and inherit the board/workspace env repo.'),
      checkout_mode: checkoutModeSchema.optional(),
      build_mode: buildModeSchema.optional(),
      liveness_policy: LivenessPolicySchema.nullable().optional()
        .describe('Reaper liveness policy override (see create_qa_scenario). Pass null to clear and inherit the board policy.'),
      qa_phases: QaPhasesSchema.nullable().optional()
        .describe('QA multi-phase model override (see create_qa_scenario). Pass null to clear and inherit the board qa_phases.'),
    },
    async ({ scenario_id, workspace_id, liveness_policy, qa_phases, ...patch }) => {
      if (!qaService) return err('QA service unavailable in this MCP context');
      try {
        const row = await qaService.update(scenario_id, workspace_id, {
          ...(patch as any),
          // Serialize only when the key was provided; undefined leaves it untouched.
          ...(liveness_policy === undefined ? {} : { liveness_policy: serializeLivenessPolicy(liveness_policy) }),
          ...(qa_phases === undefined ? {} : { qa_phases: serializeQaPhases(qa_phases) }),
        });
        return ok(scenarioToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to update QA scenario');
      }
    },
  );

  server.tool(
    'delete_qa_scenario',
    'Delete a QA scenario and cascade-delete all its runs (and the chat room each run created).',
    {
      scenario_id: z.string().describe('QaScenario ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ scenario_id, workspace_id }) => {
      if (!qaService) return err('QA service unavailable in this MCP context');
      try {
        await qaService.remove(scenario_id, workspace_id);
        return ok({ success: true, id: scenario_id });
      } catch (e: any) {
        return err(e?.message || 'Failed to delete QA scenario');
      }
    },
  );

  // ── Runs ──────────────────────────────────────────────────────────────────

  server.tool(
    'start_qa_run',
    'Start (or re-run) a QA scenario. Creates a QaRun + a ChatRoom, adds the scenario\'s ' +
    'target agent, and posts the rendered step prompt. Returns run_id + room_id. Call again ' +
    'with the same scenario to re-run — a fresh QaRun is stacked, preserving history.',
    {
      scenario_id: z.string().describe('QaScenario ID to run'),
      initial_phase: z.string().optional()
        .describe('Optional phase id to stamp on the new run at dispatch (multi-phase QA). Seeds current_phase / current_phase_at and the first phase_history entry so the phase_timeouts reaper measures the opening phase from run start. Typically the first id in the resolved qa_phases (e.g. "import"). Omit for legacy single-running.'),
    },
    async ({ scenario_id, initial_phase }, extra: { sessionId?: string }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const result = await qaRunService.startQaRun({
          scenarioId: scenario_id,
          triggeredByType: caller?.agentId ? 'agent' : 'system',
          triggeredById: caller?.agentId ?? '',
          initialPhase: initial_phase,
        });
        return ok({ run_id: result.run.id, room_id: result.room_id, prompt: result.prompt });
      } catch (e: any) {
        return err(e?.message || 'Failed to start QA run');
      }
    },
  );

  server.tool(
    'record_qa_step',
    'Record one step result on a running QaRun. Upload the step\'s evidence (screenshot/video/' +
    'dump) as Resources first (save_resource), then pass their ids in artifact_resource_ids. ' +
    'Re-recording the same idx overwrites that step.',
    {
      run_id: z.string().describe('QaRun ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      idx: z.number().describe('Step index this result is for'),
      status: z.enum(['pending', 'passed', 'failed', 'skipped']).describe('Step outcome'),
      log: z.string().optional().describe('Short evidence note for this step'),
      artifact_resource_ids: z.array(z.string()).optional().describe('Resource ids of screenshots/videos/dumps for this step'),
    },
    async ({ run_id, workspace_id, idx, status, log, artifact_resource_ids }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      try {
        const row = await qaRunService.recordStep({
          runId: run_id,
          workspaceId: workspace_id,
          idx,
          status,
          log,
          artifactResourceIds: artifact_resource_ids,
        });
        return ok(runToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to record QA step');
      }
    },
  );

  server.tool(
    'qa_run_heartbeat',
    'Emit a lightweight liveness heartbeat for a running QaRun — SEPARATE from record_qa_step. ' +
    'Liveness ≠ "recorded a step": under the heartbeat_deadline policy a run stays alive only while ' +
    'its monotonic progress_token keeps STRICTLY increasing within the board/scenario deadline. ' +
    'Re-sending the same token (or a lower one) is accepted but does NOT extend the deadline — so a ' +
    'dead drive that keeps replaying the same token (e.g. artifact_count frozen at 141) is still reaped. ' +
    'What the token counts (disk artifact count, frame counter, request count…) is the client\'s ' +
    'choice; AWB only enforces that it advances in time. Rejected once the run is terminal.',
    {
      run_id: z.string().describe('QaRun ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      progress_token: z.number().describe('Monotonic progress token. STRICTLY increase to reset the liveness deadline; a same/lower value is a no-progress heartbeat that does not.'),
      note: z.string().optional().describe('Optional human-readable note (what advanced, e.g. "artifact_count 141→152")'),
    },
    async ({ run_id, workspace_id, progress_token, note }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      try {
        const row = await qaRunService.recordHeartbeat({
          runId: run_id,
          workspaceId: workspace_id,
          progressToken: progress_token,
          note,
        });
        return ok(runToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to record QA heartbeat');
      }
    },
  );

  server.tool(
    'set_qa_phase',
    'Transition a running QaRun into a new phase (multi-phase QA — e.g. Unity import → build → run). ' +
    'SEPARATE from qa_run_heartbeat: heartbeat is a within-phase progress token; this is a STAGE transition. ' +
    'Stamps current_phase + current_phase_at (which RESETS the phase_timeouts deadline clock — the new phase ' +
    'is judged against its own timeout_sec from this instant) and appends a phase_history entry, closing the ' +
    'previous one. The phase id is stored verbatim; it need not appear in the resolved qa_phases model (an ' +
    'unmatched phase just falls back to the first-phase / global TTL timeout in the reaper). Rejected once the ' +
    'run is terminal.',
    {
      run_id: z.string().describe('QaRun ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      phase: z.string().describe('Phase id to enter (e.g. "import", "build", "run"). Should match an id in the resolved qa_phases for its timeout to apply.'),
    },
    async ({ run_id, workspace_id, phase }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      try {
        const row = await qaRunService.setPhase(run_id, workspace_id, phase);
        return ok(runToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to set QA phase');
      }
    },
  );

  server.tool(
    'attach_qa_artifact',
    'Attach one or more artifact Resource ids (video/image/dump) to a QaRun at the run level ' +
    '(not tied to a specific step). Use record_qa_step for per-step evidence.',
    {
      run_id: z.string().describe('QaRun ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      resource_ids: z.array(z.string()).describe('Resource ids to attach'),
    },
    async ({ run_id, workspace_id, resource_ids }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      try {
        const row = await qaRunService.attachArtifact(run_id, workspace_id, resource_ids);
        return ok(runToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to attach QA artifact');
      }
    },
  );

  server.tool(
    'complete_qa_run',
    'Finalize a QaRun with an overall status (passed if every step passed, else failed/error) ' +
    'and a summary. Stamps finished_at. `built_commit` is the repo HEAD SHA you built/tested — ' +
    'REPORT IT ON A PASS so the scenario records it as last_built_commit and the NEXT run of this ' +
    'scenario builds WARM (incremental, minutes) instead of cold-rebuilding from scratch (~35min). ' +
    'A self-reported pass that fails the step/evidence gates is downgraded and will NOT advance the warm commit.',
    {
      run_id: z.string().describe('QaRun ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      status: z.enum(['passed', 'failed', 'error']).describe('Final run status'),
      summary: z.string().optional().describe('Human-readable run summary'),
      built_commit: z.string().optional().describe('Repo HEAD SHA built/tested. On a PASS it becomes the scenario last_built_commit → the next run is warm (cold_then_warm). Omit and the next run stays cold.'),
    },
    async ({ run_id, workspace_id, status, summary, built_commit }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      try {
        const row = await qaRunService.completeRun(run_id, workspace_id, status, summary, built_commit);
        return ok(runToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to complete QA run');
      }
    },
  );

  server.tool(
    'list_qa_runs',
    'List runs for a QA scenario, newest first (history). Each run carries status, step_results, ' +
    'and artifact_resource_ids for comparison across re-runs.',
    {
      scenario_id: z.string().describe('QaScenario ID'),
      workspace_id: z.string().describe('Workspace ID (required)'),
      limit: z.number().optional().describe('Max rows (default 20, cap 100)'),
    },
    async ({ scenario_id, workspace_id, limit }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      try {
        const rows = await qaRunService.listRuns(scenario_id, workspace_id, limit ?? 20);
        return ok(rows.map(runToJson));
      } catch (e: any) {
        return err(e?.message || 'Failed to list QA runs');
      }
    },
  );

  server.tool(
    'get_qa_run',
    'Get a single QA run with its step_results and accumulated artifact_resource_ids.',
    {
      run_id: z.string().describe('QaRun ID'),
      workspace_id: z.string().describe('Workspace ID (required)'),
    },
    async ({ run_id, workspace_id }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      try {
        const row = await qaRunService.getRun(run_id, workspace_id);
        return ok(runToJson(row));
      } catch (e: any) {
        return err(e?.message || 'QA run not found');
      }
    },
  );

  // ── Batches (sequential multi-scenario runs) ────────────────────────────────

  server.tool(
    'start_qa_batch',
    'Start a SEQUENTIAL batch run of several QA scenarios — scenario N+1 only dispatches after ' +
    'scenario N reaches a terminal status (passed/failed/error), never all at once. Pass an ordered ' +
    '`scenario_ids` list, OR `all: true` to expand to every enabled scenario in scope (board_id "" = ' +
    'workspace-scope, <uuid> = that board, omit = all). `stop_on_fail` (default false) halts the batch ' +
    'on the first non-passed run. Returns the batch with current_index/total + pass/fail rollup; poll ' +
    'get_qa_batch for progress.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('Scope for `all`: "" → workspace-scope, <uuid> → board, omit → all'),
      scenario_ids: z.array(z.string()).optional().describe('Ordered scenario ids to run (takes precedence over `all`)'),
      all: z.boolean().optional().describe('Run every enabled scenario in scope, in name order'),
      stop_on_fail: z.boolean().optional().describe('Halt on first non-passed run (default false → continue)'),
    },
    async ({ workspace_id, board_id, scenario_ids, all, stop_on_fail }, extra: { sessionId?: string }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const batch = await qaRunService.startBatch({
          workspaceId: workspace_id,
          boardId: board_id,
          scenarioIds: scenario_ids,
          all: !!all,
          stopOnFail: !!stop_on_fail,
          triggeredByType: caller?.agentId ? 'agent' : 'system',
          triggeredById: caller?.agentId ?? '',
        });
        return ok(batchToJson(batch));
      } catch (e: any) {
        return err(e?.message || 'Failed to start QA batch');
      }
    },
  );

  server.tool(
    'get_qa_batch',
    'Get a sequential QA batch: ordered scenario_ids + run_ids, current_index/total progress, status ' +
    '(running/done/aborted), and the passed/failed/errored rollup.',
    {
      batch_id: z.string().describe('QaRunBatch ID'),
      workspace_id: z.string().describe('Workspace ID (required)'),
    },
    async ({ batch_id, workspace_id }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      try {
        const batch = await qaRunService.getBatch(batch_id, workspace_id);
        return ok(batchToJson(batch));
      } catch (e: any) {
        return err(e?.message || 'QA batch not found');
      }
    },
  );
}
