import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { BenchmarkService, RunActor } from './benchmark.service';

/**
 * Benchmark REST surface (ticket 684c012b + run lifecycle 5eb459c4).
 *
 *   POST  /api/benchmark/score                          — record/upsert one score
 *   GET   /api/benchmark/runs/:runTicketId/leaderboard  — per-run candidate table
 *   GET   /api/benchmark/leaderboard?workspace_id=…      — agent aggregate
 *
 * Run lifecycle (ticket 5eb459c4) — UI create/edit/start:
 *   POST  /api/benchmark/runs                — create a DRAFT run (candidates parked)
 *   GET   /api/benchmark/runs/:runId         — run detail (edit-form prefill)
 *   PATCH /api/benchmark/runs/:runId         — edit (Option-A policy enforced here)
 *   POST  /api/benchmark/runs/:runId/start   — start (dispatch parked candidates)
 *   POST  /api/benchmark/runs/:runId/candidates — add candidate(s)
 *
 * The Option-A fairness policy (started runs reject prompt/rubric/evaluator
 * changes + candidate removal, 422) lives in BenchmarkService.updateRun — the
 * controller just maps the thrown status onto the response.
 *
 * The MCP `submit_benchmark_score` tool is the primary write path for evaluator
 * agents; this POST endpoint is the human/UI/test equivalent over the same
 * service method.
 */
@ApiBearerAuth('user-session')
@ApiTags('benchmark')
@Controller('api/benchmark')
@UseGuards(AuthGuard)
export class BenchmarksController {
  constructor(private readonly benchmarkService: BenchmarkService) {}

  private actorFrom(user?: CurrentUserData): RunActor {
    return { id: user?.id || '', name: user?.name || '', type: 'user' };
  }

  @Post('score')
  async submitScore(@Body() body: any, @Res() res: Response) {
    try {
      const saved = await this.benchmarkService.upsertScore({
        candidate_ticket_id: body?.candidate_ticket_id,
        evaluator_agent_id: body?.evaluator_agent_id,
        dimension: body?.dimension,
        score: body?.score,
        rationale: body?.rationale,
        run_ticket_id: body?.run_ticket_id,
      });
      return res.status(201).json(saved);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to record score' });
    }
  }

  @Get('runs/:runTicketId/leaderboard')
  async runLeaderboard(@Param('runTicketId') runTicketId: string, @Res() res: Response) {
    const result = await this.benchmarkService.getRunLeaderboard(runTicketId);
    return res.json(result);
  }

  @Get('leaderboard')
  async agentLeaderboard(@Query('workspace_id') workspaceId: string, @Res() res: Response) {
    const result = await this.benchmarkService.getAgentLeaderboard(workspaceId || undefined);
    return res.json(result);
  }

  // ─── Run lifecycle (ticket 5eb459c4) ───────────────────────

  @Post('runs')
  async createRun(@Body() body: any, @CurrentUser() user: CurrentUserData, @Res() res: Response) {
    try {
      const detail = await this.benchmarkService.createDraftRun({
        board_id: body?.board_id,
        prompt: body?.prompt,
        title: body?.title,
        rubric: body?.rubric,
        base_repo: body?.base_repo,
        candidate_agent_ids: body?.candidate_agent_ids,
        evaluator_agent_ids: body?.evaluator_agent_ids,
        candidate_column_name: body?.candidate_column_name,
        actor: this.actorFrom(user),
      });
      return res.status(201).json(detail);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to create benchmark run' });
    }
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string, @Res() res: Response) {
    try {
      return res.json(await this.benchmarkService.getRunDetail(runId));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to load benchmark run' });
    }
  }

  @Patch('runs/:runId')
  async updateRun(
    @Param('runId') runId: string,
    @Body() body: any,
    @CurrentUser() user: CurrentUserData,
    @Res() res: Response,
  ) {
    try {
      const detail = await this.benchmarkService.updateRun(runId, {
        title: body?.title,
        prompt: body?.prompt,
        rubric: body?.rubric,
        base_repo: body?.base_repo,
        evaluator_agent_ids: body?.evaluator_agent_ids,
        candidate_agent_ids: body?.candidate_agent_ids,
        candidate_column_name: body?.candidate_column_name,
      }, this.actorFrom(user));
      return res.json(detail);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to update benchmark run' });
    }
  }

  @Post('runs/:runId/start')
  async startRun(@Param('runId') runId: string, @CurrentUser() user: CurrentUserData, @Res() res: Response) {
    try {
      return res.json(await this.benchmarkService.startRun(runId, this.actorFrom(user)));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to start benchmark run' });
    }
  }

  @Post('runs/:runId/candidates')
  async addCandidates(
    @Param('runId') runId: string,
    @Body() body: any,
    @CurrentUser() user: CurrentUserData,
    @Res() res: Response,
  ) {
    try {
      const ids = Array.isArray(body?.candidate_agent_ids)
        ? body.candidate_agent_ids
        : (body?.agent_id ? [body.agent_id] : []);
      const detail = await this.benchmarkService.addCandidates(runId, ids, this.actorFrom(user));
      return res.status(201).json(detail);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to add candidates' });
    }
  }
}
