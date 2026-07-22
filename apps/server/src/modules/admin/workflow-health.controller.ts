import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../../common/guards/admin.guard';
import { RespawnStormDetectorService } from '../agents/respawn-storm-detector.service';
import { AgentUsageService } from '../agents/agent-usage.service';

/**
 * Workflow-health dashboard (ticket ab06eac2) — read-only admin observability
 * for respawn storms, twins, and general workflow reliability. Sits alongside
 * `/api/diagnostics/memory` and mirrors the thin-controller / aggregation-on-
 * the-service shape of `/api/admin/stuck-tickets`.
 *
 * Endpoints:
 *   - GET /api/admin/workflow-health              → full rollup (optional ?board_id=)
 *   - GET /api/admin/workflow-health/storms       → tickets currently halted by a storm
 *   - GET /api/admin/workflow-health/respawns     → top (ticket,role) by quick-death count
 *   - GET /api/admin/workflow-health/suppressions → cumulative respawn-storm halts +
 *                                                    comment-pingpong suppressions by reason
 *                                                    (ticket 3970db66)
 *   - GET /api/admin/workflow-health/token-usage  → windowed token/cost usage rollup off the
 *                                                    `subagents` table, + suppression-derived
 *                                                    savings estimate (optional ?board_id=,
 *                                                    ticket 6dd3f968)
 *
 * `token_usage` is also folded into the main rollup response at the CONTROLLER
 * level (not inside RespawnStormDetectorService.getWorkflowHealth) so this
 * ticket's changes stay isolated from that method's existing sub-rollups.
 * Mirrors that method's per-sub-rollup defensiveness: a failing usage query
 * degrades `token_usage` to null on the combined rollup rather than 500-ing
 * the whole dashboard.
 *
 * Shares the AdminGuard used by the rest of the /api/admin/* surface.
 */
@ApiBearerAuth('user-session')
@ApiTags('admin')
@Controller('api/admin/workflow-health')
@UseGuards(AdminGuard)
export class WorkflowHealthController {
  constructor(
    private readonly detector: RespawnStormDetectorService,
    private readonly usage: AgentUsageService,
  ) {}

  @Get()
  async health(@Query('board_id') boardId: string | undefined, @Res() res: Response): Promise<Response> {
    const rollup = await this.detector.getWorkflowHealth({ boardId: boardId || undefined });
    const tokenUsage = await this.usage.getTokenUsageStats({ boardId: boardId || undefined }).catch(() => null);
    return res.json({ ...rollup, token_usage: tokenUsage });
  }

  @Get('token-usage')
  async tokenUsage(@Query('board_id') boardId: string | undefined, @Res() res: Response): Promise<Response> {
    const stats = await this.usage.getTokenUsageStats({ boardId: boardId || undefined });
    return res.json(stats);
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

  @Get('suppressions')
  async suppressions(@Res() res: Response): Promise<Response> {
    const stats = await this.detector.getSuppressionStats();
    return res.json(stats);
  }
}
