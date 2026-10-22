import { Controller, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { LogService } from '../../services/log.service';
import { MarketingEmailEventsService, type WebhookResult } from './marketing-email-events.service';

/**
 * 메일 공급자 webhook(docs/marketing.md "공급자 이벤트", "답장") — 인증 없는 공개 엔드포인트이고, 공급자의 서명이 곧 인증이다.
 * 본문은 서명을 검증하려고 raw 로 받는다(common/http-body-parsers.ts). 주소의 credential 에 서명 키가 없거나 서명이
 * 틀리면 아무것도 하지 않고 같은 401 을 돌려준다(어느 credential 이 있는지 흘리지 않는다).
 */
@ApiExcludeController()
@Controller('api/m/email')
export class MarketingEmailWebhooksController {
  constructor(
    private readonly events: MarketingEmailEventsService,
    private readonly logService: LogService,
  ) {}

  @Post(':credentialId/events')
  async receiveEvents(@Param('credentialId') credentialId: string, @Req() req: Request, @Res() res: Response) {
    return this.reply(res, () => this.events.handleEvents(credentialId, { headers: req.headers, body: rawBody(req) }));
  }

  @Post(':credentialId/inbound')
  async receiveInbound(@Param('credentialId') credentialId: string, @Req() req: Request, @Res() res: Response) {
    return this.reply(res, () => this.events.handleInbound(credentialId, { headers: req.headers, body: rawBody(req) }));
  }

  private async reply(res: Response, run: () => Promise<WebhookResult>) {
    let out: WebhookResult;
    try {
      out = await run();
    } catch (e: any) {
      // 처리 중 실패(DB 등) — 5xx 면 공급자가 다시 보낸다. 처리는 상태 기반이라 다시 받아도 결과가 같다.
      this.logService.error('Marketing', 'email webhook failed', { err: e?.message || String(e) });
      out = { status: 500, body: { error: 'failed to process the webhook' } };
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(out.status).json(out.body);
  }
}

function rawBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}
