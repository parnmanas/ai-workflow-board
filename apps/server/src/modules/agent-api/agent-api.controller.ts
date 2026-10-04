import { ApiTags, ApiSecurity } from '@nestjs/swagger';
import { Controller, Get, Post, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, IsNull, MoreThanOrEqual } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { ChatRoom } from '../../entities/ChatRoom';
import { agentIsVisibleInWorkspace } from '../../common/agent-workspace-scope';
import { resolveCallerIdentityRow } from '../mcp/shared/authz';
import { ApiKey } from '../../entities/ApiKey';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { ActivityLog } from '../../entities/ActivityLog';
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
import { loadTicketFull } from '../mcp/shared/ticket-parsing';
import { getRootArchivedAt, TicketArchivedError } from '../mcp/shared/archive-helpers';
import { TicketService, normalizeTags } from '../tickets/ticket.service';
import { Project } from '../../entities/Project';
import { findOrFail } from '../../common/find-or-fail';
import { resolveAgentDisplayName } from '../../utils/agent-name';
import { lockTicketCommentWrites } from '../../common/ticket-comment-write-lock';
import { setChatRoomSessionStatus } from './chat-session-status.store';
import { createHash } from 'node:crypto';

@ApiSecurity('agent-api-key')
@ApiTags('agent-api')
@Controller('api/agent')
@UseGuards(AgentAuthGuard)
export class AgentApiController {
  constructor(
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly membership: RoomMembershipService,
    private readonly messaging: RoomMessagingService,
    private readonly logService: LogService,
    private readonly activityService: ActivityService,
    private readonly tickets: TicketService,
  ) {}

