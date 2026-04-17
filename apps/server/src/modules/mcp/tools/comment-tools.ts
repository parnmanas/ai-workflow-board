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
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerCommentTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService } = ctx;

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

      return ok(comment);
    }
  );
}
