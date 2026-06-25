import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response, Request } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { SecurityProfileService } from './security-profile.service';
import { SecurityRunService } from './security-run.service';
import { SecurityScheduleService } from './security-schedule.service';
import { SecurityRunBatch } from '../../entities/SecurityRunBatch';
import { SecuritySchedule } from '../../entities/SecuritySchedule';

/**
 * Normalize a SecurityRunBatch row for the client: coalesce the nullable
 * simple-json columns to [] and surface `total` (= profile count) so the
 * progress UI has a stable shape. Mirrors batchToJson in the MCP security-tools.
 */
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
    triggered_by_type: b.triggered_by_type,
    triggered_by_id: b.triggered_by_id,
    finished_at: b.finished_at,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

/**
 * Normalize a SecuritySchedule row for the client: coalesce the nullable
 * simple-json column to [] so the editor has a stable shape. Mirrors
 * scheduleToJson in the MCP security-schedule tools.
 */
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

/**
 * REST surface for the security-inspection feature (SecurityProfile/SecurityRun).
 *
 * Sibling of the scenario-QA controller (qa-scenario.controller.ts): profile CRUD
 * + run dispatch + history + sequential batches + schedules. Run-result recording
 * (record finding, complete) is agent-driven via MCP tools, so it is
 * intentionally not exposed over REST. Reuses MANAGE_ACTIONS permission (same
 * automation-authoring audience as Actions / QA).
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
    private readonly scheduleService: SecurityScheduleService,
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

  // Dispatch a "refresh the checklist with the latest security info" task to the
  // profile's target agent. The agent WebSearches current OWASP/stack-CVE/Node
  // guidance and writes it back via update_security_profile. No SecurityRun row.
  @Post('profiles/:id/refresh-checklist')
  async refreshChecklist(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const result = await this.runService.startChecklistRefresh({
        profileId: id,
        triggeredByType: 'user',
        triggeredById: user?.id || '',
      });
      return res.status(201).json({
        profile_id: result.profile_id,
        room_id: result.room_id,
        prompt: result.prompt,
      });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to start checklist refresh' });
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

  // ── Batches (수동 전체 점검 — sequential multi-profile runs) ───────────────────

  // Start a sequential batch. Body: { workspace_id, board_id?, profile_ids?[],
  // all?, stop_on_fail? }. Only index 0 dispatches now; the rest are dispatched
  // one-at-a-time as each run finalizes (see SecurityRunService.onRunFinalized).
  @Post('batches')
  async startBatch(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const batch = await this.runService.startBatch({
        workspaceId: body?.workspace_id,
        boardId: body?.board_id ?? undefined,
        profileIds: Array.isArray(body?.profile_ids) ? body.profile_ids : undefined,
        all: !!body?.all,
        stopOnFail: !!body?.stop_on_fail,
        triggeredByType: 'user',
        triggeredById: user?.id || '',
      });
      return res.status(201).json(batchToJson(batch));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to start security batch' });
    }
  }

  @Get('batches/:id')
  async getBatch(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(batchToJson(await this.runService.getBatch(id, workspaceId)));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'security batch not found' });
    }
  }

  // ── Schedules (automatic batch trigger layer) ────────────────────────────────

  @Get('schedules')
  async listSchedules(
    @Query('workspace_id') workspaceId: string,
    @Query('board_id') boardId: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    try {
      const rows = await this.scheduleService.list(workspaceId, boardId);
      return res.json(rows.map(scheduleToJson));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to list security schedules' });
    }
  }

  @Get('schedules/:id')
  async getSchedule(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(scheduleToJson(await this.scheduleService.get(id, workspaceId)));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'security schedule not found' });
    }
  }

  @Post('schedules')
  async createSchedule(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const row = await this.scheduleService.create({
        workspaceId: body?.workspace_id,
        boardId: body?.board_id ?? undefined,
        name: body?.name,
        scope: body?.scope,
        profileIds: body?.profile_ids,
        cron: body?.cron,
        intervalMs: body?.interval_ms,
        enabled: body?.enabled,
        stopOnFail: body?.stop_on_fail,
        createdBy: body?.created_by || user?.id || '',
      });
      return res.status(201).json(scheduleToJson(row));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to create security schedule' });
    }
  }

  @Patch('schedules/:id')
  async updateSchedule(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    try {
      const row = await this.scheduleService.update(id, body?.workspace_id, {
        boardId: body?.board_id,
        name: body?.name,
        scope: body?.scope,
        profileIds: body?.profile_ids,
        cron: body?.cron,
        intervalMs: body?.interval_ms,
        enabled: body?.enabled,
        stopOnFail: body?.stop_on_fail,
      });
      return res.json(scheduleToJson(row));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to update security schedule' });
    }
  }

  @Delete('schedules/:id')
  async removeSchedule(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      await this.scheduleService.remove(id, workspaceId);
      return res.json({ success: true, id });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to delete security schedule' });
    }
  }

  // Manual immediate trigger — dispatch the schedule's batch now (ignores
  // enabled; does not disturb next_run_at). Returns the schedule + started batch.
  @Post('schedules/:id/run-now')
  async runScheduleNow(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const { schedule, batch } = await this.scheduleService.runNow(id, body?.workspace_id, user?.id || '');
      return res.status(201).json({ schedule: scheduleToJson(schedule), batch: batchToJson(batch) });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to run security schedule' });
    }
  }

  // Operator lever / deterministic test hook: fire ONE scheduler sweep on demand
  // (no server restart, no waiting for the background tick). Dispatches every due
  // schedule's batch and advances its next_run_at. Returns the dispatched/skipped
  // schedule ids — the same shape SecurityScheduleService.runOnce returns.
  @Post('schedules/tick')
  async tickSchedules(@Res() res: Response) {
    try {
      const { dispatched, skipped } = await this.scheduleService.runOnce();
      return res.json({ dispatched, skipped });
    } catch (e: any) {
      return res.status(e?.status || 500).json({ error: e?.message || 'Failed to run security scheduler sweep' });
    }
  }
}
