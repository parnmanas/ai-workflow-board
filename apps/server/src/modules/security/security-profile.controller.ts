import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response, Request } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { SecurityProfileService } from './security-profile.service';
import { SecurityRunService } from './security-run.service';

/**
 * REST surface for the security-inspection feature (SecurityProfile/SecurityRun).
 *
 * Sibling of the scenario-QA controller (qa-scenario.controller.ts): profile CRUD
 * + run dispatch + history. Run-result recording (record finding, complete) is
 * agent-driven via MCP tools, so it is intentionally not exposed over REST.
 * Reuses MANAGE_ACTIONS permission (same automation-authoring audience as
 * Actions / QA).
 */
@ApiBearerAuth('user-session')
@ApiTags('security')
@Controller('api/security')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_ACTIONS)
export class SecurityProfileController {
  constructor(
    private readonly profileService: SecurityProfileService,
    private readonly runService: SecurityRunService,
  ) {}

  // ── Profiles ──────────────────────────────────────────────────────────────

  @Get('profiles')
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('board_id') boardId: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    const rows = await this.profileService.list(workspaceId, boardId);
    return res.json(rows);
  }

  @Get('profiles/:id')
  async get(@Param('id') id: string, @Res() res: Response) {
    try {
      return res.json(await this.profileService.get(id));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'security profile not found' });
    }
  }

  @Post('profiles')
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const row = await this.profileService.create({ ...body, created_by: body?.created_by || user?.id || '' });
      return res.status(201).json(row);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to create security profile' });
    }
  }

  @Patch('profiles/:id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    try {
      return res.json(await this.profileService.update(id, body?.workspace_id, body));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to update security profile' });
    }
  }

  @Delete('profiles/:id')
  async remove(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      await this.profileService.remove(id, workspaceId);
      return res.json({ success: true, id });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to delete security profile' });
    }
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  // Start (or re-run) a profile. Re-run is the same call → a fresh SecurityRun.
  @Post('profiles/:id/run')
  async run(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const result = await this.runService.startRun({
        profileId: id,
        triggeredByType: 'user',
        triggeredById: user?.id || '',
      });
      return res.status(201).json({
        run_id: result.run.id,
        room_id: result.room_id,
        prompt: result.prompt,
      });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to start security run' });
    }
  }

  @Get('profiles/:id/runs')
  async listRuns(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const n = limit ? parseInt(limit, 10) : 20;
      const runs = await this.runService.listRuns(id, workspaceId, Number.isFinite(n) ? n : 20);
      return res.json(runs);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to list security runs' });
    }
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(await this.runService.getRun(runId, workspaceId));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'security run not found' });
    }
  }
}
