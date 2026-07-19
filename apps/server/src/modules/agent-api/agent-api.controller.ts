import { ApiTags, ApiSecurity } from '@nestjs/swagger';
import { Controller, Get, Post, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, IsNull } from 'typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { ChatRoom } from '../../entities/ChatRoom';
import { Agent } from '../../entities/Agent';
import { ApiKey } from '../../entities/ApiKey';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { projectChatAttachment } from '../mcp/shared/ticket-helpers';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { RoomMembershipService } from '../chat-rooms/room-membership.service';
import {
  CHAT_MESSAGE_TYPES,
  ChatMessageType,
  RoomMessagingService,
} from '../chat-rooms/room-messaging.service';
import { LogService } from '../../services/log.service';
import { ActivityService, activityEvents } from '../../services/activity.service';
import {
  findColumnByName,
  maxTicketPosition,
  maxChildPosition,
  shiftTicketPositions,
} from '../mcp/shared/ticket-helpers';
import { loadTicketFull } from '../mcp/shared/ticket-parsing';
import {
  applyTerminalEnteredAtForMove,
  getRootArchivedAt,
  isTerminalColumn,
  isTerminalReopen,
  TerminalReopenError,
  TicketArchivedError,
} from '../mcp/shared/archive-helpers';
import { isReviewToMerging, hasReviewerApproval, ReviewApprovalRequiredError } from '../mcp/shared/review-approval-guard';
import { evaluateMergeGate, MergeGateBlockedError } from '../mcp/shared/merge-gate';
import { findOrFail } from '../../common/find-or-fail';
import { resolveAgentDisplayName } from '../../utils/agent-name';

@ApiSecurity('agent-api-key')
@ApiTags('agent-api')
@Controller('api/agent')
@UseGuards(AgentAuthGuard)
export class AgentApiController {
  constructor(
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly membership: RoomMembershipService,
    private readonly messaging: RoomMessagingService,
    private readonly logService: LogService,
    private readonly activityService: ActivityService,
  ) {}

  // ── Workspace-scoping guards (security finding: authz / cross-workspace IDOR)
  //
  // AgentAuthGuard stamps request.currentWorkspaceId from the presented DB API
  // key (env/admin keys → null; the dev-mode bypass also → null). A null scope
  // is treated as full-scope and allowed everywhere — it covers env/admin keys
  // and workspace-less manager keys that legitimately operate across the
  // instance. A non-null scope must match the target resource's workspace, or
  // the handler returns 403 instead of silently operating on another tenant's
  // tickets / boards / chat.

  private requestScope(req: Request): string | null {
    const raw = (req as any).currentWorkspaceId as string | null | undefined;
    return raw ? raw : null;
  }

  private denyScope(res: Response) {
    return res.status(403).json({
      error: 'workspace_scope_denied',
      message: 'API key is scoped to a different workspace than the target resource.',
    });
  }

  // Resolve the owning workspace for a ticket id, climbing child → root because
  // subtasks carry column_id=null and the root row owns the column/board.
  private async resolveTicketWorkspaceId(
    db: DataSource | EntityManager,
    ticketId: string,
  ): Promise<string | null> {
    const tRepo = db.getRepository(Ticket);
    let t = await tRepo.findOne({ where: { id: ticketId } });
    let guard = 0;
    while (t && !t.column_id && t.parent_id && guard++ < 20) {
      t = await tRepo.findOne({ where: { id: t.parent_id } });
    }
    if (!t || !t.column_id) return null;
    const col = await db.getRepository(BoardColumn).findOne({ where: { id: t.column_id } });
    if (!col) return null;
    const board = await db.getRepository(Board).findOne({ where: { id: col.board_id } });
    return board?.workspace_id ?? null;
  }

  private async resolveBoardWorkspaceId(
    db: DataSource | EntityManager,
    boardId: string,
  ): Promise<string | null> {
    const board = await db.getRepository(Board).findOne({ where: { id: boardId } });
    return board?.workspace_id ?? null;
  }

  private async resolveRoomWorkspaceId(roomId: string): Promise<string | null> {
    const room = await this.dataSource.getRepository(ChatRoom).findOne({ where: { id: roomId } });
    return room?.workspace_id ?? null;
  }

  // Returns true when the request's scoped key may NOT touch the given target
  // workspace. A scoped key against an unresolvable workspace (null) is also
  // rejected — fail closed rather than leak across tenants.
  private scopeRejects(req: Request, targetWorkspaceId: string | null): boolean {
    const scope = this.requestScope(req);
    if (!scope) return false;
    return targetWorkspaceId !== scope;
  }

