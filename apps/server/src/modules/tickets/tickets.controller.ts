import { Controller, Get, Post, Patch, Delete, Body, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { Agent } from '../../entities/Agent';
import { AuthGuard } from '../../common/guards/auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ActivityService } from '../../services/activity.service';
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE, ALLOWED_IMAGE_MIMETYPES } from '../../common/constants/upload';

function parseComments(comments: any[]) {
  return (comments || [])
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(c => ({ ...c, images: JSON.parse(c.images || '[]') }));
}

function parseTicket(ticket: Ticket) {
  return {
    ...ticket,
    labels: JSON.parse(ticket.labels || '[]'),
    channel_ids: JSON.parse(ticket.channel_ids || '[]'),
    children: (ticket.children || [])
      .sort((a, b) => a.position - b.position)
      .map(child => ({
        ...child,
        labels: JSON.parse(child.labels || '[]'),
        channel_ids: JSON.parse(child.channel_ids || '[]'),
        children: (child.children || []).sort((a, b) => a.position - b.position).map(gc => ({
          ...gc,
          labels: JSON.parse(gc.labels || '[]'),
          channel_ids: JSON.parse(gc.channel_ids || '[]'),
          children: [],
          comments: parseComments(gc.comments),
        })),
        comments: parseComments(child.comments),
      })),
    comments: parseComments(ticket.comments),
  };
}

async function loadTicketFull(ticketRepo: Repository<Ticket>, id: string) {
  const ticket = await ticketRepo.findOne({
    where: { id },
    relations: [
      'children', 'children.children', 'children.children.comments',
      'children.comments', 'comments',
    ],
  });
  if (!ticket) return null;
  return parseTicket(ticket);
}

