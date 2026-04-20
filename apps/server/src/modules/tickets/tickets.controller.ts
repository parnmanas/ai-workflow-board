import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment, COMMENT_TYPES, CommentType } from '../../entities/Comment';
import { Agent } from '../../entities/Agent';
import { UserMention } from '../../entities/UserMention';
import { User } from '../../entities/User';
import { AuthGuard } from '../../common/guards/auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ActivityService } from '../../services/activity.service';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { MentionService } from '../../services/mention.service';
import { TriggerLoopService } from '../agents/trigger-loop.service';
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE, ALLOWED_IMAGE_MIMETYPES } from '../../common/constants/upload';
import { loadTicketFull } from '../mcp/shared/ticket-parsing';
import { maxTicketPosition, maxChildPosition, resolveAgentId, shiftTicketPositions } from '../mcp/shared/ticket-helpers';
import { findOrFail } from '../../common/find-or-fail';

@ApiBearerAuth('user-session')
@ApiTags('tickets')
@Controller('api')
@UseGuards(AuthGuard, WorkspaceGuard)
export class TicketsController {
  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(UserMention) private readonly mentionRepo: Repository<UserMention>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
    private readonly mentionService: MentionService,
    private readonly triggerLoop: TriggerLoopService,
  ) {}

  private resolveCreator(req: any, body: any): { created_by: string; created_by_type: string; created_by_id: string } {
    // If explicitly provided in body (e.g., from MCP/agent API)
    if (body.created_by && body.created_by_type) {
      return {
        created_by: body.created_by,
        created_by_type: body.created_by_type,
        created_by_id: body.created_by_id || '',
      };
    }
    // If authenticated user (via session)
    const currentUser = req.currentUser;
    if (currentUser) {
      return {
        created_by: currentUser.name,
        created_by_type: 'user',
        created_by_id: currentUser.id,
      };
    }
    return { created_by: '', created_by_type: '', created_by_id: '' };
  }

  @Post('columns/:columnId/tickets')
  async create(@Param('columnId') columnId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { title, description = '', priority = 'medium', assignee = '', reporter = '', assignee_id = '', reporter_id = '', labels = [], channel_ids = [] } = body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    await findOrFail(this.colRepo, { where: { id: columnId } }, 'Column not found');

    const resolvedAssigneeId = await resolveAgentId(this.dataSource, assignee_id, assignee);
    const resolvedReporterId = await resolveAgentId(this.dataSource, reporter_id, reporter);
    const creator = this.resolveCreator(req, body);

    const position = await maxTicketPosition(this.dataSource, columnId);
    const ticket = await this.ticketRepo.save(this.ticketRepo.create({
      column_id: columnId, title, description, priority, assignee, reporter,
      assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId,
      labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids),
      position, parent_id: null, depth: 0, status: 'todo',
      created_by: creator.created_by, created_by_type: creator.created_by_type, created_by_id: creator.created_by_id,
    }));

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'created',
      ticket_id: ticket.id,
      actor_id: creator.created_by_id || undefined,
      actor_name: creator.created_by || reporter || assignee,
    });

    return res.status(201).json({ ...ticket, labels, channel_ids, children: [], comments: [] });
  }

  @Post('tickets/:parentId/children')
  async createChild(@Param('parentId') parentId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const parent = await findOrFail(this.ticketRepo, { where: { id: parentId } }, 'Parent ticket not found');

    const childDepth = parent.depth + 1;
    if (childDepth > 2) return res.status(400).json({ error: 'Maximum depth of 2 exceeded' });

    const { title, description = '', priority = 'medium', status = 'todo', assignee = '', reporter = '', assignee_id = '', reporter_id = '', labels = [], channel_ids = [] } = body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const resolvedAssigneeId = await resolveAgentId(this.dataSource, assignee_id, assignee);
    const resolvedReporterId = await resolveAgentId(this.dataSource, reporter_id, reporter);
    const creator = this.resolveCreator(req, body);

    const position = await maxChildPosition(this.dataSource, parentId);
    const child = await this.ticketRepo.save(this.ticketRepo.create({
      parent_id: parentId, depth: childDepth, column_id: null as any,
      title, description, priority, status, assignee, reporter,
      assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId,
      labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids), position,
      created_by: creator.created_by, created_by_type: creator.created_by_type, created_by_id: creator.created_by_id,
    }));

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: child.id, action: 'created',
      ticket_id: parent.depth === 0 ? parentId : parent.parent_id || parentId,
      actor_id: creator.created_by_id || undefined,
      actor_name: creator.created_by || reporter || assignee,
      new_value: title,
    });

    return res.status(201).json({ ...child, labels: JSON.parse(child.labels || '[]'), channel_ids: JSON.parse(child.channel_ids || '[]'), children: [], comments: [] });
  }

  @Get('tickets/:id')
  async get(@Param('id') id: string, @Res() res: Response) {
    const ticket = await loadTicketFull(this.dataSource, id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    return res.json(ticket);
  }

  @Patch('tickets/:id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');

    const currentUser = req.currentUser;
    const actorId = currentUser?.id || undefined;
    const actorName = currentUser?.name || currentUser?.email || undefined;

    const { title, description, priority, assignee, reporter, reviewer_id, assignee_id, reporter_id, labels, channel_ids, status, prompt_text } = body;
    const oldAssignee = ticket.assignee;
    const oldReporter = ticket.reporter;
    const oldReviewerId = ticket.reviewer_id;
    const oldStatus = ticket.status;

    if (title !== undefined) ticket.title = title;
    if (description !== undefined) ticket.description = description;
    if (priority !== undefined) ticket.priority = priority;
    if (status !== undefined) ticket.status = status;
    if (assignee !== undefined) {
      ticket.assignee = assignee;
      ticket.assignee_id = await resolveAgentId(this.dataSource, assignee_id || '', assignee);
    } else if (assignee_id !== undefined) {
      ticket.assignee_id = assignee_id;
    }
    if (reporter !== undefined) {
      ticket.reporter = reporter;
      ticket.reporter_id = await resolveAgentId(this.dataSource, reporter_id || '', reporter);
    } else if (reporter_id !== undefined) {
      ticket.reporter_id = reporter_id;
    }
    if (reviewer_id !== undefined) ticket.reviewer_id = reviewer_id;
    if (labels !== undefined) ticket.labels = JSON.stringify(labels);
    if (channel_ids !== undefined) ticket.channel_ids = JSON.stringify(channel_ids);
    // Phase 1 ticket prompt snapshot (D-17 / ROLE-08)
    if (prompt_text !== undefined) ticket.prompt_text = prompt_text;

    await this.ticketRepo.save(ticket);

    if (status !== undefined && status !== oldStatus) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'status_changed',
        field_changed: 'status', old_value: oldStatus || '', new_value: status,
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: actorId, actor_name: actorName,
      });
    }
    if (assignee !== undefined && assignee !== oldAssignee) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'assignee', old_value: oldAssignee || '', new_value: assignee || '',
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: actorId, actor_name: actorName,
      });
    }
    if (reporter !== undefined && reporter !== oldReporter) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'reporter', old_value: oldReporter || '', new_value: reporter || '',
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: actorId, actor_name: actorName,
      });
    }
    if (reviewer_id !== undefined && reviewer_id !== oldReviewerId) {
      const reviewerAgent = reviewer_id ? await this.agentRepo.findOne({ where: { id: reviewer_id } }) : null;
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'reviewer', old_value: oldReviewerId || '', new_value: reviewerAgent?.name || reviewer_id || '',
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: actorId, actor_name: actorName,
      });
    }

    const changes: string[] = [];
    if (title !== undefined) changes.push('title');
    if (description !== undefined) changes.push('description');
    if (priority !== undefined) changes.push('priority');
    const otherChanges = changes.filter(c => !['assignee', 'reporter', 'status'].includes(c));
    if (otherChanges.length > 0) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: otherChanges.join(', '),
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: actorId, actor_name: actorName,
      });
    }

    const updated = await loadTicketFull(this.dataSource, ticket.id);
    return res.json(updated);
  }

  @Patch('tickets/:id/move')
  async move(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const { targetColumnId, targetPosition } = body;
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');

    if (ticket.depth > 0) return res.status(400).json({ error: 'Only root tickets can be moved on the board' });

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const sourceColumnId = ticket.column_id;

      await shiftTicketPositions(tRepo, { column_id: sourceColumnId }, ticket.position, -1);

      const destColumnId = targetColumnId || sourceColumnId;
      const destCount = await tRepo.createQueryBuilder('t')
        .where('t.column_id = :colId AND t.id != :id AND t.parent_id IS NULL', { colId: destColumnId, id: ticket.id })
        .getCount();
      const pos = Math.min(targetPosition ?? destCount, destCount);

      await shiftTicketPositions(tRepo, { column_id: destColumnId }, pos, +1, { inclusive: true, excludeId: ticket.id });

      await tRepo.update(ticket.id, { column_id: destColumnId, position: pos });
    });

    const updated = await loadTicketFull(this.dataSource, ticket.id);

    const oldCol = await this.colRepo.findOne({ where: { id: ticket.column_id } });
    const newColId = targetColumnId || ticket.column_id;
    const newCol = await this.colRepo.findOne({ where: { id: newColId } });

    const currentUser = req.currentUser;
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'moved',
      field_changed: 'column', old_value: oldCol?.name || String(ticket.column_id),
      new_value: newCol?.name || String(newColId), ticket_id: ticket.id,
      actor_id: currentUser?.id,
      actor_name: currentUser?.name || currentUser?.email,
    });

    return res.json(updated);
  }

  /**
   * Manually re-trigger an agent on this ticket. Used when the auto trigger
   * fired but the agent never responded (dead subagent, missed SSE, etc.) and
   * the human wants to punt it awake. Bypasses the 60s cooldown that the auto
   * path honors. Body `{role, agent_id?}` — role picks which ticket slot
   * (assignee/reporter/reviewer) to wake; an explicit agent_id overrides the
   * role-resolved target (admin override, useful when the role isn't filled
   * but someone specific should take it).
   */
  @Post('tickets/:id/trigger')
  async triggerAgent(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const role = String(body?.role || '').toLowerCase();
    if (!['assignee', 'reporter', 'reviewer'].includes(role)) {
      return res.status(400).json({ error: 'role must be one of assignee|reporter|reviewer' });
    }
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    const explicitAgentId = body?.agent_id ? String(body.agent_id) : '';
    const roleField = role === 'assignee' ? 'assignee_id'
      : role === 'reporter' ? 'reporter_id'
      : 'reviewer_id';
    const targetAgentId = explicitAgentId || (ticket as any)[roleField] || '';
    if (!targetAgentId) {
      return res.status(400).json({
        error: `No ${role} assigned on this ticket. Set ticket.${roleField} first, or pass agent_id in the body.`,
      });
    }
    const currentUser = req.currentUser;
    try {
      const trigger = await this.triggerLoop.emitManualTrigger(
        id, targetAgentId, role,
        {
          id: currentUser?.id || '',
          name: currentUser?.name || currentUser?.email || 'web-user',
        },
      );
      return res.json({
        trigger_id: trigger.trigger_id,
        ticket_id: trigger.ticket_id,
        agent_id: trigger.agent_id,
        role: trigger.role,
        trigger_source: 'manual',
        pushed_at: new Date().toISOString(),
      });
    } catch (e: any) {
      const status = typeof e?.status === 'number' ? e.status : 500;
      return res.status(status).json({ error: e?.message || 'Manual trigger failed' });
    }
  }

  @Delete('tickets/:id')
  async delete(@Param('id') id: string, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, {
      where: { id },
      relations: ['children', 'comments'],
    }, 'Ticket not found');

    const columnId = ticket.column_id;
    const position = ticket.position;
    const parentId = ticket.parent_id;

    await this.ticketRepo.remove(ticket);

    if (parentId) {
      await shiftTicketPositions(this.ticketRepo, { parent_id: parentId }, position, -1);
    } else if (columnId) {
      await shiftTicketPositions(this.ticketRepo, { column_id: columnId }, position, -1);
    }

    return res.json({ success: true });
  }

  @Post('tickets/:id/comments')
  async addComment(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { content, images = [], type, parent_id = null, metadata = {} } = body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');

    if (images.length > MAX_IMAGES_PER_MESSAGE) {
      return res.status(400).json({ error: `Maximum ${MAX_IMAGES_PER_MESSAGE} images per comment` });
    }
    for (const img of images) {
      if (!img.data || !img.filename || !img.mimetype) {
        return res.status(400).json({ error: 'Each image must have data, filename, and mimetype' });
      }
      if (!ALLOWED_IMAGE_MIMETYPES.has(img.mimetype)) {
        return res.status(400).json({ error: `Unsupported image type: ${img.mimetype}` });
      }
      const approxSize = (img.data.length * 3) / 4;
      if (approxSize > MAX_IMAGE_SIZE) {
        return res.status(400).json({ error: `Image ${img.filename} exceeds ${MAX_IMAGE_SIZE / 1024 / 1024}MB limit` });
      }
    }

    if (type !== undefined && !COMMENT_TYPES.includes(type)) {
      return res.status(400).json({ error: `Unsupported comment type: ${type}` });
    }
    const resolvedType: CommentType = (type as CommentType) || 'note';
    if (resolvedType === 'system') {
      // type=system is reserved for SystemCommentService so audit-log entries
      // can never be forged through the user-facing endpoint.
      return res.status(400).json({ error: 'type=system is reserved for SystemCommentService' });
    }

    let resolvedParentId: string | null = null;
    if (parent_id) {
      const parent = await this.commentRepo.findOne({ where: { id: parent_id } });
      if (!parent) return res.status(400).json({ error: 'parent_id references a non-existent comment' });
      if (parent.ticket_id !== id) return res.status(400).json({ error: 'parent comment belongs to a different ticket' });
      resolvedParentId = parent.id;
    }
    if (resolvedType === 'answer' && !resolvedParentId) {
      return res.status(400).json({ error: 'type=answer requires parent_id pointing to the question being answered' });
    }

    const comment = await this.commentRepo.save(this.commentRepo.create({
      ticket_id: id,
      workspace_id: ticket.workspace_id,
      author_type: 'user',
      author_id: currentUser.id,
      author: currentUser.name,
      content,
      images: JSON.stringify(images),
      type: resolvedType,
      status: resolvedType === 'question' ? 'open' : null,
      parent_id: resolvedParentId,
      metadata: JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
    }));

    // Auto-resolve the parent question when an answer arrives. Cheap idempotent
    // update, so re-answers that change the resolution state still flip status
    // back to 'resolved' even if it was already resolved by a prior answer.
    if (resolvedType === 'answer' && resolvedParentId) {
      await this.commentRepo.update({ id: resolvedParentId }, { status: 'resolved' });
    }

    await this.activityService.logActivity({
      entity_type: 'comment',
      entity_id: comment.id,
      action: 'created',
      ticket_id: id,
      actor_id: currentUser.id,
      actor_name: currentUser.name,
      new_value: content,
      field_changed: resolvedType,
    });

    // Mention dispatch — only for user-authored comments so agent->agent
    // comment chains can't trigger runaway notifications.
    try {
      await this._dispatchCommentMentions(comment, ticket, currentUser);
    } catch (err: any) {
      this.logService.warn('Mentions', `Comment mention dispatch failed for comment ${comment.id}: ${err?.message || err}`);
    }

    return res.status(201).json({
      ...comment,
      images: JSON.parse(comment.images || '[]'),
      metadata: JSON.parse(comment.metadata || '{}'),
    });
  }

  /**
   * Parse @-mention tokens from the saved comment and fire notification events.
   *
   *  - Agent mentions → `comment_mention` SSE event, routed only to the target
   *    agent's proxy. The proxy synthesizes a "this comment is addressed to
   *    YOU" subagent prompt so the agent never mistakes the mention for
   *    ambient board activity.
   *  - User mentions → `user_mentions` row + `user_mention` SSE event, consumed
   *    by the web UI sidebar badge.
   */
  private async _dispatchCommentMentions(comment: Comment, ticket: Ticket, actor: { id: string; name: string }): Promise<void> {
    const refs = this.mentionService.parseMentions(comment.content);
    if (refs.length === 0) return;

    const resolved = this.mentionService.resolveMentions(refs, ticket);
    if (resolved.length === 0) return;

    const preview = (comment.content || '').slice(0, 500);
    const ts = (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString();

    for (const m of resolved) {
      if (m.type === 'agent') {
        const agent = await this.agentRepo.findOne({ where: { id: m.id } });
        if (!agent) continue;
        // Scope safety: an agent in a different workspace should never receive this mention.
        if (agent.workspace_id && ticket.workspace_id && agent.workspace_id !== ticket.workspace_id) continue;

        activityEvents.emit('comment_mention', {
          ticket_id: ticket.id,
          comment_id: comment.id,
          workspace_id: ticket.workspace_id,
          agent_id: agent.id,
          actor_id: actor.id,
          actor_type: 'user',
          actor_name: actor.name,
          content: comment.content,
          role_prompt: agent.role_prompt || '',
          mention_source: m.roleShortcut ? 'role' : 'direct',
          role_shortcut: m.roleShortcut,
          timestamp: ts,
        });
        this.logService.info('Mentions', `Agent @-mention routed: ${agent.name} (${agent.id}) on ticket ${ticket.id}`);
      } else {
        // User mention — persist + emit for badge sync
        const row = await this.mentionRepo.save(this.mentionRepo.create({
          user_id: m.id,
          workspace_id: ticket.workspace_id,
          source_type: 'comment',
          source_id: comment.id,
          ticket_id: ticket.id,
          room_id: null,
          actor_id: actor.id,
          actor_type: 'user',
          actor_name: actor.name,
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
          actor_id: actor.id,
          actor_type: 'user',
          actor_name: actor.name,
          preview,
          created_at: (row.created_at instanceof Date ? row.created_at : new Date()).toISOString(),
        });
        this.logService.info('Mentions', `User @-mention recorded: user ${row.user_id} on ticket ${ticket.id}`);
      }
    }
  }
}
