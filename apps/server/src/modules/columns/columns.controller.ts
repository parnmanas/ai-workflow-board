import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Post, Patch, Delete, Body, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { AuthGuard } from '../../common/guards/auth.guard';
import { findOrFail } from '../../common/find-or-fail';
import { computeRoleRoutingForNewColumn } from '../boards/routing-config.helper';

// Mirrors apps/server/src/modules/mcp/tools/column-tools.ts COLUMN_KIND_VALUES.
// Kept here as a plain string set so the REST surface validates body input
// without dragging in zod for a single check.
const COLUMN_KINDS = new Set(['', 'intake', 'active', 'review', 'merging', 'terminal']);

@ApiBearerAuth('user-session')
@ApiTags('columns')
@Controller('api')
@UseGuards(AuthGuard)
export class ColumnsController {
  constructor(
    @InjectRepository(BoardColumn) private readonly repo: Repository<BoardColumn>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
  ) {}

  @Post('boards/:boardId/columns')
  async create(@Param('boardId') boardId: string, @Body() body: any, @Res() res: Response) {
    const { name, color = '#e2e8f0', description = '', kind, role_routing, is_terminal } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (kind !== undefined && !COLUMN_KINDS.has(kind)) {
      return res.status(400).json({ error: `kind must be one of ${[...COLUMN_KINDS].filter(k => k).join('|')} (or omit)` });
    }

    const maxResult = await this.repo
      .createQueryBuilder('col')
      .select('COALESCE(MAX(col.position), -1)', 'max')
      .where('col.board_id = :boardId', { boardId })
      .getRawOne();
    const position = (maxResult?.max ?? -1) + 1;

    // v0.41 — runtime dispatch reads BoardColumn.role_routing only. A new
    // column created without an explicit slug list still has to inherit
    // from the parent board's routing_config (keyed by lowercased name) or
    // adding e.g. a "Review" column via the admin UI silently disables
    // reviewer triggers on it. computeRoleRoutingForNewColumn returns an
    // empty '[]' for unknown names, matching the schema default.
    let roleRoutingJson: string;
    if (role_routing !== undefined) {
      const slugs = Array.isArray(role_routing)
        ? role_routing.filter((s: unknown): s is string => typeof s === 'string')
        : [];
      roleRoutingJson = JSON.stringify(slugs);
    } else {
      const board = await this.boardRepo.findOne({ where: { id: boardId } });
      roleRoutingJson = board ? computeRoleRoutingForNewColumn(board, name) : '[]';
    }

    let resolvedKind = kind ?? '';
    let resolvedTerminal = !!is_terminal;
    if (kind === 'terminal') {
      if (is_terminal === false) {
        return res.status(400).json({
          error: "kind='terminal' requires is_terminal=true (or omit is_terminal to auto-sync)",
        });
      }
      resolvedTerminal = true;
    } else if (resolvedTerminal && !resolvedKind) {
      resolvedKind = 'terminal';
    }

    const column = await this.repo.save(this.repo.create({
      board_id: boardId,
      name,
      position,
      color,
      description,
      kind: resolvedKind,
      role_routing: roleRoutingJson,
      is_terminal: resolvedTerminal,
    }));
    return res.status(201).json(column);
  }

  @Patch('columns/:id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { name, color, position, description, is_terminal, kind, role_routing } = body;
    const col = await findOrFail(this.repo, { where: { id } }, 'Column not found');

    if (kind !== undefined && !COLUMN_KINDS.has(kind)) {
      return res.status(400).json({ error: `kind must be one of ${[...COLUMN_KINDS].filter(k => k).join('|')} (or omit)` });
    }

    if (name !== undefined) col.name = name;
    if (color !== undefined) col.color = color;
    if (description !== undefined) col.description = description;
    if (role_routing !== undefined) {
      const slugs = Array.isArray(role_routing)
        ? role_routing.filter((s: unknown): s is string => typeof s === 'string')
        : [];
      col.role_routing = JSON.stringify(slugs);
    }

    // is_terminal / kind synchronization — mirrors apps/server/src/modules/mcp/tools/column-tools.ts
    // update_column. Both fields are kept consistent so the runtime dispatch
    // path's "is_terminal=true OR kind='terminal'" check never desyncs.
    if (kind !== undefined && is_terminal !== undefined) {
      const terminalImpliedByKind = kind === 'terminal';
      if (terminalImpliedByKind && !is_terminal) {
        return res.status(400).json({
          error: "kind='terminal' requires is_terminal=true (or omit is_terminal to auto-sync)",
        });
      }
      col.kind = kind;
      col.is_terminal = !!is_terminal;
    } else if (kind !== undefined) {
      col.kind = kind;
      if (kind === 'terminal') col.is_terminal = true;
      else if (col.is_terminal === true) col.is_terminal = false;
    } else if (is_terminal !== undefined) {
      col.is_terminal = !!is_terminal;
      if (is_terminal && !col.kind) col.kind = 'terminal';
      else if (!is_terminal && col.kind === 'terminal') col.kind = '';
    }

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
