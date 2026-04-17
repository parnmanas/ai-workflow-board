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
// Resource helpers (C13) — still needed by sync_github_resource in the
// remaining monolith until GitHub tools migrate in C14.
import { resourceToJson, embedResource as sharedEmbedResource } from './shared/resource-helpers';

// Bridge wrappers so pre-existing call sites keep working until their
// domain migration. Removed at the C16 shim-reduction step.
async function embedResource(resource: Resource) {
  return sharedEmbedResource(AppDataSource, _logger, resource);
}

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

  // Workspace tools moved to tools/workspace-tools.ts (Phase 3 C2).

  // Board tools moved to tools/board-tools.ts (Phase 3 C3).

  // Column tools moved to tools/column-tools.ts (Phase 3 C4).

  // Ticket + child-ticket tools moved to tools/ticket-tools.ts (Phase 3 C5).

  // Comment tools moved to tools/comment-tools.ts (Phase 3 C6).

  // Activity tools moved to tools/activity-tools.ts (Phase 3 C7).

  // User tools (incl. whoami) moved to tools/user-tools.ts (Phase 3 C8).

  // Agent + prompt-template + ping tools moved to tools/agent-tools.ts (Phase 3 C9).

  // set_typing + chat-room tools moved to tools/chat-tools.ts (Phase 3 C10).

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

  // API key tools moved to tools/api-key-tools.ts (Phase 3 C11).

  // Trigger + event-subscription tools moved to tools/trigger-tools.ts (Phase 3 C12).

  // Resource tools moved to tools/resource-tools.ts (Phase 3 C13).

  // GitHub tools moved to tools/github-tools.ts (Phase 3 C14).

}
