import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response, Request } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { QaService } from './qa.service';
import { QaRunService } from './qa-run.service';
import { QaRunReaperService } from './qa-run-reaper.service';
import { QaRunBatch } from '../../entities/QaRunBatch';

/**
 * Normalize a QaRunBatch row for the client: coalesce the nullable simple-json
 * columns to [] and surface `total` (= scenario count) so the progress UI has a
 * stable shape. Mirrors batchToJson in the MCP qa-tools.
 */
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

/**
 * REST surface for the scenario-based QA feature (QaScenario/QaRun).
 *
 * NOTE: distinct from the existing self-test harness at `api/admin/qa`
 * (qa.controller.ts) which runs AWB's own integration flows. This controller
 * is the first-class, board-facing QA feature: scenario CRUD + run dispatch +
 * history. Mirrors ActionsController. Run-result recording (record step,
 * complete) is agent-driven via MCP tools, so it is intentionally not exposed
 * over REST. Reuses MANAGE_ACTIONS permission (same automation-authoring
 * audience as Actions).
 */
@ApiBearerAuth('user-session')
@ApiTags('qa')
@Controller('api/qa')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_ACTIONS)
export class QaScenarioController {
  constructor(
    private readonly qaService: QaService,
    private readonly qaRunService: QaRunService,
    private readonly qaRunReaperService: QaRunReaperService,
  ) {}

  // ── Scenarios ─────────────────────────────────────────────────────────────

  @Get('scenarios')
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('board_id') boardId: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    const rows = await this.qaService.list(workspaceId, boardId);
    return res.json(rows);
  }

  @Get('scenarios/:id')
  async get(@Param('id') id: string, @Res() res: Response) {
    try {
      return res.json(await this.qaService.get(id));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'QA scenario not found' });
    }
  }

  @Post('scenarios')
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const row = await this.qaService.create({ ...body, created_by: body?.created_by || user?.id || '' });
      return res.status(201).json(row);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to create QA scenario' });
    }
  }

  @Patch('scenarios/:id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    try {
      return res.json(await this.qaService.update(id, body?.workspace_id, body));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to update QA scenario' });
    }
  }

  @Delete('scenarios/:id')
  async remove(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      await this.qaService.remove(id, workspaceId);
      return res.json({ success: true, id });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to delete QA scenario' });
    }
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  // Start (or re-run) a scenario. Re-run is the same call → a fresh QaRun.
  @Post('scenarios/:id/run')
  async run(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const result = await this.qaRunService.startQaRun({
        scenarioId: id,
        triggeredByType: 'user',
        triggeredById: user?.id || '',
      });
      return res.status(201).json({
        run_id: result.run.id,
        room_id: result.room_id,
        prompt: result.prompt,
      });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to start QA run' });
    }
  }

  @Get('scenarios/:id/runs')
  async listRuns(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const n = limit ? parseInt(limit, 10) : 20;
      const runs = await this.qaRunService.listRuns(id, workspaceId, Number.isFinite(n) ? n : 20);
      return res.json(runs);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to list QA runs' });
    }
  }

  // Operator lever: fire one reaper sweep on demand (no server restart needed
  // once the code is live). Closes any QaRun stuck non-terminal whose driver
  // died — see QaRunReaperService for the two fuses (zero-progress / 6h-TTL).
  @Post('runs/reap')
  async reap(@Res() res: Response) {
    try {
      const { reaped, details } = await this.qaRunReaperService.runOnce();
      return res.json({ reaped_count: reaped.length, reaped, details });
    } catch (e: any) {
      return res.status(e?.status || 500).json({ error: e?.message || 'Failed to run QA reaper sweep' });
    }
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(await this.qaRunService.getRun(runId, workspaceId));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'QA run not found' });
    }
  }

  // ── Batches (sequential multi-scenario runs) ────────────────────────────────

  // Start a sequential batch. Body: { workspace_id, board_id?, scenario_ids?[],
  // all?, stop_on_fail? }. Only index 0 dispatches now; the rest are dispatched
  // one-at-a-time as each run finalizes (see QaRunService.onRunFinalized).
  @Post('batches')
  async startBatch(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string } | undefined;
      const batch = await this.qaRunService.startBatch({
        workspaceId: body?.workspace_id,
        boardId: body?.board_id ?? undefined,
        scenarioIds: Array.isArray(body?.scenario_ids) ? body.scenario_ids : undefined,
        all: !!body?.all,
        stopOnFail: !!body?.stop_on_fail,
        triggeredByType: 'user',
        triggeredById: user?.id || '',
      });
      return res.status(201).json(batchToJson(batch));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to start QA batch' });
    }
  }

  @Get('batches/:id')
  async getBatch(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(batchToJson(await this.qaRunService.getBatch(id, workspaceId)));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'QA batch not found' });
    }
  }
}
