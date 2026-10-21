import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { CliMemoryError, CliMemoryService } from './cli-memory.service';

/**
 * 사용자 표면(docs/cli-memory.md). 모든 경로가 Runtime Host 아래에 있다 — 메모리는 AWB 의 것이 아니라
 * 그 장비의 CLI 파일이다. project 범위 파일은 사용자가 접근할 수 있는 계정의 프로젝트 폴더에서만 찾는다.
 */
@ApiBearerAuth('user-session')
@ApiTags('cli-memory')
@Controller('api/cli-memory')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.USE_CLI_MEMORY)
export class CliMemoryController {
  constructor(private readonly memory: CliMemoryService) {}

  private userId(req: Request): string {
    return (req as any).currentUser.id as string;
  }

  /** AuthGuard 가 묶어 둔 접근 가능 계정. 프로젝트 폴더를 고르는 근거다. */
  private accountIds(req: Request): string[] {
    const ids = (req as any).accessibleAccountIds;
    return Array.isArray(ids) ? ids : [];
  }

  private async run(res: Response, status: number, fn: () => unknown | Promise<unknown>) {
    try {
      return res.status(status).json(await fn());
    } catch (err) {
      if (err instanceof CliMemoryError) {
        return res.status(err.status).json({ error: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) });
      }
      throw err;
    }
  }

  /** 메모리를 볼 수 있는 Runtime Host(지원하지 않는 매니저는 `supported: false`). */
  @Get('hosts')
  async hosts(@Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.memory.listHosts(this.accountIds(req)));
  }

  /** 그 장비의 모든 메모리 CLI × 홈의 파일과 내용. `?check_paths=1` 이면 내용이 가리키는 경로도 확인한다. */
  @Get('hosts/:managerId/snapshot')
  async snapshot(@Param('managerId') managerId: string, @Query('check_paths') checkPaths: string | undefined, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.memory.snapshot(this.accountIds(req), this.userId(req), managerId, {
      checkPaths: checkPaths === '1' || checkPaths === 'true',
    }));
  }

  @Get('hosts/:managerId/file')
  async read(@Param('managerId') managerId: string, @Query('cli') cli: string, @Query('path') path: string, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.memory.read(this.accountIds(req), this.userId(req), managerId, { cli, path }));
  }

  /** `{ cli, path, content, base_hash, reason? }` — base_hash: 문자열(그 내용이어야) · null(없어야) · 생략(덮어쓰기). */
  @Put('hosts/:managerId/file')
  async write(@Param('managerId') managerId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.memory.write(this.accountIds(req), this.userId(req), managerId, {
      cli: body?.cli, path: body?.path, content: body?.content, base_hash: body?.base_hash, reason: body?.reason,
    }));
  }

  /** `{ cli, path, base_hash? }` — 지우기 전에 매니저가 백업한다. */
  @Post('hosts/:managerId/file/delete')
  async remove(@Param('managerId') managerId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.memory.remove(this.accountIds(req), this.userId(req), managerId, {
      cli: body?.cli, path: body?.path, base_hash: body?.base_hash,
    }));
  }

  @Get('hosts/:managerId/history')
  async history(@Param('managerId') managerId: string, @Query('cli') cli: string, @Query('path') path: string, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.memory.history(this.accountIds(req), this.userId(req), managerId, { cli, path }));
  }

  @Get('hosts/:managerId/history/:versionId')
  async readVersion(
    @Param('managerId') managerId: string,
    @Param('versionId') versionId: string,
    @Query('cli') cli: string,
    @Query('path') path: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.run(res, 200, () => this.memory.readVersion(this.accountIds(req), this.userId(req), managerId, { cli, path, version_id: versionId }));
  }

  /** `{ cli, path, version_id, base_hash? }` */
  @Post('hosts/:managerId/restore')
  async restore(@Param('managerId') managerId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.memory.restore(this.accountIds(req), this.userId(req), managerId, {
      cli: body?.cli, path: body?.path, version_id: body?.version_id, base_hash: body?.base_hash,
    }));
  }

  /** `{ cli, path, target, base_hash? }` — 세션 홈의 자리를 운영자 홈 파일로 링크한다. */
  @Post('hosts/:managerId/link')
  async link(@Param('managerId') managerId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, () => this.memory.link(this.accountIds(req), this.userId(req), managerId, {
      cli: body?.cli, path: body?.path, target: body?.target, base_hash: body?.base_hash,
    }));
  }

  /** `{ ops: [{ op: 'write'|'delete'|'link', cli, path, content?, base_hash?, target?, reason? }] }` */
  @Post('hosts/:managerId/batch')
  async batch(@Param('managerId') managerId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.run(res, 200, async () => ({ results: await this.memory.batch(this.accountIds(req), this.userId(req), managerId, body?.ops) }));
  }
}