  @Post('tickets/:id/mention-audit-runs/start')
  async startMentionAuditRun(
    @Param('id') ticketId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ticket = await this.ticketRepo.findOne({ where: { id: ticketId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const workspaceId = await this.resolveTicketWorkspaceId(this.dataSource, ticketId);
    if (this.scopeRejects(req, workspaceId)) return this.denyScope(res);
    const triggerId = typeof body?.cycle_trigger_id === 'string' ? body.cycle_trigger_id : '';
    const agentId = typeof body?.agent_id === 'string' ? body.agent_id : '';
    const attempt = Number(body?.attempt ?? 0);
    if (!triggerId.startsWith('mention:') || !agentId || ![0, 1].includes(attempt)) {
      return res.status(400).json({ error: 'invalid mention audit run' });
    }
    // P4c-4: Agent 행 대신 Host/링크 해소.
    const agent = await resolveCallerIdentityRow(this.dataSource, agentId);
    if (!workspaceId || !agent || !agentIsVisibleInWorkspace(agent.workspace_id, workspaceId)) {
      return res.status(400).json({ error: 'agent does not belong to ticket workspace' });
    }
    const familyKey = `${triggerId}:${agentId}`;
    const marker = await this.dataSource.transaction(async (manager) => {
      await lockTicketCommentWrites(manager, ticketId);
      const repo = manager.getRepository(ActivityLog);
      const existing = await repo.findOne({
        where: {
          ticket_id: ticketId,
          action: 'mention_audit_started',
          field_changed: familyKey,
          old_value: String(attempt),
        },
      });
      if (existing) return existing;
      return repo.save(repo.create({
        workspace_id: workspaceId || '',
        entity_type: 'ticket',
        entity_id: ticketId,
        ticket_id: ticketId,
        action: 'mention_audit_started',
        field_changed: familyKey,
        old_value: String(attempt),
        new_value: typeof body?.subagent_session_id === 'string' ? body.subagent_session_id : '',
        actor_id: agentId,
        actor_name: 'agent-manager',
        role: typeof body?.role === 'string' ? body.role : '',
        trigger_source: triggerId,
      }));
    });
    return res.json({
      run_token: marker.id,
      family_key: familyKey,
      attempt,
      baseline_at: marker.created_at,
    });
  }

  @Post('tickets/:id/mention-audit-runs/:runToken/complete')
  async completeMentionAuditRun(
    @Param('id') ticketId: string,
    @Param('runToken') runToken: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const workspaceId = await this.resolveTicketWorkspaceId(this.dataSource, ticketId);
    if (this.scopeRejects(req, workspaceId)) return this.denyScope(res);
    const outcome = await this.dataSource.transaction(async (manager) => {
      await lockTicketCommentWrites(manager, ticketId);
      const activityRepo = manager.getRepository(ActivityLog);
      const commentRepo = manager.getRepository(Comment);
      const marker = await activityRepo.findOne({
        where: { id: runToken, ticket_id: ticketId, action: 'mention_audit_started' },
      });
      if (!marker) return null;
      const attempt = Number(marker.old_value);
      const terminal = await activityRepo.findOne({
        where: {
          ticket_id: ticketId,
          action: 'mention_audit_completed',
          field_changed: marker.field_changed,
          old_value: String(attempt),
        },
      });
      if (terminal) {
        const replay = JSON.parse(terminal.new_value);
        return replay.decision === 'retry'
          ? { ...replay, decision: 'retry_claimed', run_token: undefined }
          : replay;
      }

      const comments = await commentRepo.find({
        where: {
          ticket_id: ticketId,
          author_type: 'agent',
          author_id: marker.actor_id,
        },
      });
      const auditCommentCount = comments.filter((comment) => {
        if (!['note', 'question', 'answer', 'decision', 'chat', 'handoff'].includes(comment.type)) return false;
        const metadata = this.safeParseMetadata(comment.metadata);
        return metadata.run_provenance === marker.id;
      }).length;
      const activities = await activityRepo.find({
        where: {
          ticket_id: ticketId,
          actor_id: marker.actor_id,
        },
      });
      const mutationActions = new Set([
        'created', 'updated', 'moved', 'deleted', 'archived', 'restored',
        'attachment_added', 'attachment_deleted',
      ]);
      const mutationEntities = new Set(['ticket', 'child_ticket', 'ticket_attachment']);
      const entityChangeCount = activities.filter((row) =>
        mutationActions.has(row.action) &&
        mutationEntities.has(row.entity_type) &&
        row.id !== marker.id &&
        row.trigger_source === marker.id
      ).length;
      const silent = Number(body?.exit_code) === 0 && auditCommentCount === 0 && entityChangeCount === 0;
      let result: any = { decision: 'succeeded', attempt, audit_comment_count: auditCommentCount, entity_change_count: entityChangeCount };
      if (silent && attempt === 0) {
        const claimed = await activityRepo.findOne({
          where: { ticket_id: ticketId, action: 'silent_exit_retry_claimed', field_changed: marker.field_changed },
        });
        result = {
          decision: claimed ? 'retry_claimed' : 'retry',
          attempt: 1,
          run_token: claimed ? undefined : marker.id,
          audit_comment_count: 0,
          entity_change_count: 0,
        };
        if (!claimed) {
          await activityRepo.save(activityRepo.create({
            workspace_id: marker.workspace_id,
            entity_type: 'ticket',
            entity_id: ticketId,
            ticket_id: ticketId,
            action: 'silent_exit_retry_claimed',
            field_changed: marker.field_changed,
            old_value: '0',
            new_value: '1',
            actor_id: marker.actor_id,
            actor_name: 'agent-manager',
            role: marker.role,
            trigger_source: marker.trigger_source,
          }));
        }
      } else if (silent) {
        result = { decision: 'failed', attempt: 1, reason: 'silent_exit_retry_exhausted', audit_comment_count: 0, entity_change_count: 0 };
      }
      await activityRepo.save(activityRepo.create({
        workspace_id: marker.workspace_id,
        entity_type: 'ticket',
        entity_id: ticketId,
        ticket_id: ticketId,
        action: 'mention_audit_completed',
        field_changed: marker.field_changed,
        old_value: String(attempt),
        new_value: JSON.stringify(result),
        actor_id: marker.actor_id,
        actor_name: 'agent-manager',
        role: marker.role,
        trigger_source: marker.trigger_source,
      }));
      return result;
    });
    if (!outcome) return res.status(404).json({ error: 'mention audit run not found' });
    return res.json(outcome);
  }

  @Post('tickets/:id/mention-audit-runs/:runToken/retry-spawn-failed')
  async failMentionAuditRetrySpawn(
    @Param('id') ticketId: string,
    @Param('runToken') runToken: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const workspaceId = await this.resolveTicketWorkspaceId(this.dataSource, ticketId);
    if (this.scopeRejects(req, workspaceId)) return this.denyScope(res);
    const outcome = await this.dataSource.transaction(async (manager) => {
      await lockTicketCommentWrites(manager, ticketId);
      const repo = manager.getRepository(ActivityLog);
      const marker = await repo.findOne({
        where: { id: runToken, ticket_id: ticketId, action: 'mention_audit_started', old_value: '0' },
      });
      if (!marker) return null;
      const existing = await repo.findOne({
        where: {
          ticket_id: ticketId,
          action: 'mention_audit_retry_spawn_failed',
          field_changed: marker.field_changed,
        },
      });
      if (!existing) {
        await repo.save(repo.create({
          workspace_id: marker.workspace_id,
          entity_type: 'ticket',
          entity_id: ticketId,
          ticket_id: ticketId,
          action: 'mention_audit_retry_spawn_failed',
          field_changed: marker.field_changed,
          old_value: '1',
          new_value: 'silent_exit_retry_spawn_failed',
          actor_id: marker.actor_id,
          actor_name: 'agent-manager',
          role: marker.role,
          trigger_source: marker.id,
        }));
      }
      return {
        decision: 'failed',
        attempt: 1,
        reason: 'silent_exit_retry_spawn_failed',
        family_key: marker.field_changed,
      };
    });
    if (!outcome) return res.status(404).json({ error: 'mention audit run not found' });
    return res.json(outcome);
  }

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

  // Resolve the owning workspace for a ticket id, climbing child → root (the
  // root row is authoritative for workspace membership).
  private async resolveTicketWorkspaceId(
    db: DataSource | EntityManager,
    ticketId: string,
  ): Promise<string | null> {
    const tRepo = db.getRepository(Ticket);
    let t = await tRepo.findOne({ where: { id: ticketId } });
    let guard = 0;
    while (t && t.parent_id && guard++ < 20) {
      t = await tRepo.findOne({ where: { id: t.parent_id } });
    }
    return t?.workspace_id || null;
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
    const agentId = typeof body?.agent_id === 'string' ? body.agent_id : '';
    const subagentSessionId = typeof body?.subagent_session_id === 'string'
      ? body.subagent_session_id
      : '';
    const cycleStartedAt = new Date(body?.cycle_started_at || 0);

    const metadata = {
      reason: 'silent_exit',
      exit_code: exitCode,
      cycle_trigger_id: cycleTriggerId || null,
      author_role: role || null,
      attempt: Number.isFinite(Number(body?.silent_exit_attempt)) ? Number(body.silent_exit_attempt) : null,
      terminal_reason: typeof body?.terminal_reason === 'string' ? body.terminal_reason : null,
    };

    const outcome = await this.dataSource.transaction(async (manager) => {
      // This ticket-row lock is shared by MCP agent-comment writes. Re-read
      // comments only after acquiring it, then create/dedupe the warning in the
      // same transaction. Thus a comment writer either commits before this
      // authoritative read (and suppresses the warning), or starts after the
      // warning transaction has linearized; there is no SELECT->INSERT gap.
      await lockTicketCommentWrites(manager, ticketId);
      const commentRepo = manager.getRepository(Comment);

    // The manager deliberately waits a short grace before calling this
    // endpoint. Re-check the authoritative rows here, immediately before the
    // conditional warning write, so a comment whose MCP response/output drain
    // raced the child exit suppresses both the warning and breaker accounting.
    // Exact trigger provenance wins. Persistent sessions cannot change their
    // MCP headers between turns, so comments without a trigger id use the
    // narrower session + dispatch-window fallback.
    if (agentId && role && Number.isFinite(cycleStartedAt.getTime())) {
      const candidates = await commentRepo.find({
        where: {
          ticket_id: ticketId,
          author_type: 'agent',
          author_id: agentId,
          created_at: MoreThanOrEqual(cycleStartedAt),
        },
        order: { created_at: 'DESC' },
        take: 50,
      });
      const persisted = candidates.find((candidate) => {
        const candidateMetadata = this.safeParseMetadata(candidate.metadata);
        if (candidateMetadata.author_role !== role) return false;
        const candidateTrigger = typeof candidateMetadata.cycle_trigger_id === 'string'
          ? candidateMetadata.cycle_trigger_id
          : '';
        if (cycleTriggerId && candidateTrigger === cycleTriggerId) return true;
        if (candidateTrigger) return false;
        return !!subagentSessionId &&
          candidateMetadata.subagent_session_id === subagentSessionId;
      });
      if (persisted) {
        this.logService.info(
          'AgentApi',
          `Silent-exit suppressed by persisted cycle comment: ticket=${ticketId.slice(0, 8)} comment=${persisted.id.slice(0, 8)}`,
          { ticket_id: ticketId, comment_id: persisted.id, cycle_trigger_id: cycleTriggerId },
        );
        return { status: 200, body: { suppressed: true, comment_id: persisted.id } };
      }
    }

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
      return { status: 200, body: refreshed };
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
    return { status: 201, body: comment };
    });
    // Do not expose success until the transaction has committed. In
    // PostgreSQL, writing the HTTP response inside the callback lets a caller
    // immediately recheck on another connection before the warning/comment is
    // durable, recreating the persistence-vs-exit ordering race.
    return res.status(outcome.status).json(outcome.body);
  }

  private safeParseMetadata(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
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
    const dedupeKey = String(body.dedupe_key);
    const recurrenceKey = createHash('sha256').update(
      `${dedupeKey}\n${String(body.room_id || '')}\n${String(body.message_id || '')}`,
    ).digest('hex');
    const recordRecurrence = async (ticketId: string) => {
      // INSERT .. ON CONFLICT DO NOTHING is the retry policy: the exact same
      // source message is stored once, while distinct room/message recurrences
      // each remain traceable.
      await this.dataSource.getRepository(Comment).createQueryBuilder().insert().values({
        ticket_id: ticketId,
        author_type: 'system', author: 'Agent Manager', type: 'system',
        content: `반복 운영 요청 감지: room=${body.room_id || ''} message=${body.message_id || ''}`,
        operational_recurrence_key: recurrenceKey,
      }).orIgnore().execute();
    };
    const existingOpen = () => this.ticketRepo.findOne({ where: { operational_dedupe_key: dedupeKey, archived_at: IsNull() } });
    const found = await existingOpen();
    if (found) {
      await recordRecurrence(found.id);
      return res.status(200).json({ id: found.id, title: found.title, reused: true });
    }
    try {
      const { ticket } = await this.tickets.create(workspaceId, {
        title: `[운영 자동화] ${String(body.operation).slice(0, 120)}용 MCP/Action capability 추가`,
        description: `원 요청: ${body.original_request || body.operation}\n정규화 operation: ${body.operation}\n누락 capability: ${body.missing_capability}\nsource room/message: ${body.room_id || ''}/${body.message_id || ''}\n\nAction 검색 후에도 실행 수단이 없었습니다. capability 구현 후 원 대화에 결과를 회신하고, 안전·권한 조건을 포함한 idempotent Action으로 등록합니다.`,
        tags: ['automation', 'mcp', 'mcp-missing', 'source:chat'],
        status: 'backlog',
        operational_dedupe_key: dedupeKey,
      }, { id: '', name: 'Agent Manager', type: 'system' });
      return res.status(201).json({ id: ticket.id, title: ticket.title, reused: false });
    } catch (error: any) {
      // A racing request won the unique key: reuse its open row.
      const existing = await existingOpen();
      if (existing) {
        await recordRecurrence(existing.id);
        return res.status(200).json({ id: existing.id, title: existing.title, reused: true });
      }
      return res.status(503).json({ error: 'operational_fallback_failed', message: error?.message || String(error) });
    }
  }

  /** non-native 채팅 런타임이 일반 작업을 티켓으로 한 번만 승격한다(docs/tickets.md). */
  @Post('ordinary-work-ticket')
  async ordinaryWorkTicket(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const scope = this.requestScope(req);
    const workspaceId = String(body.workspace_id || scope || '');
    const roomId = String(body.room_id || '');
    const messageId = String(body.message_id || '');
    const dedupeKey = `ordinary:${String(body.dedupe_key || '')}`;
    if (!workspaceId || !roomId || !messageId || !body.title || dedupeKey === 'ordinary:') {
      return res.status(400).json({ error: 'workspace_id, room_id, message_id, dedupe_key and title are required' });
    }
    if (scope && scope !== workspaceId) return this.denyScope(res);
    const projectId = body.project_id ? String(body.project_id) : '';
    if (projectId) {
      const project = await this.dataSource.getRepository(Project).findOne({ where: { id: projectId } });
      if (!project || project.workspace_id !== workspaceId) return res.status(404).json({ error: 'project not found in this workspace' });
    }
    const existingOpen = () => this.ticketRepo.findOne({ where: { operational_dedupe_key: dedupeKey, archived_at: IsNull() } });
    const reply = (ticket: Ticket, reused: boolean) => res.status(reused ? 200 : 201).json({
      id: ticket.id, title: ticket.title, source_chat_room_id: ticket.source_chat_room_id, reused,
    });
    const found = await existingOpen();
    if (found) return reply(found, true);
    try {
      const { ticket } = await this.tickets.create(workspaceId, {
        title: String(body.title).trim().slice(0, 200),
        description: String(body.description || body.original_request || '').trim(),
        tags: normalizeTags([...(Array.isArray(body.tags) ? body.tags : []), 'source:chat']),
        project_id: projectId || undefined,
        status: 'todo',
        source_kind: 'chat',
        source_chat_room_id: roomId,
        operational_dedupe_key: dedupeKey,
      }, { id: '', name: 'Agent Manager', type: 'system' });
      return reply(ticket, false);
    } catch (error: any) {
      const existing = await existingOpen();
      if (existing) return reply(existing, true);
      return res.status(503).json({ error: 'ordinary_work_fallback_failed', message: error?.message || String(error) });
    }
  }

  /** agent-manager가 non-native 프롬프트에 주입할 현재 workspace의 project · 자주 쓰는 tag 후보. */
  @Get('ordinary-work-candidates')
  async ordinaryWorkCandidates(@Req() req: Request, @Res() res: Response) {
    const scope = this.requestScope(req);
    const workspaceId = String(req.query.workspace_id || scope || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace scope is required' });
    if (scope && scope !== workspaceId) return this.denyScope(res);
    const projects = await this.dataSource.getRepository(Project).find({
      where: { workspace_id: workspaceId },
      order: { name: 'ASC' },
    });
    const tags = await this.tickets.tagSuggestions(workspaceId);
    return res.json({
      projects: projects.map((p) => ({ id: p.id, name: p.name, repo_url: p.repo_url })),
      tags: tags.slice(0, 50),
    });
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
    // P4c-4: presence ping — agent_id 자리는 Host id 다 (Agent 행 없음).
    // Host 행을 보장 + last_seen 갱신 후 ok. 구 Agent 바인딩 ping 은 404
    // (재페어링 안내) — Agent 행 재생성은 하지 않는다.
    const { agent_id } = body || {};
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    const hostRepo = this.dataSource.getRepository(RuntimeHost);
    let host = await hostRepo.findOne({ where: { id: agent_id } });
    if (!host) {
      const apiKey = (req as any).apiKey;
      const keyHostId = typeof apiKey?.host_id === 'string' && apiKey.host_id ? apiKey.host_id : null;
      if (keyHostId && agent_id === keyHostId) {
        try {
          host = await hostRepo.save(hostRepo.create({
            id: keyHostId,
            name: 'awb-agent-manager',
            hostname: 'unknown',
            workspace_id: apiKey?.workspace_id ?? null,
            is_active: 1,
          }));
          this.logService.warn(
            'AgentApi',
            `Recreated missing RuntimeHost id=${keyHostId.slice(0, 8)} from ping self-heal`,
            { host_id: keyHostId, via: 'ping self-heal' },
          );
        } catch (err: any) {
          this.logService.error(
            'AgentApi',
            `Ping host self-heal save failed for host_id=${keyHostId.slice(0, 8)}: ${err?.message ?? String(err)}`,
            { err: err?.message ?? String(err), host_id: keyHostId, stack: err?.stack },
          );
          return res.status(500).json({ error: 'Ping self-heal failed', detail: err?.message ?? String(err) });
        }
      } else {
        return res.status(404).json({
          error: 'Agent not found — re-pair this Runtime Host (Agent identities were removed in P4c-4)',
        });
      }
    }
    const now = new Date();
    try {
      await hostRepo.update({ id: host!.id }, { last_seen_at: now });
    } catch { /* best-effort */ }
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
      (await resolveAgentDisplayName(this.dataSource, agent_id))
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

  @Post('chat-rooms/:roomId/session-status')
  async setChatRoomSessionStatus(@Body() body: any, @Param('roomId') roomId: string, @Req() req: Request, @Res() res: Response) {
    const { agent_id, keep_alive_until_ms, background_task_count } = body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    if (this.scopeRejects(req, await this.resolveRoomWorkspaceId(roomId))) return this.denyScope(res);
    // Same display-name resolution as setChatRoomTyping — the badge must be
    // attributed to the responding agent's resolved `<Manager>/<Agent>` name.
    const resolvedName =
      (await resolveAgentDisplayName(this.dataSource, agent_id)) || 'Agent';
    const memberIds = await this.membership.getRoomMemberIds(roomId);
    const agentMemberIds = await this.membership.getRoomAgentMemberIds(roomId);
    const resolvedKeepAliveUntilMs = typeof keep_alive_until_ms === 'number' ? keep_alive_until_ms : null;
    const resolvedBackgroundTaskCount = Number.isFinite(background_task_count) ? Math.max(0, background_task_count) : 0;
    // Cache the last-known status so a client that opens/re-enters this room
    // between SSE pushes can ask for the current snapshot instead of waiting
    // for the next progress recheck (ticket e18be8ff review round 1, P1 #2).
    setChatRoomSessionStatus(roomId, {
      agent_id,
      agent_name: resolvedName,
      keep_alive_until_ms: resolvedKeepAliveUntilMs,
      background_task_count: resolvedBackgroundTaskCount,
    });
    activityEvents.emit('chat_room_session_status', {
      room_id: roomId,
      agent_id,
      agent_name: resolvedName,
      keep_alive_until_ms: resolvedKeepAliveUntilMs,
      background_task_count: resolvedBackgroundTaskCount,
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
      this.dataSource,
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
