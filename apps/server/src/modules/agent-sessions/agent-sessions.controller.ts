import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { AgentSessionError, AgentSessionsService } from './agent-sessions.service';

/**
 * 사용자 표면. 워크스페이스는 chat-rooms 와 같은 `X-Workspace-Id` 헤더 규약.
 * 모든 경로가 (Runtime Host, CLI) 아래에 있다 — 세션은 AWB 의 것이 아니라 그 장비의 것이다.
 */
@ApiBearerAuth('user-session')
@ApiTags('agent-sessions')
@Controller('api/agent-sessions')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.USE_AGENT_SESSIONS)
export class AgentSessionsController {
  constructor(private readonly sessions: AgentSessionsService) {}

  private workspaceId(req: Request, res: Response): string | null {
    const raw = req.headers['x-workspace-id'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) {
      res.status(400).json({ error: 'workspace_required', message: 'X-Workspace-Id header is required' });
      return null;
    }
    return String(value);
  }

  private userId(req: Request): string {
    return (req as any).currentUser.id as string;
  }

  private async run(res: Response, status: number, fn: () => Promise<unknown>) {
    try {
      return res.status(status).json(await fn());
    } catch (err) {
      if (err instanceof AgentSessionError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  }

  @Get('hosts')
  async hosts(@Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.sessions.listHosts(ws));
  }

  /** CLI 설정 — 이 Runtime Host 의 이 CLI 를 어떤 워크스페이스 Credential 로 인증할지. */
  @Get('hosts/:managerId/:cli/settings')
  async getSettings(@Param('managerId') managerId: string, @Param('cli') cli: string, @Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.sessions.getCliSettings(ws, managerId, cli));
  }

  /**
   * `{ credential_id: string | null, default_config?: {...}, backend_profile_id?: string | null }`
   * `default_config` 는 부분 갱신이다 — 보낸 키만 바뀌고, null 이면 그 키를 지운다(어댑터 기본값으로).
   * `backend_profile_id` 는 생략하면 그대로 두고, null/'' 이면 핀을 지운다(CLI 기본 엔드포인트).
   */
  @Put('hosts/:managerId/:cli/settings')
  async setSettings(@Param('managerId') managerId: string, @Param('cli') cli: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.sessions.setCliSettings(ws, this.userId(req), managerId, cli, body?.credential_id ?? null, body?.default_config, body?.backend_profile_id));
  }

  /**
   * 세션이 내보낸 이미지 한 장을 **바이트로** 돌려준다 — 브라우저가 `<img src>` 로 바로 읽는다.
   *
   * JSON 이 아니라 바이너리로 내보내는 이유: 전사 이벤트는 payload 상한이 있고 base64 는
   * 원본의 1.33배라, 스크린샷을 이벤트에 실으면 상한에 걸려 **조용히 사라졌다**. 그래서
   * 이벤트는 참조만 싣고 바이트는 이 경로로 받는다. 바이트는 AWB 에 저장되지 않고 매니저가
   * 장비에서 그때그때 읽어 온다(이 표면의 "세션 내용을 저장하지 않는다" 원칙 그대로).
   */
  @Get('hosts/:managerId/:cli/sessions/:sessionId/image/:imageRef')
  async image(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Param('imageRef') imageRef: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    try {
      const bytes = await this.sessions.readImage(ws, this.userId(req), managerId, cli, sessionId, imageRef);
      // mime 은 이벤트 payload 가 들고 있다(화면이 아는 값) — 여기서는 바이트만 책임진다.
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(bytes.length));
      // 참조는 내용 주소처럼 1회성이라 안전하게 캐시된다 — 같은 ref 는 같은 바이트다.
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      return res.end(bytes);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      return res.status(status).json({ error: err?.code || 'image_failed', message: err?.message || 'Could not read the image.' });
    }
  }

  @Get('hosts/:managerId/:cli/sessions')
  async list(@Param('managerId') managerId: string, @Param('cli') cli: string, @Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.sessions.listSessions(ws, this.userId(req), managerId, cli));
  }

  /** `{ session_id?, cwd?, title?, force? }` — session_id 없으면 새 세션(session/new), 있으면 복원(session/load).
   *  `force` 는 잠금을 쥔 외부 프로세스까지 종료하고 연다(화면의 확인 대화상자를 거친 재요청). */
  @Post('hosts/:managerId/:cli/sessions')
  async open(@Param('managerId') managerId: string, @Param('cli') cli: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 201, () => this.sessions.openSession(ws, this.userId(req), managerId, cli, {
      session_id: typeof body?.session_id === 'string' ? body.session_id : null,
      cwd: typeof body?.cwd === 'string' ? body.cwd : '',
      title: typeof body?.title === 'string' ? body.title : '',
      force: body?.force === true,
    }));
  }

  @Get('hosts/:managerId/:cli/sessions/:sessionId')
  async get(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.sessions.getSession(ws, this.userId(req), managerId, cli, sessionId));
  }

  @Post('hosts/:managerId/:cli/sessions/:sessionId/prompt')
  async prompt(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 202, () => this.sessions.prompt(ws, this.userId(req), managerId, cli, sessionId, body?.text));
  }

  @Post('hosts/:managerId/:cli/sessions/:sessionId/permission')
  async permission(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.sessions.decidePermission(ws, this.userId(req), managerId, cli, sessionId, body?.request_id, body?.option_id ?? null));
  }

  /** `{ elicitation_id, action: 'accept'|'decline'|'cancel', content? }` — 에이전트의 질문/폼(ACP elicitation)에 답한다. */
  @Post('hosts/:managerId/:cli/sessions/:sessionId/elicitation')
  async elicitation(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.sessions.answerElicitation(ws, this.userId(req), managerId, cli, sessionId, body?.elicitation_id, body?.action, body?.content));
  }

  /** `{ config_id, value }` — 모델·reasoning 등 ACP session config option 변경. value 는 select 의 value id 또는 boolean. */
  @Post('hosts/:managerId/:cli/sessions/:sessionId/config-option')
  async setConfigOption(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 202, () => this.sessions.setConfigOption(ws, this.userId(req), managerId, cli, sessionId, body?.config_id, body?.value));
  }

  @Post('hosts/:managerId/:cli/sessions/:sessionId/cancel')
  async cancel(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 202, () => this.sessions.cancel(ws, this.userId(req), managerId, cli, sessionId));
  }

  @Post('hosts/:managerId/:cli/sessions/:sessionId/mode')
  async setMode(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 202, () => this.sessions.setMode(ws, this.userId(req), managerId, cli, sessionId, body?.mode_id));
  }

  @Post('hosts/:managerId/:cli/sessions/:sessionId/restart')
  async restart(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 202, () => this.sessions.restart(ws, this.userId(req), managerId, cli, sessionId));
  }

  @Post('hosts/:managerId/:cli/sessions/:sessionId/close')
  async close(
    @Param('managerId') managerId: string,
    @Param('cli') cli: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.sessions.close(ws, this.userId(req), managerId, cli, sessionId));
  }
}
