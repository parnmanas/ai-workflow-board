import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingCampaignService } from './marketing-campaign.service';
import { MarketingChannelService } from './marketing-channel.service';
import { MarketingListHoldService } from './marketing-list-hold.service';
import { MarketingEmailEventsService } from './marketing-email-events.service';
import { channelToJson, listHoldToJson } from './marketing-json';
import { errorStatus } from './marketing-errors';
import { assertCanViewMarketing, boundAccountId, userActor } from './marketing-http';

/**
 * 채널 REST(docs/marketing.md "채널 탐색"). 승인 · 연결 · 거부 · 일시정지는 사람만 — MCP 에는 없다.
 */
@ApiBearerAuth('user-session')
@ApiTags('marketing')
@Controller('api/marketing')
@UseGuards(PermissionGuard)
export class MarketingChannelsController {
  constructor(
    private readonly campaigns: MarketingCampaignService,
    private readonly channels: MarketingChannelService,
    private readonly listHolds: MarketingListHoldService,
    private readonly emailEvents: MarketingEmailEventsService,
  ) {}

  /**
   * 메일 채널에는 두 가지를 더 싣는다(사람용 화면만 — 에이전트 개요에는 없다): 목록 발송 중지(`email_hold`)와
   * 공급자에 붙여 넣을 webhook 주소 · 서명 키 설정 여부(`email_webhooks`, 키 값은 싣지 않는다).
   */
  @Get('campaigns/:id/channels')
  async list(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      assertCanViewMarketing(req);
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      const rows = await this.channels.list(campaign);
      const listOf = (c: { config: Record<string, any> }) => String(c.config?.list_name || '');
      const holds = await this.listHolds.activeFor(campaign.account_id, rows.filter((c) => c.kind === 'email').map(listOf));
      return res.json(await Promise.all(rows.map(async (c) => {
        const json: Record<string, unknown> = channelToJson(c);
        if (c.kind === 'email') {
          const hold = holds.get(listOf(c));
          json.email_hold = hold ? listHoldToJson(hold) : null;
          json.email_webhooks = await this.emailEvents.webhookInfo(c);
        }
        return json;
      })));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list channels' });
    }
  }

  /** 사람이 직접 채널을 추가한다(근거는 선택). 이후 승인은 같은 approve 로. */
  @Post('campaigns/:id/channels')
  @RequirePermission(PERMISSIONS.MANAGE_MARKETING)
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
  @RequirePermission(PERMISSIONS.MANAGE_MARKETING)
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.json(channelToJson(await this.channels.update(id, boundAccountId(req), body || {}, userActor(req))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to update channel' });
    }
  }

  @Post('channels/:id/approve')
  @RequirePermission(PERMISSIONS.MANAGE_MARKETING)
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
  @RequirePermission(PERMISSIONS.MANAGE_MARKETING)
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
  @RequirePermission(PERMISSIONS.MANAGE_MARKETING)
  async reject(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(channelToJson(await this.channels.reject(id, boundAccountId(req), String(body?.note || ''), userActor(req))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to reject channel' });
    }
  }

  @Post('channels/:id/pause')
  @RequirePermission(PERMISSIONS.MANAGE_MARKETING)
  async pause(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(channelToJson(await this.channels.setPaused(id, boundAccountId(req), true, userActor(req))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to pause channel' });
    }
  }

  @Post('channels/:id/resume')
  @RequirePermission(PERMISSIONS.MANAGE_MARKETING)
  async resume(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(channelToJson(await this.channels.setPaused(id, boundAccountId(req), false, userActor(req))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to resume channel' });
    }
  }
}
