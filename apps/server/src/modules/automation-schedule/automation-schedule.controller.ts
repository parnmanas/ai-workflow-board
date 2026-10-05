import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response, Request } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { WorkspaceScheduleService, DispatchResult } from './automation-schedule.service';
import { AutomationSchedule } from '../../entities/AutomationSchedule';

/**
 * Normalize a AutomationSchedule row for the client editor. Field shape is kept
 * identical to scheduleToJson in the MCP automation-schedule-tools so the REST and
 * MCP surfaces hand the UI the same object.
 */
function scheduleToJson(s: AutomationSchedule) {
  return {
    id: s.id,
    account_id: s.account_id,
    name: s.name,
    target_agent_id: s.target_agent_id,
    task_prompt: s.task_prompt,
    action_id: s.action_id,
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
 * REST surface for AutomationSchedule (ticket 1927ed4a — client UI). The MCP
 * tools ticket (769eb260) intentionally deferred this controller until an editing
 * UI existed; this is that UI's backend. Mirrors the QA-schedule REST shape
 * (qa-scenario.controller.ts schedule endpoints): list / get / create / update /
 * delete / run-now. Body/query field names are snake_case (account_id,
 * target_agent_id, …); the service input is camelCase, mapped here.
 *
 * Gated on ADMIN_ACCESS to match the admin-gated Account Settings page that
 * hosts the editor — a scheduled task dispatches an arbitrary prompt to any agent
 * in the workspace, an operator-level capability.
 */
@ApiBearerAuth('user-session')
@ApiTags('automation-schedules')
@Controller('api/automation-schedules')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.ADMIN_ACCESS)
export class WorkspaceScheduleController {
  constructor(private readonly scheduleService: WorkspaceScheduleService) {}

  @Get()
  async list(
    @Query('account_id') accountId: string,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    if (!accountId) return res.status(400).json({ error: 'account_id query parameter is required' });
    try {
      const ids: string[] = (req as any)?.accessibleAccountIds || [accountId];
      const rows = (await Promise.all(ids.map(id => this.scheduleService.list(id)))).flat();
      return res.json(rows.map(scheduleToJson));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to list workspace schedules' });
    }
  }

  @Get(':id')
  async get(@Param('id') id: string, @Query('account_id') accountId: string, @Res() res: Response) {
    try {
      return res.json(scheduleToJson(await this.scheduleService.get(id, accountId)));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'Account schedule not found' });
    }
  }

  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const row = await this.scheduleService.create({
        accountId: body?.account_id,
        name: body?.name,
        targetAgentId: body?.target_agent_id,
        targetRuntime: body?.target_runtime,
        taskPrompt: body?.task_prompt,
        actionId: body?.action_id,
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
      const row = await this.scheduleService.update(id, body?.account_id, {
        name: body?.name,
        targetAgentId: body?.target_agent_id,
        targetRuntime: body?.target_runtime,
        taskPrompt: body?.task_prompt,
        actionId: body?.action_id,
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
  async remove(@Param('id') id: string, @Query('account_id') accountId: string, @Res() res: Response) {
    try {
      await this.scheduleService.remove(id, accountId);
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
      const { schedule, dispatch } = await this.scheduleService.runNow(id, body?.account_id, user?.id || '');
      return res.status(201).json({ schedule: scheduleToJson(schedule), dispatch: dispatchToJson(dispatch) });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to run workspace schedule' });
    }
  }
}
