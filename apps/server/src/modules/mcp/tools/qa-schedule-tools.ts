/**
 * QA scheduler MCP tools (QaSchedule — ticket b6bb7efd).
 *
 * A QaSchedule is an automatic trigger that, when due, kicks a sequential
 * QaRunBatch via the SAME orchestrator the manual batch buttons use
 * (start_qa_batch). The background tick lives in QaScheduleService; these tools
 * are the CRUD + manual run-now surface.
 *
 * Tools:
 *   list_qa_schedules / get_qa_schedule / create_qa_schedule /
 *   update_qa_schedule / delete_qa_schedule / run_qa_schedule_now
 *
 * Scope: scope='all' resolves enabled scenarios in scope at dispatch time (no id
 * snapshot — scenario add/remove is reflected automatically). scope='selected'
 * runs the explicit ordered scenario_ids. Cadence: exactly one of `cron`
 * (5-field, UTC) or `interval_ms`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { QaSchedule } from '../../../entities/QaSchedule';
import { QaRunBatch } from '../../../entities/QaRunBatch';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function scheduleToJson(s: QaSchedule) {
  return {
    id: s.id,
    workspace_id: s.workspace_id,
    board_id: s.board_id,
    name: s.name,
    scope: s.scope,
    scenario_ids: s.scenario_ids ?? [],
    cron: s.cron,
    interval_ms: s.interval_ms,
    enabled: s.enabled,
    stop_on_fail: s.stop_on_fail,
    next_run_at: s.next_run_at,
    last_run_at: s.last_run_at,
    last_batch_id: s.last_batch_id,
    triggered_by_type: s.triggered_by_type,
    created_by: s.created_by,
    created_at: s.created_at,
    updated_at: s.updated_at,
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
    created_at: b.created_at,
  };
}

export function registerQaScheduleTools(server: McpServer, ctx: ToolContext): void {
  const { qaScheduleService } = ctx;

  server.tool(
    'list_qa_schedules',
    'List QA schedules in a workspace. Scope rule mirrors list_qa_scenarios: omit board_id → ALL; ' +
    'board_id="" → workspace-scope only (board_id IS NULL); board_id=<uuid> → that board.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('"" → workspace-scope, <uuid> → board-scope, omit → all'),
    },
    async ({ workspace_id, board_id }) => {
      if (!qaScheduleService) return err('QA schedule service unavailable in this MCP context');
      try {
        const rows = await qaScheduleService.list(workspace_id, board_id);
        return ok(rows.map(scheduleToJson));
      } catch (e: any) {
        return err(e?.message || 'Failed to list QA schedules');
      }
    },
  );

  server.tool(
    'get_qa_schedule',
    'Get a single QA schedule by id (scope, cadence, next/last run, last batch id).',
    {
      schedule_id: z.string().describe('QaSchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ schedule_id, workspace_id }) => {
      if (!qaScheduleService) return err('QA schedule service unavailable in this MCP context');
      try {
        return ok(scheduleToJson(await qaScheduleService.get(schedule_id, workspace_id)));
      } catch (e: any) {
        return err(e?.message || 'QA schedule not found');
      }
    },
  );

  server.tool(
    'create_qa_schedule',
    'Create a QA schedule — an automatic trigger that kicks a SEQUENTIAL batch (start_qa_batch) when ' +
    'due. `scope="all"` runs every enabled scenario in scope at dispatch time (board_id <uuid> = that ' +
    'board, board_id omitted/null = whole workspace) — no id snapshot, so scenario add/remove is ' +
    'reflected automatically. `scope="selected"` runs the ordered `scenario_ids`. Set EXACTLY ONE of ' +
    '`cron` (5 UTC fields, e.g. "0 3 * * *") or `interval_ms`. `enabled` defaults true.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('Board to pin to, or omit/"" for workspace scope'),
      name: z.string().describe('Schedule name (required)'),
      scope: z.enum(['all', 'selected']).optional().describe("'all' (default) or 'selected'"),
      scenario_ids: z.array(z.string()).optional().describe("Ordered scenario ids — required when scope='selected'"),
      cron: z.string().optional().describe('5-field UTC cron (e.g. "0 3 * * *"). Mutually exclusive with interval_ms'),
      interval_ms: z.number().optional().describe('Fixed interval in ms (>= 1000). Mutually exclusive with cron'),
      enabled: z.boolean().optional().describe('Default true'),
      stop_on_fail: z.boolean().optional().describe('Halt the batch on first non-passed run (default false)'),
    },
    async (args, extra: { sessionId?: string }) => {
      if (!qaScheduleService) return err('QA schedule service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const row = await qaScheduleService.create({
          workspaceId: args.workspace_id,
          boardId: args.board_id ?? undefined,
          name: args.name,
          scope: args.scope,
          scenarioIds: args.scenario_ids,
          cron: args.cron,
          intervalMs: args.interval_ms,
          enabled: args.enabled,
          stopOnFail: args.stop_on_fail,
          createdBy: caller?.agentId ?? '',
        });
        return ok(scheduleToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to create QA schedule');
      }
    },
  );

  server.tool(
    'update_qa_schedule',
    'Update a QA schedule. Only the provided fields change. `workspace_id` is required for scope ' +
    'safety. Toggling `enabled`, or changing `cron`/`interval_ms`, recomputes next_run_at.',
    {
      schedule_id: z.string().describe('QaSchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      board_id: z.string().optional(),
      name: z.string().optional(),
      scope: z.enum(['all', 'selected']).optional(),
      scenario_ids: z.array(z.string()).optional(),
      cron: z.string().optional(),
      interval_ms: z.number().optional(),
      enabled: z.boolean().optional(),
      stop_on_fail: z.boolean().optional(),
    },
    async ({ schedule_id, workspace_id, ...patch }) => {
      if (!qaScheduleService) return err('QA schedule service unavailable in this MCP context');
      try {
        const row = await qaScheduleService.update(schedule_id, workspace_id, {
          boardId: patch.board_id,
          name: patch.name,
          scope: patch.scope,
          scenarioIds: patch.scenario_ids,
          cron: patch.cron,
          intervalMs: patch.interval_ms,
          enabled: patch.enabled,
          stopOnFail: patch.stop_on_fail,
        });
        return ok(scheduleToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to update QA schedule');
      }
    },
  );

  server.tool(
    'delete_qa_schedule',
    'Delete a QA schedule. Does NOT touch the QaRunBatches it already started.',
    {
      schedule_id: z.string().describe('QaSchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ schedule_id, workspace_id }) => {
      if (!qaScheduleService) return err('QA schedule service unavailable in this MCP context');
      try {
        await qaScheduleService.remove(schedule_id, workspace_id);
        return ok({ success: true, id: schedule_id });
      } catch (e: any) {
        return err(e?.message || 'Failed to delete QA schedule');
      }
    },
  );

  server.tool(
    'run_qa_schedule_now',
    'Manually dispatch a QA schedule\'s batch right now (ignores enabled; does NOT disturb the ' +
    'automatic next_run_at). Returns the schedule + the started batch — poll get_qa_batch for progress.',
    {
      schedule_id: z.string().describe('QaSchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ schedule_id, workspace_id }, extra: { sessionId?: string }) => {
      if (!qaScheduleService) return err('QA schedule service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const { schedule, batch } = await qaScheduleService.runNow(schedule_id, workspace_id, caller?.agentId ?? '');
        return ok({ schedule: scheduleToJson(schedule), batch: batchToJson(batch) });
      } catch (e: any) {
        return err(e?.message || 'Failed to run QA schedule');
      }
    },
  );
}
