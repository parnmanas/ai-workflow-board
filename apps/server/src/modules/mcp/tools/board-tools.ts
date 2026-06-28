/**
 * Board MCP tools.
 *
 * Tools: list_boards, get_board, get_board_summary, create_board, update_board,
 *        delete_board, move_board_to_workspace
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IsNull } from 'typeorm';
import { z } from 'zod';
import { Workspace } from '../../../entities/Workspace';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { DEFAULT_COLUMNS, DEFAULT_BOARD_ROUTING } from '../../../db';
import { DEFAULT_PROMPT_TEMPLATES } from '../../../database/default-prompt-templates';
import { PromptTemplate } from '../../../entities/PromptTemplate';
import { ok, err, safeJsonParse } from '../shared/helpers';
import { HarnessConfigSchema, serializeHarnessConfig } from '../../../common/harness-config';
import { EffortPresetsConfigSchema, validateEffortPresetsInput, serializeEffortPresets } from '../../../common/effort-presets';
import { EnvironmentConfigSchema, validateEnvironmentConfigInput, serializeEnvironmentConfig } from '../../../common/environment-config';
import { LivenessPolicySchema, serializeLivenessPolicy } from '../../qa/qa-liveness-policy';
import { QaPhasesSchema, serializeQaPhases } from '../../qa/qa-phases';
import { writeRoutingConfigThrough } from '../../boards/routing-config.helper';
import { getCallerAgent } from '../shared/session-auth';
import { WorkspaceMoveService, WorkspaceMoveBlockedError } from '../../../services/workspace-move.service';
import type { ToolContext } from './context';

export function registerBoardTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

  server.tool(
    'list_boards',
    'List all boards. Optionally filter by workspace_id.',
    {
      workspace_id: z.string().optional().describe('Filter by workspace ID'),
    },
    async ({ workspace_id }) => {
      const where: any = {};
      if (workspace_id) where.workspace_id = workspace_id;
      const boards = await dataSource.getRepository(Board).find({ where, order: { created_at: 'DESC' } });
      return ok(boards);
    }
  );

  server.tool(
    'get_board',
    'Get a board with all columns, tickets (with children and comments). Archived tickets are excluded by default — pass include_archived=true to surface them.',
    {
      board_id: z.string().describe('Board ID'),
      include_archived: z.boolean().optional().default(false).describe('Include archived tickets (archived_at IS NOT NULL). Default false matches REST /api/boards/:id.'),
    },
    async ({ board_id, include_archived }) => {
      const board = await dataSource.getRepository(Board).findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      const columns = await dataSource.getRepository(BoardColumn).find({
        where: { board_id: board.id },
        order: { position: 'ASC' },
      });

      const ticketRepo = dataSource.getRepository(Ticket);
      const columnsWithTickets = await Promise.all(
        columns.map(async (col) => {
          const whereTickets: any = { column_id: col.id };
          if (!include_archived) whereTickets.archived_at = IsNull();
          const tickets = await ticketRepo.find({
            where: whereTickets,
            relations: ['children', 'children.children', 'comments'],
            order: { position: 'ASC' },
          });
          return {
            ...col,
            tickets: tickets.map(t => ({
              ...t,
              labels: safeJsonParse(t.labels),
              channel_ids: safeJsonParse(t.channel_ids),
              children: (t.children || []).sort((a, b) => a.position - b.position).map(child => ({
                ...child,
                labels: safeJsonParse(child.labels),
                channel_ids: safeJsonParse(child.channel_ids),
                children: (child.children || []).sort((a, b) => a.position - b.position).map(gc => ({
                  ...gc,
                  labels: safeJsonParse(gc.labels),
                  channel_ids: safeJsonParse(gc.channel_ids),
                  children: [],
                })),
              })),
              comments: (t.comments || []).sort((a, b) =>
                new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
              ),
            })),
          };
        })
      );

      return ok({ ...board, columns: columnsWithTickets });
    }
  );

  server.tool(
    'get_board_summary',
    'Get a compact LLM-friendly board summary with column names, ticket counts, and per-ticket overview. Archived tickets are excluded by default — pass include_archived=true to surface them.',
    {
      board_id: z.string().optional().describe('Board ID'),
      include_archived: z.boolean().optional().default(false).describe('Include archived tickets (archived_at IS NOT NULL). Default false matches the rest of the active-ticket surface.'),
    },
    async ({ board_id, include_archived }) => {
      const board = await dataSource.getRepository(Board).findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      const columns = await dataSource.getRepository(BoardColumn).find({
        where: { board_id: board.id },
        order: { position: 'ASC' },
      });

      // Single query: load all tickets for all columns with children
      const columnIds = columns.map(c => c.id);
      const allTickets = columnIds.length > 0
        ? await dataSource.getRepository(Ticket).find({
            where: columnIds.map(cid => include_archived
              ? { column_id: cid }
              : { column_id: cid, archived_at: IsNull() }),
            relations: ['children'],
            order: { position: 'ASC' },
          })
        : [];

      // Group tickets by column
      const ticketsByColumn = new Map<string, typeof allTickets>();
      for (const t of allTickets) {
        const list = ticketsByColumn.get(t.column_id) || [];
        list.push(t);
        ticketsByColumn.set(t.column_id, list);
      }

      const summary = {
        board: board.name,
        description: board.description,
        columns: columns.map(col => {
          const tickets = ticketsByColumn.get(col.id) || [];
          return {
            name: col.name,
            ticketCount: tickets.length,
            tickets: tickets.map(t => {
              const children = t.children || [];
              const done = children.filter(c => c.status === 'done').length;
              return {
                id: t.id,
                title: t.title,
                priority: t.priority,
                assignee: t.assignee || 'unassigned',
                subtasks: `${done}/${children.length} done`,
              };
            }),
          };
        }),
      };

      return ok(summary);
    }
  );

  server.tool(
    'create_board',
    'Create a new board with default columns (Backlog, To Do, Plan, In Progress, Review, Merging, Done) and the planner→assignee→reviewer routing preset, inside a workspace',
    {
      workspace_id: z.string().describe('Workspace ID'),
      name: z.string().describe('Board name'),
      description: z.string().optional().default('').describe('Board description'),
    },
    async ({ workspace_id, name, description }) => {
      const ws = await dataSource.getRepository(Workspace).findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      const boardRepo = dataSource.getRepository(Board);
      const colRepo = dataSource.getRepository(BoardColumn);

      const board = await boardRepo.save(boardRepo.create({
        name, description, workspace_id,
        routing_config: JSON.stringify(DEFAULT_BOARD_ROUTING),
      }));
      const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
      const savedCols = await colRepo.save(defaultCols.map(c => colRepo.create(c)));
      // v0.41 — write routing_config through to per-column role_routing.
      await writeRoutingConfigThrough(dataSource, board.id);

      // Idempotently seed default workflow templates into the workspace
      // (existing rows by name are left alone) and auto-link each new
      // column to its matching template via Board.column_prompts.
      const tplRepo = dataSource.getRepository(PromptTemplate);
      const existing = await tplRepo.find({ where: { workspace_id } });
      const existingByName = new Map(existing.map(t => [t.name, t]));
      const inserted: PromptTemplate[] = [];
      for (const def of DEFAULT_PROMPT_TEMPLATES) {
        if (existingByName.has(def.name)) continue;
        inserted.push(await tplRepo.save(tplRepo.create({
          workspace_id,
          name: def.name,
          description: def.description,
          content: def.content,
          category: def.category,
        })));
      }
      const tplIdByName = new Map([
        ...existing.map(t => [t.name, t.id] as const),
        ...inserted.map(t => [t.name, t.id] as const),
      ]);
      const colPrompts: Record<string, string> = {};
      for (const col of savedCols) {
        // SEED-ONLY name match (workspace/board creation). Runtime dispatch
        // never reads column names — see ticket 47a90ea3 AC #3. TODO:
        // migrate `column_match` to a `kind_match` enum so the last seed
        // hardcode goes away.
        const def = DEFAULT_PROMPT_TEMPLATES.find(d => d.column_match === col.name.toLowerCase());
        if (!def) continue;
        const tplId = tplIdByName.get(def.name);
        if (tplId) colPrompts[col.id] = tplId;
      }
      if (Object.keys(colPrompts).length > 0) {
        await boardRepo.update({ id: board.id }, { column_prompts: JSON.stringify(colPrompts) });
      }

      const result = await boardRepo.findOne({ where: { id: board.id } });
      return ok(result);
    }
  );

  server.tool(
    'update_board',
    'Update a board name, description, routing_config, column→prompt-template mapping, auto-archive policy, agent harness override, or output language',
    {
      board_id: z.string().describe('Board ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      routing_config: z.record(z.string(), z.array(z.string())).nullable().optional()
        .describe('Column→role routing: { [lowercased column name]: ["assignee"|"reviewer"|"reporter", ...] }. Pass null or {} to clear all.'),
      column_prompts: z.record(z.string(), z.string().nullable()).nullable().optional()
        .describe('Column→PromptTemplate mapping: { [column_id]: prompt_template_id }. Pass null or {} to clear all.'),
      auto_archive_days: z.number().int().min(1).max(365).nullable().optional()
        .describe('Auto-archive policy: null disables, 1..365 archives Done-column tickets older than N days. The TicketArchiverService background job consumes this setting; changes take effect on the next archiver tick (no restart needed).'),
      harness_config: HarnessConfigSchema.nullable().optional()
        .describe('Per-board agent harness override: { system_prompt_append?, allowed_tools?, disallowed_tools?, model?, permission_mode? }. Keys set here override the workspace default per key at dispatch; unset keys inherit. Pass null to clear the board override.'),
      effort_presets: EffortPresetsConfigSchema.nullable().optional()
        .describe('Per-board abstract effort preset catalog: { default: <preset id>, presets: [{ id, label, claude?: { effort?, ultracode?, model? }, codex?: { model? }, antigravity?: { model? } }] }. A ticket carries an abstract preset id (effort_preset); dispatch resolves it against this catalog and agent-manager maps the matched preset onto per-CLI options. Pass null to clear (board falls back to the built-in catalog).'),
      language: z.string().nullable().optional()
        .describe('Per-board output language: a human-readable language name (e.g. "Korean", "English", "日本語"). Agents dispatched on this board write comments, chat, commit messages, and code comments in this language. Empty string or null clears the override (agents fall back to their default, English).'),
      environment_config: EnvironmentConfigSchema.nullable().optional()
        .describe('Per-board environment setup: { repositories?: [{ resource_id? | url?, target_dir?, branch?, post_clone_commands?: [] }], env_vars?: { KEY: value }, setup_commands?: [], setup_timeout_seconds?, version? }. When set, agent-manager provisions the working environment (clone/update repos under the agent home, run setup commands, inject non-secret env_vars) once per (agent,board) before the first dispatch, re-running only when the config fingerprint changes. Keys set here override the workspace default per top-level key. Pass null to clear the board override.'),
      paused: z.boolean().optional()
        .describe('Board-wide soft pause. true sets paused_at=now — every agent_trigger for tickets on this board is dropped (TriggerLoopService gate) and backlog promotion short-circuits; humans can still read/comment/drag. false clears paused_at to resume dispatch. Mirrors REST POST /api/boards/:id/pause|resume so the awb-mcp agent driver can engage the gate. Omit to leave the pause state untouched.'),
      liveness_policy: LivenessPolicySchema.nullable().optional()
        .describe('Per-board QaRun liveness policy for the reaper: { "type": "zero_progress", "deadline_sec"?: N } (default — reap when a run\'s age exceeds the deadline, defaulting to the global QA_RUN_TTL_MS) or { "type": "heartbeat_deadline", "deadline_sec": N } (reap only when the run\'s monotonic qa_run_heartbeat token has not strictly advanced within N seconds). Scenario-level liveness_policy overrides this. Pass null to clear (board falls back to the zero_progress default — the pre-existing behavior).'),
      qa_phases: QaPhasesSchema.nullable().optional()
        .describe('Per-board QA multi-phase model: { "phases": [ { "id": "import", "label"?: "Import", "timeout_sec": 600 }, { "id": "build", "timeout_sec": 1800 } ] }. Array order = phase order; ids unique; timeout_sec a positive integer. When set (and no explicit liveness_policy overrides it) the reaper auto-selects the phase_timeouts detector so each phase is judged against its own timeout_sec from when the run entered it (set_qa_phase). A scenario-level qa_phases overrides this. Pass null to clear (board falls back to legacy single-running behavior).'),
    },
    async ({ board_id, name, description, routing_config, column_prompts, auto_archive_days, harness_config, effort_presets, language, environment_config, paused, liveness_policy, qa_phases }) => {
      const boardRepo = dataSource.getRepository(Board);
      const board = await boardRepo.findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      if (name !== undefined) board.name = name;
      if (description !== undefined) board.description = description;
      const routingChanged = routing_config !== undefined;
      if (routingChanged) {
        if (routing_config === null) {
          board.routing_config = '{}';
        } else {
          board.routing_config = JSON.stringify(routing_config);
        }
      }
      if (column_prompts !== undefined) {
        if (column_prompts === null) {
          board.column_prompts = null;
        } else {
          // Drop null mappings so stored shape stays { [col]: templateId } without nullables
          const cleaned: Record<string, string> = {};
          for (const [colId, tplId] of Object.entries(column_prompts)) {
            if (tplId) cleaned[colId] = tplId;
          }
          board.column_prompts = Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned);
        }
      }
      if (auto_archive_days !== undefined) {
        board.auto_archive_days = auto_archive_days;
      }
      // Board output language (i18n, ticket ae28dcaf). Empty/whitespace → null
      // so the override clears back to the agent default (English).
      if (language !== undefined) {
        const trimmed = language == null ? null : String(language).trim();
        board.language = trimmed ? trimmed : null;
      }
      // Board-wide soft pause (mirrors REST /pause|/resume). true stamps
      // paused_at=now so the TriggerLoopService gate drops every emission;
      // false clears it back to null. Idempotent on repeat-true (refreshes
      // the timestamp) just like the REST endpoint.
      if (paused !== undefined) {
        board.paused_at = paused ? new Date() : null;
      }
      // Harness override (ticket 7122600c). Args already passed the strict
      // HarnessConfigSchema, so storage is a straight serialize; empty
      // objects collapse to null (same null = "no override" contract as
      // column_prompts).
      if (harness_config !== undefined) {
        board.harness_config = serializeHarnessConfig(harness_config);
      }
      // Effort preset catalog (abstract ticket effort option). null clears
      // (board falls back to the built-in catalog). Args already passed the
      // EffortPresetsConfigSchema; re-run validateEffortPresetsInput for the
      // cross-field default-matches-an-id / unique-id invariant the schema
      // alone can't express, then serialize (empty / equal-to-builtin → null).
      if (effort_presets !== undefined) {
        if (effort_presets === null) {
          board.effort_presets = null;
        } else {
          const checked = validateEffortPresetsInput(effort_presets);
          if (!checked.ok) return err(checked.error);
          board.effort_presets = serializeEffortPresets(checked.value);
        }
      }
      // Environment setup override (ticket 354d336b). null clears the board
      // override (workspace default, if any, then applies). Args already passed
      // the strict EnvironmentConfigSchema; re-run the validator for the
      // cross-field repository invariant (each repo needs a resource_id or url)
      // then serialize (empty configs collapse to null).
      if (environment_config !== undefined) {
        if (environment_config === null) {
          board.environment_config = null;
        } else {
          const checked = validateEnvironmentConfigInput(environment_config);
          if (!checked.ok) return err(checked.error);
          board.environment_config = serializeEnvironmentConfig(checked.value);
        }
      }
      // QaRun liveness policy (ticket 40010b25). Args already passed the strict
      // LivenessPolicySchema, so storage is a straight serialize; null clears the
      // override back to the built-in zero_progress default.
      if (liveness_policy !== undefined) {
        board.liveness_policy = serializeLivenessPolicy(liveness_policy);
      }
      // QA multi-phase model (ticket 90cc22f7 / 38192044). Args already passed the
      // strict QaPhasesSchema, so storage is a straight serialize; null clears the
      // model back to legacy single-running behavior.
      if (qa_phases !== undefined) {
        board.qa_phases = serializeQaPhases(qa_phases);
      }

      await boardRepo.save(board);
      // v0.41 — fan routing_config edits through to per-column role_routing
      // so the runtime trigger / allocation paths read slugs straight off the
      // BoardColumn rows. See routing-config.helper for the contract.
      if (routingChanged) {
        await writeRoutingConfigThrough(dataSource, board.id);
      }
      return ok(board);
    }
  );

  server.tool(
    'delete_board',
    'Delete a board and all its columns, tickets (with subtasks) and comments. The delete cascades ' +
    'through the column → ticket → child-ticket / comment FK chain (same behaviour as DELETE /api/boards/:id). ' +
    'Unlike delete_workspace there is no "cannot delete the last board" guard — a workspace is allowed to hold ' +
    'zero boards. Irreversible: there is no archive/restore here (use update_board / the Archive page for soft ' +
    'archival instead).',
    { board_id: z.string().describe('Board ID to delete') },
    async ({ board_id }) => {
      const boardRepo = dataSource.getRepository(Board);
      const board = await boardRepo.findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      await boardRepo.delete(board.id);
      return ok({ success: true });
    }
  );

  server.tool(
    'move_board_to_workspace',
    'Move a board (with all its columns + tickets) to a DIFFERENT workspace, carrying its workspace-scoped ' +
    'dependencies along. A workspace is a scope boundary, so this hard re-stamps workspace_id on the board, every ' +
    'column and every ticket (roots + subtasks), remaps each ticket role assignment to the destination ' +
    'workspace\'s same-slug role (creating the role there if missing), and copies referenced prompt templates / ' +
    'ws-level actions / resources / channels into the destination by name if absent (non-destructive). ' +
    'ALWAYS dry-run first (dry_run=true, the default) to see exactly what will move / copy / remap and what blocks ' +
    'the move — then re-call with dry_run=false to commit atomically (single transaction, all-or-nothing). ' +
    'Companion agents (those holding roles on the board\'s tickets) are reported; pass carry_agents=true to move ' +
    'them too, which is refused for any agent that also holds roles on tickets outside this board (pass that agent\'s ' +
    'id in exclude_agent_ids to move the board without it). The dry-run report\'s `blockers` are STRUCTURED objects ' +
    '({ code, message, agent_id?, ticket_ids?, remedies[] }) — `message` is the human-readable reason; `remedies` ' +
    'lists the actions that clear each blocker. Admin-gated.',
    {
      board_id: z.string().describe('Board ID to move'),
      target_workspace_id: z.string().describe('Destination workspace ID'),
      dry_run: z.boolean().optional().default(true)
        .describe('true (default) returns the preview report without writing; false commits the move atomically'),
      carry_agents: z.boolean().optional().default(false)
        .describe('Also move companion agents (workspace_id + api keys + credential) when they hold no roles outside this board'),
      exclude_agent_ids: z.array(z.string()).optional()
        .describe('Companion agent ids to EXCLUDE from the carry even when carry_agents=true — the board moves without them (write-free way to clear a companion_agent_outside_roles blocker)'),
    },
    async ({ board_id, target_workspace_id, dry_run, carry_agents, exclude_agent_ids }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const mover = new WorkspaceMoveService(dataSource as any, ctx.activityService);
      const opts = { carry_agents, exclude_agent_ids, actor_id: caller?.agentId, actor_name: caller?.agentName };
      try {
        const report = dry_run
          ? await mover.previewBoardMove(board_id, target_workspace_id, opts)
          : await mover.commitBoardMove(board_id, target_workspace_id, opts);
        return ok(report);
      } catch (e: any) {
        if (e instanceof WorkspaceMoveBlockedError) return err(`Move blocked: ${e.messages.join('; ')}`);
        return err(e?.message || 'Cross-workspace move failed');
      }
    }
  );
}
