import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { BenchmarkService } from './benchmark.service';

/**
 * Benchmark REST surface (ticket 684c012b).
 *
 *   POST /api/benchmark/score                          — record/upsert one score
 *   GET  /api/benchmark/runs/:runTicketId/leaderboard  — per-run candidate table
 *   GET  /api/benchmark/leaderboard?workspace_id=…      — agent aggregate
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
}
