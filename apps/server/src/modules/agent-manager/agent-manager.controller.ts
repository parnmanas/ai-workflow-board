import { ApiBearerAuth, ApiSecurity, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { Agent } from '../../entities/Agent';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { LogService } from '../../services/log.service';
import { ApiKeyService } from '../../services/api-key.service';
import { SubagentMonitorService } from '../../services/subagent-monitor.service';
import { activityEvents } from '../../services/activity.service';
import { InstanceRegistryService } from './instance-registry.service';
import { PairingService } from './pairing.service';
import { CommandLedgerService } from './command-ledger.service';
import type { AgentManagerCommand, AgentManagerCommandPayload } from '../../common/types/stream-events';

const ALLOWED_CLI_TYPES = new Set(['claude', 'codex', 'gemini', 'custom']);
const ALLOWED_COMMANDS: ReadonlySet<AgentManagerCommand> = new Set([
  'spawn_agent',
  'stop_agent',
  'restart_agent',
  'set_working_dir',
  'reload_config',
] as const);

/**
 * Agent Manager — Phase 3 admin dashboard for live daemon/proxy/manager
 * instances + ST-4 pairing/control flow for the standalone awb-agent-manager.
 *
 * Three audiences:
 *   - Plugin / agent-manager (X-Agent-Key): POST `/api/agent/instance-heartbeat`
 *     to register and refresh per-process presence. ST-4 manager mode adds
 *     agent_ids[]/working_dirs[]/paired_at to the InstanceRecord.
 *   - Admin user: GET `/api/admin/agent-manager/instances` etc. for the
 *     dashboard at `/admin/agent-manager`. ST-4 adds pairing/command endpoints.
 *   - awb-agent-manager bootstrap: POST `/api/agent-manager/pair/redeem`
 *     swaps a one-time pairing token for an API key + agent identity.
 *   - awb-agent-manager runtime: POST `/api/agent-manager/command/ack`
 *     reports back the result of a control command.
 */
@ApiTags('agent-manager')
@Controller()
export class AgentManagerController {
  constructor(
    private readonly registry: InstanceRegistryService,
    private readonly pairing: PairingService,
    private readonly apiKeyService: ApiKeyService,
    private readonly subagentMonitor: SubagentMonitorService,
    private readonly logService: LogService,
    private readonly commandLedger: CommandLedgerService,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
  ) {}

  // ─── Plugin / manager → Server ───────────────────────────────────────────

  @ApiSecurity('agent-api-key')
  @Post('api/agent/instance-heartbeat')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({
    summary: 'Plugin / awb-agent-manager → server: register / refresh a process instance',
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

    const mode: 'daemon' | 'proxy' | 'manager' =
      body?.mode === 'daemon' ? 'daemon' : body?.mode === 'manager' ? 'manager' : 'proxy';
    const cli_adapters = Array.isArray(body?.cli_adapters)
      ? body.cli_adapters.filter((s: unknown): s is string => typeof s === 'string' && !!s)
      : [];

    // ST-4: manager-mode metadata. Daemons/proxies pass through as undefined.
    const agent_ids = Array.isArray(body?.agent_ids)
      ? body.agent_ids.filter((s: unknown): s is string => typeof s === 'string' && !!s)
      : undefined;
    const working_dirs = Array.isArray(body?.working_dirs)
      ? body.working_dirs.filter((s: unknown): s is string => typeof s === 'string' && !!s)
      : undefined;
    const paired_at = typeof body?.paired_at === 'string' && body.paired_at ? body.paired_at : undefined;

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
      agent_ids,
      working_dirs,
      paired_at,
    });

    return res.json({ ok: true, instance_id: rec.instance_id, last_seen_at: rec.last_seen_at });
  }

  // ─── ST-4 awb-agent-manager bootstrap (pairing redeem) ──────────────────

  /**
   * Manager-side: exchange a pairing token (issued by an admin via the AWB
   * UI) for an API key, agent identity, and workspace binding. The token is
   * the only auth — the handler is intentionally guard-less because the
   * caller has nothing else yet. Single-shot: a redeemed token is consumed.
   */
  @Post('api/agent-manager/pair/redeem')
  @ApiOperation({ summary: 'Manager bootstrap — redeem a pairing token for an API key + agent identity' })
  async pairRedeem(@Body() body: any, @Res() res: Response) {
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';
    const instance_id = typeof body?.instance_id === 'string' ? body.instance_id.trim() : '';
    const hostname = typeof body?.hostname === 'string' ? body.hostname.trim() : 'unknown';
    if (!token && !code) {
      return res.status(400).json({ error: 'token or code is required' });
    }
    if (!instance_id) {
      return res.status(400).json({ error: 'instance_id is required' });
    }

    // Resolve a code → token if the user typed in the short display code.
    let resolvedToken = token;
    if (!resolvedToken && code) {
      // PairingService doesn't expose a code lookup directly (the token is
      // the bearer, not the code). Iterate the workspace-scoped list of any
      // known workspace to find a match — small fan-out, in-memory map.
      // We don't know the workspace here, so do an unscoped scan via the
      // service's internal map. Add a thin helper for this.
      const found = (this.pairing as any).findByCode?.(code);
      if (found && typeof found.token === 'string') resolvedToken = found.token;
    }
    if (!resolvedToken) return res.status(401).json({ error: 'Invalid or expired pairing token' });

    const rec = this.pairing.redeem(resolvedToken, instance_id);
    if (!rec) return res.status(401).json({ error: 'Invalid or expired pairing token' });

    // Create (or reuse) the manager Agent identity. We always create a fresh
    // identity per pairing redemption — sharing one Agent row across multiple
    // hosts is supported (commands fan-out by agent_id), but each redemption
    // gets its own row so revoking one host doesn't kick the others off.
    const agentName = (rec.agent_name || `awb-agent-manager (${hostname})`).slice(0, 200);
    const agent = await this.agentRepo.save(
      this.agentRepo.create({
        name: agentName,
        description: 'awb-agent-manager — paired instance (ST-4)',
        type: 'manager',
        is_active: 1,
        workspace_id: rec.workspace_id,
        roles: '[]',
      }),
    );

    const apiKey = await this.apiKeyService.createApiKey({
      name: `agent-manager:${hostname}:${rec.id}`,
      agent_id: agent.id,
      scope: 'full',
      workspace_id: rec.workspace_id,
    });

    this.logService.info('AgentManager', `Pairing redeemed id=${rec.id} ws=${rec.workspace_id} agent=${agent.id}`);

    return res.status(201).json({
      ok: true,
      api_key: apiKey.raw_key,
      agent_id: agent.id,
      agent_name: agent.name,
      workspace_id: rec.workspace_id,
      paired_at: rec.redeemed_at,
    });
  }

  // ─── ST-4 awb-agent-manager runtime — command ack ───────────────────────

  /**
   * Manager-side: report back the outcome of an agent_manager_command SSE
   * dispatch. Arrives via REST (not SSE) so failure on the bidirectional
   * stream doesn't strand the response. Requires the manager's API key
   * (AgentAuthGuard) so a hostile client can't fake an ack for somebody
   * else's command.
   */
  @ApiSecurity('agent-api-key')
  @Post('api/agent-manager/command/ack')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({ summary: 'Manager → server: ack the outcome of a control command' })
  async commandAck(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const callerAgentId = (req as any).currentAgentId || (req as any).apiKey?.agent_id || null;
    const command_id = typeof body?.command_id === 'string' ? body.command_id : '';
    const status = body?.status === 'ok' ? 'ok' : body?.status === 'error' ? 'error' : null;
    if (!command_id || !status) {
      return res.status(400).json({ error: 'command_id and status (ok|error) are required' });
    }

    // Ledger lookup verifies (a) the command was actually dispatched and
    // hasn't been acked yet, and (b) the API key acking it belongs to the
    // same manager Agent identity that the dispatch was scoped to.
    const record = this.commandLedger.consume(command_id);
    if (!record) {
      this.logService.warn(
        'AgentManager',
        `Command ack rejected — no pending dispatch (id=${command_id}, caller=${callerAgentId})`,
        { command_id, caller_agent_id: callerAgentId, status },
      );
      return res.status(410).json({ error: 'command_id is unknown or its ack window has expired' });
    }
    if (callerAgentId && callerAgentId !== record.agent_id) {
      // Re-record so the legitimate manager can still ack within the TTL.
      this.commandLedger.record(record);
      this.logService.warn(
        'AgentManager',
        `Command ack rejected — caller mismatch (id=${command_id}, caller=${callerAgentId}, expected=${record.agent_id})`,
        { command_id, caller_agent_id: callerAgentId, expected_agent_id: record.agent_id, status },
      );
      return res.status(403).json({ error: 'caller does not own this command_id' });
    }

    const detail = typeof body?.detail === 'string' ? body.detail.slice(0, 2000) : '';
    this.logService.info(
      'AgentManager',
      `Command ack id=${command_id} status=${status} command=${record.command} agent=${callerAgentId}`,
      { command_id, status, detail, command: record.command, agent_id: callerAgentId },
    );
    return res.json({ ok: true });
  }

  // ─── Admin → Server (instances) ──────────────────────────────────────────

  @ApiBearerAuth('user-session')
  @Get('api/admin/agent-manager/instances')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.ADMIN_ACCESS)
  @ApiOperation({ summary: 'List currently-heartbeating daemon/proxy/manager instances' })
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

  // ─── ST-4 admin → server: pairing tokens ────────────────────────────────

  @ApiBearerAuth('user-session')
  @Post('api/admin/agent-manager/pair')
  @UseGuards(PermissionGuard, WorkspaceGuard)
  @RequirePermission(PERMISSIONS.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Mint a one-time pairing token for an awb-agent-manager bootstrap' })
  pairMint(
    @Body() body: any,
    @CurrentUser() user: CurrentUserData | undefined,
    @CurrentWorkspaceId() workspaceId: string | null,
    @Res() res: Response,
  ) {
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const agent_name = typeof body?.agent_name === 'string' && body.agent_name.trim()
      ? body.agent_name.trim().slice(0, 200)
      : undefined;
    const rec = this.pairing.mint({
      workspace_id: workspaceId,
      created_by_user_id: user.id,
      agent_name,
    });
    // Raw token is returned ONCE — caller must hand it (or the display code)
    // to the manager CLI immediately. Subsequent listings only show the code.
    return res.status(201).json(rec);
  }

  @ApiBearerAuth('user-session')
  @Get('api/admin/agent-manager/pair')
  @UseGuards(PermissionGuard, WorkspaceGuard)
  @RequirePermission(PERMISSIONS.ADMIN_ACCESS)
  @ApiOperation({ summary: 'List active pairing tokens for the current workspace' })
  pairList(@CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    if (!workspaceId) return res.json([]);
    return res.json(this.pairing.listForWorkspace(workspaceId));
  }

  @ApiBearerAuth('user-session')
  @Delete('api/admin/agent-manager/pair/:id')
  @UseGuards(PermissionGuard, WorkspaceGuard)
  @RequirePermission(PERMISSIONS.ADMIN_ACCESS)
  @ApiOperation({ summary: 'Revoke an unredeemed pairing token' })
  pairRevoke(
    @Param('id') id: string,
    @CurrentWorkspaceId() workspaceId: string | null,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const ok = this.pairing.revoke(id, workspaceId);
    if (!ok) return res.status(404).json({ error: 'Pairing token not found' });
    return res.json({ ok: true });
  }

  // ─── ST-4 admin → server: control commands ──────────────────────────────

  @ApiBearerAuth('user-session')
  @Post('api/admin/agent-manager/instances/:id/command')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Send a control command (spawn/stop/restart/set_working_dir/reload_config) to a manager instance',
  })
  sendCommand(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: CurrentUserData | undefined,
    @Res() res: Response,
  ) {
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const inst = this.registry.get(id);
    if (!inst) return res.status(404).json({ error: 'Instance not found or expired' });
    if (inst.mode !== 'manager') {
      return res.status(409).json({
        error: 'instance_is_not_manager',
        message: 'Control commands only target awb-agent-manager instances; this is a daemon/proxy.',
      });
    }
    const command = String(body?.command || '') as AgentManagerCommand;
    if (!ALLOWED_COMMANDS.has(command)) {
      return res.status(400).json({ error: `unknown command "${command}"` });
    }
    const args = typeof body?.args === 'object' && body.args ? body.args : {};
    const command_id = randomBytes(8).toString('hex');
    const issued_at = new Date().toISOString();

    const payload: AgentManagerCommandPayload = {
      command_id,
      instance_id: inst.instance_id,
      agent_id: inst.agent_id,
      command,
      args,
      issued_by: user.id,
      issued_at,
    };
    // Ledger first, then emit. The order matters: a manager that processes
    // the SSE event very quickly could ack before our local write commits,
    // and the ack handler would then 410 Gone a legitimate response.
    this.commandLedger.record({
      command_id,
      instance_id: inst.instance_id,
      agent_id: inst.agent_id,
      command,
      issued_at,
    });
    activityEvents.emit('agent_manager_command', { ...payload, timestamp: issued_at });
    this.logService.info(
      'AgentManager',
      `Sent command ${command} to instance ${inst.instance_id} (agent=${inst.agent_id})`,
      { command_id, args, issued_by: user.id },
    );
    return res.status(202).json({ ok: true, command_id, issued_at });
  }

  // ─── ST-4 admin → server: agent identity CRUD scoped for the manager ────

  @ApiBearerAuth('user-session')
  @Post('api/admin/agent-manager/agents')
  @UseGuards(PermissionGuard, WorkspaceGuard)
  @RequirePermission(PERMISSIONS.MANAGE_AGENTS)
  @ApiOperation({
    summary: 'Create an agent identity that the agent-manager will spawn (claude/codex/gemini)',
  })
  async createManagedAgent(
    @Body() body: any,
    @CurrentWorkspaceId() workspaceId: string | null,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    const cli = typeof body?.cli === 'string' ? body.cli.trim().toLowerCase() : '';
    if (!ALLOWED_CLI_TYPES.has(cli)) {
      return res.status(400).json({ error: `cli must be one of ${[...ALLOWED_CLI_TYPES].join(', ')}` });
    }
    const working_dir = typeof body?.working_dir === 'string' ? body.working_dir.trim() : '';
    const manager_agent_id = typeof body?.manager_agent_id === 'string' && body.manager_agent_id
      ? body.manager_agent_id
      : null;
    const description = typeof body?.description === 'string' ? body.description : '';

    // If a manager_agent_id is supplied, sanity-check it exists in the same
    // workspace — silently dropping a typo'd link would make spawn-routing
    // mysteriously fail.
    if (manager_agent_id) {
      const m = await this.agentRepo.findOne({ where: { id: manager_agent_id, workspace_id: workspaceId } });
      if (!m) return res.status(400).json({ error: 'manager_agent_id does not exist in this workspace' });
    }

    const agent = await this.agentRepo.save(
      this.agentRepo.create({
        name,
        description,
        // Store the CLI selector in the existing `type` field so existing
        // listings (which key off type) keep working. claude/codex/gemini/custom.
        type: cli,
        is_active: 1,
        workspace_id: workspaceId,
        working_dir,
        manager_agent_id,
        roles: '[]',
      }),
    );
    return res.status(201).json(agent);
  }

  // ─── ST-6 manager → server: per-managed-agent API key provisioning ──────
  //
  // The manager calls this with its OWN apiKey to rotate-and-fetch an apiKey
  // scoped to a managed agent it owns. The returned raw key is delivered
  // exactly once and persisted by the manager into
  // `<MANAGER_HOME>/agents/<agent_id>/apikey`. Subagents spawned for that
  // agent then use it via `claude --mcp-config` so MCP-side attribution
  // lands on the managed agent (not the manager).
  //
  // Auth model: AgentAuthGuard validates the manager's apiKey. The owning
  // check (`Agent[target].manager_agent_id === manager_agent_id`) ensures
  // a manager can only provision keys for agents it actually owns. An admin
  // user-session route exists too (below) so an operator can rotate without
  // a live manager.

  @ApiSecurity('agent-api-key')
  @Post('api/agent-manager/managed-agents/:id/apikey/provision')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({
    summary: 'Manager → server: rotate and fetch the apiKey for a managed agent it owns',
  })
  async provisionManagedAgentKey(@Param('id') targetAgentId: string, @Req() req: Request, @Res() res: Response) {
    const callerAgentId = (req as any).currentAgentId as string | null;
    if (!callerAgentId) return res.status(401).json({ error: 'manager apiKey could not be resolved to an agent_id' });

    const target = await this.agentRepo.findOne({ where: { id: targetAgentId } });
    if (!target) return res.status(404).json({ error: 'target agent not found' });

    if (target.manager_agent_id !== callerAgentId) {
      this.logService.warn(
        'AgentManager',
        `Refused apiKey provision: caller agent=${callerAgentId.slice(0, 8)} is not owner of target=${targetAgentId.slice(0, 8)} (owner=${target.manager_agent_id || 'none'})`,
      );
      return res.status(403).json({ error: 'caller is not the owning manager for this agent' });
    }

    const issued = await this._rotateManagedAgentKey(target);
    return res.status(201).json({
      raw_key: issued.raw_key,
      key_id: issued.key_id,
      agent_id: target.id,
      workspace_id: target.workspace_id,
    });
  }

  // Admin-side equivalent — useful for operator-driven rotation without a
  // live manager (e.g. the manager box died and we want to re-provision
  // before standing up a new one). Same payload shape as the manager path.
  @ApiBearerAuth('user-session')
  @Post('api/admin/agent-manager/agents/:id/apikey/provision')
  @UseGuards(PermissionGuard, WorkspaceGuard)
  @RequirePermission(PERMISSIONS.MANAGE_AGENTS)
  @ApiOperation({ summary: 'Admin: rotate and return the managed agent\'s apiKey (one-shot)' })
  async adminProvisionManagedAgentKey(
    @Param('id') targetAgentId: string,
    @CurrentWorkspaceId() workspaceId: string | null,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const target = await this.agentRepo.findOne({ where: { id: targetAgentId, workspace_id: workspaceId } });
    if (!target) return res.status(404).json({ error: 'target agent not found in this workspace' });

    const issued = await this._rotateManagedAgentKey(target);
    return res.status(201).json({
      raw_key: issued.raw_key,
      key_id: issued.key_id,
      agent_id: target.id,
      workspace_id: target.workspace_id,
    });
  }

  /**
   * Issue a fresh apiKey for a managed agent and revoke any prior keys
   * created via this same provisioning path. The convention is name-based:
   * keys produced here carry the prefix `agent-manager-provisioned:` so
   * routine listings can distinguish them from human-created keys, and
   * rotations only invalidate previous provisioning-path keys (not user-
   * minted ones an operator might have created manually).
   */
  private async _rotateManagedAgentKey(target: Agent): Promise<{ raw_key: string; key_id: string }> {
    const provisionPrefix = 'agent-manager-provisioned:';
    await this.apiKeyService.revokeApiKeysByAgentAndNamePrefix(target.id, provisionPrefix);

    const issued = await this.apiKeyService.createApiKey({
      name: `${provisionPrefix}${target.name}`,
      agent_id: target.id,
      scope: 'full',
      workspace_id: target.workspace_id,
      expires_at: null,
    });

    this.logService.info(
      'AgentManager',
      `Provisioned apiKey for managed agent ${target.id.slice(0, 8)} (name=${target.name})`,
      { key_id: issued.apiKey.id, masked: issued.apiKey.key_masked },
    );
    return { raw_key: issued.raw_key, key_id: issued.apiKey.id };
  }
}
