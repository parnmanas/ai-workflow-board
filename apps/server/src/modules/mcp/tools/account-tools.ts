/**
 * Account CRUD MCP tools.
 *
 * Tools: list_accounts, get_account, create_account,
 *        update_account, delete_account
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IsNull } from 'typeorm';
import { deleteAccountContent } from '../../accounts/account-cleanup';
import { z } from 'zod';
import { Account } from '../../../entities/Account';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { HarnessConfigSchema, serializeHarnessConfig } from '../../../common/harness-config';
import { EnvironmentConfigSchema, validateEnvironmentConfigInput, serializeEnvironmentConfig } from '../../../common/environment-config';
import { HardBudgetConfigSchema, serializeHardBudgetConfig } from '../../../common/hard-budget-config';
import { ClonePolicySchema, serializeClonePolicy } from '../../../common/clone-policy';
import { getCallerAgent } from '../shared/session-auth';
import { resolveCallerDisplayName } from '../shared/ticket-helpers';
import { callerCanAccessAccount, requireAccountScopedFullAccess } from '../shared/authz';
import { normalizeAgentAccountId } from '../../../common/agent-account-scope';
import type { ToolContext } from './context';
import { activityEvents } from '../../../services/activity.service';

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService } = ctx;

  server.tool(
    'list_accounts',
    'List all accounts',
    {},
    async () => {
      const accounts = await dataSource.getRepository(Account).find({ order: { created_at: 'DESC' } });
      const result = await Promise.all(accounts.map(async account => {
        const ticketCount = await dataSource.getRepository(Ticket).count({ where: { account_id: account.id, archived_at: IsNull(), parent_id: IsNull() } });
        return { ...account, ticket_count: ticketCount };
      }));
      return ok(result);
    }
  );

  server.tool(
    'get_account',
    'Get an ownership account with its settings and open-ticket counts per status',
    { account_id: z.string().describe('Account ID') },
    async ({ account_id }) => {
      const account = await dataSource.getRepository(Account).findOne({ where: { id: account_id } });
      if (!account) return err('Account not found');
      const rows = await dataSource.getRepository(Ticket).createQueryBuilder('t')
        .select('t.status', 'status')
        .addSelect('COUNT(*)', 'n')
        .where('t.account_id = :account AND t.parent_id IS NULL AND t.archived_at IS NULL', { account: account_id })
        .groupBy('t.status')
        .getRawMany();
      const ticket_counts: Record<string, number> = {};
      for (const r of rows) ticket_counts[r.status] = Number(r.n);
      return ok({ ...account, ticket_counts });
    }
  );

  server.tool(
    'create_account',
    'Create an ownership account for permissions, credentials and execution policy',
    {
      name: z.string().describe('Account name'),
      description: z.string().optional().default('').describe('Account description'),
    },
    async ({ name, description }) => {
      const accountRepo = dataSource.getRepository(Account);
      const account = await accountRepo.save(accountRepo.create({ name, description }));
      activityEvents.emit('account_membership_changed', { account_id: account.id });
      return ok(await accountRepo.findOne({ where: { id: account.id } }));
    }
  );

  server.tool(
    'update_account',
    'Update an ownership account: name, description, ticket dispatch settings (max_concurrent_tickets_per_agent, dispatch_paused, language, auto_archive_days, supervisor_stale_ms / supervisor_resend_ms), the chat-workspace-folder opt-in, the agent harness (harness_config), environment env vars, clone policy, or the run hard-budget ceiling',
    {
      account_id: z.string().describe('Account ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      supervisor_stale_ms: z.number().positive().optional()
        .describe('An in_progress ticket whose agent shows no life for this long is re-dispatched by the supervisor. Default 1800000 (30 min).'),
      supervisor_resend_ms: z.number().positive().optional()
        .describe('Cooldown between supervisor re-dispatches. Default 300000 (5 min).'),
      max_concurrent_tickets_per_agent: z.number().int().min(1).max(50).optional()
        .describe('How many in_progress tickets one agent identity works at once. Default 1.'),
      dispatch_paused: z.boolean().optional().describe('true pauses all ticket dispatch in the account; false resumes.'),
      language: z.string().nullable().optional().describe('Language every agent writes in (e.g. "Korean"); null = agent default.'),
      auto_archive_days: z.number().int().min(1).max(365).nullable().optional().describe('Archive done tickets idle this many days; null disables.'),
      chat_workspace_folder_enabled: z.boolean().optional()
        .describe('Opt-in (ticket 9fd27487): when true, an ordinary chat room (not an Action Run / Orchestration Mission room) dispatches inside `.awb/chat/<room8>` instead of the agent working_dir root. Default false — off by default because the manager agent\'s own operational chat also rides this path.'),
      harness_config: HarnessConfigSchema.nullable().optional()
        .describe('Account agent harness: { system_prompt_append?, allowed_tools?, disallowed_tools?, model?, permission_mode? } — shipped on every ticket dispatch. Pass null to clear.'),
      environment_config: EnvironmentConfigSchema.nullable().optional()
        .describe('Account environment setup (env vars for ticket agents). Repositories come from each ticket\'s project, not from here. Pass null to clear.'),
      clone_policy: ClonePolicySchema.nullable().optional()
        .describe('Account-wide default repository clone policy: { clone_timeout_seconds?, clone_idle_timeout_seconds?, clone_depth?, clone_filter?, single_branch? }. A project overrides it per key via save_project.clone_policy; unset keys fall through to the system defaults (clone timeout 3600s = 60min, idle timeout DISABLED, full clone). Pass null to clear.'),
      hard_budget_config: HardBudgetConfigSchema.nullable().optional()
        .describe('Account hard-budget ceiling for new QA/Action/Orchestration run creations ({ enabled?, max_runs_per_window?, window_minutes?, … }). Pass null to clear.'),
    },
    async ({ account_id, name, description, supervisor_stale_ms, supervisor_resend_ms, max_concurrent_tickets_per_agent, dispatch_paused, language, auto_archive_days, chat_workspace_folder_enabled, harness_config, environment_config, hard_budget_config, clone_policy }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      // getCallerAgent was previously consulted only for the audit rows
      // below, never as a gate — any authenticated key could rewrite any
      // OTHER account's cadence/harness settings. Require the caller to
      // actually belong to (or be a global full-scope agent visible from)
      // the account it's editing.
      if (!(await callerCanAccessAccount(dataSource, caller, account_id))) {
        return err('Unauthorized: caller does not belong to this account');
      }

      const accountRepo = dataSource.getRepository(Account);
      const account = await accountRepo.findOne({ where: { id: account_id } });
      if (!account) return err('Account not found');

      // Snapshot cadence knobs before mutating for the config-change audit
      // (ticket 1fcba693) — old→new + actor + source=mcp.
      const cadenceBefore = {
        supervisor_stale_ms: account.supervisor_stale_ms,
        supervisor_resend_ms: account.supervisor_resend_ms,
        max_concurrent_tickets_per_agent: account.max_concurrent_tickets_per_agent,
        dispatch_paused_at: account.dispatch_paused_at ? new Date(account.dispatch_paused_at).toISOString() : '',
      };

      if (name !== undefined) account.name = name;
      if (description !== undefined) account.description = description;
      // v0.41 — cadence settings (AC #4). Zod's `.positive()` already
      // gates non-positive / non-finite input, so a successful args
      // parse means we can floor and assign without re-validating.
      if (supervisor_stale_ms !== undefined) account.supervisor_stale_ms = Math.floor(supervisor_stale_ms);
      if (supervisor_resend_ms !== undefined) account.supervisor_resend_ms = Math.floor(supervisor_resend_ms);
      if (max_concurrent_tickets_per_agent !== undefined) account.max_concurrent_tickets_per_agent = Math.floor(max_concurrent_tickets_per_agent);
      if (dispatch_paused !== undefined) account.dispatch_paused_at = dispatch_paused ? (account.dispatch_paused_at || new Date()) : null;
      if (language !== undefined) account.language = language && language.trim() ? language.trim() : null;
      if (auto_archive_days !== undefined) account.auto_archive_days = auto_archive_days;
      if (chat_workspace_folder_enabled !== undefined) account.chat_workspace_folder_enabled = chat_workspace_folder_enabled ? 1 : 0;
      // Default harness (ticket 7122600c) — strict-validated by the arg
      // schema; empty objects collapse to null via the serializer.
      if (harness_config !== undefined) account.harness_config = serializeHarnessConfig(harness_config);
      // Environment setup (ticket 354d336b) — validated, then serialized
      // (empty configs → null).
      if (environment_config !== undefined) {
        if (environment_config === null) {
          account.environment_config = null;
        } else {
          const checked = validateEnvironmentConfigInput(environment_config);
          if (!checked.ok) return err(checked.error);
          account.environment_config = serializeEnvironmentConfig(checked.value);
        }
      }
      // Default hard-budget ceiling (ticket a51ec6d9) — strict-validated by
      // the arg schema; empty objects collapse to null via the serializer.
      if (hard_budget_config !== undefined) account.hard_budget_config = serializeHardBudgetConfig(hard_budget_config);
      // Default repository clone policy (ticket bddb63ee) — same shape as
      // save_project.clone_policy; strict-validated by the arg schema, and an
      // empty object collapses to null via the serializer.
      if (clone_policy !== undefined) account.clone_policy = serializeClonePolicy(clone_policy);

      // Config-change audit (ticket 1fcba693): one grep-able config_changed row
      // per changed cadence knob, actor from the MCP session, source=mcp. In
      // standalone mode getCallerAgent returns undefined (empty actor), but the
      // row still records the change + source.
      const auditFields = ['supervisor_stale_ms', 'supervisor_resend_ms', 'max_concurrent_tickets_per_agent', 'dispatch_paused_at'];

      // Persist the settings change + its config_changed rows ATOMICALLY
      // (reviewer AC): ONE transaction, so an audit-write failure rolls the
      // cadence save back and the tool returns an error — a cadence value can
      // never persist without its trail (audit-or-nothing), which a best-effort
      // swallowed audit could not guarantee. SSE emit deferred until commit.
      let auditRows;
      try {
        auditRows = await dataSource.transaction(async (manager) => {
          await manager.save(account);
          const rows: any[] = [];
          for (const field of auditFields) {
            const oldVal = (cadenceBefore as any)[field];
            const rawNew = (account as any)[field];
            const newVal = rawNew instanceof Date ? rawNew.toISOString() : (rawNew ?? '');
            if (oldVal === newVal) continue;
            rows.push(await activityService.logActivityTx(manager, {
              entity_type: 'account',
              entity_id: account.id,
              account_id: account.id,
              ticket_id: '',
              action: 'config_changed',
              field_changed: field,
              old_value: String(oldVal),
              new_value: String(newVal),
              actor_id: caller?.agentId || '',
              // P4c-4: agent_id 키 세션은 agentName 이 비어 있다 — Host/링크로 해소한다.
              actor_name: await resolveCallerDisplayName(dataSource, caller),
              trigger_source: 'mcp',
            }));
          }
          return rows;
        });
      } catch (e: any) {
        return err(`Failed to persist account settings: ${e?.message || String(e)}`);
      }
      activityService.emitLogged(auditRows);

      return ok(account);
    }
  );

  server.tool(
    'delete_account',
    'Delete an ownership account and its tickets and projects (cannot delete the last account)',
    { account_id: z.string().describe('Account ID') },
    async ({ account_id }, extra: { sessionId?: string }) => {
      // requireFullScopeCaller alone only proves "some live, full-scope
      // Agent called this" — it never checked that the caller BELONGS to
      // the account being cascade-deleted, so a full-scope key bound to
      // account A could delete account B (ticket d6b56237 review round 2).
      const gateError = await requireAccountScopedFullAccess(
        dataSource, getCallerAgent(extra), normalizeAgentAccountId(account_id),
      );
      if (gateError) return err(gateError);

      const accountRepo = dataSource.getRepository(Account);
      const account = await accountRepo.findOne({ where: { id: account_id } });
      if (!account) return err('Account not found');

      const count = await accountRepo.count();
      if (count <= 1) return err('Cannot delete the last account');

      await deleteAccountContent(dataSource, account.id);
      await accountRepo.delete(account.id);
      return ok({ success: true });
    }
  );
}
