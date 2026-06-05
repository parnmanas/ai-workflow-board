/**
 * Board MCP tools.
 *
 * Tools: list_boards, get_board, get_board_summary, create_board, update_board
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
    'Update a board name, description, routing_config, column→prompt-template mapping, or auto-archive policy',
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
    },
    async ({ board_id, name, description, routing_config, column_prompts, auto_archive_days }) => {
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
