import { ApiTags, ApiSecurity } from '@nestjs/swagger';
import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AgentLogsService } from './agent-logs.service';

@ApiSecurity('agent-api-key')
@ApiTags('agent-logs-upload')
@Controller('api/agent/error-logs')
@UseGuards(AgentAuthGuard)
export class AgentLogsUploadController {
  constructor(private readonly service: AgentLogsService) {}

  @Post()
  async upload(@Body() body: any, @Res() res: Response, @Req() req: any) {
    const { agent_id, account_id, plugin_version, entries } = body || {};
    if (!agent_id || !Array.isArray(entries)) {
      return res.status(400).json({ error: 'agent_id + entries required' });
    }
    if (!req.currentAccountId || (account_id && account_id !== req.currentAccountId)
      || (agent_id !== req.currentAgentId && agent_id !== req.currentHostId)) {
      return res.status(403).json({ error: 'account_access_denied' });
    }
    try {
      const result = await this.service.ingestEntries(
        agent_id, req.currentAccountId, plugin_version ?? null, entries,
      );
      return res.json(result);
    } catch (err: any) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // Read-side companion to the upload path. Agents can ask the server what
  // errors another agent (or themselves) has reported — useful when one agent
  // is diagnosing a peer's crash loop and doesn't have shell access to the
  // peer's proxy.log. Queries are restricted to the authenticated account.
  @Get()
  async query(
    @Query('agent_id') agentId: string | undefined,
    @Query('level') level: string | undefined,
    @Query('category') category: string | undefined,
    @Query('since') since: string | undefined,
    @Query('until') until: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
    @Req() req: any,
  ) {
    const rows = await this.service.list({
      account_ids: req.currentAccountId ? [req.currentAccountId] : [],
      agent_id: agentId,
      level,
      category,
      since: since ? new Date(since) : undefined,
      until: until ? new Date(until) : undefined,
      limit: limit ? Math.min(parseInt(limit, 10) || 100, 500) : 100,
    });
    return res.json(rows);
  }
}
