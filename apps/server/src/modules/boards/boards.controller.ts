import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { AuthGuard } from '../../common/guards/auth.guard';
import { DEFAULT_COLUMNS } from '../../database/database.module';
import { findOrFail } from '../../common/find-or-fail';

@Controller('api/boards')
@UseGuards(AuthGuard)
export class BoardsController {
  constructor(
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
  ) {}

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('include_archived') includeArchived: string,
    @Res() res: Response,
  ) {
    const where: any = {};
    if (workspaceId) where.workspace_id = workspaceId;
    // Exclude archived boards by default; pass ?include_archived=true to see all
    if (includeArchived !== 'true') where.archived_at = IsNull();
    const boards = await this.boardRepo.find({ where, order: { created_at: 'DESC' } });
    return res.json(boards);
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    const { name, description = '', workspace_id } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

    const board = await this.boardRepo.save(this.boardRepo.create({ name, description, workspace_id }));
    const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
    await this.colRepo.save(defaultCols.map(c => this.colRepo.create(c)));

    const result = await this.boardRepo.findOne({ where: { id: board.id } });
    return res.status(201).json(result);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');

    const columns = await this.colRepo.find({ where: { board_id: board.id }, order: { position: 'ASC' } });
    const columnsWithTickets = await Promise.all(
      columns.map(async (col) => {
        const tickets = await this.ticketRepo.find({
          where: { column_id: col.id, parent_id: IsNull() },
          relations: ['children', 'children.children', 'comments'],
          order: { position: 'ASC' },
        });
        return {
          ...col,
          tickets: tickets.map(t => ({
            ...t,
            labels: JSON.parse(t.labels || '[]'),
            channel_ids: JSON.parse(t.channel_ids || '[]'),
            children: (t.children || []).sort((a, b) => a.position - b.position).map(child => ({
              ...child,
              labels: JSON.parse(child.labels || '[]'),
              channel_ids: JSON.parse(child.channel_ids || '[]'),
              children: (child.children || []).sort((a, b) => a.position - b.position),
            })),
            comments: (t.comments || []).sort((a, b) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            ).map(c => ({ ...c, images: JSON.parse(c.images || '[]') })),
          })),
        };
      })
    );

    return res.json({ ...board, columns: columnsWithTickets });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');

    const { name, description, routing_config, column_prompts } = body;
    if (name !== undefined) board.name = name;
    if (description !== undefined) board.description = description;
    if (routing_config !== undefined) board.routing_config = JSON.stringify(routing_config);
    if (column_prompts !== undefined) {
      if (column_prompts === null) {
        board.column_prompts = null;
      } else if (typeof column_prompts === 'object') {
        const cleaned: Record<string, string> = {};
        for (const [colId, tplId] of Object.entries(column_prompts)) {
          if (typeof tplId === 'string' && tplId.length > 0) cleaned[colId] = tplId;
        }
        board.column_prompts = Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned);
      }
    }

    await this.boardRepo.save(board);
    return res.json(board);
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');
    board.archived_at = new Date();
    await this.boardRepo.save(board);
    return res.json(board);
  }

  @Post(':id/restore')
  async restore(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');
    board.archived_at = null;
    await this.boardRepo.save(board);
    return res.json(board);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Res() res: Response) {
    const result = await this.boardRepo.delete(id);
    if (result.affected === 0) return res.status(404).json({ error: 'Board not found' });
    return res.json({ success: true });
  }
}
