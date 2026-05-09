import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Comment, COMMENT_TYPES, CommentType } from '../../entities/Comment';
import { Agent } from '../../entities/Agent';
import { UserMention } from '../../entities/UserMention';
import { TicketReadState } from '../../entities/TicketReadState';
import { User } from '../../entities/User';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { AuthGuard } from '../../common/guards/auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ActivityService } from '../../services/activity.service';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { MentionService } from '../../services/mention.service';
import { PresenceService } from '../../services/presence.service';
import { TriggerLoopService } from '../agents/trigger-loop.service';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import {
  MAX_COMMENT_ATTACHMENT_SIZE,
  MAX_COMMENT_ATTACHMENTS,
  MAX_TICKET_ATTACHMENT_SIZE,
  MAX_TICKET_ATTACHMENTS,
} from '../../common/constants/upload';
import { Resource } from '../../entities/Resource';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { loadTicketFull, parseComments, expandCommentAttachments } from '../mcp/shared/ticket-parsing';
import {
  maxTicketPosition,
  maxChildPosition,
  resolveAgentIdAndName,
  shiftTicketPositions,
  deleteCommentAttachmentsForTicket,
  inferTicketAttachmentMimetype,
  projectTicketAttachment,
  approxBase64Size,
} from '../mcp/shared/ticket-helpers';
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
    @InjectRepository(TicketAttachment) private readonly attachmentRepo: Repository<TicketAttachment>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
    private readonly mentionService: MentionService,
    private readonly triggerLoop: TriggerLoopService,
    private readonly presence: PresenceService,
    private readonly ticketRoleAssignments: TicketRoleAssignmentService,
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

    // Backfill name↔id whichever side the caller omitted — the MCP path
    // hands us *_id only and TicketCard reads the legacy text columns
    // directly. See `resolveAgentIdAndName` for the lookup semantics.
    const assigneeResolved = await resolveAgentIdAndName(this.dataSource, assignee_id, assignee);
    const reporterResolved = await resolveAgentIdAndName(this.dataSource, reporter_id, reporter);
    let resolvedAssigneeId = assigneeResolved.id;
    let resolvedAssignee = assigneeResolved.name;
    let resolvedReporterId = reporterResolved.id;
    let resolvedReporter = reporterResolved.name;
    const creator = this.resolveCreator(req, body);
    // Default Reporter to the ticket's creator when none was supplied — keeps
    // the original requester reachable without forcing the create form to ask.
    if (!resolvedReporter && !resolvedReporterId && creator.created_by_id) {
      resolvedReporter = creator.created_by;
      resolvedReporterId = creator.created_by_id;
    }

    const position = await maxTicketPosition(this.dataSource, columnId);
    const ticket = await this.ticketRepo.save(this.ticketRepo.create({
      column_id: columnId, title, description, priority,
      assignee: resolvedAssignee, reporter: resolvedReporter,
      assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId,
      labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids),
      position, parent_id: null, depth: 0, status: 'todo',
      created_by: creator.created_by, created_by_type: creator.created_by_type, created_by_id: creator.created_by_id,
    }));

    // Mirror onto TicketRoleAssignment so trigger loop / allocation /
    // mention resolution see the new ticket via the v0.34 path.
    await this._refreshWorkspaceId(ticket);
    if (ticket.workspace_id) {
      await this.ticketRoleAssignments.syncBuiltinTrio(ticket.id, ticket.workspace_id, {
        assignee_id: resolvedAssigneeId,
        reporter_id: resolvedReporterId,
      });
    }

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'created',
      ticket_id: ticket.id,
      actor_id: creator.created_by_id || undefined,
      actor_name: creator.created_by || reporter || assignee,
    });

    return res.status(201).json({ ...ticket, labels, channel_ids, children: [], comments: [] });
  }

  /**
   * Tickets currently inherit workspace_id from their column → board.
   * Pull it once after creation so the assignment-table sync below has
   * the value to scope WorkspaceRole lookups against.
   */
  private async _refreshWorkspaceId(ticket: Ticket): Promise<void> {
    if (ticket.workspace_id) return;
    const col = ticket.column_id
      ? await this.colRepo.findOne({ where: { id: ticket.column_id } })
      : null;
    if (!col) return;
    const board = await this.dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
    if (board?.workspace_id) {
      ticket.workspace_id = board.workspace_id;
      await this.ticketRepo.update(ticket.id, { workspace_id: ticket.workspace_id });
    }
  }

  @Post('tickets/:parentId/children')
  async createChild(@Param('parentId') parentId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const parent = await findOrFail(this.ticketRepo, { where: { id: parentId } }, 'Parent ticket not found');

    const childDepth = parent.depth + 1;
    if (childDepth > 2) return res.status(400).json({ error: 'Maximum depth of 2 exceeded' });

    const { title, description = '', priority = 'medium', status = 'todo', assignee = '', reporter = '', assignee_id = '', reporter_id = '', labels = [], channel_ids = [] } = body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    // Backfill name↔id from the Agent table (see root `create` above).
    const assigneeResolved = await resolveAgentIdAndName(this.dataSource, assignee_id, assignee);
    const reporterResolved = await resolveAgentIdAndName(this.dataSource, reporter_id, reporter);
    let resolvedAssigneeId = assigneeResolved.id;
    let resolvedAssignee = assigneeResolved.name;
    let resolvedReporterId = reporterResolved.id;
    let resolvedReporter = reporterResolved.name;
    const creator = this.resolveCreator(req, body);
    if (!resolvedReporter && !resolvedReporterId && creator.created_by_id) {
      resolvedReporter = creator.created_by;
      resolvedReporterId = creator.created_by_id;
    }

    const position = await maxChildPosition(this.dataSource, parentId);
    const child = await this.ticketRepo.save(this.ticketRepo.create({
      parent_id: parentId, depth: childDepth, column_id: null as any,
      title, description, priority, status,
      assignee: resolvedAssignee, reporter: resolvedReporter,
      assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId,
      labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids), position,
      // Inherit workspace_id from parent so role lookups resolve immediately
      // (children otherwise have NULL workspace_id and miss the sync below).
      workspace_id: parent.workspace_id || '',
      created_by: creator.created_by, created_by_type: creator.created_by_type, created_by_id: creator.created_by_id,
    }));

    if (child.workspace_id) {
      await this.ticketRoleAssignments.syncBuiltinTrio(child.id, child.workspace_id, {
        assignee_id: resolvedAssigneeId,
        reporter_id: resolvedReporterId,
      });
    }

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: child.id, action: 'created',
      ticket_id: parent.depth === 0 ? parentId : parent.parent_id || parentId,
      actor_id: creator.created_by_id || undefined,
      actor_name: creator.created_by || reporter || assignee,
      new_value: title,
    });

    return res.status(201).json({ ...child, labels: JSON.parse(child.labels || '[]'), channel_ids: JSON.parse(child.channel_ids || '[]'), children: [], comments: [] });
  }

  // IMPORTANT: keep `tickets/unread-counts` above `tickets/:id` — Express
  // picks the first matching pattern, and `:id` would eat the literal
  // "unread-counts" segment (producing a 404 "Ticket not found").
  // Sidebar badge + per-ticket badge source. Returns unread comment counts
  // scoped to tickets the current user is involved in within one workspace:
  //   - their role fields match (assignee_id / reporter_id / reviewer_id),
  //   - OR they've already read at least once (TicketReadState row exists).
  // Scoping to "involved" tickets keeps the number manageable on big boards
  // — we don't want every new comment on every ticket in the workspace
  // lighting up the badge, just ones the user cares about.
  //
  // `unread` = comments with created_at > TicketReadState.last_read_at
  // (or > user's role-grant date if the user has never marked it read).
  // For simplicity NULL last_read_at counts every ticket-comment as unread,
  // which matches the ticket detail panel's own rendering.
  @Get('tickets/unread-counts')
  async unreadCounts(@Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    const wsId = (req.headers['x-workspace-id'] as string) || '';
    if (!wsId) return res.status(400).json({ error: 'Workspace ID required' });

    // Involved ticket IDs in this workspace: role holder OR has read-state row.
    const roleTickets = await this.ticketRepo
      .createQueryBuilder('t')
      .select('t.id', 'id')
      .where('t.workspace_id = :wsId', { wsId })
      .andWhere(
        '(t.assignee_id = :uid OR t.reporter_id = :uid OR t.reviewer_id = :uid)',
        { uid: currentUser.id },
      )
      .getRawMany();
    const readRows = await this.readStateRepo
      .createQueryBuilder('r')
      .select('r.ticket_id', 'id')
      .addSelect('r.last_read_at', 'last_read_at')
      .where('r.user_id = :uid AND r.workspace_id = :wsId', { uid: currentUser.id, wsId })
      .getRawMany();

    const involvedIds = new Set<string>([
      ...roleTickets.map((r) => r.id),
      ...readRows.map((r) => r.id),
    ]);
    if (involvedIds.size === 0) return res.json({ total: 0, perTicket: {}, perBoard: {} });

    const readBy: Record<string, Date | null> = {};
    for (const r of readRows) readBy[r.id] = r.last_read_at ? new Date(r.last_read_at) : null;

    const perTicket: Record<string, number> = {};
    let total = 0;
    const comments = await this.commentRepo
      .createQueryBuilder('c')
      .select(['c.ticket_id AS ticket_id', 'c.created_at AS created_at', 'c.author_id AS author_id'])
      .where('c.ticket_id IN (:...ids)', { ids: Array.from(involvedIds) })
      .getRawMany();
    for (const c of comments) {
      if (c.author_id === currentUser.id) continue;
      const cutoff = readBy[c.ticket_id];
      if (cutoff && new Date(c.created_at) <= cutoff) continue;
      perTicket[c.ticket_id] = (perTicket[c.ticket_id] || 0) + 1;
      total++;
    }

    // Roll up perTicket → perBoard (sidebar per-board badges).
    const perBoard: Record<string, number> = {};
    const ticketIdsWithUnread = Object.keys(perTicket);
    if (ticketIdsWithUnread.length > 0) {
      const allTickets = await this.ticketRepo
        .createQueryBuilder('t')
        .select(['t.id AS id', 't.column_id AS column_id', 't.parent_id AS parent_id'])
        .where('t.workspace_id = :wsId', { wsId })
        .getRawMany();
      const byId = new Map<string, { column_id: string | null; parent_id: string | null }>();
      for (const t of allTickets) byId.set(t.id, { column_id: t.column_id, parent_id: t.parent_id });
      const columnIds = new Set<string>();
      const resolveBoardColumn = (startId: string): string | null => {
        let cursor: { column_id: string | null; parent_id: string | null } | undefined = byId.get(startId);
        for (let i = 0; cursor && !cursor.column_id && cursor.parent_id && i < 5; i++) {
          cursor = byId.get(cursor.parent_id);
        }
        return cursor?.column_id ?? null;
      };
      for (const id of ticketIdsWithUnread) {
        const colId = resolveBoardColumn(id);
        if (colId) columnIds.add(colId);
      }
      if (columnIds.size > 0) {
        const cols = await this.ticketRepo.manager
          .getRepository('BoardColumn')
          .createQueryBuilder('c')
          .select(['c.id AS id', 'c.board_id AS board_id'])
          .where('c.id IN (:...ids)', { ids: Array.from(columnIds) })
          .getRawMany();
        const boardByColumn = new Map<string, string>();
        for (const c of cols) boardByColumn.set(c.id, c.board_id);
        for (const id of ticketIdsWithUnread) {
          const colId = resolveBoardColumn(id);
          const boardId = colId ? boardByColumn.get(colId) : undefined;
          if (boardId) perBoard[boardId] = (perBoard[boardId] || 0) + perTicket[id];
        }
      }
    }

    return res.json({ total, perTicket, perBoard });
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

    const { title, description, priority, assignee, reporter, reviewer_id, assignee_id, reporter_id, labels, channel_ids, status, prompt_text, base_repo_resource_id, base_branch } = body;
    const oldAssignee = ticket.assignee;
    const oldReporter = ticket.reporter;
    const oldReviewerId = ticket.reviewer_id;
    const oldStatus = ticket.status;
    const oldBaseRepoId = ticket.base_repo_resource_id;
    const oldBaseBranch = ticket.base_branch;

    if (title !== undefined) ticket.title = title;
    if (description !== undefined) ticket.description = description;
    if (priority !== undefined) ticket.priority = priority;
    if (status !== undefined) ticket.status = status;
    // Same name↔id backfill rule as the create path: when the caller flips
    // only one side of the pair, look the other up in the Agent table so
    // TicketCard / activity log don't see a half-stale row.
    if (assignee !== undefined || assignee_id !== undefined) {
      const resolved = await resolveAgentIdAndName(
        this.dataSource,
        assignee_id !== undefined ? assignee_id : (ticket.assignee_id || ''),
        assignee !== undefined ? assignee : (ticket.assignee || ''),
      );
      ticket.assignee = assignee !== undefined ? assignee : resolved.name;
      ticket.assignee_id = assignee_id !== undefined ? assignee_id : resolved.id;
    }
    if (reporter !== undefined || reporter_id !== undefined) {
      const resolved = await resolveAgentIdAndName(
        this.dataSource,
        reporter_id !== undefined ? reporter_id : (ticket.reporter_id || ''),
        reporter !== undefined ? reporter : (ticket.reporter || ''),
      );
      ticket.reporter = reporter !== undefined ? reporter : resolved.name;
      ticket.reporter_id = reporter_id !== undefined ? reporter_id : resolved.id;
    }
    if (reviewer_id !== undefined) ticket.reviewer_id = reviewer_id;
    if (labels !== undefined) ticket.labels = JSON.stringify(labels);
    if (channel_ids !== undefined) ticket.channel_ids = JSON.stringify(channel_ids);
    // Phase 1 ticket prompt snapshot (D-17 / ROLE-08)
    if (prompt_text !== undefined) ticket.prompt_text = prompt_text;
    if (base_repo_resource_id !== undefined) {
      const next = base_repo_resource_id || '';
      if (next && ticket.workspace_id) {
        // Confine the picker to the ticket's workspace — without this an
        // attacker who guesses (or scrapes) a Resource id from another
        // workspace could pin it here, and the trigger SSE / loadTicketFull
        // snapshot would happily surface its url to the assignee.
        const repoExists = await this.dataSource.getRepository(Resource).findOne({
          where: { id: next, workspace_id: ticket.workspace_id },
        });
        if (!repoExists) return res.status(400).json({ error: 'base_repo_resource_id not found in this workspace' });
      }
      ticket.base_repo_resource_id = next;
    }
    if (base_branch !== undefined) ticket.base_branch = base_branch || '';

    await this.ticketRepo.save(ticket);

    // v0.34: mirror builtin role changes onto TicketRoleAssignment so the
    // trigger loop / mention resolution stay in sync. Each slot is only
    // synced when the caller actually included the field — passing
    // undefined leaves the assignment untouched (matches REST semantics
    // where unspecified fields preserve their value).
    if (ticket.workspace_id) {
      const trio: { assignee_id?: string; reporter_id?: string; reviewer_id?: string } = {};
      if (assignee !== undefined || assignee_id !== undefined) trio.assignee_id = ticket.assignee_id || '';
      if (reporter !== undefined || reporter_id !== undefined) trio.reporter_id = ticket.reporter_id || '';
      if (reviewer_id !== undefined) trio.reviewer_id = ticket.reviewer_id || '';
      if (Object.keys(trio).length > 0) {
        await this.ticketRoleAssignments.syncBuiltinTrio(ticket.id, ticket.workspace_id, trio);
      }
    }

    if (status !== undefined && status !== oldStatus) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'status_changed',
        field_changed: 'status', old_value: oldStatus || '', new_value: status,
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: actorId, actor_name: actorName,
      });
    }
    // Trigger off the post-save name (which now reflects backfilled lookups)
    // so a caller passing only `assignee_id` still produces a legible
    // activity entry instead of an empty `→` arrow.
    if ((assignee !== undefined || assignee_id !== undefined) && ticket.assignee !== oldAssignee) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'assignee', old_value: oldAssignee || '', new_value: ticket.assignee || '',
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: actorId, actor_name: actorName,
      });
    }
    if ((reporter !== undefined || reporter_id !== undefined) && ticket.reporter !== oldReporter) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'reporter', old_value: oldReporter || '', new_value: ticket.reporter || '',
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
    if (base_repo_resource_id !== undefined && (base_repo_resource_id || '') !== (oldBaseRepoId || '')) changes.push('base_repo');
    if (base_branch !== undefined && (base_branch || '') !== (oldBaseBranch || '')) changes.push('base_branch');
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
   * Re-parent a ticket. Two modes:
   *   - `parent_id` set     → make the ticket a subtask of that parent.
   *                            Sibling positions shift; column_id is cleared
   *                            because non-root tickets don't live on a column.
   *   - `parent_id` is null → promote the ticket back to root. Caller must
   *                            supply `column_id` (which board column to land
   *                            in); position defaults to end of column.
   *
   * Validates:
   *   - cycle: target parent must not be the ticket itself or a descendant
   *   - depth: subtree's deepest leaf must still fit under the 2-level cap
   *   - workspace: parent must share the ticket's workspace
   * Descendant depths are recomputed in the same transaction.
   */
  @Patch('tickets/:id/parent')
  async reparent(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');

    const rawParent = body?.parent_id;
    const newParentId: string | null = rawParent === null || rawParent === '' || rawParent === undefined
      ? null
      : String(rawParent);
    const targetColumnId: string | undefined = body?.column_id ? String(body.column_id) : undefined;
    const targetPosition: number | undefined = typeof body?.targetPosition === 'number'
      ? body.targetPosition
      : undefined;

    if (newParentId === ticket.id) {
      return res.status(400).json({ error: 'A ticket cannot be its own parent' });
    }

    // Pull the moving ticket's full subtree once so we can: (a) detect a cycle
    // when the requested parent is itself a descendant, (b) compute the
    // subtree's max depth offset for the cap check, and (c) re-stamp depths.
    const subtree = await this._collectSubtree(ticket.id);
    const subtreeIds = new Set(subtree.map(t => t.id));
    const subtreeMaxDepth = subtree.reduce((max, t) => Math.max(max, t.depth), ticket.depth) - ticket.depth;

    let newDepth = 0;
    let parent: Ticket | null = null;
    if (newParentId) {
      if (subtreeIds.has(newParentId)) {
        return res.status(400).json({ error: 'Cannot re-parent under self or a descendant' });
      }
      parent = await this.ticketRepo.findOne({ where: { id: newParentId } });
      if (!parent) return res.status(400).json({ error: 'Parent ticket not found' });
      if (ticket.workspace_id && parent.workspace_id && parent.workspace_id !== ticket.workspace_id) {
        return res.status(400).json({ error: 'Parent ticket belongs to a different workspace' });
      }
      newDepth = parent.depth + 1;
    } else {
      // Promotion to root requires a target column.
      if (!targetColumnId) {
        return res.status(400).json({ error: 'column_id is required when parent_id is null' });
      }
      const col = await this.colRepo.findOne({ where: { id: targetColumnId } });
      if (!col) return res.status(400).json({ error: 'Target column not found' });
      newDepth = 0;
    }

    if (newDepth + subtreeMaxDepth > 2) {
      return res.status(400).json({ error: 'Reparent would exceed maximum depth of 2' });
    }

    // No-op early-out: same parent and (for root tickets) same column with no
    // position change. Lets the UI fire reparent on every drop without us
    // having to bookkeep "did anything actually change" upstream.
    const oldParentId = ticket.parent_id;
    const oldColumnId = ticket.column_id;
    if (newParentId === oldParentId
        && (newParentId !== null || (targetColumnId && targetColumnId === oldColumnId))
        && targetPosition === undefined) {
      const unchanged = await loadTicketFull(this.dataSource, ticket.id);
      return res.json(unchanged);
    }

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);

      // 1) Close the gap left in the source scope.
      if (oldParentId) {
        await shiftTicketPositions(tRepo, { parent_id: oldParentId }, ticket.position, -1);
      } else if (oldColumnId) {
        await shiftTicketPositions(tRepo, { column_id: oldColumnId }, ticket.position, -1);
      }

      // 2) Compute the destination position.
      let pos: number;
      if (newParentId) {
        const destCount = await tRepo
          .createQueryBuilder('t')
          .where('t.parent_id = :pid AND t.id != :id', { pid: newParentId, id: ticket.id })
          .getCount();
        pos = Math.min(targetPosition ?? destCount, destCount);
        await shiftTicketPositions(tRepo, { parent_id: newParentId }, pos, +1, { inclusive: true, excludeId: ticket.id });
      } else {
        const destCol = targetColumnId!;
        const destCount = await tRepo
          .createQueryBuilder('t')
          .where('t.column_id = :cid AND t.id != :id AND t.parent_id IS NULL', { cid: destCol, id: ticket.id })
          .getCount();
        pos = Math.min(targetPosition ?? destCount, destCount);
        await shiftTicketPositions(tRepo, { column_id: destCol }, pos, +1, { inclusive: true, excludeId: ticket.id });
      }

      // 3) Update the moving ticket. column_id is nulled when the ticket is
      // parented (children don't live on a column); set to target column when
      // promoted to root.
      await tRepo.update(ticket.id, {
        parent_id: newParentId,
        depth: newDepth,
        column_id: newParentId ? (null as any) : targetColumnId!,
        position: pos,
      });

      // 4) Re-stamp depths of descendants. Each was previously at
      // (ticket.depth + offset); set to (newDepth + offset).
      const depthDelta = newDepth - ticket.depth;
      if (depthDelta !== 0) {
        for (const desc of subtree) {
          if (desc.id === ticket.id) continue;
          await tRepo.update(desc.id, { depth: desc.depth + depthDelta });
        }
      }
    });

    const updated = await loadTicketFull(this.dataSource, ticket.id);

    const currentUser = req.currentUser;
    const oldParentTitle = oldParentId
      ? (await this.ticketRepo.findOne({ where: { id: oldParentId } }))?.title || oldParentId
      : (oldColumnId ? (await this.colRepo.findOne({ where: { id: oldColumnId } }))?.name || oldColumnId : '');
    const newParentTitle = newParentId
      ? parent?.title || newParentId
      : (targetColumnId ? (await this.colRepo.findOne({ where: { id: targetColumnId } }))?.name || targetColumnId : '');
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
      field_changed: 'parent', old_value: oldParentTitle, new_value: newParentTitle,
      ticket_id: newParentId
        ? (parent?.parent_id || newParentId)
        : ticket.id,
      actor_id: currentUser?.id,
      actor_name: currentUser?.name || currentUser?.email,
    });

    return res.json(updated);
  }

  /**
   * Move a root ticket (with its entire subtree) to a different board.
   * Body: { target_board_id, target_column_id?, target_position? }
   *
   * Subtasks travel automatically — they're attached via parent_id and
   * carry column_id=null, so changing the root's column_id doesn't require
   * touching descendants. Same-workspace constraint mirrors reparent;
   * cross-workspace moves would invalidate channel/role/agent references.
   *
   * If target_column_id is omitted, lands in the target board's first
   * column (lowest position).
   */
  @Patch('tickets/:id/move-to-board')
  async moveToBoard(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');

    if (ticket.parent_id || ticket.depth > 0) {
      return res.status(400).json({ error: 'Only root tickets can be moved across boards' });
    }

    const targetBoardId: string | undefined = body?.target_board_id ? String(body.target_board_id) : undefined;
    if (!targetBoardId) return res.status(400).json({ error: 'target_board_id is required' });

    const targetColumnIdRaw: string | undefined = body?.target_column_id ? String(body.target_column_id) : undefined;
    const targetPosition: number | undefined = typeof body?.target_position === 'number'
      ? body.target_position
      : undefined;

    const boardRepo = this.dataSource.getRepository(Board);
    const targetBoard = await boardRepo.findOne({ where: { id: targetBoardId } });
    if (!targetBoard) return res.status(400).json({ error: 'Target board not found' });

    if (ticket.workspace_id && targetBoard.workspace_id && targetBoard.workspace_id !== ticket.workspace_id) {
      return res.status(400).json({ error: 'Target board belongs to a different workspace' });
    }

    // Resolve target column: explicit if given (must belong to target board),
    // otherwise the first column on that board by position.
    let targetCol: BoardColumn | null;
    if (targetColumnIdRaw) {
      targetCol = await this.colRepo.findOne({ where: { id: targetColumnIdRaw } });
      if (!targetCol) return res.status(400).json({ error: 'Target column not found' });
      if (targetCol.board_id !== targetBoardId) {
        return res.status(400).json({ error: 'Target column does not belong to target board' });
      }
    } else {
      const cols = await this.colRepo.find({ where: { board_id: targetBoardId } as any, order: { position: 'ASC' as any } });
      if (cols.length === 0) return res.status(400).json({ error: 'Target board has no columns' });
      targetCol = cols[0];
    }

    // Resolve source board (current column → board) for the no-op check and
    // activity log. column_id should always be set on a root ticket; the
    // null guard is just defensive.
    const sourceCol = ticket.column_id
      ? await this.colRepo.findOne({ where: { id: ticket.column_id } })
      : null;
    const sourceBoardId = sourceCol?.board_id ?? null;

    if (sourceBoardId === targetBoardId && targetCol.id === ticket.column_id && targetPosition === undefined) {
      const unchanged = await loadTicketFull(this.dataSource, ticket.id);
      return res.json(unchanged);
    }

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);

      // 1) Close the gap in the source column.
      if (ticket.column_id) {
        await shiftTicketPositions(tRepo, { column_id: ticket.column_id }, ticket.position, -1);
      }

      // 2) Compute destination position in the target column and open a slot.
      const destCount = await tRepo.createQueryBuilder('t')
        .where('t.column_id = :colId AND t.id != :id AND t.parent_id IS NULL', { colId: targetCol!.id, id: ticket.id })
        .getCount();
      const pos = Math.min(targetPosition ?? destCount, destCount);
      await shiftTicketPositions(tRepo, { column_id: targetCol!.id }, pos, +1, { inclusive: true, excludeId: ticket.id });

      // 3) Update the ticket. workspace_id is preserved (same-workspace
      // constraint guaranteed above) so subtasks remain consistent.
      await tRepo.update(ticket.id, { column_id: targetCol!.id, position: pos });
    });

    const updated = await loadTicketFull(this.dataSource, ticket.id);

    const sourceBoard = sourceBoardId
      ? await boardRepo.findOne({ where: { id: sourceBoardId } })
      : null;

    const currentUser = req.currentUser;
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'moved',
      field_changed: 'board',
      old_value: sourceBoard?.name || sourceBoardId || '',
      new_value: targetBoard.name || targetBoardId,
      ticket_id: ticket.id,
      actor_id: currentUser?.id,
      actor_name: currentUser?.name || currentUser?.email,
    });

    return res.json(updated);
  }

  /**
   * BFS from `rootId` collecting the ticket plus every descendant. Used by
   * reparent for cycle detection and depth re-stamping. Stays bounded by the
   * 2-level depth cap, so worst case is one root → N children → M grandchildren.
   */
  private async _collectSubtree(rootId: string): Promise<Ticket[]> {
    const out: Ticket[] = [];
    const queue: string[] = [rootId];
    while (queue.length > 0) {
      const ids = queue.splice(0, queue.length);
      const rows = await this.ticketRepo.find({ where: { id: In(ids) } as any });
      for (const r of rows) out.push(r);
      const children = await this.ticketRepo.find({ where: { parent_id: In(ids) } as any });
      for (const c of children) queue.push(c.id);
    }
    // Dedupe just in case the caller hits an unexpected cycle.
    const seen = new Set<string>();
    return out.filter(t => seen.has(t.id) ? false : (seen.add(t.id), true));
  }

  /**
   * List the resolved role assignments for a ticket — one row per
   * WorkspaceRole that has an assignment (rows with no assignment are
   * omitted; the client merges this with the workspace's full role list to
   * render an empty slot for unfilled roles).
   *
   * Each entry: { role: {id, slug, name, position, is_builtin}, holder: {type, id, name} | null }
   */
  @Get('tickets/:id/role-assignments')
  async listRoleAssignments(@Param('id') id: string, @Res() res: Response) {
    await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    const resolved = await this.ticketRoleAssignments.resolveForTicket(id);
    return res.json(resolved.map(r => ({
      role: {
        id: r.role.id, slug: r.role.slug, name: r.role.name,
        position: r.role.position, is_builtin: r.role.is_builtin,
      },
      holder: r.holder,
    })));
  }

  /**
   * Set (or clear) the holder of a single role on a ticket. Body:
   *   { agent_id?: string|null, user_id?: string|null }
   * Mutually exclusive — passing both rejects with 400. Both null/empty
   * clears the slot (deletes the assignment row).
   *
   * Builtin slugs (`assignee`/`reporter`/`reviewer`) are mirrored back to the
   * legacy ticket columns so older code paths (TicketCard, activity log,
   * agent allocation fallbacks) keep seeing the same value. Custom slugs
   * have no mirror — they live only in TicketRoleAssignment.
   */
  @Put('tickets/:id/role-assignments/:roleId')
  async setRoleAssignment(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Body() body: any,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    const agent_id: string | null = body?.agent_id || null;
    const user_id: string | null = body?.user_id || null;
    if (agent_id && user_id) {
      return res.status(400).json({ error: 'cannot set both agent_id and user_id' });
    }

    const roleRepo = this.dataSource.getRepository(WorkspaceRole);
    const role = await roleRepo.findOne({ where: { id: roleId } });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (ticket.workspace_id && role.workspace_id !== ticket.workspace_id) {
      return res.status(400).json({ error: 'Role belongs to a different workspace' });
    }

    // Validate the holder exists. Skipping this would let a typo silently
    // pin a dead id onto the ticket.
    let agentName = '';
    let userName = '';
    if (agent_id) {
      const a = await this.agentRepo.findOne({ where: { id: agent_id } });
      if (!a) return res.status(404).json({ error: 'Agent not found' });
      agentName = a.name;
    }
    if (user_id) {
      const u = await this.dataSource.getRepository(User).findOne({ where: { id: user_id } });
      if (!u) return res.status(404).json({ error: 'User not found' });
      userName = u.name || u.email;
    }

    try {
      await this.ticketRoleAssignments.setHolder(id, roleId, { agent_id, user_id });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to update role' });
    }

    // Mirror builtin slugs onto the legacy ticket columns. Display-name
    // columns (`assignee`, `reporter`) get the holder's name when an agent
    // or user fills the slot, blank when cleared. There's no historical
    // `reviewer` name column, only `reviewer_id`.
    const legacyMap: Record<string, { id: 'assignee_id' | 'reporter_id' | 'reviewer_id'; name?: 'assignee' | 'reporter' }> = {
      assignee: { id: 'assignee_id', name: 'assignee' },
      reporter: { id: 'reporter_id', name: 'reporter' },
      reviewer: { id: 'reviewer_id' },
    };
    const mirror = legacyMap[role.slug];
    let beforeId = '';
    if (mirror) {
      beforeId = (ticket as any)[mirror.id] || '';
      const newId = agent_id || user_id || '';
      const update: any = { [mirror.id]: newId };
      if (mirror.name) update[mirror.name] = agentName || userName || '';
      await this.ticketRepo.update(id, update);
    }

    const currentUser = req.currentUser;
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: id, action: 'updated',
      field_changed: mirror ? role.slug : `role:${role.slug}`,
      old_value: beforeId,
      new_value: agentName || userName || '',
      ticket_id: ticket.parent_id || ticket.id,
      actor_id: currentUser?.id,
      actor_name: currentUser?.name || currentUser?.email,
    });

    const resolved = await this.ticketRoleAssignments.resolveForTicket(id);
    return res.json({
      assignments: resolved.map(r => ({
        role: {
          id: r.role.id, slug: r.role.slug, name: r.role.name,
          position: r.role.position, is_builtin: r.role.is_builtin,
        },
        holder: r.holder,
      })),
    });
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
    if (!role) {
      return res.status(400).json({ error: 'role is required (workspace role slug)' });
    }
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    const explicitAgentId = body?.agent_id ? String(body.agent_id) : '';

    // Resolve the role holder against the workspace role catalog. Legacy
    // ticket columns (assignee_id / reporter_id / reviewer_id) are still
    // checked as a fallback so v1 callers that haven't migrated keep working
    // for the builtin three slugs.
    let targetAgentId = explicitAgentId;
    if (!targetAgentId) {
      const holder = await this.ticketRoleAssignments.getHolderBySlug(id, ticket.workspace_id, role);
      if (holder) targetAgentId = holder.agent_id || '';
      if (!targetAgentId) {
        const legacyField = role === 'assignee' ? 'assignee_id'
          : role === 'reporter' ? 'reporter_id'
          : role === 'reviewer' ? 'reviewer_id'
          : null;
        if (legacyField) targetAgentId = (ticket as any)[legacyField] || '';
      }
    }
    if (!targetAgentId) {
      return res.status(400).json({
        error: `No agent holds role '${role}' on this ticket. Set the holder first, or pass agent_id in the body.`,
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

  // ─── Ticket-level attachments ───────────────────────────
  // Files attached directly to the ticket — distinct from comment attachments
  // (which live as Resource rows). Stored inline on the ticket_attachments
  // table so binary lifecycle stays bound to the ticket and cascades on
  // ticket delete without a Resource indirection.

  @Get('tickets/:id/attachments')
  async listAttachments(@Param('id') id: string, @Res() res: Response) {
    await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    const rows = await this.attachmentRepo.find({
      where: { ticket_id: id },
      order: { created_at: 'DESC' },
    });
    return res.json(rows.map(r => projectTicketAttachment(r, { includeData: false })));
  }

  @Get('tickets/:id/attachments/:attachmentId')
  async getAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const row = await this.attachmentRepo.findOne({ where: { id: attachmentId, ticket_id: id } });
    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    return res.json(projectTicketAttachment(row, { includeData: true }));
  }

  @Post('tickets/:id/attachments')
  async addAttachments(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');

    // Accept either a single `{file_name, file_data, file_mimetype}` object
    // OR an array of them under `attachments`. Mirrors the comment endpoint's
    // pattern of letting clients batch related uploads in one call.
    const incoming: any[] = Array.isArray(body?.attachments)
      ? body.attachments
      : (body?.file_data ? [body] : []);
    if (incoming.length === 0) {
      return res.status(400).json({ error: 'attachments[] (or a single file_data + file_name) is required' });
    }

    const existingCount = await this.attachmentRepo.count({ where: { ticket_id: id } });
    if (existingCount + incoming.length > MAX_TICKET_ATTACHMENTS) {
      return res.status(400).json({
        error: `Maximum ${MAX_TICKET_ATTACHMENTS} attachments per ticket (have ${existingCount}, adding ${incoming.length})`,
      });
    }

    for (const f of incoming) {
      if (!f || typeof f !== 'object' || !f.file_data || !f.file_name) {
        return res.status(400).json({ error: 'Each attachment must include file_data and file_name' });
      }
      if (approxBase64Size(f.file_data) > MAX_TICKET_ATTACHMENT_SIZE) {
        return res.status(400).json({
          error: `Attachment ${f.file_name} exceeds ${MAX_TICKET_ATTACHMENT_SIZE / 1024 / 1024}MB limit`,
        });
      }
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(TicketAttachment);
      const created: TicketAttachment[] = [];
      for (const f of incoming) {
        const mimetype = inferTicketAttachmentMimetype(f.file_name, f.file_mimetype);
        const row = await repo.save(repo.create({
          ticket_id: id,
          workspace_id: ticket.workspace_id || '',
          file_name: f.file_name,
          file_mimetype: mimetype,
          file_data: f.file_data,
          file_size: approxBase64Size(f.file_data),
          uploaded_by_type: 'user',
          uploaded_by_id: currentUser.id,
          uploaded_by: currentUser.name || currentUser.email || '',
        }));
        created.push(row);
      }
      return created;
    });

    for (const row of saved) {
      await this.activityService.logActivity({
        entity_type: 'ticket',
        entity_id: ticket.id,
        action: 'updated',
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: currentUser.id,
        actor_name: currentUser.name || currentUser.email,
        field_changed: 'attachment',
        new_value: row.file_name,
      });
    }

    return res.status(201).json(saved.map(r => projectTicketAttachment(r, { includeData: false })));
  }

  @Delete('tickets/:id/attachments/:attachmentId')
  async deleteAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    const row = await this.attachmentRepo.findOne({ where: { id: attachmentId, ticket_id: id } });
    if (!row) return res.status(404).json({ error: 'Attachment not found' });

    await this.attachmentRepo.delete({ id: attachmentId });

    await this.activityService.logActivity({
      entity_type: 'ticket',
      entity_id: ticket.id,
      action: 'updated',
      ticket_id: ticket.parent_id || ticket.id,
      actor_id: currentUser.id,
      actor_name: currentUser.name || currentUser.email,
      field_changed: 'attachment',
      old_value: row.file_name,
    });

    return res.json({ success: true, id: attachmentId });
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
        svg: 'image/svg+xml',
        pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
        zip: 'application/zip', csv: 'text/csv',
        mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
        webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
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

    const resolved = await this.mentionService.resolveMentions(refs, ticket);
    if (resolved.length === 0) return;

    const preview = (comment.content || '').slice(0, 500);
    const ts = (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString();

    // Deep-link plumbing: resolve board_id once so each user-mention SSE
    // payload carries enough context for MentionInboxBadge to navigate to
    // /ws/<wsId>/boards/<boardId>?ticket=<id>&comment=<id> without a
    // second round-trip. Lookup is best-effort — if the column row is
    // missing for any reason the inbox falls back to the boards index.
    let boardId: string | null = null;
    if (ticket.column_id) {
      const col = await this.colRepo.findOne({ where: { id: ticket.column_id } });
      boardId = col?.board_id ?? null;
    }

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
          board_id: boardId,
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
