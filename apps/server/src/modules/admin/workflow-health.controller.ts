import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../../common/guards/admin.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator';
import { AgentUsageService } from '../agents/agent-usage.service';

/**
 * Workflow-health dashboard — read-only admin usage observability. Only the
 * usage rollups remain (docs/tickets.md → Workflow health): the respawn-storm
 * detector, and with it the storms / respawns / suppressions endpoints and
 * the `?board_id=` filter, were removed together with boards.
 *
 * Endpoints:
 *   - GET /api/admin/workflow-health              → `{ generated_at, window_minutes, token_usage }`
 *   - GET /api/admin/workflow-health/token-usage  → windowed token/cost usage rollup off the
 *                                                    `subagents` table (ticket 6dd3f968)
 *   - GET /api/admin/workflow-health/long-term-usage → all-time/장기 구간 누적 (rollup + live
 *                                                    merge, ticket 8d5c6f5d) — optional
 *                                                    ?from=&to= (YYYY-MM-DD, UTC-day aligned;
 *                                                    `from` 생략 = all-time). 항상 workspace
 *                                                    스코프 필요 (ticket 090abc77)
 *
 * The main rollup degrades `token_usage` to null on a failing usage query
 * rather than 500-ing the whole dashboard. `long_term_usage` is deliberately
 * NOT folded in — an all-time aggregate doesn't need the main rollup's 15s
 * poll cadence, so it stays a standalone on-demand endpoint.
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
  constructor(private readonly usage: AgentUsageService) {}

  @Get()
  async health(@Res() res: Response): Promise<Response> {
    const tokenUsage = await this.usage.getTokenUsageStats().catch(() => null);
    return res.json({
      generated_at: new Date().toISOString(),
      window_minutes: tokenUsage?.window_minutes ?? this.usage.windowMinutes,
      token_usage: tokenUsage,
    });
  }

  @Get('token-usage')
  async tokenUsage(@Res() res: Response): Promise<Response> {
    const stats = await this.usage.getTokenUsageStats();
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
}
