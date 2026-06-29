import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response, Request } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { WorkspaceScheduleService, DispatchResult } from './workspace-schedule.service';
import { WorkspaceSchedule } from '../../entities/WorkspaceSchedule';

/**
 * Normalize a WorkspaceSchedule row for the client editor. Field shape is kept
 * identical to scheduleToJson in the MCP workspace-schedule-tools so the REST and
 * MCP surfaces hand the UI the same object.
 */
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
  return { schedule_id: d.schedule_id, room_id: d.room_id, agent_id: d.agent_id };
}

/**
 * REST surface for WorkspaceSchedule (ticket 1927ed4a — client UI). The MCP
 * tools ticket (769eb260) intentionally deferred this controller until an editing
 * UI existed; this is that UI's backend. Mirrors the QA-schedule REST shape
 * (qa-scenario.controller.ts schedule endpoints): list / get / create / update /
 * delete / run-now. Body/query field names are snake_case (workspace_id,
 * target_agent_id, …); the service input is camelCase, mapped here.
 *
 * Gated on ADMIN_ACCESS to match the admin-gated Workspace Settings page that
 * hosts the editor — a scheduled task dispatches an arbitrary prompt to any agent
 * in the workspace, an operator-level capability.
 */
@ApiBearerAuth('user-session')
@ApiTags('workspace-schedules')
@Controller('api/workspace-schedules')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.ADMIN_ACCESS)
export class WorkspaceScheduleController {
  constructor(private readonly scheduleService: WorkspaceScheduleService) {}

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('board_id') boardId: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    try {
      const rows = await this.scheduleService.list(workspaceId, boardId);
      return res.json(rows.map(scheduleToJson));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to list workspace schedules' });
    }
  }

  @Get(':id')
  async get(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(scheduleToJson(await this.scheduleService.get(id, workspaceId)));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'Workspace schedule not found' });
    }
  }

  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const row = await this.scheduleService.create({
        workspaceId: body?.workspace_id,
        boardId: body?.board_id ?? undefined,
        name: body?.name,
        targetAgentId: body?.target_agent_id,
        taskPrompt: body?.task_prompt,
        cron: body?.cron,
        intervalMs: body?.interval_ms,
        enabled: body?.enabled,
        createdBy: body?.created_by || user?.id || '',
      });
      return res.status(201).json(scheduleToJson(row));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to create workspace schedule' });
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    try {
      const row = await this.scheduleService.update(id, body?.workspace_id, {
        boardId: body?.board_id,
        name: body?.name,
        targetAgentId: body?.target_agent_id,
        taskPrompt: body?.task_prompt,
        cron: body?.cron,
        intervalMs: body?.interval_ms,
        enabled: body?.enabled,
      });
      return res.json(scheduleToJson(row));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to update workspace schedule' });
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      await this.scheduleService.remove(id, workspaceId);
      return res.json({ success: true, id });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to delete workspace schedule' });
    }
  }

  // Manual immediate trigger — dispatch the schedule's task now (ignores enabled;
  // does not disturb next_run_at). Returns the schedule + the opened room so the
  // UI can deep-link to the dispatched conversation.
  @Post(':id/run-now')
  async runNow(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const { schedule, dispatch } = await this.scheduleService.runNow(id, body?.workspace_id, user?.id || '');
      return res.status(201).json({ schedule: scheduleToJson(schedule), dispatch: dispatchToJson(dispatch) });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to run workspace schedule' });
    }
  }
}
