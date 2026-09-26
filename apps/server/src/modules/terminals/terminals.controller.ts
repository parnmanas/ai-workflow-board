import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { TerminalError, TerminalsService } from './terminals.service';

/**
 * 사용자 표면. 워크스페이스는 agent-sessions 와 같은 `X-Workspace-Id` 헤더 규약.
 * 모든 경로가 Runtime Host 아래에 있다 — 터미널은 AWB 의 것이 아니라 그 장비의 셸이다.
 */
@ApiBearerAuth('user-session')
@ApiTags('terminals')
@Controller('api/terminals')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.USE_TERMINALS)
export class TerminalsController {
  constructor(private readonly terminals: TerminalsService) {}

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

  private async run(res: Response, status: number, fn: () => unknown | Promise<unknown>) {
    try {
      return res.status(status).json(await fn());
    } catch (err) {
      if (err instanceof TerminalError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  }

  /** 터미널을 띄울 수 있는 Runtime Host 와 그 장비의 셸 목록. */
  @Get('hosts')
  async hosts(@Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.terminals.listHosts(ws));
  }

  /** 지금 살아 있는 터미널만. 죽은 것은 기록이 없으므로 아예 나오지 않는다. */
  @Get('hosts/:managerId/terminals')
  async list(@Param('managerId') managerId: string, @Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.terminals.listTerminals(ws, this.userId(req), managerId));
  }

  /** `{ shell?, cwd?, title?, cols?, rows? }` — 새 PTY. */
  @Post('hosts/:managerId/terminals')
  async open(@Param('managerId') managerId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 201, () => this.terminals.openTerminal(ws, this.userId(req), managerId, {
      shell: typeof body?.shell === 'string' ? body.shell : null,
      cwd: typeof body?.cwd === 'string' ? body.cwd : '',
      title: typeof body?.title === 'string' ? body.title : '',
      cols: body?.cols,
      rows: body?.rows,
    }));
  }

  /** 스크롤백 스냅샷을 받고 driver 가 된다. `?cols=&rows=` 를 주면 붙으면서 크기도 맞춘다. */
  @Get('hosts/:managerId/terminals/:terminalId')
  async attach(
    @Param('managerId') managerId: string,
    @Param('terminalId') terminalId: string,
    @Query('cols') cols: string | undefined,
    @Query('rows') rows: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.terminals.attach(ws, this.userId(req), managerId, terminalId, { cols, rows }));
  }

  /** `{ data }` — 키 입력 원문(Ctrl-C 같은 제어문자 포함). 답은 출력 스트림으로 온다. */
  @Post('hosts/:managerId/terminals/:terminalId/input')
  async input(
    @Param('managerId') managerId: string,
    @Param('terminalId') terminalId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 202, () => this.terminals.write(ws, this.userId(req), managerId, terminalId, body?.data));
  }

  @Post('hosts/:managerId/terminals/:terminalId/resize')
  async resize(
    @Param('managerId') managerId: string,
    @Param('terminalId') terminalId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.terminals.resize(ws, this.userId(req), managerId, terminalId, body?.cols, body?.rows));
  }

  @Post('hosts/:managerId/terminals/:terminalId/close')
  async close(
    @Param('managerId') managerId: string,
    @Param('terminalId') terminalId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ws = this.workspaceId(req, res);
    if (!ws) return;
    return this.run(res, 200, () => this.terminals.close(ws, this.userId(req), managerId, terminalId));
  }
}
