import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { MarketingAnalyticsService } from './marketing-analytics.service';

const NOT_FOUND = '링크를 찾을 수 없습니다 / Link not found';

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
  constructor(private readonly analytics: MarketingAnalyticsService) {}

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
