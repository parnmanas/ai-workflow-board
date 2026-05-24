import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards, Inject, forwardRef } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository, In, IsNull } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { ActivityLog } from '../../entities/ActivityLog';
import { Workspace } from '../../entities/Workspace';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator';
import { PERMISSIONS, hasPermission } from '../../common/types/permissions';
import { AgentStatusService } from './agent-status.service';
import { AllocationService } from './allocation.service';
import { SubagentMonitorService } from '../../services/subagent-monitor.service';
import { InstanceRegistryService, InstanceRecord } from '../agent-manager/instance-registry.service';
import { LogService } from '../../services/log.service';
import { ApiOperation, ApiParam, ApiQuery, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { findOrFail } from '../../common/find-or-fail';

/** Subset of InstanceRecord surfaced on /api/agents responses so the AI Agents
 *  admin UI can render the same heartbeat / version / supervision metadata that
 *  the dedicated AgentManager admin page shows. `supervised` is a derived flag:
 *  true when the matched instance is a manager that lists this agent in
 *  agent_ids[]; false when this agent IS the instance's primary agent (proxy /
 *  daemon / a manager identity itself). */
export interface AgentLiveInstance {
  instance_id: string;
  mode: 'daemon' | 'proxy' | 'manager';
  hostname: string;
  plugin_version: string;
  cli: string;
  cli_adapters: string[];
  pid: number;
  started_at: string;
  last_seen_at: string;
  supervised: boolean;
  working_dirs?: string[];
  agent_ids?: string[];
}

/** Per-agent subagent rollup. Keeps the response bounded — `recent` is at most
 *  SUBAGENTS_PREVIEW_LIMIT entries (newest first); the full list still lives at
 *  /api/admin/agent-manager/instances/:id/subagents and /api/subagent-monitor. */
export interface AgentSubagentRollup {
  total: number;
  active: number;
  recent: any[]; // SubagentSummary[] — duplicated here would import a type from another module path; the field is treated as opaque by callers.
}

const SUBAGENTS_PREVIEW_LIMIT = 5;

@ApiBearerAuth('user-session')
@ApiTags('agents')
@Controller('api/agents')
@UseGuards(PermissionGuard, WorkspaceGuard)
@RequirePermission(PERMISSIONS.MANAGE_AGENTS)
export class AgentsController {
  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly agentStatusService: AgentStatusService,
    private readonly allocationService: AllocationService,
    private readonly subagentMonitor: SubagentMonitorService,
    // forwardRef: AgentManagerModule already imports AgentsModule (for
    // SubagentMonitorService); the cycle is resolved on both sides.
    @Inject(forwardRef(() => InstanceRegistryService))
    private readonly instanceRegistry: InstanceRegistryService,
    private readonly logService: LogService,
  ) {}

  @Get(':id/allocated-tickets')
  @RequirePermission(PERMISSIONS.VIEW_ACTIVITY)
  @ApiOperation({
    summary: 'List tickets currently allocated to this agent',
    description:
      'Returns rows [{ ticket_id, role, column_id, column_position, priority, priority_index, title, my_last_update_at }]. ' +
      'Excludes terminal columns. my_last_update_at = MAX(latest comment by this agent, latest activity log entry with actor_id=this agent). ' +
      'REST counterpart of the MCP tool `get_allocated_tickets` — used by the plugin-side 5-minute allocation poll (v0.25.0).',
  })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)' })
  @ApiQuery({ name: 'workspace_id', description: 'Workspace to scope results', required: true })
  async allocatedTickets(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @CurrentWorkspaceId() currentWorkspaceId: string | null,
    @Res() res: Response,
  ) {
    const effectiveWs = workspaceId || currentWorkspaceId || '';
    if (!effectiveWs) return res.status(400).json({ error: 'workspace_id is required' });
    const result = await this.allocationService.getAllocatedTickets(id, effectiveWs);
    if ('error' in result) return res.status(400).json(result);
    return res.json(result);
  }

  @Get()
  async list(@Req() req: Request, @CurrentWorkspaceId() workspaceId: string | null, @Query('scope') scope: string, @Res() res: Response) {
    // Admin can request all agents across workspaces with ?scope=all
    const isAdmin = (req as any).currentUser?.role === 'admin';
    if (scope === 'all' && isAdmin) {
      const agents = await this.agentRepo.find({ order: { name: 'ASC' } });
      const named = await this._enrichManagerNames(agents);
      return res.json(await this._enrichLiveData(named));
    }
    if (!workspaceId) return res.json([]);
    // Manager-type rows are global by design (workspace_id is NULL after
    // migration 19; '' is the pre-19 shape; some rows may carry a stale
    // workspace id). Surface them in every workspace's AI Agents tab via a
    // `type: 'manager'` branch so the listing doesn't depend on the storage
    // shape of workspace_id at all.
    const agents = await this.agentRepo.find({
      where: [
        { workspace_id: workspaceId },
        { workspace_id: '' },
        { workspace_id: IsNull() as any },
        { type: 'manager' },
      ],
      order: { name: 'ASC' },
    });
    const named = await this._enrichManagerNames(agents);
    return res.json(await this._enrichLiveData(named));
  }

  /**
   * Add `manager_name` to managed agents so the client can render them as
   * `<ManagerName>/<AgentName>` everywhere without a second round trip.
   * One DB call total — looks up every distinct manager_agent_id in the
   * input set and patches the rows in place.
   */
  private async _enrichManagerNames<T extends Pick<Agent, 'id' | 'manager_agent_id' | 'name'>>(
    agents: T[],
  ): Promise<Array<T & { manager_name?: string }>> {
    const managerIds = Array.from(new Set(
      agents.map((a) => a.manager_agent_id).filter((id): id is string => !!id),
    ));
    if (managerIds.length === 0) return agents;
    const managers = await this.agentRepo.find({
      where: { id: In(managerIds) },
      select: { id: true, name: true } as any,
    });
    const nameById = new Map(managers.map((m) => [m.id, m.name]));
    return agents.map((a) =>
      a.manager_agent_id
        ? { ...(a as any), manager_name: nameById.get(a.manager_agent_id) || undefined }
        : a,
    );
  }

  /**
   * Attach `live_instance` (heartbeat snapshot from InstanceRegistry) and a
   * `subagents` rollup (counts + recent preview) to each agent in the input.
   *
   * For managed agents, the matched instance is the manager process that lists
   * the agent in its `agent_ids[]`. For standalone agents (proxy/daemon/manager
   * identities themselves), the match is the instance whose primary `agent_id`
   * equals the agent. Without this enrichment, the AI Agents admin page shows
   * essentially nothing for manager-supervised agents — they don't carry their
   * own SSE session, so `is_online`/`last_seen_at` on the Agent row stay zero.
   *
   * Subagents come from SubagentMonitor: one DB call per distinct workspace,
   * grouped by agent_id in memory. Each agent gets up to SUBAGENTS_PREVIEW_LIMIT
   * recent rows so the response stays bounded; the full lists remain at the
   * existing /api/admin/agent-manager/instances/:id/subagents endpoint.
   */
  private async _enrichLiveData<T extends Pick<Agent, 'id' | 'workspace_id'>>(
    agents: T[],
  ): Promise<Array<T & { live_instance?: AgentLiveInstance; subagents?: AgentSubagentRollup }>> {
    if (agents.length === 0) return [];

    // ── live_instance ──────────────────────────────────────────────
    // Build two indexes off the in-memory registry: by primary agent_id
    // (proxy/daemon/manager-identity case) and by supervised agent_ids[]
    // (manager-supervised case).
    const allInstances = this.instanceRegistry.list();
    const primaryByAgentId = new Map<string, InstanceRecord>();
    const supervisorByAgentId = new Map<string, InstanceRecord>();
    for (const inst of allInstances) {
      const prev = primaryByAgentId.get(inst.agent_id);
      if (!prev || prev.last_seen_at < inst.last_seen_at) {
        primaryByAgentId.set(inst.agent_id, inst);
      }
      if (inst.mode === 'manager' && Array.isArray(inst.agent_ids)) {
        for (const supervisedId of inst.agent_ids) {
          const prevSup = supervisorByAgentId.get(supervisedId);
          if (!prevSup || prevSup.last_seen_at < inst.last_seen_at) {
            supervisorByAgentId.set(supervisedId, inst);
          }
        }
      }
    }

    // ── subagents ──────────────────────────────────────────────────
    // SubagentMonitor.listForWorkspace is one DB query per workspace; group
    // by agent_id in memory. Pull every workspace present in the input set
    // exactly once so admin scope=all listings don't fan out by agent.
    const workspaceIds = Array.from(new Set(
      agents.map((a) => a.workspace_id).filter((w): w is string => !!w),
    ));
    const subagentsByAgentId = new Map<string, any[]>();
    await Promise.all(
      workspaceIds.map(async (wsId) => {
        const subs = await this.subagentMonitor.listForWorkspace(wsId);
        for (const s of subs) {
          const list = subagentsByAgentId.get(s.agent_id) || [];
          list.push(s);
          subagentsByAgentId.set(s.agent_id, list);
        }
      }),
    );

    return agents.map((a) => {
      const inst = primaryByAgentId.get(a.id) || supervisorByAgentId.get(a.id);
      const subList = subagentsByAgentId.get(a.id) || [];
      const enriched: T & { live_instance?: AgentLiveInstance; subagents?: AgentSubagentRollup } = { ...a };
      if (inst) {
        enriched.live_instance = {
          instance_id: inst.instance_id,
          mode: inst.mode,
          hostname: inst.hostname,
          plugin_version: inst.plugin_version,
          cli: inst.cli,
          cli_adapters: inst.cli_adapters,
          pid: inst.pid,
          started_at: inst.started_at,
          last_seen_at: inst.last_seen_at,
          // True only for the manager-supervised case (agent appears in
          // agent_ids[] but isn't the instance's primary agent_id).
          supervised: !!supervisorByAgentId.get(a.id) && inst.agent_id !== a.id,
          working_dirs: inst.working_dirs,
          agent_ids: inst.agent_ids,
        };
      }
      if (subList.length > 0) {
        const active = subList.filter((s: any) => !s.ended_at).length;
        enriched.subagents = {
          total: subList.length,
          active,
          recent: subList.slice(0, SUBAGENTS_PREVIEW_LIMIT),
        };
      }
      return enriched;
    });
  }

  @Get('dashboard')
  @RequirePermission(PERMISSIONS.VIEW_ACTIVITY)  // override class-level MANAGE_AGENTS (research §Pattern 4)
  async dashboard(@Query('workspace_id') workspaceId: string, @Res() res: Response) {
    // Safe default: return empty array when workspace_id is absent — prevents cross-workspace data leak
    if (!workspaceId) return res.json([]);

    // Mirror list() — include workspace-less rows so manager identities show
    // up on the dashboard in every workspace, regardless of workspace_id
    // storage shape (NULL post-migration 19, '' pre-19, stale id otherwise).
    const agents = await this.agentRepo.find({
      where: [
        { workspace_id: workspaceId },
        { workspace_id: '' },
        { workspace_id: IsNull() as any },
        { type: 'manager' },
      ],
      order: { name: 'ASC' },
    });

    const enriched = await this._enrichManagerNames(agents);
    const rows = enriched.map((agent) => {
      // Phase 3 D-42 — pull live current_task from AgentStatusService (in-memory)
      const liveStatus = this.agentStatusService.getOne(agent.id);
      const currentTask = liveStatus?.current_task
        ? {
            ticket_id: liveStatus.current_task.ticket_id,
            ticket_title: liveStatus.current_task.ticket_title,
            claimed_at: liveStatus.current_task.claimed_at.toISOString(),
            role: liveStatus.current_task.role || undefined,
          }
        : undefined;

      return {
        id: agent.id,
        name: agent.name,
        manager_agent_id: (agent as any).manager_agent_id ?? null,
        manager_name: (agent as any).manager_name,
        avatar_url: agent.avatar_url,
        is_online: !!agent.is_online,
        last_seen_at: agent.last_seen_at ? agent.last_seen_at.toISOString() : null,
        connected_at: agent.connected_at ? agent.connected_at.toISOString() : null,
        workspace_id: agent.workspace_id,
        // v0.25.0: AgentTrigger table removed; field kept for UI compat but always 0.
        pending_trigger_count: 0,
        current_task: currentTask,
      };
    });

    return res.json(rows);
  }

  @Get(':id/activity')
  @RequirePermission(PERMISSIONS.VIEW_ACTIVITY)
  async getAgentActivity(
    @Param('id') id: string,
    @Query('limit') limitRaw: string,
    @CurrentWorkspaceId() workspaceId: string | null,
    @Res() res: Response,
  ) {
    // Verify agent belongs to requesting workspace before returning activity.
    // Workspace-less agents (manager identities) are visible to every
    // workspace's activity view.
    await findOrFail(this.agentRepo, {
      where: { id, ...(workspaceId ? { workspace_id: In([workspaceId, '']) } : {}) },
    }, 'Agent not found');

    const limit = Math.min(Math.max(parseInt(limitRaw) || 50, 1), 200);
    const logs = await this.dataSource.getRepository(ActivityLog).find({
      where: { actor_id: id },
      order: { created_at: 'DESC' },
      take: limit,
    });
    return res.json(logs);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.VIEW_ACTIVITY)
  async get(@Param('id') id: string, @Req() req: Request, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    // System admins bypass workspace scoping on the :id endpoints (mirrors
    // the `?scope=all` rule on list). Without this, an admin viewing a
    // managed agent from the global AgentManager page 404s whenever the
    // agent's workspace differs from the operator's currently-active
    // workspace — the AgentManager page itself fetches cross-workspace via
    // getAgentsAll(), so the detail / edit / delete surfaces have to follow
    // the same rule or the round-trip breaks. Workspace admins (with
    // MANAGE_AGENTS only inside their own workspace) stay scoped — but they
    // can still read workspace-less identities (managers, with workspace_id
    // stored as '' OR NULL — historic rows may use either). Without the
    // IsNull() branch, loadManagerInfo on /admin/agent-manager 404s and the
    // Edit Identity button stays disabled, since the dialog only renders when
    // managerInfo loaded.
    // No workspace filter on by-id lookups. The lookup is keyed on id only
    // (a UUID — globally unique) and permission is enforced by the guard
    // chain (AuthGuard → PermissionGuard with VIEW_ACTIVITY). Filtering on
    // workspace_id here used to silently 404 manager rows whenever the
    // operator's current workspace differed from the manager's stored
    // workspace, and even for in-workspace rows when the storage shape was
    // unexpected ('' vs NULL vs stale id). Operator directive: id-only.
    const agent = await findOrFail(this.agentRepo, { where: { id } }, 'Agent not found');

    // Phase 3 D-44 — role_prompt is admin-gated. Non-admin viewers receive a redacted payload.
    // req.currentUser is populated by AuthGuard (runs before PermissionGuard) and cannot be spoofed from headers.
    const currentUser = (req as any).currentUser;
    const canSeeRolePrompt = currentUser
      ? hasPermission(
          currentUser.role || 'user',
          currentUser.permissions || [],
          PERMISSIONS.MANAGE_AGENTS,
        )
      : false;

    // Enrich with live current_task from AgentStatusService (in-memory), same
    // source the /dashboard list uses. Without this, the detail view always
    // rendered "Idle" even when the agent was actively working on a ticket —
    // a straight inconsistency with what the list view showed.
    const liveStatus = this.agentStatusService.getOne(agent.id);
    const currentTask = liveStatus?.current_task
      ? {
          ticket_id: liveStatus.current_task.ticket_id,
          ticket_title: liveStatus.current_task.ticket_title,
          claimed_at: liveStatus.current_task.claimed_at.toISOString(),
          role: liveStatus.current_task.role || undefined,
        }
      : undefined;

    const named = await this._enrichManagerNames([agent]);
    const [enriched] = await this._enrichLiveData(named);
    if (canSeeRolePrompt) {
      return res.json({ ...enriched, current_task: currentTask, redacted: false });
    }

    // Non-admin: strip role_prompt + role_prompt_meta before returning
    const { role_prompt, role_prompt_meta, ...safe } = enriched as any;
    return res.json({ ...safe, role_prompt: '', role_prompt_meta: null, current_task: currentTask, redacted: true });
  }

  @Post()
  async create(@Body() body: any, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const { name, description = '', type = 'custom', avatar_url = '', is_active = 1, working_dir = '', manager_agent_id = null, credential_id = null } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // Use workspace injected by WorkspaceGuard — ignore body-supplied workspace_id to
    // prevent cross-workspace agent creation by users in other workspaces.
    // Fall back to oldest workspace for backward-compat when guard sets no workspace
    // (e.g. dev mode with no X-Workspace-Id header).
    let effectiveWorkspaceId: string = workspaceId || '';
    if (!effectiveWorkspaceId) {
      const defaultWs = await this.dataSource
        .getRepository(Workspace)
        .findOne({ where: {}, order: { id: 'ASC' } });
      effectiveWorkspaceId = defaultWs?.id || '';
    }

    // Manager-type agents MUST be workspace-less (operator invariant — they
    // supervise children across any workspace). Force null here even if the
    // caller passed a workspace via WorkspaceGuard. Other types get the
    // effective workspace as before.
    const agent = await this.agentRepo.save(
      this.agentRepo.create({
        name, description, type, avatar_url, is_active,
        workspace_id: type === 'manager' ? null : effectiveWorkspaceId,
        working_dir: typeof working_dir === 'string' ? working_dir : '',
        manager_agent_id: typeof manager_agent_id === 'string' && manager_agent_id ? manager_agent_id : null,
        credential_id: typeof credential_id === 'string' && credential_id ? credential_id : null,
      }),
    );
    return res.status(201).json(agent);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    // System admins bypass workspace scoping (mirrors GET ?scope=all and the
    // get-by-id rule above). Fixes the AgentManager admin page edit flow:
    // the page lists agents cross-workspace via getAgentsAll() but Edit was
    // 404ing whenever the operator's active workspace differed from the
    // agent's workspace. Workspace-scoped admins stay scoped — but they are
    // also allowed to edit workspace-less identities (manager agents) so the
    // Edit Identity dialog on the AgentManager page works for them. Without
    // this, GET returned the workspace-less manager (line 323 `In([ws, ''])`)
    // and the dialog opened, but Save 404'd here and the operator saw a silent
    // failure.
    // id-only lookup — symmetric with GET. PermissionGuard already gated this
    // path with MANAGE_AGENTS; layering a workspace filter on top kept hiding
    // legitimate edits behind silent 404s. See GET handler comment.
    const agent = await findOrFail(this.agentRepo, { where: { id } }, 'Agent not found');

    // Snapshot pre-update fields used to detect identity changes we want to
    // audit. Past incident: manager Agent names silently flipped from the
    // operator-set label (e.g. "Ralf") to a hostname-derived fallback
    // ("awb-agent-manager (PARN-HOME)") with no record of who / when, because
    // none of the three mutation paths (this PATCH, MCP update_agent,
    // pair/redeem create) emitted an audit line. Log here so the next rename
    // is attributable from /admin/logs without DB forensics.
    const prevName = agent.name;
    const prevManagerAgentId = agent.manager_agent_id ?? null;
    const actorId =
      (req as any).currentUser?.id || (req as any).currentAgentId || (req as any).apiKey?.agent_id || null;
    const actorRole = (req as any).currentUser?.role || null;

    const { name, description, type, avatar_url, is_active, role_prompt, role_prompt_meta, working_dir, manager_agent_id, credential_id } = body;
    if (name !== undefined) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) return res.status(400).json({ error: 'name cannot be empty' });
      agent.name = trimmed;
    }
    if (description !== undefined) agent.description = description;
    if (type !== undefined) agent.type = type;
    if (avatar_url !== undefined) agent.avatar_url = avatar_url;
    if (is_active !== undefined) agent.is_active = Number(is_active) ? 1 : 0;
    // Phase 1 role prompt fields (D-14 / ROLE-02)
    if (role_prompt !== undefined) agent.role_prompt = role_prompt;
    if (role_prompt_meta !== undefined) agent.role_prompt_meta = role_prompt_meta;
    // ST-4 — agent-manager fields. working_dir is plain text; manager_agent_id
    // can be null to detach an agent from a manager (e.g. moved to a host
    // running the legacy proxy).
    if (working_dir !== undefined) {
      agent.working_dir = typeof working_dir === 'string' ? working_dir : '';
    }
    if (manager_agent_id !== undefined) {
      const next = typeof manager_agent_id === 'string' && manager_agent_id ? manager_agent_id : null;
      if (next) {
        // Mirror the createManagedAgent contract — verify the target row
        // exists and is a manager identity (type='manager'). Cross-workspace
        // links are intentionally allowed: a global manager can supervise
        // children in any workspace it has been minted identities for.
        const m = await this.agentRepo.findOne({ where: { id: next } });
        if (!m) return res.status(400).json({ error: 'manager_agent_id does not exist' });
        if (m.type !== 'manager') {
          return res.status(400).json({ error: 'manager_agent_id must reference a manager-type agent' });
        }
      }
      agent.manager_agent_id = next;
    }
    if (credential_id !== undefined) {
      // Empty string / falsy = clear; non-empty string = set. Detaching an
      // agent from its credential is a one-line UI affordance, so accept null
      // and '' the same way working_dir / manager_agent_id do.
      agent.credential_id = typeof credential_id === 'string' && credential_id ? credential_id : null;
    }

    // Operator invariant: manager-type agents are workspace-less. Catches
    // type-flip (non-manager → manager) plus any in-place save where the
    // agent was loaded with a stale workspace_id (the boot cleanup is
    // catch-all but this normalise-on-save makes the rule local).
    if (agent.type === 'manager') {
      agent.workspace_id = null;
    }

    const updated = await this.agentRepo.save(agent);

    if (prevName !== updated.name) {
      this.logService.info(
        'AgentIdentity',
        `Agent name changed: "${prevName}" → "${updated.name}" (id=${updated.id.slice(0, 8)} type=${updated.type})`,
        {
          agent_id: updated.id,
          agent_type: updated.type,
          field: 'name',
          before: prevName,
          after: updated.name,
          actor_id: actorId,
          actor_role: actorRole,
          via: 'PATCH /api/agents/:id',
        },
      );
    }
    if ((prevManagerAgentId ?? null) !== (updated.manager_agent_id ?? null)) {
      this.logService.info(
        'AgentIdentity',
        `Agent manager_agent_id changed: ${prevManagerAgentId || '(none)'} → ${updated.manager_agent_id || '(none)'} (id=${updated.id.slice(0, 8)} name=${updated.name})`,
        {
          agent_id: updated.id,
          agent_name: updated.name,
          field: 'manager_agent_id',
          before: prevManagerAgentId,
          after: updated.manager_agent_id ?? null,
          actor_id: actorId,
          actor_role: actorRole,
          via: 'PATCH /api/agents/:id',
        },
      );
    }
    return res.json(updated);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Req() req: Request, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    // id-only lookup — symmetric with GET / PATCH.
    const agent = await findOrFail(this.agentRepo, { where: { id } }, 'Agent not found');
    await this.agentRepo.delete(agent.id);
    return res.json({ success: true });
  }
}
