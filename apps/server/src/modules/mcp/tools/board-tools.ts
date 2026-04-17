/**
 * Board MCP tools.
 *
 * Tools: list_boards, get_board, get_board_summary, create_board, update_board
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Workspace } from '../../../entities/Workspace';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { DEFAULT_COLUMNS } from '../../../db';
import { ok, err, safeJsonParse } from '../shared/helpers';
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
    'Get a board with all columns, tickets (with children and comments)',
    { board_id: z.string().describe('Board ID') },
    async ({ board_id }) => {
      const board = await dataSource.getRepository(Board).findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      const columns = await dataSource.getRepository(BoardColumn).find({
        where: { board_id: board.id },
        order: { position: 'ASC' },
      });

      const ticketRepo = dataSource.getRepository(Ticket);
      const columnsWithTickets = await Promise.all(
        columns.map(async (col) => {
          const tickets = await ticketRepo.find({
            where: { column_id: col.id },
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
    'Get a compact LLM-friendly board summary with column names, ticket counts, and per-ticket overview',
    { board_id: z.string().optional().describe('Board ID') },
    async ({ board_id }) => {
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
            where: columnIds.map(cid => ({ column_id: cid })),
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
    'Create a new board with default columns (Backlog, To Do, In Progress, Review, Done) inside a workspace',
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

      const board = await boardRepo.save(boardRepo.create({ name, description, workspace_id }));
      const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
      await colRepo.save(defaultCols.map(c => colRepo.create(c)));

      const result = await boardRepo.findOne({ where: { id: board.id } });
      return ok(result);
    }
  );

  server.tool(
    'update_board',
    'Update a board name, description, or column→prompt-template mapping',
    {
      board_id: z.string().describe('Board ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      column_prompts: z.record(z.string(), z.string().nullable()).nullable().optional()
        .describe('Column→PromptTemplate mapping: { [column_id]: prompt_template_id }. Pass null or {} to clear all.'),
    },
    async ({ board_id, name, description, column_prompts }) => {
      const boardRepo = dataSource.getRepository(Board);
      const board = await boardRepo.findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      if (name !== undefined) board.name = name;
      if (description !== undefined) board.description = description;
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

      await boardRepo.save(board);
      return ok(board);
    }
  );
}
