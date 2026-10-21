import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingCampaignService } from './marketing-campaign.service';
import { MarketingPostService } from './marketing-post.service';
import { postToJson } from './marketing-json';
import { errorStatus } from './marketing-errors';
import { boundAccountId, userActor } from './marketing-http';

/**
 * 게시물 REST(docs/marketing.md "커뮤니케이션"). 외부 발신의 승인 · 거부 · 재시도 · 게시 기록은 사람만 —
 * MCP 에는 초안(draft_marketing_post)만 있다.
 */
@ApiBearerAuth('user-session')
@ApiTags('marketing')
@Controller('api/marketing')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_MARKETING)
export class MarketingPostsController {
  constructor(
    private readonly campaigns: MarketingCampaignService,
    private readonly posts: MarketingPostService,
  ) {}

  @Get('campaigns/:id/posts')
  async list(@Param('id') id: string, @Query('status') status: string, @Query('limit') limit: string, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      const rows = await this.posts.list(campaign, status || undefined, limit ? Number(limit) : 100);
      return res.json(rows.map((p) => postToJson(p, this.posts.preview(p, campaign))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list posts' });
    }
  }

  @Get('posts/:id')
  async get(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const accountId = boundAccountId(req);
      const post = await this.posts.get(id, accountId);
      const campaign = await this.campaigns.get(post.campaign_id, accountId);
      return res.json(postToJson(post, this.posts.preview(post, campaign)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Post not found' });
    }
  }

  @Post('posts/:id/approve')
  async approve(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const post = await this.posts.approve(id, boundAccountId(req), userActor(req), body || {});
      return res.status(200).json(postToJson(post));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to approve post' });
    }
  }

  @Post('posts/:id/reject')
  async reject(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(postToJson(await this.posts.reject(id, boundAccountId(req), userActor(req), String(body?.note || ''))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to reject post' });
    }
  }

  @Post('posts/:id/retry')
  async retry(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(postToJson(await this.posts.retry(id, boundAccountId(req), userActor(req))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to retry post' });
    }
  }

  @Post('posts/:id/mark-published')
  async markPublished(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(postToJson(await this.posts.markPublished(id, boundAccountId(req), userActor(req), body?.permalink)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to record the post' });
    }
  }
}
