/**
 * Comment MCP tools.
 *
 * Tools: add_comment
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { Comment } from '../../../entities/Comment';
import { Ticket } from '../../../entities/Ticket';
import { User } from '../../../entities/User';
import { UserMention } from '../../../entities/UserMention';
import { activityEvents } from '../../../services/activity.service';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerCommentTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, mentionService, logger } = ctx;

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
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
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
            const agent = await dataSource.getRepository(Agent).findOne({ where: { id: resolvedAuthorId } });
            authorName = agent?.name || `Agent #${resolvedAuthorId}`;
          }
        } else {
          const user = await dataSource.getRepository(User).findOne({ where: { id: resolvedAuthorId } });
          authorName = user?.name || `User #${resolvedAuthorId}`;
        }
      }

      const commentRepo = dataSource.getRepository(Comment);
      const comment = await commentRepo.save(commentRepo.create({
        ticket_id, author_type: resolvedAuthorType, author_id: resolvedAuthorId, author: authorName, content,
      }));

      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolvedAuthorId, actor_name: authorName,
        new_value: content,
      });

      // Dispatch @-mentions just like the REST path
      // (tickets.controller._dispatchCommentMentions). Without this, a
      // subagent adding a comment via MCP with `@[agent:...|Name]` tokens
      // would only fire the ambient board_update — the target agent
      // never receives the targeted `comment_mention` event and so the
      // mention silently degrades to an update.
      try {
        const refs = mentionService.parseMentions(content);
        if (refs.length > 0) {
          const resolved = mentionService.resolveMentions(refs, ticket);
          const preview = (content || '').slice(0, 500);
          const ts = (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString();
          const userMentionRepo = dataSource.getRepository(UserMention);
          for (const m of resolved) {
            if (m.type === 'agent') {
              const agent = await dataSource.getRepository(Agent).findOne({ where: { id: m.id } });
              if (!agent) continue;
              // Same workspace-scope safety as the REST path.
              if (agent.workspace_id && ticket.workspace_id && agent.workspace_id !== ticket.workspace_id) continue;
              activityEvents.emit('comment_mention', {
                ticket_id: ticket.id,
                comment_id: comment.id,
                workspace_id: ticket.workspace_id,
                agent_id: agent.id,
                actor_id: resolvedAuthorId,
                actor_type: resolvedAuthorType,
                actor_name: authorName,
                content,
                role_prompt: agent.role_prompt || '',
                mention_source: m.roleShortcut ? 'role' : 'direct',
                role_shortcut: m.roleShortcut,
                timestamp: ts,
              });
              logger.info('Mentions', `Agent @-mention routed via MCP add_comment: ${agent.name} (${agent.id}) on ticket ${ticket.id}`);
            } else {
              const row = await userMentionRepo.save(userMentionRepo.create({
                user_id: m.id,
                workspace_id: ticket.workspace_id,
                source_type: 'comment',
                source_id: comment.id,
                ticket_id: ticket.id,
                room_id: null,
                actor_id: resolvedAuthorId,
                actor_type: resolvedAuthorType,
                actor_name: authorName,
                preview,
              }));
              activityEvents.emit('user_mention', {
                mention_id: row.id,
                user_id: row.user_id,
                workspace_id: row.workspace_id,
                source_type: 'comment',
                source_id: comment.id,
                ticket_id: ticket.id,
                room_id: null,
                actor_id: resolvedAuthorId,
                actor_type: resolvedAuthorType,
                actor_name: authorName,
                preview,
                created_at: (row.created_at instanceof Date ? row.created_at : new Date()).toISOString(),
              });
              logger.info('Mentions', `User @-mention recorded via MCP add_comment: user ${row.user_id} on ticket ${ticket.id}`);
            }
          }
        }
      } catch (e) {
        // Never fail the comment save because mention dispatch blew up.
        logger.warn('Mentions', `MCP add_comment mention dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      return ok(comment);
    }
  );
}