  @Get('tickets/:id')
  async getTicket(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const ticket = await loadTicketFull(this.dataSource, id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (this.scopeRejects(req, await this.resolveTicketWorkspaceId(this.dataSource, id))) {
      return this.denyScope(res);
    }
    return res.json(ticket);
  }

  /**
   * Silent-exit fallback comment endpoint for the agent-manager.
   *
   * The MCP `add_comment` tool rejects `type='system'` so an agent can't forge
   * audit-log entries. But the agent-manager itself — running outside any
   * spawned CLI — is a trusted operator that needs to mark "subagent finished
   * without leaving a trace" with the same provenance the SystemCommentService
   * uses for column moves. This endpoint is gated by `AgentAuthGuard` (manager
   * key) and creates a `type='system'` Comment + emits the `activity` event so
   * board_update SSE cascades to Reviewer triggers normally.
   *
   * Body shape (all optional except content):
   *   - content: rendered fallback body (code-block-wrapped CLI tail).
   *   - exit_code, cycle_trigger_id, role: stored on `comment.metadata` so the
   *     UI / debugger can correlate the row with the dead subagent.
   *   - actor_name: display name to stamp on the activity log; defaults to
   *     'agent-manager'.
   */
  @Post('tickets/:id/silent-exit-comment')
  async postSilentExitComment(
    @Param('id') ticketId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ticket = await this.ticketRepo.findOne({ where: { id: ticketId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (this.scopeRejects(req, await this.resolveTicketWorkspaceId(this.dataSource, ticketId))) {
      return this.denyScope(res);
    }
    // Archived tickets are read-only — refuse so manager retries don't pile
    // up forever on a terminally-archived row.
    if (ticket.archived_at) {
      return res.status(409).json({
        error: 'ticket_archived',
        message: new TicketArchivedError(ticket.id).message,
      });
    }

    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'content is required' });

    const exitCode = body?.exit_code === null || body?.exit_code === undefined
      ? null
      : Number(body.exit_code);
    const cycleTriggerId = typeof body?.cycle_trigger_id === 'string' ? body.cycle_trigger_id : '';
    const role = typeof body?.role === 'string' ? body.role : '';
    const actorName = typeof body?.actor_name === 'string' && body.actor_name
      ? body.actor_name
      : 'agent-manager';

    const metadata = {
      reason: 'silent_exit',
      exit_code: exitCode,
      cycle_trigger_id: cycleTriggerId || null,
      author_role: role || null,
    };

    const commentRepo = this.dataSource.getRepository(Comment);

    // Dedupe rule: if the most recent comment on this ticket already has the
    // same fingerprint (type='system' + reason + exit_code + author_role),
    // bump its repeat_count + last_repeated_at in place instead of inserting
    // a duplicate row. We only collapse against the LAST comment on the
    // ticket so a user/agent reply in between starts a fresh occurrence row
    // and the timeline stays readable.
    //
    // We also emit `action='updated'` (not `'created'`) on the bumped path so
    // the Reviewer cascade in event-registry doesn't keep re-firing on the
    // same stuck-loop error — the whole point of this dedupe is that the
    // server already knows "we've been here before, nothing new to react to".
    const lastComment = await commentRepo.findOne({
      where: { ticket_id: ticketId },
      order: { created_at: 'DESC' },
    });
    const fingerprint = this.computeSystemFingerprint(metadata);
    const lastFingerprint = lastComment
      ? this.computeSystemFingerprint(this.safeParseMetadata(lastComment.metadata), lastComment.type)
      : null;

    if (lastComment && lastFingerprint && lastFingerprint === fingerprint) {
      const prevCount = lastComment.repeat_count ?? 1;
      const nextCount = prevCount + 1;
      const now = new Date();
      // Refresh content + metadata so the displayed body reflects the latest
      // tail / trigger id — older revisions stay implicit in `repeat_count`.
      // last_repeated_at is the source of truth for "most recent occurrence";
      // created_at stays pinned so the row doesn't jump in the timeline.
      await commentRepo.update(lastComment.id, {
        content,
        metadata: JSON.stringify(metadata),
        repeat_count: nextCount,
        last_repeated_at: now,
      });

      await this.activityService.logActivity({
        entity_type: 'comment',
        entity_id: lastComment.id,
        action: 'updated',
        ticket_id: ticketId,
        // actor_id: 'system' — required so the trigger-loop's system-actor
        // guard skips this activity. Without it the dedupe row landed with
        // actor_id='' which slips past `actor_id === 'system'` AND matches
        // `action === 'updated'` in trigger-loop's _handleActivity, so a
        // silent-exit on an agent that's hit a hard external limit (e.g.
        // codex usage cap) re-triggered the SAME agent → another silent-exit
        // → another dedupe `updated` → ... a tight runaway loop. On
        // 2026-05-28 a single ticket (ID 672b385d…) accumulated 131,068
        // silent_exit cycles inside ~6 hours, leaking ~170 MB/min of node
        // heap (closure + retained MCP response strings) until the server
        // crashed with "Reached heap limit".
        actor_id: 'system',
        actor_name: actorName,
        new_value: String(nextCount),
        field_changed: 'repeat_count',
      });

      this.logService.info(
        'AgentApi',
        `Silent-exit system comment deduped: ticket=${ticketId.slice(0, 8)} exit=${exitCode ?? '-'} count=${nextCount} comment=${lastComment.id.slice(0, 8)}`,
        { ticket_id: ticketId, comment_id: lastComment.id, exit_code: exitCode, cycle_trigger_id: cycleTriggerId, repeat_count: nextCount },
      );

      const refreshed = await commentRepo.findOne({ where: { id: lastComment.id } });
      return res.status(200).json(refreshed);
    }

    const comment = await commentRepo.save(commentRepo.create({
      ticket_id: ticketId,
      author_type: 'system',
      author_id: '',
      author: 'System',
      content,
      type: 'system',
      metadata: JSON.stringify(metadata),
    }));

    // Same activity-event contract the MCP add_comment / REST add-comment
    // paths use — entity_type='comment' + action='created' flows through
    // event-registry's board_update mapping and reaches SSE subscribers, which
    // is how the Reviewer-trigger cascade gets notified. Without this emit the
    // comment lands silently in the DB and the board never re-renders until a
    // user reloads.
    await this.activityService.logActivity({
      entity_type: 'comment',
      entity_id: comment.id,
      action: 'created',
      ticket_id: ticketId,
      // actor_id: 'system' — see the dedupe path above for the runaway-loop
      // rationale. The created path is rarer (only the first silent-exit
      // for a fingerprint lands here; subsequent ones dedupe), but it's
      // exactly as capable of self-triggering an agent that's hit a hard
      // external limit. Treat it the same way.
      actor_id: 'system',
      actor_name: actorName,
      new_value: content,
      field_changed: 'system',
    });

    this.logService.info(
      'AgentApi',
      `Silent-exit system comment posted: ticket=${ticketId.slice(0, 8)} exit=${exitCode ?? '-'} trigger=${cycleTriggerId.slice(0, 8) || '-'}`,
      { ticket_id: ticketId, comment_id: comment.id, exit_code: exitCode, cycle_trigger_id: cycleTriggerId },
    );
    return res.status(201).json(comment);
  }

  private safeParseMetadata(raw: string | null | undefined): Record<string, unknown> {
    if (!raw || typeof raw !== 'string') return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  // Stable JSON key for the (reason, exit_code, author_role) tuple on a
  // type='system' comment. Returns null for any other comment type so the
  // dedupe never folds non-system rows together. Only fields that identify
  // "same kind of error" are included; cycle_trigger_id is intentionally
  // excluded — it varies per cycle and is the noise we want to collapse.
  private computeSystemFingerprint(
    metadata: Record<string, unknown>,
    commentType: string = 'system',
  ): string | null {
    if (commentType !== 'system') return null;
    const reason = typeof metadata.reason === 'string' ? metadata.reason : '';
    if (!reason) return null;
    const exitCode = metadata.exit_code === null || metadata.exit_code === undefined
      ? null
      : Number(metadata.exit_code);
    const authorRole = typeof metadata.author_role === 'string' ? metadata.author_role : '';
    return JSON.stringify({ reason, exit_code: exitCode, author_role: authorRole });
  }

  @Get('board-summary')
  async boardSummaryDefault(@Req() req: Request, @Res() res: Response) {
    return this.boardSummary('1', req, res);
  }

  @Get('board-summary/:boardId')
  async boardSummary(@Param('boardId') boardId: string, @Req() req: Request, @Res() res: Response) {
    const id = boardId || '1';
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');
    if (this.scopeRejects(req, board.workspace_id ?? null)) return this.denyScope(res);

    const columns = await this.colRepo.find({ where: { board_id: board.id }, order: { position: 'ASC' } });
    const summary = {
      board: board.name,
      description: board.description,
      columns: await Promise.all(columns.map(async col => {
        // Mirror REST GET /api/boards/:id — archived tickets drop out by
        // default. Legacy agent-api has no opt-in flag; if a caller needs
        // the full set they should migrate to the MCP get_board tool with
        // include_archived=true (or hit the archive endpoint directly).
        const tickets = await this.ticketRepo.find({
          where: { column_id: col.id, archived_at: IsNull() },
          relations: ['children'],
          order: { position: 'ASC' },
        });
        return {
          name: col.name,
          ticketCount: tickets.length,
          tickets: tickets.map(t => {
            const children = t.children || [];
            const done = children.filter(c => c.status === 'done').length;
            return { id: t.id, title: t.title, priority: t.priority, assignee: t.assignee || 'unassigned', subtasks: `${done}/${children.length} done` };
          }),
        };
      })),
    };
    return res.json(summary);
  }

  @Post('create-ticket')
  async createTicket(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { boardId, column, title, description = '', priority = 'medium', assignee = '', subtasks = [] } = body;
    if (!column || !title) return res.status(400).json({ error: 'column and title are required' });

    const col = await findColumnByName(this.dataSource, boardId, column);
    if (!col) return res.status(404).json({ error: `Column "${column}" not found` });
    if (this.scopeRejects(req, await this.resolveBoardWorkspaceId(this.dataSource, col.board_id))) {
      return this.denyScope(res);
    }

    const ticket = await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);

      const position = await maxTicketPosition(manager, col.id);
      // Stamp terminal_entered_at when the destination column is already
      // terminal so the archiver can later pick this row up. The archiver
      // requires terminal_entered_at IS NOT NULL.
      const terminalEnteredAt = isTerminalColumn(col) ? new Date() : null;
      const t = await tRepo.save(tRepo.create({
        column_id: col.id, title, description, priority, assignee, labels: '[]', position,
        terminal_entered_at: terminalEnteredAt,
      }));

      if (subtasks.length > 0) {
        const stEntities = subtasks.map((st: string | { title: string }, idx: number) => {
          const stTitle = typeof st === 'string' ? st : st.title;
          return tRepo.create({ parent_id: t.id, depth: 1, column_id: null as any, title: stTitle, position: idx, status: 'todo' });
        });
        await tRepo.save(stEntities);
      }

      return t;
    });

    const full = await this.ticketRepo.findOne({
      where: { id: ticket.id },
      relations: ['children'],
    });
    return res.status(201).json({ ...full, labels: JSON.parse(full!.labels || '[]') });
  }

