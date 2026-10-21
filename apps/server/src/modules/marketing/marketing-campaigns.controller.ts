import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingCampaignService } from './marketing-campaign.service';
import { MarketingAuditService } from './marketing-audit.service';
import { campaignToJson, auditToJson } from './marketing-json';
import { normalizeStatus } from './marketing-campaign.logic';
import { errorStatus } from './marketing-errors';
import { boundAccountId, listAccountIds, userActor } from './marketing-http';

/**
 * 캠페인 REST(docs/marketing.md). 목록은 접근 가능한 계정을 합치고, 상세 · 쓰기는
 * AccountAccessService 가 캠페인의 실제 소유 계정으로 묶어 둔 계정으로 검사한다.
 */
@ApiBearerAuth('user-session')
@ApiTags('marketing')
@Controller('api/marketing/campaigns')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_MARKETING)
export class MarketingCampaignsController {
  constructor(
    private readonly campaigns: MarketingCampaignService,
    private readonly audit: MarketingAuditService,
  ) {}

  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    try {
      const rows = await this.campaigns.list(listAccountIds(req));
      return res.json(rows.map(campaignToJson));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list campaigns' });
    }
  }

  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const row = await this.campaigns.create(boundAccountId(req), body || {}, userActor(req));
      return res.status(201).json(campaignToJson(row));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to create campaign' });
    }
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      return res.json(campaignToJson(await this.campaigns.get(id, boundAccountId(req))));
    } catch (e: any) {
      return res.status(errorStatus(e, 404)).json({ error: e?.message || 'Campaign not found' });
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const { account_id: _ignored, ...patch } = body || {};
      const row = await this.campaigns.update(id, boundAccountId(req), patch, userActor(req));
      return res.json(campaignToJson(row));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to update campaign' });
    }
  }

  @Post(':id/status')
  async setStatus(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const row = await this.campaigns.setStatus(id, boundAccountId(req), normalizeStatus(body?.status), userActor(req));
      return res.status(200).json(campaignToJson(row));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to change campaign status' });
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      await this.campaigns.remove(id, boundAccountId(req), userActor(req));
      return res.json({ success: true, id });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to delete campaign' });
    }
  }

  @Get(':id/audit')
  async auditLog(
    @Param('id') id: string,
    @Query('limit') limit: string,
    @Query('before') before: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      const beforeDate = before ? new Date(before) : undefined;
      const rows = await this.audit.list(campaign.id, campaign.account_id, {
        limit: limit ? Number(limit) : undefined,
        before: beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : undefined,
      });
      return res.json(rows.map(auditToJson));
    } catch (e: any) {
      return res.status(errorStatus(e, 404)).json({ error: e?.message || 'Failed to read audit log' });
    }
  }
}
