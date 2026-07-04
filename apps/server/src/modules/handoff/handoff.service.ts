import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Comment } from '../../entities/Comment';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { LogService } from '../../services/log.service';
import { ActivityService, activityEvents } from '../../services/activity.service';
import { isTerminalColumn } from '../mcp/shared/archive-helpers';
import {
  findColumnByName,
  maxTicketPosition,
  resolveAgentIdAndName,
  refreshTicketWorkspaceId,
} from '../mcp/shared/ticket-helpers';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import { TicketPrerequisitesService } from '../tickets/ticket-prerequisites.service';
import { TriggerLoopService } from '../agents/trigger-loop.service';
import { parseDefaultRoleAssignments } from '../../common/default-role-assignments-config';
import {
  parseHandoffSpec,
  handoffSpecHasHops,
  HandoffHop,
  HandoffSpec,
} from '../../common/handoff-spec-config';

function safeJsonParse<T = any>(val: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(val || JSON.stringify(fallback)) as T;
  } catch {
    return fallback;
  }
}

/** Label stamped on every ticket a relay creates, so the pipeline rollup / UI
 * can tell a handoff follow-up apart from a hand-filed ticket at a glance. */
export const HANDOFF_FOLLOWUP_LABEL = 'handoff';
/** Label stamped on a reverse-rejection defect ticket (부품 3). */
export const HANDOFF_REJECTION_LABEL = 'handoff-rejection';

export interface RejectHandoffArgs {
  followupTicketId: string;
  reason: string;
  defectTitle?: string;
  defectColumnName?: string;
  defectAssigneeId?: string;
  actorId?: string;
  actorName?: string;
}

export interface RejectHandoffResult {
  defect_ticket_id: string;
  defect_board_id: string;
  source_ticket_id: string;
  followup_pending_on_tickets: boolean;
}

export interface PipelineStage {
  ticket_id: string;
  title: string;
  board_id: string;
  board_name: string;
  column_id: string | null;
  column_name: string;
  is_terminal: boolean;
  status: string;
  is_followup: boolean;
  is_rejection: boolean;
  source_ticket_id: string;
  pending_on_tickets: boolean;
  remaining_hops: number;
  created_at: Date;
}

export interface HandoffPipeline {
  root_ticket_id: string;
  stages: PipelineStage[];
}

/**
 * Cross-board handoff pipeline — relay engine (ticket ac21a745).
 *
 * The runtime companion to the `handoff_spec` data layer. A SEPARATE listener
 * on the shared `activityEvents` 'activity' stream — the exact pattern
 * OnTicketDoneActionService / QaRerunOnFixService use — so no module takes a
 * dependency on another. When a ticket carrying a `handoff_spec` lands on a
 * terminal column, this service:
 *
 *   1. Atomically claims `handoff_dispatched_at` (its OWN idempotency stamp,
 *      separate from on_done / qa_rerun so the three terminal-entry hooks never
 *      starve each other) — at most one relay per terminal ENTRY.
 *   2. Pops the FIRST hop, creates a follow-up ticket on that hop's target board
 *      carrying the source's deliverable context (deep link + final handoff
 *      comment + carried attachments), and hands the REMAINING hops down to the
 *      follow-up's own `handoff_spec`. So one N-hop spec drives an N-board relay
 *      (기획→그래픽→클라→QA) with zero human intervention — each stage's
 *      completion births the next. The chain self-terminates when the last hop
 *      is consumed (the follow-up carries an empty spec).
 *
 * It also owns the reverse-rejection (`rejectHandoff`) and pipeline rollup
 * (`getPipeline`) surfaces the MCP tools call into.
 */
