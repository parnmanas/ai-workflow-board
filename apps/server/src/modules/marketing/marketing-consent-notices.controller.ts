import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingConsentNoticeService } from './marketing-consent-notice.service';
import { consentNoticeSettingsToJson, consentNoticeToJson } from './marketing-json';
import { errorStatus } from './marketing-errors';
import { boundAccountId, userActor } from './marketing-http';

/**
 * 수신 동의 재확인 안내 REST(docs/marketing.md "동의 재확인 안내") — 연락처와 같이 계정 단위이고 사람만 쓴다(MCP 에는 없다).
 * 문구 · 발송 시점 · 무응답 처리 · 켜기는 운영자가 정한다.
 */
@ApiBearerAuth('user-session')
@ApiTags('marketing')
@Controller('api/marketing')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_MARKETING)
export class MarketingConsentNoticesController {
  constructor(private readonly notices: MarketingConsentNoticeService) {}

  /** 설정(저장한 적이 없으면 기본 문구)과 현황. */
  @Get('consent-notices/settings')
  async settings(@Req() req: Request, @Res() res: Response) {
    try {
      return res.json(await this.overviewJson(boundAccountId(req)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to load consent notice settings' });
    }
  }

  @Put('consent-notices/settings')
  async save(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const accountId = boundAccountId(req);
      await this.notices.saveSettings(accountId, body || {}, userActor(req));
      return res.json(await this.overviewJson(accountId));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to save consent notice settings' });
    }
  }

  /** 저장하기 전의 문구를 실제로 나갈 모양으로(예시 받는 사람 · 이 계정의 첫 메일 채널 발신자). */
  @Post('consent-notices/preview')
  async preview(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(await this.notices.preview(boundAccountId(req), body || {}));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to preview the consent notice' });
    }
  }

  /** 실패한 안내를 다시 보낸다(기한 전인 것만). 공급자 설정을 고친 뒤에 쓴다. */
  @Post('consent-notices/retry-failed')
  async retryFailed(@Req() req: Request, @Res() res: Response) {
    try {
      const accountId = boundAccountId(req);
      const requeued = await this.notices.retryFailed(accountId, userActor(req));
      return res.status(200).json({ requeued, ...(await this.overviewJson(accountId)) });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to retry consent notices' });
    }
  }

  @Get('consent-notices')
  async list(@Query('status') status: string, @Query('limit') limit: string, @Req() req: Request, @Res() res: Response) {
    try {
      const rows = await this.notices.list(boundAccountId(req), { status: status || undefined, limit: limit ? Number(limit) : undefined });
      return res.json(rows.map((r) => consentNoticeToJson(r.notice, r.contact)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list consent notices' });
    }
  }

  private async overviewJson(accountId: string) {
    const { row, settings, counts } = await this.notices.overview(accountId);
    return { settings: consentNoticeSettingsToJson(row, settings), counts };
  }
}
