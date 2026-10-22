import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingContactService } from './marketing-contact.service';
import { MarketingEmailService } from './marketing-email.service';
import { MarketingPostService } from './marketing-post.service';
import { MarketingListHoldService } from './marketing-list-hold.service';
import { MarketingConsentNoticeService } from './marketing-consent-notice.service';
import { contactToJson, emailSendToJson, listHoldToJson } from './marketing-json';
import { errorStatus } from './marketing-errors';
import { boundAccountId, userActor } from './marketing-http';

/**
 * 메일 연락처 · 발송 기록 REST(docs/marketing.md "메일"). 연락처는 설치 전체의 한 목록이고(같은 주소는 한 번) 사람만 넣는다 — MCP 에는 없다.
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
    private readonly listHolds: MarketingListHoldService,
    private readonly consentNotices: MarketingConsentNoticeService,
  ) {}

  @Get('brands')
  async brands(@Req() req: Request, @Res() res: Response) {
    try { return res.json(await this.contacts.listBrands(boundAccountId(req))); }
    catch (e: any) { return res.status(errorStatus(e)).json({ error: e?.message }); }
  }

  @Post('brands')
  async createBrand(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try { return res.status(201).json(await this.contacts.createBrand(boundAccountId(req), body?.name, userActor(req))); }
    catch (e: any) { return res.status(errorStatus(e)).json({ error: e?.message }); }
  }

  @Post('brands/:id/migrate-legacy')
  async migrateLegacy(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try { return res.json(await this.contacts.migrateLegacy(boundAccountId(req), id, body?.contact_ids, userActor(req))); }
    catch (e: any) { return res.status(errorStatus(e)).json({ error: e?.message }); }
  }

  @Get('contacts')
  async list(
    @Query('list') list: string,
    @Query('brand_id') brandId: string,
    @Query('status') status: string,
    @Query('q') q: string,
    @Query('limit') limit: string,
    @Query('offset') offset: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const accountId = boundAccountId(req);
      const out = await this.contacts.list(accountId, {
        brand_id: brandId || undefined, list: list || undefined, status: status || undefined, q: q || undefined,
        limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined,
      });
      const brandIds = [...new Set(out.contacts.flatMap((c) => c.consents.map((v) => v.brand_id)))];
      const notices = new Map(await Promise.all(brandIds.map(async (brandId) => [brandId,
        await this.consentNotices.latestFor(accountId, out.contacts.map((c) => c.id), brandId)] as const)));
      return res.json({ total: out.total, contacts: out.contacts.map((c) => ({
        ...contactToJson(c), legacy_consent_migrated: c.legacy_consent_migrated,
        consents: c.consents.map(({ unsubscribe_token, consent_ip, ...consent }) => {
          const json = contactToJson({ ...c, ...consent }, notices.get(consent.brand_id)?.get(c.id));
          return { ...consent, consent_due_at: json.consent_due_at, consent_notice: json.consent_notice };
        }),
      })) });
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
      return res.status(200).json(contactToJson(await this.contacts.markUnsubscribed(id, boundAccountId(req), userActor(req), String(body?.note || ''), body?.brand_id ? String(body.brand_id) : undefined)));
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

  /** 스팸 신고율로 발송을 멈춘 목록(docs/marketing.md "목록 발송 중지") — 지금 멈춘 것과 지난 이력. */
  @Get('list-holds')
  async holds(@Query('list') list: string, @Query('status') status: string, @Req() req: Request, @Res() res: Response) {
    try {
      const rows = await this.listHolds.list(boundAccountId(req), { list: list || undefined, status: status || undefined });
      return res.json(rows.map(listHoldToJson));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list holds' });
    }
  }

  /** 해제 — 무엇을 확인 · 고쳤는지 사유가 필요하다. 보류된 메일은 바로 다시 보낸다. */
  @Post('list-holds/:id/release')
  async releaseHold(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(listHoldToJson(await this.listHolds.release(id, boundAccountId(req), userActor(req), body?.note)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to release the hold' });
    }
  }

  @Get('posts/:id/sends')
  async sends(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const post = await this.posts.get(id, boundAccountId(req));
      const [rows, counts, outcomes] = await Promise.all([this.email.listSends(post), this.email.sendCounts(post.id), this.email.outcomeCounts(post.id)]);
      return res.json({ counts, outcomes, sends: rows.map(emailSendToJson) });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list sends' });
    }
  }
}
