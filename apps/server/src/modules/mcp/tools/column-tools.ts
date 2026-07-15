/**
 * Column MCP tools.
 *
 * Tools: create_column, update_column, delete_column
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { computeRoleRoutingForNewColumn } from '../../boards/routing-config.helper';
import { ok, err } from '../shared/helpers';
import type { ToolContext } from './context';

// Workflow kinds the runtime dispatch path keys off of (BoardColumn.kind).
// Empty-string is allowed and treated as 'active' at runtime — it's the
// back-compat default for columns that predate v0.41.
const COLUMN_KIND_VALUES = ['', 'intake', 'active', 'review', 'merging', 'terminal'] as const;
const UNASSIGNED_POLICY_VALUES = ['halt', 'skip', 'skip_if_ticket_staffed'] as const;

export function registerColumnTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

  server.tool(
    'create_column',
    'Add a new column to a board',
    {
      board_id: z.string().describe('Board ID'),
      name: z.string().describe('Column name'),
      color: z.string().optional().default('#e2e8f0').describe('Column color (hex)'),
      kind: z.enum(COLUMN_KIND_VALUES).optional()
        .describe("Workflow kind used by runtime dispatch (intake|active|review|merging|terminal). Omit to default to '' (treated as 'active')."),
      role_routing: z.array(z.string()).optional()
        .describe("Role slugs to wake when a ticket lands on this column (e.g. ['assignee']). Omit to inherit from the parent board's routing_config under the (lowercased) column name."),
      is_terminal: z.boolean().optional()
        .describe('Whether tickets in this column are workflow end-state. Auto-syncs with `kind` (kind="terminal" implies is_terminal=true).'),
      unassigned_policy: z.enum(UNASSIGNED_POLICY_VALUES).optional().default('halt')
        .describe('When no routed role has a holder: halt, always skip, or skip only when the ticket has another holder'),
    },
    async ({ board_id, name, color, kind, role_routing, is_terminal, unassigned_policy }) => {
      const repo = dataSource.getRepository(BoardColumn);
      const maxResult = await repo
        .createQueryBuilder('col')
        .select('COALESCE(MAX(col.position), -1)', 'max')
        .where('col.board_id = :boardId', { boardId: board_id })
        .getRawOne();
      const position = (maxResult?.max ?? -1) + 1;

      // v0.41 — every runtime dispatch path reads BoardColumn.role_routing
      // (NOT Board.routing_config). A new column created without an explicit
      // role_routing arg still has to start with the slugs the operator
      // already configured under that column name on the parent board, or
      // it'll silently ignore routing for that column. Matches the
      // writeRoutingConfigThrough path used elsewhere.
      let roleRoutingJson: string;
      if (role_routing !== undefined) {
        roleRoutingJson = JSON.stringify(role_routing.filter(s => typeof s === 'string'));
      } else {
        const board = await dataSource.getRepository(Board).findOne({ where: { id: board_id } });
        roleRoutingJson = board ? computeRoleRoutingForNewColumn(board, name) : '[]';
      }

      // is_terminal / kind synchronization mirrors update_column: kind='terminal'
      // implies is_terminal=true; an unset kind on an is_terminal=true column
      // upgrades to 'terminal'. Otherwise default kind='' (legacy 'active').
      let resolvedKind: typeof COLUMN_KIND_VALUES[number] = (kind ?? '') as any;
      let resolvedTerminal = !!is_terminal;
      if (kind === 'terminal') {
        if (is_terminal === false) {
          return err("kind='terminal' requires is_terminal=true (or omit is_terminal to auto-sync)");
        }
        resolvedTerminal = true;
      } else if (resolvedTerminal && !resolvedKind) {
        resolvedKind = 'terminal';
      }

      const column = await repo.save(repo.create({
        board_id,
        name,
        position,
        color,
        kind: resolvedKind,
        role_routing: roleRoutingJson,
        is_terminal: resolvedTerminal,
        unassigned_policy,
      }));
      return ok(column);
    }
  );

  server.tool(
    'update_column',
    'Update a column name, color, description, position, terminal flag, or workflow kind',
    {
      column_id: z.string().describe('Column ID'),
      name: z.string().optional().describe('New column name'),
      color: z.string().optional().describe('New column color (hex)'),
      description: z.string().optional().describe('New column description'),
      position: z.number().optional().describe('New position index'),
      is_terminal: z.boolean().optional()
        .describe('Whether tickets in this column are considered workflow end-state (excluded from agent allocation polling). Typically true for Done-style columns. Auto-syncs with `kind` — flipping to true sets kind=terminal when kind was unset, flipping to false clears kind=terminal.'),
      kind: z.enum(COLUMN_KIND_VALUES).optional()
        .describe("Workflow kind used by runtime dispatch (intake|active|review|merging|terminal). Set to '' to clear / treat as legacy 'active'. Auto-syncs with `is_terminal` — kind='terminal' implies is_terminal=true."),
      role_routing: z.array(z.string()).optional()
        .describe('Role slugs to wake when a ticket lands on this column. Replaces the legacy lowercased-name lookup against Board.routing_config.'),
      unassigned_policy: z.enum(UNASSIGNED_POLICY_VALUES).optional()
        .describe('When no routed role has a holder: halt, always skip, or skip only when the ticket has another holder'),
    },
    async ({ column_id, name, color, description, position, is_terminal, kind, role_routing, unassigned_policy }) => {
      const repo = dataSource.getRepository(BoardColumn);
      const col = await repo.findOne({ where: { id: column_id } });
      if (!col) return err('Column not found');

      if (name !== undefined) col.name = name;
      if (color !== undefined) col.color = color;
      if (description !== undefined) col.description = description;
      if (unassigned_policy !== undefined) col.unassigned_policy = unassigned_policy;
      if (role_routing !== undefined) {
        // Storage shape is JSON-stringified array; mirrors the migration
        // backfill format and the writeRoutingConfigThrough helper.
        (col as any).role_routing = JSON.stringify(role_routing.filter(s => typeof s === 'string'));
      }

      // is_terminal / kind synchronization — the runtime dispatch path
      // treats "is_terminal === true OR kind === 'terminal'" as terminal,
      // so the two must not desync. If a caller passes only one of the
      // two, derive the other; if they pass both, honour the caller's
      // explicit pair as long as it's consistent.
      if (kind !== undefined && is_terminal !== undefined) {
        const terminalImpliedByKind = kind === 'terminal';
        if (terminalImpliedByKind && !is_terminal) {
          return err("kind='terminal' requires is_terminal=true (or omit is_terminal to auto-sync)");
        }
        col.kind = kind as any;
        col.is_terminal = !!is_terminal;
      } else if (kind !== undefined) {
        col.kind = kind as any;
        // Auto-sync: kind='terminal' forces is_terminal=true; flipping
        // away from 'terminal' clears the legacy boolean (so a previously-
        // terminal column doesn't keep gating dispatch via is_terminal).
        if (kind === 'terminal') col.is_terminal = true;
        else if ((col as any).is_terminal === true) col.is_terminal = false;
      } else if (is_terminal !== undefined) {
        col.is_terminal = !!is_terminal;
        // Auto-sync: flipping is_terminal=true on an unmarked column
        // upgrades kind to 'terminal'; flipping is_terminal=false on a
        // column whose kind was 'terminal' clears it back to '' (legacy
        // active). Don't overwrite a non-terminal kind set by an earlier
        // caller (e.g. 'review') — that would be silently destructive.
        // `!col.kind` covers both empty-string (legacy) and any nullish
        // backfill miss; we deliberately don't upgrade a non-empty
        // non-terminal kind (e.g. 'review') to 'terminal' just because
        // someone toggled is_terminal — that would be silently destructive.
        if (is_terminal && !col.kind) col.kind = 'terminal' as any;
        else if (!is_terminal && col.kind === 'terminal') col.kind = '' as any;
      }

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
