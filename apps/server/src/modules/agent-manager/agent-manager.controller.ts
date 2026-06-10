import { ApiBearerAuth, ApiSecurity, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { Agent } from '../../entities/Agent';
import { Credential } from '../../entities/Credential';
import { Ticket } from '../../entities/Ticket';
import { decrypt } from '../../services/encryption.service';
import { TriggerLoopService } from '../agents/trigger-loop.service';
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
import { ALLOWED_CLI_TYPES } from '../../common/types/cli-types';

const ALLOWED_COMMANDS: ReadonlySet<AgentManagerCommand> = new Set([
  'spawn_agent',
  'stop_agent',
  'restart_agent',
  'set_working_dir',
  'reload_config',
  'update_plugins',
  'refresh_mcp_config',
  'pull_working_dir',
  'update_manager',
  'restart_manager',
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
    private readonly triggerLoop: TriggerLoopService,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
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

    // Per-CLI model lists the manager's installed CLIs accept (cliType →
    // string[]), gathered via each adapter's listModels(). Validated leniently
    // — drop non-string entries and non-array values — and stored on the
    // instance record so the admin UI can offer a per-agent model dropdown.
    let available_models: Record<string, string[]> | undefined;
    if (body?.available_models && typeof body.available_models === 'object' && !Array.isArray(body.available_models)) {
      const out: Record<string, string[]> = {};
      for (const [cli, list] of Object.entries(body.available_models)) {
        if (!Array.isArray(list)) continue;
        const models = list.filter((s: unknown): s is string => typeof s === 'string' && !!s);
        if (models.length) out[cli] = models;
      }
      if (Object.keys(out).length) available_models = out;
    }

    // Per-managed-agent credential metadata (manager-mode only). Each row
    // is opportunistically validated — bad shapes are dropped silently
    // because the heartbeat is best-effort and a rolling-out manager
    // version is the more likely cause than malice. The token itself is
    // NEVER on the wire, so the worst-case server-side mistake here is
    // showing a stale badge until the next heartbeat.
    const agent_credentials = Array.isArray(body?.agent_credentials)
      ? body.agent_credentials
          .filter((row: any) => row && typeof row === 'object' && typeof row.agent_id === 'string' && row.agent_id)
          .map((row: any) => ({
            agent_id: String(row.agent_id),
            cli: typeof row.cli === 'string' && row.cli ? row.cli : 'unknown',
            kind:
              row.kind === 'subscription' || row.kind === 'api_key' ||
              row.kind === 'operator_home' || row.kind === 'unknown' || row.kind === 'missing'
                ? row.kind
                : 'unknown',
            expires_at_ms:
              typeof row.expires_at_ms === 'number' && Number.isFinite(row.expires_at_ms)
                ? row.expires_at_ms
                : null,
            refresh_token_present: row.refresh_token_present === true,
          }))
      : undefined;

    // Self-update fields — manager fills these via its UpdateChecker. Older
    // managers omit them and we leave the registry record's fields undefined.
    // `null` here is a meaningful "checker has run but couldn't read the
    // remote ref"; preserve it so the UI can distinguish "not yet checked"
    // from "checked, no update".
    const hasField = (k: string): boolean => Object.prototype.hasOwnProperty.call(body || {}, k);
    const latest_version = hasField('latest_version')
      ? (typeof body.latest_version === 'string' ? body.latest_version : null)
      : undefined;
    const update_available = hasField('update_available') ? Boolean(body.update_available) : undefined;
    const repo_root = hasField('repo_root')
      ? (typeof body.repo_root === 'string' ? body.repo_root : null)
      : undefined;
    const default_branch = hasField('default_branch')
      ? (typeof body.default_branch === 'string' ? body.default_branch : null)
      : undefined;
    const update_last_checked_at = hasField('update_last_checked_at')
      ? (typeof body.update_last_checked_at === 'string' ? body.update_last_checked_at : null)
      : undefined;
    const update_last_error = hasField('update_last_error')
      ? (typeof body.update_last_error === 'string' ? body.update_last_error : null)
      : undefined;

    // Self-heal: a manager heartbeat that authenticates with a valid apiKey
    // (apiKey.agent_id is the heartbeat's authoritative agent_id) but whose
    // Agent row has been deleted out from under us would otherwise leave the
    // admin AgentManager page showing an instance whose detail endpoint 404s
    // — operator reports "Edit Identity 안 됨, /api/agents/<id> 404". When
    // mode='manager', re-mint the Agent row from the heartbeat's hostname so
    // the operator can rename it via Edit Identity instead of being stuck.
    // workspace_id=null per the workspace-less invariant.
    if (mode === 'manager') {
      try {
        const exists = await this.agentRepo.findOne({ where: { id: agent_id } });
        if (!exists) {
          const hostnameStr =
            typeof body?.hostname === 'string' && body.hostname ? body.hostname : 'unknown';
          const recreated = this.agentRepo.create({
            id: agent_id,
            name: `awb-agent-manager (${hostnameStr})`,
            description: 'awb-agent-manager — recreated from heartbeat (Agent row was missing)',
            type: 'manager',
            is_active: 1,
            workspace_id: null,
            roles: '[]',
          });
          await this.agentRepo.save(recreated);
          this.logService.warn(
            'AgentManager',
            `Recreated missing manager Agent row id=${agent_id.slice(0, 8)} name="${recreated.name}" from heartbeat`,
            { agent_id, hostname: hostnameStr, instance_id, via: 'instance-heartbeat self-heal' },
          );
        }
      } catch (err: any) {
        this.logService.warn(
          'AgentManager',
          `Self-heal failed for manager agent_id=${agent_id.slice(0, 8)}: ${err?.message ?? String(err)}`,
          { err: err?.message ?? String(err), agent_id, instance_id },
        );
      }
    }

    // Manager instances are workspace-less by design (operator invariant).
    // The manager process sends its config.json workspace_id in the heartbeat
    // body for backwards compat, but we ignore it and force NULL into the
    // InstanceRegistry record — otherwise the AgentManager admin page
    // (`{inst.workspace_id || '—'}`) keeps rendering a workspace badge even
    // after the DB `agent.workspace_id` was stripped to NULL.
    const incomingWs =
      typeof body?.workspace_id === 'string' && body.workspace_id ? body.workspace_id : fallbackWorkspaceId;
    const effectiveInstanceWs = mode === 'manager' ? null : incomingWs;

    const rec = this.registry.upsert({
      instance_id,
      agent_id,
      workspace_id: effectiveInstanceWs,
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
      agent_credentials,
      available_models,
      latest_version,
      update_available,
      repo_root,
      default_branch,
      update_last_checked_at,
      update_last_error,
    });

    // Mark every managed agent the manager is supervising as alive. Managed
    // agents have no long-running process of their own — they only spawn
    // short-lived ticket-session subagents per trigger — so without this
    // their Agent.last_seen_at never advances and the AI Agents page shows
    // them OFFLINE forever even when the manager has them in agent_ids[]
    // ("live" on the Agent Manager detail page). AgentStatusService's 30s
    // sweep reads last_seen_at and emits agent_status SSE, so this update
    // is the only handoff needed.
    //
    // Ownership-scoped to the calling manager (manager_agent_id === agent_id)
    // so a heartbeat from manager A can never accidentally signal aliveness
    // for agents B owns. Empty/legacy heartbeats from non-manager modes
    // skip the update entirely.
    if (mode === 'manager' && agent_ids && agent_ids.length > 0) {
      try {
        await this.agentRepo.update(
          { id: In(agent_ids), manager_agent_id: agent_id },
          { last_seen_at: new Date(), is_online: 1 },
        );
      } catch (err: any) {
        this.logService.warn('AgentManager', 'Failed to refresh managed-agent presence on heartbeat', {
          err: err?.message ?? String(err),
          manager_agent_id: agent_id,
          managed_agent_count: agent_ids.length,
        });
      }
    }

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
    //
    // workspace_id is intentionally '' (workspace-less). A manager identity
    // isn't a per-workspace concept — it supervises managed children that may
    // live in any workspace — so the AI Agents tab in every workspace should
    // see it. The pair record still carries the original workspace_id for
    // audit / cleanup, and the API key below stays scoped there so its
    // permission surface remains workspace-bounded.
    const agentName = (rec.agent_name || `awb-agent-manager (${hostname})`).slice(0, 200);
    const agent = await this.agentRepo.save(
      this.agentRepo.create({
        name: agentName,
        description: 'awb-agent-manager — paired instance (ST-4)',
        type: 'manager',
        is_active: 1,
        // null (not '') is the canonical "no workspace" value. Manager
        // identities are global by design — they supervise children that
        // may live in any workspace. Storing '' here historically caused
        // workspace-scoped lookups (e.g. GET /api/agents/:id with
        // `In([ws, ''])`) to silently fail when the manager's leftover
        // workspace_id was something else, leaving the admin page unable
        // to load Manager identity for editing.
        workspace_id: null,
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

    // Audit: each redeem mints a *new* manager Agent row. If the operator
    // re-paired a host that already had an operator-set name (e.g. "Ralf"),
    // the new row carries the hostname-derived fallback unless rec.agent_name
    // was supplied. Children whose manager_agent_id gets re-pointed to this
    // new row will then display the new prefix — a frequent source of "all
    // my agents got renamed" reports. Log so the trail is in /admin/logs.
    this.logService.info(
      'AgentIdentity',
      `Manager agent created via pair/redeem: name="${agent.name}" (id=${agent.id.slice(0, 8)} hostname=${hostname} ws=${rec.workspace_id} pairing=${rec.id})`,
      {
        agent_id: agent.id,
        agent_name: agent.name,
        agent_type: 'manager',
        hostname,
        workspace_id: rec.workspace_id,
        pairing_id: rec.id,
        rec_agent_name: rec.agent_name || null,
        via: 'POST /api/agent-manager/pair/redeem',
      },
    );

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
  async list(@Query('workspace_id') workspaceId: string, @Res() res: Response) {
    const data = workspaceId ? this.registry.listForWorkspace(workspaceId) : this.registry.list();
    // Enrich each instance with the backing Agent.name so the admin list can
    // render the configured identity (the operator-facing label they edit
    // under "Edit Identity") instead of the OS hostname. Fallback to
    // hostname when the Agent row is missing or has no name set — keeps
    // the previous default behavior for stale rows.
    const agentIds = Array.from(new Set(data.map((i) => i.agent_id).filter(Boolean)));
    const nameMap = new Map<string, string>();
    if (agentIds.length > 0) {
      const agents = await this.agentRepo.find({ where: { id: In(agentIds) } });
      for (const a of agents) if (a.name) nameMap.set(a.id, a.name);
    }
    const enriched = data.map((inst) => ({ ...inst, agent_name: nameMap.get(inst.agent_id) || null }));
    return res.json(enriched);
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

  // Trigger an in-place restart of a manager instance.
  //
  // Dispatches `restart_manager` over the agent_manager_command SSE channel
  // — the manager re-execs itself (no git pull / install / build), so the
  // new process takes over the agent lockfile from the dying parent. Daemon /
  // proxy instances don't speak this command and return 409 here rather than
  // queuing a no-op dispatch the operator would never see acked.
  //
  // user-session auth is mandatory because the dispatch carries `issued_by` —
  // we read it through @CurrentUser and 401 on the unauthenticated case
  // even though PermissionGuard typically catches it.
  @ApiBearerAuth('user-session')
  @Post('api/admin/agent-manager/instances/:id/restart')
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Dispatch restart_manager to a manager instance (re-exec in place)',
  })
  restart(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserData | undefined,
    @Res() res: Response,
  ) {
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    const inst = this.registry.get(id);
    if (!inst) return res.status(404).json({ error: 'Instance not found or expired' });
    if (inst.mode !== 'manager') {
      return res.status(409).json({
        error: 'instance_is_not_manager',
        message:
          'Restart is only supported for awb-agent-manager instances; daemon/proxy instances do not have a re-exec hook.',
      });
    }

    const command_id = randomBytes(8).toString('hex');
    const issued_at = new Date().toISOString();
    const payload: AgentManagerCommandPayload = {
      command_id,
      instance_id: inst.instance_id,
      agent_id: inst.agent_id,
      command: 'restart_manager',
      args: {},
      issued_by: user.id,
      issued_at,
    };
    // Ledger first, then emit — same ordering as sendCommand: a fast manager
    // could ack before our local write commits and the ack handler would
    // then 410 a legitimate response.
    this.commandLedger.record({
      command_id,
      instance_id: inst.instance_id,
      agent_id: inst.agent_id,
      command: 'restart_manager',
      issued_at,
    });
    activityEvents.emit('agent_manager_command', { ...payload, timestamp: issued_at });
    this.logService.info(
      'AgentManager',
      `Sent command restart_manager to instance ${inst.instance_id} (agent=${inst.agent_id})`,
      { command_id, issued_by: user.id },
    );
    return res.status(202).json({
      ok: true,
      command_id,
      issued_at,
      message: 'restart_manager dispatched — manager will re-exec in place',
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
  async sendCommand(
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
    const args: Record<string, any> = typeof body?.args === 'object' && body.args ? { ...body.args } : {};

    // For spawn_agent: hydrate the agent record server-side and fill any
    // missing args (name / cli / working_dir / manager_agent_id) before
    // emitting. Admin-supplied args win — they're allowed to override the
    // DB value for one-off scenarios. The manager used to fetch this from
    // /api/agents/:id over its agent apiKey, but that endpoint is gated by
    // user-session permissions and always returned 401, leaving spawn_agent
    // dependent on whatever the caller happened to pass. Filling at
    // dispatch time gets rid of that round-trip and the auth mismatch.
    if (command === 'spawn_agent' && typeof args.agent_id === 'string' && args.agent_id) {
      const target = await this.agentRepo.findOne({ where: { id: args.agent_id } });
      if (target) {
        if (args.name === undefined) args.name = target.name;
        if (args.cli === undefined) args.cli = target.type;
        if (args.working_dir === undefined && target.working_dir) {
          args.working_dir = target.working_dir;
        }
        if (args.manager_agent_id === undefined && target.manager_agent_id) {
          args.manager_agent_id = target.manager_agent_id;
        }
        if (args.credential_id === undefined && target.credential_id) {
          args.credential_id = target.credential_id;
        }
        // Per-agent default model — same pattern as working_dir/credential_id.
        // The manager injects it as `--model` (claude/codex) at spawn time.
        if (args.model === undefined && target.model) {
          args.model = target.model;
        }
      }
    }

    // pull_working_dir: enrich with the canonical Agent.working_dir so the
    // manager doesn't have to /api/agent-manager/managed-agents/:id round-trip
    // before running git pull. Same pattern as spawn_agent above.
    if (command === 'pull_working_dir' && typeof args.agent_id === 'string' && args.agent_id) {
      if (!args.working_dir) {
        const target = await this.agentRepo.findOne({ where: { id: args.agent_id } });
        if (target?.working_dir) args.working_dir = target.working_dir;
      }
    }
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
    summary: 'Create an agent identity that the agent-manager will spawn (claude/codex/antigravity)',
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
    const credential_id = typeof body?.credential_id === 'string' && body.credential_id
      ? body.credential_id
      : null;
    const description = typeof body?.description === 'string' ? body.description : '';
    // Per-agent default model — free-form (validated only as a string). The
    // admin UI fills it from the manager's reported available_models, but a
    // free-text value is allowed too (the list may not cover every model the
    // account can access). Empty = unset.
    const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : null;

    // If a manager_agent_id is supplied, sanity-check the row exists and is
    // actually a manager identity (type='manager', minted by pair/redeem). The
    // manager is intentionally *not* required to live in the same workspace as
    // the agent it supervises — managers are paired once by an admin and may
    // run agents for any workspace they're given identities in. Silently
    // dropping a typo'd link would make spawn-routing mysteriously fail, so
    // we still fail fast on a missing/wrong-type row.
    if (manager_agent_id) {
      const m = await this.agentRepo.findOne({ where: { id: manager_agent_id } });
      if (!m) return res.status(400).json({ error: 'manager_agent_id does not exist' });
      if (m.type !== 'manager') {
        return res.status(400).json({ error: 'manager_agent_id must reference a manager-type agent' });
      }
    }
    // Same sanity check for credential_id — fail fast with a clear error rather
    // than letting spawn time discover the broken FK on the agent-manager side.
    if (credential_id) {
      const c = await this.credentialRepo.findOne({ where: { id: credential_id, workspace_id: workspaceId } });
      if (!c) return res.status(400).json({ error: 'credential_id does not exist in this workspace' });
    }

    const agent = await this.agentRepo.save(
      this.agentRepo.create({
        name,
        description,
        // Store the CLI selector in the existing `type` field so existing
        // listings (which key off type) keep working. claude/codex/antigravity/custom.
        type: cli,
        is_active: 1,
        workspace_id: workspaceId,
        working_dir,
        manager_agent_id,
        credential_id,
        model,
        roles: '[]',
      }),
    );
    return res.status(201).json(agent);
  }

  // ─── Cross-workspace manager listing ──────────────────────────────────
  //
  // Managers are paired by an admin into whatever workspace was active when
  // the pairing token was minted, but the workspace AI Agents tab needs to
  // surface every reachable manager so an operator can attach an agent in
  // their own workspace to a globally-paired manager. We deliberately
  // bypass the WorkspaceGuard scoping here — MANAGE_AGENTS still gates
  // access — so managers minted in workspace A are visible to MANAGE_AGENTS
  // holders in workspace B. Returns only the columns the picker needs.
  @ApiBearerAuth('user-session')
  @Get('api/admin/agent-manager/managers')
  @UseGuards(PermissionGuard, WorkspaceGuard)
  @RequirePermission(PERMISSIONS.MANAGE_AGENTS)
  @ApiOperation({
    summary: 'List every Agent row with type=manager (cross-workspace)',
  })
  async listManagers(@Res() res: Response) {
    const managers = await this.agentRepo.find({
      where: { type: 'manager' },
      order: { name: 'ASC' },
    });
    return res.json(
      managers.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        workspace_id: m.workspace_id,
        is_active: m.is_active,
      })),
    );
  }

  // ─── Move a managed agent to a different workspace ────────────────────
  //
  // Pre-existing managed agents created against a global manager already
  // ended up in the manager's pairing-time workspace. The AgentManager
  // admin page now exposes a per-row workspace picker so operators can
  // re-home those agents into the correct workspace without recreating
  // them. type and manager_agent_id are intentionally untouched.
  @ApiBearerAuth('user-session')
  @Patch('api/admin/agent-manager/agents/:id/workspace')
  @UseGuards(PermissionGuard, WorkspaceGuard)
  @RequirePermission(PERMISSIONS.MANAGE_AGENTS)
  @ApiOperation({
    summary: 'Move an existing managed-agent identity into a different workspace',
  })
  async setManagedAgentWorkspace(
    @Param('id') agentId: string,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const target_workspace_id =
      typeof body?.workspace_id === 'string' && body.workspace_id ? body.workspace_id : '';
    if (!target_workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    // Guard against re-homing a manager identity through this endpoint —
    // managers don't carry per-workspace meaning the same way managed
    // children do (children inherit their manager regardless of ws).
    if (agent.type === 'manager') {
      return res.status(400).json({ error: 'cannot move a manager-type agent through this endpoint' });
    }

    agent.workspace_id = target_workspace_id;
    const updated = await this.agentRepo.save(agent);
    this.logService.info(
      'AgentManager',
      `Managed agent moved id=${agent.id.slice(0, 8)} → ws=${target_workspace_id.slice(0, 8)}`,
    );
    return res.json(updated);
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

  // ─── ST-7 manager → server: read a managed-agent record the manager owns ─
  //
  // Mirror of the apikey provision route above: AgentAuthGuard + ownership
  // check (`target.manager_agent_id === caller`). Manager calls this from
  // `fetchAgentRecord` to hydrate a managed agent's canonical name / cli /
  // working_dir before spawn / set_working_dir. Replaces the previous reach
  // into `/api/agents/:id`, which is gated by user-session permissions and
  // always returned 401 to the manager — see the matching enrichment in
  // sendCommand for the dispatch-time fallback.
  @ApiSecurity('agent-api-key')
  @Get('api/agent-manager/managed-agents/:id')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({
    summary: 'Manager → server: fetch the canonical record of a managed agent it owns',
  })
  async getManagedAgentForManager(
    @Param('id') targetAgentId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const callerAgentId = (req as any).currentAgentId as string | null;
    if (!callerAgentId) return res.status(401).json({ error: 'manager apiKey could not be resolved to an agent_id' });

    const target = await this.agentRepo.findOne({ where: { id: targetAgentId } });
    if (!target) return res.status(404).json({ error: 'target agent not found' });

    if (target.manager_agent_id !== callerAgentId) {
      this.logService.warn(
        'AgentManager',
        `Refused agent record fetch: caller=${callerAgentId.slice(0, 8)} is not owner of target=${targetAgentId.slice(0, 8)} (owner=${target.manager_agent_id || 'none'})`,
      );
      return res.status(403).json({ error: 'caller is not the owning manager for this agent' });
    }

    return res.json({
      id: target.id,
      name: target.name,
      type: target.type,
      working_dir: target.working_dir,
      manager_agent_id: target.manager_agent_id,
      workspace_id: target.workspace_id,
      credential_id: target.credential_id,
      // Per-agent default model — the manager's fetchAgentRecord reads this as
      // remote.model and prefers it over the spawn payload's args.model.
      model: target.model,
    });
  }

  // Manager → server: read the decrypted CLI credential for a managed agent
  // it owns. Same auth model as getManagedAgentForManager: AgentAuthGuard +
  // ownership check. Returned payload carries provider + raw credential
  // fields (auth.json contents, api_key string, etc.) so the manager can
  // either write a credential file into per-agent cli-home (subscription
  // kind) or set the matching env var at spawn (api_key kind). Returns 204
  // when the agent has no credential_id set, which the manager treats as
  // "fall back to operator HOME" (legacy behaviour).
  @ApiSecurity('agent-api-key')
  @Get('api/agent-manager/managed-agents/:id/credential')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({
    summary: "Manager → server: fetch the decrypted CLI credential for a managed agent it owns",
  })
  async getManagedAgentCredential(
    @Param('id') targetAgentId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const callerAgentId = (req as any).currentAgentId as string | null;
    if (!callerAgentId) return res.status(401).json({ error: 'manager apiKey could not be resolved to an agent_id' });

    const target = await this.agentRepo.findOne({ where: { id: targetAgentId } });
    if (!target) return res.status(404).json({ error: 'target agent not found' });

    if (target.manager_agent_id !== callerAgentId) {
      this.logService.warn(
        'AgentManager',
        `Refused credential fetch: caller=${callerAgentId.slice(0, 8)} is not owner of target=${targetAgentId.slice(0, 8)} (owner=${target.manager_agent_id || 'none'})`,
      );
      return res.status(403).json({ error: 'caller is not the owning manager for this agent' });
    }

    if (!target.credential_id) return res.status(204).send();

    const cred = await this.credentialRepo.findOne({
      where: {
        id: target.credential_id,
        // target.workspace_id is nullable now (manager rows store NULL); a
        // managed agent fetching its credential should never have NULL here,
        // but the filter is omitted defensively so the lookup keys only on
        // id when the workspace pointer is missing.
        ...(target.workspace_id ? { workspace_id: target.workspace_id } : {}),
      },
    });
    if (!cred) {
      this.logService.warn(
        'AgentManager',
        `Managed agent credential ${target.credential_id.slice(0, 8)} not found for agent=${target.id.slice(0, 8)} — falling back to none`,
      );
      return res.status(404).json({ error: 'credential not found' });
    }

    // Disambiguate "stored fields legitimately empty" from "decrypt silently
    // failed". encryption.service.decrypt() returns '' on key mismatch — the
    // legacy code path then JSON.parse'd that, threw, and returned 200 OK
    // with fields={} (silent), which downstream surfaced as a managed agent
    // running with no auth at all. Now: if the ciphertext was 'enc:'-prefixed
    // (i.e. genuinely encrypted) but decrypt returned '', surface as 503 with
    // a clear message so the operator can re-edit the credential to re-encrypt
    // it under the current key.
    const ciphertext = cred.encrypted_data || '';
    const plaintext = ciphertext ? decrypt(ciphertext) : '';
    if (ciphertext.startsWith('enc:') && !plaintext) {
      this.logService.error(
        'AgentManager',
        `Credential decrypt failed for cred=${cred.id.slice(0, 8)} (provider=${cred.provider}). ` +
          `Likely cause: ENCRYPTION_KEY env / .encryption_key file changed since the credential was saved. ` +
          `Operator must re-edit the credential in Admin → Credentials to re-encrypt it under the current key.`,
      );
      return res.status(503).json({
        error: 'credential_decrypt_failed',
        credential_id: cred.id,
        provider: cred.provider,
        detail:
          'Server failed to decrypt the stored credential. The encryption key may have changed since ' +
          'the credential was saved. Re-edit the credential in Admin → Credentials to re-encrypt it.',
      });
    }

    let fields: Record<string, string> = {};
    if (plaintext) {
      try {
        const decoded = JSON.parse(plaintext);
        if (decoded && typeof decoded === 'object') {
          fields = decoded as Record<string, string>;
        }
      } catch {
        // Plaintext didn't parse as JSON — treat as empty fields and warn.
        // Caller (manager) already handles the empty-fields case with its own
        // explicit ERROR log so the operator sees what's mis-configured.
        this.logService.warn(
          'AgentManager',
          `Credential plaintext is not valid JSON for cred=${cred.id.slice(0, 8)}`,
        );
      }
    }

    return res.json({
      credential_id: cred.id,
      provider: cred.provider,
      fields,
    });
  }

  // Manager → server: immediately re-push agent_trigger(s) for the in-flight
  // (ticket, role) work a just-restarted managed agent was interrupted on.
  //
  // restart_agent now reaps the agent's zombie one-shot subagents + persistent
  // sessions (ticket 86683d12). The killed children were mid-flight on real
  // tickets; without this endpoint the agent wouldn't resume that work until
  // TicketSupervisorService's ~30-min stale sweep noticed and re-pushed. The
  // manager calls this right after the fresh spawn so the agent picks the work
  // back up on the new credential in seconds, not half an hour.
  //
  // Auth: AgentAuthGuard validates the manager's apiKey; ownership is enforced
  // (target.manager_agent_id === caller) exactly like the sibling
  // managed-agent routes. Each trigger is emitted with force_respawn +
  // bypassFocus so the precise interrupted ticket resumes regardless of which
  // ticket the focus selector would otherwise pick.
  @ApiSecurity('agent-api-key')
  @Post('api/agent-manager/managed-agents/:id/resume-triggers')
  @UseGuards(AgentAuthGuard)
  @ApiOperation({
    summary: "Manager → server: re-push triggers for a restarted agent's interrupted work",
  })
  async resumeManagedAgentTriggers(
    @Param('id') targetAgentId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const callerAgentId = (req as any).currentAgentId as string | null;
    if (!callerAgentId) return res.status(401).json({ error: 'manager apiKey could not be resolved to an agent_id' });

    const target = await this.agentRepo.findOne({ where: { id: targetAgentId } });
    if (!target) return res.status(404).json({ error: 'target agent not found' });

    if (target.manager_agent_id !== callerAgentId) {
      this.logService.warn(
        'AgentManager',
        `Refused resume-triggers: caller=${callerAgentId.slice(0, 8)} is not owner of target=${targetAgentId.slice(0, 8)} (owner=${target.manager_agent_id || 'none'})`,
      );
      return res.status(403).json({ error: 'caller is not the owning manager for this agent' });
    }

    // De-dup (ticket_id, role) and drop malformed rows. The manager already
    // de-dups across its session/subagent managers, but a hostile / buggy
    // client shouldn't be able to fan out N emits per ticket from here.
    const rawItems = Array.isArray(body?.items) ? body.items : [];
    const byKey = new Map<string, { ticket_id: string; role: string }>();
    for (const item of rawItems) {
      const ticket_id = typeof item?.ticket_id === 'string' ? item.ticket_id.trim() : '';
      const role = typeof item?.role === 'string' ? item.role.trim() : '';
      if (!ticket_id) continue;
      byKey.set(`${ticket_id}:${role}`, { ticket_id, role });
    }
    const items = Array.from(byKey.values());

    let emitted = 0;
    let skipped = 0;
    for (const { ticket_id, role } of items) {
      const ticket = await this.ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) {
        skipped++;
        continue;
      }
      try {
        // bypassFocus: the agent was demonstrably working this exact ticket
        // before the restart killed its child, so resume THIS ticket rather
        // than letting the focus selector re-pick. force_respawn so any
        // racing leftover child is replaced by a fresh one on the new
        // credential. _emitTrigger still honors board-paused / archived /
        // pending gates, so a re-push can't reanimate parked work.
        await this.triggerLoop.emitAgentTrigger(
          ticket,
          target.id,
          role,
          'manager_restart',
          'system',
          { forceRespawn: true, bypassFocus: true },
        );
        emitted++;
      } catch (err: any) {
        skipped++;
        this.logService.warn('AgentManager', 'resume-triggers emit failed', {
          err: err?.message ?? String(err),
          ticket_id,
          role,
          agent_id: target.id,
        });
      }
    }

    this.logService.info(
      'AgentManager',
      `resume-triggers agent=${target.id.slice(0, 8)} requested=${items.length} emitted=${emitted} skipped=${skipped}`,
      { agent_id: target.id, requested: items.length, emitted, skipped },
    );
    return res.json({ ok: true, emitted, skipped });
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
    // Hard-delete previous provisioning rows (not soft-revoke). Each spawn /
    // restart used to add one is_active=0 row and never clean it up, so the
    // table grew unbounded — operator hit "수십개" after only a few weeks
    // of normal use. The audit trail for "previous key existed and rotated"
    // is captured in the LogService.info call below; the raw row itself
    // carries no information once it's superseded.
    const removed = await this.apiKeyService.deleteApiKeysByAgentAndNamePrefix(target.id, provisionPrefix);
    if (removed > 0) {
      this.logService.info(
        'AgentManager',
        `Rotated managed-agent apiKey for ${target.id.slice(0, 8)} — deleted ${removed} superseded provisioning row(s)`,
        { agent_id: target.id, removed },
      );
    }

    const issued = await this.apiKeyService.createApiKey({
      name: `${provisionPrefix}${target.name}`,
      agent_id: target.id,
      scope: 'full',
      // target.workspace_id is nullable (managers carry NULL). Provisioning
      // a key for a managed agent that has no workspace falls back to '' so
      // the apiKey row's workspace_id stays a definite string (which the
      // ApiKey entity / query layer expect).
      workspace_id: target.workspace_id ?? '',
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
