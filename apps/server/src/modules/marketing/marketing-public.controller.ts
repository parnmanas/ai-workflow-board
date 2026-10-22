import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { MarketingAnalyticsService } from './marketing-analytics.service';
import { MarketingContactService } from './marketing-contact.service';
import { MarketingEmailService } from './marketing-email.service';
import { MarketingConsentNoticeService } from './marketing-consent-notice.service';

const NOT_FOUND = '링크를 찾을 수 없습니다 / Link not found';
const UNSUB_RATE_WINDOW_MS = 60_000;
const UNSUB_RATE_MAX = 30;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${title}</title>`
    + `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6;color:#222}`
    + `button{font-size:1rem;padding:.6rem 1.2rem;cursor:pointer}</style></head><body>${body}</body></html>`;
}

/** 수신거부 확인 화면 — 토큰이 맞든 틀리든 같은 화면(누구의 주소인지 · 유효한지 드러내지 않는다). */
const CONFIRM_PAGE = page('수신거부 / Unsubscribe',
  '<h1>수신거부 / Unsubscribe</h1><p>이 주소로 오는 마케팅 메일 수신을 거부하시겠습니까? 비용은 들지 않습니다.</p>'
  + '<p>Stop receiving marketing email at this address? It is free.</p>'
  + '<form method="post"><button type="submit">수신거부 / Unsubscribe</button></form>');

function donePage(date: string): string {
  return page('수신거부 완료 / Unsubscribed',
    `<h1>수신거부 처리됨 / Unsubscribed</h1><p>${date}에 수신거부가 처리되었습니다. 앞으로 마케팅 메일을 보내지 않습니다.</p>`
    + `<p>Your request was processed on ${date}. You will not receive marketing email from us.</p>`);
}

/** 동의 유지 확인 화면(재확인 안내의 유지 링크) — GET 은 아무것도 바꾸지 않는다. 토큰과 무관하게 같은 화면이다. */
const KEEP_CONFIRM_PAGE = page('수신 동의 유지 / Keep receiving',
  '<h1>수신 동의 유지 / Keep receiving</h1><p>이 주소로 오는 광고성 메일을 계속 받으시겠습니까? 누르시면 오늘 날짜로 수신 동의가 갱신됩니다.</p>'
  + '<p>Keep receiving our marketing email at this address? Pressing the button renews your consent as of today.</p>'
  + '<form method="post"><button type="submit">계속 받기 / Keep receiving</button></form>'
  + '<p>그만 받으시려면 안내 메일의 수신거부 링크를 눌러 주세요. / To stop instead, use the unsubscribe link in the email.</p>');

function keptPage(date: string): string {
  return page('수신 동의 유지됨 / Consent kept',
    `<h1>수신 동의 유지됨 / Consent kept</h1><p>${date}에 광고성 메일 수신 동의가 유지되었습니다. 언제든 메일의 수신거부 링크로 그만 받을 수 있습니다.</p>`
    + `<p>Your consent was kept on ${date}. You can unsubscribe at any time with the link in our emails.</p>`);
}

const KEEP_UNAVAILABLE_PAGE = page('처리할 수 없는 링크 / Link not available',
  '<h1>처리할 수 없는 링크 / Link not available</h1><p>기한이 지났거나, 이미 수신거부 · 삭제된 주소의 링크입니다. 메일을 다시 받으시려면 가입 화면에서 새로 동의해 주세요.</p>'
  + '<p>This link has expired or belongs to an address that no longer receives our email. To receive it again, please sign up again.</p>');

/** 클라이언트 식별 키 — 해시해서 메모리에만 둔다. 프록시 뒤면 X-Forwarded-For 의 첫 값. */
export function clientKeyOf(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.socket?.remoteAddress || '';
  return `${ip}|${String(req.headers['user-agent'] || '')}`;
}

