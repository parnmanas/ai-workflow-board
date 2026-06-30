/**
 * Workspace scheduler MCP tools (WorkspaceSchedule — ticket 769eb260, on top of
 * foundation 8845be79).
 *
 * A WorkspaceSchedule is a general-purpose "do this task at this time" trigger
 * for a SINGLE agent: when due, the background WorkspaceScheduleService opens a
 * fresh chat room, seats `target_agent_id`, and sends `task_prompt` as the
 * opening message (the QA/Security RUN dispatch shape). These tools are the CRUD
 * + manual run-now surface over that service; the background tick lives in the
 * service, not here.
 *
 * Tools:
 *   list_workspace_schedules / get_workspace_schedule / create_workspace_schedule /
 *   update_workspace_schedule / delete_workspace_schedule / run_workspace_schedule_now
 *
 * Scope: list mirrors list_qa_schedules — omit board_id → ALL; board_id="" →
 * workspace-scope only (board_id IS NULL); board_id=<uuid> → that board. Cadence:
 * exactly one of `cron` (5-field, UTC) or `interval_ms` (>= 1000).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkspaceSchedule } from '../../../entities/WorkspaceSchedule';
import type { DispatchResult } from '../../workspace-schedule/workspace-schedule.service';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function scheduleToJson(s: WorkspaceSchedule) {
  return {
    id: s.id,
    workspace_id: s.workspace_id,
    board_id: s.board_id,
    name: s.name,
    target_agent_id: s.target_agent_id,
    task_prompt: s.task_prompt,
    cron: s.cron,
    interval_ms: s.interval_ms,
    enabled: s.enabled,
    next_run_at: s.next_run_at,
    last_run_at: s.last_run_at,
    last_room_id: s.last_room_id,
    triggered_by_type: s.triggered_by_type,
    created_by: s.created_by,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

function dispatchToJson(d: DispatchResult) {
  return {
    schedule_id: d.schedule_id,
    room_id: d.room_id,
    agent_id: d.agent_id,
  };
}

export function registerWorkspaceScheduleTools(server: McpServer, ctx: ToolContext): void {
  const { workspaceScheduleService } = ctx;

  server.tool(
    'list_workspace_schedules',
    'List workspace schedules. Scope rule mirrors list_qa_schedules: omit board_id → ALL; ' +
    'board_id="" → workspace-scope only (board_id IS NULL); board_id=<uuid> → that board.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('"" → workspace-scope, <uuid> → board-scope, omit → all'),
    },
    async ({ workspace_id, board_id }) => {
      if (!workspaceScheduleService) return err('Workspace schedule service unavailable in this MCP context');
      try {
        const rows = await workspaceScheduleService.list(workspace_id, board_id);
        return ok(rows.map(scheduleToJson));
      } catch (e: any) {
        return err(e?.message || 'Failed to list workspace schedules');
      }
    },
  );

  server.tool(
    'get_workspace_schedule',
    'Get a single workspace schedule by id (target agent, task prompt, cadence, next/last run, last room id).',
    {
      schedule_id: z.string().describe('WorkspaceSchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ schedule_id, workspace_id }) => {
      if (!workspaceScheduleService) return err('Workspace schedule service unavailable in this MCP context');
      try {
        return ok(scheduleToJson(await workspaceScheduleService.get(schedule_id, workspace_id)));
      } catch (e: any) {
        return err(e?.message || 'Workspace schedule not found');
      }
    },
  );

  server.tool(
    'create_workspace_schedule',
    'Create a workspace schedule — a general-purpose "do this task at this time" trigger for ONE agent. ' +
    'When due, it opens a fresh chat room, seats `target_agent_id`, and sends `task_prompt` as the opening ' +
    'message (the QA/Security RUN dispatch shape). `board_id` is optional context (omit/"" = workspace ' +
    'scope) and does NOT affect when it fires. Set EXACTLY ONE of `cron` (5 UTC fields, e.g. "0 3 * * *") ' +
    'or `interval_ms` (>= 1000). `enabled` defaults true.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      name: z.string().describe('Schedule name (required)'),
      target_agent_id: z.string().describe('The single agent the task is dispatched to (required)'),
      task_prompt: z.string().describe('Free-text task message sent to the agent when the schedule fires (required)'),
      board_id: z.string().optional().describe('Board to pin context to, or omit/"" for workspace scope'),
      cron: z.string().optional().describe('5-field UTC cron (e.g. "0 3 * * *"). Mutually exclusive with interval_ms'),
      interval_ms: z.number().optional().describe('Fixed interval in ms (>= 1000). Mutually exclusive with cron'),
      enabled: z.boolean().optional().describe('Default true'),
    },
    async (args, extra: { sessionId?: string }) => {
      if (!workspaceScheduleService) return err('Workspace schedule service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const row = await workspaceScheduleService.create({
          workspaceId: args.workspace_id,
          boardId: args.board_id ?? undefined,
          name: args.name,
          targetAgentId: args.target_agent_id,
          taskPrompt: args.task_prompt,
          cron: args.cron,
          intervalMs: args.interval_ms,
          enabled: args.enabled,
          createdBy: caller?.agentId ?? '',
        });
        return ok(scheduleToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to create workspace schedule');
      }
    },
  );

  server.tool(
    'update_workspace_schedule',
    'Update a workspace schedule. Only the provided fields change. `workspace_id` is required for scope ' +
    'safety. Toggling `enabled`, or changing `cron`/`interval_ms`, recomputes next_run_at.',
    {
      schedule_id: z.string().describe('WorkspaceSchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      name: z.string().optional(),
      target_agent_id: z.string().optional(),
      task_prompt: z.string().optional(),
      board_id: z.string().optional(),
      cron: z.string().optional(),
      interval_ms: z.number().optional(),
      enabled: z.boolean().optional(),
    },
    async ({ schedule_id, workspace_id, ...patch }) => {
      if (!workspaceScheduleService) return err('Workspace schedule service unavailable in this MCP context');
      try {
        const row = await workspaceScheduleService.update(schedule_id, workspace_id, {
          name: patch.name,
          targetAgentId: patch.target_agent_id,
          taskPrompt: patch.task_prompt,
          boardId: patch.board_id,
          cron: patch.cron,
          intervalMs: patch.interval_ms,
          enabled: patch.enabled,
        });
        return ok(scheduleToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to update workspace schedule');
      }
    },
  );

  server.tool(
    'delete_workspace_schedule',
    'Delete a workspace schedule. Does NOT touch the chat rooms it already opened.',
    {
      schedule_id: z.string().describe('WorkspaceSchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ schedule_id, workspace_id }) => {
      if (!workspaceScheduleService) return err('Workspace schedule service unavailable in this MCP context');
      try {
        await workspaceScheduleService.remove(schedule_id, workspace_id);
        return ok({ success: true, id: schedule_id });
      } catch (e: any) {
        return err(e?.message || 'Failed to delete workspace schedule');
      }
    },
  );

  server.tool(
    'run_workspace_schedule_now',
    'Manually dispatch a workspace schedule\'s task right now (ignores enabled; does NOT disturb the ' +
    'automatic next_run_at). Returns the schedule + the dispatch result (schedule_id, room_id, agent_id) — ' +
    'the spawned conversation lives in that chat room.',
    {
      schedule_id: z.string().describe('WorkspaceSchedule ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ schedule_id, workspace_id }, extra: { sessionId?: string }) => {
      if (!workspaceScheduleService) return err('Workspace schedule service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const { schedule, dispatch } = await workspaceScheduleService.runNow(schedule_id, workspace_id, caller?.agentId ?? '');
        return ok({ schedule: scheduleToJson(schedule), dispatch: dispatchToJson(dispatch) });
      } catch (e: any) {
        return err(e?.message || 'Failed to run workspace schedule');
      }
    },
  );
}
