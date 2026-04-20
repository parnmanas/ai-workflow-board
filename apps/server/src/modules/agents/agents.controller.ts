import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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
import { ApiOperation, ApiParam, ApiQuery, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { findOrFail } from '../../common/find-or-fail';

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
      return res.json(agents);
    }
    if (!workspaceId) return res.json([]);
    const agents = await this.agentRepo.find({
      where: { workspace_id: workspaceId },
      order: { name: 'ASC' },
    });
    return res.json(agents);
  }

  @Get('dashboard')
  @RequirePermission(PERMISSIONS.VIEW_ACTIVITY)  // override class-level MANAGE_AGENTS (research §Pattern 4)
  async dashboard(@Query('workspace_id') workspaceId: string, @Res() res: Response) {
    // Safe default: return empty array when workspace_id is absent — prevents cross-workspace data leak
    if (!workspaceId) return res.json([]);

    const agents = await this.agentRepo.find({
      where: { workspace_id: workspaceId },
      order: { name: 'ASC' },
    });

    const rows = agents.map((agent) => {
      // Phase 3 D-42 — pull live current_task from AgentStatusService (in-memory)
      const liveStatus = this.agentStatusService.getOne(agent.id);
      const currentTask = liveStatus?.current_task
        ? {
            ticket_id: liveStatus.current_task.ticket_id,
            ticket_title: liveStatus.current_task.ticket_title,
            claimed_at: liveStatus.current_task.claimed_at.toISOString(),
          }
        : undefined;

      return {
        id: agent.id,
        name: agent.name,
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
    // Verify agent belongs to requesting workspace before returning activity
    await findOrFail(this.agentRepo, {
      where: { id, ...(workspaceId ? { workspace_id: workspaceId } : {}) },
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
    const agent = await findOrFail(this.agentRepo, {
      where: { id, ...(workspaceId ? { workspace_id: workspaceId } : {}) },
    }, 'Agent not found');

    // Phase 3 D-44 — role_prompt is admin-gated. Non-admin viewers receive a redacted payload.
    // req.currentUser is populated by AuthGuard (runs before PermissionGuard) and cannot be spoofed from headers.
    const currentUser = (req as any).currentUser;
    const isAdmin = currentUser
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
        }
      : undefined;

    if (isAdmin) {
      return res.json({ ...agent, current_task: currentTask, redacted: false });
    }

    // Non-admin: strip role_prompt + role_prompt_meta before returning
    const { role_prompt, role_prompt_meta, ...safe } = agent as any;
    return res.json({ ...safe, role_prompt: '', role_prompt_meta: null, current_task: currentTask, redacted: true });
  }

  @Post()
  async create(@Body() body: any, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const { name, description = '', type = 'custom', avatar_url = '', is_active = 1 } = body;
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

    const agent = await this.agentRepo.save(
      this.agentRepo.create({ name, description, type, avatar_url, is_active, workspace_id: effectiveWorkspaceId }),
    );
    return res.status(201).json(agent);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const agent = await findOrFail(this.agentRepo, {
      where: { id, ...(workspaceId ? { workspace_id: workspaceId } : {}) },
    }, 'Agent not found');

    const { name, description, type, avatar_url, is_active, role_prompt, role_prompt_meta } = body;
    // Phase 1 role prompt fields (D-14 / ROLE-02)
    if (role_prompt !== undefined) agent.role_prompt = role_prompt;
    if (role_prompt_meta !== undefined) agent.role_prompt_meta = role_prompt_meta;

    const updated = await this.agentRepo.save(agent);
    return res.json(updated);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const agent = await findOrFail(this.agentRepo, {
      where: { id, ...(workspaceId ? { workspace_id: workspaceId } : {}) },
    }, 'Agent not found');
    await this.agentRepo.delete(agent.id);
    return res.json({ success: true });
  }
}