  /** Atomic manager fallback for chat runtimes without native MCP.  The unique
   * key is cleared when a ticket becomes terminal, so only open work dedupes. */
  @Post('operational-capability-ticket')
  async operationalCapabilityTicket(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const scope = this.requestScope(req);
    const workspaceId = String(body.workspace_id || scope || '');
    if (!workspaceId || !body.dedupe_key || !body.operation || !body.missing_capability) {
      return res.status(400).json({ error: 'workspace_id, dedupe_key, operation and missing_capability are required' });
    }
    if (scope && scope !== workspaceId) return this.denyScope(res);
    try {
      const result = await this.dataSource.transaction(async manager => {
        const tickets = manager.getRepository(Ticket);
        const comments = manager.getRepository(Comment);
        let ticket = await tickets.findOne({ where: { operational_dedupe_key: String(body.dedupe_key), archived_at: IsNull() } });
        if (ticket) {
          await comments.save(comments.create({
            ticket_id: ticket.id,
            author_type: 'system', author: 'Agent Manager', type: 'system',
            content: `반복 운영 요청 감지: room=${body.room_id || ''} message=${body.message_id || ''}`,
          }));
          return { ticket, reused: true };
        }
        const board = body.board_id
          ? await manager.getRepository(Board).findOne({ where: { id: String(body.board_id), workspace_id: workspaceId } })
          : await manager.getRepository(Board).findOne({ where: { workspace_id: workspaceId }, order: { created_at: 'ASC' } });
        if (!board) throw new Error('no board available for operational fallback');
        const column = await manager.getRepository(BoardColumn).findOne({ where: { board_id: board.id, is_terminal: false }, order: { position: 'ASC' } });
        if (!column) throw new Error('no active column available for operational fallback');
        const title = `[운영 자동화] ${String(body.operation).slice(0, 120)}용 MCP/Action capability 추가`;
        ticket = tickets.create({
          workspace_id: workspaceId, column_id: column.id, title,
          description: `원 요청: ${body.original_request || body.operation}\n정규화 operation: ${body.operation}\n누락 capability: ${body.missing_capability}\nsource room/message: ${body.room_id || ''}/${body.message_id || ''}\n\nAction 검색 후에도 실행 수단이 없었습니다. capability 구현 후 원 대화에 결과를 회신하고, 안전·권한 조건을 포함한 idempotent Action으로 등록합니다.`,
          labels: JSON.stringify(['automation', 'mcp', 'mcp-missing', 'source:chat']),
          priority: 'medium', position: await maxTicketPosition(manager, column.id),
          operational_dedupe_key: String(body.dedupe_key),
        });
        ticket = await tickets.save(ticket);
        return { ticket, reused: false };
      });
      return res.status(result.reused ? 200 : 201).json({ id: result.ticket.id, title: result.ticket.title, reused: result.reused });
    } catch (error: any) {
      // A racing transaction won the unique key: read and reuse its open row.
      const existing = await this.ticketRepo.findOne({ where: { operational_dedupe_key: String(body.dedupe_key), archived_at: IsNull() } });
      if (existing) return res.status(200).json({ id: existing.id, title: existing.title, reused: true });
      return res.status(503).json({ error: 'operational_fallback_failed', message: error?.message || String(error) });
    }
  }

