import { ApiBearerAuth, ApiSecurity, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { LogService } from '../../services/log.service';
import { SubagentMonitorService } from '../../services/subagent-monitor.service';
import { InstanceRegistryService } from './instance-registry.service';

/**
 * Agent Manager — Phase 3 admin dashboard for live daemon/proxy instances.
 *
 * Three audiences:
 *   - Plugin (X-Agent-Key): POST `/api/agent/instance-heartbeat` to register
 *     and refresh per-process presence. The Agent.last_seen_at row collapses
 *     all instances to one online flag; this endpoint preserves the per-process
 *     fan-out (host, mode, plugin version, registered CLI adapters).
 *   - Admin user: GET `/api/admin/agent-manager/instances` etc. for the
 *     dashboard at `/admin/agent-manager`.
 *   - Self-update path (Phase 4): POST `/instances/:id/restart` is a stub —
 *     Phase 4 will deliver SIGUSR1 to the process via the daemon's signal
 *     handler.
 */
@ApiTags('agent-manager')
@Controller()
export class AgentManagerController {
  constructor(
    private readonly registry: InstanceRegistryService,
    private readonly subagentMonitor: SubagentMonitorService,
    private readonly logService: LogService,
  ) {}

  // ─── Plugin → Server ─────────────────────────────────────────────────────

  @ApiSecurity('agent-api-key')
  @Post('api/agent/instance-heartbeat')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({
    summary: 'Plugin → server: register / refresh a daemon-or-proxy instance',
  })
  async heartbeat(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const auth = (req as any).apiKey;
    const fallbackAgentId = (req as any).currentAgentId || auth?.agent_id || null;
    const fallbackWorkspaceId = (req as any).currentWorkspaceId ?? null;

    const instance_id = typeof body?.instance_id === 'string' ? body.instance_id.trim() : '';
    if (!instance_id) {
      return res.status(400).json({ error: 'instance_id is required' });
    }

    const agent_id = typeof body?.agent_id === 'string' && body.agent_id ? body.agent_id : fallbackAgentId;
    if (!agent_id) {
      return res.status(400).json({ error: 'agent_id is required (and could not be resolved from API key)' });
    }

    const mode = body?.mode === 'daemon' ? 'daemon' : 'proxy';
    const cli_adapters = Array.isArray(body?.cli_adapters)
      ? body.cli_adapters.filter((s: unknown): s is string => typeof s === 'string' && !!s)
      : [];

    const rec = this.registry.upsert({
      instance_id,
      agent_id,
      workspace_id: typeof body?.workspace_id === 'string' && body.workspace_id ? body.workspace_id : fallbackWorkspaceId,
      mode,
      hostname: typeof body?.hostname === 'string' && body.hostname ? body.hostname : 'unknown',
      plugin_version: typeof body?.plugin_version === 'string' && body.plugin_version ? body.plugin_version : 'unknown',
      cli: typeof body?.cli === 'string' && body.cli ? body.cli : 'claude',
      cli_adapters,
      pid: Number.isFinite(body?.pid) ? Number(body.pid) : 0,
      started_at: typeof body?.started_at === 'string' && body.started_at ? body.started_at : new Date().toISOString(),
    });

    return res.json({ ok: true, instance_id: rec.instance_id, last_seen_at: rec.last_seen_at });
  }

  // ─── Admin → Server ──────────────────────────────────────────────────────

  @ApiBearerAuth('user-session')
  @Get('api/admin/agent-manager/instances')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.ADMIN_ACCESS)
  @ApiOperation({ summary: 'List currently-heartbeating daemon/proxy instances' })
  list(@Query('workspace_id') workspaceId: string, @Res() res: Response) {
    const data = workspaceId ? this.registry.listForWorkspace(workspaceId) : this.registry.list();
    return res.json(data);
  }

  @ApiBearerAuth('user-session')
  @Get('api/admin/agent-manager/instances/:id/subagents')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Subagents currently tracked for the agent backing this instance' })
  async subagents(@Param('id') id: string, @Res() res: Response) {
    const inst = this.registry.get(id);
    if (!inst) return res.status(404).json({ error: 'Instance not found or expired' });
    if (!inst.workspace_id) {
      return res.json([]);
    }
    const all = await this.subagentMonitor.listForWorkspace(inst.workspace_id);
    return res.json(all.filter((s) => s.agent_id === inst.agent_id));
  }

  @ApiBearerAuth('user-session')
  @Get('api/admin/agent-manager/instances/:id/logs')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Recent server-side log entries that mention this instance / its agent' })
  logs(@Param('id') id: string, @Query('limit') limitRaw: string, @Res() res: Response) {
    const inst = this.registry.get(id);
    if (!inst) return res.status(404).json({ error: 'Instance not found or expired' });

    const limit = Math.min(Math.max(parseInt(limitRaw) || 100, 1), 500);
    const candidates = this.logService.query({ limit: 2000 });
    const agentIdLower = inst.agent_id.toLowerCase();
    const shortId = inst.agent_id.slice(0, 8).toLowerCase();
    const instanceIdLower = inst.instance_id.toLowerCase();
    const matched = candidates.filter((entry) => {
      const haystack = `${entry.message} ${JSON.stringify(entry.meta || {})}`.toLowerCase();
      return haystack.includes(agentIdLower) || haystack.includes(shortId) || haystack.includes(instanceIdLower);
    });
    return res.json(matched.slice(0, limit));
  }

  @ApiBearerAuth('user-session')
  @Post('api/admin/agent-manager/instances/:id/restart')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Trigger an instance restart (Phase 4 self-update — currently a stub)',
  })
  restart(@Param('id') id: string, @Res() res: Response) {
    const inst = this.registry.get(id);
    if (!inst) return res.status(404).json({ error: 'Instance not found or expired' });
    this.logService.info(
      'AgentManager',
      `Restart requested for instance ${id} (agent=${inst.agent_id}, host=${inst.hostname}, mode=${inst.mode})`,
      { instance: inst },
    );
    return res.status(501).json({
      error: 'not_implemented',
      message:
        'Restart is wired to the Phase 4 self-update endpoint. Until that lands, ' +
        'send SIGUSR1 directly to the process: `kill -USR1 <pid>` on the host.',
      instance: inst,
    });
  }
}
