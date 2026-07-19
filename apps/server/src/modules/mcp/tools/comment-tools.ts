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
import { In } from 'typeorm';
import { Agent } from '../../../entities/Agent';
import { Comment, CommentType, COMMENT_TYPES } from '../../../entities/Comment';
import { Ticket } from '../../../entities/Ticket';
import { User } from '../../../entities/User';
import { UserMention } from '../../../entities/UserMention';
import { Resource } from '../../../entities/Resource';
import { activityEvents } from '../../../services/activity.service';
import { ok, err, MENTION_SYNTAX_DOC, sanitizeHarnessMarkers } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { TicketArchivedError, isTerminalColumn } from '../shared/archive-helpers';
import { detectDeferralToTerminal, formatDeferralTerminalWarning } from '../shared/deferral-terminal-guard';
import { findColumnByName } from '../shared/ticket-helpers';
import { resolveAgentDisplayName } from '../../../utils/agent-name';
import { resolveAuthorRole as resolveAuthorRoleImpl, mergeAuthorRoleIntoMetadata } from './author-role';
import { BoardColumn } from '../../../entities/BoardColumn';
import { buildConsensusMetadata, buildProposalMetadata } from '../../../common/consensus-state';
import { getConsensusState, findOpenProposal } from '../../../services/consensus.service';
import { buildConsensusUpdatePayload, autoExecuteConsensusMove } from '../../../services/consensus-actions';
import type { ToolContext } from './context';
import { applyAgentCommentPingPongGuard } from '../../../common/agent-comment-pingpong';

