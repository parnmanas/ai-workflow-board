import { Body, Controller, Delete, Get, Header, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { BUSINESS_MCP_CALLBACK_PATH, BusinessMcpService } from './business-mcp.service';
import { requestOrigin } from '../../common/public-url';

@ApiTags('business')
@Controller('api/business/companies/:companyId/mcp')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_BUSINESS)
export class BusinessMcpController {
  constructor(private readonly service: BusinessMcpService) {}
  @Get() @Header('Cache-Control', 'no-store')
  list(@Param('companyId') companyId: string, @Req() req: any) { return this.service.list(companyId, req.currentAccountId); }
  @Post(':provider/authorize') @Header('Cache-Control', 'no-store')
  async authorize(@Param() p: any, @Req() req: any, @Res({ passthrough: true }) res: Response) {
    const result = await this.service.authorize(p.companyId, req.currentAccountId, p.provider, req.currentUser.id, requestOrigin(req));
    if (result.cookie) res.cookie(result.cookie_name, result.cookie, { httpOnly: true, sameSite: 'lax', secure: result.secure, path: BUSINESS_MCP_CALLBACK_PATH, maxAge: 600_000 });
    return { url: result.url, mode: result.mode, redirect_uri: result.redirect_uri };
  }
  @Post(':provider/complete') @Header('Cache-Control', 'no-store')
  complete(@Param() p: any, @Req() req: any, @Body() body: unknown) { return this.service.completePasted(p.companyId, req.currentAccountId, p.provider, body, req.currentUser.id); }
  @Get(':provider/tools') @Header('Cache-Control', 'no-store')
  tools(@Param() p: any, @Req() req: any, @Query('query') query?: string, @Query('names') names?: string) {
    return this.service.tools(p.companyId, req.currentAccountId, p.provider, { query, names: names ? names.split(',').map(s => s.trim()).filter(Boolean) : undefined });
  }
  @Post(':provider/tools/refresh') @Header('Cache-Control', 'no-store')
  refresh(@Param() p: any, @Req() req: any) { return this.service.tools(p.companyId, req.currentAccountId, p.provider, { refresh: true }); }
  @Post(':provider/call') @Header('Cache-Control', 'no-store')
  call(@Param() p: any, @Req() req: any, @Body() body: unknown) { return this.service.call(p.companyId, req.currentAccountId, p.provider, body, req.currentUser.id); }
  @Delete(':provider')
  disconnect(@Param() p: any, @Req() req: any) { return this.service.disconnect(p.companyId, req.currentAccountId, p.provider, req.currentUser.id); }
}

/** Single-use OAuth state + HttpOnly browser cookie authenticate the provider's return. */
@ApiExcludeController()
@Controller('api/business-mcp')
export class BusinessMcpCallbackController {
  constructor(private readonly service: BusinessMcpService) {}
  @Get('oauth/callback')
  async callback(@Query() query: any, @Req() req: any, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    const state = typeof query.state === 'string' ? query.state : ''; const code = typeof query.code === 'string' ? query.code : '';
    const cookieName = `awb_mcp_oauth_${state.slice(0, 12)}`;
    const cookie = /^[a-zA-Z0-9_-]{43}$/.test(state) ? String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '' : '';
    try {
      const result = await this.service.complete(state, code, { cookie });
      res.clearCookie(cookieName, { path: BUSINESS_MCP_CALLBACK_PATH });
      return res.redirect(303, `/business/connectors?stage=formation&company=${encodeURIComponent(result.company_id)}&mcp=${encodeURIComponent(result.provider)}`);
    } catch {
      // The OAuth code and provider error text never reach logs, HTML or a redirect target.
      return res.status(400).type('html').send('<!doctype html><html lang="ko"><meta charset="utf-8"><title>연결 확인</title><p>서비스 로그인을 완료하지 못했습니다. 원래 창에서 같은 브라우저로 로그인을 다시 시작하세요.</p><a href="/business/connectors?stage=formation">커넥터로 돌아가기</a></html>');
    }
  }
}
