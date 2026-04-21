import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment, COMMENT_TYPES, CommentType } from '../../entities/Comment';
import { Agent } from '../../entities/Agent';
import { UserMention } from '../../entities/UserMention';
import { TicketReadState } from '../../entities/TicketReadState';
import { User } from '../../entities/User';
import { AuthGuard } from '../../common/guards/auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ActivityService } from '../../services/activity.service';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { MentionService } from '../../services/mention.service';
import { PresenceService } from '../../services/presence.service';
import { TriggerLoopService } from '../agents/trigger-loop.service';
import { MAX_COMMENT_ATTACHMENT_SIZE, MAX_COMMENT_ATTACHMENTS } from '../../common/constants/upload';
import { Resource } from '../../entities/Resource';
import { loadTicketFull, parseComments, expandCommentAttachments } from '../mcp/shared/ticket-parsing';
import { maxTicketPosition, maxChildPosition, resolveAgentId, shiftTicketPositions, deleteCommentAttachmentsForTicket } from '../mcp/shared/ticket-helpers';
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
    @InjectRepository(TicketReadState) private readonly readStateRepo: Repository<TicketReadState>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
    private readonly mentionService: MentionService,
    private readonly triggerLoop: TriggerLoopService,
    private readonly presence: PresenceService,
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

    // Strip comment_attachment Resources before the ticket cascade removes
    // the comment rows they were tied to — Resource has no FK back to Ticket.
    await deleteCommentAttachmentsForTicket(this.dataSource, ticket.id);

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
    const {
      content,
      type,
      parent_id = null,
      metadata = {},
      // Pre-created Resource ids (agent/MCP path — Resources already exist).
      attachment_resource_ids: rawAttachmentIds = [],
      // Inline file uploads (user/UI path — server creates Resources in the
      // same transaction as the comment so a failure rolls both back).
      attachments: rawInlineAttachments = [],
    } = body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');

    const preIds: string[] = Array.isArray(rawAttachmentIds)
      ? rawAttachmentIds.filter((v: any) => typeof v === 'string' && v)
      : [];
    const inlineFiles: { file_data: string; file_name: string; file_mimetype: string }[] =
      Array.isArray(rawInlineAttachments) ? rawInlineAttachments : [];

    if (preIds.length + inlineFiles.length > MAX_COMMENT_ATTACHMENTS) {
      return res.status(400).json({ error: `Maximum ${MAX_COMMENT_ATTACHMENTS} attachments per comment` });
    }
    for (const f of inlineFiles) {
      if (!f || typeof f !== 'object' || !f.file_data || !f.file_name) {
        return res.status(400).json({ error: 'Each inline attachment must have file_data and file_name' });
      }
      const approxSize = (f.file_data.length * 3) / 4;
      if (approxSize > MAX_COMMENT_ATTACHMENT_SIZE) {
        return res.status(400).json({ error: `Attachment ${f.file_name} exceeds ${MAX_COMMENT_ATTACHMENT_SIZE / 1024 / 1024}MB limit` });
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

    // Verify any pre-created Resource ids belong to this ticket's workspace
    // and are typed correctly before we commit. Cross-workspace references
    // would let a caller attach another team's Resource to a comment.
    if (preIds.length > 0) {
      const resourceRepo = this.dataSource.getRepository(Resource);
      const rows = await resourceRepo.findBy({ id: In(preIds) } as any);
      const found = new Map(rows.map(r => [r.id, r]));
      for (const rid of preIds) {
        const r = found.get(rid);
        if (!r) return res.status(400).json({ error: `attachment_resource_ids contains unknown id: ${rid}` });
        if (r.workspace_id !== ticket.workspace_id) {
          return res.status(400).json({ error: `attachment resource ${rid} belongs to a different workspace` });
        }
        if (r.type !== 'comment_attachment') {
          return res.status(400).json({ error: `attachment resource ${rid} is type=${r.type}; expected comment_attachment` });
        }
      }
    }

    const inferResourceMimetypeLocal = (dataBase64: string, fileName: string, explicit?: string): string => {
      if (explicit && explicit.length > 0) return explicit;
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      const extMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
        pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
        zip: 'application/zip', csv: 'text/csv', mp4: 'video/mp4', mov: 'video/quicktime',
      };
      return extMap[ext] || 'application/octet-stream';
    };

    // Resolve the ticket's board so attachments land in that board's Resources
    // (not the workspace scope). Tickets store column_id, not board_id, and
    // child tickets have a null column — walk to the ancestor that has one.
    const resolveBoardId = async (startTicket: Ticket): Promise<string | null> => {
      let cursor: Ticket | null = startTicket;
      while (cursor && !cursor.column_id && cursor.parent_id) {
        cursor = await this.ticketRepo.findOne({ where: { id: cursor.parent_id } });
      }
      if (!cursor?.column_id) return null;
      const col = await this.colRepo.findOne({ where: { id: cursor.column_id } });
      return col?.board_id || null;
    };
    const ticketBoardId = inlineFiles.length > 0 ? await resolveBoardId(ticket) : null;

    const comment = await this.dataSource.transaction(async (manager) => {
      const createdIds: string[] = [];
      for (const f of inlineFiles) {
        const mimetype = inferResourceMimetypeLocal(f.file_data, f.file_name, f.file_mimetype);
        const r = await manager.getRepository(Resource).save(
          manager.getRepository(Resource).create({
            workspace_id: ticket.workspace_id,
            board_id: ticketBoardId,
            credential_id: null,
            name: f.file_name,
            description: '',
            type: 'comment_attachment',
            url: '',
            content: '',
            file_data: f.file_data,
            file_name: f.file_name,
            file_mimetype: mimetype,
            tags: '[]',
          }),
        );
        createdIds.push(r.id);
      }
      const allIds = [...preIds, ...createdIds];
      return manager.getRepository(Comment).save(manager.getRepository(Comment).create({
        ticket_id: id,
        workspace_id: ticket.workspace_id,
        author_type: 'user',
        author_id: currentUser.id,
        author: currentUser.name,
        content,
        attachment_resource_ids: JSON.stringify(allIds),
        type: resolvedType,
        status: resolvedType === 'question' ? 'open' : null,
        parent_id: resolvedParentId,
        metadata: JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
      }));
    });

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

    const [parsed] = parseComments([comment]);
    await expandCommentAttachments(this.dataSource, [parsed]);
    return res.status(201).json(parsed);
  }

  @Get('tickets/:id/read-state')
  async getReadState(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    const row = await this.readStateRepo.findOne({ where: { user_id: currentUser.id, ticket_id: id } });
    return res.json({ ticket_id: id, last_read_at: row?.last_read_at ?? null });
  }

  @Post('tickets/:id/read')
  async markRead(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Optional explicit cutoff (ISO timestamp); defaults to NOW so the
    // common "I just opened the panel" case marks everything currently
    // visible as read.
    const cutoff = body?.up_to ? new Date(body.up_to) : new Date();
    if (Number.isNaN(cutoff.getTime())) {
      return res.status(400).json({ error: 'up_to must be an ISO timestamp' });
    }

    let row = await this.readStateRepo.findOne({ where: { user_id: currentUser.id, ticket_id: id } });
    if (!row) {
      row = this.readStateRepo.create({
        user_id: currentUser.id,
        ticket_id: id,
        workspace_id: ticket.workspace_id || '',
        last_read_at: cutoff,
      });
    } else {
      // Monotonic — never roll the marker backwards. If a newer cutoff is
      // already stored (e.g., another tab marked further), keep that and
      // return the larger value so the client converges.
      if (!row.last_read_at || cutoff.getTime() > row.last_read_at.getTime()) {
        row.last_read_at = cutoff;
      }
    }
    const saved = await this.readStateRepo.save(row);
    return res.json({ ticket_id: id, last_read_at: saved.last_read_at });
  }

  @Post('tickets/:id/presence')
  async setPresence(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Default action is "ping" — explicit { is_active: false } leaves the
    // ticket. Beacons on tab close use the leave variant so the badge clears
    // before the 30s sweep would.
    const isLeaving = body?.is_active === false;
    if (isLeaving) {
      this.presence.leave(id, { type: 'user', id: currentUser.id });
    } else {
      this.presence.ping(id, {
        type: 'user',
        id: currentUser.id,
        name: currentUser.name || '',
        workspaceId: ticket.workspace_id,
      });
    }
    return res.json({ ok: true, viewers: this.presence.list(id).map(v => ({ type: v.type, id: v.id, name: v.name })) });
  }

  @Post('tickets/:id/comment-typing')
  async setCommentTyping(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    activityEvents.emit('comment_typing', {
      ticket_id: id,
      workspace_id: ticket.workspace_id,
      actor_type: 'user',
      actor_id: currentUser.id,
      actor_name: currentUser.name || '',
      is_typing: !!body?.is_typing,
      comment_type: typeof body?.comment_type === 'string' ? body.comment_type : undefined,
      timestamp: new Date().toISOString(),
    });

    return res.json({ ok: true });
  }

  @Patch('tickets/:ticketId/comments/:commentId/status')
  async setCommentStatus(
    @Param('ticketId') ticketId: string,
    @Param('commentId') commentId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const desired = body?.status;
    // Only the question lifecycle uses status today. Restrict the surface
    // explicitly so we can extend later (e.g., decision 'archived') without
    // accidentally accepting arbitrary strings now.
    if (desired !== 'open' && desired !== 'resolved') {
      return res.status(400).json({ error: "status must be 'open' or 'resolved'" });
    }

    const comment = await this.commentRepo.findOne({ where: { id: commentId } });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.ticket_id !== ticketId) {
      return res.status(400).json({ error: 'Comment does not belong to that ticket' });
    }
    if (comment.type !== 'question') {
      return res.status(400).json({ error: 'Only question comments carry a resolvable status' });
    }
    if (comment.status === desired) {
      // No-op write; return the row so the client can reconcile state without
      // a follow-up GET.
      const [parsed] = parseComments([comment]);
      await expandCommentAttachments(this.dataSource, [parsed]);
      return res.json(parsed);
    }

    await this.commentRepo.update({ id: commentId }, { status: desired });

    await this.activityService.logActivity({
      entity_type: 'comment',
      entity_id: commentId,
      action: 'updated',
      ticket_id: ticketId,
      actor_id: currentUser.id,
      actor_name: currentUser.name,
      field_changed: 'status',
      old_value: comment.status || '',
      new_value: desired,
    });

    const updated = await this.commentRepo.findOne({ where: { id: commentId } });
    const source = updated || comment;
    source.status = desired;
    const [parsed] = parseComments([source]);
    await expandCommentAttachments(this.dataSource, [parsed]);
    return res.json(parsed);
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