@Injectable()
export class HandoffService implements OnModuleInit, OnModuleDestroy {
  private _activityListener?: (log: ActivityLog) => void;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly roleAssignmentService: TicketRoleAssignmentService,
    private readonly prerequisitesService: TicketPrerequisitesService,
    private readonly triggerLoopService: TriggerLoopService,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
  ) {}

  onModuleInit() {
    this._activityListener = (log: ActivityLog) => {
      this._handleActivity(log).catch((e: unknown) => {
        this.logService.error('Handoff', 'HandoffService _handleActivity error', { err: e });
      });
    };
    activityEvents.on('activity', this._activityListener);
  }

  onModuleDestroy() {
    if (this._activityListener) {
      activityEvents.removeListener('activity', this._activityListener);
      this._activityListener = undefined;
    }
  }

  // ── Relay engine ─────────────────────────────────────────────────────────

  private async _handleActivity(log: ActivityLog): Promise<void> {
    // Only a column move can land a ticket on a terminal column.
    if (log.action !== 'moved' || !log.ticket_id) return;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: log.ticket_id } });
    if (!ticket || !ticket.column_id) return;

    const col = await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } });
    if (!isTerminalColumn(col)) return;
    // Without a terminal-entry anchor the edge-claim predicate has nothing to
    // compare against — bail (matches the on-done hook's "same entry" semantics).
    if (!ticket.terminal_entered_at) return;

    // Cheap pre-claim scope guard: no hops → nothing to relay. Avoids a write on
    // every completion of every ticket that carries no handoff spec.
    if (!handoffSpecHasHops(ticket.handoff_spec)) return;

    // Atomic once-per-terminal-entry claim. The WHERE guard is the real
    // protection against two near-simultaneous 'moved' activities both relaying:
    // only the first UPDATE matches.
    const claimAt = new Date();
    const claim = await ticketRepo
      .createQueryBuilder()
      .update(Ticket)
      .set({ handoff_dispatched_at: claimAt })
      .where('id = :id', { id: ticket.id })
      .andWhere('terminal_entered_at IS NOT NULL')
      .andWhere('(handoff_dispatched_at IS NULL OR handoff_dispatched_at < terminal_entered_at)')
      .execute();
    const claimed = claim.affected === undefined || claim.affected === null || claim.affected > 0;
    if (!claimed) {
      this.logService.info('Handoff', 'relay skipped (already dispatched this terminal entry)', {
        ticket_id: ticket.id,
      });
      return;
    }

    try {
      await this._dispatchRelay(ticket);
    } catch (e: any) {
      // A relay failure must never crash the event listener — log and move on.
      this.logService.error('Handoff', `relay dispatch failed for ticket ${ticket.id}: ${e?.message || e}`);
    }
  }

  /**
   * Pop the first hop off the source ticket's spec and create the follow-up on
   * that board, inheriting the remaining hops. Board/column existence is checked
   * here against the DB — a spec pointing at a board that later disappeared
   * degrades to a logged skip, never a crash.
   */
  private async _dispatchRelay(source: Ticket): Promise<void> {
    const spec = parseHandoffSpec(source.handoff_spec);
    if (spec.hops.length === 0) return;
    const [hop, ...remaining] = spec.hops;

    const board = await this.dataSource.getRepository(Board).findOne({ where: { id: hop.target_board_id } });
    if (!board) {
      this.logService.warn('Handoff', 'relay hop target board missing — skipping', {
        source_ticket_id: source.id, target_board_id: hop.target_board_id,
      });
      return;
    }

    const column = await this._resolveColumn(hop.target_board_id, hop.target_column_name);
    if (!column) {
      this.logService.warn('Handoff', 'relay hop target board has no usable column — skipping', {
        source_ticket_id: source.id, target_board_id: hop.target_board_id,
      });
      return;
    }

    const followupId = await this._createFollowupTicket(source, hop, { hops: remaining }, column, board);

    this.logService.info('Handoff', 'relay follow-up created', {
      source_ticket_id: source.id,
      followup_ticket_id: followupId,
      target_board_id: hop.target_board_id,
      target_column: column.name,
      remaining_hops: remaining.length,
    });
  }

  /**
   * Create the follow-up ticket carrying the source's deliverable context.
   * Mirrors QaFailureTicketService._createTicket / FeaturesService._createChainTicket:
   * create → backfill workspace_id → sync builtin trio → apply board defaults →
   * log 'created'. Then carries attachments + inherits remaining hops.
   */
  private async _createFollowupTicket(
    source: Ticket,
    hop: HandoffHop,
    remainingSpec: HandoffSpec,
    column: BoardColumn,
    board: Board,
  ): Promise<string> {
    const title = this._buildTitle(hop, source);
    const description = await this._buildFollowupBody(source, hop);
    const labels = this._buildLabels(hop, HANDOFF_FOLLOWUP_LABEL);
    const priority = (hop.priority || source.priority || 'medium').trim();

    // Resolve role holders: explicit hop holders win, else fall back to the
    // source ticket's holders (the same functional owner carries the relay when
    // the hop doesn't re-target), else the target board's default_role_assignments
    // fill any still-vacant role below.
    const assigneeId = hop.assignee_id || source.assignee_id || '';
    const reporterId = hop.reporter_id || source.reporter_id || '';
    const reviewerId = hop.reviewer_id || source.reviewer_id || '';
    const resolvedAssignee = await resolveAgentIdAndName(this.dataSource, assigneeId, '', this.logService);

    const inheritsHops = remainingSpec.hops.length > 0;
    const followup = await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const position = await maxTicketPosition(manager, column.id);
      return tRepo.save(tRepo.create({
        column_id: column.id,
        workspace_id: board.workspace_id || '',
        title,
        description,
        priority,
        assignee: resolvedAssignee.name,
        reporter: resolvedAssignee.name,
        assignee_id: assigneeId,
        reporter_id: reporterId,
        reviewer_id: reviewerId,
        labels: JSON.stringify(labels),
        channel_ids: '[]',
        position,
        effort_preset: hop.effort_preset && hop.effort_preset.trim() ? hop.effort_preset.trim() : null,
        // Inherit the remaining hops so the relay continues when THIS ticket
        // completes; '' when the last hop was just consumed (relay terminates).
        handoff_spec: inheritsHops ? JSON.stringify(remainingSpec) : '',
        // Relay lineage back-pointer — powers reverse rejection + pipeline rollup.
        handoff_source_ticket_id: source.id,
        created_by: 'Handoff',
        created_by_type: 'system',
        created_by_id: '',
      }));
    });

    // Backfill workspace_id (column → board) then mirror the role trio onto
    // TicketRoleAssignment so the trigger loop / focus selector see the ticket
    // and the assignee loop actually dispatches.
    await refreshTicketWorkspaceId(this.dataSource, followup);
    const wsId = followup.workspace_id || board.workspace_id || '';
    if (wsId) {
      await this.roleAssignmentService.syncBuiltinTrio(followup.id, wsId, {
        assignee_id: assigneeId || undefined,
        reporter_id: reporterId || undefined,
        reviewer_id: reviewerId || undefined,
      });
      // Board default role holders — fill any role still VACANT after the trio.
      try {
        const defaults = parseDefaultRoleAssignments(board.default_role_assignments);
        if (Object.keys(defaults).length > 0) {
          await this.roleAssignmentService.applyBoardDefaults(followup.id, wsId, defaults);
        }
      } catch { /* non-fatal — degrade to "no defaults" */ }
    }

    // Carry deliverable attachments (기획서 / 에셋 매니페스트) onto the follow-up
    // so the next board's agent never has to re-discover the predecessor's output.
    await this._carryAttachments(source, followup, hop, wsId);

    await this.activityService.logActivity({
      entity_type: 'ticket',
      entity_id: followup.id,
      action: 'created',
      ticket_id: followup.id,
      actor_name: 'Handoff',
    });

    return followup.id;
  }

  /**
   * Copy the source ticket's attachment rows onto the follow-up when the hop
   * opts in (carry_attachments = all, carry_attachment_ids = a subset; the two
   * are union'd). Duplicates the base64 payload so the follow-up is
   * self-contained on its own board. Never throws — a carry failure must not
   * abort the relay (the follow-up still has the deep link in its body).
   */
  private async _carryAttachments(
    source: Ticket,
    followup: Ticket,
    hop: HandoffHop,
    workspaceId: string,
  ): Promise<void> {
    const wantAll = hop.carry_attachments === true;
    const wantIds = Array.isArray(hop.carry_attachment_ids) ? hop.carry_attachment_ids.filter(Boolean) : [];
    if (!wantAll && wantIds.length === 0) return;

    try {
      const attRepo = this.dataSource.getRepository(TicketAttachment);
      const sourceRows = await attRepo.find({
        where: { ticket_id: source.id, owner_type: 'ticket' },
        order: { created_at: 'ASC' },
      });
      const idSet = new Set(wantIds);
      const picked = sourceRows.filter((r) => wantAll || idSet.has(r.id));
      if (picked.length === 0) return;

      for (const r of picked) {
        await attRepo.save(attRepo.create({
          workspace_id: workspaceId || r.workspace_id || '',
          owner_type: 'ticket',
          owner_id: followup.id,
          ticket_id: followup.id,
          room_id: null,
          file_name: r.file_name,
          file_mimetype: r.file_mimetype,
          file_data: r.file_data,
          file_size: r.file_size,
          uploaded_by_type: 'system',
          uploaded_by_id: '',
          uploaded_by: 'Handoff',
        }));
      }
      this.logService.info('Handoff', 'carried attachments to follow-up', {
        source_ticket_id: source.id, followup_ticket_id: followup.id, count: picked.length,
      });
    } catch (e: any) {
      this.logService.warn('Handoff', `attachment carry failed (continuing): ${e?.message || e}`, {
        source_ticket_id: source.id, followup_ticket_id: followup.id,
      });
    }
  }

  // ── Reverse rejection (부품 3) ─────────────────────────────────────────────

  /**
   * A follow-up board found the PREDECESSOR's deliverable defective. File a
   * defect ticket back on the source ticket's board (assigned to whoever
   * produced the deliverable) AND re-block the follow-up on it as a prerequisite,
   * so the follow-up auto-resumes the instant the defect is fixed. This is the
   * cross-board generalization of the QA→fix loop.
   */
  async rejectHandoff(args: RejectHandoffArgs): Promise<RejectHandoffResult> {
    const followup = await this.dataSource.getRepository(Ticket).findOne({ where: { id: args.followupTicketId } });
    if (!followup) throw badRequest('Follow-up ticket not found');
    const sourceId = (followup.handoff_source_ticket_id || '').trim();
    if (!sourceId) {
      throw badRequest('This ticket was not created by a handoff relay (no handoff_source_ticket_id) — nothing to reject upstream');
    }
    const source = await this.dataSource.getRepository(Ticket).findOne({ where: { id: sourceId } });
    if (!source) throw badRequest(`Source ticket ${sourceId} not found (relay lineage broken)`);
    if (!source.column_id) throw badRequest('Source ticket has no column — cannot resolve its board');
    const sourceCol = await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: source.column_id } });
    if (!sourceCol) throw badRequest('Source ticket column missing — cannot resolve its board');
    const sourceBoard = await this.dataSource.getRepository(Board).findOne({ where: { id: sourceCol.board_id } });
    if (!sourceBoard) throw badRequest('Source board not found');

    const column = await this._resolveColumn(sourceCol.board_id, args.defectColumnName);
    if (!column) throw badRequest('Source board has no usable column for the defect ticket');

    const defectId = await this._createRejectionTicket(source, followup, sourceBoard, column, args);

    // Re-block the follow-up on the defect: pending_on_tickets flips true and the
    // follow-up auto-resumes the moment the defect lands on a terminal column
    // (TicketPrerequisitesService auto-resume wiring in TriggerLoopService).
    const addResult = await this.prerequisitesService.addPrerequisites(followup.id, [defectId], {
      reason: `크로스보드 반려: 선행 산출물(${source.title}) 결함 수정 대기`,
      actorId: args.actorId,
      actorName: args.actorName || 'Handoff',
    });

    this.logService.info('Handoff', 'reverse rejection filed', {
      followup_ticket_id: followup.id, source_ticket_id: source.id,
      defect_ticket_id: defectId, defect_board_id: sourceBoard.id,
    });

    return {
      defect_ticket_id: defectId,
      defect_board_id: sourceBoard.id,
      source_ticket_id: source.id,
      followup_pending_on_tickets: addResult.pending_on_tickets,
    };
  }

  private async _createRejectionTicket(
    source: Ticket,
    followup: Ticket,
    board: Board,
    column: BoardColumn,
    args: RejectHandoffArgs,
  ): Promise<string> {
    const title = (args.defectTitle && args.defectTitle.trim())
      ? args.defectTitle.trim()
      : `[반려] ${source.title}`;
    const description = this._buildRejectionBody(source, followup, args.reason);
    // Default the defect to whoever produced the source deliverable.
    const assigneeId = args.defectAssigneeId || source.assignee_id || '';
    const resolved = await resolveAgentIdAndName(this.dataSource, assigneeId, '', this.logService);

    const defect = await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const position = await maxTicketPosition(manager, column.id);
      return tRepo.save(tRepo.create({
        column_id: column.id,
        workspace_id: board.workspace_id || '',
        title,
        description,
        priority: 'high',
        assignee: resolved.name,
        reporter: resolved.name,
        assignee_id: assigneeId,
        reporter_id: assigneeId,
        reviewer_id: assigneeId,
        labels: JSON.stringify([HANDOFF_REJECTION_LABEL, 'auto']),
        channel_ids: '[]',
        position,
        created_by: 'Handoff',
        created_by_type: 'system',
        created_by_id: '',
      }));
    });

    await refreshTicketWorkspaceId(this.dataSource, defect);
    const wsId = defect.workspace_id || board.workspace_id || '';
    if (wsId && assigneeId) {
      await this.roleAssignmentService.syncBuiltinTrio(defect.id, wsId, {
        assignee_id: assigneeId,
        reporter_id: assigneeId,
        reviewer_id: assigneeId,
      });
    }
    if (wsId) {
      try {
        const defaults = parseDefaultRoleAssignments(board.default_role_assignments);
        if (Object.keys(defaults).length > 0) {
          await this.roleAssignmentService.applyBoardDefaults(defect.id, wsId, defaults);
        }
      } catch { /* non-fatal */ }
    }

    await this.activityService.logActivity({
      entity_type: 'ticket',
      entity_id: defect.id,
      action: 'created',
      ticket_id: defect.id,
      actor_name: 'Handoff',
    });

    // Dispatch the defect ticket's current-column holders so the fix loop starts
    // without waiting for a supervisor poll (mirrors the feature-chain root dispatch).
    if (this.triggerLoopService) {
      try {
        await this.triggerLoopService.dispatchCurrentColumn(defect.id, 'handoff_rejection', args.actorId || '');
      } catch (e) {
        this.logService.warn('Handoff', 'rejection ticket dispatch failed (continuing)', {
          err: String(e), defect_ticket_id: defect.id,
        });
      }
    }

    return defect.id;
  }

  // ── Pipeline rollup (부품 4) ────────────────────────────────────────────────

  /**
   * Reconstruct the whole relay a ticket belongs to. Walk UP the lineage
   * (handoff_source_ticket_id) to the root, then walk DOWN (tickets whose
   * handoff_source_ticket_id points back) to enumerate every stage across boards.
   * Rejection defect tickets are excluded from the DOWN walk lineage (they point
   * at the source via prerequisite, not handoff_source_ticket_id) so the relay
   * spine stays linear.
   */
  async getPipeline(ticketId: string): Promise<HandoffPipeline> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const start = await ticketRepo.findOne({ where: { id: ticketId } });
    if (!start) throw badRequest('Ticket not found');

    // Walk up to the relay root (bounded by a seen-set against a corrupt cycle).
    let root = start;
    const seenUp = new Set<string>([root.id]);
    while (root.handoff_source_ticket_id) {
      const parent = await ticketRepo.findOne({ where: { id: root.handoff_source_ticket_id } });
      if (!parent || seenUp.has(parent.id)) break;
      seenUp.add(parent.id);
      root = parent;
    }

    // BFS down the lineage: children are tickets whose handoff_source_ticket_id
    // equals a node already in the tree.
    const nodes: Ticket[] = [];
    const seen = new Set<string>();
    const queue: Ticket[] = [root];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      nodes.push(cur);
      const children = await ticketRepo.find({ where: { handoff_source_ticket_id: cur.id } });
      for (const c of children) if (!seen.has(c.id)) queue.push(c);
    }

    const stages: PipelineStage[] = [];
    for (const t of nodes) {
      stages.push(await this._projectStage(t));
    }
    stages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    return { root_ticket_id: root.id, stages };
  }

  private async _projectStage(t: Ticket): Promise<PipelineStage> {
    let boardId = '';
    let boardName = '';
    let columnName = '';
    let isTerminal = false;
    if (t.column_id) {
      const col = await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: t.column_id } });
      if (col) {
        columnName = col.name || '';
        isTerminal = isTerminalColumn(col);
        boardId = col.board_id;
        const board = await this.dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
        boardName = board?.name || '';
      }
    }
    const labels = safeJsonParse<string[]>(t.labels, []);
    return {
      ticket_id: t.id,
      title: t.title,
      board_id: boardId,
      board_name: boardName,
      column_id: t.column_id || null,
      column_name: columnName,
      is_terminal: isTerminal,
      status: t.status,
      is_followup: !!t.handoff_source_ticket_id,
      is_rejection: Array.isArray(labels) && labels.includes(HANDOFF_REJECTION_LABEL),
      source_ticket_id: t.handoff_source_ticket_id || '',
      pending_on_tickets: !!t.pending_on_tickets,
      remaining_hops: parseHandoffSpec(t.handoff_spec).hops.length,
      created_at: t.created_at,
    };
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────

  /** Named column → first non-terminal → first column. */
  private async _resolveColumn(boardId: string, columnName?: string): Promise<BoardColumn | null> {
    if (columnName && columnName.trim()) {
      const byName = await findColumnByName(this.dataSource, boardId, columnName.trim());
      if (byName) return byName;
    }
    const cols = await this.dataSource.getRepository(BoardColumn).find({
      where: { board_id: boardId },
      order: { position: 'ASC' },
    });
    if (cols.length === 0) return null;
    return cols.find((c) => !isTerminalColumn(c)) || cols[0];
  }

  private _buildTitle(hop: HandoffHop, source: Ticket): string {
    const tpl = hop.title_template && hop.title_template.trim() ? hop.title_template : '[핸드오프] {{source_title}}';
    return tpl.replace(/\{\{\s*source_title\s*\}\}/g, source.title);
  }

  private _buildLabels(hop: HandoffHop, marker: string): string[] {
    const base = Array.isArray(hop.labels) && hop.labels.length ? hop.labels.slice() : [];
    if (!base.includes(marker)) base.push(marker);
    return base;
  }

  /**
   * Deep link into the client for a ticket: /ws/<ws>/boards/<board>?ticket=<id>.
   * Board is resolved from the ticket's column; workspace from the ticket.
   */
  private async _ticketDeepLink(ticket: Ticket, boardId: string): Promise<string> {
    const ws = ticket.workspace_id || '';
    if (!ws || !boardId) return `(딥링크 없음 — ws/board 미해결, 티켓 \`${ticket.id}\`)`;
    return `/ws/${ws}/boards/${boardId}?ticket=${ticket.id}`;
  }

  /** The source ticket's most recent non-system comment — the deliverable summary. */
  private async _latestHandoffComment(sourceId: string): Promise<string> {
    const rows = await this.dataSource.getRepository(Comment).find({
      where: { ticket_id: sourceId },
      order: { created_at: 'DESC' },
      take: 20,
    });
    const meaningful = rows.find((c) => c.author_type !== 'system' && (c.content || '').trim());
    return meaningful ? meaningful.content.trim() : '';
  }

  /**
   * Follow-up body: a custom template (with {{source_*}} substitution) followed
   * by an ALWAYS-appended carried-context block (deep link + final handoff
   * comment + carried-attachment note) so the downstream agent never re-discovers
   * the predecessor's deliverable.
   */
  private async _buildFollowupBody(source: Ticket, hop: HandoffHop): Promise<string> {
    const sourceCol = source.column_id
      ? await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: source.column_id } })
      : null;
    const sourceBoardId = sourceCol?.board_id || '';
    const link = await this._ticketDeepLink(source, sourceBoardId);
    const handoffNote = await this._latestHandoffComment(source.id);
    const attachmentNote = (hop.carry_attachments === true || (Array.isArray(hop.carry_attachment_ids) && hop.carry_attachment_ids.length > 0))
      ? '이 티켓에 선행 산출물 첨부가 복사되어 있습니다 (첨부 탭 참조).'
      : '_(반입된 첨부 없음)_';

    const context = [
      `---`,
      `## 🔗 선행 산출물 컨텍스트 (크로스보드 핸드오프)`,
      ``,
      `이 티켓은 선행 보드 작업 완료로 **자동 생성**되었습니다.`,
      ``,
      `- **원본 티켓:** [${source.title}](${link}) (\`${source.id}\`)`,
      `- **최종 handoff 코멘트:**`,
      handoffNote ? this._quote(handoffNote) : '> _(원본 티켓에 요약 코멘트 없음 — 위 딥링크에서 히스토리를 확인하세요)_',
      ``,
      `- **반입 첨부:** ${attachmentNote}`,
      ``,
      `> ℹ️ 선행 산출물을 다시 탐색하지 말고 위 링크·첨부·요약을 그대로 활용하세요. 산출물에 결함이 있으면 \`reject_handoff\` 로 원본 보드에 반려하세요.`,
    ].join('\n');

    const custom = hop.description_template && hop.description_template.trim()
      ? this._applyTemplate(hop.description_template, source, link, handoffNote)
      : '';

    return custom ? `${custom}\n\n${context}` : context;
  }

  private _buildRejectionBody(source: Ticket, followup: Ticket, reason: string): string {
    return [
      `> 🤖 이 티켓은 크로스보드 **역방향 반려**로 자동 생성되었습니다.`,
      ``,
      `## 선행 산출물 결함 반려`,
      ``,
      `후속 보드 작업 티켓이 이 보드의 선행 산출물에서 결함을 발견해 반려했습니다.`,
      ``,
      `- **결함 지적 티켓(후속):** ${followup.title} (\`${followup.id}\`)`,
      `- **원본 산출물 티켓:** ${source.title} (\`${source.id}\`)`,
      ``,
      `### 반려 사유`,
      reason && reason.trim() ? this._quote(reason.trim()) : '> _(사유 미기재)_',
      ``,
      `---`,
      `_이 티켓을 수정 완료(terminal 컬럼)하면 후속 티켓 \`${followup.id}\` 이 자동으로 재개됩니다 (prerequisite auto-resume)._`,
    ].join('\n');
  }

  private _applyTemplate(tpl: string, source: Ticket, link: string, handoffNote: string): string {
    return tpl
      .replace(/\{\{\s*source_title\s*\}\}/g, source.title)
      .replace(/\{\{\s*source_id\s*\}\}/g, source.id)
      .replace(/\{\{\s*source_link\s*\}\}/g, link)
      .replace(/\{\{\s*handoff_note\s*\}\}/g, handoffNote || '')
      .replace(/\{\{\s*attachments\s*\}\}/g, '(첨부 탭 참조)');
  }

  private _quote(text: string): string {
    return text.split('\n').map((l) => `> ${l}`).join('\n');
  }
}

function badRequest(msg: string): Error {
  const e = new Error(msg) as Error & { status: number };
  e.status = 400;
  return e;
}
