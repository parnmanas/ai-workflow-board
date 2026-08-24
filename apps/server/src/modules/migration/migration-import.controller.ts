import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Body, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AdminGuard } from '../../common/guards/admin.guard';
import { MigrationRunService } from './migration-run.service';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { MigrationRun } from '../../entities/MigrationRun';

/** 소스 토큰(암호화 사본)은 절대 클라이언트로 되돌리지 않는다. */
function runToJson(run: MigrationRun) {
  const { source_token_encrypted, ...rest } = run;
  return rest;
}

/**
 * 도착지 admin 전용 import 트리거 표면 (ticket 0f638509). AdminGuard(사용자
 * 세션) 보호 — 이 서버로 데이터를 실제로 채워 넣는 트리거이므로 관리자만.
 */
@ApiBearerAuth('user-session')
@ApiTags('migration')
@Controller('api/admin/migration')
@UseGuards(AdminGuard)
export class MigrationImportController {
  constructor(
    private readonly migrationRuns: MigrationRunService,
    private readonly instanceQuiesce: InstanceQuiesceService,
  ) {}

  @Get('runs')
  async list(@Res() res: Response) {
    const runs = await this.migrationRuns.listRuns();
    return res.json(runs.map(runToJson));
  }

  @Get('runs/:id')
  async get(@Param('id') id: string, @Res() res: Response) {
    try {
      const run = await this.migrationRuns.getRun(id);
      return res.json(runToJson(run));
    } catch (e: any) {
      return res.status(e?.status || 500).json({ error: e?.message || 'Failed to load run' });
    }
  }

  /** 완료 기준 1 — 소스 URL + 단기 토큰으로 import 시작. */
  @Post('runs')
  async start(@Req() req: Request, @Body() body: any, @Res() res: Response) {
    try {
      const run = await this.migrationRuns.startRun({
        sourceUrl: String(body?.source_url || ''),
        sourceToken: String(body?.source_token || ''),
        skipAttachments: !!body?.skip_attachments,
        allowMerge: !!body?.allow_merge,
        createdBy: (req as any).currentUser?.name || (req as any).currentUser?.email || (req as any).currentUser?.id || '',
      });
      return res.json(runToJson(run));
    } catch (e: any) {
      return res.status(e?.status || 500).json({ error: e?.message || 'Failed to start migration run' });
    }
  }

  /** 완료 기준 7 — 본문만 먼저 당긴 실행에 첨부/임베딩을 별도로 채운다. */
  @Post('runs/:id/pull-attachments')
  async pullAttachments(@Param('id') id: string, @Res() res: Response) {
    try {
      const run = await this.migrationRuns.pullAttachments(id);
      return res.json(runToJson(run));
    } catch (e: any) {
      return res.status(e?.status || 500).json({ error: e?.message || 'Failed to start attachments pull' });
    }
  }

  /** 완료 기준 6 — 현재 인스턴스 quiesce 상태. */
  @Get('quiesce')
  async getQuiesce(@Res() res: Response) {
    const quiesced = await this.instanceQuiesce.isQuiesced();
    const reason = quiesced ? await this.instanceQuiesce.getReason() : '';
    return res.json({ quiesced, reason });
  }

  /** 완료 기준 6 — 운영자가 명시적으로 fleet 디스패치를 재개. */
  @Post('quiesce/resume')
  async resumeFleet(@Res() res: Response) {
    await this.instanceQuiesce.setQuiesced(false);
    return res.json({ quiesced: false });
  }
}
