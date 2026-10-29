import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingCampaignService } from './marketing-campaign.service';
import { MarketingChannelService } from './marketing-channel.service';
import { MarketingAnalyticsService } from './marketing-analytics.service';
import { linkToJson, metricToJson } from './marketing-json';
import { errorStatus } from './marketing-errors';
import { boundAccountId, userActor } from './marketing-http';
import { publicBaseUrl } from '../../common/public-url';

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 분석 REST(docs/marketing.md "분석"): 리포트 · 추적 링크 · 지표. */
@ApiBearerAuth('user-session')
@ApiTags('marketing')
@Controller('api/marketing')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_MARKETING)
export class MarketingAnalyticsController {
  constructor(
    private readonly campaigns: MarketingCampaignService,
    private readonly channels: MarketingChannelService,
    private readonly analytics: MarketingAnalyticsService,
  ) {}

  @Get('campaigns/:id/report')
  async report(@Param('id') id: string, @Query('since') since: string, @Query('until') until: string, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      return res.json(await this.analytics.report(campaign, { since: parseDate(since), until: parseDate(until) }));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to build report' });
    }
  }

  @Get('campaigns/:id/links')
  async links(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      const base = publicBaseUrl();
      return res.json((await this.analytics.listLinks(campaign)).map((l) => linkToJson(l, base ? `${base}/api/m/${l.code}` : null)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list links' });
    }
  }

  @Post('campaigns/:id/links')
  async createLink(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      const channel = await this.channels.getInCampaign(campaign, String(body?.channel_id || ''));
      const { link, url } = await this.analytics.createLink(campaign, channel, body || {}, userActor(req));
      return res.status(201).json(linkToJson(link, url));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to create link' });
    }
  }

  @Get('campaigns/:id/metrics')
  async metrics(@Param('id') id: string, @Query('limit') limit: string, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      return res.json((await this.analytics.listMetrics(campaign, limit ? Number(limit) : 200)).map(metricToJson));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list metrics' });
    }
  }

  @Post('campaigns/:id/metrics')
  async record(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      const rows = await this.analytics.recordMetrics(campaign, body?.observations, userActor(req));
      return res.status(201).json(rows.map(metricToJson));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to record metrics' });
    }
  }
}
