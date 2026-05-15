import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Put, Param, Body, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminGuard } from '../../common/guards/admin.guard';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import {
  ColumnRolePolicy,
  ColumnRolePolicyExpectedAction,
  ColumnRolePolicyOnViolation,
} from '../../entities/ColumnRolePolicy';
import { parseRoleRouting, parseGateLabels } from './column-role-policy.service';

/**
 * Admin surface for ColumnRolePolicy (ticket f886ada7).
 *
 *   - GET /api/admin/column-policies                    → list every board's policies
 *   - GET /api/admin/column-policies/:boardId           → one board's policies + column metadata
 *   - PUT /api/admin/column-policies/:id                → edit a single row
 *
 * AdminGuard enforced. Writes take effect on the next sweep — the
 * detector reads policies fresh each tick, so no server restart needed.
 */
@ApiBearerAuth('user-session')
@ApiTags('admin')
@Controller('api/admin/column-policies')
@UseGuards(AdminGuard)
export class ColumnPoliciesController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async listAll(@Res() res: Response): Promise<Response> {
    const boards = await this.dataSource.getRepository(Board).find();
    const boardSummaries = await Promise.all(
      boards.map(b => this._loadBoardPolicies(b)),
    );
    return res.json({ boards: boardSummaries });
  }

  @Get(':boardId')
  async listOne(@Param('boardId') boardId: string, @Res() res: Response): Promise<Response> {
    if (!boardId) return res.status(400).json({ error: 'board_id is required' });
    const board = await this.dataSource.getRepository(Board).findOne({ where: { id: boardId } });
    if (!board) return res.status(404).json({ error: 'board not found' });
    const summary = await this._loadBoardPolicies(board);
    return res.json(summary);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @Res() res: Response,
  ): Promise<Response> {
    if (!id) return res.status(400).json({ error: 'policy_id is required' });
    const repo = this.dataSource.getRepository(ColumnRolePolicy);
    const row = await repo.findOne({ where: { id } });
    if (!row) return res.status(404).json({ error: 'policy not found' });

    if (body && typeof body === 'object') {
      if (typeof body.enabled === 'boolean') row.enabled = body.enabled;
      if (Number.isFinite(body.max_cycles_without_progress)) {
        // Clamp to [1, 100] — anything lower than 1 is "alert on every
        // cycle" which would spam; anything > 100 is effectively disabled.
        row.max_cycles_without_progress = Math.max(1, Math.min(100, Math.floor(body.max_cycles_without_progress)));
      }
      const violationValues: ColumnRolePolicyOnViolation[] = ['alert', 'auto_move', 'escalate_meta_ticket'];
      if (typeof body.on_violation === 'string' && violationValues.includes(body.on_violation as ColumnRolePolicyOnViolation)) {
        row.on_violation = body.on_violation as ColumnRolePolicyOnViolation;
      }
      const actionValues: ColumnRolePolicyExpectedAction[] = ['move', 'wait_until_label_removed', 'terminal'];
      if (typeof body.expected_action === 'string' && actionValues.includes(body.expected_action as ColumnRolePolicyExpectedAction)) {
        row.expected_action = body.expected_action as ColumnRolePolicyExpectedAction;
      }
      if (typeof body.target_column_id === 'string') {
        row.target_column_id = body.target_column_id;
      }
      if (Array.isArray(body.gate_labels)) {
        const clean = body.gate_labels
          .filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
          .slice(0, 50);
        row.gate_labels = JSON.stringify(clean);
      }
    }

    await repo.save(row);
    return res.json({ success: true, policy: this._shape(row) });
  }

  private async _loadBoardPolicies(board: Board): Promise<any> {
    const cols = await this.dataSource
      .getRepository(BoardColumn)
      .find({ where: { board_id: board.id }, order: { position: 'ASC' } });
    const policies = await this.dataSource
      .getRepository(ColumnRolePolicy)
      .find({ where: { board_id: board.id } });
    const polByColumn = new Map<string, ColumnRolePolicy[]>();
    for (const p of policies) {
      const list = polByColumn.get(p.column_id) ?? [];
      list.push(p);
      polByColumn.set(p.column_id, list);
    }
    const columns = cols.map(c => ({
      id: c.id,
      name: c.name,
      position: c.position,
      kind: c.kind,
      is_terminal: c.is_terminal,
      role_routing: parseRoleRouting(c.role_routing),
      policies: (polByColumn.get(c.id) ?? []).map(p => this._shape(p)),
    }));
    return {
      board_id: board.id,
      board_name: board.name,
      workspace_id: board.workspace_id,
      columns,
    };
  }

  private _shape(p: ColumnRolePolicy): any {
    return {
      id: p.id,
      board_id: p.board_id,
      column_id: p.column_id,
      role_slug: p.role_slug,
      expected_action: p.expected_action,
      target_column_id: p.target_column_id,
      gate_labels: parseGateLabels(p.gate_labels),
      max_cycles_without_progress: p.max_cycles_without_progress,
      on_violation: p.on_violation,
      enabled: p.enabled,
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  }
}
