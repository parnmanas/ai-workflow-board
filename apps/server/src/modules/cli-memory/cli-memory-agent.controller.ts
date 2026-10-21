import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { CliMemoryService } from './cli-memory.service';

/**
 * agent-manager 표면(`X-Agent-Key`, 매니저 자신의 키). terminals 와 같은 규약: 호출자 identity 는
 * AgentAuthGuard 가 찍은 currentAgentId 이고, dev 모드(AGENT_DEV_MODE)에서는 body 의 manager_id 다.
 */
@ApiTags('cli-memory')
@Controller('api/agent/cli-memory')
@UseGuards(AgentAuthGuard)
export class CliMemoryAgentController {
  constructor(private readonly memory: CliMemoryService) {}

  private callerId(req: Request): string {
    const stamped = (req as any).currentAgentId as string | undefined;
    const claimed = typeof (req.body as any)?.manager_id === 'string' ? (req.body as any).manager_id : '';
    return stamped || (!(req as any).apiKey && claimed ? claimed : '');
  }

  /** `{ manager_id, ok, result?, error?, code? }` — 모든 메모리 op 의 응답. */
  @Post('rpc/:requestId')
  async rpc(@Param('requestId') requestId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const caller = this.callerId(req);
    if (!caller) return res.status(401).json({ error: 'manager_identity_required' });
    const outcome = this.memory.resolveRpc(requestId, caller, body ?? {});
    if (!outcome.ok) return res.status(404).json({ error: outcome.reason });
    return res.status(200).json({ ok: true });
  }
}
