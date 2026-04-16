import { Controller, Get, Post, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { AgentAuthGuard } from '../../common/guards/agent-auth.guard';
import { ChatRoomsService } from '../chat-rooms/chat-rooms.service';
import { activityEvents } from '../../services/activity.service';

async function findColumn(dataSource: DataSource, boardId: string, columnName: string) {
  return dataSource.getRepository(BoardColumn)
    .createQueryBuilder('col')
    .where('col.board_id = :boardId AND LOWER(col.name) = LOWER(:name)', { boardId, name: columnName })
    .getOne();
}

async function maxTicketPosition(ticketRepo: Repository<Ticket>, columnId: string): Promise<number> {
  const result = await ticketRepo
    .createQueryBuilder('t')
    .select('COALESCE(MAX(t.position), -1)', 'max')
    .where('t.column_id = :columnId', { columnId })
    .getRawOne();
  return (result?.max ?? -1) + 1;
}

@Controller('api/agent')
@UseGuards(AgentAuthGuard)
export class AgentApiController {
  constructor(
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectRepository(ChatRoomMessage) private readonly messageRepo: Repository<ChatRoomMessage>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly chatRoomsService: ChatRoomsService,
  ) {}

  @Get('board-summary')
  async boardSummaryDefault(@Res() res: Response) {
    return this.boardSummary('1', res);
  }

  @Get('board-summary/:boardId')
  async boardSummary(@Param('boardId') boardId: string, @Res() res: Response) {
    const id = boardId || '1';
    const board = await this.boardRepo.findOne({ where: { id } });
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const columns = await this.colRepo.find({ where: { board_id: board.id }, order: { position: 'ASC' } });
    const summary = {
      board: board.name,
      description: board.description,
      columns: await Promise.all(columns.map(async col => {
        const tickets = await this.ticketRepo.find({
          where: { column_id: col.id },
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

    const col = await findColumn(this.dataSource, boardId, column);
    if (!col) return res.status(404).json({ error: `Column "${column}" not found` });

    const ticket = await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);

      const position = await maxTicketPosition(tRepo, col.id);
      const t = await tRepo.save(tRepo.create({
        column_id: col.id, title, description, priority, assignee, labels: '[]', position,
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

    const ticket = await this.ticketRepo.findOne({ where: { id: ticketId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const col = await findColumn(this.dataSource, boardId, toColumn);
    if (!col) return res.status(404).json({ error: `Column "${toColumn}" not found` });

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);

      await tRepo.createQueryBuilder().update()
        .set({ position: () => 'position - 1' })
        .where('column_id = :colId AND position > :pos', { colId: ticket.column_id, pos: ticket.position })
        .execute();

      const destCount = await tRepo.createQueryBuilder('t')
        .where('t.column_id = :colId AND t.id != :id', { colId: col.id, id: ticket.id }).getCount();
      const pos = position ?? destCount;

      await tRepo.createQueryBuilder().update()
        .set({ position: () => 'position + 1' })
        .where('column_id = :colId AND position >= :pos AND id != :id', { colId: col.id, pos, id: ticket.id })
        .execute();

      await tRepo.update(ticket.id, { column_id: col.id, position: pos });
    });

    return res.json({ success: true, ticketId, movedTo: toColumn });
  }

  @Post('batch')
  async batch(@Body() body: any, @Res() res: Response) {
    const { operations } = body;
    if (!Array.isArray(operations)) return res.status(400).json({ error: 'operations array is required' });

    const results: any[] = [];

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const cRepo = manager.getRepository(Comment);

      for (const op of operations) {
        try {
          switch (op.action) {
            case 'create-ticket': {
              const col = await findColumn(this.dataSource, String(op.boardId), op.column);
              if (!col) { results.push({ error: `Column "${op.column}" not found` }); continue; }
              const pos = await maxTicketPosition(tRepo, col.id);
              const r = await tRepo.save(tRepo.create({
                column_id: col.id, title: op.title, description: op.description || '',
                priority: op.priority || 'medium', assignee: op.assignee || '', labels: '[]', position: pos,
              }));
              results.push({ success: true, ticketId: r.id });
              break;
            }
            case 'move-ticket': {
              const col = await findColumn(this.dataSource, String(op.boardId), op.toColumn);
              if (!col) { results.push({ error: `Column "${op.toColumn}" not found` }); continue; }
              const t = await tRepo.findOne({ where: { id: String(op.ticketId) } });
              if (!t) { results.push({ error: 'Ticket not found' }); continue; }

              await tRepo.createQueryBuilder().update()
                .set({ position: () => 'position - 1' })
                .where('column_id = :colId AND position > :pos', { colId: t.column_id, pos: t.position }).execute();

              const cnt = await tRepo.createQueryBuilder('t')
                .where('t.column_id = :colId AND t.id != :id', { colId: col.id, id: t.id }).getCount();
              const pos = op.position ?? cnt;

              await tRepo.createQueryBuilder().update()
                .set({ position: () => 'position + 1' })
                .where('column_id = :colId AND position >= :pos AND id != :id', { colId: col.id, pos, id: t.id }).execute();

              await tRepo.update(t.id, { column_id: col.id, position: pos });
              results.push({ success: true, ticketId: op.ticketId, movedTo: op.toColumn });
              break;
            }
            case 'add-child':
            case 'add-subtask': {
              const maxP = await tRepo.createQueryBuilder('t')
                .select('COALESCE(MAX(t.position), -1)', 'max')
                .where('t.parent_id = :parentId', { parentId: String(op.ticketId) }).getRawOne();
              const r = await tRepo.save(tRepo.create({
                parent_id: String(op.ticketId), depth: 1, column_id: null as any,
                title: op.title, position: (maxP?.max ?? -1) + 1, status: 'todo',
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
              await tRepo.update(ticketId, updates);
              results.push({ success: true, ticketId });
              break;
            }
            case 'add-comment': {
              const r = await cRepo.save(cRepo.create({
                ticket_id: String(op.ticketId),
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

  @Post('chat-rooms/:roomId/typing')
  async setChatRoomTyping(@Body() body: any, @Param('roomId') roomId: string, @Res() res: Response) {
    const { agent_id, agent_name, is_typing } = body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    const memberIds = await this.chatRoomsService.getRoomMemberIds(roomId);
    const agentMemberIds = await this.chatRoomsService.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_typing', {
      room_id: roomId,
      agent_id,
      agent_name: agent_name || 'Agent',
      is_typing: is_typing !== false,
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
    return res.json({ ok: true });
  }

  @Get('chat-rooms/:roomId/messages')
  async getChatRoomMessages(@Param('roomId') roomId: string, @Res() res: Response, @Query('limit') limitStr?: string) {
    const limit = Math.min(parseInt(limitStr || '50', 10) || 50, 200);
    const messages = await this.messageRepo
      .createQueryBuilder('m')
      .where('m.room_id = :roomId', { roomId })
      .orderBy('m.created_at', 'DESC')
      .limit(limit)
      .getMany();
    return res.json(messages.reverse());
  }
}
