import { Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { HostModelsError, HostModelsService } from './host-models.service';

/**
 * 모델이 보이는 모든 화면(Agent 다이얼로그 · 팀 슬롯 · 세션 설정 · 새 세션 · Runtime
 * Hosts)이 쓰는 하나의 읽기/갱신 경로. 로그인한 사용자면 누구나 — 모델 목록은
 * 비밀이 아니고, 재열거는 호스트가 자기 CLI 에 `models` 를 묻는 일일 뿐이다.
 */
@Controller('api/agent-manager/hosts')
@UseGuards(AuthGuard)
export class HostModelsController {
  constructor(private readonly hostModels: HostModelsService) {}

  @Get(':managerAgentId/models')
  async get(@Param('managerAgentId') managerAgentId: string, @Res() res: Response) {
    try {
      return res.json(await this.hostModels.snapshot(managerAgentId));
    } catch (err) {
      return this.fail(res, err);
    }
  }

  @Post(':managerAgentId/models/refresh')
  async refresh(@Param('managerAgentId') managerAgentId: string, @Req() req: any, @Res() res: Response) {
    try {
      const issuedBy = `user:${req?.currentUser?.id ?? req?.user?.id ?? 'unknown'}`;
      return res.status(200).json(await this.hostModels.refresh(managerAgentId, issuedBy));
    } catch (err) {
      return this.fail(res, err);
    }
  }

  private fail(res: Response, err: unknown) {
    if (err instanceof HostModelsError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}
