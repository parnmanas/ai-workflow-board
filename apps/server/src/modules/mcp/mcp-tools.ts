/**
 * AI-Workflow Board MCP Tool Registrations
 *
 * Shared module: registers all 35 MCP tools on a given McpServer instance.
 * Used by both the standalone mcp-server.ts and the integrated NestJS server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DataSource } from 'typeorm';
import { DEFAULT_COLUMNS } from '../../db';
import type { ToolContext } from './tools/context';

// Module-scope DataSource reference. Historically this was a mutable global
// overridden via `setDataSource`. During Phase 3 we pivoted to passing a
// ToolContext into `registerAllTools`, but the monolithic tool bodies below
// still close over `AppDataSource`. We hydrate it from `ctx.dataSource` at
// the top of `registerAllTools` so every tool call sees the NestJS-managed
// DataSource (or the standalone one in standalone mode).
let AppDataSource: DataSource = null as unknown as DataSource;

// ─── Agent Auth Context (per-session) ──────────────────────
// Session auth context is stored centrally in internal/session-store.ts
// (merged with the transport-session map so both share a single TTL).
// These exports remain to preserve the existing public API — they delegate
// to sessionStore. Note: setSessionAuth is a no-op if the session has not
// been registered with a transport first (preferred flow is to pass `auth`
// to sessionStore.register() atomically — the controller does this).
import { sessionStore, type McpAgentContext } from './internal/session-store';

export type { McpAgentContext };

export function setSessionAuth(sessionId: string, ctx: McpAgentContext) {
  sessionStore.setAuth(sessionId, ctx);
}

export function removeSessionAuth(sessionId: string) {
  sessionStore.removeAuth(sessionId);
}

function getCallerAgent(extra: { sessionId?: string }): McpAgentContext | undefined {
  if (!extra.sessionId) return undefined;
  return sessionStore.getAuth(extra.sessionId);
}

// Logger pulled from the ToolContext — set inside `registerAllTools`.
// `mcpToolsLog` preserves the original call sites while routing through
// the context's logger (NestJS LogService in integrated mode, console
// shim in standalone mode).
import type { McpLogger } from './tools/context';
let _logger: McpLogger = {
  info: (c, m, meta) => console.log(`[${c}]`, m, meta || ''),
  warn: (c, m, meta) => console.warn(`[${c}]`, m, meta || ''),
  error: (c, m, meta) => console.error(`[${c}]`, m, meta || ''),
};

function mcpToolsLog(message: string, meta?: Record<string, any>) {
  _logger.info('MCP', message, meta);
}
import { Workspace } from '../../entities/Workspace';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { AgentTrigger } from '../../entities/AgentTrigger';
import { AgentChannelIdentity } from '../../entities/AgentChannelIdentity';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { Channel } from '../../entities/Channel';
import { ActivityLog } from '../../entities/ActivityLog';
import { activityEvents } from '../../services/activity.service';
import { ApiKey } from '../../entities/ApiKey';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { Resource } from '../../entities/Resource';
import { ResourceEmbedding } from '../../entities/ResourceEmbedding';
import {
  generateEmbedding, buildResourceText, textHash,
  cosineSimilarity, isEmbeddingEnabled, setEmbeddingDataSource,
} from '../../services/embedding.service';
import {
  isGitHubEnabled, parseGitHubUrl, fetchRepoInfo, buildSyncContent,
  searchGitHubRepos, searchGitHubCode, searchGitHubIssues,
  setGitHubDataSource,
} from '../../services/github-connector.service';

import { randomBytes } from 'crypto';

// Shared helpers extracted during Phase 3 C1. These replace the previous
// in-file definitions of `ok`, `err`, `safeJsonParse`, and `loadTicketFull`.
import { ok, err, safeJsonParse } from './shared/helpers';
import { loadTicketFull as sharedLoadTicketFull } from './shared/ticket-parsing';

async function findColumnByName(boardId: string, columnName: string) {
  return AppDataSource.getRepository(BoardColumn)
    .createQueryBuilder('col')
    .where('col.board_id = :boardId AND LOWER(col.name) = LOWER(:name)', { boardId, name: columnName })
    .getOne();
}

async function maxTicketPosition(columnId: string): Promise<number> {
  const result = await AppDataSource.getRepository(Ticket)
    .createQueryBuilder('t')
    .select('COALESCE(MAX(t.position), -1)', 'max')
    .where('t.column_id = :columnId', { columnId })
    .getRawOne();
  return (result?.max ?? -1) + 1;
}

async function maxChildPosition(parentId: string): Promise<number> {
  const result = await AppDataSource.getRepository(Ticket)
    .createQueryBuilder('t')
    .select('COALESCE(MAX(t.position), -1)', 'max')
    .where('t.parent_id = :parentId', { parentId })
    .getRawOne();
  return (result?.max ?? -1) + 1;
}

// `loadTicketFull` is a thin wrapper over the shared implementation — it
// binds the module-scope AppDataSource so the rest of this file can call it
// without an explicit DataSource argument. Tool files moved into tools/
// will call `sharedLoadTicketFull(ctx.dataSource, id)` directly.
async function loadTicketFull(id: string) {
  return sharedLoadTicketFull(AppDataSource, id);
}

// Resolve agent ID from name if ID is missing
async function resolveAgentId(id: string, name: string): Promise<string> {
  if (id) return id;
  if (!name) return '';
  const agent = await AppDataSource.getRepository(Agent).findOne({ where: { name } }).catch(() => null);
  return agent?.id || '';
}

// Inline activity logging for standalone mode
async function logActivity(params: {
  entity_type: string; entity_id: string | number; action: string;
  field_changed?: string; old_value?: string; new_value?: string;
  actor_id?: string; actor_name?: string; ticket_id: string;
  role?: string; trigger_source?: string;
}) {
  const repo = AppDataSource.getRepository(ActivityLog);
  const log = repo.create({
    entity_type: params.entity_type,
    entity_id: String(params.entity_id),
    action: params.action,
    field_changed: params.field_changed || '',
    old_value: params.old_value || '',
    new_value: params.new_value || '',
    actor_id: params.actor_id || '',
    actor_name: params.actor_name || '',
    ticket_id: params.ticket_id,
    role: params.role || '',
    trigger_source: params.trigger_source || '',
  });
  const saved = await repo.save(log);
  activityEvents.emit('activity', saved);
  return saved;
}

async function getTicketActivity(ticketId: string, limit = 50) {
  return AppDataSource.getRepository(ActivityLog).find({
    where: { ticket_id: ticketId },
    order: { created_at: 'DESC' },
    take: limit,
  });
}

async function getRecentActivity(limit = 100) {
  return AppDataSource.getRepository(ActivityLog).find({
    order: { created_at: 'DESC' },
    take: limit,
  });
}

// Inline API key functions for standalone mode
function generateApiKeyValue(): string {
  return 'awb_' + randomBytes(20).toString('hex');
}

function maskKeyValue(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '***';
  return key.slice(0, 8) + '***' + key.slice(-4);
}

async function createApiKey(params: {
  name: string; agent_id?: string | null; scope?: string; expires_at?: Date | null;
}) {
  const repo = AppDataSource.getRepository(ApiKey);
  const rawKey = generateApiKeyValue();
  const entity = repo.create({
    name: params.name,
    key: rawKey,
    agent_id: params.agent_id ?? null,
    scope: params.scope || 'full',
    expires_at: params.expires_at ?? null,
  });
  const saved = await repo.save(entity);
  const { key, ...rest } = saved;
  return { apiKey: { ...rest, key_masked: maskKeyValue(key) }, raw_key: rawKey };
}

async function listApiKeys() {
  const keys = await AppDataSource.getRepository(ApiKey).find({
    order: { created_at: 'DESC' },
    relations: ['agent'],
  });
  return keys.map(({ key, ...rest }) => ({ ...rest, key_masked: maskKeyValue(key) }));
}

async function getApiKey(id: string) {
  const found = await AppDataSource.getRepository(ApiKey).findOne({ where: { id }, relations: ['agent'] });
  if (!found) return null;
  const { key, ...rest } = found;
  return { ...rest, key_masked: maskKeyValue(key) };
}

async function revokeApiKey(id: string): Promise<boolean> {
  const repo = AppDataSource.getRepository(ApiKey);
  const found = await repo.findOne({ where: { id } });
  if (!found) return false;
  found.is_active = 0;
  await repo.save(found);
  return true;
}

async function deleteApiKey(id: string): Promise<boolean> {
  const result = await AppDataSource.getRepository(ApiKey).delete(id);
  return (result.affected ?? 0) > 0;
}

async function updateApiKey(id: string, updates: {
  name?: string; scope?: string; is_active?: number; expires_at?: Date | null; agent_id?: string | null;
}) {
  const repo = AppDataSource.getRepository(ApiKey);
  const found = await repo.findOne({ where: { id } });
  if (!found) return null;

  if (updates.name !== undefined) found.name = updates.name;
  if (updates.scope !== undefined) found.scope = updates.scope;
  if (updates.is_active !== undefined) found.is_active = updates.is_active;
  if (updates.expires_at !== undefined) found.expires_at = updates.expires_at;
  if (updates.agent_id !== undefined) found.agent_id = updates.agent_id;

  const saved = await repo.save(found);
  const { key, ...rest } = saved;
  return { ...rest, key_masked: maskKeyValue(key) };
}

// ─── Tool Registration ──────────────────────────────────────

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // Hydrate module-scope references from the context. Phase 3 is moving the
  // tool bodies into tools/<domain>-tools.ts — for now they still close over
  // these locals, so we sync them here on every registration.
  AppDataSource = ctx.dataSource;
  _logger = ctx.logger;
  setEmbeddingDataSource(ctx.dataSource);
  setGitHubDataSource(ctx.dataSource);

  // ═══════════════════════════════════════════════════════════
  //  WORKSPACE TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'list_workspaces',
    'List all workspaces',
    {},
    async () => {
      const workspaces = await AppDataSource.getRepository(Workspace).find({ order: { created_at: 'DESC' } });
      const result = await Promise.all(workspaces.map(async ws => {
        const boardCount = await AppDataSource.getRepository(Board).count({ where: { workspace_id: ws.id } });
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
      const ws = await AppDataSource.getRepository(Workspace).findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      const boards = await AppDataSource.getRepository(Board).find({
        where: { workspace_id },
        order: { created_at: 'ASC' },
      });

      const boardsSummary = await Promise.all(boards.map(async board => {
        const columns = await AppDataSource.getRepository(BoardColumn).find({
          where: { board_id: board.id },
          order: { position: 'ASC' },
        });
        const colsSummary = await Promise.all(columns.map(async col => {
          const ticketCount = await AppDataSource.getRepository(Ticket).count({ where: { column_id: col.id } });
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
      const wsRepo = AppDataSource.getRepository(Workspace);
      const boardRepo = AppDataSource.getRepository(Board);
      const colRepo = AppDataSource.getRepository(BoardColumn);

      const ws = await wsRepo.save(wsRepo.create({ name, description }));
      const board = await boardRepo.save(boardRepo.create({
        workspace_id: ws.id,
        name: `${name} Board`,
        description: '',
      }));

      const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
      await colRepo.save(defaultCols.map(c => colRepo.create(c)));

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
      const wsRepo = AppDataSource.getRepository(Workspace);
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
      const wsRepo = AppDataSource.getRepository(Workspace);
      const ws = await wsRepo.findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      const count = await wsRepo.count();
      if (count <= 1) return err('Cannot delete the last workspace');

      await wsRepo.delete(ws.id);
      return ok({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  BOARD TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'list_boards',
    'List all boards. Optionally filter by workspace_id.',
    {
      workspace_id: z.string().optional().describe('Filter by workspace ID'),
    },
    async ({ workspace_id }) => {
      const where: any = {};
      if (workspace_id) where.workspace_id = workspace_id;
      const boards = await AppDataSource.getRepository(Board).find({ where, order: { created_at: 'DESC' } });
      return ok(boards);
    }
  );

  server.tool(
    'get_board',
    'Get a board with all columns, tickets (with children and comments)',
    { board_id: z.string().describe('Board ID') },
    async ({ board_id }) => {
      const board = await AppDataSource.getRepository(Board).findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      const columns = await AppDataSource.getRepository(BoardColumn).find({
        where: { board_id: board.id },
        order: { position: 'ASC' },
      });

      const ticketRepo = AppDataSource.getRepository(Ticket);
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
      const board = await AppDataSource.getRepository(Board).findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      const columns = await AppDataSource.getRepository(BoardColumn).find({
        where: { board_id: board.id },
        order: { position: 'ASC' },
      });

      // Single query: load all tickets for all columns with children
      const columnIds = columns.map(c => c.id);
      const allTickets = columnIds.length > 0
        ? await AppDataSource.getRepository(Ticket).find({
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
      const ws = await AppDataSource.getRepository(Workspace).findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      const boardRepo = AppDataSource.getRepository(Board);
      const colRepo = AppDataSource.getRepository(BoardColumn);

      const board = await boardRepo.save(boardRepo.create({ name, description, workspace_id }));
      const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
      await colRepo.save(defaultCols.map(c => colRepo.create(c)));

      const result = await boardRepo.findOne({ where: { id: board.id } });
      return ok(result);
    }
  );

  server.tool(
    'update_board',
    'Update a board name or description',
    {
      board_id: z.string().describe('Board ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
    },
    async ({ board_id, name, description }) => {
      const boardRepo = AppDataSource.getRepository(Board);
      const board = await boardRepo.findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      if (name !== undefined) board.name = name;
      if (description !== undefined) board.description = description;

      await boardRepo.save(board);
      return ok(board);
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  COLUMN TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'create_column',
    'Add a new column to a board',
    {
      board_id: z.string().describe('Board ID'),
      name: z.string().describe('Column name'),
      color: z.string().optional().default('#e2e8f0').describe('Column color (hex)'),
    },
    async ({ board_id, name, color }) => {
      const repo = AppDataSource.getRepository(BoardColumn);
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
    'Update a column name, color, or position',
    {
      column_id: z.string().describe('Column ID'),
      name: z.string().optional().describe('New column name'),
      color: z.string().optional().describe('New column color (hex)'),
      position: z.number().optional().describe('New position index'),
    },
    async ({ column_id, name, color, position }) => {
      const repo = AppDataSource.getRepository(BoardColumn);
      const col = await repo.findOne({ where: { id: column_id } });
      if (!col) return err('Column not found');

      if (name !== undefined) col.name = name;
      if (color !== undefined) col.color = color;
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
      const result = await AppDataSource.getRepository(BoardColumn).delete(column_id);
      if (result.affected === 0) return err('Column not found');
      return ok({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  TICKET TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'get_ticket',
    'Get a single ticket with its children and comments',
    { ticket_id: z.string().describe('Ticket ID') },
    async ({ ticket_id }) => {
      const ticket = await loadTicketFull(ticket_id);
      if (!ticket) return err('Ticket not found');
      return ok(ticket);
    }
  );

  server.tool(
    'create_ticket',
    'Create a new ticket. You can specify either column_id (numeric) or column_name + board_id to find the column by name.',
    {
      title: z.string().describe('Ticket title'),
      description: z.string().optional().default('').describe('Ticket description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium').describe('Priority level'),
      assignee: z.string().optional().default('').describe('Assignee name'),
      reporter: z.string().optional().default('').describe('Reporter name'),
      assignee_id: z.string().optional().default('').describe('Assignee user ID'),
      reporter_id: z.string().optional().default('').describe('Reporter user ID'),
      reviewer_id: z.string().optional().default('').describe('Reviewer agent ID'),
      labels: z.array(z.string()).optional().default([]).describe('Labels'),
      channel_ids: z.array(z.string()).optional().default([]).describe('Notification channel IDs'),
      column_id: z.string().optional().describe('Column ID (use this OR column_name)'),
      column_name: z.string().optional().describe('Column name (case-insensitive, requires board_id)'),
      board_id: z.string().optional().describe('Board ID (used with column_name)'),
      subtasks: z.array(z.string()).optional().default([]).describe('List of subtask titles to create inline'),
      created_by: z.string().optional().default('').describe('Creator name (user or agent)'),
      created_by_type: z.enum(['user', 'agent']).optional().default('agent').describe('Creator type'),
      created_by_id: z.string().optional().default('').describe('Creator ID'),
    },
    async ({ title, description, priority, assignee, reporter, assignee_id, reporter_id, reviewer_id, labels, channel_ids, column_id, column_name, board_id, subtasks, created_by, created_by_type, created_by_id }, extra: { sessionId?: string }) => {
      let resolvedColumnId = column_id;
      if (!resolvedColumnId && column_name) {
        if (!board_id) return err('board_id is required when using column_name');
        const col = await findColumnByName(board_id, column_name);
        if (!col) return err(`Column "${column_name}" not found in board ${board_id}`);
        resolvedColumnId = col.id;
      }
      if (!resolvedColumnId) return err('Either column_id or column_name is required');

      const col = await AppDataSource.getRepository(BoardColumn).findOne({ where: { id: resolvedColumnId } });
      if (!col) return err('Column not found');

      // Auto-fill creator from authenticated agent if not provided
      const caller = getCallerAgent(extra);
      const creatorName = created_by || (caller?.agentName) || reporter || assignee || '';
      const creatorType = created_by ? created_by_type : (caller?.agentId ? 'agent' : (reporter ? 'agent' : ''));
      const creatorId = created_by_id || (caller?.agentId) || (reporter ? await resolveAgentId('', reporter) : '');

      const ticket = await AppDataSource.transaction(async (manager) => {
        const tRepo = manager.getRepository(Ticket);

        const resolvedAssigneeId = await resolveAgentId(assignee_id, assignee);
        const resolvedReporterId = await resolveAgentId(reporter_id, reporter);
        const position = await maxTicketPosition(resolvedColumnId!);
        const t = await tRepo.save(tRepo.create({
          column_id: resolvedColumnId!, title, description, priority, assignee, reporter,
          assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId, reviewer_id,
          labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids), position,
          created_by: creatorName, created_by_type: creatorType, created_by_id: creatorId,
        }));

        if (subtasks.length > 0) {
          const stEntities = subtasks.map((stTitle, idx) =>
            tRepo.create({
              parent_id: t.id, depth: 1, column_id: null as any, title: stTitle, position: idx, status: 'todo',
              created_by: creatorName, created_by_type: creatorType, created_by_id: creatorId,
            })
          );
          await tRepo.save(stEntities);
        }

        return t;
      });

      await logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'created',
        ticket_id: ticket.id, actor_name: creatorName || reporter || assignee,
      });

      const full = await loadTicketFull(ticket.id);
      return ok(full);
    }
  );

  server.tool(
    'update_ticket',
    'Update a ticket\'s fields (title, description, priority, assignee, reporter, reviewer_id, labels, channel_ids)',
    {
      ticket_id: z.string().describe('Ticket ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('New priority'),
      assignee: z.string().optional().describe('New assignee name'),
      reporter: z.string().optional().describe('New reporter name'),
      assignee_id: z.string().optional().describe('New assignee user ID'),
      reporter_id: z.string().optional().describe('New reporter user ID'),
      reviewer_id: z.string().optional().describe('Reviewer agent ID'),
      labels: z.array(z.string()).optional().describe('New labels array'),
      channel_ids: z.array(z.string()).optional().describe('New notification channel IDs'),
    },
    async ({ ticket_id, title, description, priority, assignee, reporter, assignee_id, reporter_id, reviewer_id, labels, channel_ids }, extra: { sessionId?: string }) => {
      const ticketRepo = AppDataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      const caller = getCallerAgent(extra);

      // Track old values before updating
      const oldAssignee = ticket.assignee;
      const oldReporter = ticket.reporter;

      const changes: string[] = [];
      if (title !== undefined) { ticket.title = title; changes.push('title'); }
      if (description !== undefined) { ticket.description = description; changes.push('description'); }
      if (priority !== undefined) { ticket.priority = priority; changes.push('priority'); }
      if (assignee !== undefined && assignee !== oldAssignee) {
        ticket.assignee = assignee;
        ticket.assignee_id = await resolveAgentId(assignee_id || '', assignee);
        changes.push('assignee');
      } else if (assignee_id !== undefined) { ticket.assignee_id = assignee_id; }
      if (reporter !== undefined && reporter !== oldReporter) {
        ticket.reporter = reporter;
        ticket.reporter_id = await resolveAgentId(reporter_id || '', reporter);
        changes.push('reporter');
      } else if (reporter_id !== undefined) { ticket.reporter_id = reporter_id; }
      if (reviewer_id !== undefined) { ticket.reviewer_id = reviewer_id; changes.push('reviewer'); }
      if (labels !== undefined) { ticket.labels = JSON.stringify(labels); changes.push('labels'); }
      if (channel_ids !== undefined) { ticket.channel_ids = JSON.stringify(channel_ids); changes.push('channel_ids'); }

      await ticketRepo.save(ticket);

      // Log assignee/reporter changes separately for system comment generation
      if (assignee !== undefined && assignee !== oldAssignee) {
        await logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'assignee', old_value: oldAssignee || '', new_value: assignee || '',
          ticket_id: ticket.id, actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }
      if (reporter !== undefined && reporter !== oldReporter) {
        await logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'reporter', old_value: oldReporter || '', new_value: reporter || '',
          ticket_id: ticket.id, actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }

      // Log other field changes (excluding assignee/reporter which are logged separately above)
      const otherChanges = changes.filter(c => c !== 'assignee' && c !== 'reporter');
      if (otherChanges.length > 0) {
        await logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: otherChanges.join(', '), ticket_id: ticket.id,
          actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }

      const updated = await loadTicketFull(ticket.id);
      return ok(updated);
    }
  );

  server.tool(
    'move_ticket',
    'Move a ticket to a different column. You can specify target by column_id or column_name.',
    {
      ticket_id: z.string().describe('Ticket ID'),
      target_column_id: z.string().optional().describe('Target column ID (use this OR target_column_name)'),
      target_column_name: z.string().optional().describe('Target column name (case-insensitive)'),
      board_id: z.string().optional().describe('Board ID (used with target_column_name)'),
      position: z.number().optional().describe('Target position in the column (default: end)'),
    },
    async ({ ticket_id, target_column_id, target_column_name, board_id, position }, extra: { sessionId?: string }) => {
      const ticketRepo = AppDataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      const caller = getCallerAgent(extra);
      let destColumnId = target_column_id;
      if (!destColumnId && target_column_name) {
        if (!board_id) return err('board_id is required when using target_column_name');
        const col = await findColumnByName(board_id, target_column_name);
        if (!col) return err(`Column "${target_column_name}" not found`);
        destColumnId = col.id;
      }
      if (!destColumnId) return err('Either target_column_id or target_column_name is required');

      const oldColumnId = ticket.column_id;

      await AppDataSource.transaction(async (manager) => {
        const tRepo = manager.getRepository(Ticket);

        await tRepo.createQueryBuilder()
          .update()
          .set({ position: () => 'position - 1' })
          .where('column_id = :colId AND position > :pos', { colId: ticket.column_id, pos: ticket.position })
          .execute();

        const destCount = await tRepo.createQueryBuilder('t')
          .where('t.column_id = :colId AND t.id != :id', { colId: destColumnId, id: ticket.id })
          .getCount();
        const pos = Math.min(position ?? destCount, destCount);

        await tRepo.createQueryBuilder()
          .update()
          .set({ position: () => 'position + 1' })
          .where('column_id = :colId AND position >= :pos AND id != :id', { colId: destColumnId, pos, id: ticket.id })
          .execute();

        await tRepo.update(ticket.id, { column_id: destColumnId!, position: pos });
      });

      // Resolve column names for activity log
      const oldCol = await AppDataSource.getRepository(BoardColumn).findOne({ where: { id: oldColumnId } });
      const newCol = await AppDataSource.getRepository(BoardColumn).findOne({ where: { id: destColumnId! } });

      await logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'moved',
        field_changed: 'column', old_value: oldCol?.name || String(oldColumnId),
        new_value: newCol?.name || String(destColumnId), ticket_id: ticket.id,
        actor_id: caller?.agentId, actor_name: caller?.agentName,
      });

      const updated = await loadTicketFull(ticket.id);
      return ok(updated);
    }
  );

  server.tool(
    'delete_ticket',
    'Delete a ticket and all its children and comments',
    { ticket_id: z.string().describe('Ticket ID') },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticketRepo = AppDataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({
        where: { id: ticket_id },
        relations: ['children', 'comments'],
      });
      if (!ticket) return err('Ticket not found');

      const caller = getCallerAgent(extra);
      const columnId = ticket.column_id;
      const position = ticket.position;

      await ticketRepo.remove(ticket);

      await ticketRepo.createQueryBuilder()
        .update()
        .set({ position: () => 'position - 1' })
        .where('column_id = :colId AND position > :pos', { colId: columnId, pos: position })
        .execute();

      await logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'deleted',
        ticket_id: ticket.id, actor_id: caller?.agentId, actor_name: caller?.agentName,
      });

      return ok({ success: true, deleted_ticket_id: ticket_id });
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  CHILD TICKET TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'create_child_ticket',
    'Create a child ticket (subtask) under a parent ticket',
    {
      parent_id: z.string().describe('Parent ticket ID'),
      title: z.string().describe('Child ticket title'),
      description: z.string().optional().default('').describe('Description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium').describe('Priority'),
      status: z.enum(['todo', 'in_progress', 'done']).optional().default('todo').describe('Status'),
      assignee: z.string().optional().default('').describe('Assignee name'),
      reporter: z.string().optional().default('').describe('Reporter name'),
      assignee_id: z.string().optional().default('').describe('Assignee user ID'),
      reporter_id: z.string().optional().default('').describe('Reporter user ID'),
      labels: z.array(z.string()).optional().default([]).describe('Labels'),
      created_by: z.string().optional().default('').describe('Creator name (user or agent)'),
      created_by_type: z.enum(['user', 'agent']).optional().default('agent').describe('Creator type'),
      created_by_id: z.string().optional().default('').describe('Creator ID'),
    },
    async ({ parent_id, title, description, priority, status, assignee, reporter, assignee_id, reporter_id, labels, created_by, created_by_type, created_by_id }, extra: { sessionId?: string }) => {
      const ticketRepo = AppDataSource.getRepository(Ticket);
      const parent = await ticketRepo.findOne({ where: { id: parent_id } });
      if (!parent) return err('Parent ticket not found');

      const newDepth = (parent.depth || 0) + 1;
      if (newDepth > 2) return err('Maximum nesting depth is 2 (sub-subtask)');

      const caller = getCallerAgent(extra);
      const creatorName = created_by || (caller?.agentName) || reporter || assignee || '';
      const creatorType = created_by ? created_by_type : (caller?.agentId ? 'agent' : (reporter ? 'agent' : ''));
      const creatorId = created_by_id || (caller?.agentId) || (reporter ? await resolveAgentId('', reporter) : '');

      const position = await maxChildPosition(parent_id);
      const child = await ticketRepo.save(ticketRepo.create({
        parent_id, depth: newDepth, column_id: null as any, title, description, priority, status,
        assignee, reporter, assignee_id, reporter_id,
        labels: JSON.stringify(labels), position,
        created_by: creatorName, created_by_type: creatorType, created_by_id: creatorId,
      }));

      await logActivity({
        entity_type: 'ticket', entity_id: child.id, action: 'created',
        new_value: child.title, ticket_id: parent_id, actor_name: creatorName || reporter || assignee,
      });

      return ok(child);
    }
  );

  server.tool(
    'update_child_ticket',
    'Update a child ticket (title, description, status, priority, assignee, etc.)',
    {
      ticket_id: z.string().describe('Child ticket ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      status: z.enum(['todo', 'in_progress', 'done']).optional().describe('New status'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('New priority'),
      assignee: z.string().optional().describe('New assignee name'),
      reporter: z.string().optional().describe('New reporter name'),
      assignee_id: z.string().optional().describe('New assignee user ID'),
      reporter_id: z.string().optional().describe('New reporter user ID'),
      labels: z.array(z.string()).optional().describe('New labels'),
    },
    async ({ ticket_id, title, description, status, priority, assignee, reporter, assignee_id, reporter_id, labels }, extra: { sessionId?: string }) => {
      const ticketRepo = AppDataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Child ticket not found');

      const caller = getCallerAgent(extra);
      const oldStatus = ticket.status;

      if (title !== undefined) ticket.title = title;
      if (description !== undefined) ticket.description = description;
      if (status !== undefined) ticket.status = status;
      if (priority !== undefined) ticket.priority = priority;
      if (assignee !== undefined) ticket.assignee = assignee;
      if (reporter !== undefined) ticket.reporter = reporter;
      if (assignee_id !== undefined) ticket.assignee_id = assignee_id;
      if (reporter_id !== undefined) ticket.reporter_id = reporter_id;
      if (labels !== undefined) ticket.labels = JSON.stringify(labels);

      const updated = await ticketRepo.save(ticket);

      if (oldStatus !== ticket.status) {
        await logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'status_changed',
          field_changed: 'status', old_value: oldStatus, new_value: ticket.status,
          ticket_id: ticket.parent_id || ticket.id,
          actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      } else {
        await logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          ticket_id: ticket.parent_id || ticket.id,
          actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }

      return ok(updated);
    }
  );

  server.tool(
    'delete_child_ticket',
    'Delete a child ticket',
    { ticket_id: z.string().describe('Child ticket ID') },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticketRepo = AppDataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Child ticket not found');

      const caller = getCallerAgent(extra);
      const deletedTitle = ticket.title;
      const parentId = ticket.parent_id;
      const deletedPosition = ticket.position;

      await ticketRepo.delete(ticket.id);

      if (parentId) {
        await ticketRepo.createQueryBuilder()
          .update()
          .set({ position: () => 'position - 1' })
          .where('parent_id = :parentId AND position > :pos', { parentId, pos: deletedPosition })
          .execute();
      }

      await logActivity({
        entity_type: 'ticket', entity_id: ticket_id, action: 'deleted',
        new_value: deletedTitle, ticket_id: parentId || ticket_id,
        actor_id: caller?.agentId, actor_name: caller?.agentName,
      });

      return ok({ success: true, deleted_ticket_id: ticket_id });
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  COMMENT TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'add_comment',
    'Add a comment to a ticket. When authenticated as an agent, author fields are auto-filled if omitted.',
    {
      ticket_id: z.string().describe('Ticket ID'),
      author_type: z.enum(['user', 'agent']).optional().describe('Comment author type (auto-detected from auth)'),
      author_id: z.string().optional().describe('Author ID (auto-filled from auth if omitted)'),
      author: z.string().optional().describe('Display name (auto-resolved from auth/ID if omitted)'),
      content: z.string().describe('Comment content'),
    },
    async ({ ticket_id, author_type, author_id, author, content }, extra: { sessionId?: string }) => {
      const ticket = await AppDataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      // Auto-fill from authenticated agent if fields are missing
      const caller = getCallerAgent(extra);
      const resolvedAuthorType = author_type || (caller?.agentId ? 'agent' : 'user');
      const resolvedAuthorId = author_id || caller?.agentId || '';

      if (!resolvedAuthorId) return err('author_id is required (or authenticate with an agent API key)');

      // Resolve author name if not provided
      let authorName = author || '';
      if (!authorName) {
        if (resolvedAuthorType === 'agent') {
          if (caller?.agentName && caller?.agentId === resolvedAuthorId) {
            authorName = caller.agentName;
          } else {
            const agent = await AppDataSource.getRepository(Agent).findOne({ where: { id: resolvedAuthorId } });
            authorName = agent?.name || `Agent #${resolvedAuthorId}`;
          }
        } else {
          const user = await AppDataSource.getRepository(User).findOne({ where: { id: resolvedAuthorId } });
          authorName = user?.name || `User #${resolvedAuthorId}`;
        }
      }

      const commentRepo = AppDataSource.getRepository(Comment);
      const comment = await commentRepo.save(commentRepo.create({
        ticket_id, author_type: resolvedAuthorType, author_id: resolvedAuthorId, author: authorName, content,
      }));

      await logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolvedAuthorId, actor_name: authorName,
        new_value: content,
      });

      return ok(comment);
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  ACTIVITY TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'get_ticket_activity',
    'Get activity log for a specific ticket',
    {
      ticket_id: z.string().describe('Ticket ID'),
      limit: z.number().optional().default(50).describe('Max number of entries'),
    },
    async ({ ticket_id, limit }) => {
      const logs = await getTicketActivity(ticket_id, limit);
      return ok(logs);
    }
  );

  server.tool(
    'get_recent_activity',
    'Get the global recent activity feed across all tickets',
    {
      limit: z.number().optional().default(100).describe('Max number of entries'),
    },
    async ({ limit }) => {
      const logs = await getRecentActivity(limit);
      return ok(logs);
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  USER TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'list_users',
    'List all registered users',
    {},
    async () => {
      const users = await AppDataSource.getRepository(User).find({ order: { name: 'ASC' } });
      return ok(users);
    }
  );

  server.tool(
    'get_user',
    'Get a single user by ID',
    { user_id: z.string().describe('User ID') },
    async ({ user_id }) => {
      const user = await AppDataSource.getRepository(User).findOne({ where: { id: user_id } });
      if (!user) return err('User not found');
      return ok(user);
    }
  );

  server.tool(
    'create_user',
    'Create a new user',
    {
      name: z.string().describe('User name'),
      email: z.string().optional().default('').describe('Email address'),
      avatar_url: z.string().optional().default('').describe('Avatar URL'),
      role: z.enum(['admin', 'user']).optional().default('user').describe('User role'),
      discord_user_id: z.string().optional().default('').describe('Discord user ID for @mentions'),
      permissions: z.array(z.string()).optional().default([]).describe('Custom permissions (e.g. ["admin.users","admin.agents"])'),
    },
    async ({ name, email, avatar_url, role, discord_user_id, permissions }) => {
      const userRepo = AppDataSource.getRepository(User);
      const userData: any = { name, email, avatar_url, role, discord_user_id };
      if (permissions && permissions.length > 0) {
        userData.permissions = JSON.stringify(permissions);
      }
      const user = await userRepo.save(userRepo.create(userData));
      return ok(user);
    }
  );

  server.tool(
    'update_user',
    'Update a user',
    {
      user_id: z.string().describe('User ID'),
      name: z.string().optional().describe('New name'),
      email: z.string().optional().describe('New email'),
      avatar_url: z.string().optional().describe('New avatar URL'),
      role: z.enum(['admin', 'user']).optional().describe('New role'),
      discord_user_id: z.string().optional().describe('New Discord user ID'),
      permissions: z.array(z.string()).optional().describe('Custom permissions array'),
    },
    async ({ user_id, name, email, avatar_url, role, discord_user_id, permissions }) => {
      const userRepo = AppDataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: user_id } });
      if (!user) return err('User not found');

      if (name !== undefined) user.name = name;
      if (email !== undefined) user.email = email;
      if (avatar_url !== undefined) user.avatar_url = avatar_url;
      if (role !== undefined) user.role = role;
      if (discord_user_id !== undefined) user.discord_user_id = discord_user_id;
      if (permissions !== undefined) user.permissions = JSON.stringify(permissions);

      const updated = await userRepo.save(user);
      return ok(updated);
    }
  );

  server.tool(
    'delete_user',
    'Delete a user',
    { user_id: z.string().describe('User ID') },
    async ({ user_id }) => {
      const userRepo = AppDataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: user_id } });
      if (!user) return err('User not found');
      await userRepo.delete(user.id);
      return ok({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  AGENT REGISTRATION TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'list_agents',
    'List all registered AI agents',
    {},
    async () => {
      const agents = await AppDataSource.getRepository(Agent).find({
        relations: ['channel_identities'],
        order: { name: 'ASC' },
      });
      return ok(agents);
    }
  );

  server.tool(
    'get_agent',
    'Get a single AI agent by ID',
    { agent_id: z.string().describe('Agent ID') },
    async ({ agent_id }) => {
      const agent = await AppDataSource.getRepository(Agent).findOne({
        where: { id: agent_id },
        relations: ['channel_identities'],
      });
      if (!agent) return err('Agent not found');
      return ok(agent);
    }
  );

  server.tool(
    'create_agent',
    'Register a new AI agent',
    {
      name: z.string().describe('Agent name'),
      description: z.string().optional().default('').describe('Agent description'),
      type: z.enum(['claude', 'gpt', 'custom']).optional().default('custom').describe('Agent type'),
      avatar_url: z.string().optional().default('').describe('Avatar URL'),
      is_active: z.number().optional().default(1).describe('Active (1) or inactive (0)'),
    },
    async ({ name, description, type, avatar_url, is_active }) => {
      const agentRepo = AppDataSource.getRepository(Agent);
      const agent = await agentRepo.save(agentRepo.create({ name, description, type, avatar_url, is_active }));
      return ok({ ...agent, channel_identities: [] });
    }
  );

  server.tool(
    'update_agent',
    'Update an AI agent (name, description, type, avatar_url, is_active, role_prompt, role_prompt_meta)',
    {
      agent_id: z.string().describe('Agent ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      type: z.enum(['claude', 'gpt', 'custom']).optional().describe('New type'),
      avatar_url: z.string().optional().describe('New avatar URL'),
      is_active: z.number().optional().describe('Active (1) or inactive (0)'),
      role_prompt: z.string().optional().describe('Markdown role instructions delivered to this agent on every trigger'),
      role_prompt_meta: z.record(z.string(), z.unknown()).optional().describe(
        'Optional metadata sidecar: { version?, updated_by?, template_id?, ... } — forward-compat hook, safe to omit'
      ),
    },
    async ({ agent_id, name, description, type, avatar_url, is_active, role_prompt, role_prompt_meta }) => {
      const agentRepo = AppDataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      if (name !== undefined) agent.name = name;
      if (description !== undefined) agent.description = description;
      if (type !== undefined) agent.type = type;
      if (avatar_url !== undefined) agent.avatar_url = avatar_url;
      if (is_active !== undefined) agent.is_active = is_active;
      if (role_prompt !== undefined) agent.role_prompt = role_prompt;              // NEW — D-18
      if (role_prompt_meta !== undefined) agent.role_prompt_meta = role_prompt_meta as Record<string, any>; // NEW — D-18

      await agentRepo.save(agent);
      const updated = await agentRepo.findOne({ where: { id: agent.id }, relations: ['channel_identities'] });
      return ok(updated);
    }
  );

  server.tool(
    'delete_agent',
    'Delete an AI agent',
    { agent_id: z.string().describe('Agent ID') },
    async ({ agent_id }) => {
      const agentRepo = AppDataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');
      await agentRepo.delete(agent.id);
      return ok({ success: true });
    }
  );

  // ─── Prompt Templates (D-19) ─────────────────────────────────
  // Workspace-scoped per D-15. Three tools instead of a single polymorphic
  // `manage_prompt_template` — see D-19 rationale.

  server.tool(
    'list_prompt_templates',
    'List prompt templates in a workspace. Pass `id` to fetch a single template (get semantics) or `category` to filter.',
    {
      workspace_id: z.string().describe('Workspace ID (required — templates are workspace-scoped per D-15)'),
      id: z.string().optional().describe('If provided, return only the matching template (array of length 0 or 1)'),
      category: z.string().optional().describe('Optional category filter (free-form string match)'),
    },
    async ({ workspace_id, id, category }) => {
      const repo = AppDataSource.getRepository(PromptTemplate);
      if (id) {
        const tpl = await repo.findOne({ where: { id, workspace_id } });
        return ok(tpl ? [tpl] : []);
      }
      const where: any = { workspace_id };
      if (category) where.category = category;
      const tpls = await repo.find({ where, order: { name: 'ASC' } });
      return ok(tpls);
    }
  );

  server.tool(
    'save_prompt_template',
    'Upsert a prompt template. If `id` is provided → update; otherwise → create a new template.',
    {
      workspace_id: z.string().describe('Workspace ID (required — scope boundary)'),
      id: z.string().optional().describe('Template ID — omit to create a new template, provide to update an existing one'),
      name: z.string().describe('Template name (required, free-form)'),
      description: z.string().optional().describe('Short description (default: empty string)'),
      content: z.string().describe('Template body — markdown. This is what gets snapshot-copied into a ticket prompt_text when selected.'),
      category: z.string().optional().describe('Free-form category string (default: empty string)'),
    },
    async ({ workspace_id, id, name, description, content, category }) => {
      const repo = AppDataSource.getRepository(PromptTemplate);
      if (!name || !name.trim()) return err('Template name is required');
      if (!content) return err('Template content is required');

      if (id) {
        const existing = await repo.findOne({ where: { id, workspace_id } });
        if (!existing) return err('Template not found in workspace');
        existing.name = name;
        existing.description = description ?? '';
        existing.content = content;
        existing.category = category ?? '';
        const saved = await repo.save(existing);
        return ok(saved);
      }

      const created = repo.create({
        workspace_id,
        name,
        description: description ?? '',
        content,
        category: category ?? '',
      });
      const saved = await repo.save(created);
      return ok(saved);
    }
  );

  server.tool(
    'delete_prompt_template',
    'Delete a prompt template by id. Requires workspace_id as a safety scope to prevent cross-workspace deletes.',
    {
      workspace_id: z.string().describe('Workspace ID (required — scope boundary, must match the template)'),
      id: z.string().describe('Template ID'),
    },
    async ({ workspace_id, id }) => {
      const repo = AppDataSource.getRepository(PromptTemplate);
      const existing = await repo.findOne({ where: { id, workspace_id } });
      if (!existing) return err('Template not found in workspace');
      await repo.delete({ id, workspace_id });
      return ok({ success: true, id });
    }
  );

  // ─── Connection: ping ────────────────────────────────────────
  server.tool(
    'ping',
    'Heartbeat tool — call every 30 seconds to keep agent marked as online. ' +
    'Auto-stamps connected_at on first call. Returns current last_seen_at.',
    {
      agent_id: z.string().describe('Your agent ID (the UUID from list_agents)'),
    },
    async ({ agent_id }) => {
      const agentRepo = AppDataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err(`Agent not found: ${agent_id}`);

      const now = new Date();
      if (!agent.connected_at) agent.connected_at = now;
      agent.last_seen_at = now;
      agent.is_online = 1;
      await agentRepo.save(agent);

      mcpToolsLog(`ping: agent ${agent_id} (${agent.name}) is online`);
      return ok({ status: 'ok', agent_id, last_seen_at: now.toISOString() });
    }
  );

  // ─── Connection: set_typing ────────────────────────────────
  server.tool(
    'set_typing',
    'Signal that this agent is actively processing a ticket (shows typing indicator in the UI). ' +
    'Call with is_typing=false when done to clear the indicator immediately.',
    {
      agent_id: z.string().describe('Your agent ID'),
      ticket_id: z.string().describe('ID of the ticket being processed'),
      is_typing: z.boolean().describe('true = started processing, false = done processing'),
    },
    async ({ agent_id, ticket_id, is_typing }) => {
      const timestamp = new Date().toISOString();
      activityEvents.emit('agent_typing', { agent_id, ticket_id, is_typing, timestamp });
      // Auto-clear after 60s if agent crashes without sending stop signal
      if (is_typing) {
        setTimeout(() => {
          activityEvents.emit('agent_typing', {
            agent_id,
            ticket_id,
            is_typing: false,
            timestamp: new Date().toISOString(),
          });
        }, 60_000);
      }
      return ok({ status: 'ok' });
    }
  );

  // ─── Chat: send_chat_room_message (v2.0 — replaces legacy send_chat_message) ───
  server.tool(
    'send_chat_room_message',
    'Send a message to a chat room. The agent must be an active participant in the room. ' +
    'Messages are persisted and delivered to all room participants via SSE.',
    {
      room_id: z.string().describe('Chat room ID to send the message to'),
      content: z.string().min(1).max(10000).describe('Message content (supports markdown: bold, italic, code span, links)'),
    },
    async ({ room_id, content }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      if (!caller) return err('Unauthorized: no agent identity for this session');

      const agent = caller.agentId
        ? await AppDataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } })
        : null;
      if (!agent) return err('Agent identity not found for this session');

      // Verify agent is an active participant
      const participant = await AppDataSource.getRepository(ChatRoomParticipant).findOne({
        where: { room_id, participant_id: agent.id, participant_type: 'agent', left_at: undefined },
      });
      if (!participant) return err(`Agent is not an active participant in room ${room_id}`);

      // Save message
      const msg = await AppDataSource.getRepository(ChatRoomMessage).save(
        AppDataSource.getRepository(ChatRoomMessage).create({
          room_id,
          sender_type: 'agent',
          sender_id: agent.id,
          content,
          workspace_id: agent.workspace_id,
        }),
      );

      // Update room last_message_at
      await AppDataSource.getRepository(ChatRoom).update(room_id, { last_message_at: msg.created_at });

      // Resolve member_ids for SSE participant filter
      const members = await AppDataSource.getRepository(ChatRoomParticipant).find({
        where: { room_id, left_at: undefined },
      });
      const memberIds = new Set(members.filter(m => m.participant_type === 'user').map(m => m.participant_id));
      const agentMemberIds = new Set(members.filter(m => m.participant_type === 'agent').map(m => m.participant_id));

      activityEvents.emit('chat_room_message', {
        room_id,
        workspace_id: agent.workspace_id,
        message_id: msg.id,
        sender_type: 'agent',
        sender_id: agent.id,
        sender_name: agent.name,
        content,
        images: [],
        created_at: msg.created_at instanceof Date ? msg.created_at.toISOString() : msg.created_at,
        member_ids: memberIds,
        agent_member_ids: agentMemberIds,
      });

      return ok({ message_id: msg.id, room_id, content, created_at: msg.created_at });
    }
  );

  // ─── Chat: list_chat_rooms ───
  server.tool(
    'list_chat_rooms',
    'List chat rooms the agent participates in, with last message preview and unread count.',
    {},
    async (_args: Record<string, never>, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      if (!caller) return err('Unauthorized: no agent identity for this session');

      const agent = caller.agentId
        ? await AppDataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } })
        : null;
      if (!agent) return err('Agent identity not found');

      const rooms = await AppDataSource.getRepository(ChatRoomParticipant)
        .createQueryBuilder('p')
        .innerJoinAndSelect('p.room', 'r')
        .where('p.participant_id = :agentId', { agentId: agent.id })
        .andWhere('p.participant_type = :type', { type: 'agent' })
        .andWhere('p.left_at IS NULL')
        .orderBy('r.last_message_at', 'DESC', 'NULLS LAST')
        .getMany();

      return ok(rooms.map(p => ({
        room_id: p.room_id,
        name: p.room?.name || null,
        type: p.room?.type || 'group',
        last_message_at: p.room?.last_message_at || null,
      })));
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  CHANNEL TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'list_channels',
    'List all notification channels (Discord etc.)',
    {},
    async () => {
      const channels = await AppDataSource.getRepository(Channel).find({ order: { name: 'ASC' } });
      const masked = channels.map(ch => ({
        ...ch,
        bot_token: ch.bot_token ? '***' + ch.bot_token.slice(-4) : '',
      }));
      return ok(masked);
    }
  );

  server.tool(
    'create_channel',
    'Create a notification channel (e.g. Discord)',
    {
      name: z.string().describe('Channel name'),
      type: z.string().optional().default('discord').describe('Channel type'),
      bot_token: z.string().optional().default('').describe('Bot token'),
      channel_id: z.string().optional().default('').describe('External channel ID'),
      is_active: z.number().optional().default(1).describe('Active (1) or inactive (0)'),
      notify_on_status_change: z.number().optional().default(1).describe('Notify on status change'),
      notify_on_update: z.number().optional().default(1).describe('Notify on updates'),
      notify_on_comment: z.number().optional().default(1).describe('Notify on comments'),
    },
    async ({ name, type, bot_token, channel_id, is_active, notify_on_status_change, notify_on_update, notify_on_comment }) => {
      const channelRepo = AppDataSource.getRepository(Channel);
      const channel = await channelRepo.save(channelRepo.create({
        name, type, bot_token, channel_id, is_active,
        notify_on_status_change, notify_on_update, notify_on_comment,
      }));
      return ok({ ...channel, bot_token: channel.bot_token ? '***' + channel.bot_token.slice(-4) : '' });
    }
  );

  server.tool(
    'update_channel',
    'Update a notification channel',
    {
      channel_db_id: z.string().describe('Channel DB ID'),
      name: z.string().optional().describe('New name'),
      type: z.string().optional().describe('New type'),
      bot_token: z.string().optional().describe('New bot token'),
      channel_id: z.string().optional().describe('New external channel ID'),
      is_active: z.number().optional().describe('Active (1) or inactive (0)'),
      notify_on_status_change: z.number().optional().describe('Notify on status change'),
      notify_on_update: z.number().optional().describe('Notify on updates'),
      notify_on_comment: z.number().optional().describe('Notify on comments'),
    },
    async ({ channel_db_id, name, type, bot_token, channel_id, is_active, notify_on_status_change, notify_on_update, notify_on_comment }) => {
      const channelRepo = AppDataSource.getRepository(Channel);
      const channel = await channelRepo.findOne({ where: { id: channel_db_id } });
      if (!channel) return err('Channel not found');

      if (name !== undefined) channel.name = name;
      if (type !== undefined) channel.type = type;
      if (bot_token !== undefined && bot_token !== '') channel.bot_token = bot_token;
      if (channel_id !== undefined) channel.channel_id = channel_id;
      if (is_active !== undefined) channel.is_active = is_active;
      if (notify_on_status_change !== undefined) channel.notify_on_status_change = notify_on_status_change;
      if (notify_on_update !== undefined) channel.notify_on_update = notify_on_update;
      if (notify_on_comment !== undefined) channel.notify_on_comment = notify_on_comment;

      await channelRepo.save(channel);
      return ok({ ...channel, bot_token: channel.bot_token ? '***' + channel.bot_token.slice(-4) : '' });
    }
  );

  server.tool(
    'delete_channel',
    'Delete a notification channel',
    { channel_db_id: z.string().describe('Channel DB ID') },
    async ({ channel_db_id }) => {
      const channelRepo = AppDataSource.getRepository(Channel);
      const channel = await channelRepo.findOne({ where: { id: channel_db_id } });
      if (!channel) return err('Channel not found');
      await channelRepo.delete(channel.id);
      return ok({ success: true });
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  BATCH OPERATIONS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'batch_operations',
    `Execute multiple operations in a single transaction. Each operation object has an "action" field.
Supported actions:
  - create-ticket: { action, boardId?, column, title, description?, priority?, assignee? }
  - move-ticket: { action, boardId?, ticketId, toColumn, position? }
  - add-child: { action, ticketId, title } (also accepts legacy "add-subtask")
  - update-child: { action, ticketId, title?, status? } (also accepts legacy "update-subtask" with subtaskId)
  - add-comment: { action, ticketId, author, content }`,
    {
      operations: z.array(z.record(z.string(), z.unknown())).describe('Array of operation objects'),
    },
    async ({ operations }) => {
      const results: any[] = [];

      await AppDataSource.transaction(async (manager) => {
        const tRepo = manager.getRepository(Ticket);
        const cRepo = manager.getRepository(Comment);

        for (const op of operations) {
          try {
            switch (op.action) {
              case 'create-ticket': {
                const col = await findColumnByName(String(op.boardId), String(op.column));
                if (!col) { results.push({ error: `Column "${op.column}" not found` }); continue; }
                const pos = await maxTicketPosition(col.id);
                const r = await tRepo.save(tRepo.create({
                  column_id: col.id, title: String(op.title), description: String(op.description || ''),
                  priority: String(op.priority || 'medium'), assignee: String(op.assignee || ''), labels: '[]', position: pos,
                }));
                results.push({ success: true, ticketId: r.id });
                break;
              }
              case 'move-ticket': {
                const col = await findColumnByName(String(op.boardId), String(op.toColumn));
                if (!col) { results.push({ error: `Column "${op.toColumn}" not found` }); continue; }
                const t = await tRepo.findOne({ where: { id: String(op.ticketId) } });
                if (!t) { results.push({ error: 'Ticket not found' }); continue; }

                await tRepo.createQueryBuilder().update()
                  .set({ position: () => 'position - 1' })
                  .where('column_id = :colId AND position > :pos', { colId: t.column_id, pos: t.position }).execute();

                const cnt = await tRepo.createQueryBuilder('t')
                  .where('t.column_id = :colId AND t.id != :id', { colId: col.id, id: t.id }).getCount();
                const pos = Number(op.position) || cnt;

                await tRepo.createQueryBuilder().update()
                  .set({ position: () => 'position + 1' })
                  .where('column_id = :colId AND position >= :pos AND id != :id', { colId: col.id, pos, id: t.id }).execute();

                await tRepo.update(t.id, { column_id: col.id, position: pos });
                results.push({ success: true, ticketId: String(op.ticketId), movedTo: op.toColumn });
                break;
              }
              case 'add-child':
              case 'add-subtask': {
                const parentTicket = await tRepo.findOne({ where: { id: String(op.ticketId) } });
                if (!parentTicket) { results.push({ error: `Parent ticket not found: ${op.ticketId}` }); break; }
                const newDepth = (parentTicket.depth || 0) + 1;
                if (newDepth > 2) { results.push({ error: `Max nesting depth (2) exceeded` }); break; }
                const maxP = await tRepo.createQueryBuilder('t')
                  .select('COALESCE(MAX(t.position), -1)', 'max')
                  .where('t.parent_id = :parentId', { parentId: String(op.ticketId) }).getRawOne();
                const r = await tRepo.save(tRepo.create({
                  parent_id: String(op.ticketId), depth: newDepth, column_id: null as any,
                  title: String(op.title), position: (maxP?.max ?? -1) + 1, status: 'todo',
                }));
                results.push({ success: true, ticketId: r.id });
                break;
              }
              case 'update-child':
              case 'update-subtask': {
                const updates: any = {};
                if (op.done !== undefined) updates.status = op.done ? 'done' : 'todo';
                if (op.title !== undefined) updates.title = String(op.title);
                if (op.status !== undefined) updates.status = String(op.status);
                const childId = String(op.subtaskId || op.ticketId);
                await tRepo.update(childId, updates);
                results.push({ success: true, ticketId: childId });
                break;
              }
              case 'add-comment': {
                const r = await cRepo.save(cRepo.create({
                  ticket_id: String(op.ticketId), author: String(op.author), content: String(op.content),
                }));
                results.push({ success: true, commentId: r.id });
                break;
              }
              default:
                results.push({ error: `Unknown action: ${op.action}` });
            }
          } catch (opErr: any) {
            results.push({ error: opErr.message });
          }
        }
      });

      return ok({ results });
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  API KEY MANAGEMENT TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'list_api_keys',
    'List all API keys (key values are masked). Shows name, scope, agent, status, usage stats.',
    {},
    async () => {
      const keys = await listApiKeys();
      return ok(keys);
    }
  );

  server.tool(
    'get_api_key',
    'Get details of a single API key by ID',
    { key_id: z.string().describe('API key ID') },
    async ({ key_id }) => {
      const key = await getApiKey(key_id);
      if (!key) return err('API key not found');
      return ok(key);
    }
  );

  server.tool(
    'create_api_key',
    'Create a new API key for MCP authentication. The raw key is returned ONLY in this response — save it immediately.',
    {
      name: z.string().describe('Display name for the key (e.g. "claude-prod", "gpt-dev")'),
      agent_id: z.string().optional().describe('Link to an Agent ID (optional)'),
      scope: z.enum(['full', 'read', 'write']).optional().default('full').describe('Permission scope'),
      expires_in_days: z.number().optional().describe('Auto-expire after N days (optional, null = never)'),
    },
    async ({ name, agent_id, scope, expires_in_days }) => {
      let expires_at: Date | null = null;
      if (expires_in_days && expires_in_days > 0) {
        expires_at = new Date();
        expires_at.setDate(expires_at.getDate() + expires_in_days);
      }

      const result = await createApiKey({ name, agent_id: agent_id ?? null, scope, expires_at });
      return ok({
        ...result.apiKey,
        raw_key: result.raw_key,
        _notice: 'Save the raw_key now. It will NOT be shown again.',
      });
    }
  );

  server.tool(
    'revoke_api_key',
    'Revoke (deactivate) an API key. The key remains in DB but can no longer authenticate.',
    { key_id: z.string().describe('API key ID to revoke') },
    async ({ key_id }) => {
      const success = await revokeApiKey(key_id);
      if (!success) return err('API key not found');
      return ok({ success: true, message: 'Key revoked' });
    }
  );

  server.tool(
    'delete_api_key',
    'Permanently delete an API key from the database',
    { key_id: z.string().describe('API key ID to delete') },
    async ({ key_id }) => {
      const success = await deleteApiKey(key_id);
      if (!success) return err('API key not found');
      return ok({ success: true });
    }
  );

  server.tool(
    'update_api_key',
    'Update an API key\'s metadata (name, scope, active status, expiration, agent link)',
    {
      key_id: z.string().describe('API key ID'),
      name: z.string().optional().describe('New display name'),
      scope: z.enum(['full', 'read', 'write']).optional().describe('New scope'),
      is_active: z.number().optional().describe('1 = active, 0 = revoked'),
      agent_id: z.string().optional().describe('Link to Agent ID (null to unlink)'),
      expires_in_days: z.number().optional().describe('Set expiry N days from now (0 or null = never expire)'),
    },
    async ({ key_id, name, scope, is_active, agent_id, expires_in_days }) => {
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (scope !== undefined) updates.scope = scope;
      if (is_active !== undefined) updates.is_active = is_active;
      if (agent_id !== undefined) updates.agent_id = agent_id;
      if (expires_in_days !== undefined) {
        if (expires_in_days === 0) {
          updates.expires_at = null;
        } else {
          const d = new Date();
          d.setDate(d.getDate() + expires_in_days);
          updates.expires_at = d;
        }
      }

      const result = await updateApiKey(key_id, updates);
      if (!result) return err('API key not found');
      return ok(result);
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  ROLE ROUTING TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'get_my_tickets',
    'Get tickets where this agent is assignee, reporter, or reviewer within the workspace.',
    {
      agent_id: z.string().describe('Calling agent ID'),
      workspace_id: z.string().describe('Workspace to scope results'),
      status: z.string().optional().describe('Filter by ticket status (optional, e.g. "todo", "in_progress", "done")'),
    },
    async ({ agent_id, workspace_id, status }) => {
      const agentRepo = AppDataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      if (agent.workspace_id && agent.workspace_id !== workspace_id) {
        return err('Agent does not belong to the requested workspace');
      }

      const ticketRepo = AppDataSource.getRepository(Ticket);
      let qb = ticketRepo.createQueryBuilder('t')
        .innerJoin('columns', 'col', 'col.id = t.column_id')
        .innerJoin('boards', 'b', 'b.id = col.board_id')
        .where('b.workspace_id = :workspaceId', { workspaceId: workspace_id })
        .andWhere('(t.assignee_id = :agentId OR t.reporter_id = :agentId OR t.reviewer_id = :agentId)', { agentId: agent_id });

      if (status) {
        qb = qb.andWhere('t.status = :status', { status });
      }

      const tickets = await qb.orderBy('t.created_at', 'DESC').getMany();
      return ok(tickets.map(t => ({
        ...t,
        labels: safeJsonParse(t.labels, []),
        channel_ids: safeJsonParse(t.channel_ids, []),
      })));
    }
  );

  server.tool(
    'get_pending_triggers',
    'Fetch unacknowledged AgentTrigger records targeting this agent. ' +
    'Returns triggers where acknowledged_at IS NULL and expires_at has not passed. ' +
    'Agents also receive real-time agent_trigger SSE events when new triggers are created.',
    {
      agent_id: z.string().describe('Calling agent ID'),
      workspace_id: z.string().describe('Workspace to scope results'),
    },
    async ({ agent_id, workspace_id }) => {
      const agentRepo = AppDataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      if (agent.workspace_id && agent.workspace_id !== workspace_id) {
        return err('Agent does not belong to the requested workspace');
      }

      const now = new Date();
      const triggers = await AppDataSource.getRepository(AgentTrigger)
        .createQueryBuilder('t')
        .where('t.acknowledged_at IS NULL')
        .andWhere('(t.expires_at IS NULL OR t.expires_at > :now)', { now })
        .andWhere('t.agent_id = :agentId', { agentId: agent_id })
        .orderBy('t.created_at', 'ASC')
        .getMany();

      return ok(triggers);
    }
  );

  server.tool(
    'acknowledge_trigger',
    'Mark an AgentTrigger as acknowledged so it no longer appears in get_pending_triggers. ' +
    'Call this after you have started processing the triggered ticket.',
    {
      trigger_id: z.string().describe('AgentTrigger ID to acknowledge'),
      agent_id: z.string().describe('Calling agent ID (for audit log)'),
    },
    async ({ trigger_id, agent_id }) => {
      const repo = AppDataSource.getRepository(AgentTrigger);
      const trigger = await repo.findOne({ where: { id: trigger_id } });
      if (!trigger) return err('Trigger not found');

      if (trigger.acknowledged_at) {
        return ok({ already_acknowledged: true, trigger_id, acknowledged_at: trigger.acknowledged_at });
      }

      // Only the target agent can acknowledge their own trigger
      if (trigger.agent_id !== agent_id) {
        return err(`Trigger belongs to agent "${trigger.agent_id}", not "${agent_id}"`);
      }

      trigger.acknowledged_at = new Date();
      await repo.save(trigger);

      await logActivity({
        entity_type: 'ticket',
        entity_id: trigger.ticket_id,
        action: 'updated',
        field_changed: 'trigger_acknowledged',
        new_value: trigger_id,
        ticket_id: trigger.ticket_id,
        actor_id: agent_id,
        role: trigger.role,
        trigger_source: 'agent_trigger',
      });

      return ok({ acknowledged: true, trigger_id, role: trigger.role, ticket_id: trigger.ticket_id });
    }
  );

  server.tool(
    'claim_ticket',
    'Exclusively claim a ticket for processing. Sets a TTL-based lock preventing other agents ' +
    'from claiming the same ticket. Returns error if ticket is currently locked by another agent. ' +
    'Same-agent re-claim is idempotent (refreshes locked_at). Subagents call this with their own agent_id.',
    {
      ticket_id: z.string().describe('Ticket ID to claim'),
      agent_id: z.string().describe('Your agent ID (the lock will be owned by this agent)'),
      ttl_minutes: z.number().optional().default(30).describe('Lock TTL in minutes (default 30, max 120)'),
    },
    async ({ ticket_id, agent_id, ttl_minutes }) => {
      const ticketRepo = AppDataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      // Check existing lock — allow re-claim by same agent (idempotent refresh)
      if (ticket.locked_by_agent_id && ticket.locked_by_agent_id !== agent_id) {
        // Check if the existing lock has expired (in-request TTL path — LOCK-03 gap-fill)
        const lockAgeMs = Date.now() - new Date(ticket.locked_at!).getTime();
        const clampedTtlMs = Math.min(ttl_minutes ?? 30, 120) * 60 * 1000;
        if (lockAgeMs < clampedTtlMs) {
          return err(`Ticket already claimed by agent ${ticket.locked_by_agent_id}`);
        }
        // Expired lock — silent override; sweep may not have run yet
      }

      const agentRepo = AppDataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      const previousOwner = ticket.locked_by_agent_id;
      ticket.locked_by_agent_id = agent_id;
      ticket.locked_at = new Date();

      try {
        await ticketRepo.save(ticket);
      } catch (e: any) {
        // @VersionColumn optimistic lock conflict: two agents claimed simultaneously
        if (e?.name === 'OptimisticLockVersionMismatch' || e?.message?.includes('optimistic lock')) {
          return err('Claim conflict — retry');
        }
        throw e;
      }

      await logActivity({
        entity_type: 'ticket',
        entity_id: ticket_id,
        action: 'updated',
        field_changed: 'locked_by_agent_id',
        old_value: previousOwner ?? '',
        new_value: agent_id,
        actor_id: agent_id,
        actor_name: agent.name,
        ticket_id,
        role: '',
        trigger_source: 'agent_claim',
      });

      return ok({
        claimed: true,
        ticket_id,
        agent_id,
        locked_at: ticket.locked_at,
        ...(previousOwner && previousOwner !== agent_id ? { note: 'expired lock overridden' } : {}),
      });
    }
  );

  server.tool(
    'release_ticket',
    'Release a previously claimed ticket lock. Only the agent that owns the lock can release it. ' +
    'Returns ok({released: false}) if the ticket was not locked (idempotent). ' +
    'Returns error if the lock is owned by a different agent.',
    {
      ticket_id: z.string().describe('Ticket ID to release'),
      agent_id: z.string().describe('Your agent ID — must match the current lock owner'),
    },
    async ({ ticket_id, agent_id }) => {
      const ticketRepo = AppDataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      // Idempotent: ticket was not locked
      if (!ticket.locked_by_agent_id) {
        return ok({ released: false, reason: 'Ticket was not locked' });
      }

      // Ownership check (LOCK-02 release path, T-04-02-02 Tampering mitigation)
      if (ticket.locked_by_agent_id !== agent_id) {
        return err(`Lock owned by agent ${ticket.locked_by_agent_id} — cannot release`);
      }

      ticket.locked_by_agent_id = null;
      ticket.locked_at = null;
      await ticketRepo.save(ticket);

      await logActivity({
        entity_type: 'ticket',
        entity_id: ticket_id,
        action: 'updated',
        field_changed: 'locked_by_agent_id',
        old_value: agent_id,
        new_value: '',
        actor_id: agent_id,
        ticket_id,
        role: '',
        trigger_source: 'agent_release',
      });

      return ok({ released: true, ticket_id, agent_id });
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  AGENT IDENTITY TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'whoami',
    'Returns the authenticated agent identity for this MCP session. Use this to verify your connection and identity.',
    {},
    async (_args: any, extra: { sessionId?: string }) => {
      const ctx = getCallerAgent(extra);
      if (!ctx) return ok({ authenticated: false, message: 'No agent context — running in dev mode or unauthenticated.' });

      let agentInfo: Record<string, any> | null = null;
      if (ctx.agentId) {
        const found = await AppDataSource.getRepository(Agent).findOne({
          where: { id: ctx.agentId },
          relations: ['channel_identities'],
        });
        if (found) {
          agentInfo = {
            id: found.id,
            name: found.name,
            type: found.type,
            description: found.description,
            is_active: found.is_active,
            channel_identities: found.channel_identities,
          };
        }
      }

      return ok({
        authenticated: true,
        agent_id: ctx.agentId || null,
        agent_name: ctx.agentName || null,
        scope: ctx.scope || 'full',
        source: ctx.source,
        agent: agentInfo,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════
  //  EVENT SUBSCRIPTION TOOLS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    'subscribe_events',
    'Subscribe to board events. Returns recent events since the given cursor (ISO timestamp or event ID). Events include ticket creation, updates, moves, comments, and agent assignments. Poll periodically to receive updates.',
    {
      board_id: z.string().optional().describe('Filter events by board ID (omit for all boards)'),
      since: z.string().optional().describe('ISO timestamp or activity log ID cursor — returns events after this point. Omit for last 10 minutes.'),
      limit: z.number().optional().default(50).describe('Max events to return'),
      assigned_to_me: z.boolean().optional().default(false).describe('Only return events for tickets assigned to the authenticated agent'),
    },
    async ({ board_id, since, limit, assigned_to_me }, extra: { sessionId?: string }) => {
      const ctx = getCallerAgent(extra);
      const repo = AppDataSource.getRepository(ActivityLog);

      let query = repo.createQueryBuilder('a')
        .orderBy('a.created_at', 'ASC')
        .take(limit);

      // Time cursor
      if (since) {
        // Try as ISO date first, then as activity ID
        const sinceDate = new Date(since);
        if (!isNaN(sinceDate.getTime())) {
          query = query.where('a.created_at > :since', { since: sinceDate.toISOString() });
        } else {
          // Treat as activity log ID — get events after that ID's timestamp
          const ref = await repo.findOne({ where: { id: parseInt(since) as any } });
          if (ref) {
            query = query.where('a.created_at > :since', { since: ref.created_at });
          }
        }
      } else {
        // Default: last 10 minutes
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        query = query.where('a.created_at > :since', { since: tenMinAgo });
      }

      let events = await query.getMany();

      // Filter by board if specified
      if (board_id) {
        const ticketIds = new Set<string>();
        const tickets = await AppDataSource.getRepository(Ticket)
          .createQueryBuilder('t')
          .innerJoin(BoardColumn, 'col', 'col.id = t.column_id')
          .where('col.board_id = :board_id', { board_id })
          .select('t.id')
          .getMany();
        tickets.forEach(t => ticketIds.add(t.id));

        // Also include child tickets
        if (ticketIds.size > 0) {
          const children = await AppDataSource.getRepository(Ticket)
            .createQueryBuilder('t')
            .where('t.parent_id IN (:...ids)', { ids: Array.from(ticketIds) })
            .select('t.id')
            .getMany();
          children.forEach(c => ticketIds.add(c.id));
        }

        events = events.filter(e => e.ticket_id && ticketIds.has(e.ticket_id));
      }

      // Filter to only events for tickets assigned to the calling agent
      if (assigned_to_me && ctx?.agentId) {
        const myTickets = await AppDataSource.getRepository(Ticket)
          .createQueryBuilder('t')
          .where('t.assignee_id = :agentId', { agentId: ctx.agentId })
          .select('t.id')
          .getMany();
        const myTicketIds = new Set(myTickets.map(t => t.id));
        events = events.filter(e => e.ticket_id && myTicketIds.has(e.ticket_id));
      }

      const cursor = events.length > 0
        ? events[events.length - 1].created_at
        : since || new Date().toISOString();

      return ok({
        events: events.map(e => ({
          id: e.id,
          entity_type: e.entity_type,
          action: e.action,
          ticket_id: e.ticket_id,
          field_changed: e.field_changed || undefined,
          old_value: e.old_value || undefined,
          new_value: e.new_value || undefined,
          actor_id: e.actor_id || undefined,
          actor_name: e.actor_name || undefined,
          timestamp: e.created_at,
        })),
        cursor,
        count: events.length,
        has_more: events.length >= limit,
      });
    }
  );

  // ─── Resources ────────────────────────────────────────────────

  function parseResourceTags(r: Resource) {
    try { return JSON.parse(r.tags || '[]'); } catch { return []; }
  }

  function resourceToJson(r: Resource) {
    return {
      id: r.id,
      workspace_id: r.workspace_id,
      board_id: r.board_id,
      name: r.name,
      description: r.description,
      type: r.type,
      url: r.url,
      content: r.content ? r.content.slice(0, 500) + (r.content.length > 500 ? '...' : '') : '',
      file_name: r.file_name,
      file_mimetype: r.file_mimetype,
      has_file: !!r.file_data,
      tags: parseResourceTags(r),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  async function embedResource(resource: Resource) {
    if (!(await isEmbeddingEnabled())) return;
    const text = buildResourceText({
      name: resource.name,
      description: resource.description,
      type: resource.type,
      url: resource.url,
      content: resource.content,
      tags: resource.tags,
    });
    const hash = textHash(text);
    const embRepo = AppDataSource.getRepository(ResourceEmbedding);
    const existing = await embRepo.findOne({ where: { resource_id: resource.id } });
    if (existing && existing.text_hash === hash) return;

    const result = await generateEmbedding(text);
    if (!result) return;

    if (existing) {
      existing.embedding = JSON.stringify(result.embedding);
      existing.model = result.model;
      existing.dimensions = result.dimensions;
      existing.text_hash = hash;
      await embRepo.save(existing);
    } else {
      await embRepo.save(embRepo.create({
        resource_id: resource.id,
        embedding: JSON.stringify(result.embedding),
        model: result.model,
        dimensions: result.dimensions,
        text_hash: hash,
      }));
    }
    mcpToolsLog(`Embedded resource ${resource.id} (${resource.name})`);
  }

  server.tool(
    'list_resources',
    'List resources in a workspace. Optionally filter by board_id or type (repository/document/image/link). ' +
    'Resources with board_id=null are workspace-level; those with a board_id are board-scoped.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('Board ID to filter board-scoped resources. Omit for workspace-level resources.'),
      type: z.string().optional().describe('Filter by resource type: repository, document, image, link'),
    },
    async ({ workspace_id, board_id, type }) => {
      const repo = AppDataSource.getRepository(Resource);
      const where: any = { workspace_id };
      if (board_id !== undefined) where.board_id = board_id || null;
      if (type) where.type = type;
      const resources = await repo.find({ where, order: { name: 'ASC' } });
      return ok(resources.map(resourceToJson));
    }
  );

  server.tool(
    'get_resource',
    'Get a single resource by ID with full content (including file_data if present).',
    {
      id: z.string().describe('Resource ID'),
    },
    async ({ id }) => {
      const repo = AppDataSource.getRepository(Resource);
      const resource = await repo.findOne({ where: { id } });
      if (!resource) return err('Resource not found');
      return ok({
        ...resource,
        tags: parseResourceTags(resource),
      });
    }
  );

  server.tool(
    'save_resource',
    'Create or update a resource. If `id` is provided → update; otherwise → create. ' +
    'Supports four types: repository (GitHub repos etc.), document (text content), image (base64 file or URL), link (general URLs). ' +
    'Resources are automatically embedded for vector search when an embedding API is configured.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      id: z.string().optional().describe('Resource ID — omit to create, provide to update'),
      board_id: z.string().optional().describe('Board ID for board-scoped resources. Omit or null for workspace-level.'),
      name: z.string().describe('Resource name'),
      description: z.string().optional().describe('Short description'),
      type: z.enum(['repository', 'document', 'image', 'link']).optional().default('link').describe('Resource type'),
      url: z.string().optional().describe('External URL (for repository/link/image types)'),
      content: z.string().optional().describe('Text content (for document type or notes)'),
      file_data: z.string().optional().describe('Base64-encoded file data (for image type)'),
      file_name: z.string().optional().describe('Original file name'),
      file_mimetype: z.string().optional().describe('File MIME type'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
    },
    async ({ workspace_id, id, board_id, name, description, type, url, content, file_data, file_name, file_mimetype, tags }) => {
      const repo = AppDataSource.getRepository(Resource);
      if (!name || !name.trim()) return err('Resource name is required');

      if (id) {
        const existing = await repo.findOne({ where: { id, workspace_id } });
        if (!existing) return err('Resource not found in workspace');
        existing.name = name.trim();
        if (description !== undefined) existing.description = description;
        if (type !== undefined) existing.type = type;
        if (url !== undefined) existing.url = url;
        if (content !== undefined) existing.content = content;
        if (file_data !== undefined) existing.file_data = file_data;
        if (file_name !== undefined) existing.file_name = file_name;
        if (file_mimetype !== undefined) existing.file_mimetype = file_mimetype;
        if (board_id !== undefined) existing.board_id = board_id || null;
        if (tags !== undefined) existing.tags = JSON.stringify(tags);
        const saved = await repo.save(existing);
        embedResource(saved).catch(() => {});
        return ok(resourceToJson(saved));
      }

      const created = repo.create({
        workspace_id,
        board_id: board_id || null,
        name: name.trim(),
        description: description ?? '',
        type: type ?? 'link',
        url: url ?? '',
        content: content ?? '',
        file_data: file_data ?? '',
        file_name: file_name ?? '',
        file_mimetype: file_mimetype ?? '',
        tags: JSON.stringify(tags ?? []),
      });
      const saved = await repo.save(created);
      embedResource(saved).catch(() => {});
      return ok(resourceToJson(saved));
    }
  );

  server.tool(
    'delete_resource',
    'Delete a resource by ID. Also removes its vector embedding if one exists.',
    {
      workspace_id: z.string().describe('Workspace ID (required — scope boundary)'),
      id: z.string().describe('Resource ID'),
    },
    async ({ workspace_id, id }) => {
      const repo = AppDataSource.getRepository(Resource);
      const existing = await repo.findOne({ where: { id, workspace_id } });
      if (!existing) return err('Resource not found in workspace');
      await repo.delete({ id, workspace_id });
      const embRepo = AppDataSource.getRepository(ResourceEmbedding);
      await embRepo.delete({ resource_id: id });
      return ok({ success: true, id });
    }
  );

  server.tool(
    'search_resources',
    'Search resources using semantic vector similarity (when embedding API configured) or text matching (fallback). ' +
    'Returns resources ranked by relevance. Use this to find relevant documents, repos, images, or links.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      query: z.string().describe('Natural language search query'),
      board_id: z.string().optional().describe('Limit search to a specific board. Omit to search workspace-level resources.'),
      type: z.string().optional().describe('Filter by resource type'),
      limit: z.number().optional().default(10).describe('Max results to return (default: 10)'),
    },
    async ({ workspace_id, query, board_id, type, limit }) => {
      const repo = AppDataSource.getRepository(Resource);
      const where: any = { workspace_id };
      if (board_id !== undefined) where.board_id = board_id || null;
      if (type) where.type = type;
      const resources = await repo.find({ where, order: { name: 'ASC' } });

      if (resources.length === 0) return ok({ results: [], search_mode: 'none', total: 0 });

      // Try vector search first
      if (await isEmbeddingEnabled()) {
        const queryEmbedding = await generateEmbedding(query);
        if (queryEmbedding) {
          const embRepo = AppDataSource.getRepository(ResourceEmbedding);
          const resourceIds = resources.map(r => r.id);
          const embeddings = await embRepo
            .createQueryBuilder('e')
            .where('e.resource_id IN (:...ids)', { ids: resourceIds })
            .getMany();

          if (embeddings.length > 0) {
            const embMap = new Map(embeddings.map(e => [e.resource_id, e]));
            const scored = resources
              .filter(r => embMap.has(r.id))
              .map(r => {
                const emb = embMap.get(r.id)!;
                const vec = JSON.parse(emb.embedding);
                const score = cosineSimilarity(queryEmbedding.embedding, vec);
                return { resource: r, score };
              })
              .sort((a, b) => b.score - a.score)
              .slice(0, limit);

            return ok({
              results: scored.map(s => ({
                ...resourceToJson(s.resource),
                relevance_score: Math.round(s.score * 1000) / 1000,
              })),
              search_mode: 'vector',
              total: scored.length,
            });
          }
        }
      }

      // Fallback: text search
      const q = query.toLowerCase();
      const scored = resources
        .map(r => {
          let score = 0;
          if (r.name.toLowerCase().includes(q)) score += 3;
          if (r.description.toLowerCase().includes(q)) score += 2;
          if (r.content.toLowerCase().includes(q)) score += 1;
          if (r.url.toLowerCase().includes(q)) score += 1;
          const tags = parseResourceTags(r);
          if (tags.some((t: string) => t.toLowerCase().includes(q))) score += 2;
          return { resource: r, score };
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return ok({
        results: scored.map(s => ({
          ...resourceToJson(s.resource),
          relevance_score: s.score,
        })),
        search_mode: 'text',
        total: scored.length,
      });
    }
  );

  server.tool(
    'embed_resources',
    'Trigger embedding generation for all resources in a workspace that do not yet have embeddings. ' +
    'Requires EMBEDDING_PROVIDER and OPENAI_API_KEY environment variables to be configured. ' +
    'Returns the count of newly embedded resources.',
    {
      workspace_id: z.string().describe('Workspace ID'),
    },
    async ({ workspace_id }) => {
      if (!(await isEmbeddingEnabled())) {
        return err('Embedding not configured. Set EMBEDDING_PROVIDER=openai and OPENAI_API_KEY env vars.');
      }
      const repo = AppDataSource.getRepository(Resource);
      const resources = await repo.find({ where: { workspace_id } });
      let embedded = 0;
      for (const resource of resources) {
        try {
          await embedResource(resource);
          embedded++;
        } catch (e: any) {
          mcpToolsLog(`Failed to embed resource ${resource.id}: ${e.message}`);
        }
      }
      return ok({ success: true, total: resources.length, embedded });
    }
  );

  // ─── GitHub Connector ─────────────────────────────────────────

  server.tool(
    'fetch_github_info',
    'Fetch metadata about a GitHub repository (description, README, file tree, topics). ' +
    'Uses credential_id for auth if provided, otherwise falls back to global GitHub token.',
    {
      url: z.string().optional().describe('GitHub repository URL (e.g. https://github.com/owner/repo)'),
      owner: z.string().optional().describe('Repository owner (alternative to url)'),
      repo: z.string().optional().describe('Repository name (alternative to url)'),
      credential_id: z.string().optional().describe('Credential ID from workspace credentials (overrides global token)'),
    },
    async ({ url, owner, repo, credential_id }) => {
      if (!(await isGitHubEnabled(credential_id))) {
        return err('GitHub token not configured. Add a credential or set global token in Admin Settings.');
      }
      let o = owner;
      let r = repo;
      if (url) {
        const parsed = parseGitHubUrl(url);
        if (!parsed) return err('Invalid GitHub URL. Expected format: https://github.com/owner/repo');
        o = parsed.owner;
        r = parsed.repo;
      }
      if (!o || !r) return err('Provide either url or both owner and repo');

      try {
        const info = await fetchRepoInfo(o, r, credential_id);
        return ok(info);
      } catch (e: any) {
        return err(`GitHub API error: ${e.message}`);
      }
    }
  );

  server.tool(
    'sync_github_resource',
    'Sync a GitHub repository into a resource. Fetches repo metadata, README, and file tree, ' +
    'stores them as resource content, and auto-embeds for vector search. ' +
    'If resource_id is provided, updates the existing resource; otherwise creates a new one. ' +
    'Uses credential_id for auth if provided.',
    {
      workspace_id: z.string().describe('Workspace ID'),
      url: z.string().describe('GitHub repository URL'),
      resource_id: z.string().optional().describe('Existing resource ID to update (omit to create new)'),
      board_id: z.string().optional().describe('Board ID for board-scoped resource'),
      credential_id: z.string().optional().describe('Credential ID for GitHub auth (overrides global token)'),
    },
    async ({ workspace_id, url, resource_id, board_id, credential_id }) => {
      if (!(await isGitHubEnabled(credential_id))) {
        return err('GitHub token not configured. Add a credential or set global token in Admin Settings.');
      }
      const parsed = parseGitHubUrl(url);
      if (!parsed) return err('Invalid GitHub URL');

      let info;
      try {
        info = await fetchRepoInfo(parsed.owner, parsed.repo, credential_id);
      } catch (e: any) {
        return err(`GitHub API error: ${e.message}`);
      }

      const resourceRepo = AppDataSource.getRepository(Resource);
      const content = buildSyncContent(info);
      const tags = [...info.topics];
      if (info.language && !tags.includes(info.language.toLowerCase())) {
        tags.push(info.language.toLowerCase());
      }

      if (resource_id) {
        const existing = await resourceRepo.findOne({ where: { id: resource_id, workspace_id } });
        if (!existing) return err('Resource not found in workspace');
        existing.name = info.full_name;
        existing.description = info.description;
        existing.type = 'repository';
        existing.url = info.html_url;
        existing.content = content;
        existing.tags = JSON.stringify(tags);
        if (credential_id) existing.credential_id = credential_id;
        const saved = await resourceRepo.save(existing);
        embedResource(saved).catch(() => {});
        mcpToolsLog(`Synced GitHub repo ${info.full_name} → resource ${saved.id}`);
        return ok(resourceToJson(saved));
      }

      const created = resourceRepo.create({
        workspace_id,
        board_id: board_id || null,
        credential_id: credential_id || null,
        name: info.full_name,
        description: info.description,
        type: 'repository',
        url: info.html_url,
        content,
        file_data: '',
        file_name: '',
        file_mimetype: '',
        tags: JSON.stringify(tags),
      });
      const saved = await resourceRepo.save(created);
      embedResource(saved).catch(() => {});
      mcpToolsLog(`Created GitHub resource ${info.full_name} → ${saved.id}`);
      return ok(resourceToJson(saved));
    }
  );

  server.tool(
    'search_github',
    'Search GitHub for repositories, code, or issues using the GitHub Search API. ' +
    'Uses credential_id for auth if provided, otherwise falls back to global token.',
    {
      query: z.string().describe('Search query (uses GitHub search syntax, e.g. "react language:typescript stars:>100")'),
      scope: z.enum(['repositories', 'code', 'issues']).default('repositories')
        .describe('What to search: repositories, code, or issues'),
      per_page: z.number().optional().default(10).describe('Results per page (max 30, default 10)'),
      sort: z.string().optional().describe('Sort field — repos: stars/forks/updated; issues: created/updated/comments'),
      credential_id: z.string().optional().describe('Credential ID for GitHub auth (overrides global token)'),
    },
    async ({ query, scope, per_page, sort, credential_id }) => {
      if (!(await isGitHubEnabled(credential_id))) {
        return err('GitHub token not configured. Add a credential or set global token in Admin Settings.');
      }
      const limit = Math.min(per_page ?? 10, 30);
      try {
        if (scope === 'code') {
          const results = await searchGitHubCode(query, { per_page: limit, credential_id });
          return ok({ scope: 'code', total_count: results.total_count, items: results.items });
        }
        if (scope === 'issues') {
          const results = await searchGitHubIssues(query, { per_page: limit, sort, credential_id });
          return ok({ scope: 'issues', total_count: results.total_count, items: results.items });
        }
        const results = await searchGitHubRepos(query, { per_page: limit, sort, credential_id });
        return ok({ scope: 'repositories', total_count: results.total_count, items: results.items });
      } catch (e: any) {
        return err(`GitHub search error: ${e.message}`);
      }
    }
  );
}
