import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AgentLogsService } from './agent-logs.service';

@Controller('api/agent/error-logs')
@UseGuards(AgentAuthGuard)
export class AgentLogsUploadController {
  constructor(private readonly service: AgentLogsService) {}

  @Post()
  async upload(@Body() body: any, @Res() res: Response) {
    const { agent_id, workspace_id, plugin_version, entries } = body || {};
    if (!agent_id || !Array.isArray(entries)) {
      return res.status(400).json({ error: 'agent_id + entries required' });
    }
    try {
      const result = await this.service.ingestEntries(
        agent_id, workspace_id ?? null, plugin_version ?? null, entries,
      );
      return res.json(result);
    } catch (err: any) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }
}
