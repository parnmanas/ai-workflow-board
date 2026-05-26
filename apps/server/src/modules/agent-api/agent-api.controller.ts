import { ApiTags, ApiSecurity } from '@nestjs/swagger';
import { Controller, Get, Post, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
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
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
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
  TicketArchivedError,
} from '../mcp/shared/archive-helpers';
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
  ) {}

  @Get('tickets/:id')
  async getTicket(@Param('id') id: string, @Res() res: Response) {
    const ticket = await loadTicketFull(this.dataSource, id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    return res.json(ticket);
  }

  @Get('board-summary')
  async boardSummaryDefault(@Res() res: Response) {
    return this.boardSummary('1', res);
  }

  @Get('board-summary/:boardId')
  async boardSummary(@Param('boardId') boardId: string, @Res() res: Response) {
    const id = boardId || '1';
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');

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
  async createTicket(@Body() body: any, @Res() res: Response) {
    const { boardId, column, title, description = '', priority = 'medium', assignee = '', subtasks = [] } = body;
    if (!column || !title) return res.status(400).json({ error: 'column and title are required' });

    const col = await findColumnByName(this.dataSource, boardId, column);
    if (!col) return res.status(404).json({ error: `Column "${column}" not found` });

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

  @Post('move-ticket')
  async moveTicket(@Body() body: any, @Res() res: Response) {
    const { boardId, ticketId, toColumn, position } = body;
    if (!ticketId || !toColumn) return res.status(400).json({ error: 'ticketId and toColumn are required' });

    const ticket = await findOrFail(this.ticketRepo, { where: { id: ticketId } }, 'Ticket not found');
    if (ticket.archived_at) {
      return res.status(409).json({
        error: 'ticket_archived',
        hint: 'Call unarchive first',
        message: new TicketArchivedError(ticket.id).message,
      });
    }

    const col = await findColumnByName(this.dataSource, boardId, toColumn);
    if (!col) return res.status(404).json({ error: `Column "${toColumn}" not found` });

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
  async batch(@Body() body: any, @Res() res: Response) {
    const { operations } = body;
    if (!Array.isArray(operations)) return res.status(400).json({ error: 'operations array is required' });

    const results: any[] = [];

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

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const cRepo = manager.getRepository(Comment);
      const colRepoTx = manager.getRepository(BoardColumn);

      for (const op of operations) {
        try {
          switch (op.action) {
            case 'create-ticket': {
              const col = await findColumnByName(manager, String(op.boardId), op.column);
              if (!col) { results.push({ error: `Column "${op.column}" not found` }); continue; }
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
              if (t.archived_at) { results.push(archivedRejection(t.id)); continue; }

              const sourceColumnId = t.column_id;
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
  async setChatRoomTyping(@Body() body: any, @Param('roomId') roomId: string, @Res() res: Response) {
    const { agent_id, agent_name, is_typing, status } = body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
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
  async sendChatRoomMessage(@Body() body: any, @Param('roomId') roomId: string, @Res() res: Response) {
    const { agent_id, content } = body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
    // Empty content is valid when attachments carry the payload — service
    // enforces the "content OR attachment_ids" rule consistently.
    if ((!content || (typeof content === 'string' && !content.trim())) && attachmentIds.length === 0) {
      return res.status(400).json({ error: 'content or attachment_ids required' });
    }

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
    );
    return res.status(201).json(msg);
  }

  @Get('chat-rooms/:roomId/messages')
  async getChatRoomMessages(@Param('roomId') roomId: string, @Res() res: Response, @Query('limit') limitStr?: string) {
    const limit = Math.min(parseInt(limitStr || '50', 10) || 50, 200);
    const messages = await this.messaging.getMessages(roomId, '', limit, undefined, { observer: true });
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
