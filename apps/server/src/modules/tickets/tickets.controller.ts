import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment, COMMENT_TYPES, CommentType } from '../../entities/Comment';
import { UserMention } from '../../entities/UserMention';
import { TicketReadState } from '../../entities/TicketReadState';
import { User } from '../../entities/User';
import { AuthGuard } from '../../common/guards/auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ActivityService } from '../../services/activity.service';
import { activityEvents } from '../../services/activity.service';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { LogService } from '../../services/log.service';
import { MentionService } from '../../services/mention.service';
import { PresenceService } from '../../services/presence.service';
import { TicketDispatchService } from '../agents/ticket-dispatch.service';
import { TicketPrerequisitesService } from './ticket-prerequisites.service';
import { TicketInputError, TicketService, type TicketActor } from './ticket.service';
import {
  MAX_COMMENT_ATTACHMENT_SIZE,
  MAX_COMMENT_ATTACHMENTS,
  MAX_TICKET_ATTACHMENT_SIZE,
  MAX_TICKET_ATTACHMENTS,
} from '../../common/constants/upload';
import { Resource } from '../../entities/Resource';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { loadTicketFull, parseComments, expandCommentAttachments, loadTicketComments, DETAIL_COMMENT_PAGE } from '../mcp/shared/ticket-parsing';
import { getRootArchivedAt, TicketArchivedError } from '../mcp/shared/archive-helpers';
import {
  maxChildPosition,
  shiftTicketPositions,
  deleteCommentAttachmentsForTicket,
  inferTicketAttachmentMimetype,
  projectTicketAttachment,
  approxBase64Size,
} from '../mcp/shared/ticket-helpers';
import { findOrFail } from '../../common/find-or-fail';
import { computeTicketCommentChainDepth } from '../../common/agent-chain-depth';
import { resolveMentionTarget } from '../../common/mention-dispatch-profile';
import { TicketDuplicateService } from './ticket-duplicate.service';
import { ArtifactRefsService } from '../artifact-refs/artifact-refs.service';
import { normalizeTags } from './ticket.service';
import { parseTicketStatus, TICKET_STATUSES, type TicketStatus } from '../../common/ticket-status';

/**
 * Ticket REST surface (docs/tickets.md). Mutations go through TicketService so
 * REST, MCP and the automatic ticket producers share one set of side effects.
 */
