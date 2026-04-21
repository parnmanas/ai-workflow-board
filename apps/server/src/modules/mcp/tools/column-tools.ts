/**
 * Column MCP tools.
 *
 * Tools: create_column, update_column, delete_column
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BoardColumn } from '../../../entities/BoardColumn';
import { ok, err } from '../shared/helpers';
import type { ToolContext } from './context';

export function registerColumnTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

  server.tool(
    'create_column',
    'Add a new column to a board',
    {
      board_id: z.string().describe('Board ID'),
      name: z.string().describe('Column name'),
      color: z.string().optional().default('#e2e8f0').describe('Column color (hex)'),
    },
    async ({ board_id, name, color }) => {
      const repo = dataSource.getRepository(BoardColumn);
      const maxResult = await repo
        .createQueryBuilder('col')
        .select('COALESCE(MAX(col.position), -1)', 'max')
        .where('col.board_id = :boardId', { boardId: board_id })
        .getRawOne();
      const position = (maxResult?.max ?? -1) + 1;
      const column = await repo.save(repo.create({ board_id, name, position, color }));
      return ok(column);
    }
  );

  server.tool(
    'update_column',
    'Update a column name, color, description, position, or terminal flag',
    {
      column_id: z.string().describe('Column ID'),
      name: z.string().optional().describe('New column name'),
      color: z.string().optional().describe('New column color (hex)'),
      description: z.string().optional().describe('New column description'),
      position: z.number().optional().describe('New position index'),
      is_terminal: z.boolean().optional()
        .describe('Whether tickets in this column are considered workflow end-state (excluded from agent allocation polling). Typically true for Done-style columns.'),
    },
    async ({ column_id, name, color, description, position, is_terminal }) => {
      const repo = dataSource.getRepository(BoardColumn);
      const col = await repo.findOne({ where: { id: column_id } });
      if (!col) return err('Column not found');

      if (name !== undefined) col.name = name;
      if (color !== undefined) col.color = color;
      if (description !== undefined) col.description = description;
      if (is_terminal !== undefined) col.is_terminal = !!is_terminal;
      await repo.save(col);

      if (position !== undefined) {
        const cols = await repo.find({ where: { board_id: col.board_id }, order: { position: 'ASC' } });
        const ids = cols.map(c => c.id).filter(id => id !== col.id);
        ids.splice(position, 0, col.id);
        await Promise.all(ids.map((id, idx) => repo.update(id, { position: idx })));
      }

      const updated = await repo.findOne({ where: { id: col.id } });
      return ok(updated);
    }
  );

  server.tool(
    'delete_column',
    'Delete a column (and all tickets in it)',
    { column_id: z.string().describe('Column ID') },
    async ({ column_id }) => {
      const result = await dataSource.getRepository(BoardColumn).delete(column_id);
      if (result.affected === 0) return err('Column not found');
      return ok({ success: true });
    }
  );
}
