import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { VoiceError, VoiceService } from './voice.service';
import { VoiceAnnouncerService } from './voice-announcer.service';
import { VoicePresenceService } from './voice-presence.service';
import { OperatorProposalError, OperatorProposalService } from './operator-proposal.service';
import {
  OperatorInputError,
  createOperatorEntry,
  patchOperatorEntry,
  readOperators,
  updateOperators,
} from './operator-config';

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
  constructor(
    private readonly voice: VoiceService,
    private readonly announcer: VoiceAnnouncerService,
    private readonly presence: VoicePresenceService,
  ) {}

  /** 엔진이 켜져 있고 쓸 수 있는가. admin 에게는 Voice lab 이 비교할 공급자 목록도 준다. */
  @Get('config')
  async config(@Req() req: Request, @Res() res: Response) {
    const isAdmin = (req as any).currentUser?.role === 'admin';
    return run(res, () => this.voice.status(isAdmin));
  }

  /**
   * 발화 하나(raw 오디오 본문, Content-Type = 녹음 형식) → `{ text, provider, model, latency_ms }`.
   * `?purpose=wake` 는 잠든 operator 를 부르는 말을 확인하는 상시 청취다 — 자체 호스팅 엔진에서만 받는다.
   */
  @Post('transcribe')
  async transcribe(@Req() req: Request, @Query('purpose') purpose: string, @Res() res: Response) {
    const { audio, mimeType } = audioBody(req);
    return run(res, () => this.voice.transcribe(audio, mimeType, undefined, purpose === 'wake' ? 'wake' : 'utterance', (req as any).currentUser.id));
  }

  @Get('speaker')
  async speaker(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return run(res, () => this.voice.speakerProfile((req as any).currentUser.id));
  }

  @Post('speaker/enroll')
  async enrollSpeaker(@Req() req: Request, @Res() res: Response) {
    const { audio, mimeType } = audioBody(req);
    return run(res, () => this.voice.enrollSpeaker((req as any).currentUser.id, audio, mimeType));
  }

  @Patch('speaker')
  async updateSpeaker(@Req() req: Request, @Body() body: any, @Res() res: Response) {
    return run(res, () => this.voice.updateSpeaker((req as any).currentUser.id, body ?? {}));
  }

  @Delete('speaker')
  async removeSpeaker(@Req() req: Request, @Res() res: Response) {
    return run(res, () => this.voice.removeSpeaker((req as any).currentUser.id));
  }

  @Get('lab/models')
  @UseGuards(AdminGuard)
  async sttModels(@Res() res: Response) {
    return run(res, () => this.voice.localModels());
  }

  /** `{ text, summary? }`(화면용 답) → `{ chunks }`(읽을 조각). `summary` 면 첫 문단만(operator 의 답). 엔진을 부르지 않는다. */
  @Post('speakable')
  async speakable(@Body() body: any, @Res() res: Response) {
    return run(res, () => ({ chunks: this.voice.speakable(typeof body?.text === 'string' ? body.text : '', body?.summary === true) }));
  }

  /** `{ text }`(읽을 조각 하나) → 오디오 바이트. */
  @Post('speech')
  async speech(@Body() body: any, @Res() res: Response) {
    return sendAudio(res, () => this.voice.synthesize(typeof body?.text === 'string' ? body.text : ''));
  }

  /**
   * 이 탭이 지금 보고 있는 세션 — `{ tab_id, session: { manager_id, cli, session_id } | null, visible }`.
   * 보고 있는 세션의 완료는 operator 에게 보고하지 않는다. 화면이 바뀔 때와 30초마다 온다.
   */
  @Put('presence')
  async reportPresence(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const tabId = str(body?.tab_id, 64);
    if (!tabId) return res.status(400).json({ error: 'tab_id_required', message: 'tab_id is required.' });
    const s = body?.session;
    const session = s && str(s.manager_id, 128) && str(s.cli, 64) && str(s.session_id, 256)
      ? { manager_id: str(s.manager_id, 128), cli: str(s.cli, 64), session_id: str(s.session_id, 256) }
      : null;
    this.presence.update((req as any).currentUser.id, tabId, session, body?.visible !== false);
    return res.status(204).end();
  }

  /** 음성 알림(`voice_announcement`)의 소리 — 받는 사람만. 처음 요청될 때 합성한다. */
  @Get('announcements/:id/audio')
  async announcementAudio(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const userId = (req as any).currentUser.id as string;
    return sendAudio(res, async () => ({ ...(await this.announcer.audio(id, userId)), provider: 'announcement' }));
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

/**
 * Operators — 이름 붙은 Agent Session 들(docs/voice-operator.md "Operator"). 세션 화면에서 이름을 붙여
 * 등록하고, 사이드바의 OPERATORS 가 그 세션을 연다. "헤이 <이름>" 으로 부르면 깨어난다.
 * 등록·수정·해제는 admin 만 — 사이트를 다루는 에이전트이기 때문이다.
 */
@ApiBearerAuth('user-session')
@ApiTags('voice')
@Controller('api/voice/operators')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.USE_VOICE)
export class VoiceOperatorsController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private denied(req: Request, res: Response): boolean {
    if ((req as any).currentUser?.role === 'admin') return false;
    res.status(403).json({ error: 'admin_required', message: 'Only an admin can manage operators.' });
    return true;
  }

  private async write(res: Response, fn: () => Promise<unknown>) {
    try {
      return res.json(await fn());
    } catch (err) {
      if (err instanceof OperatorInputError) return res.status(err.status).json({ error: err.code, message: err.message });
      throw err;
    }
  }

  @Get()
  async list(@Res() res: Response) {
    return res.json({ operators: await readOperators(this.dataSource) });
  }

  /** `{ name, aliases?, manager_id, cli, session_id, cwd?, title? }` — 이 세션을 이 이름의 operator 로 등록한다. */
  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    if (this.denied(req, res)) return;
    // 화면의 워크스페이스를 같이 남긴다 — 서버가 대신 보고를 보낼 때 이 워크스페이스의 CLI 설정으로 연다.
    const header = req.headers['x-account-id'];
    const accountId = String(Array.isArray(header) ? header[0] : header ?? '');
    return this.write(res, () => updateOperators(this.dataSource, (list) => {
      const operator = createOperatorEntry({ ...body, account_id: accountId }, (req as any).currentUser.id, list);
      return { next: [...list, operator], result: { operator } };
    }));
  }

  /** `{ name?, aliases?, title? }` */
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    if (this.denied(req, res)) return;
    return this.write(res, () => updateOperators(this.dataSource, (list) => {
      const current = list.find((op) => op.id === id);
      if (!current) throw new OperatorInputError(404, 'operator_not_found', 'No such operator.');
      const operator = patchOperatorEntry(current, body, list);
      return { next: list.map((op) => (op.id === id ? operator : op)), result: { operator } };
    }));
  }

  /** 등록만 푼다 — 세션은 그 장비에 그대로 남는다. */
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    if (this.denied(req, res)) return;
    return this.write(res, () => updateOperators(this.dataSource, (list) => {
      if (!list.some((op) => op.id === id)) throw new OperatorInputError(404, 'operator_not_found', 'No such operator.');
      const next = list.filter((op) => op.id !== id);
      return { next, result: { operators: next } };
    }));
  }
}

