import { Body, Controller, Delete, Get, Header, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { BusinessTrademarkIntegrationsService, TRADEMARK_CALLBACK_PATH } from './business-trademark-integrations.service';

@ApiTags('business')
@Controller('api/business/companies/:companyId/trademarks/:trademarkId/integrations')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_BUSINESS)
export class BusinessTrademarkIntegrationsController {
  constructor(private readonly service: BusinessTrademarkIntegrationsService) {}
  @Get() @Header('Cache-Control', 'no-store')
  list(@Param() p: any, @Req() req: any) { return this.service.list(p.companyId, req.currentAccountId, p.trademarkId); }
  @Post() @Header('Cache-Control', 'no-store')
  configure(@Param() p: any, @Req() req: any, @Body() body: unknown) { return this.service.configure(p.companyId, req.currentAccountId, p.trademarkId, body, req.currentUser.id); }
  @Delete(':id')
  disconnect(@Param() p: any, @Req() req: any, @Body() body: any) { return this.service.disconnect(p.companyId, req.currentAccountId, p.trademarkId, p.id, body?.revision); }
  @Post(':id/authorize') @Header('Cache-Control', 'no-store')
  async authorize(@Param() p: any, @Req() req: any, @Res({ passthrough: true }) res: Response) {
    const result = await this.service.authorize(p.companyId, req.currentAccountId, p.trademarkId, p.id, req.currentUser.id);
    res.cookie(result.cookie_name, result.cookie, { httpOnly: true, sameSite: 'lax', secure: result.secure, path: TRADEMARK_CALLBACK_PATH, maxAge: 600_000 });
    return { url: result.url };
  }
  @Post(':id/sync')
  sync(@Param() p: any, @Req() req: any) { return this.service.sync(p.companyId, req.currentAccountId, p.trademarkId, p.id); }
  @Post(':id/options') @Header('Cache-Control', 'no-store')
  options(@Param() p: any, @Req() req: any) { return this.service.options(p.companyId, req.currentAccountId, p.trademarkId, p.id); }
  @Post(':id/actions') @Header('Cache-Control', 'no-store')
  prepare(@Param() p: any, @Req() req: any, @Body() body: unknown) { return this.service.prepare(p.companyId, req.currentAccountId, p.trademarkId, p.id, body, req.currentUser.id); }
  @Get('actions/:actionId') @Header('Cache-Control', 'no-store')
  review(@Param() p: any, @Req() req: any) { return this.service.review(p.companyId, req.currentAccountId, p.trademarkId, p.actionId); }
  @Delete('actions/:actionId')
  discard(@Param() p: any, @Req() req: any, @Body() body: unknown) { return this.service.discard(p.companyId, req.currentAccountId, p.trademarkId, p.actionId, body); }
  @Post('actions/:actionId/send') @Header('Cache-Control', 'no-store')
  send(@Param() p: any, @Req() req: any, @Body() body: unknown) { return this.service.execute(p.companyId, req.currentAccountId, p.trademarkId, p.actionId, body, req.currentUser.id); }
  @Post('actions/:actionId/reconcile') @Header('Cache-Control', 'no-store')
  reconcile(@Param() p: any, @Req() req: any, @Body() body: unknown) { return this.service.execute(p.companyId, req.currentAccountId, p.trademarkId, p.actionId, body, req.currentUser.id, true); }
  @Get('actions/:actionId/document')
  async document(@Param() p: any, @Req() req: any, @Query('preview') preview: string | undefined, @Res() res: Response) {
    const bytes = await this.service.document(p.companyId, req.currentAccountId, p.trademarkId, p.actionId, preview === undefined ? null : /^\d$/.test(preview) ? Number(preview) : -1);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', 'attachment; filename="trademark-agreement.pdf"');
    res.send(bytes);
  }
}

/** Signature- or single-use OAuth-state-authenticated routes. No session token is exposed to the provider. */
@ApiExcludeController()
@Controller('api/business-integrations')
export class BusinessTrademarkIntegrationCallbacksController {
  constructor(private readonly service: BusinessTrademarkIntegrationsService) {}
  @Get('oauth/callback')
  async callback(@Query() query: any, @Req() req: any, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    const state = typeof query.state === 'string' ? query.state : ''; const code = typeof query.code === 'string' ? query.code : '';
    const cookieName = `awb_tm_oauth_${state.slice(0, 12)}`;
    const cookie = /^[a-zA-Z0-9_-]{43}$/.test(state) ? String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '' : '';
    try {
      const result = await this.service.callback(state, code, cookie);
      res.clearCookie(cookieName, { path: TRADEMARK_CALLBACK_PATH });
      return res.redirect(303, `/business/operations?stage=trademark&company=${encodeURIComponent(result.company_id)}&trademark=${encodeURIComponent(result.trademark_id)}&integration=connected`);
    } catch {
      // OAuth code and error_description must never reach logs, HTML, analytics or an open redirect.
      return res.status(400).type('html').send('<!doctype html><html lang="ko"><meta charset="utf-8"><title>연결 확인</title><p>서비스 연결을 완료하지 못했습니다. 원래 창에서 연결 설정·권한을 확인하고 같은 브라우저에서 다시 로그인하세요.</p><a href="/business/operations?stage=trademark">상표 관리로 돌아가기</a></html>');
    }
  }
  @Post('webhooks/:id')
  webhook(@Param('id') id: string, @Req() req: any) { return this.service.webhook(id, req.body, req.headers); }
}
