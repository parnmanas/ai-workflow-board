import { ApiSecurity, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { CliLoginSessionService } from './cli-login-session.service';

const VALID_STATUSES = new Set(['awaiting_user', 'succeeded', 'failed', 'timed_out', 'cancelled']);

/**
 * Manager → server 전용 라우트. CredentialsController와 분리한 이유: 그쪽은
 * 클래스 레벨에서 PermissionGuard(사용자 세션)를 요구하므로, 같은 클래스에
 * AgentAuthGuard 라우트를 method-level로 얹으면 두 guard가 AND로 겹쳐 매니저의
 * X-Agent-Key 호출이 항상 401(사용자 세션 없음)로 막힌다.
 */
@ApiTags('agent-manager')
@Controller('api/agent-manager/cli-login')
@UseGuards(AgentAuthGuard)
export class CliLoginAgentController {
  constructor(private readonly sessions: CliLoginSessionService) {}

  @ApiSecurity('agent-api-key')
  @Post(':sessionId/progress')
  @ApiOperation({ summary: 'Manager → server: report cli_login_start progress/completion' })
  async progress(
    @Param('sessionId') sessionId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const callerAgentId = (req as any).currentAgentId as string | null;
    if (!callerAgentId) {
      return res.status(401).json({ error: 'manager apiKey could not be resolved to an agent_id' });
    }

    const status = String(body?.status || '');
    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: `invalid status "${status}"` });
    }

    try {
      const session = await this.sessions.applyProgress({
        sessionId,
        callerAgentId,
        commandId: String(body?.command_id || ''),
        status: status as any,
        verificationUrl: typeof body?.verification_url === 'string' ? body.verification_url : undefined,
        userCode: typeof body?.user_code === 'string' ? body.user_code : undefined,
        rawOutputFallback: typeof body?.raw_output_fallback === 'string' ? body.raw_output_fallback : undefined,
        errorDetail: typeof body?.error_detail === 'string' ? body.error_detail : undefined,
        credentialFields:
          body?.credential_fields && typeof body.credential_fields === 'object'
            ? body.credential_fields
            : undefined,
      });
      // 토큰 원문은 절대 응답에 싣지 않는다 — 상태 메타데이터만 돌려준다.
      return res.json({ ok: true, session_id: session.id, status: session.status });
    } catch (err: any) {
      return res.status(err?.status || 500).json({ error: err?.message || 'failed to record progress' });
    }
  }
}