/**
 * 인증 없는 공개 엔드포인트(docs/marketing.md "분석", "메일"). 가드가 없다 — 받는 사람은 AWB 사용자가 아니다.
 * 추적 링크는 저장된 주소로만 302 하고, 모르는 코드는 언제나 같은 404 다(존재 여부를 흘리지 않는다).
 */
@ApiExcludeController()
@Controller('api/m')
export class MarketingPublicController {
  private readonly unsubRate = new Map<string, { start: number; n: number }>();

  constructor(
    private readonly analytics: MarketingAnalyticsService,
    private readonly contacts: MarketingContactService,
    private readonly email: MarketingEmailService,
    private readonly consentNotices: MarketingConsentNoticeService,
  ) {}

  /** IP(+UA) 당 분당 30 회 — 수신거부 · 동의 유지가 같은 버킷을 쓴다. 넘었으면 true. */
  private limited(req: Request): boolean {
    const key = clientKeyOf(req);
    const now = Date.now();
    const bucket = this.unsubRate.get(key);
    if (!bucket || now - bucket.start > UNSUB_RATE_WINDOW_MS) this.unsubRate.set(key, { start: now, n: 1 });
    else if (++bucket.n > UNSUB_RATE_MAX) return true;
    if (this.unsubRate.size > 50_000) this.unsubRate.clear();
    return false;
  }

  /** 수신거부 확인 화면. GET 은 아무것도 바꾸지 않는다(메일 보안 스캐너가 링크를 열어도 처리되지 않게). */
  @Get('u/:token')
  unsubscribePage(@Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('text/html; charset=utf-8').send(CONFIRM_PAGE);
  }

  /**
   * 수신거부 처리 — 화면의 버튼과 메일 앱의 One-Click(RFC 8058, `List-Unsubscribe=One-Click`) 둘 다 이것이다.
   * 응답은 토큰과 무관하게 같다. 처리 결과는 화면과(가능하면) 안내 메일로 알린다.
   */
  @Post('u/:token')
  async unsubscribe(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Cache-Control', 'no-store');
    if (this.limited(req)) return res.status(429).type('text/plain; charset=utf-8').send('Too many requests');
    const oneClick = String((req.body as any)?.['List-Unsubscribe'] || '') === 'One-Click';
    const contact = await this.contacts.unsubscribeByToken(token, oneClick ? 'one_click' : 'link').catch(() => null);
    if (contact) void this.email.sendUnsubscribeNotice(contact);
    return res.status(200).type('text/html; charset=utf-8').send(donePage(date));
  }

  /** 동의 유지 확인 화면(docs/marketing.md "동의 재확인 안내"). GET 은 아무것도 바꾸지 않는다. */
  @Get('c/:token')
  keepPage(@Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('text/html; charset=utf-8').send(KEEP_CONFIRM_PAGE);
  }

  /** 동의 유지 — 새 동의로 기록한다(동의일 = 지금). 수신거부 · 삭제된 주소나 기한이 지난 링크는 되살리지 않는다. */
  @Post('c/:token')
  async keep(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    if (this.limited(req)) return res.status(429).type('text/plain; charset=utf-8').send('Too many requests');
    const result = await this.consentNotices.keep(token).catch(() => ({ kept: false, at: null }));
    if (!result.kept || !result.at) return res.status(200).type('text/html; charset=utf-8').send(KEEP_UNAVAILABLE_PAGE);
    return res.status(200).type('text/html; charset=utf-8').send(keptPage(new Date(result.at).toISOString().slice(0, 10)));
  }

  @Get(':code')
  async redirect(@Param('code') code: string, @Req() req: Request, @Res() res: Response) {
    const target = await this.analytics.click(code, {
      method: req.method,
      userAgent: String(req.headers['user-agent'] || ''),
      clientKey: clientKeyOf(req),
      purpose: String(req.headers['sec-purpose'] || req.headers['purpose'] || req.headers['x-moz'] || ''),
    }).catch(() => null);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
    if (!target) return res.status(404).type('text/plain; charset=utf-8').send(NOT_FOUND);
    return res.redirect(302, target);
  }
}
