/**
 * Workspace CRUD MCP tools.
 *
 * Tools: list_workspaces, get_workspace, create_workspace,
 *        update_workspace, delete_workspace
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IsNull } from 'typeorm';
import { z } from 'zod';
import { Workspace } from '../../../entities/Workspace';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { WorkspaceRole } from '../../../entities/WorkspaceRole';
import { DEFAULT_COLUMNS, BUILTIN_ROLES, DEFAULT_BOARD_ROUTING } from '../../../db';
import { DEFAULT_PROMPT_TEMPLATES } from '../../../database/default-prompt-templates';
import { PromptTemplate } from '../../../entities/PromptTemplate';
import { ok, err } from '../shared/helpers';
import { HarnessConfigSchema, serializeHarnessConfig } from '../../../common/harness-config';
import { EnvironmentConfigSchema, validateEnvironmentConfigInput, serializeEnvironmentConfig } from '../../../common/environment-config';
import { writeRoutingConfigThrough } from '../../boards/routing-config.helper';
import type { ToolContext } from './context';

export function registerWorkspaceTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

  server.tool(
    'list_workspaces',
    'List all workspaces',
    {},
    async () => {
      const workspaces = await dataSource.getRepository(Workspace).find({ order: { created_at: 'DESC' } });
      const result = await Promise.all(workspaces.map(async ws => {
        const boardCount = await dataSource.getRepository(Board).count({ where: { workspace_id: ws.id } });
        return { ...ws, board_count: boardCount };
      }));
      return ok(result);
    }
  );

  server.tool(
    'get_workspace',
    'Get a workspace with its boards, columns, and ticket counts',
    { workspace_id: z.string().describe('Workspace ID') },
    async ({ workspace_id }) => {
      const ws = await dataSource.getRepository(Workspace).findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      const boards = await dataSource.getRepository(Board).find({
        where: { workspace_id },
        order: { created_at: 'ASC' },
      });

      const boardsSummary = await Promise.all(boards.map(async board => {
        const columns = await dataSource.getRepository(BoardColumn).find({
          where: { board_id: board.id },
          order: { position: 'ASC' },
        });
        const colsSummary = await Promise.all(columns.map(async col => {
          // Archive exclusion (ticket 9b44526b): mirror get_board / get_board_summary
          // — archived tickets are not part of the active workspace surface and
          // should not inflate the column ticket_count default callers see.
          const ticketCount = await dataSource.getRepository(Ticket).count({
            where: { column_id: col.id, archived_at: IsNull() },
          });
          return { id: col.id, name: col.name, position: col.position, color: col.color, ticket_count: ticketCount };
        }));
        return { ...board, columns: colsSummary };
      }));

      return ok({ ...ws, boards: boardsSummary });
    }
  );

  server.tool(
    'create_workspace',
    'Create a new workspace with a default board, columns (Backlog, To Do, Plan, In Progress, Review, Merging, Done) and the planner→assignee→reviewer routing preset',
    {
      name: z.string().describe('Workspace name'),
      description: z.string().optional().default('').describe('Workspace description'),
    },
    async ({ name, description }) => {
      const wsRepo = dataSource.getRepository(Workspace);
      const boardRepo = dataSource.getRepository(Board);
      const colRepo = dataSource.getRepository(BoardColumn);

      const ws = await wsRepo.save(wsRepo.create({ name, description }));
      const board = await boardRepo.save(boardRepo.create({
        workspace_id: ws.id,
        name: `${name} Board`,
        description: '',
        routing_config: JSON.stringify(DEFAULT_BOARD_ROUTING),
      }));

      const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
      const savedCols = await colRepo.save(defaultCols.map(c => colRepo.create(c)));
      // v0.41 — fan board.routing_config into per-column role_routing.
      await writeRoutingConfigThrough(dataSource, board.id);

      // v0.34: seed built-in role preset (planner/assignee/reporter/reviewer).
      const roleRepo = dataSource.getRepository(WorkspaceRole);
      await roleRepo.save(BUILTIN_ROLES.map(def => roleRepo.create({
        workspace_id: ws.id,
        slug: def.slug,
        name: def.name,
        role_prompt: def.role_prompt,
        description: def.description,
        position: def.position,
        is_builtin: true,
      })));

      // Default workflow prompt templates + auto-link to columns by name.
      // Same registry feeds the REST + first-run + MCP paths so all three
      // produce identical output for a fresh workspace.
      const tplRepo = dataSource.getRepository(PromptTemplate);
      const seededTemplates = await tplRepo.save(DEFAULT_PROMPT_TEMPLATES.map(def =>
        tplRepo.create({
          workspace_id: ws.id,
          name: def.name,
          description: def.description,
          content: def.content,
          category: def.category,
        })));
      const tplIdByName = new Map(seededTemplates.map(t => [t.name, t.id]));
      const colPrompts: Record<string, string> = {};
      for (const col of savedCols) {
        // SEED-ONLY name match (create_workspace MCP path). Runtime
        // dispatch never reads column names — see ticket 47a90ea3 AC #3.
        // TODO: migrate `column_match` to a `kind_match` enum so the
        // last seed hardcode goes away.
        const def = DEFAULT_PROMPT_TEMPLATES.find(d => d.column_match === col.name.toLowerCase());
        if (!def) continue;
        const tplId = tplIdByName.get(def.name);
        if (tplId) colPrompts[col.id] = tplId;
      }
      if (Object.keys(colPrompts).length > 0) {
        await boardRepo.update({ id: board.id }, { column_prompts: JSON.stringify(colPrompts) });
      }

      const result = await wsRepo.findOne({ where: { id: ws.id } });
      return ok(result);
    }
  );

  server.tool(
    'update_workspace',
    'Update a workspace name, description, trigger-loop cadence settings (supervisor_stale_ms / supervisor_resend_ms / dispatch_queue_depth), claim-verification settings (claim_verification_enabled / claim_verification_grace_ms), or the default agent harness (harness_config)',
    {
      workspace_id: z.string().describe('Workspace ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      supervisor_stale_ms: z.number().positive().optional()
        .describe('Time-since-last-update before TicketSupervisor considers an allocation stale. Default 1800000 (30 min).'),
      supervisor_resend_ms: z.number().positive().optional()
        .describe('Cooldown between supervisor force-respawn re-pushes. Default 300000 (5 min).'),
      dispatch_queue_depth: z.number().positive().optional()
        .describe('Per-agent dispatch queue depth cap. When full, the lowest-priority pending item is dropped. Default 100.'),
      claim_verification_enabled: z.boolean().optional()
        .describe('Enable the claim-verification sweep (ticket dcb9d661): when an assignee comments in an active column without committing or moving the ticket within the grace window, auto-park it for human review. Default false.'),
      claim_verification_grace_ms: z.number().positive().optional()
        .describe('Grace window in ms before the claim-verification sweep auto-pends an idle assignee claim. Default 600000 (10 min).'),
      harness_config: HarnessConfigSchema.nullable().optional()
        .describe('Workspace-wide default agent harness: { system_prompt_append?, allowed_tools?, disallowed_tools?, model?, permission_mode? }. Boards override it per key via their own harness_config. Pass null to clear.'),
      environment_config: EnvironmentConfigSchema.nullable().optional()
        .describe('Workspace-wide default environment setup: { repositories?, env_vars?, setup_commands?, setup_timeout_seconds?, version? }. Boards override it per top-level key via their own environment_config. Pass null to clear.'),
    },
    async ({ workspace_id, name, description, supervisor_stale_ms, supervisor_resend_ms, dispatch_queue_depth, claim_verification_enabled, claim_verification_grace_ms, harness_config, environment_config }) => {
      const wsRepo = dataSource.getRepository(Workspace);
      const ws = await wsRepo.findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      if (name !== undefined) ws.name = name;
      if (description !== undefined) ws.description = description;
      // v0.41 — cadence settings (AC #4). Zod's `.positive()` already
      // gates non-positive / non-finite input, so a successful args
      // parse means we can floor and assign without re-validating.
      if (supervisor_stale_ms !== undefined) ws.supervisor_stale_ms = Math.floor(supervisor_stale_ms);
      if (supervisor_resend_ms !== undefined) ws.supervisor_resend_ms = Math.floor(supervisor_resend_ms);
      if (dispatch_queue_depth !== undefined) ws.dispatch_queue_depth = Math.floor(dispatch_queue_depth);
      if (claim_verification_enabled !== undefined) ws.claim_verification_enabled = claim_verification_enabled ? 1 : 0;
      if (claim_verification_grace_ms !== undefined) ws.claim_verification_grace_ms = Math.floor(claim_verification_grace_ms);
      // Default harness (ticket 7122600c) — strict-validated by the arg
      // schema; empty objects collapse to null via the serializer.
      if (harness_config !== undefined) ws.harness_config = serializeHarnessConfig(harness_config);
      // Default environment setup (ticket 354d336b) — strict-validated by the
      // arg schema; re-run the validator for the cross-field repository
      // invariant, then serialize (empty configs collapse to null).
      if (environment_config !== undefined) {
        if (environment_config === null) {
          ws.environment_config = null;
        } else {
          const checked = validateEnvironmentConfigInput(environment_config);
          if (!checked.ok) return err(checked.error);
          ws.environment_config = serializeEnvironmentConfig(checked.value);
        }
      }

      await wsRepo.save(ws);
      return ok(ws);
    }
  );

  server.tool(
    'delete_workspace',
    'Delete a workspace and all its boards, columns, tickets (cannot delete the last workspace)',
    { workspace_id: z.string().describe('Workspace ID') },
    async ({ workspace_id }) => {
      const wsRepo = dataSource.getRepository(Workspace);
      const ws = await wsRepo.findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      const count = await wsRepo.count();
      if (count <= 1) return err('Cannot delete the last workspace');

      await wsRepo.delete(ws.id);
      return ok({ success: true });
    }
  );
}
