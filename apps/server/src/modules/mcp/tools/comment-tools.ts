/**
 * Comment MCP tools.
 *
 * Tools: add_comment, ask_question, answer_question, record_decision
 *
 * The three typed-intent tools (ask_question / answer_question / record_decision)
 * are thin wrappers around the same Comment.save() that add_comment uses, but
 * they pin the `type` discriminator at the tool boundary so the agent's intent
 * is encoded in the call itself. This makes prompt design clearer than
 * "use add_comment with type='question'" and avoids agents drifting back to
 * type='note' by forgetting to pass the field.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { Comment, CommentType, COMMENT_TYPES } from '../../../entities/Comment';
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
    'Add a comment to a ticket. When authenticated as an agent, author fields are auto-filled if omitted. ' +
      'Optional `type`/`parent_id`/`metadata` mirror the REST endpoint so an agent can post note/chat/handoff/etc. ' +
      'directly without falling back to the more opinionated ask_question/answer_question/record_decision tools. ' +
      'type=\'system\' is reserved for SystemCommentService and rejected here.',
    {
      ticket_id: z.string().describe('Ticket ID'),
      author_type: z.enum(['user', 'agent']).optional().describe('Comment author type (auto-detected from auth)'),
      author_id: z.string().optional().describe('Author ID (auto-filled from auth if omitted)'),
      author: z.string().optional().describe('Display name (auto-resolved from auth/ID if omitted)'),
      content: z.string().describe('Comment content'),
      type: z.enum(['note', 'question', 'answer', 'decision', 'chat', 'handoff']).optional()
        .describe("Comment type discriminator (default 'note'). type='answer' requires parent_id and auto-resolves the parent question."),
      parent_id: z.string().optional()
        .describe("Parent comment id for threading. Must belong to the same ticket. Required for type='answer'."),
      metadata: z.record(z.string(), z.unknown()).optional()
        .describe('Type-specific extension bag (e.g. handoff target_agent_id, decision references[]). Stored as JSON on the row.'),
    },
    async ({ ticket_id, author_type, author_id, author, content, type, parent_id, metadata }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      // Validate type — REST endpoint shape parity. Zod already restricts to the
      // allowed enum, but we also reject 'system' explicitly so an agent can't
      // forge audit-log entries by claiming type=system.
      if (type !== undefined && !COMMENT_TYPES.includes(type as CommentType)) {
        return err(`Unsupported comment type: ${type}`);
      }
      const resolvedType: CommentType = (type as CommentType | undefined) || 'note';
      if (resolvedType === 'system') {
        return err("type='system' is reserved for SystemCommentService");
      }

      // Validate parent_id (when given): must exist and belong to the same ticket.
      const commentRepo = dataSource.getRepository(Comment);
      let resolvedParentId: string | null = null;
      if (parent_id) {
        const parent = await commentRepo.findOne({ where: { id: parent_id } });
        if (!parent) return err('parent_id references a non-existent comment');
        if (parent.ticket_id !== ticket_id) return err('parent comment belongs to a different ticket');
        resolvedParentId = parent.id;
      }
      if (resolvedType === 'answer' && !resolvedParentId) {
        return err("type='answer' requires parent_id pointing to the question being answered");
      }

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

      const comment = await commentRepo.save(commentRepo.create({
        ticket_id,
        author_type: resolvedAuthorType,
        author_id: resolvedAuthorId,
        author: authorName,
        content,
        type: resolvedType,
        status: resolvedType === 'question' ? 'open' : null,
        parent_id: resolvedParentId,
        metadata: JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
      }));

      // Auto-resolve parent question on answer — same idempotent flip the REST
      // endpoint and answer_question tool perform, so all three surfaces agree.
      if (resolvedType === 'answer' && resolvedParentId) {
        await commentRepo.update({ id: resolvedParentId }, { status: 'resolved' });
      }

      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolvedAuthorId, actor_name: authorName,
        new_value: content,
        field_changed: resolvedType,
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

  // ─── Helper: resolve caller identity (auth + author resolution) ────
  // Centralizes the auto-fill logic that all 4 tools share. Returns the
  // resolved {authorType, authorId, authorName} or an error tuple.
  async function resolveAuthor(
    requestedType: 'user' | 'agent' | undefined,
    requestedId: string | undefined,
    requestedName: string | undefined,
    extra: { sessionId?: string },
  ): Promise<{ authorType: 'user' | 'agent'; authorId: string; authorName: string } | { error: string }> {
    const caller = getCallerAgent(extra);
    const authorType = requestedType || (caller?.agentId ? 'agent' : 'user');
    const authorId = requestedId || caller?.agentId || '';
    if (!authorId) return { error: 'author_id is required (or authenticate with an agent API key)' };

    let authorName = requestedName || '';
    if (!authorName) {
      if (authorType === 'agent') {
        if (caller?.agentName && caller?.agentId === authorId) {
          authorName = caller.agentName;
        } else {
          const agent = await dataSource.getRepository(Agent).findOne({ where: { id: authorId } });
          authorName = agent?.name || `Agent #${authorId}`;
        }
      } else {
        const user = await dataSource.getRepository(User).findOne({ where: { id: authorId } });
        authorName = user?.name || `User #${authorId}`;
      }
    }
    return { authorType, authorId, authorName };
  }

  // ─── ask_question ────────────────────────────────────────────────
  server.tool(
    'ask_question',
    'Ask a question on a ticket — creates a comment with type=question, status=open. The ticket assignee/reporter (or @mentioned user) is notified. Use this when you are blocked and need a human answer before continuing; the ticket detail UI surfaces the open question prominently.',
    {
      ticket_id: z.string().describe('Ticket ID the question is about'),
      content: z.string().describe('Question body. Plain text or markdown. Embed @[user:id|Name] tokens to direct the question at a specific user.'),
      author_type: z.enum(['user', 'agent']).optional().describe('Author type (auto-detected from auth)'),
      author_id: z.string().optional().describe('Author ID (auto-filled from auth if omitted)'),
      author: z.string().optional().describe('Display name (auto-resolved if omitted)'),
    },
    async ({ ticket_id, content, author_type, author_id, author }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);

      const commentRepo = dataSource.getRepository(Comment);
      const comment = await commentRepo.save(commentRepo.create({
        ticket_id,
        author_type: resolved.authorType,
        author_id: resolved.authorId,
        author: resolved.authorName,
        content,
        type: 'question' as CommentType,
        status: 'open',
      }));

      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
        new_value: content, field_changed: 'question',
      });

      // Mention dispatch — same logic as the REST + add_comment paths so an
      // ask_question with @[user:...|Name] reaches the inbox + sidebar badge.
      try {
        const refs = mentionService.parseMentions(content);
        if (refs.length > 0) {
          const resolvedRefs = mentionService.resolveMentions(refs, ticket);
          const preview = (content || '').slice(0, 500);
          const ts = (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString();
          const userMentionRepo = dataSource.getRepository(UserMention);
          for (const m of resolvedRefs) {
            if (m.type === 'agent') {
              const agent = await dataSource.getRepository(Agent).findOne({ where: { id: m.id } });
              if (!agent) continue;
              if (agent.workspace_id && ticket.workspace_id && agent.workspace_id !== ticket.workspace_id) continue;
              activityEvents.emit('comment_mention', {
                ticket_id: ticket.id, comment_id: comment.id, workspace_id: ticket.workspace_id,
                agent_id: agent.id,
                actor_id: resolved.authorId, actor_type: resolved.authorType, actor_name: resolved.authorName,
                content, role_prompt: agent.role_prompt || '',
                mention_source: m.roleShortcut ? 'role' : 'direct', role_shortcut: m.roleShortcut,
                timestamp: ts,
              });
            } else {
              const row = await userMentionRepo.save(userMentionRepo.create({
                user_id: m.id, workspace_id: ticket.workspace_id,
                source_type: 'comment', source_id: comment.id,
                ticket_id: ticket.id, room_id: null,
                actor_id: resolved.authorId, actor_type: resolved.authorType, actor_name: resolved.authorName,
                preview,
              }));
              activityEvents.emit('user_mention', {
                mention_id: row.id, user_id: row.user_id, workspace_id: row.workspace_id,
                source_type: 'comment', source_id: comment.id,
                ticket_id: ticket.id, room_id: null,
                actor_id: resolved.authorId, actor_type: resolved.authorType, actor_name: resolved.authorName,
                preview,
                created_at: (row.created_at instanceof Date ? row.created_at : new Date()).toISOString(),
              });
            }
          }
        }
      } catch (e) {
        logger.warn('Mentions', `ask_question mention dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      return ok(comment);
    }
  );

  // ─── answer_question ─────────────────────────────────────────────
  server.tool(
    'answer_question',
    'Answer a previously-asked question. Creates a comment with type=answer and parent_id pointing at the question; the parent question auto-resolves so the ticket no longer shows it as open. The original question must exist on the same ticket and have type=question.',
    {
      question_comment_id: z.string().describe("ID of the question comment being answered (Comment.id where type='question')"),
      content: z.string().describe('Answer body. Plain text or markdown.'),
      author_type: z.enum(['user', 'agent']).optional(),
      author_id: z.string().optional(),
      author: z.string().optional(),
    },
    async ({ question_comment_id, content, author_type, author_id, author }, extra: { sessionId?: string }) => {
      const commentRepo = dataSource.getRepository(Comment);
      const question = await commentRepo.findOne({ where: { id: question_comment_id } });
      if (!question) return err('Question comment not found');
      if (question.type !== 'question') return err('Parent comment is not a question');

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);

      const answer = await commentRepo.save(commentRepo.create({
        ticket_id: question.ticket_id,
        author_type: resolved.authorType,
        author_id: resolved.authorId,
        author: resolved.authorName,
        content,
        type: 'answer' as CommentType,
        parent_id: question.id,
      }));

      // Idempotent flip — even if a prior answer already resolved it, this
      // matches the REST endpoint's behavior so the two paths agree.
      await commentRepo.update({ id: question.id }, { status: 'resolved' });

      await activityService.logActivity({
        entity_type: 'comment', entity_id: answer.id, action: 'created',
        ticket_id: question.ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
        new_value: content, field_changed: 'answer',
      });

      return ok(answer);
    }
  );

  // ─── record_decision ─────────────────────────────────────────────
  server.tool(
    'record_decision',
    'Record a decision on a ticket — creates a comment with type=decision. Use this for resolved trade-offs, scope choices, or anything future readers should be able to find without scrolling the full discussion. Decisions render with a distinctive style and survive comment-filter toggles by default.',
    {
      ticket_id: z.string().describe('Ticket ID'),
      content: z.string().describe('Decision text. Phrase as a statement: "We will use X because Y".'),
      references: z.array(z.string()).optional().describe('Optional comment ids the decision draws from (stored in metadata.references for later traceability).'),
      author_type: z.enum(['user', 'agent']).optional(),
      author_id: z.string().optional(),
      author: z.string().optional(),
    },
    async ({ ticket_id, content, references, author_type, author_id, author }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);

      const commentRepo = dataSource.getRepository(Comment);
      const comment = await commentRepo.save(commentRepo.create({
        ticket_id,
        author_type: resolved.authorType,
        author_id: resolved.authorId,
        author: resolved.authorName,
        content,
        type: 'decision' as CommentType,
        metadata: JSON.stringify(references && references.length > 0 ? { references } : {}),
      }));

      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
        new_value: content, field_changed: 'decision',
      });

      return ok(comment);
    }
  );

  // ─── handoff_to_agent ────────────────────────────────────────────
  // Tier-1 D. Reassign a ticket to another agent and leave a typed
  // handoff comment in one tool call. Without this, agents had to call
  // update_ticket (assignee change) and add_comment separately and
  // hope the receiver could thread them together. The handoff comment
  // type renders distinctively in the timeline and the comment_mention
  // event lets the receiving agent's proxy spawn a subagent immediately
  // with the handoff context — the assignee-change trigger that fires
  // soon after carries no human-readable explanation, so the mention
  // fills the "why am I picking this up?" gap.
  server.tool(
    'handoff_to_agent',
    'Hand a ticket off to another agent. Reassigns the ticket (assignee role only — reporter/reviewer remain unchanged) AND posts a type=handoff comment so the receiver sees both the ticket and the human-readable rationale. The receiving agent gets a comment_mention event so their proxy can react immediately; the standard assignee-change trigger still fires so existing routing logic continues to work.',
    {
      ticket_id: z.string().describe('Ticket ID being handed off'),
      target_agent_id: z.string().describe("ID of the Agent the ticket is being assigned to"),
      content: z.string().describe('Handoff rationale. Why is the receiver picking this up? What context do they need? Plain text or markdown.'),
      author_type: z.enum(['user', 'agent']).optional(),
      author_id: z.string().optional(),
      author: z.string().optional(),
    },
    async ({ ticket_id, target_agent_id, content, author_type, author_id, author }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      const agentRepo = dataSource.getRepository(Agent);
      const targetAgent = await agentRepo.findOne({ where: { id: target_agent_id } });
      if (!targetAgent) return err('target_agent_id refers to an unknown agent');
      // Cross-workspace handoff would silently leak ticket context to an
      // agent whose API key lives in a different workspace boundary; refuse.
      if (targetAgent.workspace_id && ticket.workspace_id && targetAgent.workspace_id !== ticket.workspace_id) {
        return err('Target agent is in a different workspace than the ticket');
      }

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);

      // Snapshot the previous assignee BEFORE the swap so the handoff
      // metadata records who passed the baton (useful for audit trails
      // and for the receiver to acknowledge the prior owner).
      const previousAssigneeId = ticket.assignee_id || '';
      const previousAssigneeName = ticket.assignee || '';

      // Self-handoff is a no-op assignment but a valid comment surface
      // (e.g., "I'm picking this back up after the deploy completed");
      // we don't refuse but we also don't churn the assignee row.
      const isSameAssignee = previousAssigneeId === target_agent_id;

      // 1. Save handoff comment first so the activity dispatch + mention
      //    event reference an existing comment row.
      const commentRepo = dataSource.getRepository(Comment);
      const comment = await commentRepo.save(commentRepo.create({
        ticket_id,
        author_type: resolved.authorType,
        author_id: resolved.authorId,
        author: resolved.authorName,
        content,
        type: 'handoff' as CommentType,
        metadata: JSON.stringify({
          target_agent_id,
          target_agent_name: targetAgent.name,
          previous_assignee_id: previousAssigneeId || null,
          previous_assignee_name: previousAssigneeName || null,
          role: 'assignee',
        }),
      }));

      // 2. Reassign ticket. Skip the write if it would be a no-op so we
      //    don't fire a spurious assignee_changed activity.
      if (!isSameAssignee) {
        ticket.assignee_id = target_agent_id;
        ticket.assignee = targetAgent.name;
        await ticketRepo.save(ticket);

        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'assignee',
          old_value: previousAssigneeName || '',
          new_value: targetAgent.name,
          ticket_id: ticket.parent_id || ticket.id,
          actor_id: resolved.authorId, actor_name: resolved.authorName,
        });
      }

      // 3. Activity for the comment itself — same shape as record_decision /
      //    ask_question so the inbox feed treats it consistently.
      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
        new_value: content, field_changed: 'handoff',
      });

      // 4. comment_mention to the target agent so the proxy spawns a
      //    subagent NOW with the handoff content rather than waiting for
      //    the next assignee-trigger cycle.
      const ts = (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString();
      activityEvents.emit('comment_mention', {
        ticket_id: ticket.id,
        comment_id: comment.id,
        workspace_id: ticket.workspace_id,
        agent_id: targetAgent.id,
        actor_id: resolved.authorId,
        actor_type: resolved.authorType,
        actor_name: resolved.authorName,
        content,
        role_prompt: targetAgent.role_prompt || '',
        mention_source: 'direct',
        timestamp: ts,
      });
      logger.info('Handoff', `Ticket ${ticket.id} handed to agent ${targetAgent.name} (${targetAgent.id}) by ${resolved.authorName}`);

      return ok({ comment, ticket: { id: ticket.id, assignee_id: ticket.assignee_id, assignee: ticket.assignee } });
    }
  );
}
