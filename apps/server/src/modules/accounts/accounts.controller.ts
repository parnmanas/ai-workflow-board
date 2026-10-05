import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, EntityManager } from 'typeorm';
import { Account } from '../../entities/Account';
import { RelationTuple } from '../../entities/RelationTuple';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { User } from '../../entities/User';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { ApiKey } from '../../entities/ApiKey';
import { resolveCallerIdentityRow } from '../mcp/shared/authz';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ActivityService } from '../../services/activity.service';
import { activityEvents } from '../../services/activity.service';
import { parseRuntimeSpec } from '../../common/runtime-spec';
import { deleteAccountContent } from './account-cleanup';
import { ReBACService } from '../../services/rebac.service';
import { findOrFail } from '../../common/find-or-fail';
import { validateHarnessConfigInput, serializeHarnessConfig } from '../../common/harness-config';
import { validateEnvironmentConfigInput, serializeEnvironmentConfig } from '../../common/environment-config';
import { validateClonePolicyInput, serializeClonePolicy } from '../../common/clone-policy';
import { validateHardBudgetConfigInput, serializeHardBudgetConfig } from '../../common/hard-budget-config';
import { hasPermission } from '../../common/types/permissions';
import { PERMISSIONS } from '../../common/types/permissions';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { agentIsVisibleInWorkspace, agentWorkspaceWhere } from '../../common/agent-account-scope';

@ApiBearerAuth('user-session')
@ApiTags('accounts')
@Controller('api/accounts')
@UseGuards(AuthGuard)
export class AccountsController {
  constructor(
    @InjectRepository(Account) private readonly wsRepo: Repository<Account>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly rebacService: ReBACService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
  ) {}

  private async requireOwner(user: CurrentUserData, accountId: string, res: Response) {
    if (user?.role === 'admin') return true;
    const owner = await this.rebacService.check(
      { type: 'user', id: user.id },
      'owner',
      { type: 'account', id: accountId },
    );
    if (!owner) res.status(403).json({ error: 'account_owner_required' });
    return owner;
  }

