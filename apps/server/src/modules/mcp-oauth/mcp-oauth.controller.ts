import { Body, Controller, Delete, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { oauthBase } from './mcp-oauth-clients';
import { McpOAuthService } from './mcp-oauth.service';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const expired = (res: Response) => res.status(400).type('text').send('연결 요청이 만료되었습니다. Start the connection again in your app.');

@Controller('api/mcp-oauth')
export class McpOAuthController {
  constructor(private readonly oauth: McpOAuthService) {}

  @Get('consent/:id')
  async consent(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    try {
      const { flow, accounts } = await this.oauth.choices(id, req);
      if (!accounts.length) return res.status(403).type('text').send('An active AWB account is required.');
      const callbackOrigin = new URL(flow.params.redirectUri).origin;
      res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; base-uri 'none'; frame-ancestors 'none'`);
      const ko = req.acceptsLanguages('ko', 'en') === 'ko';
      const title = ko ? flow.name + '에 AWB 연결' : 'Connect AWB to ' + flow.name;
      const permission = ko ? '선택한 계정의 프로젝트와 티켓을 조회할 수 있습니다. 티켓 상세에는 댓글이 포함됩니다.'
        : 'Allow this app to read projects and tickets in the selected account, including ticket comments.';
      const offline = ko ? '앱은 연결을 해제하거나 30일이 지날 때까지 다시 접속할 수 있습니다.'
        : 'The app may reconnect for up to 30 days. You can disconnect it in AWB settings.';
      return res.type('html').send(`<!doctype html><html lang="${ko ? 'ko' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f6f7fa;color:#172333;margin:0}main{box-sizing:border-box;margin:12vh auto;padding:1.5rem;max-width:31rem}h1{font-size:1.6rem}select,button{font:inherit;padding:.5rem .75rem;border:1px solid #738092;border-radius:.4rem}select{display:block;width:100%;margin:.3rem 0 1.5rem}button{background:white;cursor:pointer}button[value=allow]{background:#173f67;color:white}</style>
<main><h1>${escape(title)}</h1><p>${ko ? '로그인한 Google 계정' : 'Signed in with Google as'} <strong>${escape(flow.email!)}</strong></p><p>${permission}</p>${flow.offline ? '<p>' + offline + '</p>' : ''}
<form method="post"><label>${ko ? 'AWB 계정' : 'AWB account'}<select name="account_id">${accounts.map(a => '<option value="' + escape(a.id) + '">' + escape(a.name) + '</option>').join('')}</select></label>
<button name="decision" value="deny">${ko ? '취소' : 'Cancel'}</button> <button name="decision" value="allow">${ko ? '조회 허용' : 'Allow read access'}</button></form></main></html>`);
    } catch { return expired(res); }
  }

  @Post('consent/:id')
  async decide(@Req() req: Request, @Res() res: Response, @Param('id') id: string, @Body() body: any) {
    const base = oauthBase();
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!base || req.get('origin') !== new URL(base).origin) return res.sendStatus(403);
    if (!['allow', 'deny'].includes(body?.decision)) return res.sendStatus(400);
    try {
      const { accounts } = await this.oauth.choices(id, req);
      if (body.decision === 'allow' && !accounts.some(a => a.id === body.account_id)) return res.sendStatus(403);
      const dest = this.oauth.finish(id, req, body.decision === 'allow' ? body.account_id : undefined);
      res.clearCookie('awb_mcp_' + id, { path: new URL(base + '/api/').pathname });
      return res.redirect(303, dest);
    } catch { return expired(res); }
  }

  @Get('connections') @UseGuards(AuthGuard)
  async connections(@Req() req: any, @Res() res: Response) {
    res.set('Cache-Control', 'no-store');
    const base = oauthBase();
    return res.json({ endpoint: base ? base + '/mcp' : null, connections: await this.oauth.list(req.currentUser.id, req.currentAccountId) });
  }

  @Delete('connections/:id') @UseGuards(AuthGuard)
  async disconnect(@Req() req: any, @Param('id') id: string) {
    await this.oauth.disconnect(id, req.currentUser.id, req.currentAccountId);
    return { disconnected: true };
  }
}
