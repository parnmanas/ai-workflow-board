import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, IsNull, DataSource } from 'typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { AuthGuard } from '../../common/guards/auth.guard';
import { DEFAULT_COLUMNS } from '../../database/database.module';
import { DEFAULT_BOARD_ROUTING } from '../../db';
import { PromptTemplatesService } from '../prompt-templates/prompt-templates.service';
import { Agent } from '../../entities/Agent';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { findOrFail } from '../../common/find-or-fail';
import { parseComments, expandCommentAttachments } from '../mcp/shared/ticket-parsing';
import { writeRoutingConfigThrough } from './routing-config.helper';
import { AgentWorkloadService } from '../agents/agent-workload.service';

@ApiBearerAuth('user-session')
@ApiTags('boards')
@Controller('api/boards')
@UseGuards(AuthGuard)
export class BoardsController {
  constructor(
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly promptTemplatesService: PromptTemplatesService,
    private readonly agentWorkload: AgentWorkloadService,
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

    const board = await this.boardRepo.save(this.boardRepo.create({
      name, description, workspace_id,
      routing_config: JSON.stringify(DEFAULT_BOARD_ROUTING),
    }));
    const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
    const savedCols = await this.colRepo.save(defaultCols.map(c => this.colRepo.create(c)));
    // v0.41 — propagate the just-written routing_config into per-column
    // role_routing so runtime dispatch reads slugs from the column rows.
    await writeRoutingConfigThrough(this.dataSource, board.id);

    // Auto-link each new column to its matching default workflow template.
    // seedDefaults is idempotent — existing workspaces (where the templates
    // were minted at workspace-create time or via the backfill migration)
    // get a no-op insert and the existing rows back.
    await this.promptTemplatesService.seedDefaults(workspace_id);
    const colPrompts = await this.promptTemplatesService.computeDefaultColumnPrompts(
      workspace_id,
      savedCols.map(c => ({ id: c.id, name: c.name })),
    );
    if (Object.keys(colPrompts).length > 0) {
      await this.boardRepo.update({ id: board.id }, { column_prompts: JSON.stringify(colPrompts) });
    }

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
            comments: parseComments(t.comments),
          })),
        };
      })
    );

    const allComments: any[] = [];
    for (const col of columnsWithTickets) for (const t of col.tickets) allComments.push(...t.comments);
    await expandCommentAttachments(this.dataSource, allComments);

    return res.json({ ...board, columns: columnsWithTickets });
  }

  /**
   * GET /api/boards/:id/focus-tickets
   *
   * Returns the current focus ticket for each (agent, role) pair on this
   * board. Used by the board UI to display which ticket is the active focus
   * for each agent role, and which tickets are being skipped because another
   * ticket holds focus (ticket b55e4421).
   *
   * Response shape:
   *   { focus_tickets: Array<{ agent_id: string; agent_name: string; role: string; ticket_id: string }> }
   */
  @Get(':id/focus-tickets')
  async getFocusTickets(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');

    // Find all unique (agent_id, role_slug) pairs that have tickets on this board.
    const assignRepo = this.dataSource.getRepository(TicketRoleAssignment);
    const roleRepo = this.dataSource.getRepository(WorkspaceRole);
    const columns = await this.colRepo.find({ where: { board_id: board.id } });
    const colIds = columns.map(c => c.id);
    if (colIds.length === 0) return res.json({ focus_tickets: [] });

    // Find all tickets on this board's columns.
    const tickets = await this.ticketRepo
      .createQueryBuilder('t')
      .where('t.column_id IN (:...colIds)', { colIds })
      .getMany();
    if (tickets.length === 0) return res.json({ focus_tickets: [] });

    const ticketIds = tickets.map(t => t.id);
    const assignments = await assignRepo
      .createQueryBuilder('ra')
      .where('ra.ticket_id IN (:...ids)', { ids: ticketIds })
      .getMany();

    // Dedupe (agent_id, role_id) pairs.
    const seen = new Set<string>();
    const pairs: Array<{ agent_id: string; role_id: string }> = [];
    for (const a of assignments) {
      if (!a.agent_id) continue;
      const key = `${a.agent_id}|${a.role_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ agent_id: a.agent_id, role_id: a.role_id });
    }

    // Resolve role slugs and agent names.
    const roles = await roleRepo.find({ where: { workspace_id: board.workspace_id } });
    const roleById = new Map(roles.map(r => [r.id, r]));

    const agentRepo = this.dataSource.getRepository(Agent);
    const agentIds = Array.from(new Set(pairs.map(p => p.agent_id)));
    const agents = agentIds.length > 0
      ? await agentRepo.createQueryBuilder('a').where('a.id IN (:...ids)', { ids: agentIds }).getMany()
      : [];
    const agentById = new Map(agents.map(a => [a.id, a]));

    // Compute focus for each (agent, role) pair.
    const focusTickets: Array<{ agent_id: string; agent_name: string; role: string; ticket_id: string }> = [];
    for (const { agent_id, role_id } of pairs) {
      const role = roleById.get(role_id);
      if (!role) continue;
      const focusTicketId = await this.agentWorkload.getFocusTicket(agent_id, board.id, role.slug);
      if (focusTicketId) {
        const agent = agentById.get(agent_id);
        focusTickets.push({
          agent_id,
          agent_name: agent?.name ?? agent_id,
          role: role.slug,
          ticket_id: focusTicketId,
        });
      }
    }

    return res.json({ focus_tickets: focusTickets });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');

    const { name, description, routing_config, column_prompts, max_concurrent_tickets_per_agent } = body;
    if (name !== undefined) board.name = name;
    if (description !== undefined) board.description = description;
    const routingChanged = routing_config !== undefined;
    if (routingChanged) board.routing_config = JSON.stringify(routing_config);
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
    if (max_concurrent_tickets_per_agent !== undefined) {
      const n = Math.floor(Number(max_concurrent_tickets_per_agent));
      if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({
          error: 'max_concurrent_tickets_per_agent must be a positive integer (>= 1)',
        });
      }
      board.max_concurrent_tickets_per_agent = n;
    }

    await this.boardRepo.save(board);
    // v0.41 — fan routing_config edits through to per-column role_routing.
    // Done after the board save so the propagation reads the latest blob.
    if (routingChanged) {
      await writeRoutingConfigThrough(this.dataSource, board.id);
    }
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

  // Pause: idempotent — repeat calls just refresh paused_at to "now". Cheaper
  // than a 409 / no-op detour and keeps the audit trail (updated_at) honest
  // about who hit the button last.
  @Post(':id/pause')
  async pause(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');
    board.paused_at = new Date();
    await this.boardRepo.save(board);
    return res.json(board);
  }

  @Post(':id/resume')
  async resume(@Param('id') id: string, @Res() res: Response) {
    const board = await findOrFail(this.boardRepo, { where: { id } }, 'Board not found');
    board.paused_at = null;
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
