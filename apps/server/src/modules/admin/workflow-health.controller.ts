import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../../common/guards/admin.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator';
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
 *   - GET /api/admin/workflow-health/long-term-usage → all-time/장기 구간 누적 (rollup + live
 *                                                    merge, ticket 8d5c6f5d) — optional
 *                                                    ?from=&to= (YYYY-MM-DD, UTC-day aligned;
 *                                                    `from` 생략 = all-time). 항상 workspace
 *                                                    스코프 필요 (ticket 090abc77)
 *
 * `token_usage` is also folded into the main rollup response at the CONTROLLER
 * level (not inside RespawnStormDetectorService.getWorkflowHealth) so this
 * ticket's changes stay isolated from that method's existing sub-rollups.
 * Mirrors that method's per-sub-rollup defensiveness: a failing usage query
 * degrades `token_usage` to null on the combined rollup rather than 500-ing
 * the whole dashboard. `long_term_usage` is deliberately NOT folded in —
 * unlike the windowed stats, an all-time aggregate doesn't need the main
 * rollup's 15s poll cadence, so it stays a standalone on-demand endpoint.
 *
 * Shares the AdminGuard used by the rest of the /api/admin/* surface.
 * `long-term-usage` additionally needs WorkspaceGuard (`getLongTermUsageStats`
 * is workspace-scoped, unlike the rest of this controller) — admins get the
 * guard's bypass branch, so it still resolves purely from the ambient
 * `X-Workspace-Id` header / `?workspace_id=` without a membership check.
 */
@ApiBearerAuth('user-session')
@ApiTags('admin')
@Controller('api/admin/workflow-health')
@UseGuards(AdminGuard, WorkspaceGuard)
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

  @Get('long-term-usage')
  async longTermUsage(
    @CurrentWorkspaceId() workspaceId: string | null,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: Response,
  ): Promise<Response> {
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspace_id required (X-Workspace-Id header or ?workspace_id=)' });
    }
    const fromDate = from ? new Date(from) : undefined;
    if (fromDate && Number.isNaN(fromDate.getTime())) {
      return res.status(400).json({ error: 'from must be a valid date (YYYY-MM-DD)' });
    }
    const toDate = to ? new Date(to) : undefined;
    if (toDate && Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'to must be a valid date (YYYY-MM-DD)' });
    }
    const stats = await this.usage.getLongTermUsageStats({ workspaceId, from: fromDate, to: toDate });
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
