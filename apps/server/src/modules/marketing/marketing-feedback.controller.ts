import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingCampaignService } from './marketing-campaign.service';
import { MarketingFeedbackService } from './marketing-feedback.service';
import { feedbackToJson } from './marketing-json';
import { errorStatus } from './marketing-errors';
import { boundAccountId, userActor } from './marketing-http';

/** 피드백 REST(docs/marketing.md "피드백 → 제품"). */
@ApiBearerAuth('user-session')
@ApiTags('marketing')
@Controller('api/marketing')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_MARKETING)
export class MarketingFeedbackController {
  constructor(
    private readonly campaigns: MarketingCampaignService,
    private readonly feedback: MarketingFeedbackService,
  ) {}

  @Get('campaigns/:id/feedback')
  async list(@Param('id') id: string, @Query('limit') limit: string, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      const [recorded, collected] = await Promise.all([
        this.feedback.list(campaign, { limit: limit ? Number(limit) : 100 }),
        this.feedback.collected(campaign, { limit: 50 }),
      ]);
      return res.json({
        recorded: recorded.map((f) => feedbackToJson(f)),
        collected: collected.map(({ item, channel }) => ({
          id: item.id,
          channel_id: channel.id,
          channel_name: channel.name,
          permalink: item.permalink,
          author: item.author,
          classification: item.classification,
          status: item.status,
          ticket_id: item.ticket_id,
          collected_at: item.collected_at,
        })),
      });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list feedback' });
    }
  }

  @Post('campaigns/:id/feedback')
  async record(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      const { feedback, duplicate, ticket, note } = await this.feedback.record(campaign, body || {}, userActor(req));
      return res.status(duplicate ? 200 : 201).json({ feedback: feedbackToJson(feedback), duplicate, ticket_id: ticket?.id || null, note });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to record feedback' });
    }
  }

  /** 상한과 무관하게 사람이 티켓으로 만든다. */
  @Post('feedback/:id/ticket')
  async ticket(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const accountId = boundAccountId(req);
      const row = await this.feedback.get(id, accountId);
      const campaign = await this.campaigns.get(row.campaign_id, accountId);
      const ticket = await this.feedback.ticketNow(id, accountId, campaign, userActor(req));
      return res.status(200).json({ ticket_id: ticket.id, status: ticket.status, title: ticket.title });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to file the ticket' });
    }
  }
}
