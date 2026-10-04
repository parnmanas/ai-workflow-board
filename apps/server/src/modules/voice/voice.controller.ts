import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { VoiceError, VoiceService } from './voice.service';

async function run(res: Response, fn: () => Promise<unknown> | unknown) {
  try {
    return res.status(200).json(await fn());
  } catch (err) {
    if (err instanceof VoiceError) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }
}

function audioBody(req: Request): { audio: Buffer; mimeType: string } {
  // http-body-parsers.ts 가 이 경로의 본문을 raw Buffer 로 잡아 둔다.
  // 형식은 codecs 까지 그대로 넘긴다(`audio/webm;codecs=opus`) — 공급자가 판정에 쓴다.
  const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  return { audio, mimeType: String(req.headers['content-type'] || 'application/octet-stream') };
}

async function sendAudio(res: Response, fn: () => Promise<{ audio: Buffer; contentType: string; provider: string }>) {
  try {
    const out = await fn();
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Voice-Provider', out.provider);
    return res.status(200).send(out.audio);
  } catch (err) {
    if (err instanceof VoiceError) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }
}

/**
 * 음성 게이트웨이(docs/voice-operator.md). 엔진 키는 서버 설정에만 있다 — 화면은 녹음한 바이트를
 * 보내 글자를 받고, 글자를 보내 소리를 받는다. 비용이 드는 경로라 기본은 admin 전용 권한이다.
 */
@ApiBearerAuth('user-session')
@ApiTags('voice')
@Controller('api/voice')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.USE_VOICE)
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /** 엔진이 켜져 있고 쓸 수 있는가. admin 에게는 Voice lab 이 비교할 공급자 목록도 준다. */
  @Get('config')
  async config(@Req() req: Request, @Res() res: Response) {
    const isAdmin = (req as any).currentUser?.role === 'admin';
    return run(res, () => this.voice.status(isAdmin));
  }

  /** 발화 하나(raw 오디오 본문, Content-Type = 녹음 형식) → `{ text, provider, model, latency_ms }`. */
  @Post('transcribe')
  async transcribe(@Req() req: Request, @Res() res: Response) {
    const { audio, mimeType } = audioBody(req);
    return run(res, () => this.voice.transcribe(audio, mimeType));
  }

  /** `{ text }`(화면용 답) → `{ chunks }`(읽을 조각). 엔진을 부르지 않는다. */
  @Post('speakable')
  async speakable(@Body() body: any, @Res() res: Response) {
    return run(res, () => ({ chunks: this.voice.speakable(typeof body?.text === 'string' ? body.text : '') }));
  }

  /** `{ text }`(읽을 조각 하나) → 오디오 바이트. */
  @Post('speech')
  async speech(@Body() body: any, @Res() res: Response) {
    return sendAudio(res, () => this.voice.synthesize(typeof body?.text === 'string' ? body.text : ''));
  }
}

/**
 * Voice lab — 엔진 고르기(bake-off)용. 키가 있는 공급자를 골라 같은 발화·문장을 나란히 비교한다.
 * 설정된 활성 공급자와 무관하게 부를 수 있으므로 admin 전용이다.
 */
@ApiBearerAuth('user-session')
@ApiTags('voice')
@Controller('api/voice/lab')
@UseGuards(AdminGuard)
export class VoiceLabController {
  constructor(private readonly voice: VoiceService) {}

  @Post('transcribe')
  async transcribe(@Req() req: Request, @Query('provider') provider: string, @Query('model') model: string, @Res() res: Response) {
    const { audio, mimeType } = audioBody(req);
    return run(res, () => this.voice.transcribe(audio, mimeType, { provider: provider || undefined, model: model || undefined }));
  }

  /** `?provider=` 의 목소리 목록 — 설정할 목소리를 고르는 데 쓴다. */
  @Get('voices')
  async voices(@Query('provider') provider: string, @Res() res: Response) {
    return run(res, async () => ({ voices: await this.voice.listVoices(provider || '') }));
  }

  @Post('speech')
  async speech(@Body() body: any, @Res() res: Response) {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return sendAudio(res, () => this.voice.synthesize(str(body?.text) ?? '', {
      provider: str(body?.provider),
      voice: str(body?.voice),
      model: str(body?.model),
    }));
  }
}