export function registerCommentTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, mentionService, logger, ticketRoleAssignmentService } = ctx;

  // `resolveAuthorRole` / `mergeAuthorRoleIntoMetadata` live in ./author-role
  // so their resolution-order contract is unit-testable (ticket ed07eeeb).
  // This thin wrapper binds the closure's `ticketRoleAssignmentService` so the
  // five call sites below keep their original argument list.
  const resolveAuthorRole = (
    ticketId: string,
    requestedRole: string | undefined,
    authorType: 'user' | 'agent',
    authorId: string,
    sessionRole: string | undefined,
    sessionTicketId: string | undefined,
  ): Promise<string | null> =>
    resolveAuthorRoleImpl(
      ticketRoleAssignmentService,
      ticketId,
      requestedRole,
      authorType,
      authorId,
      sessionRole,
      sessionTicketId,
    );

  server.tool(
    'add_comment',
    'Add a comment to a ticket. When authenticated as an agent, author fields are auto-filled if omitted. ' +
      'Optional `type`/`parent_id`/`metadata` mirror the REST endpoint so an agent can post note/chat/handoff/etc. ' +
      'directly without falling back to the more opinionated ask_question/answer_question/record_decision tools. ' +
      'type=\'system\' is reserved for SystemCommentService and rejected here.\n\n' +
      MENTION_SYNTAX_DOC,
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
      author_role: z.string().optional()
        .describe("Role the comment is authored as (e.g. 'assignee', 'reviewer'). Auto-filled from the subagent session pin or from TicketRoleAssignment when omitted. Stored on metadata.author_role so the UI can render which role spoke."),
      attachment_resource_ids: z.array(z.string()).optional()
        .describe("Resource ids to attach. Each must already exist with type='comment_attachment' in the ticket's workspace — create them first via save_resource. MCP does not accept inline base64 here (cap payload size, keep upload/transaction logic in one place)."),
    },
    async ({ ticket_id, author_type, author_id, author, content, type, parent_id, metadata, author_role, attachment_resource_ids }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

      // Strip any `<system-reminder>…</system-reminder>` or sibling harness
      // markers a confused CLI subagent echoed from its model context into
      // the comment body (ticket ce6c8d58). Pre-resolve the caller for the
      // log line so we know which agent is leaking.
      const __callerForSanitize = getCallerAgent(extra);
      content = sanitizeHarnessMarkers(content, { logger, toolName: 'add_comment', fieldName: 'content', agentId: __callerForSanitize?.agentId });

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

      // Resolve author name if not provided. For agents always go through
      // `resolveAgentDisplayName` so the denormalized `author` snapshot picks
      // up the `<Manager>/<Agent>` prefix — `caller.agentName` carries only
      // the bare API-key name.
      let authorName = author || '';
      if (!authorName) {
        if (resolvedAuthorType === 'agent') {
          const display = await resolveAgentDisplayName(dataSource.getRepository(Agent), resolvedAuthorId);
          authorName = display || caller?.agentName || `Agent #${resolvedAuthorId}`;
        } else {
          const user = await dataSource.getRepository(User).findOne({ where: { id: resolvedAuthorId } });
          authorName = user?.name || `User #${resolvedAuthorId}`;
        }
      }

      // Validate any attachment_resource_ids so agents can't cross-workspace
      // or mistakenly wire a generic resource into a comment.
      const resolvedAttachmentIds: string[] = Array.isArray(attachment_resource_ids)
        ? attachment_resource_ids.filter((v): v is string => typeof v === 'string' && !!v)
        : [];
      if (resolvedAttachmentIds.length > 0) {
        const rows = await dataSource.getRepository(Resource).findBy({ id: In(resolvedAttachmentIds) } as any);
        const found = new Map(rows.map(r => [r.id, r]));
        for (const rid of resolvedAttachmentIds) {
          const r = found.get(rid);
          if (!r) return err(`attachment_resource_ids contains unknown id: ${rid}`);
          if (r.workspace_id !== ticket.workspace_id) return err(`attachment resource ${rid} belongs to a different workspace`);
          if (r.type !== 'comment_attachment') return err(`attachment resource ${rid} is type=${r.type}; expected comment_attachment`);
        }
      }

      const resolvedAuthorRole = await resolveAuthorRole(
        ticket_id,
        author_role,
        resolvedAuthorType,
        resolvedAuthorId,
        caller?.subagentRole,
        caller?.subagentTicketId,
      );
      const finalMetadata = mergeAuthorRoleIntoMetadata(metadata, resolvedAuthorRole);

      // Server-side primary guard. Pending tickets accept no further agent
      // comments; repeated terminal receipts are dropped before comment/SSE
      // creation. The manager repeats the terminal check as a replay safety net.
      const recentAgentComments = resolvedAuthorType === 'agent'
        ? await commentRepo.find({ where: { ticket_id }, order: { created_at: 'DESC' }, take: 20 })
        : [];
      const nextGuardComment = { author_type: resolvedAuthorType, content, metadata: finalMetadata };
      const guard = await applyAgentCommentPingPongGuard({
        ticket,
        next: nextGuardComment,
        recent: recentAgentComments,
        pend: async () => {
          ticket.pending_user_action = true;
          ticket.pending_reason = '작업 대상 부재 상태에서 동일 대기 확인이 반복되어 자동 중지되었습니다. 작업 대상을 지정한 뒤 pending을 해제하세요.';
          ticket.pending_set_at = new Date();
          ticket.pending_set_by = 'agent_comment_pingpong_guard';
          await dataSource.getRepository(Ticket).save(ticket);
          await activityService.logActivity({
            entity_type: 'ticket', entity_id: ticket.id, action: 'updated', ticket_id: ticket.id,
            field_changed: 'pending_user_action', old_value: 'false', new_value: 'true',
            actor_id: 'system', actor_name: 'agent_comment_pingpong_guard',
          });
        },
      });
      if (guard.suppressed) {
        return ok(guard);
      }

      // Deferral-to-terminal guard (ticket 9f2adfd0): FLAG — never block — when
      // this comment hands scope to an already-terminal ticket, so the deferring
      // agent notices at post time and the flag persists on the comment for
      // future readers. Non-blocking sibling of the terminal-reopen guard.
      let deferralWarning:
        | { message: string; targets: Array<{ id: string; title: string; column: string | null; archived: boolean }> }
        | null = null;
      try {
        const terminalTargets = await detectDeferralToTerminal(
          content,
          async (token) => {
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
            let t: Ticket | null = null;
            if (isUuid) {
              t = await dataSource.getRepository(Ticket).findOne({ where: { id: token } });
            } else {
              // 8-hex short id → unique prefix match; skip if ambiguous (2+ hits)
              // so a coincidental prefix collision never mislabels a ticket.
              const rows = await dataSource.getRepository(Ticket).createQueryBuilder('t')
                .where('LOWER(t.id) LIKE :p', { p: `${token.toLowerCase()}%` })
                .limit(2)
                .getMany();
              if (rows.length === 1) t = rows[0];
            }
            if (!t) return null;
            const col = t.column_id
              ? await dataSource.getRepository(BoardColumn).findOne({ where: { id: t.column_id } })
              : null;
            return {
              id: t.id,
              title: t.title,
              columnName: col?.name ?? null,
              isTerminal: isTerminalColumn(col),
              archived: !!t.archived_at,
            };
          },
          { selfTicketId: ticket_id },
        );
        if (terminalTargets.length > 0) {
          deferralWarning = {
            message: formatDeferralTerminalWarning(terminalTargets),
            targets: terminalTargets.map((t) => ({ id: t.id, title: t.title, column: t.columnName, archived: t.archived })),
          };
          // Persist the flag so the UI + future readers see it, not just the poster.
          finalMetadata.deferral_terminal_warning = deferralWarning;
          logger.warn(
            'DeferralGuard',
            `add_comment on ${ticket_id} defers to terminal ticket(s): ${terminalTargets.map((t) => t.id).join(', ')}`,
          );
        }
      } catch (e) {
        // Detection is advisory — never fail the comment write because it blew up.
        logger.warn('DeferralGuard', `deferral-terminal detection failed on ${ticket_id}: ${e instanceof Error ? e.message : String(e)}`);
      }

      const comment = await commentRepo.save(commentRepo.create({
        ticket_id,
        author_type: resolvedAuthorType,
        author_id: resolvedAuthorId,
        author: authorName,
        content,
        attachment_resource_ids: JSON.stringify(resolvedAttachmentIds),
        type: resolvedType,
        status: resolvedType === 'question' ? 'open' : null,
        parent_id: resolvedParentId,
        metadata: JSON.stringify(finalMetadata),
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
          // T3 self-exclusion: drop the comment author so `@[role:assignee]`
          // summons only the OTHER co-holders — never a comment_mention back
          // to yourself (recursive self-spawn guard, mirrors the T2 dispatch
          // per-holder self-guard).
          const resolved = await mentionService.resolveMentions(refs, ticket, {
            excludeActor: { type: resolvedAuthorType, id: resolvedAuthorId },
          });
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

      // Surface the deferral-to-terminal flag back to the poster in the tool
      // result (extra field — backward compatible) as well as persisting it on
      // the comment metadata above.
      if (deferralWarning) {
        return ok({ ...comment, deferral_terminal_warning: deferralWarning });
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
        const display = await resolveAgentDisplayName(dataSource.getRepository(Agent), authorId);
        authorName = display || caller?.agentName || `Agent #${authorId}`;
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
    'Ask a question on a ticket — creates a comment with type=question, status=open. The ticket assignee/reporter (or @mentioned user) is notified. Use this when you are blocked and need a human answer before continuing; the ticket detail UI surfaces the open question prominently.\n\n' +
    MENTION_SYNTAX_DOC,
    {
      ticket_id: z.string().describe('Ticket ID the question is about'),
      content: z.string().describe('Question body. Plain text or markdown. Embed @[user:id|Name] tokens to direct the question at a specific user.'),
      author_type: z.enum(['user', 'agent']).optional().describe('Author type (auto-detected from auth)'),
      author_id: z.string().optional().describe('Author ID (auto-filled from auth if omitted)'),
      author: z.string().optional().describe('Display name (auto-resolved if omitted)'),
      author_role: z.string().optional()
        .describe("Role the question is authored as. Auto-filled from subagent session pin or TicketRoleAssignment when omitted; stored on metadata.author_role."),
    },
    async ({ ticket_id, content, author_type, author_id, author, author_role }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);

      content = sanitizeHarnessMarkers(content, { logger, toolName: 'ask_question', fieldName: 'content', agentId: resolved.authorId });

      const commentRepo = dataSource.getRepository(Comment);
      const callerCtx = getCallerAgent(extra);
      const resolvedAuthorRole = await resolveAuthorRole(
        ticket_id, author_role, resolved.authorType, resolved.authorId,
        callerCtx?.subagentRole, callerCtx?.subagentTicketId,
      );
      const askMetadata = mergeAuthorRoleIntoMetadata(undefined, resolvedAuthorRole);
      const comment = await commentRepo.save(commentRepo.create({
        ticket_id,
        author_type: resolved.authorType,
        author_id: resolved.authorId,
        author: resolved.authorName,
        content,
        type: 'question' as CommentType,
        status: 'open',
        metadata: JSON.stringify(askMetadata),
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
          // T3 self-exclusion (see add_comment): the author never mentions
          // themselves via a role fan-out or a direct self `@[agent:…]`.
          const resolvedRefs = await mentionService.resolveMentions(refs, ticket, {
            excludeActor: { type: resolved.authorType, id: resolved.authorId },
          });
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
    'Answer a previously-asked question. Creates a comment with type=answer and parent_id pointing at the question; the parent question auto-resolves so the ticket no longer shows it as open. The original question must exist on the same ticket and have type=question.\n\n' +
    MENTION_SYNTAX_DOC,
    {
      question_comment_id: z.string().describe("ID of the question comment being answered (Comment.id where type='question')"),
      content: z.string().describe('Answer body. Plain text or markdown.'),
      author_type: z.enum(['user', 'agent']).optional(),
      author_id: z.string().optional(),
      author: z.string().optional(),
      author_role: z.string().optional()
        .describe("Role the answer is authored as. Auto-filled from subagent session pin or TicketRoleAssignment when omitted; stored on metadata.author_role."),
    },
    async ({ question_comment_id, content, author_type, author_id, author, author_role }, extra: { sessionId?: string }) => {
      const commentRepo = dataSource.getRepository(Comment);
      const question = await commentRepo.findOne({ where: { id: question_comment_id } });
      if (!question) return err('Question comment not found');
      if (question.type !== 'question') return err('Parent comment is not a question');
      // Refuse answers on archived tickets — the question + answer pair is a
      // mutation surface and the ticket is supposed to be read-only.
      const answerTicket = await dataSource.getRepository(Ticket).findOne({ where: { id: question.ticket_id } });
      if (answerTicket?.archived_at) return err(new TicketArchivedError(answerTicket.id).message);

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);

      content = sanitizeHarnessMarkers(content, { logger, toolName: 'answer_question', fieldName: 'content', agentId: resolved.authorId });

      const callerCtx = getCallerAgent(extra);
      const resolvedAuthorRole = await resolveAuthorRole(
        question.ticket_id, author_role, resolved.authorType, resolved.authorId,
        callerCtx?.subagentRole, callerCtx?.subagentTicketId,
      );
      const answerMetadata = mergeAuthorRoleIntoMetadata(undefined, resolvedAuthorRole);
      const answer = await commentRepo.save(commentRepo.create({
        ticket_id: question.ticket_id,
        author_type: resolved.authorType,
        author_id: resolved.authorId,
        author: resolved.authorName,
        content,
        type: 'answer' as CommentType,
        parent_id: question.id,
        metadata: JSON.stringify(answerMetadata),
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
    'Record a decision on a ticket — creates a comment with type=decision. Use this for resolved trade-offs, scope choices, or anything future readers should be able to find without scrolling the full discussion. Decisions render with a distinctive style and survive comment-filter toggles by default.\n\n' +
    MENTION_SYNTAX_DOC,
    {
      ticket_id: z.string().describe('Ticket ID'),
      content: z.string().describe('Decision text. Phrase as a statement: "We will use X because Y".'),
      references: z.array(z.string()).optional().describe('Optional comment ids the decision draws from (stored in metadata.references for later traceability).'),
      author_type: z.enum(['user', 'agent']).optional(),
      author_id: z.string().optional(),
      author: z.string().optional(),
      author_role: z.string().optional()
        .describe("Role the decision is recorded as. Auto-filled from subagent session pin or TicketRoleAssignment when omitted; stored on metadata.author_role."),
    },
    async ({ ticket_id, content, references, author_type, author_id, author, author_role }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);

      content = sanitizeHarnessMarkers(content, { logger, toolName: 'record_decision', fieldName: 'content', agentId: resolved.authorId });

      const commentRepo = dataSource.getRepository(Comment);
      const callerCtx = getCallerAgent(extra);
      const resolvedAuthorRole = await resolveAuthorRole(
        ticket_id, author_role, resolved.authorType, resolved.authorId,
        callerCtx?.subagentRole, callerCtx?.subagentTicketId,
      );
      const decisionMetadata = mergeAuthorRoleIntoMetadata(
        references && references.length > 0 ? { references } : undefined,
        resolvedAuthorRole,
      );
      const comment = await commentRepo.save(commentRepo.create({
        ticket_id,
        author_type: resolved.authorType,
        author_id: resolved.authorId,
        author: resolved.authorName,
        content,
        type: 'decision' as CommentType,
        metadata: JSON.stringify(decisionMetadata),
      }));

      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
        new_value: content, field_changed: 'decision',
      });

      return ok(comment);
    }
  );

  // ─── record_agreement (다중담당자·합의 T4) ──────────────────────────
  // 홀더가 특정 이동 제안(T5)에 대해 명시적 승인/이의 시그널을 남긴다. 코멘트에
  // metadata.consensus_vote=true 마커를 심어 (1) 트리거 루프의
  // `_commentSuppressesFanout` hook 이 이 코멘트로는 다른 홀더를 재디스패치하지
  // 않도록(승인이 또 승인을 부르는 self-echo 방지) 하고, (2) 판정 서비스가
  // 최신 시그널만 유효로 집계하게 한다. 순수 판정은 common/consensus-state.
  server.tool(
    'record_agreement',
    'Cast a formal multi-holder consensus signal (agree/object) on a ticket, so a gate can decide whether the current phase may advance. ' +
      'This is the T4 consensus vote — distinct from the free-form discussion notes co-holders exchange. ' +
      'The signal is stamped with metadata.consensus_vote so it does NOT re-dispatch the other holders (no approval-echo loop), ' +
      'and only your LATEST signal counts (re-call to change agree↔object). ' +
      'Consensus is satisfied when every holder of the current column\'s routing role(s) has an `agree` on the current move proposal; ' +
      'a newer proposal invalidates (stales) earlier signals. Reporters may `override` to force-pass (audit-logged).\n\n' +
      MENTION_SYNTAX_DOC,
    {
      ticket_id: z.string().describe('Ticket ID the signal is about'),
      status: z.enum(['agree', 'object']).describe("Your consensus signal on the current move proposal. 'agree' consents to advancing the phase; 'object' blocks it."),
      proposal_id: z.string().optional().describe('The move proposal (T5) this signal targets. Omit for a proposal-less signal — the most recently referenced proposal is used as the anchor.'),
      override: z.boolean().optional().describe('Reporter-only tie-break / force-pass. Honored ONLY when you currently hold the reporter role on this ticket; it is stamped and audit-logged, and forces consensus satisfied even over an objection.'),
      content: z.string().optional().describe('Optional rationale shown in the ticket timeline alongside the signal.'),
      author_type: z.enum(['user', 'agent']).optional(),
      author_id: z.string().optional(),
      author: z.string().optional(),
      author_role: z.string().optional()
        .describe('Role the signal is cast as. Auto-filled from subagent session pin or TicketRoleAssignment when omitted; stored on metadata.author_role.'),
    },
    async ({ ticket_id, status, proposal_id, override, content, author_type, author_id, author, author_role }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);

      const by = { type: resolved.authorType, id: resolved.authorId } as const;
      let proposalId = proposal_id && proposal_id.trim() ? proposal_id.trim() : null;
      // T5 UX: proposal_id 생략 시 최신 열린 이동 제안을 앵커로 자동 채택 → 홀더는
      // record_agreement(agree) 만 호출해도 현재 제안에 투표된다. 열린 제안이 없으면
      // (예: 제안 없는 순수 T4 시그널) null 유지 → auto-execute 도 발동하지 않는다.
      if (!proposalId && ticketRoleAssignmentService) {
        try {
          const open = await findOpenProposal(dataSource, ticket_id);
          if (open) proposalId = open.proposalId;
        } catch {
          /* best-effort — 앵커 자동채택 실패는 명시 투표 흐름을 막지 않는다 */
        }
      }

      // override 게이트: reporter 홀더만 강제 통과할 수 있다. 판정 로직도
      // reporter 홀더의 override 만 인정하므로 잘못 켜도 무해하지만, 비-reporter
      // 시그널에 오해를 부르는 마커를 심지 않도록 여기서 걸러 낸다.
      let effectiveOverride = false;
      if (override === true && ticketRoleAssignmentService) {
        try {
          const grouped = await ticketRoleAssignmentService.resolveGroupedForTicket(ticket.id);
          const reporter = grouped.find((g) => g.role.slug === 'reporter');
          effectiveOverride = !!reporter?.holders.some((h) => h.type === by.type && h.id === by.id);
        } catch {
          effectiveOverride = false;
        }
      }

      const rationale = sanitizeHarnessMarkers(content || '', { logger, toolName: 'record_agreement', fieldName: 'content', agentId: resolved.authorId });
      const headline = `합의 시그널: ${status}${proposalId ? ` (제안 ${proposalId})` : ''}${effectiveOverride ? ' · reporter override' : ''}`;
      const body = rationale ? `${headline}\n\n${rationale}` : headline;

      // 마커(consensus_vote) + 구조화 payload + author_role 병합. 마커는
      // common/consensus-meta 단일 정의 → T2 hook 과 정합.
      const callerCtx = getCallerAgent(extra);
      const resolvedAuthorRole = await resolveAuthorRole(
        ticket_id, author_role, resolved.authorType, resolved.authorId,
        callerCtx?.subagentRole, callerCtx?.subagentTicketId,
      );
      const metadata = mergeAuthorRoleIntoMetadata(
        buildConsensusMetadata({ status, proposalId, by, override: effectiveOverride }),
        resolvedAuthorRole,
      );

      const commentRepo = dataSource.getRepository(Comment);
      const comment = await commentRepo.save(commentRepo.create({
        ticket_id,
        author_type: resolved.authorType,
        author_id: resolved.authorId,
        author: resolved.authorName,
        content: body,
        type: 'note' as CommentType,
        metadata: JSON.stringify(metadata),
      }));

      // 이 vote 반영 후 합의 상태 재판정(best-effort — 판정 실패가 시그널 저장을
      // 깨뜨리지 않게). 표준 컨텍스트(role-assignment 서비스 부재)면 생략 —
      // standalone 에는 소비할 라이브 컨슈머가 없다.
      let state: Awaited<ReturnType<typeof getConsensusState>> | null = null;
      if (ticketRoleAssignmentService) {
        try {
          state = await getConsensusState(
            { dataSource, ticketRoleAssignmentService },
            ticket,
            { proposalId },
          );
        } catch (e) {
          logger.warn('Consensus', `getConsensusState failed on record_agreement: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // activity 노출: 시그널 + 결과 상태. board_update SSE 가 field_changed=
      // 'consensus' 로 흘러 UI(T6)가 반응하고, get_ticket_activity 가 감사 트레일.
      const activityValue = JSON.stringify({
        status,
        proposal_id: proposalId,
        override: effectiveOverride,
        ...(state
          ? {
              satisfied: state.satisfied,
              required: state.required.length,
              agreed: state.agreed.length,
              objected: state.objected.length,
              pending: state.pending.length,
              proposal_anchor: state.proposalId,
            }
          : {}),
      });
      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
        new_value: activityValue, field_changed: 'consensus',
      });

      // consensus_update SSE(UI T6 소비). state 가 있을 때만 — standalone 은
      // 라이브 컨슈머가 없어 생략. board_update(위 activity)와 별개로 재판정
      // 결과를 구조화해 밀어 넣어 UI 가 재조회 없이 배지를 갱신하게 한다.
      if (state) {
        activityEvents.emit('consensus_update', buildConsensusUpdatePayload(ticket, state, {
          status,
          override: effectiveOverride,
          actorId: resolved.authorId,
          actorName: resolved.authorName,
          timestamp: (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString(),
        }));
      }

      // reporter override 감사 로그(DoD).
      if (effectiveOverride && state?.overriddenBy) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
          field_changed: 'consensus_override',
          new_value: `reporter ${resolved.authorName} forced consensus${proposalId ? ` on proposal ${proposalId}` : ''}`,
        });
      }

      // auto-execute (T5, 결정 2): 합의 성립 + 열린 제안 매칭 시 서버가 실제 이동.
      // consensus-actions.autoExecuteConsensusMove 로 단일화 — REST 투표 브릿지와
      // 동일한 부작용(원자 클레임 → performColumnMove, actor 'consensus' sentinel,
      // consensus_move 감사). best-effort: 이동 실패가 시그널 저장을 깨뜨리지 않게.
      let moved: { proposal_id: string; to_column_id: string; to_column_name: string | null } | null = null;
      if (state && ticketRoleAssignmentService) {
        try {
          const nowIso = (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString();
          moved = await autoExecuteConsensusMove(
            { dataSource, activityService, ticketRoleAssignmentService },
            ticket, state, nowIso, resolved.authorName,
          );
        } catch (e) {
          logger.warn('Consensus', `auto-execute move failed on record_agreement: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return ok({ comment, consensus: state, moved });
    }
  );

  // ─── propose_move (다중담당자·합의 T5) ───────────────────────────────
  // 다중홀더(≥2) 티켓의 컬럼 이동을 '제안'으로 연다. 제안 comment 의 id 가 곧
  // proposalId — 전 홀더가 record_agreement(agree) 로 이 제안에 동의하면 서버가
  // 자동 이동한다(auto-execute). 홀더 ≤1 이면 ceremony 불필요 → move_ticket 안내.
  // 제안 comment 는 vote 마커를 심지 않아 팬아웃되어 공동 홀더를 깨운다(투표 유도).
  server.tool(
    'propose_move',
    'Open a MOVE PROPOSAL to advance a MULTI-HOLDER ticket (its current column\'s routing role has ≥2 holders) to another column. ' +
      'The proposal comment\'s id IS the proposal_id: once EVERY routing-role holder casts record_agreement(agree) referencing it, the server AUTO-EXECUTES the move ' +
      '(position shift, branch-tip clear, terminal stamp — identical to move_ticket). A reporter may override to force-pass. ' +
      'If the routing role has ≤1 holder there is no consensus ceremony — call move_ticket directly instead. ' +
      'The proposal is deliberately NOT a consensus vote, so it fans out to wake the co-holders who must vote.\n\n' +
      MENTION_SYNTAX_DOC,
    {
      ticket_id: z.string().describe('Ticket ID to propose a move for'),
      target_column_id: z.string().optional().describe('Target column ID (use this OR target_column_name)'),
      target_column_name: z.string().optional().describe('Target column name (case-insensitive; requires board_id)'),
      board_id: z.string().optional().describe('Board ID (required when using target_column_name)'),
      content: z.string().optional().describe('Optional rationale shown in the ticket timeline alongside the proposal.'),
      author_type: z.enum(['user', 'agent']).optional(),
      author_id: z.string().optional(),
      author: z.string().optional(),
      author_role: z.string().optional()
        .describe('Role the proposal is authored as. Auto-filled from subagent session pin or TicketRoleAssignment when omitted; stored on metadata.author_role.'),
    },
    async ({ ticket_id, target_column_id, target_column_name, board_id, content, author_type, author_id, author, author_role }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

      if (!ticketRoleAssignmentService) {
        return err('propose_move requires the role-assignment service (unavailable in standalone MCP mode).');
      }

      // 대상 컬럼 해석(move_ticket 과 동일 규약).
      let destColumnId = target_column_id;
      if (!destColumnId && target_column_name) {
        if (!board_id) return err('board_id is required when using target_column_name');
        const col = await findColumnByName(dataSource, board_id, target_column_name);
        if (!col) return err(`Column "${target_column_name}" not found`);
        destColumnId = col.id;
      }
      if (!destColumnId) return err('Either target_column_id or target_column_name is required');
      if (destColumnId === ticket.column_id) return err('제안 대상이 현재 컬럼과 동일합니다 — 이동 제안이 아닙니다.');
      const destCol = await dataSource.getRepository(BoardColumn).findOne({ where: { id: destColumnId } });
      if (!destCol) return err('Target column not found');

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);
      const by = { type: resolved.authorType, id: resolved.authorId } as const;

      // 현재(이탈) 컬럼 라우팅 홀더 수 확인 — ≤1 이면 ceremony 불필요.
      const preState = await getConsensusState({ dataSource, ticketRoleAssignmentService }, ticket, {});
      if (preState.required.length < 2) {
        return err(
          `이 컬럼의 라우팅 역할 홀더가 ${preState.required.length}명입니다(≤1). ` +
          `합의 ceremony 가 불필요하니 move_ticket 으로 직접 이동하세요.`,
        );
      }

      // 제안 comment — id 가 곧 proposalId. vote 마커는 심지 않는다(팬아웃 유지 →
      // 공동 홀더를 깨워 투표하게). buildProposalMetadata + author_role 병합.
      const currentCol = ticket.column_id
        ? await dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } })
        : null;
      const rationale = sanitizeHarnessMarkers(content || '', { logger, toolName: 'propose_move', fieldName: 'content', agentId: resolved.authorId });
      const headline = `이동 제안: '${currentCol?.name ?? '—'}' → '${destCol.name}' (by ${resolved.authorName}). 전 홀더가 record_agreement(agree) 하면 서버가 자동 이동합니다.`;
      const body = rationale ? `${headline}\n\n${rationale}` : headline;

      const callerCtx = getCallerAgent(extra);
      const resolvedAuthorRole = await resolveAuthorRole(
        ticket_id, author_role, resolved.authorType, resolved.authorId,
        callerCtx?.subagentRole, callerCtx?.subagentTicketId,
      );
      const metadata = mergeAuthorRoleIntoMetadata(
        buildProposalMetadata({ targetColumnId: destCol.id, targetColumnName: destCol.name, by }),
        resolvedAuthorRole,
      );

      const commentRepo = dataSource.getRepository(Comment);
      const comment = await commentRepo.save(commentRepo.create({
        ticket_id,
        author_type: resolved.authorType,
        author_id: resolved.authorId,
        author: resolved.authorName,
        content: body,
        type: 'note' as CommentType,
        metadata: JSON.stringify(metadata),
      }));

      // 이 제안을 앵커로 재판정 — pending(아직 투표 안 한 홀더)이 드러난다.
      let state: Awaited<ReturnType<typeof getConsensusState>> | null = null;
      try {
        state = await getConsensusState({ dataSource, ticketRoleAssignmentService }, ticket, { proposalId: comment.id });
      } catch (e) {
        logger.warn('Consensus', `getConsensusState failed on propose_move: ${e instanceof Error ? e.message : String(e)}`);
      }

      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
        new_value: JSON.stringify({ target_column_id: destCol.id, target_column_name: destCol.name, proposal_id: comment.id }),
        field_changed: 'consensus_proposal',
      });

      // consensus_update SSE(UI T6) — 새 제안으로 배지/pending 갱신. status 는 방금
      // 캐스트된 시그널 필드지만 제안엔 시그널이 없어 중립값 'agree'(레지스트리 기본).
      if (state) {
        activityEvents.emit('consensus_update', buildConsensusUpdatePayload(ticket, state, {
          status: 'agree',
          override: false,
          actorId: resolved.authorId,
          actorName: resolved.authorName,
          timestamp: (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString(),
        }));
      }

      return ok({
        proposal: comment,
        proposal_id: comment.id,
        target_column: { id: destCol.id, name: destCol.name },
        consensus: state,
      });
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
    'Hand a ticket off to another agent. Reassigns the ticket (assignee role only — reporter/reviewer remain unchanged) AND posts a type=handoff comment so the receiver sees both the ticket and the human-readable rationale. The receiving agent gets a comment_mention event so their proxy can react immediately; the standard assignee-change trigger still fires so existing routing logic continues to work.\n\n' +
    MENTION_SYNTAX_DOC,
    {
      ticket_id: z.string().describe('Ticket ID being handed off'),
      target_agent_id: z.string().describe("ID of the Agent the ticket is being assigned to"),
      content: z.string().describe('Handoff rationale. Why is the receiver picking this up? What context do they need? Plain text or markdown.'),
      author_type: z.enum(['user', 'agent']).optional(),
      author_id: z.string().optional(),
      author: z.string().optional(),
      author_role: z.string().optional()
        .describe("Role the handing-off agent is acting as. Auto-filled from subagent session pin or TicketRoleAssignment when omitted; stored on metadata.author_role. (Distinct from metadata.role which records the target's incoming role.)"),
    },
    async ({ ticket_id, target_agent_id, content, author_type, author_id, author, author_role }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

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

      content = sanitizeHarnessMarkers(content, { logger, toolName: 'handoff_to_agent', fieldName: 'content', agentId: resolved.authorId });

      // Snapshot the previous assignee BEFORE the swap so the handoff
      // metadata records who passed the baton (useful for audit trails
      // and for the receiver to acknowledge the prior owner).
      const previousAssigneeId = ticket.assignee_id || '';
      const previousAssigneeName = ticket.assignee || '';

      // Self-handoff is a no-op assignment but a valid comment surface
      // (e.g., "I'm picking this back up after the deploy completed");
      // we don't refuse but we also don't churn the assignee row.
      const isSameAssignee = previousAssigneeId === target_agent_id;

      // Resolve the target agent's canonical `<Manager>/<Agent>` display once
      // so handoff metadata, the denormalized `ticket.assignee` column, and the
      // assignee_changed activity log all stamp the same string the rest of
      // the UI uses. Falling back to the bare name keeps the write safe if the
      // manager row was deleted (dangling FK).
      const targetAgentDisplay =
        (await resolveAgentDisplayName(agentRepo, targetAgent.id)) || targetAgent.name;

      // 1. Save handoff comment first so the activity dispatch + mention
      //    event reference an existing comment row.
      const commentRepo = dataSource.getRepository(Comment);
      const callerCtx = getCallerAgent(extra);
      const resolvedAuthorRole = await resolveAuthorRole(
        ticket_id, author_role, resolved.authorType, resolved.authorId,
        callerCtx?.subagentRole, callerCtx?.subagentTicketId,
      );
      const handoffMetadata = mergeAuthorRoleIntoMetadata({
        target_agent_id,
        target_agent_name: targetAgentDisplay,
        previous_assignee_id: previousAssigneeId || null,
        previous_assignee_name: previousAssigneeName || null,
        role: 'assignee',
      }, resolvedAuthorRole);
      const comment = await commentRepo.save(commentRepo.create({
        ticket_id,
        author_type: resolved.authorType,
        author_id: resolved.authorId,
        author: resolved.authorName,
        content,
        type: 'handoff' as CommentType,
        metadata: JSON.stringify(handoffMetadata),
      }));

      // 2. Reassign ticket. Skip the write if it would be a no-op so we
      //    don't fire a spurious assignee_changed activity.
      if (!isSameAssignee) {
        ticket.assignee_id = target_agent_id;
        ticket.assignee = targetAgentDisplay;
        await ticketRepo.save(ticket);

        // v0.34: mirror the new assignee onto the assignment table so the
        // trigger loop sees it on the next activity event.
        if (ctx.ticketRoleAssignmentService && ticket.workspace_id) {
          await ctx.ticketRoleAssignmentService.syncBuiltinTrio(ticket.id, ticket.workspace_id, {
            assignee_id: target_agent_id,
          });
        }

        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'assignee',
          old_value: previousAssigneeName || '',
          new_value: targetAgentDisplay,
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