@Controller('api')
@UseGuards(AuthGuard, WorkspaceGuard)
export class TicketsController {
  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
  ) {}

  private async resolveAgentId(id: string, name: string): Promise<string> {
    if (id) return id;
    if (!name) return '';
    const agent = await this.agentRepo.findOne({ where: { name } }).catch(() => null);
    return agent?.id || '';
  }

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

    const col = await this.colRepo.findOne({ where: { id: columnId } });
    if (!col) return res.status(404).json({ error: 'Column not found' });

    const resolvedAssigneeId = await this.resolveAgentId(assignee_id, assignee);
    const resolvedReporterId = await this.resolveAgentId(reporter_id, reporter);
    const creator = this.resolveCreator(req, body);

    const maxResult = await this.ticketRepo
      .createQueryBuilder('t')
      .select('COALESCE(MAX(t.position), -1)', 'max')
      .where('t.column_id = :columnId AND t.parent_id IS NULL', { columnId })
      .getRawOne();

    const position = (maxResult?.max ?? -1) + 1;
    const ticket = await this.ticketRepo.save(this.ticketRepo.create({
      column_id: columnId, title, description, priority, assignee, reporter,
      assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId,
      labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids),
      position, parent_id: null, depth: 0, status: 'todo',
      created_by: creator.created_by, created_by_type: creator.created_by_type, created_by_id: creator.created_by_id,
    }));

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'created',
      ticket_id: ticket.id, actor_name: creator.created_by || reporter || assignee,
    });

    return res.status(201).json({ ...ticket, labels, channel_ids, children: [], comments: [] });
  }

  @Post('tickets/:parentId/children')
  async createChild(@Param('parentId') parentId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const parent = await this.ticketRepo.findOne({ where: { id: parentId } });
    if (!parent) return res.status(404).json({ error: 'Parent ticket not found' });

    const childDepth = parent.depth + 1;
    if (childDepth > 2) return res.status(400).json({ error: 'Maximum depth of 2 exceeded' });

    const { title, description = '', priority = 'medium', status = 'todo', assignee = '', reporter = '', assignee_id = '', reporter_id = '', labels = [], channel_ids = [] } = body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const resolvedAssigneeId = await this.resolveAgentId(assignee_id, assignee);
    const resolvedReporterId = await this.resolveAgentId(reporter_id, reporter);
    const creator = this.resolveCreator(req, body);

    const maxResult = await this.ticketRepo
      .createQueryBuilder('t')
      .select('COALESCE(MAX(t.position), -1)', 'max')
      .where('t.parent_id = :parentId', { parentId })
      .getRawOne();

    const position = (maxResult?.max ?? -1) + 1;
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
      actor_name: creator.created_by || reporter || assignee,
      new_value: title,
    });

    return res.status(201).json({ ...child, labels: JSON.parse(child.labels || '[]'), channel_ids: JSON.parse(child.channel_ids || '[]'), children: [], comments: [] });
  }

  @Get('tickets/:id')
  async get(@Param('id') id: string, @Res() res: Response) {
    const ticket = await loadTicketFull(this.ticketRepo, id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    return res.json(ticket);
  }

  @Patch('tickets/:id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

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
      ticket.assignee_id = await this.resolveAgentId(assignee_id || '', assignee);
    } else if (assignee_id !== undefined) {
      ticket.assignee_id = assignee_id;
    }
    if (reporter !== undefined) {
      ticket.reporter = reporter;
      ticket.reporter_id = await this.resolveAgentId(reporter_id || '', reporter);
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
      });
    }
    if (assignee !== undefined && assignee !== oldAssignee) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'assignee', old_value: oldAssignee || '', new_value: assignee || '',
        ticket_id: ticket.parent_id || ticket.id,
      });
    }
    if (reporter !== undefined && reporter !== oldReporter) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'reporter', old_value: oldReporter || '', new_value: reporter || '',
        ticket_id: ticket.parent_id || ticket.id,
      });
    }
    if (reviewer_id !== undefined && reviewer_id !== oldReviewerId) {
      const reviewerAgent = reviewer_id ? await this.agentRepo.findOne({ where: { id: reviewer_id } }) : null;
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'reviewer', old_value: oldReviewerId || '', new_value: reviewerAgent?.name || reviewer_id || '',
        ticket_id: ticket.parent_id || ticket.id,
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
      });
    }

    const updated = await loadTicketFull(this.ticketRepo, ticket.id);
    return res.json(updated);
  }

  @Patch('tickets/:id/move')
  async move(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { targetColumnId, targetPosition } = body;
    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    if (ticket.depth > 0) return res.status(400).json({ error: 'Only root tickets can be moved on the board' });

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const sourceColumnId = ticket.column_id;

      await tRepo.createQueryBuilder()
        .update()
        .set({ position: () => 'position - 1' })
        .where('column_id = :colId AND position > :pos AND parent_id IS NULL', { colId: sourceColumnId, pos: ticket.position })
        .execute();

      const destColumnId = targetColumnId || sourceColumnId;
      const destCount = await tRepo.createQueryBuilder('t')
        .where('t.column_id = :colId AND t.id != :id AND t.parent_id IS NULL', { colId: destColumnId, id: ticket.id })
        .getCount();
      const pos = Math.min(targetPosition ?? destCount, destCount);

      await tRepo.createQueryBuilder()
        .update()
        .set({ position: () => 'position + 1' })
        .where('column_id = :colId AND position >= :pos AND id != :id AND parent_id IS NULL', { colId: destColumnId, pos, id: ticket.id })
        .execute();

      await tRepo.update(ticket.id, { column_id: destColumnId, position: pos });
    });

    const updated = await loadTicketFull(this.ticketRepo, ticket.id);

    const oldCol = await this.colRepo.findOne({ where: { id: ticket.column_id } });
    const newColId = targetColumnId || ticket.column_id;
    const newCol = await this.colRepo.findOne({ where: { id: newColId } });

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'moved',
      field_changed: 'column', old_value: oldCol?.name || String(ticket.column_id),
      new_value: newCol?.name || String(newColId), ticket_id: ticket.id,
    });

    return res.json(updated);
  }

  @Delete('tickets/:id')
  async delete(@Param('id') id: string, @Res() res: Response) {
    const ticket = await this.ticketRepo.findOne({
      where: { id },
      relations: ['children', 'comments'],
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const columnId = ticket.column_id;
    const position = ticket.position;
    const parentId = ticket.parent_id;

    await this.ticketRepo.remove(ticket);

    if (parentId) {
      await this.ticketRepo.createQueryBuilder()
        .update()
        .set({ position: () => 'position - 1' })
        .where('parent_id = :parentId AND position > :pos', { parentId, pos: position })
        .execute();
    } else if (columnId) {
      await this.ticketRepo.createQueryBuilder()
        .update()
        .set({ position: () => 'position - 1' })
        .where('column_id = :colId AND position > :pos AND parent_id IS NULL', { colId: columnId, pos: position })
        .execute();
    }

    return res.json({ success: true });
  }

  @Post('tickets/:id/comments')
  async addComment(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { content, images = [] } = body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

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

    const comment = await this.commentRepo.save(this.commentRepo.create({
      ticket_id: id,
      author_type: 'user',
      author_id: currentUser.id,
      author: currentUser.name,
      content,
      images: JSON.stringify(images),
    }));

    await this.activityService.logActivity({
      entity_type: 'comment',
      entity_id: comment.id,
      action: 'created',
      ticket_id: id,
      actor_id: currentUser.id,
      actor_name: currentUser.name,
      new_value: content,
    });

    return res.status(201).json({ ...comment, images: JSON.parse(comment.images || '[]') });
  }
}
