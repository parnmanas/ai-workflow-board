import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../../common/guards/admin.guard';
import { RespawnStormDetectorService } from '../agents/respawn-storm-detector.service';

/**
 * Workflow-health dashboard (ticket ab06eac2) — read-only admin observability
 * for respawn storms, twins, and general workflow reliability. Sits alongside
 * `/api/diagnostics/memory` and mirrors the thin-controller / aggregation-on-
 * the-service shape of `/api/admin/stuck-tickets`.
 *
 * Endpoints:
 *   - GET /api/admin/workflow-health            → full rollup (optional ?board_id=)
 *   - GET /api/admin/workflow-health/storms     → tickets currently halted by a storm
 *   - GET /api/admin/workflow-health/respawns   → top (ticket,role) by quick-death count
 *
 * Shares the AdminGuard used by the rest of the /api/admin/* surface.
 */
@ApiBearerAuth('user-session')
@ApiTags('admin')
@Controller('api/admin/workflow-health')
@UseGuards(AdminGuard)
export class WorkflowHealthController {
  constructor(private readonly detector: RespawnStormDetectorService) {}

  @Get()
  async health(@Query('board_id') boardId: string | undefined, @Res() res: Response): Promise<Response> {
    const rollup = await this.detector.getWorkflowHealth({ boardId: boardId || undefined });
    return res.json(rollup);
  }

  @Get('storms')
  async storms(@Res() res: Response): Promise<Response> {
    const storms = await this.detector.listActiveStorms();
    return res.json({ storms });
  }

  @Get('respawns')
  async respawns(
    @Query('board_id') boardId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ): Promise<Response> {
    const parsedLimit = limit ? Math.max(1, Math.min(100, parseInt(limit, 10) || 10)) : 10;
    const rows = await this.detector.topRespawnCounts({ boardId: boardId || undefined, limit: parsedLimit });
    return res.json({ respawns: rows });
  }
}
