import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingCampaignService } from './marketing-campaign.service';
import { MarketingChannelService } from './marketing-channel.service';
import { channelToJson } from './marketing-json';
import { errorStatus } from './marketing-errors';
import { boundAccountId, userActor } from './marketing-http';

/**
 * 채널 REST(docs/marketing.md "채널 탐색"). 승인 · 연결 · 거부 · 일시정지는 사람만 — MCP 에는 없다.
 */
@ApiBearerAuth('user-session')
@ApiTags('marketing')
@Controller('api/marketing')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_MARKETING)
export class MarketingChannelsController {
  constructor(
    private readonly campaigns: MarketingCampaignService,
    private readonly channels: MarketingChannelService,
  ) {}

  @Get('campaigns/:id/channels')
  async list(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      return res.json((await this.channels.list(campaign)).map(channelToJson));
    } catch (e: any) {
      return res.status(errorStatus(e, 404)).json({ error: e?.message || 'Failed to list channels' });
    }
  }

  /** 사람이 직접 채널을 추가한다(근거는 선택). 이후 승인은 같은 approve 로. */
  @Post('campaigns/:id/channels')
  async create(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      const { channel, duplicate } = await this.channels.propose(campaign, body || {}, userActor(req));
      return res.status(duplicate ? 200 : 201).json({ ...channelToJson(channel), duplicate });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to add channel' });
    }
  }

  @Patch('channels/:id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.json(channelToJson(await this.channels.update(id, boundAccountId(req), body || {}, userActor(req))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to update channel' });
    }
  }

  @Post('channels/:id/approve')
  async approve(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const accountId = boundAccountId(req);
      const channel = await this.channels.get(id, accountId);
      const campaign = await this.campaigns.get(channel.campaign_id, accountId);
      return res.status(200).json(channelToJson(await this.channels.approve(id, accountId, body || {}, userActor(req), campaign)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to approve channel' });
    }
  }

  @Post('channels/:id/connect')
  async connect(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const accountId = boundAccountId(req);
      const channel = await this.channels.get(id, accountId);
      const campaign = await this.campaigns.get(channel.campaign_id, accountId);
      return res.status(200).json(channelToJson(await this.channels.connect(id, accountId, body || {}, userActor(req), campaign)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to connect channel' });
    }
  }

  @Post('channels/:id/reject')
  async reject(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(channelToJson(await this.channels.reject(id, boundAccountId(req), String(body?.note || ''), userActor(req))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to reject channel' });
    }
  }

  @Post('channels/:id/pause')
  async pause(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(channelToJson(await this.channels.setPaused(id, boundAccountId(req), true, userActor(req))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to pause channel' });
    }
  }

  @Post('channels/:id/resume')
  async resume(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(channelToJson(await this.channels.setPaused(id, boundAccountId(req), false, userActor(req))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to resume channel' });
    }
  }
}
