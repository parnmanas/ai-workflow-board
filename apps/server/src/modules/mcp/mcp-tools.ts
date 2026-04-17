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

  // Workspace tools moved to tools/workspace-tools.ts (Phase 3 C2).

  // Board tools moved to tools/board-tools.ts (Phase 3 C3).

  // Column tools moved to tools/column-tools.ts (Phase 3 C4).

  // Ticket + child-ticket tools moved to tools/ticket-tools.ts (Phase 3 C5).

  // Comment tools moved to tools/comment-tools.ts (Phase 3 C6).

  // Activity tools moved to tools/activity-tools.ts (Phase 3 C7).

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
