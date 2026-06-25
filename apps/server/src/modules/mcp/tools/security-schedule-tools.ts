/**
 * Security scheduler MCP tools (SecuritySchedule).
 *
 * A SecuritySchedule is an automatic trigger that, when due, kicks a sequential
 * SecurityRunBatch via the SAME orchestrator the manual batch path uses
 * (start_security_batch). The background tick lives in SecurityScheduleService;
 * these tools are the CRUD + manual run-now surface.
 *
 * Tools:
 *   list_security_schedules / get_security_schedule / create_security_schedule /
 *   update_security_schedule / delete_security_schedule / run_security_schedule_now
 *
 * Scope: scope='all' resolves enabled profiles in scope at dispatch time (no id
 * snapshot — profile add/remove is reflected automatically). scope='selected'
 * runs the explicit ordered profile_ids. Cadence: exactly one of `cron` (5-field,
 * UTC) or `interval_ms`.
 *
 * Deploy-timing footgun: a scheduled run hits the RUNNING (deployed) server,
 * which auto-deploys from production.private only after main merges — so a
 * schedule firing right after a fix-merge can inspect pre-deploy code. Every
 * SecurityRun records its scanned_commit so the inspected commit is always
 * reconstructable; operationally, keep the cadence coarser than the main→prod
 * deploy lag. See docs/security-scheduler.md.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SecuritySchedule } from '../../../entities/SecuritySchedule';
import { SecurityRunBatch } from '../../../entities/SecurityRunBatch';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function scheduleToJson(s: SecuritySchedule) {
  return {
    id: s.id,
    workspace_id: s.workspace_id,
    board_id: s.board_id,
    name: s.name,
    scope: s.scope,
    profile_ids: s.profile_ids ?? [],
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

function batchToJson(b: SecurityRunBatch) {
  const ids = b.profile_ids ?? [];
  return {
    id: b.id,
    workspace_id: b.workspace_id,
    board_id: b.board_id,
    profile_ids: ids,
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

export function registerSecurityScheduleTools(server: McpServer, ctx: ToolContext): void {
  const { securityScheduleService } = ctx;

  server.tool(
    'list_security_schedules',
    'List security schedules in a workspace. Scope rule mirrors list_security_profiles: omit board_id ' +
    '→ ALL; board_id="" → workspace-scope only (board_id IS NULL); board_id=<uuid> → that board.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('"" → workspace-scope, <uuid> → board-scope, omit → all'),
    },
    async ({ workspace_id, board_id }) => {
      if (!securityScheduleService) return err('security schedule service unavailable in this MCP context');
      try {
        const rows = await securityScheduleService.list(workspace_id, board_id);
        return ok(rows.map(scheduleToJson));
      } catch (e: any) {
        return err(e?.message || 'Failed to list security schedules');
      }
    },
  );

  server.tool(
    'get_security_schedule',
    'Get a single security schedule by id (scope, cadence, next/last run, last batch id).',
    {
      schedule_id: z.string().describe('SecuritySchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ schedule_id, workspace_id }) => {
      if (!securityScheduleService) return err('security schedule service unavailable in this MCP context');
      try {
        return ok(scheduleToJson(await securityScheduleService.get(schedule_id, workspace_id)));
      } catch (e: any) {
        return err(e?.message || 'security schedule not found');
      }
    },
  );

  server.tool(
    'create_security_schedule',
    'Create a security schedule — an automatic trigger that kicks a SEQUENTIAL batch ' +
    '(start_security_batch) when due. `scope="all"` runs every enabled profile in scope at dispatch ' +
    'time (board_id <uuid> = that board, board_id omitted/null = whole workspace) — no id snapshot, so ' +
    'profile add/remove is reflected automatically. `scope="selected"` runs the ordered `profile_ids`. ' +
    'Set EXACTLY ONE of `cron` (5 UTC fields, e.g. "0 3 * * *") or `interval_ms`. `enabled` defaults ' +
    'true. NOTE: a scheduled run inspects the RUNNING server\'s code — keep the cadence coarser than ' +
    'your main→prod deploy lag so a run lands after the deploy (the inspected commit is recorded on ' +
    'each run\'s scanned_commit regardless).',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('Board to pin to, or omit/"" for workspace scope'),
      name: z.string().describe('Schedule name (required)'),
      scope: z.enum(['all', 'selected']).optional().describe("'all' (default) or 'selected'"),
      profile_ids: z.array(z.string()).optional().describe("Ordered profile ids — required when scope='selected'"),
      cron: z.string().optional().describe('5-field UTC cron (e.g. "0 3 * * *"). Mutually exclusive with interval_ms'),
      interval_ms: z.number().optional().describe('Fixed interval in ms (>= 1000). Mutually exclusive with cron'),
      enabled: z.boolean().optional().describe('Default true'),
      stop_on_fail: z.boolean().optional().describe('Halt the batch on first non-passed run (default false)'),
    },
    async (args, extra: { sessionId?: string }) => {
      if (!securityScheduleService) return err('security schedule service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const row = await securityScheduleService.create({
          workspaceId: args.workspace_id,
          boardId: args.board_id ?? undefined,
          name: args.name,
          scope: args.scope,
          profileIds: args.profile_ids,
          cron: args.cron,
          intervalMs: args.interval_ms,
          enabled: args.enabled,
          stopOnFail: args.stop_on_fail,
          createdBy: caller?.agentId ?? '',
        });
        return ok(scheduleToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to create security schedule');
      }
    },
  );

  server.tool(
    'update_security_schedule',
    'Update a security schedule. Only the provided fields change. `workspace_id` is required for scope ' +
    'safety. Toggling `enabled`, or changing `cron`/`interval_ms`, recomputes next_run_at.',
    {
      schedule_id: z.string().describe('SecuritySchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      board_id: z.string().optional(),
      name: z.string().optional(),
      scope: z.enum(['all', 'selected']).optional(),
      profile_ids: z.array(z.string()).optional(),
      cron: z.string().optional(),
      interval_ms: z.number().optional(),
      enabled: z.boolean().optional(),
      stop_on_fail: z.boolean().optional(),
    },
    async ({ schedule_id, workspace_id, ...patch }) => {
      if (!securityScheduleService) return err('security schedule service unavailable in this MCP context');
      try {
        const row = await securityScheduleService.update(schedule_id, workspace_id, {
          boardId: patch.board_id,
          name: patch.name,
          scope: patch.scope,
          profileIds: patch.profile_ids,
          cron: patch.cron,
          intervalMs: patch.interval_ms,
          enabled: patch.enabled,
          stopOnFail: patch.stop_on_fail,
        });
        return ok(scheduleToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to update security schedule');
      }
    },
  );

  server.tool(
    'delete_security_schedule',
    'Delete a security schedule. Does NOT touch the SecurityRunBatches it already started.',
    {
      schedule_id: z.string().describe('SecuritySchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ schedule_id, workspace_id }) => {
      if (!securityScheduleService) return err('security schedule service unavailable in this MCP context');
      try {
        await securityScheduleService.remove(schedule_id, workspace_id);
        return ok({ success: true, id: schedule_id });
      } catch (e: any) {
        return err(e?.message || 'Failed to delete security schedule');
      }
    },
  );

  server.tool(
    'run_security_schedule_now',
    "Manually dispatch a security schedule's batch right now (ignores enabled; does NOT disturb the " +
    'automatic next_run_at). Returns the schedule + the started batch — poll get_security_batch for progress.',
    {
      schedule_id: z.string().describe('SecuritySchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ schedule_id, workspace_id }, extra: { sessionId?: string }) => {
      if (!securityScheduleService) return err('security schedule service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const { schedule, batch } = await securityScheduleService.runNow(schedule_id, workspace_id, caller?.agentId ?? '');
        return ok({ schedule: scheduleToJson(schedule), batch: batchToJson(batch) });
      } catch (e: any) {
        return err(e?.message || 'Failed to run security schedule');
      }
    },
  );
}
