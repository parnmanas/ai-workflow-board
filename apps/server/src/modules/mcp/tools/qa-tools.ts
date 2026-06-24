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
 *   Reads:     list_qa_runs / get_qa_run
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { QaScenario } from '../../../entities/QaScenario';
import { QaRun } from '../../../entities/QaRun';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
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
    auto_ticket_id: r.auto_ticket_id ?? null,
    rerun_generation: r.rerun_generation ?? 0,
    triggered_by_type: r.triggered_by_type,
    triggered_by_id: r.triggered_by_id,
    started_at: r.started_at,
    finished_at: r.finished_at,
    created_at: r.created_at,
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
    },
    async ({ scenario_id, workspace_id, ...patch }) => {
      if (!qaService) return err('QA service unavailable in this MCP context');
      try {
        const row = await qaService.update(scenario_id, workspace_id, patch as any);
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
    { scenario_id: z.string().describe('QaScenario ID to run') },
    async ({ scenario_id }, extra: { sessionId?: string }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const result = await qaRunService.startQaRun({
          scenarioId: scenario_id,
          triggeredByType: caller?.agentId ? 'agent' : 'system',
          triggeredById: caller?.agentId ?? '',
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
    'and a summary. Stamps finished_at.',
    {
      run_id: z.string().describe('QaRun ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      status: z.enum(['passed', 'failed', 'error']).describe('Final run status'),
      summary: z.string().optional().describe('Human-readable run summary'),
    },
    async ({ run_id, workspace_id, status, summary }) => {
      if (!qaRunService) return err('QA run service unavailable in this MCP context');
      try {
        const row = await qaRunService.completeRun(run_id, workspace_id, status, summary);
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
}
