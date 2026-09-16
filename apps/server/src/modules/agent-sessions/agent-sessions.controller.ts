import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { AgentSessionError, AgentSessionsService } from './agent-sessions.service';

/**
 * 사용자(소유자) 표면. 워크스페이스는 chat-rooms 와 같은 `X-Workspace-Id` 헤더
 * 규약을 따르고, 실질 경계는 owner_user_id 다 — 남의 세션은 404 로 감춘다.
 */
@ApiBearerAuth('user-session')
@ApiTags('agent-sessions')
@Controller('api/agent-sessions')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.USE_AGENT_SESSIONS)
export class AgentSessionsController {
  constructor(private readonly sessions: AgentSessionsService) {}

  private workspaceId(req: Request): string | null {
    const raw = req.headers['x-workspace-id'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value ? String(value) : null;
  }

  private userId(req: Request): string {
    return (req as any).currentUser.id as string;
  }

  private async run(res: Response, status: number, fn: () => Promise<unknown>) {
    try {
      const body = await fn();
      if (status === 204) return res.status(204).send();
      return res.status(status).json(body);
    } catch (err) {
      if (err instanceof AgentSessionError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  }

  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req);
    if (!ws) return res.status(400).json({ error: 'workspace_required', message: 'X-Workspace-Id header is required' });
    return this.run(res, 200, () => this.sessions.listForOwner(ws, this.userId(req)));
  }

  /** 세션을 열 수 있는 에이전트 후보 — 새 세션 피커용. */
  @Get('agents')
  async listAgents(@Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req);
    if (!ws) return res.status(400).json({ error: 'workspace_required', message: 'X-Workspace-Id header is required' });
    return this.run(res, 200, () => this.sessions.listSessionAgents(ws));
  }

  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req) || (typeof body?.workspace_id === 'string' ? body.workspace_id : null);
    if (!ws) return res.status(400).json({ error: 'workspace_required', message: 'X-Workspace-Id header is required' });
    if (!body?.agent_id || typeof body.agent_id !== 'string') {
      return res.status(400).json({ error: 'agent_id_required', message: 'agent_id is required' });
    }
    return this.run(res, 201, () => this.sessions.create({
      workspaceId: ws,
      userId: this.userId(req),
      agentId: body.agent_id,
      cwd: typeof body.cwd === 'string' ? body.cwd : '',
      title: typeof body.title === 'string' ? body.title : '',
      permissionPolicy: typeof body.permission_policy === 'string' ? body.permission_policy : 'ask',
    }));
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.sessions.getOwnedSnapshot(id, this.userId(req)));
  }

  @Get(':id/events')
  async events(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query('after_seq') afterSeq?: string,
    @Query('limit') limit?: string,
  ) {
    return this.run(res, 200, () => this.sessions.listEvents(
      id,
      this.userId(req),
      Number.parseInt(afterSeq || '0', 10) || 0,
      Number.parseInt(limit || '0', 10) || 0,
    ));
  }

  @Post(':id/prompt')
  async prompt(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 202, () => this.sessions.prompt(id, this.userId(req), body?.text));
  }

  @Post(':id/permission')
  async permission(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.sessions.decidePermission(id, this.userId(req), body?.request_id, body?.option_id ?? null));
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 202, () => this.sessions.cancel(id, this.userId(req)));
  }

  @Post(':id/mode')
  async setMode(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 202, () => this.sessions.setMode(id, this.userId(req), body?.mode_id));
  }

  @Patch(':id')
  async rename(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.sessions.rename(id, this.userId(req), body?.title));
  }

  @Post(':id/close')
  async close(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.sessions.close(id, this.userId(req)));
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    // 클라이언트 request() 헬퍼가 항상 res.json() 을 읽으므로 204 대신 200 + { ok }.
    return this.run(res, 200, async () => {
      await this.sessions.remove(id, this.userId(req));
      return { ok: true };
    });
  }
}
