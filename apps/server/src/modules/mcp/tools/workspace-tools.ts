/**
 * Workspace CRUD MCP tools.
 *
 * Tools: list_workspaces, get_workspace, create_workspace,
 *        update_workspace, delete_workspace
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IsNull } from 'typeorm';
import { deleteWorkspaceContent } from '../../workspaces/workspace-cleanup';
import { z } from 'zod';
import { Workspace } from '../../../entities/Workspace';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { HarnessConfigSchema, serializeHarnessConfig } from '../../../common/harness-config';
import { EnvironmentConfigSchema, validateEnvironmentConfigInput, serializeEnvironmentConfig } from '../../../common/environment-config';
import { HardBudgetConfigSchema, serializeHardBudgetConfig } from '../../../common/hard-budget-config';
import { ClonePolicySchema, serializeClonePolicy } from '../../../common/clone-policy';
import { getCallerAgent } from '../shared/session-auth';
import { resolveCallerDisplayName } from '../shared/ticket-helpers';
import { callerCanAccessWorkspace, requireWorkspaceScopedFullAccess } from '../shared/authz';
import { normalizeAgentWorkspaceId } from '../../../common/agent-workspace-scope';
import type { ToolContext } from './context';

export function registerWorkspaceTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService } = ctx;

  server.tool(
    'list_workspaces',
    'List all workspaces',
    {},
    async () => {
      const workspaces = await dataSource.getRepository(Workspace).find({ order: { created_at: 'DESC' } });
      const result = await Promise.all(workspaces.map(async ws => {
        const ticketCount = await dataSource.getRepository(Ticket).count({ where: { workspace_id: ws.id, archived_at: IsNull(), parent_id: IsNull() } });
        return { ...ws, ticket_count: ticketCount };
      }));
      return ok(result);
    }
  );

  server.tool(
    'get_workspace',
    'Get a workspace with its settings and open-ticket counts per status',
    { workspace_id: z.string().describe('Workspace ID') },
    async ({ workspace_id }) => {
      const ws = await dataSource.getRepository(Workspace).findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');
      const rows = await dataSource.getRepository(Ticket).createQueryBuilder('t')
        .select('t.status', 'status')
        .addSelect('COUNT(*)', 'n')
        .where('t.workspace_id = :ws AND t.parent_id IS NULL AND t.archived_at IS NULL', { ws: workspace_id })
        .groupBy('t.status')
        .getRawMany();
      const ticket_counts: Record<string, number> = {};
      for (const r of rows) ticket_counts[r.status] = Number(r.n);
      return ok({ ...ws, ticket_counts });
    }
  );

  server.tool(
    'create_workspace',
    'Create a new workspace (an empty ticket pool; add projects with save_project)',
    {
      name: z.string().describe('Workspace name'),
      description: z.string().optional().default('').describe('Workspace description'),
    },
    async ({ name, description }) => {
      const wsRepo = dataSource.getRepository(Workspace);
      const ws = await wsRepo.save(wsRepo.create({ name, description }));
      return ok(await wsRepo.findOne({ where: { id: ws.id } }));
    }
  );

  server.tool(
    'update_workspace',
    'Update a workspace: name, description, ticket dispatch settings (max_concurrent_tickets_per_agent, dispatch_paused, language, auto_archive_days, supervisor_stale_ms / supervisor_resend_ms), the chat-workspace-folder opt-in, the agent harness (harness_config), environment env vars, clone policy, or the run hard-budget ceiling',
    {
      workspace_id: z.string().describe('Workspace ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      supervisor_stale_ms: z.number().positive().optional()
        .describe('An in_progress ticket whose agent shows no life for this long is re-dispatched by the supervisor. Default 1800000 (30 min).'),
      supervisor_resend_ms: z.number().positive().optional()
        .describe('Cooldown between supervisor re-dispatches. Default 300000 (5 min).'),
      max_concurrent_tickets_per_agent: z.number().int().min(1).max(50).optional()
        .describe('How many in_progress tickets one agent identity works at once. Default 1.'),
      dispatch_paused: z.boolean().optional().describe('true pauses all ticket dispatch in the workspace; false resumes.'),
      language: z.string().nullable().optional().describe('Language every agent writes in (e.g. "Korean"); null = agent default.'),
      auto_archive_days: z.number().int().min(1).max(365).nullable().optional().describe('Archive done tickets idle this many days; null disables.'),
      chat_workspace_folder_enabled: z.boolean().optional()
        .describe('Opt-in (ticket 9fd27487): when true, an ordinary chat room (not an Action Run / Orchestration Mission room) dispatches inside `.awb/chat/<room8>` instead of the agent working_dir root. Default false — off by default because the manager agent\'s own operational chat also rides this path.'),
      harness_config: HarnessConfigSchema.nullable().optional()
        .describe('Workspace agent harness: { system_prompt_append?, allowed_tools?, disallowed_tools?, model?, permission_mode? } — shipped on every ticket dispatch. Pass null to clear.'),
      environment_config: EnvironmentConfigSchema.nullable().optional()
        .describe('Workspace environment setup (env vars for ticket agents). Repositories come from each ticket\'s project, not from here. Pass null to clear.'),
      clone_policy: ClonePolicySchema.nullable().optional()
        .describe('Workspace-wide default repository clone policy: { clone_timeout_seconds?, clone_idle_timeout_seconds?, clone_depth?, clone_filter?, single_branch? }. A project overrides it per key via save_project.clone_policy; unset keys fall through to the system defaults (clone timeout 3600s = 60min, idle timeout DISABLED, full clone). Pass null to clear.'),
      hard_budget_config: HardBudgetConfigSchema.nullable().optional()
        .describe('Workspace hard-budget ceiling for new QA/Action/Orchestration run creations ({ enabled?, max_runs_per_window?, window_minutes?, … }). Pass null to clear.'),
    },
    async ({ workspace_id, name, description, supervisor_stale_ms, supervisor_resend_ms, max_concurrent_tickets_per_agent, dispatch_paused, language, auto_archive_days, chat_workspace_folder_enabled, harness_config, environment_config, hard_budget_config, clone_policy }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      // getCallerAgent was previously consulted only for the audit rows
      // below, never as a gate — any authenticated key could rewrite any
      // OTHER workspace's cadence/harness settings. Require the caller to
      // actually belong to (or be a global full-scope agent visible from)
      // the workspace it's editing.
      if (!(await callerCanAccessWorkspace(dataSource, caller, workspace_id))) {
        return err('Unauthorized: caller does not belong to this workspace');
      }

      const wsRepo = dataSource.getRepository(Workspace);
      const ws = await wsRepo.findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      // Snapshot cadence knobs before mutating for the config-change audit
      // (ticket 1fcba693) — old→new + actor + source=mcp.
      const cadenceBefore = {
        supervisor_stale_ms: ws.supervisor_stale_ms,
        supervisor_resend_ms: ws.supervisor_resend_ms,
        max_concurrent_tickets_per_agent: ws.max_concurrent_tickets_per_agent,
        dispatch_paused_at: ws.dispatch_paused_at ? new Date(ws.dispatch_paused_at).toISOString() : '',
      };

      if (name !== undefined) ws.name = name;
      if (description !== undefined) ws.description = description;
      // v0.41 — cadence settings (AC #4). Zod's `.positive()` already
      // gates non-positive / non-finite input, so a successful args
      // parse means we can floor and assign without re-validating.
      if (supervisor_stale_ms !== undefined) ws.supervisor_stale_ms = Math.floor(supervisor_stale_ms);
      if (supervisor_resend_ms !== undefined) ws.supervisor_resend_ms = Math.floor(supervisor_resend_ms);
      if (max_concurrent_tickets_per_agent !== undefined) ws.max_concurrent_tickets_per_agent = Math.floor(max_concurrent_tickets_per_agent);
      if (dispatch_paused !== undefined) ws.dispatch_paused_at = dispatch_paused ? (ws.dispatch_paused_at || new Date()) : null;
      if (language !== undefined) ws.language = language && language.trim() ? language.trim() : null;
      if (auto_archive_days !== undefined) ws.auto_archive_days = auto_archive_days;
      if (chat_workspace_folder_enabled !== undefined) ws.chat_workspace_folder_enabled = chat_workspace_folder_enabled ? 1 : 0;
      // Default harness (ticket 7122600c) — strict-validated by the arg
      // schema; empty objects collapse to null via the serializer.
      if (harness_config !== undefined) ws.harness_config = serializeHarnessConfig(harness_config);
      // Environment setup (ticket 354d336b) — validated, then serialized
      // (empty configs → null).
      if (environment_config !== undefined) {
        if (environment_config === null) {
          ws.environment_config = null;
        } else {
          const checked = validateEnvironmentConfigInput(environment_config);
          if (!checked.ok) return err(checked.error);
          ws.environment_config = serializeEnvironmentConfig(checked.value);
        }
      }
      // Default hard-budget ceiling (ticket a51ec6d9) — strict-validated by
      // the arg schema; empty objects collapse to null via the serializer.
      if (hard_budget_config !== undefined) ws.hard_budget_config = serializeHardBudgetConfig(hard_budget_config);
      // Default repository clone policy (ticket bddb63ee) — same shape as
      // save_project.clone_policy; strict-validated by the arg schema, and an
      // empty object collapses to null via the serializer.
      if (clone_policy !== undefined) ws.clone_policy = serializeClonePolicy(clone_policy);

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
          await manager.save(ws);
          const rows: any[] = [];
          for (const field of auditFields) {
            const oldVal = (cadenceBefore as any)[field];
            const rawNew = (ws as any)[field];
            const newVal = rawNew instanceof Date ? rawNew.toISOString() : (rawNew ?? '');
            if (oldVal === newVal) continue;
            rows.push(await activityService.logActivityTx(manager, {
              entity_type: 'workspace',
              entity_id: ws.id,
              workspace_id: ws.id,
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
        return err(`Failed to persist workspace settings: ${e?.message || String(e)}`);
      }
      activityService.emitLogged(auditRows);

      return ok(ws);
    }
  );

  server.tool(
    'delete_workspace',
    'Delete a workspace and all its tickets and projects (cannot delete the last workspace)',
    { workspace_id: z.string().describe('Workspace ID') },
    async ({ workspace_id }, extra: { sessionId?: string }) => {
      // requireFullScopeCaller alone only proves "some live, full-scope
      // Agent called this" — it never checked that the caller BELONGS to
      // the workspace being cascade-deleted, so a full-scope key bound to
      // workspace A could delete workspace B (ticket d6b56237 review round 2).
      const gateError = await requireWorkspaceScopedFullAccess(
        dataSource, getCallerAgent(extra), normalizeAgentWorkspaceId(workspace_id),
      );
      if (gateError) return err(gateError);

      const wsRepo = dataSource.getRepository(Workspace);
      const ws = await wsRepo.findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      const count = await wsRepo.count();
      if (count <= 1) return err('Cannot delete the last workspace');

      await deleteWorkspaceContent(dataSource, ws.id);
      await wsRepo.delete(ws.id);
      return ok({ success: true });
    }
  );
}