@ApiBearerAuth('user-session')
@ApiTags('tickets')
@Controller('api')
@UseGuards(AuthGuard, WorkspaceGuard)
export class TicketsController {
  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectRepository(UserMention) private readonly mentionRepo: Repository<UserMention>,
    @InjectRepository(TicketReadState) private readonly readStateRepo: Repository<TicketReadState>,
    @InjectRepository(TicketAttachment) private readonly attachmentRepo: Repository<TicketAttachment>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
    private readonly mentionService: MentionService,
    private readonly tickets: TicketService,
    private readonly dispatcher: TicketDispatchService,
    private readonly presence: PresenceService,
    private readonly ticketPrerequisites: TicketPrerequisitesService,
    private readonly ticketDuplicates: TicketDuplicateService,
    private readonly artifactRefs: ArtifactRefsService,
    // ticket 0f638509 — instance-wide fleet quiesce. @Global() (see
    // shared-services.module.ts), cycle-free.
    private readonly instanceQuiesce: InstanceQuiesceService,
  ) {}

  private actorOf(req: any): TicketActor {
    const user = req.currentUser;
    return user ? { id: user.id, name: user.name || user.email || '', type: 'user' } : { id: '', name: '', type: 'system' };
  }

  private fail(res: Response, err: any): Response {
    if (err instanceof TicketInputError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof TicketArchivedError) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: err.message });
    throw err;
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
    const currentUser = req.currentUser;
    if (currentUser) {
      return { created_by: currentUser.name, created_by_type: 'user', created_by_id: currentUser.id };
    }
    return { created_by: '', created_by_type: '', created_by_id: '' };
  }

  // ─── list / create ──────────────────────────────────────

  @Get('workspaces/:wsId/tickets')
  async list(@Param('wsId') wsId: string, @Req() req: Request, @Res() res: Response) {
    const q = req.query as Record<string, string | undefined>;
    const split = (v: string | undefined) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
    const statuses: TicketStatus[] = [];
    for (const raw of split(q.status)) {
      const status = parseTicketStatus(raw);
      if (!status) return res.status(400).json({ error: `status must be one of ${TICKET_STATUSES.join(', ')}` });
      statuses.push(status);
    }
    const result = await this.tickets.list(wsId, {
      status: statuses,
      tags: split(q.tags),
      project_id: q.project_id || undefined,
      assignee_key: q.assignee_key || undefined,
      q: q.q || undefined,
      include_archived: q.include_archived === '1' || q.include_archived === 'true',
      archived_only: q.archived_only === '1' || q.archived_only === 'true',
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return res.json(result);
  }

  @Get('workspaces/:wsId/ticket-tags')
  async tags(@Param('wsId') wsId: string, @Res() res: Response) {
    return res.json({ tags: await this.tickets.tagSuggestions(wsId) });
  }

  @Post('workspaces/:wsId/tickets')
  async create(@Param('wsId') wsId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const { ticket, duplicate_candidates } = await this.tickets.create(wsId, body, this.actorOf(req));
      const full = await loadTicketFull(this.dataSource, ticket.id, { commentLimit: DETAIL_COMMENT_PAGE });
      return res.status(201).json({ ...full, duplicate_candidates });
    } catch (err) {
      return this.fail(res, err);
    }
  }

  @Post('tickets/:id/duplicate-decision')
  async decideDuplicate(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const workspaceId = (req as any).currentWorkspaceId as string;
    const existing = await this.ticketRepo.findOne({ where: { id, workspace_id: workspaceId } });
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    const actor = this.resolveCreator(req, body);
    try {
      const ticket = await this.ticketDuplicates.confirm(
        id,
        body.action === 'keep_independent' ? null : String(body.candidate_ticket_id || ''),
        actor.created_by,
        actor.created_by_id,
      );
      if (!ticket.canonical_ticket_id) {
        await this.dispatcher.resumeTicket(ticket.id, 'duplicate_rejected');
      }
      return res.json(ticket);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'Duplicate decision rejected' });
    }
  }

  @Post('tickets/:parentId/children')
  async createChild(@Param('parentId') parentId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const parent = await findOrFail(this.ticketRepo, { where: { id: parentId } }, 'Parent ticket not found');
    // Archive gate — the root row owns archived_at; subtasks don't carry it.
    const rootArchived = await getRootArchivedAt(this.dataSource, parent);
    if (rootArchived) {
      return res.status(409).json({
        error: 'ticket_archived',
        hint: 'Call unarchive first',
        message: new TicketArchivedError(parent.id).message,
      });
    }
    const childDepth = parent.depth + 1;
    if (childDepth > 2) return res.status(400).json({ error: 'Maximum depth of 2 exceeded' });
    const { title, description = '', priority = 'medium' } = body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const status = body.status === 'done' ? 'done' : 'todo';
    const creator = this.resolveCreator(req, body);
    const position = await maxChildPosition(this.dataSource, parentId);
    const child = await this.ticketRepo.save(this.ticketRepo.create({
      parent_id: parentId, depth: childDepth,
      title, description, priority, status,
      tags: JSON.stringify(normalizeTags(body.tags ?? [])),
      channel_ids: JSON.stringify(Array.isArray(body.channel_ids) ? body.channel_ids : []),
      position,
      workspace_id: parent.workspace_id || '',
      created_by: creator.created_by, created_by_type: creator.created_by_type, created_by_id: creator.created_by_id,
    }));
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: child.id, action: 'created',
      ticket_id: parent.depth === 0 ? parentId : parent.parent_id || parentId,
      workspace_id: child.workspace_id,
      actor_id: creator.created_by_id || undefined,
      actor_name: creator.created_by,
      new_value: title,
    });
    return res.status(201).json({ ...this.tickets.serialize(child), children: [], comments: [] });
  }

  // ─── unread / read-all ──────────────────────────────────

  // 한 워크스페이스 내에서 `userId`가 "관여"하는 티켓 ID 집합: 만든 사람이거나
  // TicketReadState 행이 있는(=한 번이라도 읽은 적 있는) 티켓 — 아카이브된
  // 티켓은 어느 쪽이든 제외. unreadCounts 와 markAllTicketsRead 가 이 메서드를
  // 공유해 "관여" 판정 기준이 항상 일치하도록 한다.
  private async _getInvolvedTicketIds(
    wsId: string,
    userId: string,
  ): Promise<{ involvedIds: string[]; readBy: Record<string, Date | null> }> {
    const ownTickets = await this.ticketRepo
      .createQueryBuilder('t')
      .select('t.id', 'id')
      .where('t.workspace_id = :wsId', { wsId })
      .andWhere('t.created_by_id = :uid', { uid: userId })
      .andWhere('t.archived_at IS NULL')
      .getRawMany();
    const readRows = await this.readStateRepo
      .createQueryBuilder('r')
      .select('r.ticket_id', 'id')
      .addSelect('r.last_read_at', 'last_read_at')
      .where('r.user_id = :uid AND r.workspace_id = :wsId', { uid: userId, wsId })
      .getRawMany();
    // A ticket the user once read and that has since been archived must not
    // keep pinging the badge.
    const ownIds = new Set<string>(ownTickets.map((t) => t.id));
    const readOnlyIds = readRows.map((r) => r.id).filter((id: string) => !ownIds.has(id));
    const liveReadOnlyIds = readOnlyIds.length > 0
      ? (await this.ticketRepo
          .createQueryBuilder('t')
          .select('t.id', 'id')
          .where('t.id IN (:...ids)', { ids: readOnlyIds })
          .andWhere('t.workspace_id = :wsId', { wsId })
          .andWhere('t.archived_at IS NULL')
          .getRawMany()).map((r) => r.id as string)
      : [];
    const involvedIds = Array.from(new Set<string>([...ownIds, ...liveReadOnlyIds]));
    const readBy: Record<string, Date | null> = {};
    for (const r of readRows) readBy[r.id] = r.last_read_at ? new Date(r.last_read_at) : null;
    return { involvedIds, readBy };
  }

  // IMPORTANT: keep `tickets/unread-counts` above `tickets/:id` — Express
  // picks the first matching pattern, and `:id` would eat the literal
  // "unread-counts" segment (producing a 404 "Ticket not found").
  // Sidebar badge + per-ticket badge source: unread comment counts on tickets
  // the current user is involved in (see _getInvolvedTicketIds).
  @Get('tickets/unread-counts')
  async unreadCounts(@Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    const wsId = (req.headers['x-workspace-id'] as string) || '';
    if (!wsId) return res.status(400).json({ error: 'Workspace ID required' });

    const { involvedIds, readBy } = await this._getInvolvedTicketIds(wsId, currentUser.id);
    if (involvedIds.length === 0) return res.json({ total: 0, perTicket: {} });

    const perTicket: Record<string, number> = {};
    let total = 0;
    const comments = await this.commentRepo
      .createQueryBuilder('c')
      .select(['c.ticket_id AS ticket_id', 'c.created_at AS created_at', 'c.author_id AS author_id'])
      .where('c.ticket_id IN (:...ids)', { ids: involvedIds })
      .getRawMany();
    for (const c of comments) {
      if (c.author_id === currentUser.id) continue;
      const cutoff = readBy[c.ticket_id];
      if (cutoff && new Date(c.created_at) <= cutoff) continue;
      perTicket[c.ticket_id] = (perTicket[c.ticket_id] || 0) + 1;
      total++;
    }
    return res.json({ total, perTicket });
  }

  // 티켓 코멘트 일괄 "읽음 처리" — 관여 티켓(_getInvolvedTicketIds)에만
  // 스코프되어 호출자가 아무 지분도 없는 티켓엔 read-state 행을 만들 수 없다.
  // 처리 후 `ticket_reads_cleared` 를 emit 해 같은 사용자의 다른 탭/기기도
  // 재조회 없이 뱃지를 수렴시킨다.
  @Post('tickets/read-all')
  async markAllTicketsRead(@Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    const wsId = (req.headers['x-workspace-id'] as string) || '';
    if (!wsId) return res.status(400).json({ error: 'Workspace ID required' });

    const { involvedIds } = await this._getInvolvedTicketIds(wsId, currentUser.id);
    if (involvedIds.length === 0) return res.json({ updated: 0 });
    const now = new Date();
    await this.readStateRepo.upsert(involvedIds.map((id) => ({
      user_id: currentUser.id, ticket_id: id, workspace_id: wsId, last_read_at: now,
    })), ['user_id', 'ticket_id']);
    activityEvents.emit('ticket_reads_cleared', {
      user_id: currentUser.id,
      workspace_id: wsId,
      updated: involvedIds.length,
      read_at: now.toISOString(),
    });
    return res.json({ updated: involvedIds.length });
  }

  // ─── read ───────────────────────────────────────────────

  @Get('tickets/:id')
  async get(@Param('id') id: string, @Res() res: Response) {
    // bounded 코멘트 로드: detail 패널은 처음엔 최신 페이지만 필요하고 더 오래된
    // 코멘트는 GET /tickets/:id/comments 로 scroll-load 한다.
    const ticket = await loadTicketFull(this.dataSource, id, { commentLimit: DETAIL_COMMENT_PAGE });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    return res.json(ticket);
  }

  // 단일 티켓(root/하위)의 커서 페이지네이션 코멘트: `limit`(기본 50, 최대 200)
  // + `before`(코멘트 id)로 복합 (created_at, id) 커서를 따라간다. 최신순.
  @Get('tickets/:id/comments')
  async getComments(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const limit = parseInt(req.query.limit as string, 10) || DETAIL_COMMENT_PAGE;
    const before = (req.query.before as string) || undefined;
    const comments = await loadTicketComments(this.dataSource, id, { limit, before });
    return res.json(comments);
  }

  // ─── update / move / run ────────────────────────────────

  @Patch('tickets/:id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });
    const actor = this.actorOf(req);
    try {
      // Pending flag first: the panel's "needs you" toggle. Clearing it wakes
      // the assignee (TicketService.unpend → resumeTicket).
      if (body.pending_user_action !== undefined) {
        if (body.pending_user_action) {
          if (!ticket.pending_user_action || (body.pending_reason !== undefined && body.pending_reason !== ticket.pending_reason)) {
            await this.tickets.pend(ticket.id, body.pending_reason ?? ticket.pending_reason ?? '', actor);
          }
        } else if (ticket.pending_user_action) {
          await this.tickets.unpend(ticket.id, actor);
        }
      } else if (body.pending_reason !== undefined && ticket.pending_user_action && body.pending_reason !== ticket.pending_reason) {
        await this.tickets.pend(ticket.id, body.pending_reason, actor);
      }
      await this.tickets.update(ticket.id, body, actor);
    } catch (err) {
      return this.fail(res, err);
    }
    const updated = await loadTicketFull(this.dataSource, ticket.id, { commentLimit: DETAIL_COMMENT_PAGE });
    return res.json(updated);
  }

  @Patch('tickets/:id/move')
  async move(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    if (body?.status === undefined || body?.status === null || body?.status === '') {
      return res.status(400).json({ error: `status is required (${TICKET_STATUSES.join(', ')})` });
    }
    try {
      await this.tickets.move(id, body.status, this.actorOf(req), { position: body.position });
    } catch (err) {
      return this.fail(res, err);
    }
    const updated = await loadTicketFull(this.dataSource, id, { commentLimit: DETAIL_COMMENT_PAGE });
    return res.json(updated);
  }

  /** Re-parent a ticket under another ticket (subtask), or promote a subtask to a root ticket. */
  @Patch('tickets/:id/parent')
  async reparent(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first' });
    const newParentId: string | null = body?.parent_id ? String(body.parent_id) : null;
    if (newParentId === ticket.parent_id) return res.json(await loadTicketFull(this.dataSource, id));
    let depth = 0;
    if (newParentId) {
      if (newParentId === ticket.id) return res.status(400).json({ error: 'A ticket cannot be its own parent' });
      const parent = await this.ticketRepo.findOne({ where: { id: newParentId } });
      if (!parent) return res.status(400).json({ error: 'Parent ticket not found' });
      if (parent.workspace_id !== ticket.workspace_id) return res.status(400).json({ error: 'Parent must be in the same workspace' });
      depth = parent.depth + 1;
      const hasGrandchildren = await this.ticketRepo
        .createQueryBuilder('t')
        .innerJoin(Ticket, 'c', 'c.parent_id = t.id')
        .where('t.parent_id = :id', { id: ticket.id })
        .getCount();
      const subtreeDepth = hasGrandchildren ? 2 : (await this.ticketRepo.count({ where: { parent_id: ticket.id } })) ? 1 : 0;
      if (depth + subtreeDepth > 2) return res.status(400).json({ error: 'Maximum depth of 2 exceeded' });
      // Ancestor cycle guard.
      let cursor: Ticket | null = parent;
      for (let i = 0; cursor && i < 4; i++) {
        if (cursor.id === ticket.id) return res.status(400).json({ error: 'Cannot move a ticket under its own descendant' });
        cursor = cursor.parent_id ? await this.ticketRepo.findOne({ where: { id: cursor.parent_id } }) : null;
      }
    }
    const oldParentId = ticket.parent_id;
    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      if (oldParentId) await shiftTicketPositions(tRepo, { parent_id: oldParentId }, ticket.position, -1);
      const position = newParentId ? await maxChildPosition(manager, newParentId) : 0;
      await tRepo.update(ticket.id, {
        parent_id: newParentId,
        depth,
        position,
        // A subtask is a checklist item (todo/done); a promoted root starts queued.
        status: newParentId ? (ticket.status === 'done' ? 'done' : 'todo') : (ticket.status === 'done' ? 'done' : 'todo'),
      });
      // Children of the moved ticket keep their relative depth.
      await tRepo.createQueryBuilder().update().set({ depth: depth + 1 }).where('parent_id = :id', { id: ticket.id }).execute();
    });
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'updated', ticket_id: ticket.id, workspace_id: ticket.workspace_id,
      field_changed: 'parent_id', old_value: oldParentId || '', new_value: newParentId || '',
      actor_id: req.currentUser?.id, actor_name: req.currentUser?.name || '',
    });
    return res.json(await loadTicketFull(this.dataSource, id));
  }

  /** Manual Run: start a todo ticket now (capacity-bound) or re-send an in_progress one. */
  @Post('tickets/:id/trigger')
  async trigger(@Param('id') id: string, @Res() res: Response) {
    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (await this.instanceQuiesce.isQuiesced()) {
      return res.status(409).json({ ok: false, dispatched: false, reason: 'instance_quiesced' });
    }
    const result = await this.dispatcher.manualTrigger(id);
    return res.json({ ok: true, ...result });
  }

  // ─── archive / delete ───────────────────────────────────

  @Post('tickets/:id/archive')
  async archiveTicket(@Param('id') id: string, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    if (ticket.archived_at) return res.json({ ...ticket, already_archived: true });
    if (ticket.parent_id || ticket.depth > 0) {
      return res.status(400).json({ error: 'Only root tickets can be archived' });
    }
    ticket.archived_at = new Date();
    // dedupe key 정리는 MCP archive_ticket과 동일 정책(티켓 a565b657).
    ticket.operational_dedupe_key = null;
    await this.ticketRepo.save(ticket);
    const currentUser = req.currentUser;
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'archived',
      ticket_id: ticket.id, workspace_id: ticket.workspace_id,
      actor_id: currentUser?.id,
      actor_name: currentUser?.name || currentUser?.email || 'manual',
      field_changed: 'archived_at',
      new_value: new Date(ticket.archived_at).toISOString(),
    });
    const updated = await loadTicketFull(this.dataSource, ticket.id);
    return res.json({ ...updated, manual: true, on_terminal: ticket.status === 'done' });
  }

  @Post('tickets/:id/unarchive')
  async unarchiveTicket(@Param('id') id: string, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    if (!ticket.archived_at) return res.json({ ...ticket, already_active: true });
    const wasArchivedAt = ticket.archived_at;
    ticket.archived_at = null;
    // Reset the archiver clock so the unarchived ticket gets the full grace
    // window again instead of being re-archived on the next tick.
    ticket.terminal_entered_at = ticket.status === 'done' ? new Date() : null;
    await this.ticketRepo.save(ticket);
    const currentUser = req.currentUser;
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'unarchived',
      ticket_id: ticket.id, workspace_id: ticket.workspace_id,
      actor_id: currentUser?.id,
      actor_name: currentUser?.name || currentUser?.email || 'manual',
      field_changed: 'archived_at',
      old_value: new Date(wasArchivedAt).toISOString(),
      new_value: '',
    });
    const updated = await loadTicketFull(this.dataSource, ticket.id);
    return res.json(updated);
  }

  @Delete('tickets/:id')
  async delete(@Param('id') id: string, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, {
      where: { id },
      relations: ['children', 'comments'],
    }, 'Ticket not found');
    const linkedDuplicates = await this.ticketRepo.count({ where: { canonical_ticket_id: ticket.id } });
    if (linkedDuplicates > 0) {
      return res.status(409).json({ error: 'canonical_has_duplicates', linked_duplicates: linkedDuplicates });
    }
    const position = ticket.position;
    const parentId = ticket.parent_id;
    const workspaceId = ticket.workspace_id;
    // Prereq cascade (ticket 48d14fff): drop links pointing AT this ticket and
    // re-evaluate dependents BEFORE remove() — the FK ON DELETE CASCADE would
    // otherwise wipe the link rows first, leaving nothing to read.
    let unblockedDependents: string[] = [];
    try {
      unblockedDependents = await this.ticketPrerequisites.onPrerequisiteRemoved(ticket.id);
    } catch (e) {
      this.logService.warn('Ticket', 'delete prereq cascade failed (continuing)', { err: String(e), ticket_id: ticket.id });
    }
    // Strip comment_attachment Resources before the ticket cascade removes
    // the comment rows they were tied to — Resource has no FK back to Ticket.
    await deleteCommentAttachmentsForTicket(this.dataSource, ticket.id);
    await this.ticketRepo.remove(ticket);
    if (parentId) await shiftTicketPositions(this.ticketRepo, { parent_id: parentId }, position, -1);
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: id, action: 'deleted', ticket_id: id, workspace_id: workspaceId,
    });
    for (const depId of unblockedDependents) {
      try {
        await this.dispatcher.resumeTicket(depId, 'prerequisite_resolved');
      } catch (e) {
        this.logService.warn('Ticket', 'delete unblock dispatch failed (continuing)', { err: String(e), ticket_id: depId });
      }
    }
    return res.json({ success: true });
  }

  // ─── Ticket prerequisites (ticket 48d14fff) ─────────────
  // The "blocked-by another ticket" M:N surface. The link set itself is also
  // folded into GET /tickets/:id via loadTicketFull.

  @Get('tickets/:id/prerequisites')
  async listPrerequisites(@Param('id') id: string, @Res() res: Response) {
    await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    const rows = await this.ticketPrerequisites.listFull(id);
    return res.json({ ticket_id: id, prerequisites: rows });
  }

  @Post('tickets/:id/prerequisites')
  async addPrerequisites(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const ids: string[] = Array.isArray(body?.prerequisite_ticket_ids)
      ? body.prerequisite_ticket_ids
      : (body?.prerequisite_ticket_id ? [body.prerequisite_ticket_id] : []);
    const actor = req.currentUser;
    try {
      await this.ticketPrerequisites.addPrerequisites(id, ids, {
        reason: body?.reason,
        actorId: actor?.id,
        actorName: actor?.name,
      });
    } catch (e: any) {
      return res.status(e?.status === 400 ? 400 : 500).json({ error: e?.message || 'Failed to add prerequisites' });
    }
    const updated = await loadTicketFull(this.dataSource, id);
    return res.json(updated);
  }

  @Delete('tickets/:id/prerequisites/:prereqId')
  async removePrerequisite(@Param('id') id: string, @Param('prereqId') prereqId: string, @Req() req: any, @Res() res: Response) {
    const actor = req.currentUser;
    const before = await this.ticketRepo.findOne({ where: { id } });
    if (!before) return res.status(404).json({ error: 'Ticket not found' });
    const wasPending = !!before.pending_on_tickets;
    let result: { removed: boolean; pending_on_tickets: boolean };
    try {
      result = await this.ticketPrerequisites.removePrerequisite(id, prereqId, {
        actorId: actor?.id,
        actorName: actor?.name,
      });
    } catch (e: any) {
      return res.status(e?.status === 400 ? 400 : 500).json({ error: e?.message || 'Failed to remove prerequisite' });
    }
    // Wake the assignee only on a real true → false flip.
    if (result.removed && wasPending && !result.pending_on_tickets) {
      try {
        await this.dispatcher.resumeTicket(id, 'prerequisite_resolved');
      } catch (e) {
        this.logService.warn('Ticket', 'remove prerequisite unblock dispatch failed (continuing)', { err: String(e), ticket_id: id });
      }
    }
    const updated = await loadTicketFull(this.dataSource, id);
    return res.json(updated);
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
    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });

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
          owner_type: 'ticket',
          owner_id: id,
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
    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });
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

  // (archive gate applied below after finding the ticket)
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
    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });
    const normalizedContent = await this.artifactRefs.normalizeStoredOutput(ticket.workspace_id, content);

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
        if (r.workspace_id !== null && r.workspace_id !== ticket.workspace_id) {
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


    const comment = await this.dataSource.transaction(async (manager) => {
      const createdIds: string[] = [];
      for (const f of inlineFiles) {
        const mimetype = inferResourceMimetypeLocal(f.file_data, f.file_name, f.file_mimetype);
        const r = await manager.getRepository(Resource).save(
          manager.getRepository(Resource).create({
            workspace_id: ticket.workspace_id,
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
        content: normalizedContent,
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
      new_value: normalizedContent,
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
    // NOTE: this marker deliberately does NOT clear @-mentions on the ticket.
    // Opening a thread is not proof the user saw a specific mention buried in
    // it. Mentions clear when their own comment actually enters the viewport
    // — see useMentionViewportReader on the client, which reads the pending
    // set from GET /mentions/unread-by-source and POSTs /mentions/read-batch.
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

    const ticketForArchive = await this.ticketRepo.findOne({ where: { id: ticketId } });
    if (ticketForArchive?.archived_at) {
      return res.status(409).json({
        error: 'ticket_archived',
        hint: 'Call unarchive first',
        message: new TicketArchivedError(ticketForArchive.id).message,
      });
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

    // T3 self-exclusion: the comment author (a user on this REST path — the
    // emitted events below hardcode actor_type 'user') is dropped so a
    // `@[role:…]` fan-out never notifies them of their own comment.
    const resolved = await this.mentionService.resolveMentions(refs, ticket, {
      excludeActor: { type: 'user', id: actor.id },
    });
    if (resolved.length === 0) return;

    const preview = (comment.content || '').slice(0, 500);
    const ts = (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString();

    // Ticket-comment analog of room-messaging.service.ts's chat chain-depth
    // stamp (ticket 07402c57) — computed once per comment and reused across
    // every fan-out target below, since it reflects this ticket's comment
    // history, not the recipient.
    const agentChainDepth = await computeTicketCommentChainDepth(this.commentRepo, ticket.id);
    // Instance-wide quiesce gate (ticket 0f638509 — live pull import),
    // checked once outside the loop — a quiesced destination must not
    // spawn/wake an agent via an @-mention either.
    const quiescedForMentions = await this.instanceQuiesce.isQuiesced();

    for (const m of resolved) {
      if (m.type === 'agent') {
        if (quiescedForMentions) continue;
        // P4c-4: REST comment 멘션도 spec-direct 해소.
        const target = await resolveMentionTarget(this.dataSource, ticket, m.id);
        if (!target) continue;

        const { extras } = target;
        activityEvents.emit('comment_mention', {
          ticket_id: ticket.id,
          comment_id: comment.id,
          workspace_id: ticket.workspace_id,
          agent_id: target.agentId,
          actor_id: actor.id,
          actor_type: 'user',
          actor_name: actor.name,
          content: comment.content,
          dispatch_trigger_id: '',
          dispatch_role: '',
          role_prompt: target.rolePrompt,
          mention_source: 'direct',
          role_shortcut: '',
          timestamp: ts,
          agent_chain_depth: agentChainDepth,
          harness_config: extras.harness_config,
          cli_runtime_profile: extras.cli_runtime_profile,
          effort_preset: extras.effort_preset,
          environment_config: extras.environment_config,
          worktree_mode: extras.worktree_mode,
          ...(target.runtime ? { runtime: target.runtime } : {}),
        });
        this.logService.info('Mentions', `Agent @-mention routed: ${target.displayName} (${target.agentId}) on ticket ${ticket.id}`);
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
