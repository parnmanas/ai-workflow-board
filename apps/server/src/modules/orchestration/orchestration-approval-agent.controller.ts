import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { OrchestrationApprovalService, type ApprovalHostCaller } from './orchestration-approval.service';

function callerOf(req: Request): ApprovalHostCaller {
  const r = req as any;
  return {
    accountId: r.currentAccountId || null,
    runtimeKey: r.currentRuntimeKey || null,
    hostId: r.currentHostId || null,
  };
}

function fail(res: Response, e: any, fallback: string) {
  return res.status(e?.status || 500).json({ error: e?.message || fallback });
}

/**
 * Runtime Host half of mission tool approvals (docs/orchestration.md → "실행 승인").
 *
 * A CLI running a mission room at `approve` trust raises a permission prompt; the manager posts it
 * here, long-polls `wait` until someone answers, and hands the answer back to the CLI. The body's
 * `agent_id` is the runtime the prompt came from — a runtime key may only speak for itself, a
 * manager key for the runtimes on its own host (checked in the service).
 */
@Controller('api/agent/orchestration/approvals')
@UseGuards(AgentAuthGuard)
export class OrchestrationApprovalAgentController {
  constructor(private readonly approvals: OrchestrationApprovalService) {}

  @Post()
  async request(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(201).json(await this.approvals.request(body ?? {}, callerOf(req)));
    } catch (e: any) {
      return fail(res, e, 'Failed to request approval');
    }
  }

  @Get(':id/wait')
  async wait(
    @Param('id') id: string,
    @Query('agent_id') agentId: string,
    @Query('timeout_ms') timeoutMs: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const parsed = parseInt(timeoutMs, 10);
      return res.json(await this.approvals.wait(id, String(agentId || ''), callerOf(req), Number.isFinite(parsed) ? parsed : NaN));
    } catch (e: any) {
      return fail(res, e, 'Failed to read the approval');
    }
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.json(await this.approvals.cancelByRequester(id, String(body?.agent_id || ''), callerOf(req), String(body?.reason || '')));
    } catch (e: any) {
      return fail(res, e, 'Failed to cancel the approval');
    }
  }
}
