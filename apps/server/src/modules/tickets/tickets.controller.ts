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
import { TicketPrerequisitesService } from './ticket-prerequisites.service';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import { getConsensusView, openMoveProposal, recordConsensusVote } from '../../services/consensus-actions';
import { evaluateConsensusMoveGate } from '../../services/consensus.service';
import {
  MAX_COMMENT_ATTACHMENT_SIZE,
  MAX_COMMENT_ATTACHMENTS,
  MAX_TICKET_ATTACHMENT_SIZE,
  MAX_TICKET_ATTACHMENTS,
} from '../../common/constants/upload';
import { Resource } from '../../entities/Resource';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { loadTicketFull, parseComments, expandCommentAttachments, loadTicketComments, DETAIL_COMMENT_PAGE } from '../mcp/shared/ticket-parsing';
import { applyTerminalEnteredAtForMove, getRootArchivedAt, isTerminalColumn, TicketArchivedError } from '../mcp/shared/archive-helpers';
import { isReviewToMerging, hasReviewerApproval, ReviewApprovalRequiredError } from '../mcp/shared/review-approval-guard';
import { evaluateMergeGate, MergeGateBlockedError } from '../mcp/shared/merge-gate';
import {
  maxTicketPosition,
  maxChildPosition,
  refreshTicketWorkspaceId,
  resolveAgentIdAndName,
  formatAgentDisplayName,
  shiftTicketPositions,
  deleteCommentAttachmentsForTicket,
  inferTicketAttachmentMimetype,
  projectTicketAttachment,
  approxBase64Size,
  validateNextTicketId,
} from '../mcp/shared/ticket-helpers';
import { findOrFail } from '../../common/find-or-fail';
import { parseDefaultRoleAssignments, type DefaultRoleAssignments } from '../../common/default-role-assignments-config';
import { validateHandoffSpecInput } from '../../common/handoff-spec-config';

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
    private readonly ticketPrerequisites: TicketPrerequisitesService,
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
    const { title, description = '', priority = 'medium', assignee = '', reporter = '', assignee_id = '', reporter_id = '', labels = [], channel_ids = [], role_assignments, next_ticket_id, effort_preset, skip_default_assignments = false } = body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    await findOrFail(this.colRepo, { where: { id: columnId } }, 'Column not found');

    // Resolve the destination column's workspace upfront so the next_ticket_id
    // workspace-guard runs against the correct value (the freshly-created
    // ticket row's workspace_id is set by refreshTicketWorkspaceId AFTER save).
    let prospectiveWorkspaceId = '';
    try {
      const col = await this.colRepo.findOne({ where: { id: columnId } });
      if (col) {
        const board = await this.dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
        prospectiveWorkspaceId = board?.workspace_id || '';
      }
    } catch { /* non-fatal — validateNextTicketId will skip the workspace guard */ }

    let resolvedNextTicketId: string | null = null;
    if (next_ticket_id !== undefined) {
      try {
        // currentTicketId=null on create — the row doesn't have an id yet, so
        // the self-link guard inside the helper is a no-op here. Still safe
        // to call because UUIDs are unforgeable; a fresh ticket can't pre-
        // collide with itself.
        resolvedNextTicketId = await validateNextTicketId(this.dataSource, next_ticket_id, null, prospectiveWorkspaceId);
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'next_ticket_id rejected' });
      }
    }

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

    // Board default role holders (ticket d94a1b87). Parse the destination
    // board's config up front (a) so a board-configured default reporter wins
    // over the generic creator→reporter auto-fill, and (b) to backfill vacant
    // roles after the explicit assignments below. skip_default_assignments opts
    // the whole create out (genuine zero-holder — QA orphan probes) and also
    // suppresses the creator→reporter auto-fill so no holder sneaks in.
    let boardDefaults: DefaultRoleAssignments = {};
    if (!skip_default_assignments) {
      try {
        const col = await this.colRepo.findOne({ where: { id: columnId } });
        if (col) {
          const defBoard = await this.dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
          boardDefaults = parseDefaultRoleAssignments(defBoard?.default_role_assignments);
        }
      } catch { /* non-fatal — degrade to "no defaults" */ }
    }
    const hasDefaultReporter = Array.isArray(boardDefaults['reporter']) && boardDefaults['reporter'].length > 0;

    // Default Reporter to the ticket's creator when none was supplied — keeps
    // the original requester reachable without forcing the create form to ask.
    // Suppressed on opt-out (zero-holder) or when the board sets a default
    // reporter (that configured holder wins — applyBoardDefaults fills it).
    if (!resolvedReporter && !resolvedReporterId && creator.created_by_id && !skip_default_assignments && !hasDefaultReporter) {
      resolvedReporter = creator.created_by;
      resolvedReporterId = creator.created_by_id;
    }

    const position = await maxTicketPosition(this.dataSource, columnId);
    // Stamp terminal_entered_at on create when the destination column is
    // already terminal (e.g. operator drops a ticket straight into Done).
    // The archiver requires terminal_entered_at IS NOT NULL, so without this
    // stamp those tickets would silently never auto-archive.
    const destColumnForStamp = await this.colRepo.findOne({ where: { id: columnId } });
    const terminalEnteredAt = isTerminalColumn(destColumnForStamp) ? new Date() : null;
    const ticket = await this.ticketRepo.save(this.ticketRepo.create({
      column_id: columnId, title, description, priority,
      assignee: resolvedAssignee, reporter: resolvedReporter,
      assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId,
      labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids),
      position, parent_id: null, depth: 0, status: 'todo',
      next_ticket_id: resolvedNextTicketId,
      // Abstract effort preset id (trim → empty becomes null). Resolved
      // against the board catalog at dispatch; null = board default.
      effort_preset: typeof effort_preset === 'string' && effort_preset.trim() ? effort_preset.trim() : null,
      terminal_entered_at: terminalEnteredAt,
      created_by: creator.created_by, created_by_type: creator.created_by_type, created_by_id: creator.created_by_id,
    }));

    // Mirror onto TicketRoleAssignment so trigger loop / allocation /
    // mention resolution see the new ticket via the v0.34 path.
    await refreshTicketWorkspaceId(this.dataSource, ticket);
    if (ticket.workspace_id) {
      await this.ticketRoleAssignments.syncBuiltinTrio(ticket.id, ticket.workspace_id, {
        assignee_id: resolvedAssigneeId,
        reporter_id: resolvedReporterId,
      });
    }

    // REST/MCP parity: accept role_assignments[] (planner / custom roles).
    // Same explicit-slug-wins policy as MCP — applied AFTER syncBuiltinTrio.
    if (Array.isArray(role_assignments) && role_assignments.length > 0) {
      try {
        await this._applyRoleAssignments(ticket.id, ticket.workspace_id, role_assignments);
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'role_assignments rejected' });
      }
    }

    // Board defaults (d94a1b87): fill roles still VACANT after the explicit
    // trio + role_assignments. Priority is explicit holder > board default >
    // unassigned — applyBoardDefaults only writes a currently-vacant role.
    // Empty config / opt-out → boardDefaults is {} → no-op.
    if (ticket.workspace_id && Object.keys(boardDefaults).length > 0) {
      await this.ticketRoleAssignments.applyBoardDefaults(ticket.id, ticket.workspace_id, boardDefaults);
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
   * Apply REST `role_assignments[]` payload onto a ticket. Mirrors the MCP
   * `applyRoleAssignments` helper so `planner` and any workspace custom
   * role can be set from either surface. Throws on unknown slug; empty slug
   * is silently skipped.
   *
   * MULTI-HOLDER (다중담당자 T1): repeated same-slug entries are grouped and
   * applied as one holder set via `setHolders()` — matching the MCP path —
   * so a role can carry several holders. An all-empty group clears the slot.
   */
  private async _applyRoleAssignments(
    ticketId: string,
    workspaceId: string,
    assignments: Array<{ role_slug?: string; agent_id?: string; user_id?: string }>,
  ): Promise<void> {
    if (!workspaceId) {
      throw new Error('Cannot apply role_assignments — ticket has no workspace_id');
    }
    const roleRepo = this.dataSource.getRepository(WorkspaceRole);

    // Group by slug (first-seen order) so repeated same-slug entries become a
    // multi-holder set instead of clobbering each other.
    const bySlug = new Map<string, Array<{ agent_id: string | null; user_id: string | null }>>();
    for (const a of assignments) {
      const slug = (a?.role_slug || '').trim();
      if (!slug) continue;
      const holder = { agent_id: a?.agent_id || null, user_id: a?.user_id || null };
      const list = bySlug.get(slug);
      if (list) list.push(holder);
      else bySlug.set(slug, [holder]);
    }

    for (const [slug, holders] of bySlug) {
      const role = await roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
      if (!role) throw new Error(`Unknown role slug "${slug}" in workspace ${workspaceId}`);
      // setHolders drops all-empty entries → an all-empty group clears the slot.
      await this.ticketRoleAssignments.setHolders(ticketId, role.id, holders);
    }
  }

  @Post('tickets/:parentId/children')
  async createChild(@Param('parentId') parentId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const parent = await findOrFail(this.ticketRepo, { where: { id: parentId } }, 'Parent ticket not found');

    // Archive gate — walk up to the root and check its archived_at. Subtasks
    // don't carry the flag themselves (archive is board-level, subtasks have
    // no column); the root row owns it.
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

    // Involved ticket IDs in this workspace: role holder OR has read-state
    // row. Archived tickets are excluded so the unread badge doesn't keep
    // pinging the user for old Done-and-archived work.
    const roleTickets = await this.ticketRepo
      .createQueryBuilder('t')
      .select('t.id', 'id')
      .where('t.workspace_id = :wsId', { wsId })
      .andWhere(
        '(t.assignee_id = :uid OR t.reporter_id = :uid OR t.reviewer_id = :uid)',
        { uid: currentUser.id },
      )
      .andWhere('t.archived_at IS NULL')
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
      // Load only the unread tickets and their ancestor chain — not every
      // ticket in the workspace (which on an archive-heavy workspace pulls the
      // entire ticket graph into memory just to resolve a handful of parent
      // columns). Subtasks carry no column_id, so we walk parent_id up to the
      // root; depth is capped at 2 (root→child→grandchild) and the bounded
      // loop stops as soon as no new parents appear. Perf ticket b3812637.
      const byId = new Map<string, { column_id: string | null; parent_id: string | null }>();
      let frontier: string[] = ticketIdsWithUnread.slice();
      for (let hop = 0; frontier.length > 0 && hop < 6; hop++) {
        const missing = frontier.filter((id) => !byId.has(id));
        if (missing.length === 0) break;
        const rows = await this.ticketRepo
          .createQueryBuilder('t')
          .select(['t.id AS id', 't.column_id AS column_id', 't.parent_id AS parent_id'])
          .where('t.id IN (:...ids)', { ids: missing })
          .getRawMany();
        for (const t of rows) byId.set(t.id, { column_id: t.column_id, parent_id: t.parent_id });
        frontier = rows
          .map((t) => t.parent_id)
          .filter((pid): pid is string => !!pid && !byId.has(pid));
      }
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
    // bounded 코멘트 로드: detail 패널은 처음엔 최신 페이지만 필요하고 더 오래된
    // 코멘트는 GET /tickets/:id/comments 로 scroll-load 한다. 여기가 OOM 경로 —
    // 코멘트 수천 개 티켓은 패널을 열 때마다(+보드 갱신 refetch) 트리 전체 코멘트를
    // 직렬화하고 있었다.
    const ticket = await loadTicketFull(this.dataSource, id, { commentLimit: DETAIL_COMMENT_PAGE });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    return res.json(ticket);
  }

  // 단일 티켓(root/하위)의 커서 페이지네이션 코멘트. chat 메시지 엔드포인트
  // (GET /chat-rooms/:roomId/messages)와 동일한 모양: `limit`(기본 50, 최대 200)
  // + `before`(코멘트 id)로 복합 (created_at, id) 커서를 따라가 같은 timestamp
  // 버스트도 안 건너뛴다. 최신순으로 반환해 클라가 현재 화면 아래에 페이지를
  // append 한다(코멘트는 newest-at-top). 패널은 사용자가 하단으로 스크롤할 때
  // 이걸로 더 오래된 코멘트를 로드한다.
  @Get('tickets/:id/comments')
  async getComments(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const ticket = await this.ticketRepo.findOne({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const limit = parseInt(req.query.limit as string, 10) || DETAIL_COMMENT_PAGE;
    const before = (req.query.before as string) || undefined;
    const comments = await loadTicketComments(this.dataSource, id, { limit, before });
    return res.json(comments);
  }

  @Patch('tickets/:id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');

    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });

    const currentUser = req.currentUser;
    const actorId = currentUser?.id || undefined;
    const actorName = currentUser?.name || currentUser?.email || undefined;

    const { title, description, priority, assignee, reporter, reviewer_id, assignee_id, reporter_id, labels, channel_ids, status, prompt_text, base_repo_resource_id, base_branch, role_assignments, next_ticket_id, on_done_action_ids, handoff_spec, pending_user_action, pending_reason, effort_preset } = body;
    const oldAssignee = ticket.assignee;
    const oldReporter = ticket.reporter;
    const oldReviewerId = ticket.reviewer_id;
    const oldStatus = ticket.status;
    const oldBaseRepoId = ticket.base_repo_resource_id;
    const oldBaseBranch = ticket.base_branch;
    const oldNextTicketId = ticket.next_ticket_id;
    const oldPending = !!ticket.pending_user_action;

    if (title !== undefined) ticket.title = title;
    if (description !== undefined) ticket.description = description;
    if (priority !== undefined) ticket.priority = priority;
    if (status !== undefined) ticket.status = status;
    // Same name↔id backfill rule as the create path: when the caller flips
    // only one side of the pair, look the other up in the Agent table so
    // TicketCard / activity log don't see a half-stale row. Empty strings
    // are passed for the omitted side so the helper actually does a DB
    // lookup — pre-filling from the existing row makes both helper args
    // truthy and trips the `if (id && name)` short-circuit, which silently
    // re-saves the previous holder's name on an id-only update.
    if (assignee !== undefined || assignee_id !== undefined) {
      const resolved = await resolveAgentIdAndName(
        this.dataSource,
        assignee_id !== undefined ? assignee_id : '',
        assignee !== undefined ? assignee : '',
      );
      ticket.assignee_id = assignee_id !== undefined ? assignee_id : (resolved.id || ticket.assignee_id);
      // When the resolver matched a real Agent, write its canonical
      // `<Manager>/<Agent>` display — beats any bare leaf name the caller
      // hand-typed. Otherwise fall through to the caller's literal (which
      // also lets `assignee: ''` clear the column).
      if (resolved.id) {
        ticket.assignee = resolved.name;
      } else if (assignee !== undefined) {
        ticket.assignee = assignee;
      }
    }
    if (reporter !== undefined || reporter_id !== undefined) {
      const resolved = await resolveAgentIdAndName(
        this.dataSource,
        reporter_id !== undefined ? reporter_id : '',
        reporter !== undefined ? reporter : '',
      );
      ticket.reporter_id = reporter_id !== undefined ? reporter_id : (resolved.id || ticket.reporter_id);
      if (resolved.id) {
        ticket.reporter = resolved.name;
      } else if (reporter !== undefined) {
        ticket.reporter = reporter;
      }
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
    if (next_ticket_id !== undefined) {
      try {
        ticket.next_ticket_id = await validateNextTicketId(
          this.dataSource,
          next_ticket_id,
          ticket.id,
          ticket.workspace_id || '',
        );
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'next_ticket_id rejected' });
      }
    }
    // On-ticket-done hook binding (method "a", ticket 16a6339c). Stored as a
    // JSON string like labels / channel_ids; dedupe + drop blanks so the array
    // stays clean. An empty array clears the per-ticket binding. Mirrors the
    // MCP update_ticket path (ticket-crud-tools.ts).
    const oldOnDoneActionIds = ticket.on_done_action_ids;
    if (on_done_action_ids !== undefined) {
      const arr = Array.isArray(on_done_action_ids) ? on_done_action_ids : [];
      const cleaned = Array.from(new Set(arr.filter((s: any) => typeof s === 'string' && s)));
      ticket.on_done_action_ids = JSON.stringify(cleaned);
    }

    // Cross-board handoff relay spec (ticket ac21a745). Validate → canonical JSON
    // string ('' clears). A bad shape throws a 400 (loud typo). Mirrors the MCP
    // update_ticket path (ticket-crud-tools.ts).
    const oldHandoffSpec = ticket.handoff_spec;
    if (handoff_spec !== undefined) {
      try {
        ticket.handoff_spec = validateHandoffSpecInput(handoff_spec);
      } catch (e: any) {
        return res.status(e?.status || 400).json({ error: e?.message || 'handoff_spec rejected' });
      }
    }

    // Abstract effort preset id — stored as-is (trim; empty → null). Resolved
    // against the board catalog at dispatch; null = board default. Mirrors the
    // MCP update_ticket path (ticket-crud-tools.ts).
    const oldEffortPreset = ticket.effort_preset;
    if (effort_preset !== undefined) {
      ticket.effort_preset = typeof effort_preset === 'string' && effort_preset.trim() ? effort_preset.trim() : null;
    }

    // Pending-user-action toggle (ticket a57517be). Mirrors the MCP
    // update_ticket path: flipping true stamps set_at + set_by, flipping
    // false clears all three; updating the reason on an already-pending
    // ticket is a separate small change.
    let pendingChanged = false;
    let pendingReasonChanged = false;
    if (pending_user_action !== undefined) {
      const next = !!pending_user_action;
      if (next !== oldPending) {
        ticket.pending_user_action = next;
        if (next) {
          ticket.pending_set_at = new Date();
          ticket.pending_set_by = actorName || '';
          if (pending_reason !== undefined) ticket.pending_reason = pending_reason || '';
        } else {
          ticket.pending_set_at = null;
          ticket.pending_set_by = '';
          ticket.pending_reason = '';
        }
        pendingChanged = true;
      } else if (next && pending_reason !== undefined && pending_reason !== ticket.pending_reason) {
        ticket.pending_reason = pending_reason || '';
        pendingReasonChanged = true;
      }
    } else if (pending_reason !== undefined && oldPending && pending_reason !== ticket.pending_reason) {
      ticket.pending_reason = pending_reason || '';
      pendingReasonChanged = true;
    }

    await this.ticketRepo.save(ticket);

    // B1 carry-over: backfill workspace_id for legacy tickets created via
    // the pre-fix MCP path (Ticket row stored with default ''). REST PATCH
    // is the most likely surface to hit such a row first; without this any
    // assignment-table sync below would silently skip.
    await refreshTicketWorkspaceId(this.dataSource, ticket);

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

    // REST/MCP parity: accept role_assignments[] (planner / custom roles).
    if (Array.isArray(role_assignments) && role_assignments.length > 0) {
      try {
        await this._applyRoleAssignments(ticket.id, ticket.workspace_id, role_assignments);
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'role_assignments rejected' });
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
    if (next_ticket_id !== undefined && (ticket.next_ticket_id || '') !== (oldNextTicketId || '')) changes.push('next_ticket');
    if (on_done_action_ids !== undefined && ticket.on_done_action_ids !== oldOnDoneActionIds) changes.push('on_done_action_ids');
    if (handoff_spec !== undefined && (ticket.handoff_spec || '') !== (oldHandoffSpec || '')) changes.push('handoff_spec');
    if (effort_preset !== undefined && (ticket.effort_preset || '') !== (oldEffortPreset || '')) changes.push('effort_preset');
    if (pendingReasonChanged) changes.push('pending_reason');
    const otherChanges = changes.filter(c => !['assignee', 'reporter', 'status'].includes(c));
    if (otherChanges.length > 0) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: otherChanges.join(', '),
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: actorId, actor_name: actorName,
      });
    }
    // Pending-user-action gets its own activity row so the audit trail
    // shows the explicit flip rather than being bundled into a generic
    // "updated". Field name matches the MCP path so a single grep
    // surfaces every park/unpark event.
    if (pendingChanged) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'pending_user_action',
        old_value: oldPending ? 'true' : 'false',
        new_value: ticket.pending_user_action ? 'true' : 'false',
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: actorId, actor_name: actorName,
      });
    }

    // Ticket a57517be finding 2: an unpend (true → false) must explicitly
    // wake the ticket's current column's role-holders. The
    // `field_changed='pending_user_action'` activity row above does NOT
    // route through column-based dispatch on its own, and before this
    // flip the focus-selector + trigger-loop gates would have dropped
    // any incidental wake-up anyway. Mirrors the MCP `unpend_ticket`
    // tool. Focus selector inside `_emitTrigger` still applies — if the
    // assignee is already focused on another ticket, this stays silent
    // and the focus model decides when this ticket comes back in.
    if (pendingChanged && oldPending && !ticket.pending_user_action) {
      try {
        await this.triggerLoop.dispatchCurrentColumn(ticket.id, 'unpend', actorId || '');
      } catch (e) {
        this.logService.warn('Tickets', 'unpend dispatch failed (continuing)', {
          err: String(e), ticket_id: ticket.id,
        });
      }
    }

    const updated = await loadTicketFull(this.dataSource, ticket.id);
    return res.json(updated);
  }

  @Patch('tickets/:id/move')
  async move(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const { targetColumnId, targetPosition, force } = body;
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');

    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });
    if (ticket.depth > 0) return res.status(400).json({ error: 'Only root tickets can be moved on the board' });

    // Review→Merging approval gate (ticket a3d25202 — proposal 2 of 86bfb8af).
    // Unlike the terminal-reopen guard (which deliberately exempts this human
    // drag path), proposal 2 *targets* the manual path: a person dragging a card
    // Review→Merging must not cross the review gate unless a reviewer-authored
    // comment exists. body.force is the explicit human override.
    if (targetColumnId) {
      const [sourceColForGuard, destColForGuard] = await Promise.all([
        ticket.column_id ? this.colRepo.findOne({ where: { id: ticket.column_id } }) : Promise.resolve(null),
        this.colRepo.findOne({ where: { id: targetColumnId } }),
      ]);
      if (!force && isReviewToMerging(sourceColForGuard, destColForGuard) && !(await hasReviewerApproval(this.dataSource, ticket.id))) {
        const e = new ReviewApprovalRequiredError(ticket.id, sourceColForGuard?.name ?? String(ticket.column_id), destColForGuard?.name ?? String(targetColumnId));
        return res.status(e.status).json({ error: e.code, hint: e.hint, message: e.message });
      }

      // 머지 게이트(티켓 c806bad3): Review→Merging(stale-base) / Merging→Done(부분머지)
      // 기계 검증. board 가 merge_gate_config 로 opt-in 한 경우에만 동작하며 해석 실패는
      // 전부 통과(availability-first) — 미설정 보드 무회귀. force 는 의도적 우회.
      if (!force) {
        const mg = await evaluateMergeGate(this.dataSource, ticket, sourceColForGuard, destColForGuard);
        if (mg.blocked) {
          const e = new MergeGateBlockedError(mg);
          return res.status(e.status).json({ error: e.code, hint: e.hint, message: e.message });
        }
      }

      // 다중담당자·합의 게이트(T5/T6): 이탈(현재) 컬럼 라우팅 역할 홀더가 ≥2 이고
      // 합의 미성립이면 직접 컬럼 이동을 차단한다 — 사람이 보드에서 드래그해도
      // 팀 합의를 우회하지 못하게(MCP move_ticket 게이트와 동일). force / reporter
      // override(satisfied) 는 통과. 같은 컬럼 재정렬(targetColumnId===현재)은 면제.
      if (!force && targetColumnId !== ticket.column_id) {
        const gate = await evaluateConsensusMoveGate(this.consensusDeps(), ticket);
        if (gate.blocked) {
          return res.status(409).json({
            error: 'consensus_required',
            message: `다중담당자 티켓 — 라우팅 역할 홀더 ${gate.state.required.length}명의 합의가 필요합니다. `
              + `합의 패널에서 '이동 제안' 후 전원 동의(또는 reporter override) 시 서버가 자동 이동합니다.`,
            consensus: {
              required: gate.state.required.length,
              agreed: gate.state.agreed.length,
              pending: gate.state.pending.length,
              objected: gate.state.objected.length,
            },
          });
        }
      }
    }

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

      // Clear the claim-verification branch-tip snapshot (ticket dcb9d661).
      // Matches the MCP `move_ticket` tool's behaviour: a column move closes
      // the prior column's claim cycle, so the snapshot tied to it is no
      // longer evidence the sweep can use. Next assignee trigger on an active
      // destination re-snapshots with a fresh baseline.
      await tRepo.update(ticket.id, {
        column_id: destColumnId,
        position: pos,
        branch_tip_sha_at_trigger: '',
        branch_tip_snapshot_at: null,
      });

      // Stamp / clear terminal_entered_at when the move crosses the terminal
      // boundary. Re-resolved here so cross-DB-driver locking semantics are
      // preserved — same transaction as the position shifts above.
      const colRepoTx = manager.getRepository(BoardColumn);
      const [sourceColForStamp, destColForStamp] = await Promise.all([
        sourceColumnId ? colRepoTx.findOne({ where: { id: sourceColumnId } }) : Promise.resolve(null),
        colRepoTx.findOne({ where: { id: destColumnId } }),
      ]);
      await applyTerminalEnteredAtForMove(tRepo, ticket.id, sourceColForStamp, destColForStamp);
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
    const reparentRootArchived = await getRootArchivedAt(this.dataSource, ticket);
    if (reparentRootArchived) {
      return res.status(409).json({
        error: 'ticket_archived',
        hint: 'Call unarchive first',
        message: new TicketArchivedError(ticket.id).message,
      });
    }

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

      // Reparent can change whether the (now-root) ticket sits on a terminal
      // column: promotion to root with a terminal target, or a child moving
      // out of a parent that was on terminal. Re-resolve and stamp.
      if (!newParentId) {
        const colRepoTx = manager.getRepository(BoardColumn);
        const [sourceColForStamp, destColForStamp] = await Promise.all([
          oldColumnId ? colRepoTx.findOne({ where: { id: oldColumnId } }) : Promise.resolve(null),
          colRepoTx.findOne({ where: { id: targetColumnId! } }),
        ]);
        await applyTerminalEnteredAtForMove(tRepo, ticket.id, sourceColForStamp, destColForStamp);
      } else {
        // Demoted to subtask — clear the stamp (subtasks have no column).
        await tRepo.update(ticket.id, { terminal_entered_at: null });
      }

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

    if (ticket.archived_at) {
      return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });
    }
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

      // Cross-board move can change terminal status — stamp / clear
      // terminal_entered_at the same way same-board moves do.
      await applyTerminalEnteredAtForMove(tRepo, ticket.id, sourceCol, targetCol!);
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
    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });
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
      // Canonical `<Manager>/<Agent>` for subagents — matches what the MCP
      // create/update path writes via `resolveAgentIdAndName`. Without this
      // the legacy `ticket.assignee` text column stores the bare leaf name
      // ("AWB") while role_assignments stores the canonical form, so
      // TicketCard renders the wrong label until someone re-saves.
      agentName = await formatAgentDisplayName(this.dataSource, a);
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

  // ─── 다중담당자·합의 REST 브릿지 (T6) ────────────────────────────────────
  // 합의 READ/제안/투표/override 는 지금까지 MCP 툴 전용(코멘트 마커 기반)이었다.
  // 브라우저(웹 UI T6)가 소비할 수 있도록 같은 서버 로직(consensus-actions)을 얇게
  // REST 로 노출한다 — 저자는 로그인 유저(req.currentUser). SSE consensus_update 는
  // 액션 함수 안에서 방출되고, 합의 성립 시 서버가 auto-execute 로 실제 이동한다.
  private consensusDeps() {
    return {
      dataSource: this.dataSource,
      activityService: this.activityService,
      ticketRoleAssignmentService: this.ticketRoleAssignments,
    };
  }

  /**
   * 현재 합의 상태 뷰 — 역할홀더별 agree/pending/object, 열린 이동 제안(target),
   * party 표시 이름, 게이트 요약(홀더≥2 & 미성립이면 blocked). 합의 패널이 소비.
   */
  @Get('tickets/:id/consensus')
  async getTicketConsensus(@Param('id') id: string, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    const view = await getConsensusView(this.consensusDeps(), ticket);
    return res.json(view);
  }

  /**
   * 이동 제안 열기(홀더≥2). Body `{ target_column_id, content? }`. 제안 comment 의
   * id 가 곧 proposal_id — 전 홀더가 동의하면 서버가 자동 이동한다. 홀더≤1 이면 400.
   */
  @Post('tickets/:id/consensus/propose')
  async proposeTicketConsensusMove(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });
    const currentUser = req.currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    const targetColumnId: string = body?.target_column_id || body?.targetColumnId || '';
    if (!targetColumnId) return res.status(400).json({ error: 'target_column_id is required' });
    try {
      const result = await openMoveProposal(this.consensusDeps(), {
        ticket,
        by: { type: 'user', id: currentUser.id },
        byName: currentUser.name || currentUser.email || 'user',
        destColumnId: targetColumnId,
        content: typeof body?.content === 'string' ? body.content : undefined,
      });
      return res.json(result);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to open move proposal' });
    }
  }

  /**
   * 합의 시그널 캐스트. Body `{ status:'agree'|'object', proposal_id?, override?, content? }`.
   * override 는 reporter 홀더에게만 유효(서버가 검증·무시). 합의 성립 시 서버가
   * 열린 제안을 auto-execute 로 이동시킨다 — 응답 `moved` 에 반영.
   */
  @Post('tickets/:id/consensus/vote')
  async recordTicketConsensusVote(@Param('id') id: string, @Body() body: any, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });
    const currentUser = req.currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    const status = body?.status;
    if (status !== 'agree' && status !== 'object') {
      return res.status(400).json({ error: "status must be 'agree' or 'object'" });
    }
    try {
      const result = await recordConsensusVote(this.consensusDeps(), {
        ticket,
        by: { type: 'user', id: currentUser.id },
        byName: currentUser.name || currentUser.email || 'user',
        status,
        proposalId: typeof body?.proposal_id === 'string' ? body.proposal_id : null,
        override: body?.override === true,
        content: typeof body?.content === 'string' ? body.content : undefined,
      });
      return res.json(result);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to record consensus vote' });
    }
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
    if (ticket.archived_at) return res.status(409).json({ error: 'ticket_archived', hint: 'Call unarchive first', message: new TicketArchivedError(ticket.id).message });
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

  // ─── Archive endpoints (ticket 9b44526b) ───────────────────────
  // Manual archive / restore. Background TicketArchiverService performs the
  // same archive write — these are the human-driven entry points and the
  // restore path (the archiver never auto-restores).

  @Post('tickets/:id/archive')
  async archiveTicket(@Param('id') id: string, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    if (ticket.archived_at) return res.json({ ...ticket, already_archived: true });
    if (ticket.parent_id || ticket.depth > 0) {
      return res.status(400).json({ error: 'Only root tickets can be archived' });
    }

    let isTerminal = false;
    if (ticket.column_id) {
      const col = await this.colRepo.findOne({ where: { id: ticket.column_id } });
      isTerminal = !!col && ((col as any).is_terminal === true || (col as any).kind === 'terminal');
      if (!isTerminal) {
        this.logService.info('Archiver', 'manual archive on non-terminal column', {
          ticket_id: ticket.id, column_id: ticket.column_id, column_name: col?.name,
        });
      }
    }

    ticket.archived_at = new Date();
    await this.ticketRepo.save(ticket);

    const currentUser = req.currentUser;
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'archived',
      ticket_id: ticket.id,
      actor_id: currentUser?.id,
      actor_name: currentUser?.name || currentUser?.email || 'manual',
      field_changed: 'archived_at',
      new_value: new Date(ticket.archived_at).toISOString(),
    });

    const updated = await loadTicketFull(this.dataSource, ticket.id);
    return res.json({ ...updated, manual: true, on_terminal: isTerminal });
  }

  @Post('tickets/:id/unarchive')
  async unarchiveTicket(@Param('id') id: string, @Req() req: any, @Res() res: Response) {
    const ticket = await findOrFail(this.ticketRepo, { where: { id } }, 'Ticket not found');
    if (!ticket.archived_at) return res.json({ ...ticket, already_active: true });

    let isTerminalNow = false;
    if (ticket.column_id) {
      const col = await this.colRepo.findOne({ where: { id: ticket.column_id } });
      isTerminalNow = !!col && ((col as any).is_terminal === true || (col as any).kind === 'terminal');
    }

    const wasArchivedAt = ticket.archived_at;
    ticket.archived_at = null;
    // Reset the archiver clock so the unarchived ticket gets the full grace
    // window again — otherwise a ticket archived after 30 days, then
    // unarchived, would be re-archived on the next tick.
    ticket.terminal_entered_at = isTerminalNow ? new Date() : null;
    await this.ticketRepo.save(ticket);

    const currentUser = req.currentUser;
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'unarchived',
      ticket_id: ticket.id,
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

    const columnId = ticket.column_id;
    const position = ticket.position;
    const parentId = ticket.parent_id;

    // Prereq cascade (ticket 48d14fff): drop links pointing AT this ticket and
    // re-evaluate dependents BEFORE remove() — the FK ON DELETE CASCADE would
    // otherwise wipe the link rows first, leaving nothing to read. Mirrors the
    // MCP delete_ticket tool.
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

    if (parentId) {
      await shiftTicketPositions(this.ticketRepo, { parent_id: parentId }, position, -1);
    } else if (columnId) {
      await shiftTicketPositions(this.ticketRepo, { column_id: columnId }, position, -1);
    }

    // Wake the now-unblocked dependents on their current column.
    for (const depId of unblockedDependents) {
      try {
        await this.triggerLoop.dispatchCurrentColumn(depId, 'prerequisite_resolved', '');
      } catch (e) {
        this.logService.warn('Ticket', 'delete unblock dispatch failed (continuing)', { err: String(e), ticket_id: depId });
      }
    }

    return res.json({ success: true });
  }

  // ─── Ticket prerequisites (ticket 48d14fff) ─────────────
  // The "blocked-by another ticket" M:N surface. The detail panel's
  // Prerequisites section drives these; the link set itself is also folded
  // into GET /tickets/:id via loadTicketFull, so the panel renders without an
  // extra call and only hits these endpoints on mutation.

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
    // Wake the ticket's current-column holders only on a real true → false flip.
    if (result.removed && wasPending && !result.pending_on_tickets) {
      try {
        await this.triggerLoop.dispatchCurrentColumn(id, 'prerequisite_resolved', actor?.id || '');
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