  @Post('move-ticket')
  async moveTicket(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { boardId, ticketId, toColumn, position, force } = body;
    if (!ticketId || !toColumn) return res.status(400).json({ error: 'ticketId and toColumn are required' });

    const ticket = await findOrFail(this.ticketRepo, { where: { id: ticketId } }, 'Ticket not found');
    if (this.scopeRejects(req, await this.resolveTicketWorkspaceId(this.dataSource, ticketId))) {
      return this.denyScope(res);
    }
    if (ticket.archived_at) {
      return res.status(409).json({
        error: 'ticket_archived',
        hint: 'Call unarchive first',
        message: new TicketArchivedError(ticket.id).message,
      });
    }

    const col = await findColumnByName(this.dataSource, boardId, toColumn);
    if (!col) return res.status(404).json({ error: `Column "${toColumn}" not found` });

    // Terminal-reopen guard (ticket ad0eb567) — same protection as the MCP
    // move_ticket tool: a stale automated caller must not drag an already-
    // terminal ticket back into a non-terminal column without force=true.
    const sourceColForGuard = ticket.column_id
      ? await this.colRepo.findOne({ where: { id: ticket.column_id } })
      : null;
    if (!force && isTerminalReopen(sourceColForGuard, col)) {
      const e = new TerminalReopenError(ticket.id, sourceColForGuard?.name ?? String(ticket.column_id), col.name);
      return res.status(e.status).json({ error: e.code, hint: e.hint, message: e.message });
    }

    // Review→Merging approval gate (ticket a3d25202) — the legacy move surface
    // is an automated caller too, so it must not become a backdoor that crosses
    // the review gate without a reviewer-authored comment. force=true overrides.
    if (!force && isReviewToMerging(sourceColForGuard, col) && !(await hasReviewerApproval(this.dataSource, ticket.id))) {
      const e = new ReviewApprovalRequiredError(ticket.id, sourceColForGuard?.name ?? String(ticket.column_id), col.name);
      return res.status(e.status).json({ error: e.code, hint: e.hint, message: e.message });
    }

    // 머지 게이트(티켓 c806bad3) — 이 legacy 자동 이동 표면도 백도어가 되지 않게
    // MCP/REST 와 동일한 검증. board opt-in(merge_gate_config) 시에만 동작, 해석 실패는
    // 통과(availability-first). force=true 우회.
    if (!force) {
      const mg = await evaluateMergeGate(this.dataSource, ticket, sourceColForGuard, col);
      if (mg.blocked) {
        const e = new MergeGateBlockedError(mg);
        return res.status(e.status).json({ error: e.code, hint: e.hint, message: e.message });
      }
    }

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const sourceColumnId = ticket.column_id;

      await shiftTicketPositions(tRepo, { column_id: sourceColumnId }, ticket.position, -1);

      const destCount = await tRepo.createQueryBuilder('t')
        .where('t.column_id = :colId AND t.id != :id AND t.parent_id IS NULL', { colId: col.id, id: ticket.id }).getCount();
      const pos = position ?? destCount;

      await shiftTicketPositions(tRepo, { column_id: col.id }, pos, +1, { inclusive: true, excludeId: ticket.id });

      await tRepo.update(ticket.id, { column_id: col.id, position: pos });

      // Keep terminal_entered_at honest on the legacy surface too — without
      // this stamp the archiver would never see tickets moved into Done via
      // this endpoint and would silently skip them forever.
      const colRepoTx = manager.getRepository(BoardColumn);
      const sourceCol = sourceColumnId
        ? await colRepoTx.findOne({ where: { id: sourceColumnId } })
        : null;
      await applyTerminalEnteredAtForMove(tRepo, ticket.id, sourceCol, col);
    });

    return res.json({ success: true, ticketId, movedTo: toColumn });
  }

  @Post('batch')
  async batch(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { operations } = body;
    if (!Array.isArray(operations)) return res.status(400).json({ error: 'operations array is required' });

    const results: any[] = [];
    // Workspace scope for this batch (null = env/admin/manager key → full
    // scope). Each op below verifies its target workspace against this before
    // mutating, so a scoped key can't reach across tenants via the batch loop.
    const batchScope = this.requestScope(req);
    const scopeDenied = { error: 'workspace_scope_denied' };

    // Stable rejection payload for archived-ticket mutations on the batch
    // surface. Mirrors the single-shot `/api/agent/move-ticket` response so
    // operators wiring batch consumers see the same `ticket_archived` code
    // they would see from the non-batch path — the policy is "archived
    // tickets are read-only except lookup, unarchive, and delete" and the
    // batch loop must not become a backdoor around it.
    const archivedRejection = (ticketId: string) => ({
      error: 'ticket_archived',
      hint: 'Call unarchive first',
      message: new TicketArchivedError(ticketId).message,
      ticketId,
    });

    // 머지 게이트(티켓 c806bad3) — batch move-ticket 도 자동 이동 표면이라
    // stale-base(Review→Merging)·부분머지(Merging→Done)를 서버가 막아야 한다.
    // ⚠️ evaluateMergeGate 의 기본 prober 는 forceFetch git fetch 를 수행하므로,
    // single move 핸들러(트랜잭션 밖 평가)와 동일하게 **트랜잭션 진입 전**에
    // 미리 평가한다. 트랜잭션 안에서 git I/O 를 돌리면 fetch 동안 DB 트랜잭션을
    // 붙잡는다(sql.js 는 전역 단일 연결이라 서버 전체를 막는다). 차단 결과를 op
    // 인덱스로 캐싱해 아래 루프에서는 조회만 한다. board opt-in·해석 실패 통과는
    // evaluateMergeGate 가 처리하고, 루프에서 merge gate 보다 먼저 거부되는
    // op(scope/archived/review-approval)는 여기서도 건너뛰어 single 핸들러와 동일한
    // 순서·부작용(차단 코멘트)을 유지한다. op.force 는 여기서 걸러진다.
    const mergeGateBlocks = new Map<number, MergeGateBlockedError>();
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (!op || op.action !== 'move-ticket' || op.force) continue;
      const col = await findColumnByName(this.dataSource, String(op.boardId), op.toColumn);
      if (!col) continue;
      const t = await this.ticketRepo.findOne({ where: { id: String(op.ticketId) } });
      if (!t) continue;
      if (batchScope && (await this.resolveTicketWorkspaceId(this.dataSource, t.id)) !== batchScope) continue;
      if (t.archived_at) continue;
      const sourceCol = t.column_id
        ? await this.colRepo.findOne({ where: { id: t.column_id } })
        : null;
      // review-approval 은 루프에서 merge gate 보다 먼저 거부하므로 여기서도 건너뛴다
      // (불필요한 git fetch + 오해 소지 있는 차단 코멘트 방지).
      if (isReviewToMerging(sourceCol, col) && !(await hasReviewerApproval(this.dataSource, t.id))) continue;
      const mg = await evaluateMergeGate(this.dataSource, t, sourceCol, col);
      if (mg.blocked) mergeGateBlocks.set(i, new MergeGateBlockedError(mg));
    }

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const cRepo = manager.getRepository(Comment);
      const colRepoTx = manager.getRepository(BoardColumn);

      let opIndex = -1;
      for (const op of operations) {
        opIndex++;
        try {
          switch (op.action) {
            case 'create-ticket': {
              const col = await findColumnByName(manager, String(op.boardId), op.column);
              if (!col) { results.push({ error: `Column "${op.column}" not found` }); continue; }
              if (batchScope && (await this.resolveBoardWorkspaceId(manager, col.board_id)) !== batchScope) {
                results.push(scopeDenied); continue;
              }
              const pos = await maxTicketPosition(manager, col.id);
              // Stamp terminal_entered_at when landing directly on a terminal
              // column — same rationale as the single-shot create-ticket above.
              const terminalEnteredAt = isTerminalColumn(col) ? new Date() : null;
              const r = await tRepo.save(tRepo.create({
                column_id: col.id, title: op.title, description: op.description || '',
                priority: op.priority || 'medium', assignee: op.assignee || '', labels: '[]', position: pos,
                terminal_entered_at: terminalEnteredAt,
              }));
              results.push({ success: true, ticketId: r.id });
              break;
            }
            case 'move-ticket': {
              const col = await findColumnByName(manager, String(op.boardId), op.toColumn);
              if (!col) { results.push({ error: `Column "${op.toColumn}" not found` }); continue; }
              const t = await tRepo.findOne({ where: { id: String(op.ticketId) } });
              if (!t) { results.push({ error: 'Ticket not found' }); continue; }
              if (batchScope && (await this.resolveTicketWorkspaceId(manager, t.id)) !== batchScope) {
                results.push(scopeDenied); continue;
              }
              if (t.archived_at) { results.push(archivedRejection(t.id)); continue; }

              const sourceColumnId = t.column_id;

              // Terminal-reopen guard (ticket ad0eb567) — the batch surface is
              // an automated caller too, so it must not become a backdoor that
              // drags an already-terminal ticket back out without op.force.
              const sourceColForGuard = sourceColumnId
                ? await colRepoTx.findOne({ where: { id: sourceColumnId } })
                : null;
              if (!op.force && isTerminalReopen(sourceColForGuard, col)) {
                const e = new TerminalReopenError(t.id, sourceColForGuard?.name ?? String(sourceColumnId), col.name);
                results.push({ error: e.code, hint: e.hint, message: e.message, ticketId: t.id });
                continue;
              }

              // Review→Merging approval gate (ticket a3d25202) — the batch loop
              // is another automated move surface; keep it from bypassing review
              // independence. Uses the transaction manager as scope. op.force
              // overrides, mirroring the terminal-reopen guard above.
              if (!op.force && isReviewToMerging(sourceColForGuard, col) && !(await hasReviewerApproval(manager, t.id))) {
                const e = new ReviewApprovalRequiredError(t.id, sourceColForGuard?.name ?? String(sourceColumnId), col.name);
                results.push({ error: e.code, hint: e.hint, message: e.message, ticketId: t.id });
                continue;
              }

              // 머지 게이트(티켓 c806bad3) — 이 이동은 트랜잭션 진입 전(batch() 상단)에
              // 미리 평가해 op 인덱스로 캐싱했다(git fetch 동안 DB 트랜잭션을 잡지 않기
              // 위함 — single 핸들러와 동일 의도). 여기서는 조회만; op.force 는 pre-pass
              // 에서 이미 걸러졌고, review-approval 등 앞선 가드도 pre-pass 가 미러링한다.
              const mgBlock = mergeGateBlocks.get(opIndex);
              if (mgBlock) {
                results.push({ error: mgBlock.code, hint: mgBlock.hint, message: mgBlock.message, ticketId: t.id });
                continue;
              }

              await shiftTicketPositions(tRepo, { column_id: sourceColumnId }, t.position, -1);

              const cnt = await tRepo.createQueryBuilder('t')
                .where('t.column_id = :colId AND t.id != :id AND t.parent_id IS NULL', { colId: col.id, id: t.id }).getCount();
              const pos = op.position ?? cnt;

              await shiftTicketPositions(tRepo, { column_id: col.id }, pos, +1, { inclusive: true, excludeId: t.id });

              await tRepo.update(t.id, { column_id: col.id, position: pos });

              // Mirror the single-shot move-ticket handler — without this
              // stamp the archiver candidate query (`terminal_entered_at IS
              // NOT NULL`) would never see tickets moved into Done through
              // the batch surface, so auto-archive would silently skip
              // them forever.
              const sourceCol = sourceColumnId
                ? await colRepoTx.findOne({ where: { id: sourceColumnId } })
                : null;
              await applyTerminalEnteredAtForMove(tRepo, t.id, sourceCol, col);

              results.push({ success: true, ticketId: op.ticketId, movedTo: op.toColumn });
              break;
            }
            case 'add-child':
            case 'add-subtask': {
              const parentId = String(op.ticketId);
              const parent = await tRepo.findOne({ where: { id: parentId } });
              if (!parent) { results.push({ error: 'Parent ticket not found' }); continue; }
              if (batchScope && (await this.resolveTicketWorkspaceId(manager, parent.id)) !== batchScope) {
                results.push(scopeDenied); continue;
              }
              // Walk to the root — subtasks have no column and carry no
              // archived_at of their own; the root carries the flag.
              const rootArchived = await getRootArchivedAt(manager, parent);
              if (rootArchived) { results.push(archivedRejection(parent.id)); continue; }

              const position = await maxChildPosition(manager, parentId);
              const r = await tRepo.save(tRepo.create({
                parent_id: parentId, depth: 1, column_id: null as any,
                title: op.title, position, status: 'todo',
              }));
              results.push({ success: true, ticketId: r.id });
              break;
            }
            case 'update-child':
            case 'update-subtask': {
              const updates: any = {};
              if (op.done !== undefined) updates.status = op.done ? 'done' : 'todo';
              if (op.title !== undefined) updates.title = op.title;
              if (op.status !== undefined) updates.status = String(op.status);
              const ticketId = String(op.subtaskId || op.ticketId);
              const sub = await tRepo.findOne({ where: { id: ticketId } });
              if (!sub) { results.push({ error: 'Ticket not found' }); continue; }
              if (batchScope && (await this.resolveTicketWorkspaceId(manager, sub.id)) !== batchScope) {
                results.push(scopeDenied); continue;
              }
              const rootArchived = await getRootArchivedAt(manager, sub);
              if (rootArchived) { results.push(archivedRejection(ticketId)); continue; }
              await tRepo.update(ticketId, updates);
              results.push({ success: true, ticketId });
              break;
            }
            case 'add-comment': {
              const ticketId = String(op.ticketId);
              const t = await tRepo.findOne({ where: { id: ticketId } });
              if (!t) { results.push({ error: 'Ticket not found' }); continue; }
              if (batchScope && (await this.resolveTicketWorkspaceId(manager, t.id)) !== batchScope) {
                results.push(scopeDenied); continue;
              }
              if (t.archived_at) { results.push(archivedRejection(ticketId)); continue; }
              const r = await cRepo.save(cRepo.create({
                ticket_id: ticketId,
                author_type: op.authorType || 'agent',
                author_id: String(op.authorId || ''),
                author: op.author || '',
                content: op.content,
              }));
              results.push({ success: true, commentId: r.id });
              break;
            }
            default:
              results.push({ error: `Unknown action: ${op.action}` });
          }
        } catch (opErr: any) {
          results.push({ error: opErr.message });
        }
      }
    });

    return res.json({ results });
  }

  /**
   * Lightweight presence heartbeat. Mirrors the MCP `ping` tool but skips the
   * 4-step initialize / notifications/initialized / tools/call / DELETE dance
   * that an MCP session requires — a single POST is enough to stamp
   * last_seen_at, and the previous flow was the dominant source of MCP
   * session churn (one new + one closed session per heartbeat per proxy,
   * multiplied across every running agent instance).
   *
   * Intentionally silent at info-level: every healthy proxy posts one every
   * HEARTBEAT_INTERVAL_MS (30s by default), so logging would drown the rest
   * of the MCP/HTTP timeline. last_seen_at is the source of truth.
   */
  @Post('ping')
  async ping(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { agent_id } = body || {};
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    const agentRepo = this.dataSource.getRepository(Agent);
    let agent = await agentRepo.findOne({ where: { id: agent_id } });

    // Repair ApiKey.agent_id when it was nulled out by an earlier
    // `ON DELETE SET NULL` FK firing during an Agent-row deletion window
    // (pre-sync chaos, manual cleanup, etc.). Without this repair the SSE
    // auth path reads apiKey.agent_id = null → identity.agentId = undefined
    // → every per-agent SSE filter (`scope.agent_id === identity.agentId`)
    // rejects and update_manager / restart_manager / chat_request /
    // comment_mention silently never reach the manager. Symptom: server
    // returns 200 on dispatch and emits the event, but no SSE subscriber
    // matches so it falls into the void.
    const apiKeyRow = (req as any).apiKey;
    if (apiKeyRow && agent && !apiKeyRow.agent_id) {
      try {
        const apiKeyRepo = this.dataSource.getRepository(ApiKey);
        await apiKeyRepo.update({ id: apiKeyRow.id }, { agent_id: agent.id });
        apiKeyRow.agent_id = agent.id;
        this.logService.warn(
          'AgentApi',
          `Re-linked ApiKey id=${apiKeyRow.id.slice(0, 8)} agent_id=${agent.id.slice(0, 8)} (was NULL — ON DELETE SET NULL aftermath)`,
          { api_key_id: apiKeyRow.id, agent_id: agent.id, via: 'ping repair' },
        );
      } catch (err: any) {
        this.logService.error(
          'AgentApi',
          `Ping apiKey repair failed for api_key=${apiKeyRow.id.slice(0, 8)}: ${err?.message ?? String(err)}`,
          { err: err?.message ?? String(err), api_key_id: apiKeyRow.id },
        );
      }
    }
    // Self-heal mirror of instance-heartbeat (agent-manager.controller.ts:163).
    // A manager whose Agent row was deleted out from under it would otherwise
    // 404 on every 30s ping AND never appear searchable in the AI Agents
    // page until the operator manually re-pairs. Recreate from the API key's
    // linked agent metadata so the manager rejoins the system on the next
    // tick — workspace_id=null per the workspace-less invariant for managers,
    // arbitrary name preserved from the API key so the operator can still
    // identify it from the admin UI's instance list.
    if (!agent) {
      const apiKey = (req as any).apiKey;
      const linkedAgent = apiKey?.agent;
      if (linkedAgent && linkedAgent.id === agent_id) {
        try {
          const recreated = agentRepo.create({
            id: agent_id,
            name: linkedAgent.name || `awb-agent-manager`,
            description:
              linkedAgent.description ||
              'awb-agent-manager — recreated from ping (Agent row was missing)',
            type: linkedAgent.type === 'manager' ? 'manager' : (linkedAgent.type || 'manager'),
            is_active: 1,
            workspace_id: linkedAgent.type === 'manager' ? null : linkedAgent.workspace_id ?? null,
            roles: linkedAgent.roles || '[]',
          });
          await agentRepo.save(recreated);
          this.logService.warn(
            'AgentApi',
            `Recreated missing Agent row id=${agent_id.slice(0, 8)} type=${recreated.type} from ping self-heal`,
            { agent_id, via: 'ping self-heal' },
          );
          agent = recreated;
        } catch (err: any) {
          this.logService.error(
            'AgentApi',
            `Ping self-heal save failed for agent_id=${agent_id.slice(0, 8)}: ${err?.message ?? String(err)}`,
            { err: err?.message ?? String(err), agent_id, stack: err?.stack },
          );
          return res.status(500).json({ error: 'Ping self-heal failed', detail: err?.message ?? String(err) });
        }
      } else {
        return res.status(404).json({ error: 'Agent not found' });
      }
    }
    const now = new Date();
    const patch: Partial<Agent> = { last_seen_at: now, is_online: 1 };
    if (!agent.connected_at) patch.connected_at = now;
    await agentRepo.update({ id: agent_id }, patch);
    return res.json({ status: 'ok', agent_id, last_seen_at: now.toISOString() });
  }

  @Post('chat-rooms/:roomId/typing')
  async setChatRoomTyping(@Body() body: any, @Param('roomId') roomId: string, @Req() req: Request, @Res() res: Response) {
    const { agent_id, agent_name, is_typing, status } = body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    if (this.scopeRejects(req, await this.resolveRoomWorkspaceId(roomId))) return this.denyScope(res);
    // Resolve canonical Manager/Agent display server-side so the typing
    // indicator label matches the rest of the chat UI even when the
    // subagent posts a bare name (or no name at all).
    const resolvedName =
      (await resolveAgentDisplayName(this.dataSource.getRepository(Agent), agent_id))
      || agent_name
      || 'Agent';
    const memberIds = await this.membership.getRoomMemberIds(roomId);
    const agentMemberIds = await this.membership.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_typing', {
      room_id: roomId,
      agent_id,
      agent_name: resolvedName,
      is_typing: is_typing !== false,
      status: status || null,
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
    return res.json({ ok: true });
  }

  @Post('chat-rooms/:roomId/messages')
  async sendChatRoomMessage(@Body() body: any, @Param('roomId') roomId: string, @Req() req: Request, @Res() res: Response) {
    const { agent_id, content } = body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    if (this.scopeRejects(req, await this.resolveRoomWorkspaceId(roomId))) return this.denyScope(res);
    const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
    // Empty content is valid when attachments carry the payload — service
    // enforces the "content OR attachment_ids" rule consistently.
    if ((!content || (typeof content === 'string' && !content.trim())) && attachmentIds.length === 0) {
      return res.status(400).json({ error: 'content or attachment_ids required' });
    }
    // Optional discriminator — agent-manager passes 'progress' for tool-call
    // heartbeats so they get filtered out of agent history replays. Default
    // to 'message' for legacy callers that don't set it.
    const rawType = typeof body.type === 'string' ? body.type : 'message';
    if (!CHAT_MESSAGE_TYPES.includes(rawType as ChatMessageType)) {
      return res.status(400).json({ error: `invalid type: ${rawType}` });
    }
    const messageType = rawType as ChatMessageType;

    const room = await this.dataSource.getRepository(ChatRoom).findOne({ where: { id: roomId } });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const agentName = await resolveAgentDisplayName(
      this.dataSource.getRepository(Agent),
      agent_id,
    ) || 'Agent';

    const msg = await this.messaging.sendMessage(
      roomId,
      room.workspace_id,
      'agent',
      agent_id,
      agentName,
      content ?? '',
      undefined,
      attachmentIds,
      messageType,
      // F-1 (ticket 24694916): structured ticket-action refs the agent-manager
      // captured from mcp__awb__* tool results. sendMessage sanitizes + bounds it;
      // absent on ordinary sends. Only wired on this agent-authenticated path.
      { metadata: body.metadata },
    );
    return res.status(201).json(msg);
  }

  @Get('chat-rooms/:roomId/messages')
  async getChatRoomMessages(@Param('roomId') roomId: string, @Req() req: Request, @Res() res: Response, @Query('limit') limitStr?: string) {
    if (this.scopeRejects(req, await this.resolveRoomWorkspaceId(roomId))) return this.denyScope(res);
    const limit = Math.min(parseInt(limitStr || '50', 10) || 50, 200);
    // Chat history feeding back into a spawned CLI must NOT include the
    // manager's own progress narration — `excludeProgress` drops type='progress'
    // rows at the SQL level. The web UI calls the user-session controller,
    // which does not set this flag, so humans still see the heartbeat trail.
    const messages = await this.messaging.getMessages(
      roomId, '', limit, undefined, { observer: true, excludeProgress: true },
    );
    return res.json(messages);
  }

  // Mirrors the user-session GET /api/chat-rooms/:roomId/attachments/:id but
  // gated by AgentAuthGuard + agent participant check so the agent-manager
  // can fetch attachment bytes for vision / file delivery to subagent prompts.
  // The user-session route stays the canonical UI path; this is a peer that
  // exists so an agent-key holder doesn't have to spin up a user session just
  // to read content from a room it's already a participant of.
  @Get('chat-rooms/:roomId/attachments/:attachmentId')
  async getChatRoomAttachment(
    @Req() req: Request,
    @Res() res: Response,
    @Param('roomId') roomId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const agentId = (req as any).currentAgentId as string | undefined;
    if (!agentId) return res.status(403).json({ error: 'Agent identity required' });
    if (this.scopeRejects(req, await this.resolveRoomWorkspaceId(roomId))) return this.denyScope(res);
    try {
      await this.membership.requireActiveParticipant(roomId, agentId, 'agent');
      const row = await this.dataSource.getRepository(TicketAttachment).findOne({
        where: { id: attachmentId, room_id: roomId },
      });
      if (!row || (row.owner_type !== 'chat_room' && row.owner_type !== 'chat_message')) {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      return res.json(projectChatAttachment(row, { includeData: true }));
    } catch (err: any) {
      return res.status(err.status || 403).json({ error: err.message });
    }
  }
}
