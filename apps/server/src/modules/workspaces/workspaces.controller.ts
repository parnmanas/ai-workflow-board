import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, EntityManager } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { ActivityLog } from '../../entities/ActivityLog';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ActivityService } from '../../services/activity.service';
import { DEFAULT_COLUMNS } from '../../database/database.module';
import { DEFAULT_BOARD_ROUTING } from '../../db';
import { WorkspaceRolesService } from '../workspace-roles/workspace-roles.service';
import { PromptTemplatesService } from '../prompt-templates/prompt-templates.service';
import { ReBACService } from '../../services/rebac.service';
import { findOrFail } from '../../common/find-or-fail';
import { parseComments, expandCommentAttachments } from '../mcp/shared/ticket-parsing';
import { writeRoutingConfigThrough } from '../boards/routing-config.helper';
import { validateHarnessConfigInput, serializeHarnessConfig } from '../../common/harness-config';
import { validateEnvironmentConfigInput, serializeEnvironmentConfig } from '../../common/environment-config';
import { hasPermission } from '../../common/types/permissions';
import { PERMISSIONS } from '../../common/types/permissions';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@ApiBearerAuth('user-session')
@ApiTags('workspaces')
@Controller('api/workspaces')
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(
    @InjectRepository(Workspace) private readonly wsRepo: Repository<Workspace>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly rebacService: ReBACService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly workspaceRolesService: WorkspaceRolesService,
    private readonly promptTemplatesService: PromptTemplatesService,
    private readonly activityService: ActivityService,
  ) {}

  @Get()
  async list(@Res() res: Response) {
    const workspaces = await this.wsRepo.find({ order: { created_at: 'DESC' } });
    const result = await Promise.all(workspaces.map(async ws => {
      const boardCount = await this.boardRepo.count({ where: { workspace_id: ws.id } });
      return { ...ws, board_count: boardCount };
    }));
    return res.json(result);
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    const { name, description = '', board_name } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const ws = await this.wsRepo.save(this.wsRepo.create({ name, description }));
    const board = await this.boardRepo.save(this.boardRepo.create({
      workspace_id: ws.id, name: board_name?.trim() || `${name} Board`, description: '',
      // Default routing pairs each workflow column with its driving role.
      // Admins can edit via Board Settings → Routing.
      routing_config: JSON.stringify(DEFAULT_BOARD_ROUTING),
    }));
    const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
    const savedCols = await this.colRepo.save(defaultCols.map(c => this.colRepo.create(c)));
    // v0.41 — fan board.routing_config into per-column role_routing.
    await writeRoutingConfigThrough(this.dataSource, board.id);

    // v0.34: every new workspace gets the same builtin role preset that
    // existing workspaces received from the migration. Mention syntax,
    // routing_config, and trigger dispatch all rely on these slugs being
    // present, so seeding here keeps fresh workspaces immediately usable.
    await this.workspaceRolesService.seedBuiltinRoles(ws.id);

    // Default workflow prompt templates + auto-link each column to the
    // matching template so the board ships with a working column→prompt
    // map (not just empty routing). seedDefaults must precede the column
    // map computation; otherwise the templates aren't yet visible.
    await this.promptTemplatesService.seedDefaults(ws.id);
    const colPrompts = await this.promptTemplatesService.computeDefaultColumnPrompts(
      ws.id,
      savedCols.map(c => ({ id: c.id, name: c.name })),
    );
    if (Object.keys(colPrompts).length > 0) {
      await this.boardRepo.update({ id: board.id }, { column_prompts: JSON.stringify(colPrompts) });
    }

    const result = await this.wsRepo.findOne({ where: { id: ws.id } });
    return res.status(201).json(result);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response) {
    const ws = await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');

    const boards = await this.boardRepo.find({ where: { workspace_id: id }, order: { created_at: 'ASC' } });
    const boardsFull = await Promise.all(boards.map(async board => {
      const columns = await this.colRepo.find({ where: { board_id: board.id }, order: { position: 'ASC' } });
      const colsFull = await Promise.all(columns.map(async col => {
        const tickets = await this.ticketRepo.find({
          // Archive exclusion (ticket 9b44526b): workspace board snapshots
          // must hide archived tickets by default — they have their own
          // dedicated archive endpoint and including them here would silently
          // re-inflate every consumer of /api/workspaces/:id.
          where: { column_id: col.id, archived_at: IsNull() },
          relations: ['children', 'comments'],
          order: { position: 'ASC' },
        });
        return {
          ...col,
          tickets: tickets.map(t => ({
            ...t,
            labels: JSON.parse(t.labels || '[]'),
            channel_ids: JSON.parse(t.channel_ids || '[]'),
            children: (t.children || []).sort((a, b) => a.position - b.position),
            comments: parseComments(t.comments),
          })),
        };
      }));
      return { ...board, columns: colsFull };
    }));

    // Hydrate comment attachments across every ticket in one batched query.
    const allComments: any[] = [];
    for (const b of boardsFull) for (const col of b.columns) for (const t of col.tickets) allComments.push(...t.comments);
    await expandCommentAttachments(this.dataSource, allComments);

    return res.json({ ...ws, boards: boardsFull });
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @Res() res: Response,
    @CurrentUser() user: CurrentUserData,
  ) {
    const ws = await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');

    // Snapshot the cadence/liveness knobs BEFORE mutating so a config-change
    // audit can record old→new (ticket 1fcba693). These are the settings that
    // pace the supervisor backstop — the incident was a 4 h supervisor_stale_ms
    // applied with no trail. Audit written after a successful save below.
    const cadenceBefore = {
      supervisor_stale_ms: ws.supervisor_stale_ms,
      supervisor_resend_ms: ws.supervisor_resend_ms,
      dispatch_queue_depth: ws.dispatch_queue_depth,
      claim_verification_grace_ms: ws.claim_verification_grace_ms,
    };

    const {
      name, description,
      supervisor_stale_ms, supervisor_resend_ms, dispatch_queue_depth,
      claim_verification_enabled, claim_verification_grace_ms,
      harness_config, environment_config, assistant_agent_id,
    } = body;
    if (name !== undefined) ws.name = name;
    if (description !== undefined) ws.description = description;

    // v0.41 — cadence settings (AC #4). These bound the supervisor
    // backstop frequency and the per-agent dispatch queue depth. Defaults
    // (30 min / 5 min / 100) live in the entity column; we accept any
    // positive finite integer here and silently ignore garbage so a bad
    // PATCH can't wedge the workspace into "0 ms stale check".
    if (supervisor_stale_ms !== undefined) {
      const v = Number(supervisor_stale_ms);
      if (Number.isFinite(v) && v > 0) ws.supervisor_stale_ms = Math.floor(v);
      else return res.status(400).json({ error: 'supervisor_stale_ms must be a positive number' });
    }
    if (supervisor_resend_ms !== undefined) {
      const v = Number(supervisor_resend_ms);
      if (Number.isFinite(v) && v > 0) ws.supervisor_resend_ms = Math.floor(v);
      else return res.status(400).json({ error: 'supervisor_resend_ms must be a positive number' });
    }
    if (dispatch_queue_depth !== undefined) {
      const v = Number(dispatch_queue_depth);
      if (Number.isFinite(v) && v > 0) ws.dispatch_queue_depth = Math.floor(v);
      else return res.status(400).json({ error: 'dispatch_queue_depth must be a positive number' });
    }

    // Claim-verification settings (ticket dcb9d661). `enabled` is stored
    // as int (0/1) for SQLite compat; we accept boolean / number / string
    // truthy values and normalise. `grace_ms` requires a positive finite
    // integer — same shape as the supervisor cadences above.
    if (claim_verification_enabled !== undefined) {
      const raw = claim_verification_enabled;
      const v = (raw === true || raw === 1 || raw === '1' || raw === 'true') ? 1 : 0;
      ws.claim_verification_enabled = v;
    }
    if (claim_verification_grace_ms !== undefined) {
      const v = Number(claim_verification_grace_ms);
      if (Number.isFinite(v) && v > 0) ws.claim_verification_grace_ms = Math.floor(v);
      else return res.status(400).json({ error: 'claim_verification_grace_ms must be a positive number' });
    }

    // Workspace-wide default agent harness (ticket 7122600c). Same contract
    // as the board PATCH: null clears, objects are strict-zod-validated → 400.
    if (harness_config !== undefined) {
      if (harness_config === null) {
        ws.harness_config = null;
      } else {
        const checked = validateHarnessConfigInput(harness_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        ws.harness_config = serializeHarnessConfig(checked.value);
      }
    }

    // Workspace-wide default environment setup (ticket 354d336b; simplified in
    // 8fbe90e9). Same contract as the board PATCH: null clears; objects are
    // normalised to repositories[].resource_id only (legacy keys dropped).
    if (environment_config !== undefined) {
      if (environment_config === null) {
        ws.environment_config = null;
      } else {
        const checked = validateEnvironmentConfigInput(environment_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        ws.environment_config = serializeEnvironmentConfig(checked.value);
      }
    }

    // AWB 어시스턴트 지정 (에픽 bf65ca00 · S2). Chat-first 진입이 연결할 DM 프리셋의
    // 에이전트. 다른 workspace 설정과 달리 이 필드는 관리자 전용(planner 결정 a):
    //   1) 권한 게이트 — MANAGE_AGENTS 를 가진 사용자만 지정/해제 가능. 필드가 body 에
    //      실제로 존재할 때만 검사하므로 name/description/cadence 등 기존 PATCH 경로의
    //      권한 요건은 그대로 유지된다(회귀 0).
    //   2) workspace 경계 + 유효성 — null 은 해제. 값이 있으면 이 workspace 소속의
    //      활성 에이전트여야 하며(manager 는 DM auto-route 대상이 아니라 제외, line
    //      _handleDmAgentRequest), 그렇지 않으면 400. 미지정/무효는 클라가 안전한
    //      empty state 로 처리하므로 서버는 잘못된 지정만 막는다.
    if (assistant_agent_id !== undefined) {
      if (!hasPermission(user?.role || '', user?.permissions || [], PERMISSIONS.MANAGE_AGENTS)) {
        return res.status(403).json({ error: 'Assistant agent can only be set by an admin (admin.agents permission required)' });
      }
      if (assistant_agent_id === null || assistant_agent_id === '') {
        ws.assistant_agent_id = null;
      } else if (typeof assistant_agent_id !== 'string') {
        return res.status(400).json({ error: 'assistant_agent_id must be an agent id string or null' });
      } else {
        const agent = await this.agentRepo.findOne({ where: { id: assistant_agent_id } });
        if (!agent || agent.is_active !== 1 || agent.type === 'manager' || agent.workspace_id !== id) {
          return res.status(400).json({ error: 'assistant_agent_id must reference an active agent in this workspace' });
        }
        ws.assistant_agent_id = agent.id;
      }
    }

    // Persist the settings change and its config-change audit ATOMICALLY
    // (ticket 1fcba693, reviewer AC). The cadence save and the config_changed
    // rows share ONE transaction, so if the audit write fails the whole PATCH
    // rolls back and returns 500 — a cadence value (e.g. the incident's 4 h
    // supervisor_stale_ms) can never land "with no trail" again, which a
    // best-effort/swallowed audit could not guarantee. The live SSE emit is
    // deferred until after commit so a rolled-back row never rides the stream.
    let auditRows: ActivityLog[];
    try {
      auditRows = await this.dataSource.transaction(async (manager) => {
        await manager.save(ws);
        return this._auditCadenceChangesTx(manager, ws.id, cadenceBefore, ws, {
          actorId: user?.id || '',
          actorName: user?.name || '',
          source: 'rest',
        });
      });
    } catch (e: any) {
      return res.status(500).json({ error: `Failed to persist workspace settings: ${e?.message || String(e)}` });
    }
    this.activityService.emitLogged(auditRows);

    return res.json(ws);
  }

  /**
   * Write a `config_changed` ActivityLog row for each supervisor/dispatch
   * cadence field that actually changed (ticket 1fcba693), via the caller's
   * transaction `manager` so the rows commit — or roll back — atomically with
   * the workspace save. Workspace-scoped (entity_type='workspace',
   * ticket_id=''), carrying actor + old→new + source so a value like the
   * incident's 4 h supervisor_stale_ms can never again land without a trail.
   * Returns the persisted (not-yet-emitted) rows; the caller emits them after
   * commit. Deliberately does NOT swallow — a write failure propagates so the
   * transaction rolls the settings change back too (audit-or-nothing).
   */
  private async _auditCadenceChangesTx(
    manager: EntityManager,
    workspaceId: string,
    before: { supervisor_stale_ms: number; supervisor_resend_ms: number; dispatch_queue_depth: number; claim_verification_grace_ms: number },
    after: Workspace,
    actor: { actorId: string; actorName: string; source: string },
  ): Promise<ActivityLog[]> {
    const fields: Array<keyof typeof before> = [
      'supervisor_stale_ms', 'supervisor_resend_ms', 'dispatch_queue_depth', 'claim_verification_grace_ms',
    ];
    const rows: ActivityLog[] = [];
    for (const field of fields) {
      const oldVal = before[field];
      const newVal = (after as any)[field];
      if (oldVal === newVal) continue;
      rows.push(await this.activityService.logActivityTx(manager, {
        entity_type: 'workspace',
        entity_id: workspaceId,
        workspace_id: workspaceId,
        ticket_id: '',
        action: 'config_changed',
        field_changed: field,
        old_value: String(oldVal),
        new_value: String(newVal),
        actor_id: actor.actorId,
        actor_name: actor.actorName,
        trigger_source: actor.source,
      }));
    }
    return rows;
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Res() res: Response) {
    const ws = await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');

    const count = await this.wsRepo.count();
    if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last workspace' });

    await this.wsRepo.delete(ws.id);
    return res.json({ success: true });
  }

  // ─── Workspace Members (ReBAC) ─────────────────────────

  @Get(':id/members')
  async listMembers(@Param('id') id: string, @Res() res: Response) {
    await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');

    const [members, owners] = await Promise.all([
      this.rebacService.listSubjects({ type: 'workspace', id }, 'member'),
      this.rebacService.listSubjects({ type: 'workspace', id }, 'owner'),
    ]);

    const ownerIds = new Set(owners.filter(s => s.type === 'user').map(s => s.id));
    const allUserIds = [...new Set([
      ...members.filter(s => s.type === 'user').map(s => s.id),
      ...ownerIds,
    ])];

    if (allUserIds.length === 0) return res.json([]);

    const users = await this.userRepo.find({ where: { id: In(allUserIds) } });
    const result = users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      status: (u as any).status,
      avatar_url: u.avatar_url,
      relation: ownerIds.has(u.id) ? 'owner' : 'member',
    }));
    return res.json(result);
  }

  @Post(':id/members')
  async addMember(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { user_id, relation = 'member' } = body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!['member', 'owner'].includes(relation)) {
      return res.status(400).json({ error: 'relation must be member or owner' });
    }

    await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');
    await findOrFail(this.userRepo, { where: { id: user_id } }, 'User not found');

    await this.rebacService.grant({ type: 'user', id: user_id }, relation, { type: 'workspace', id });
    return res.status(201).json({ success: true, user_id, relation, workspace_id: id });
  }

  @Patch(':id/members/:userId')
  async updateMemberRole(
    @Param('id') id: string, @Param('userId') userId: string,
    @Body() body: any, @Res() res: Response,
  ) {
    const { relation } = body;
    if (!['member', 'owner'].includes(relation)) {
      return res.status(400).json({ error: 'relation must be member or owner' });
    }
    // Revoke both, then grant the new one
    await this.rebacService.revoke({ type: 'user', id: userId }, 'member', { type: 'workspace', id });
    await this.rebacService.revoke({ type: 'user', id: userId }, 'owner', { type: 'workspace', id });
    await this.rebacService.grant({ type: 'user', id: userId }, relation, { type: 'workspace', id });
    return res.json({ success: true, user_id: userId, relation });
  }

  @Delete(':id/members/:userId')
  async removeMember(@Param('id') id: string, @Param('userId') userId: string, @Res() res: Response) {
    await this.rebacService.revoke({ type: 'user', id: userId }, 'member', { type: 'workspace', id });
    await this.rebacService.revoke({ type: 'user', id: userId }, 'owner', { type: 'workspace', id });
    return res.json({ success: true });
  }

  // ─── Mention autocomplete candidates ───────────────────────
  //
  // Returns the user + agent set the composer's @-dropdown should show for
  // this workspace. When `ticket_id` is supplied, role shortcuts are included
  // only for roles that the ticket has filled — otherwise `@assignee` etc.
  // would resolve to nothing and confuse the user.

  @Get(':id/mention-candidates')
  async mentionCandidates(
    @Param('id') id: string,
    @Query('ticket_id') ticketId: string | undefined,
    @Res() res: Response,
  ) {
    await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');

    const [members, owners, agents] = await Promise.all([
      this.rebacService.listSubjects({ type: 'workspace', id }, 'member'),
      this.rebacService.listSubjects({ type: 'workspace', id }, 'owner'),
      this.agentRepo.find({ where: { workspace_id: id, is_active: 1 }, order: { name: 'ASC' } }),
    ]);

    // ST-7: enrich agents with manager_name so the client autocompleter
    // can render managed agents as <ManagerName>/<AgentName>. Single
    // batched lookup keyed off distinct manager_agent_ids — no extra
    // round-trip when the workspace has no managed agents.
    const managerIds = Array.from(
      new Set(agents.map((a) => a.manager_agent_id).filter((x): x is string => !!x)),
    );
    const managerNameById = new Map<string, string>();
    if (managerIds.length > 0) {
      const managers = await this.agentRepo.find({
        where: { id: In(managerIds) },
        select: { id: true, name: true } as any,
      });
      for (const m of managers) managerNameById.set(m.id, m.name);
    }
    const formatAgent = (a: Agent): string => {
      const mgr = a.manager_agent_id ? managerNameById.get(a.manager_agent_id) : '';
      return mgr ? `${mgr}/${a.name}` : a.name;
    };

    const allUserIds = [...new Set([
      ...members.filter(s => s.type === 'user').map(s => s.id),
      ...owners.filter(s => s.type === 'user').map(s => s.id),
    ])];
    const users = allUserIds.length
      ? (await this.userRepo.find({ where: { id: In(allUserIds) } }))
          .map(u => ({ id: u.id, name: u.name, avatar_url: u.avatar_url }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    // v0.34: role shortcuts come from the workspace_roles table (any slug
    // the workspace has defined), not the hardcoded triple. Each shortcut
    // resolves against the ticket_role_assignments row for that role on
    // the supplied ticket; roles with no assignment are omitted (so
    // `@assignee` only appears in the autocompleter when an assignee is set).
    const roleShortcuts: Array<{
      key: string;
      label: string;
      resolved_type: 'agent' | 'user';
      resolved_id: string;
    }> = [];
    if (ticketId) {
      const ticket = await this.ticketRepo.findOne({ where: { id: ticketId } });
      if (ticket) {
        const wsRoles = await this.dataSource
          .getRepository(WorkspaceRole)
          .find({ where: { workspace_id: id }, order: { position: 'ASC' } });
        const assignments = await this.dataSource
          .getRepository(TicketRoleAssignment)
          .find({ where: { ticket_id: ticket.id } });
        const byRoleId = new Map(assignments.map(a => [a.role_id, a]));
        const agentById = new Map(agents.map(a => [a.id, a]));
        const userById = new Map(users.map(u => [u.id, u]));
        for (const role of wsRoles) {
          const a = byRoleId.get(role.id);
          if (!a) continue;
          if (a.agent_id) {
            const agent = agentById.get(a.agent_id);
            const label = agent ? `${role.slug} (${formatAgent(agent)})` : role.slug;
            roleShortcuts.push({
              key: role.slug,
              label,
              resolved_type: 'agent',
              resolved_id: a.agent_id,
            });
          } else if (a.user_id) {
            const u = userById.get(a.user_id);
            const label = u ? `${role.slug} (${u.name})` : role.slug;
            roleShortcuts.push({
              key: role.slug,
              label,
              resolved_type: 'user',
              resolved_id: a.user_id,
            });
          }
        }
      }
    }

    return res.json({
      users,
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        avatar_url: a.avatar_url,
        manager_agent_id: a.manager_agent_id ?? null,
        manager_name: a.manager_agent_id ? managerNameById.get(a.manager_agent_id) || null : null,
      })),
      role_shortcuts: roleShortcuts,
    });
  }
}
