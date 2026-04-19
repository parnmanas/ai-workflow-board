import { ApiTags } from '@nestjs/swagger';
import { Controller, Post, Patch, Delete, Body, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BoardColumn } from '../../entities/BoardColumn';
import { AuthGuard } from '../../common/guards/auth.guard';
import { findOrFail } from '../../common/find-or-fail';

@ApiTags('columns')
@Controller('api')
@UseGuards(AuthGuard)
export class ColumnsController {
  constructor(
    @InjectRepository(BoardColumn) private readonly repo: Repository<BoardColumn>,
  ) {}

  @Post('boards/:boardId/columns')
  async create(@Param('boardId') boardId: string, @Body() body: any, @Res() res: Response) {
    const { name, color = '#e2e8f0', description = '' } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const maxResult = await this.repo
      .createQueryBuilder('col')
      .select('COALESCE(MAX(col.position), -1)', 'max')
      .where('col.board_id = :boardId', { boardId })
      .getRawOne();

    const position = (maxResult?.max ?? -1) + 1;
    const column = await this.repo.save(this.repo.create({ board_id: boardId, name, position, color, description }));
    return res.status(201).json(column);
  }

  @Patch('columns/:id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { name, color, position, description, is_terminal } = body;
    const col = await findOrFail(this.repo, { where: { id } }, 'Column not found');

    if (name !== undefined) col.name = name;
    if (color !== undefined) col.color = color;
    if (description !== undefined) col.description = description;
    if (is_terminal !== undefined) col.is_terminal = !!is_terminal;
    await this.repo.save(col);

    if (position !== undefined) {
      const cols = await this.repo.find({ where: { board_id: col.board_id }, order: { position: 'ASC' } });
      const ids = cols.map(c => c.id).filter(cid => cid !== col.id);
      ids.splice(position, 0, col.id);
      await Promise.all(ids.map((cid, idx) => this.repo.update(cid, { position: idx })));
    }

    const updated = await this.repo.findOne({ where: { id: col.id } });
    return res.json(updated);
  }

  @Delete('columns/:id')
  async delete(@Param('id') id: string, @Res() res: Response) {
    const result = await this.repo.delete(id);
    if (result.affected === 0) return res.status(404).json({ error: 'Column not found' });
    return res.json({ success: true });
  }
}
