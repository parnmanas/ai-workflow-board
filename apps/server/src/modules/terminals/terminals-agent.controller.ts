import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { TerminalError, TerminalsService } from './terminals.service';

/**
 * agent-manager 표면(`X-Agent-Key`, 매니저 자신의 키). agent-sessions 와 같은 규약:
 * 호출자 identity 는 AgentAuthGuard 가 찍은 currentAgentId 이며 경로/바디의 manager_id 와
 * 일치해야 한다. dev 모드(AGENT_DEV_MODE)에서는 body/query 의 manager_id 를 identity 로 받는다.
 */
@ApiTags('terminals')
@Controller('api/agent/terminals')
@UseGuards(AgentAuthGuard)
export class TerminalsAgentController {
  constructor(private readonly terminals: TerminalsService) {}

  private callerId(req: Request): string {
    const stamped = (req as any).currentAgentId as string | undefined;
    const bodyClaim = typeof (req.body as any)?.manager_id === 'string' ? (req.body as any).manager_id : '';
    const queryClaim = typeof (req.query as any)?.manager_id === 'string' ? String((req.query as any).manager_id) : '';
    const claimed = bodyClaim || queryClaim;
    return stamped || (!(req as any).apiKey && claimed ? claimed : '');
  }

  private guard(req: Request, res: Response, managerId: string): boolean {
    const caller = this.callerId(req);
    if (!caller) {
      res.status(401).json({ error: 'manager_identity_required', message: 'A Runtime Host API key (or manager_id in dev mode) is required' });
      return false;
    }
    if (caller !== managerId) {
      res.status(403).json({ error: 'manager_mismatch', message: 'API key identity does not match manager_id' });
      return false;
    }
    return true;
  }

  private run(res: Response, fn: () => unknown) {
    try {
      return res.status(200).json(fn());
    } catch (err) {
      if (err instanceof TerminalError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  }

  /** `{ manager_id, ok, result?, error?, code? }` — list/open/attach RPC 응답. */
  @Post('rpc/:requestId')
  async rpc(@Param('requestId') requestId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const caller = this.callerId(req);
    if (!caller) return res.status(401).json({ error: 'manager_identity_required' });
    const outcome = this.terminals.resolveRpc(requestId, caller, body ?? {});
    if (!outcome.ok) return res.status(404).json({ error: outcome.reason });
    return res.status(200).json({ ok: true });
  }

  /** `{ manager_id, chunks: [{ seq, data(base64), created_at }], state?: {...} }` — PTY 출력 중계(저장 없음). */
  @Post(':managerId/:terminalId/output')
  async output(
    @Param('managerId') managerId: string,
    @Param('terminalId') terminalId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.guard(req, res, managerId)) return;
    return this.run(res, () => this.terminals.relayOutput(managerId, terminalId, body?.chunks, body?.state ?? null));
  }

  /** `{ manager_id, status?, cwd?, title?, cols?, rows?, pid?, exit_code?, last_error?, reason? }` */
  @Patch(':managerId/:terminalId')
  async state(
    @Param('managerId') managerId: string,
    @Param('terminalId') terminalId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.guard(req, res, managerId)) return;
    const { manager_id: _ignored, ...patch } = body ?? {};
    return this.run(res, () => ({ ok: true, terminal: this.terminals.applyState(managerId, terminalId, patch) }));
  }
}
