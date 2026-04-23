import { Controller, Get, Post, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Agent } from '../../entities/Agent';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { FsBrowserService, FsOp, FsPluginResponse } from '../../services/fs-browser.service';
import { LogService } from '../../services/log.service';

/**
 * Two route families share this controller:
 *   - `/api/agents/:id/fs/*` — user session + BROWSE_AGENT_FS perm. Web UI
 *     calls these; controller forwards to the plugin via FsBrowserService
 *     and awaits the plugin's response.
 *   - `/api/fs/responses/:requestId` — agent API key (X-Agent-Key). Plugin
 *     POSTs the op result back here; ownership is checked before resolving
 *     the pending promise.
 *
 * Separate path prefix for the response route (`/api/fs/...`) instead of
 * nesting under `/api/agents/...` keeps the two auth surfaces visually
 * distinct and makes it obvious that the response endpoint is plugin-only.
 */

const READ_LIMIT_CAP = 5 * 1024 * 1024; // 5 MB per read — plugin enforces the same.

@ApiBearerAuth('user-session')
@ApiTags('agent-fs')
@Controller()
export class FsBrowserController {
  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly fsBrowser: FsBrowserService,
    private readonly logService: LogService,
  ) {}

  // ─── User-facing: roots / list / stat / read ──────────────────────

  @Get('api/agents/:id/fs/roots')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.BROWSE_AGENT_FS)
  @ApiOperation({
    summary: 'Report the agent\'s configured scope roots and current working directory',
    description: 'UI calls this on open to decide the initial directory without the user having to type a path. Also tells the UI whether fs browsing is enabled on the plugin side.',
  })
  async roots(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.forward(id, 'roots', {}, req, res);
  }

  @Get('api/agents/:id/fs/list')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.BROWSE_AGENT_FS)
  @ApiOperation({ summary: 'List a directory on the agent machine' })
  @ApiParam({ name: 'id', description: 'Target agent ID' })
  @ApiQuery({ name: 'path', description: 'Absolute path on the agent machine' })
  async list(
    @Param('id') id: string,
    @Query('path') path: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.forward(id, 'list', { path }, req, res);
  }

  @Get('api/agents/:id/fs/stat')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.BROWSE_AGENT_FS)
  @ApiOperation({ summary: 'Stat a file or directory on the agent machine' })
  async stat(
    @Param('id') id: string,
    @Query('path') path: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.forward(id, 'stat', { path }, req, res);
  }

  @Get('api/agents/:id/fs/read')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.BROWSE_AGENT_FS)
  @ApiOperation({
    summary: 'Read a file on the agent machine',
    description: 'Returns content as utf8 when text-like, base64 otherwise. Size capped at 5MB per request; use offset/limit for larger files.',
  })
  @ApiQuery({ name: 'offset', required: false, description: 'Byte offset (default 0)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max bytes (server caps at 5MB)' })
  async read(
    @Param('id') id: string,
    @Query('path') path: string,
    @Query('offset') offset: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const off = offset ? Math.max(0, parseInt(offset, 10) || 0) : 0;
    const lim = Math.min(limit ? Math.max(1, parseInt(limit, 10) || 0) : READ_LIMIT_CAP, READ_LIMIT_CAP);
    return this.forward(id, 'read', { path, offset: off, limit: lim }, req, res);
  }

  // ─── Plugin-facing: response receiver ─────────────────────────────

  @Post('api/fs/responses/:requestId')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({ summary: 'Plugin → server: deliver the response for an earlier fs_request' })
  async deliverResponse(
    @Param('requestId') requestId: string,
    @Body() body: FsPluginResponse,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const agentId = this.resolveAgentFromRequest(req);
    if (!agentId) return res.status(401).json({ error: 'Could not resolve agent from API key' });

    if (!requestId || typeof requestId !== 'string') {
      return res.status(400).json({ error: 'request_id is required' });
    }
    if (!body || typeof body.ok !== 'boolean') {
      return res.status(400).json({ error: 'body must include an "ok" boolean' });
    }

    const outcome = this.fsBrowser.resolveResponse(requestId, agentId, body);
    if (!outcome.ok) {
      // Either the pending was already resolved (timeout or duplicate) or the
      // caller is the wrong agent. Both map to 404/403 from the plugin's POV
      // but "unknown request_id" is the honest diagnosis — the plugin can't
      // act on this distinction anyway.
      return res.status(404).json({ error: outcome.reason || 'Unknown request_id' });
    }
    return res.status(204).send();
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  private resolveAgentFromRequest(req: Request): string | null {
    // AgentAuthGuard loaded apiKey with .agent relation; pull the id off it.
    // Keeping the lookup synchronous here avoids another DB hit since the
    // guard already did the work. Fallback to currentWorkspaceId style
    // properties the guard attaches in case future refactors move things.
    const auth = (req as any).apiKey;
    if (auth?.agent_id) return auth.agent_id;
    const scoped = (req as any).currentAgentId;
    return typeof scoped === 'string' && scoped ? scoped : null;
  }

  private async forward(
    agentId: string,
    op: FsOp,
    args: { path?: string; offset?: number; limit?: number },
    req: Request,
    res: Response,
  ) {
    // `roots` is a self-describing discovery call — no path input makes sense.
    // Every other op needs a concrete absolute path from the caller.
    if (op !== 'roots' && (!args.path || typeof args.path !== 'string')) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    const currentUser = (req as any).currentUser;
    const userLabel = currentUser?.name || currentUser?.id || 'unknown';

    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!agent.is_online) {
      return res.status(503).json({ error: 'Agent is offline', code: 'AGENT_OFFLINE' });
    }

    this.logService.info('FsBrowser', `${userLabel} ${op} ${args.path ?? ''} on agent ${agent.name} (${agent.id})`);

    try {
      const result = await this.fsBrowser.request(agentId, op, args);
      if (!result.ok) {
        const status = mapErrorCode(result.code);
        return res.status(status).json({ error: result.error || 'Plugin returned error', code: result.code });
      }
      return res.json(result.data);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg === 'Agent offline') return res.status(503).json({ error: msg, code: 'AGENT_OFFLINE' });
      if (msg === 'Agent not found') return res.status(404).json({ error: msg });
      this.logService.error('FsBrowser', `Request failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
  }
}

function mapErrorCode(code: string | undefined): number {
  switch (code) {
    case 'SCOPE_DENIED': return 403;
    case 'FS_BROWSER_DISABLED': return 403;
    case 'ENOENT': return 404;
    case 'EACCES': return 403;
    case 'EISDIR': return 400;
    case 'ENOTDIR': return 400;
    case 'TIMEOUT': return 504;
    case 'PATH_INVALID': return 400;
    default: return 500;
  }
}
