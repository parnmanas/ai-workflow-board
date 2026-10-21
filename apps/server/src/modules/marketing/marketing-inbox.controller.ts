import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingInboxService } from './marketing-inbox.service';
import { errorStatus } from './marketing-errors';
import { assertCanViewMarketing, listAccountIds, userHas } from './marketing-http';

/**
 * 승인함 수 — 접근 가능한 계정의 캠페인을 합친다. `total` 은 **이 사람이 처리할 수 있는 것**만 센다:
 * manage 는 채널 제안 · 초안 · 기록 대기 게시물, approve_spend 는 편성 제안 · 지출 대기 · 결과 불명 · 결제 기록 대기.
 */
@ApiBearerAuth('user-session')
@ApiTags('marketing')
@Controller('api/marketing')
@UseGuards(PermissionGuard)
export class MarketingInboxController {
  constructor(private readonly inbox: MarketingInboxService) {}

  @Get('inbox')
  async counts(@Req() req: Request, @Res() res: Response) {
    try {
      assertCanViewMarketing(req);
      const manage = userHas(req, PERMISSIONS.MANAGE_MARKETING);
      const money = userHas(req, PERMISSIONS.APPROVE_MARKETING_SPEND);
      const campaigns = await this.inbox.counts(listAccountIds(req));
      const actionable = (c: (typeof campaigns)[number]) =>
        (manage ? c.channels_proposed + c.posts_draft : 0)
        + (money ? c.allocations_proposed + c.spend_pending + c.spend_unknown + c.manual_awaiting_payment : 0);
      const rows = campaigns.map((c) => ({ ...c, actionable: actionable(c) }));
      return res.json({ total: rows.reduce((sum, c) => sum + c.actionable, 0), campaigns: rows.filter((c) => c.actionable > 0) });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to read the marketing inbox' });
    }
  }
}
