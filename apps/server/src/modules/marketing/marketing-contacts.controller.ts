import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingContactService } from './marketing-contact.service';
import { MarketingEmailService } from './marketing-email.service';
import { MarketingPostService } from './marketing-post.service';
import { contactToJson, emailSendToJson } from './marketing-json';
import { errorStatus } from './marketing-errors';
import { boundAccountId, userActor } from './marketing-http';

/**
 * 메일 연락처 · 발송 기록 REST(docs/marketing.md "메일"). 연락처는 계정 단위이고 사람만 넣는다 — MCP 에는 없다.
 */
@ApiBearerAuth('user-session')
@ApiTags('marketing')
@Controller('api/marketing')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_MARKETING)
export class MarketingContactsController {
  constructor(
    private readonly contacts: MarketingContactService,
    private readonly email: MarketingEmailService,
    private readonly posts: MarketingPostService,
  ) {}

  @Get('contacts')
  async list(
    @Query('list') list: string,
    @Query('status') status: string,
    @Query('q') q: string,
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const out = await this.contacts.list(boundAccountId(req), {
        list: list || undefined, status: status || undefined, q: q || undefined,
        limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined,
      });
      return res.json({ total: out.total, contacts: out.contacts.map(contactToJson) });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list contacts' });
    }
  }

  /** 동의 증거와 함께 가져온다. 이미 수신거부 · 삭제된 주소는 억제된다. */
  @Post('contacts/import')
  async import(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(await this.contacts.import(boundAccountId(req), body || {}, userActor(req)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to import contacts' });
    }
  }

  @Post('contacts/:id/unsubscribe')
  async unsubscribe(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(contactToJson(await this.contacts.markUnsubscribed(id, boundAccountId(req), userActor(req), String(body?.note || ''))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to unsubscribe contact' });
    }
  }

  @Post('contacts/:id/erase')
  async erase(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(contactToJson(await this.contacts.erase(id, boundAccountId(req), userActor(req))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to erase contact' });
    }
  }

  @Get('posts/:id/sends')
  async sends(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const post = await this.posts.get(id, boundAccountId(req));
      const [rows, counts] = await Promise.all([this.email.listSends(post), this.email.sendCounts(post.id)]);
      return res.json({ counts, sends: rows.map(emailSendToJson) });
    } catch (e: any) {
      return res.status(errorStatus(e, 404)).json({ error: e?.message || 'Failed to list sends' });
    }
  }
}
