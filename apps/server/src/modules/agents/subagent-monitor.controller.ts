import { Controller, Get, Post, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { SubagentMonitorService } from '../../services/subagent-monitor.service';

/**
 * Two route families on one controller — same auth split as fs-browser:
 *   - /api/subagent-monitor/* (user session) — list + transcript for the web UI
 *   - /api/agent-subagents/* (X-Agent-Key) — plugin → server lifecycle/log POSTs
 *
 * Records are persisted in the `subagents` + `subagent_log_lines` tables and
 * driven by SubagentMonitorService. The `expires_at` fence handles retention:
 *   - end POST stamps it directly (process exited cleanly).
 *   - reconcile POST stamps it for any subagent the plugin no longer reports
 *     as alive (covers crashes / lost taps / proxy restarts).
 *   - sweep DELETEs the row + lines once `now > expires_at`.
 */
@ApiTags('subagent-monitor')
@Controller()
export class SubagentMonitorController {
  constructor(private readonly svc: SubagentMonitorService) {}

  // ─── User-facing ──────────────────────────────────────────────────

  @ApiBearerAuth('user-session')
  @Get('api/subagent-monitor/workspaces/:workspaceId')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'List active + recently-ended subagents in a workspace' })
  async listForWorkspace(@Param('workspaceId') workspaceId: string, @Res() res: Response) {
    const list = await this.svc.listForWorkspace(workspaceId);
    return res.json(list);
  }

  @ApiBearerAuth('user-session')
  @Get('api/subagent-monitor/:subagentId')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get a subagent\'s recorded transcript (full DB-backed log)' })
  async getTranscript(
    @Param('subagentId') subagentId: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const t = await this.svc.getTranscript(subagentId, workspaceId);
    if (!t) return res.status(404).json({ error: 'Subagent not found in this workspace' });
    return res.json(t);
  }

  // ─── Plugin-facing ────────────────────────────────────────────────

  @Post('api/agent-subagents')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({ summary: 'Plugin → server: register a freshly-spawned subagent' })
  async register(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const agentId = this._agentId(req);
    if (!agentId) return res.status(401).json({ error: 'Could not resolve agent from API key' });

    const { subagent_id, kind, session_key, pid, started_at, label, ticket_id, ticket_title, role } = body || {};
    // workspace_id falls back to the API key's bound workspace when the
    // plugin doesn't pass it explicitly (the plugin doesn't always know it).
    const workspaceId = body?.workspace_id || (req as any).currentWorkspaceId;
    if (!subagent_id || !kind || !workspaceId) {
      return res.status(400).json({ error: 'subagent_id, kind, and workspace_id (or workspace-bound key) are required' });
    }
    const rec = await this.svc.register({
      subagent_id,
      agent_id: agentId,
      workspace_id: workspaceId,
      kind,
      session_key: session_key || '',
      pid: pid || 0,
      started_at,
      label,
      ticket_id: typeof ticket_id === 'string' && ticket_id ? ticket_id : undefined,
      ticket_title: typeof ticket_title === 'string' && ticket_title ? ticket_title : undefined,
      role: typeof role === 'string' && role ? role : undefined,
    });
    return res.status(201).json({ subagent_id: rec.subagent_id });
  }

  @Post('api/agent-subagents/reconcile')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({ summary: 'Plugin → server: report current live subagent_ids; missing ones are marked ended' })
  async reconcile(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const agentId = this._agentId(req);
    if (!agentId) return res.status(401).json({ error: 'Could not resolve agent from API key' });
    const live = Array.isArray(body?.live_subagent_ids) ? body.live_subagent_ids : null;
    if (!live) return res.status(400).json({ error: 'body.live_subagent_ids must be an array' });
    const result = await this.svc.reconcile(agentId, live);
    return res.json(result);
  }

  @Post('api/agent-subagents/:subagentId/lines')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({ summary: 'Plugin → server: batch-append stream-json lines for a subagent' })
  async appendLines(
    @Param('subagentId') subagentId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const agentId = this._agentId(req);
    if (!agentId) return res.status(401).json({ error: 'Could not resolve agent from API key' });
    const lines = Array.isArray(body?.lines) ? body.lines : null;
    if (!lines) return res.status(400).json({ error: 'body.lines must be an array' });
    const result = await this.svc.appendLines(subagentId, agentId, lines);
    if (!result.ok) return res.status(404).json({ error: result.reason });
    return res.status(204).send();
  }

  @Post('api/agent-subagents/:subagentId/end')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({ summary: 'Plugin → server: mark a subagent as ended' })
  async end(
    @Param('subagentId') subagentId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const agentId = this._agentId(req);
    if (!agentId) return res.status(401).json({ error: 'Could not resolve agent from API key' });
    const result = await this.svc.end({
      subagent_id: subagentId,
      agent_id: agentId,
      exit_code: body?.exit_code,
      signal: body?.signal,
    });
    if (!result.ok) return res.status(404).json({ error: result.reason });
    return res.status(204).send();
  }

  private _agentId(req: Request): string | null {
    const auth = (req as any).apiKey;
    if (auth?.agent_id) return auth.agent_id;
    const scoped = (req as any).currentAgentId;
    return typeof scoped === 'string' && scoped ? scoped : null;
  }
}
