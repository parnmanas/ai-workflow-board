import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AgentLogsService } from './agent-logs.service';

@ApiBearerAuth('user-session')
@ApiTags('agent-logs-admin')
@Controller('api/admin/agent-logs')
@UseGuards(AdminGuard)
export class AgentLogsAdminController {
  constructor(private readonly service: AgentLogsService) {}

  @Get()
  async list(
    @Query('agent_id') agentId: string | undefined,
    @Query('level') level: string | undefined,
    @Query('category') category: string | undefined,
    @Query('since') since: string | undefined,
    @Query('until') until: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    const rows = await this.service.list({
      agent_id: agentId,
      level,
      category,
      since: since ? new Date(since) : undefined,
      until: until ? new Date(until) : undefined,
      limit: limit ? Math.min(parseInt(limit, 10) || 100, 500) : 100,
    });
    return res.json(rows);
  }

  @Get('agents')
  async agents(@Res() res: Response) {
    return res.json(await this.service.listAgentsWithRecentErrors(7));
  }
}