/**
 * 작업 제안(docs/voice-operator.md "작업 제안") — operator 가 다른 세션에 시키자고 남긴 프롬프트를 사용자가 보거나
 * 보내거나 거절한다. 보내는 것은 그 세션에 프롬프트를 넣는 일이라 음성 권한이 아니라 세션 권한으로 막는다.
 * 제안은 그것을 승인할 사용자에게만 보이고 그 사용자만 정한다.
 */
@ApiBearerAuth('user-session')
@ApiTags('voice')
@Controller('api/voice/proposals')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.USE_AGENT_SESSIONS)
export class VoiceProposalsController {
  constructor(private readonly proposals: OperatorProposalService) {}

  private userId(req: Request): string {
    return (req as any).currentUser.id as string;
  }

  private async run(res: Response, fn: () => Promise<unknown>) {
    try {
      return res.status(200).json(await fn());
    } catch (err) {
      if (err instanceof OperatorProposalError) return res.status(err.status).json({ error: err.code, message: err.message });
      throw err;
    }
  }

  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    return this.run(res, async () => ({ proposals: await this.proposals.listForUser(this.userId(req)) }));
  }

  /** 승인 — 대상 세션이 한가하면 바로 보내고, 턴 중이면 그 턴이 끝날 때 보낸다(status `queued`). */
  @Post(':id/send')
  async send(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    return this.run(res, async () => ({ proposal: await this.proposals.sendByUser(this.userId(req), id) }));
  }

  @Post(':id/dismiss')
  async dismiss(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    return this.run(res, async () => ({ proposal: await this.proposals.dismiss(this.userId(req), id) }));
  }
}
