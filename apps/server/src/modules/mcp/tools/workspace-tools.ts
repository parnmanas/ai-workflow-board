/**
 * Workspace CRUD MCP tools.
 *
 * Tools: list_workspaces, get_workspace, create_workspace,
 *        update_workspace, delete_workspace
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Workspace } from '../../../entities/Workspace';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { WorkspaceRole } from '../../../entities/WorkspaceRole';
import { DEFAULT_COLUMNS, BUILTIN_ROLES } from '../../../db';
import { ok, err } from '../shared/helpers';
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
          const ticketCount = await dataSource.getRepository(Ticket).count({ where: { column_id: col.id } });
          return { id: col.id, name: col.name, position: col.position, color: col.color, ticket_count: ticketCount };
        }));
        return { ...board, columns: colsSummary };
      }));

      return ok({ ...ws, boards: boardsSummary });
    }
  );

  server.tool(
    'create_workspace',
    'Create a new workspace with a default board and columns (Backlog, To Do, In Progress, Review, Done)',
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
      }));

      const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
      await colRepo.save(defaultCols.map(c => colRepo.create(c)));

      // v0.34: seed built-in role preset (assignee/reporter/reviewer).
      const roleRepo = dataSource.getRepository(WorkspaceRole);
      await roleRepo.save(BUILTIN_ROLES.map(def => roleRepo.create({
        workspace_id: ws.id,
        slug: def.slug,
        name: def.name,
        role_prompt: '',
        description: def.description,
        position: def.position,
        is_builtin: true,
      })));

      const result = await wsRepo.findOne({ where: { id: ws.id } });
      return ok(result);
    }
  );

  server.tool(
    'update_workspace',
    'Update a workspace name or description',
    {
      workspace_id: z.string().describe('Workspace ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
    },
    async ({ workspace_id, name, description }) => {
      const wsRepo = dataSource.getRepository(Workspace);
      const ws = await wsRepo.findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      if (name !== undefined) ws.name = name;
      if (description !== undefined) ws.description = description;

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