  private async requireWorkspaceAccess(user: CurrentUserData, accountId: string, res: Response) {
    if (user?.role === 'admin') return true;
    const subject = { type: 'user', id: user.id };
    const object = { type: 'account', id: accountId };
    const allowed =
      await this.rebacService.check(subject, 'owner', object) ||
      await this.rebacService.check(subject, 'member', object);
    if (!allowed) res.status(403).json({ error: 'account_access_denied' });
    return allowed;
  }

  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    const ids: string[] = (req as any).accessibleAccountIds || [];
    if (!ids.length) return res.json([]);
    const accounts = await this.wsRepo.find({ where: { id: In(ids) }, order: { created_at: 'DESC' } });
    const result = await Promise.all(accounts.map(async ws => {
      const ticketCount = await this.ticketRepo.count({ where: { account_id: ws.id, archived_at: IsNull(), parent_id: IsNull() } });
      return { ...ws, ticket_count: ticketCount };
    }));
    return res.json(result);
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response, @CurrentUser() user: CurrentUserData) {
    const { name, description = '' } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const account = await this.dataSource.transaction(async manager => {
      const row = await manager.getRepository(Account).save(manager.getRepository(Account).create({ name, description }));
      await manager.getRepository(RelationTuple).save(manager.getRepository(RelationTuple).create({
        subject_type: 'user', subject_id: user.id, relation: 'owner', object_type: 'account', object_id: row.id,
      }));
      return row;
    });
    activityEvents.emit('account_membership_changed', { user_id: user.id, account_id: account.id });
    return res.status(201).json(account);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response, @CurrentUser() user: CurrentUserData) {
    if (!await this.requireWorkspaceAccess(user, id, res)) return;
    const ws = await findOrFail(this.wsRepo, { where: { id } }, 'Account not found');
    const rows = await this.ticketRepo.createQueryBuilder('t')
      .select('t.status', 'status')
      .addSelect('COUNT(*)', 'n')
      .where('t.account_id = :ws AND t.parent_id IS NULL AND t.archived_at IS NULL', { ws: id })
      .groupBy('t.status')
      .getRawMany();
    const ticket_counts: Record<string, number> = {};
    for (const r of rows) ticket_counts[r.status] = Number(r.n);
    return res.json({ ...ws, ticket_counts });
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @Res() res: Response,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!await this.requireOwner(user, id, res)) return;
    const ws = await findOrFail(this.wsRepo, { where: { id } }, 'Account not found');

    // Snapshot the cadence/liveness knobs BEFORE mutating so a config-change
    // audit can record old→new (ticket 1fcba693). These are the settings that
    // pace the supervisor backstop — the incident was a 4 h supervisor_stale_ms
    // applied with no trail. Audit written after a successful save below.
    const cadenceBefore = cadenceSnapshot(ws);

    const {
      name, description,
      supervisor_stale_ms, supervisor_resend_ms,
      max_concurrent_tickets_per_agent, dispatch_paused_at, language, auto_archive_days,
      chat_workspace_folder_enabled,
      harness_config, environment_config,
      hard_budget_config, clone_policy,
    } = body;
    if (name !== undefined) ws.name = name;
    if (description !== undefined) ws.description = description;

    // Supervisor cadence (TicketDispatchService). Defaults (30 min / 5 min)
    // live in the entity column; only positive finite integers are accepted
    // so a bad PATCH can't wedge the workspace into "0 ms stale check".
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
    // Ticket dispatch settings that used to live on each board (docs/tickets.md).
    if (max_concurrent_tickets_per_agent !== undefined) {
      const v = Number(max_concurrent_tickets_per_agent);
      if (Number.isInteger(v) && v >= 1 && v <= 50) ws.max_concurrent_tickets_per_agent = v;
      else return res.status(400).json({ error: 'max_concurrent_tickets_per_agent must be an integer 1..50' });
    }
    if (dispatch_paused_at !== undefined) {
      if (dispatch_paused_at === null || dispatch_paused_at === false || dispatch_paused_at === '') {
        ws.dispatch_paused_at = null;
      } else {
        const at = dispatch_paused_at === true ? new Date() : new Date(dispatch_paused_at);
        if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'dispatch_paused_at must be an ISO timestamp, true or null' });
        ws.dispatch_paused_at = ws.dispatch_paused_at || at;
      }
    }
    if (language !== undefined) {
      const v = language == null ? '' : String(language).trim();
      ws.language = v ? v.slice(0, 64) : null;
    }
    if (auto_archive_days !== undefined) {
      if (auto_archive_days === null || auto_archive_days === '') {
        ws.auto_archive_days = null;
      } else {
        const v = Number(auto_archive_days);
        if (Number.isInteger(v) && v >= 1 && v <= 365) ws.auto_archive_days = v;
        else return res.status(400).json({ error: 'auto_archive_days must be null or an integer 1..365' });
      }
    }

    // 채팅-워크스페이스-폴더 opt-in(티켓 9fd27487).    // 채팅-워크스페이스-폴더 opt-in(티켓 9fd27487). int(0/1) truthy 정규화.
    if (chat_workspace_folder_enabled !== undefined) {
      const raw = chat_workspace_folder_enabled;
      ws.chat_workspace_folder_enabled = (raw === true || raw === 1 || raw === '1' || raw === 'true') ? 1 : 0;
    }

    // Account agent harness (ticket 7122600c): null clears, objects are
    // strict-zod-validated → 400.
    if (harness_config !== undefined) {
      if (harness_config === null) {
        ws.harness_config = null;
      } else {
        const checked = validateHarnessConfigInput(harness_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        ws.harness_config = serializeHarnessConfig(checked.value);
      }
    }

    // Account hard-budget ceiling (ticket a51ec6d9) — the QA/Action/
    // Orchestration run-creation-rate guard (common/run-budget-guard.ts).
    // null clears, objects are strict-zod-validated → 400.
    if (hard_budget_config !== undefined) {
      if (hard_budget_config === null) {
        ws.hard_budget_config = null;
      } else {
        const checked = validateHardBudgetConfigInput(hard_budget_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        ws.hard_budget_config = serializeHardBudgetConfig(checked.value);
      }
    }

    // Account environment setup (ticket 354d336b) — env vars for ticket
    // agents. null clears.
    if (environment_config !== undefined) {
      if (environment_config === null) {
        ws.environment_config = null;
      } else {
        const checked = validateEnvironmentConfigInput(environment_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        ws.environment_config = serializeEnvironmentConfig(checked.value);
      }
    }

    // Account-wide default repository clone policy (ticket bddb63ee).
    // Projects override it per key; null clears. 두 레이어 모두 비면 시스템
    // 기본값(clone timeout 60분)이 그대로 적용된다.
    if (clone_policy !== undefined) {
      if (clone_policy === null) {
        ws.clone_policy = null;
      } else {
        const checked = validateClonePolicyInput(clone_policy);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        ws.clone_policy = serializeClonePolicy(checked.value);
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
   * the workspace save. Account-scoped (entity_type='account',
   * ticket_id=''), carrying actor + old→new + source so a value like the
   * incident's 4 h supervisor_stale_ms can never again land without a trail.
   * Returns the persisted (not-yet-emitted) rows; the caller emits them after
   * commit. Deliberately does NOT swallow — a write failure propagates so the
   * transaction rolls the settings change back too (audit-or-nothing).
   */
  private async _auditCadenceChangesTx(
    manager: EntityManager,
    accountId: string,
    before: ReturnType<typeof cadenceSnapshot>,
    after: Account,
    actor: { actorId: string; actorName: string; source: string },
  ): Promise<ActivityLog[]> {
    const now = cadenceSnapshot(after);
    const fields = Object.keys(before) as Array<keyof typeof before>;
    const rows: ActivityLog[] = [];
    for (const field of fields) {
      const oldVal = before[field];
      const newVal = now[field];
      if (oldVal === newVal) continue;
      rows.push(await this.activityService.logActivityTx(manager, {
        entity_type: 'account',
        entity_id: accountId,
        account_id: accountId,
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
  async delete(@Param('id') id: string, @Res() res: Response, @CurrentUser() user: CurrentUserData) {
    if (!await this.requireOwner(user, id, res)) return;
    const ws = await findOrFail(this.wsRepo, { where: { id } }, 'Account not found');

    const count = await this.wsRepo.count();
    if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last account' });

    await deleteAccountContent(this.dataSource, ws.id);
    await this.dataSource.transaction(async manager => {
      await manager.getRepository(RelationTuple).delete({ object_type: 'account', object_id: ws.id });
      await manager.getRepository(Account).delete(ws.id);
    });
    return res.json({ success: true });
  }

  // ─── Account Members (ReBAC) ─────────────────────────

  @Get(':id/members')
  async listMembers(@Param('id') id: string, @Res() res: Response, @CurrentUser() user: CurrentUserData) {
    if (!await this.requireWorkspaceAccess(user, id, res)) return;
    await findOrFail(this.wsRepo, { where: { id } }, 'Account not found');

    const [members, owners] = await Promise.all([
      this.rebacService.listSubjects({ type: 'account', id }, 'member'),
      this.rebacService.listSubjects({ type: 'account', id }, 'owner'),
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
  async addMember(@Param('id') id: string, @Body() body: any, @Res() res: Response, @CurrentUser() user: CurrentUserData) {
    if (!await this.requireOwner(user, id, res)) return;
    const { user_id, relation = 'member' } = body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!['member', 'owner'].includes(relation)) {
      return res.status(400).json({ error: 'relation must be member or owner' });
    }

    await findOrFail(this.wsRepo, { where: { id } }, 'Account not found');
    await findOrFail(this.userRepo, { where: { id: user_id } }, 'User not found');

    await this.rebacService.grant({ type: 'user', id: user_id }, relation, { type: 'account', id });
    return res.status(201).json({ success: true, user_id, relation, account_id: id });
  }

  @Patch(':id/members/:userId')
  async updateMemberRole(
    @Param('id') id: string, @Param('userId') userId: string,
    @Body() body: any, @Res() res: Response, @CurrentUser() user: CurrentUserData,
  ) {
    if (!await this.requireOwner(user, id, res)) return;
    await findOrFail(this.wsRepo, { where: { id } }, 'Account not found');
    await findOrFail(this.userRepo, { where: { id: userId } }, 'User not found');
    const { relation } = body;
    if (!['member', 'owner'].includes(relation)) {
      return res.status(400).json({ error: 'relation must be member or owner' });
    }
    // Revoke both, then grant the new one
    await this.rebacService.revoke({ type: 'user', id: userId }, 'member', { type: 'account', id });
    await this.rebacService.revoke({ type: 'user', id: userId }, 'owner', { type: 'account', id });
    await this.rebacService.grant({ type: 'user', id: userId }, relation, { type: 'account', id });
    return res.json({ success: true, user_id: userId, relation });
  }

  @Delete(':id/members/:userId')
  async removeMember(@Param('id') id: string, @Param('userId') userId: string, @Res() res: Response, @CurrentUser() user: CurrentUserData) {
    if (!await this.requireOwner(user, id, res)) return;
    await findOrFail(this.wsRepo, { where: { id } }, 'Account not found');
    await this.rebacService.revoke({ type: 'user', id: userId }, 'member', { type: 'account', id });
    await this.rebacService.revoke({ type: 'user', id: userId }, 'owner', { type: 'account', id });
    return res.json({ success: true });
  }

  // ─── Mention autocomplete candidates ───────────────────────
  //
  // Returns the user + agent set the composer's @-dropdown should show for
  // this workspace. The only agent a ticket comment can wake is the ticket's
  // assignee, so the agent section is that one agent (when `ticket_id` is
  // supplied and the ticket has one).

  @Get(':id/mention-candidates')
  async mentionCandidates(
    @Param('id') id: string,
    @Query('ticket_id') ticketId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!await this.requireWorkspaceAccess(user, id, res)) return;
    await findOrFail(this.wsRepo, { where: { id } }, 'Account not found');

    const [members, owners] = await Promise.all([
      this.rebacService.listSubjects({ type: 'account', id }, 'member'),
      this.rebacService.listSubjects({ type: 'account', id }, 'owner'),
    ]);
    const agents: Array<{ id: string; name: string }> = [];
    if (ticketId) {
      const ticket = await this.ticketRepo.findOne({ where: { id: ticketId, account_id: id } });
      const spec = ticket ? parseRuntimeSpec(ticket.assignee) : null;
      if (ticket && spec && ticket.assignee_key) {
        const host = await this.dataSource.getRepository(RuntimeHost).findOne({ where: { id: spec.manager_agent_id } });
        agents.push({ id: ticket.assignee_key, name: host ? `${host.name}/${spec.label}` : spec.label });
      }
    }

    const allUserIds = [...new Set([
      ...members.filter(s => s.type === 'user').map(s => s.id),
      ...owners.filter(s => s.type === 'user').map(s => s.id),
    ])];
    const users = allUserIds.length
      ? (await this.userRepo.find({ where: { id: In(allUserIds) } }))
          .map(u => ({ id: u.id, name: u.name, avatar_url: u.avatar_url }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    return res.json({
      users,
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        avatar_url: null,
        manager_agent_id: null,
        manager_name: null,
      })),
      role_shortcuts: [],
    });
  }
}

/** The settings whose changes get a `config_changed` audit row (ticket 1fcba693). */
function cadenceSnapshot(ws: Account) {
  return {
    supervisor_stale_ms: String(ws.supervisor_stale_ms),
    supervisor_resend_ms: String(ws.supervisor_resend_ms),
    max_concurrent_tickets_per_agent: String(ws.max_concurrent_tickets_per_agent),
    dispatch_paused_at: ws.dispatch_paused_at ? new Date(ws.dispatch_paused_at).toISOString() : '',
  };
}
