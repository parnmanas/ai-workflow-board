import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, EntityManager } from 'typeorm';
import { Account } from '../../entities/Account';
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
import { findOrFail } from '../../common/find-or-fail';
import { validateHarnessConfigInput, serializeHarnessConfig } from '../../common/harness-config';
import { validateEnvironmentConfigInput, serializeEnvironmentConfig } from '../../common/environment-config';
import { validateClonePolicyInput, serializeClonePolicy } from '../../common/clone-policy';
import { validateHardBudgetConfigInput, serializeHardBudgetConfig } from '../../common/hard-budget-config';
import { hasPermission } from '../../common/types/permissions';
import { PERMISSIONS } from '../../common/types/permissions';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { agentIsVisibleInAccount, agentAccountWhere } from '../../common/agent-account-scope';

/** 공용 메모리 상한(글자). 매 티켓·미션 지시문에 통째로 실린다. */
export const KNOWLEDGE_MEMORY_MAX = 32_000;

@ApiBearerAuth('user-session')
@ApiTags('accounts')
@Controller('api/accounts')
@UseGuards(AuthGuard)
export class AccountsController {
  constructor(
    @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
  ) {}

  private async requireOwner(user: CurrentUserData, accountId: string, res: Response) {
    if (user?.role === 'admin') return true;
    res.status(403).json({ error: 'admin_required' });
    return false;
  }


  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    const ids: string[] = (req as any).accessibleAccountIds || [];
    if (!ids.length) return res.json([]);
    const accounts = await this.accountRepo.find({ where: { id: In(ids) }, order: { created_at: 'DESC' } });
    const result = await Promise.all(accounts.map(async account => {
      const ticketCount = await this.ticketRepo.count({ where: { account_id: account.id, archived_at: IsNull(), parent_id: IsNull() } });
      return { ...account, ticket_count: ticketCount };
    }));
    return res.json(result);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response, @CurrentUser() user: CurrentUserData) {
    const account = await findOrFail(this.accountRepo, { where: { id } }, 'Account not found');
    const rows = await this.ticketRepo.createQueryBuilder('t')
      .select('t.status', 'status')
      .addSelect('COUNT(*)', 'n')
      .where('t.account_id = :account AND t.parent_id IS NULL AND t.archived_at IS NULL', { account: id })
      .groupBy('t.status')
      .getRawMany();
    const ticket_counts: Record<string, number> = {};
    for (const r of rows) ticket_counts[r.status] = Number(r.n);
    return res.json({ ...account, ticket_counts });
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @Res() res: Response,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!await this.requireOwner(user, id, res)) return;
    const account = await findOrFail(this.accountRepo, { where: { id } }, 'Account not found');

    // Snapshot the cadence/liveness knobs BEFORE mutating so a config-change
    // audit can record old→new (ticket 1fcba693). These are the settings that
    // pace the supervisor backstop — the incident was a 4 h supervisor_stale_ms
    // applied with no trail. Audit written after a successful save below.
    const cadenceBefore = cadenceSnapshot(account);

    const {
      supervisor_stale_ms, supervisor_resend_ms,
      max_concurrent_tickets_per_agent, dispatch_paused_at, language, auto_archive_days,
      chat_workspace_folder_enabled,
      harness_config, environment_config,
      hard_budget_config, clone_policy,
      knowledge_memory,
    } = body;

    // Supervisor cadence (TicketDispatchService). Defaults (30 min / 5 min)
    // live in the entity column; only positive finite integers are accepted
    // so a bad PATCH can't wedge the account into "0 ms stale check".
    if (supervisor_stale_ms !== undefined) {
      const v = Number(supervisor_stale_ms);
      if (Number.isFinite(v) && v > 0) account.supervisor_stale_ms = Math.floor(v);
      else return res.status(400).json({ error: 'supervisor_stale_ms must be a positive number' });
    }
    if (supervisor_resend_ms !== undefined) {
      const v = Number(supervisor_resend_ms);
      if (Number.isFinite(v) && v > 0) account.supervisor_resend_ms = Math.floor(v);
      else return res.status(400).json({ error: 'supervisor_resend_ms must be a positive number' });
    }
    // Ticket dispatch settings that used to live on each board (docs/tickets.md).
    if (max_concurrent_tickets_per_agent !== undefined) {
      const v = Number(max_concurrent_tickets_per_agent);
      if (Number.isInteger(v) && v >= 1 && v <= 50) account.max_concurrent_tickets_per_agent = v;
      else return res.status(400).json({ error: 'max_concurrent_tickets_per_agent must be an integer 1..50' });
    }
    if (dispatch_paused_at !== undefined) {
      if (dispatch_paused_at === null || dispatch_paused_at === false || dispatch_paused_at === '') {
        account.dispatch_paused_at = null;
      } else {
        const at = dispatch_paused_at === true ? new Date() : new Date(dispatch_paused_at);
        if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'dispatch_paused_at must be an ISO timestamp, true or null' });
        account.dispatch_paused_at = account.dispatch_paused_at || at;
      }
    }
    if (language !== undefined) {
      const v = language == null ? '' : String(language).trim();
      account.language = v ? v.slice(0, 64) : null;
    }
    if (auto_archive_days !== undefined) {
      if (auto_archive_days === null || auto_archive_days === '') {
        account.auto_archive_days = null;
      } else {
        const v = Number(auto_archive_days);
        if (Number.isInteger(v) && v >= 1 && v <= 365) account.auto_archive_days = v;
        else return res.status(400).json({ error: 'auto_archive_days must be null or an integer 1..365' });
      }
    }

    // 채팅-계정-폴더 opt-in(티켓 9fd27487).    // 채팅-계정-폴더 opt-in(티켓 9fd27487). int(0/1) truthy 정규화.
    if (chat_workspace_folder_enabled !== undefined) {
      const raw = chat_workspace_folder_enabled;
      account.chat_workspace_folder_enabled = (raw === true || raw === 1 || raw === '1' || raw === 'true') ? 1 : 0;
    }

    // 공용 메모리(Knowledge) — 모든 Agent 의 지시문에 실리므로 상한을 둔다.
    if (knowledge_memory !== undefined) {
      if (typeof knowledge_memory !== 'string') return res.status(400).json({ error: 'knowledge_memory must be a string' });
      if (knowledge_memory.length > KNOWLEDGE_MEMORY_MAX) {
        return res.status(400).json({ error: `knowledge_memory is capped at ${KNOWLEDGE_MEMORY_MAX} characters` });
      }
      account.knowledge_memory = knowledge_memory;
    }

    // Account agent harness (ticket 7122600c): null clears, objects are
    // strict-zod-validated → 400.
    if (harness_config !== undefined) {
      if (harness_config === null) {
        account.harness_config = null;
      } else {
        const checked = validateHarnessConfigInput(harness_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        account.harness_config = serializeHarnessConfig(checked.value);
      }
    }

    // Account hard-budget ceiling (ticket a51ec6d9) — the QA/Action/
    // Orchestration run-creation-rate guard (common/run-budget-guard.ts).
    // null clears, objects are strict-zod-validated → 400.
    if (hard_budget_config !== undefined) {
      if (hard_budget_config === null) {
        account.hard_budget_config = null;
      } else {
        const checked = validateHardBudgetConfigInput(hard_budget_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        account.hard_budget_config = serializeHardBudgetConfig(checked.value);
      }
    }

    // Account environment setup (ticket 354d336b) — env vars for ticket
    // agents. null clears.
    if (environment_config !== undefined) {
      if (environment_config === null) {
        account.environment_config = null;
      } else {
        const checked = validateEnvironmentConfigInput(environment_config);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        account.environment_config = serializeEnvironmentConfig(checked.value);
      }
    }

    // Account-wide default repository clone policy (ticket bddb63ee).
    // Projects override it per key; null clears. 두 레이어 모두 비면 시스템
    // 기본값(clone timeout 60분)이 그대로 적용된다.
    if (clone_policy !== undefined) {
      if (clone_policy === null) {
        account.clone_policy = null;
      } else {
        const checked = validateClonePolicyInput(clone_policy);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        account.clone_policy = serializeClonePolicy(checked.value);
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
        await manager.save(account);
        return this._auditCadenceChangesTx(manager, account.id, cadenceBefore, account, {
          actorId: user?.id || '',
          actorName: user?.name || '',
          source: 'rest',
        });
      });
    } catch (e: any) {
      return res.status(500).json({ error: `Failed to persist account settings: ${e?.message || String(e)}` });
    }
    this.activityService.emitLogged(auditRows);

    return res.json(account);
  }

  /**
   * Write a `config_changed` ActivityLog row for each supervisor/dispatch
   * cadence field that actually changed (ticket 1fcba693), via the caller's
   * transaction `manager` so the rows commit — or roll back — atomically with
   * the account save. Account-scoped (entity_type='account',
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

  // ─── Mention autocomplete candidates ───────────────────────
  //
  // Returns the user + agent set the composer's @-dropdown should show for
  // this account. The only agent a ticket comment can wake is the ticket's
  // assignee, so the agent section is that one agent (when `ticket_id` is
  // supplied and the ticket has one).

  @Get(':id/mention-candidates')
  async mentionCandidates(
    @Param('id') id: string,
    @Query('ticket_id') ticketId: string | undefined,
    @Res() res: Response,
    @CurrentUser() user: CurrentUserData,
  ) {
    await findOrFail(this.accountRepo, { where: { id } }, 'Account not found');

    const agents: Array<{ id: string; name: string }> = [];
    if (ticketId) {
      const ticket = await this.ticketRepo.findOne({ where: { id: ticketId, account_id: id } });
      const spec = ticket ? parseRuntimeSpec(ticket.assignee) : null;
      if (ticket && spec && ticket.assignee_key) {
        const host = await this.dataSource.getRepository(RuntimeHost).findOne({ where: { id: spec.manager_agent_id } });
        agents.push({ id: ticket.assignee_key, name: host ? `${host.name}/${spec.label}` : spec.label });
      }
    }

    const users = (await this.userRepo.find({ where: { status: 'active' }, order: { name: 'ASC' } }))
      .map(u => ({ id: u.id, name: u.name, avatar_url: u.avatar_url }));

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
function cadenceSnapshot(account: Account) {
  return {
    supervisor_stale_ms: String(account.supervisor_stale_ms),
    supervisor_resend_ms: String(account.supervisor_resend_ms),
    max_concurrent_tickets_per_agent: String(account.max_concurrent_tickets_per_agent),
    dispatch_paused_at: account.dispatch_paused_at ? new Date(account.dispatch_paused_at).toISOString() : '',
  };
}
