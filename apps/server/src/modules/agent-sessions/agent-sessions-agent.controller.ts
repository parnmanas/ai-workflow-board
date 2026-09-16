import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AgentSessionError, AgentSessionsService } from './agent-sessions.service';

/**
 * agent-manager 표면(`X-Agent-Key`, 매니저 자신의 키). 호출자 identity 는
 * AgentAuthGuard 가 찍은 currentAgentId 이며, 경로/바디의 manager_id 와 일치해야 한다.
 * dev 모드(AGENT_DEV_MODE, 키 검증 생략)에서는 나머지 /api/agent/* 표면과 같은
 * 규약으로 body.manager_id 를 identity 로 받는다.
 */
@ApiTags('agent-sessions')
@Controller('api/agent/sessions')
@UseGuards(AgentAuthGuard)
export class AgentSessionsAgentController {
  constructor(private readonly sessions: AgentSessionsService) {}

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
      if (err instanceof AgentSessionError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  }

  /** CLI 설정으로 이 매니저에 묶인 credential 의 원문. `?workspace_id=` 필수. 비밀이므로 no-store. */
  @Get('credential/:credentialId')
  async credential(
    @Param('credentialId') credentialId: string,
    @Query('workspace_id') workspaceId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const caller = this.callerId(req);
    if (!caller) return res.status(401).json({ error: 'manager_identity_required' });
    try {
      const material = await this.sessions.getSessionCredential(caller, credentialId, String(workspaceId || '').trim());
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(material);
    } catch (err) {
      if (err instanceof AgentSessionError) return res.status(err.status).json({ error: err.code, message: err.message });
      throw err;
    }
  }

  /** `{ manager_id, ok, result?, error?, code? }` — list/history/open RPC 응답. */
  @Post('rpc/:requestId')
  async rpc(@Param('requestId') requestId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const caller = this.callerId(req);
    if (!caller) return res.status(401).json({ error: 'manager_identity_required' });
    const outcome = this.sessions.resolveRpc(requestId, caller, body ?? {});
    if (!outcome.ok) return res.status(404).json({ error: outcome.reason });
    return res.status(200).json({ ok: true });
  }

  /** `{ manager_id, events: [...], state?: {...} }` — 라이브 스트림 중계(저장 없음). */
  @Post(':managerId/:cli/:sessionId/events')
  async events(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.guard(req, res, managerId)) return;
    return this.run(res, () => this.sessions.relayEvents(managerId, cli, sessionId, body?.events, body?.state ?? null));
  }

  /** `{ manager_id, status?, cwd?, title?, current_mode?, available_modes?, resume_supported?, last_error?, reason? }` */
  @Patch(':managerId/:cli/:sessionId')
  async state(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.guard(req, res, managerId)) return;
    const { manager_id: _ignored, ...patch } = body ?? {};
    return this.run(res, () => ({ ok: true, live: this.sessions.applyState(managerId, cli, sessionId, patch) }));
  }
}
