import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response, Request } from 'express';
import { Req } from '@nestjs/common';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { ActionsService } from './actions.service';

@ApiBearerAuth('user-session')
@ApiTags('actions')
@Controller('api/actions')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_ACTIONS)
export class ActionsController {
  constructor(private readonly actionsService: ActionsService) {}

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('board_id') boardId: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    const rows = await this.actionsService.list(workspaceId, boardId);
    return res.json(rows);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response) {
    try {
      const row = await this.actionsService.get(id);
      return res.json(row);
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'Action not found' });
    }
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    try {
      const row = await this.actionsService.create(body);
      return res.status(201).json(row);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to create action' });
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    try {
      const row = await this.actionsService.update(id, body?.workspace_id, body);
      return res.json(row);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to update action' });
    }
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    try {
      await this.actionsService.remove(id, workspaceId);
      return res.json({ success: true, id });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to delete action' });
    }
  }

  // Trigger a Run. The triggering user is read off the request — PermissionGuard
  // already authenticated them, so currentUser is on the request object.
  @Post(':id/run')
  async run(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const result = await this.actionsService.dispatch({
        actionId: id,
        triggeredByType: 'user',
        triggeredById: user?.id || '',
      });
      return res.status(201).json({
        run_id: result.run.id,
        room_id: result.room_id,
        prompt: result.prompt,
      });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to run action' });
    }
  }

  @Get(':id/runs')
  async listRuns(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const n = limit ? parseInt(limit, 10) : 20;
      const runs = await this.actionsService.listRuns(id, workspaceId, Number.isFinite(n) ? n : 20);
      return res.json(runs);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to list runs' });
    }
  }

  @Get('runs/:runId')
  async getRun(
    @Param('runId') runId: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    try {
      const run = await this.actionsService.getRun(runId, workspaceId);
      return res.json(run);
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'Run not found' });
    }
  }
}
