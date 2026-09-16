import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { AgentSessionError, AgentSessionsService } from './agent-sessions.service';

/**
 * agent-manager 표면(`X-Agent-Key`). 매니저는 세션의 agent 키(또는 자기 매니저
 * 키)로 ACP 스트림을 append 하고 세션 상태를 patch 한다. 워크스페이스 스코프
 * 키는 agent-api 와 같은 규칙으로 대조한다(스코프 밖이면 403).
 */
@ApiTags('agent-sessions')
@Controller('api/agent/sessions')
@UseGuards(AgentAuthGuard)
export class AgentSessionsAgentController {
  constructor(private readonly sessions: AgentSessionsService) {}

  private async resolve(req: Request, res: Response, sessionId: string) {
    // AgentAuthGuard 가 DB 키를 검증했으면 currentAgentId 가 있다. dev 모드
    // (AGENT_DEV_MODE) / 정적 AGENT_API_KEY 경로는 키 검증을 건너뛰어 identity 가
    // 없으므로, 그때만 나머지 /api/agent/* 표면과 같은 규약으로 body.agent_id 를
    // 호출자 identity 로 받는다(그 모드는 어차피 전체 신뢰).
    const stamped = (req as any).currentAgentId as string | undefined;
    const claimed = typeof (req.body as any)?.agent_id === 'string' ? (req.body as any).agent_id : '';
    const callerAgentId = stamped || (!(req as any).apiKey && claimed ? claimed : '');
    if (!callerAgentId) {
      res.status(401).json({ error: 'agent_identity_required', message: 'An agent-bound API key (or agent_id in dev mode) is required' });
      return null;
    }
    const session = await this.sessions.getForAgentCaller(sessionId, callerAgentId);
    const scope = ((req as any).currentWorkspaceId as string | null | undefined) || null;
    if (scope && scope !== session.workspace_id) {
      res.status(403).json({ error: 'workspace_scope_denied', message: 'API key is scoped to a different workspace than the session.' });
      return null;
    }
    return session;
  }

  private async run(req: Request, res: Response, sessionId: string, fn: (session: any) => Promise<unknown>) {
    try {
      const session = await this.resolve(req, res, sessionId);
      if (!session) return;
      // Nest 는 @Post 핸들러에 201 을 기본으로 찍는다 — append/patch 는 생성이 아니므로 200.
      return res.status(200).json(await fn(session));
    } catch (err) {
      if (err instanceof AgentSessionError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  }

  /** `{ events: [{ type, payload, turn_id? }], patch?: { status, native_session_id, … } }` */
  @Post(':id/events')
  async append(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(req, res, id, (session) => this.sessions.appendEvents(session, body?.events, body?.patch ?? null));
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(req, res, id, async (session) => ({ ok: true, session: await this.sessions.applyManagerPatch(session, body ?? {}) }));
  }
}
