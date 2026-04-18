import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { AuthGuard } from '../../common/guards/auth.guard';
import { DEFAULT_COLUMNS } from '../../database/database.module';
import { ReBACService } from '../../services/rebac.service';
import { findOrFail } from '../../common/find-or-fail';

@Controller('api/workspaces')
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(
    @InjectRepository(Workspace) private readonly wsRepo: Repository<Workspace>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(BoardColumn) private readonly colRepo: Repository<BoardColumn>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly rebacService: ReBACService,
  ) {}

  @Get()
  async list(@Res() res: Response) {
    const workspaces = await this.wsRepo.find({ order: { created_at: 'DESC' } });
    const result = await Promise.all(workspaces.map(async ws => {
      const boardCount = await this.boardRepo.count({ where: { workspace_id: ws.id } });
      return { ...ws, board_count: boardCount };
    }));
    return res.json(result);
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    const { name, description = '', board_name } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const ws = await this.wsRepo.save(this.wsRepo.create({ name, description }));
    const board = await this.boardRepo.save(this.boardRepo.create({
      workspace_id: ws.id, name: board_name?.trim() || `${name} Board`, description: '',
    }));
    const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
    await this.colRepo.save(defaultCols.map(c => this.colRepo.create(c)));

    const result = await this.wsRepo.findOne({ where: { id: ws.id } });
    return res.status(201).json(result);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response) {
    const ws = await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');

    const boards = await this.boardRepo.find({ where: { workspace_id: id }, order: { created_at: 'ASC' } });
    const boardsFull = await Promise.all(boards.map(async board => {
      const columns = await this.colRepo.find({ where: { board_id: board.id }, order: { position: 'ASC' } });
      const colsFull = await Promise.all(columns.map(async col => {
        const tickets = await this.ticketRepo.find({
          where: { column_id: col.id },
          relations: ['children', 'comments'],
          order: { position: 'ASC' },
        });
        return {
          ...col,
          tickets: tickets.map(t => ({
            ...t,
            labels: JSON.parse(t.labels || '[]'),
            channel_ids: JSON.parse(t.channel_ids || '[]'),
            children: (t.children || []).sort((a, b) => a.position - b.position),
            comments: (t.comments || []).sort((a, b) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            ).map(c => ({ ...c, images: JSON.parse(c.images || '[]') })),
          })),
        };
      }));
      return { ...board, columns: colsFull };
    }));

    return res.json({ ...ws, boards: boardsFull });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const ws = await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');

    const { name, description } = body;
    if (name !== undefined) ws.name = name;
    if (description !== undefined) ws.description = description;

    await this.wsRepo.save(ws);
    return res.json(ws);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Res() res: Response) {
    const ws = await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');

    const count = await this.wsRepo.count();
    if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last workspace' });

    await this.wsRepo.delete(ws.id);
    return res.json({ success: true });
  }

  // ─── Workspace Members (ReBAC) ─────────────────────────

  @Get(':id/members')
  async listMembers(@Param('id') id: string, @Res() res: Response) {
    await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');

    const [members, owners] = await Promise.all([
      this.rebacService.listSubjects({ type: 'workspace', id }, 'member'),
      this.rebacService.listSubjects({ type: 'workspace', id }, 'owner'),
    ]);

    const ownerIds = new Set(owners.filter(s => s.type === 'user').map(s => s.id));
    const allUserIds = [...new Set([
      ...members.filter(s => s.type === 'user').map(s => s.id),
      ...ownerIds,
    ])];

    if (allUserIds.length === 0) return res.json([]);

    const users = await this.userRepo.find({ where: { id: In(allUserIds) } });
    const result = users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      status: (u as any).status,
      avatar_url: u.avatar_url,
      relation: ownerIds.has(u.id) ? 'owner' : 'member',
    }));
    return res.json(result);
  }

  @Post(':id/members')
  async addMember(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { user_id, relation = 'member' } = body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!['member', 'owner'].includes(relation)) {
      return res.status(400).json({ error: 'relation must be member or owner' });
    }

    await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');
    await findOrFail(this.userRepo, { where: { id: user_id } }, 'User not found');

    await this.rebacService.grant({ type: 'user', id: user_id }, relation, { type: 'workspace', id });
    return res.status(201).json({ success: true, user_id, relation, workspace_id: id });
  }

  @Patch(':id/members/:userId')
  async updateMemberRole(
    @Param('id') id: string, @Param('userId') userId: string,
    @Body() body: any, @Res() res: Response,
  ) {
    const { relation } = body;
    if (!['member', 'owner'].includes(relation)) {
      return res.status(400).json({ error: 'relation must be member or owner' });
    }
    // Revoke both, then grant the new one
    await this.rebacService.revoke({ type: 'user', id: userId }, 'member', { type: 'workspace', id });
    await this.rebacService.revoke({ type: 'user', id: userId }, 'owner', { type: 'workspace', id });
    await this.rebacService.grant({ type: 'user', id: userId }, relation, { type: 'workspace', id });
    return res.json({ success: true, user_id: userId, relation });
  }

  @Delete(':id/members/:userId')
  async removeMember(@Param('id') id: string, @Param('userId') userId: string, @Res() res: Response) {
    await this.rebacService.revoke({ type: 'user', id: userId }, 'member', { type: 'workspace', id });
    await this.rebacService.revoke({ type: 'user', id: userId }, 'owner', { type: 'workspace', id });
    return res.json({ success: true });
  }

  // ─── Mention autocomplete candidates ───────────────────────
  //
  // Returns the user + agent set the composer's @-dropdown should show for
  // this workspace. When `ticket_id` is supplied, role shortcuts are included
  // only for roles that the ticket has filled — otherwise `@assignee` etc.
  // would resolve to nothing and confuse the user.

  @Get(':id/mention-candidates')
  async mentionCandidates(
    @Param('id') id: string,
    @Query('ticket_id') ticketId: string | undefined,
    @Res() res: Response,
  ) {
    await findOrFail(this.wsRepo, { where: { id } }, 'Workspace not found');

    const [members, owners, agents] = await Promise.all([
      this.rebacService.listSubjects({ type: 'workspace', id }, 'member'),
      this.rebacService.listSubjects({ type: 'workspace', id }, 'owner'),
      this.agentRepo.find({ where: { workspace_id: id, is_active: 1 }, order: { name: 'ASC' } }),
    ]);

    const allUserIds = [...new Set([
      ...members.filter(s => s.type === 'user').map(s => s.id),
      ...owners.filter(s => s.type === 'user').map(s => s.id),
    ])];
    const users = allUserIds.length
      ? (await this.userRepo.find({ where: { id: In(allUserIds) } }))
          .map(u => ({ id: u.id, name: u.name, avatar_url: u.avatar_url }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    const roleShortcuts: Array<{ key: string; label: string; resolved_type: 'agent'; resolved_id: string }> = [];
    if (ticketId) {
      const ticket = await this.ticketRepo.findOne({ where: { id: ticketId } });
      if (ticket) {
        const agentById = new Map(agents.map(a => [a.id, a]));
        const addShortcut = (key: 'assignee' | 'reporter' | 'reviewer', agentId: string) => {
          if (!agentId) return;
          const agent = agentById.get(agentId);
          const label = agent ? `${key} (${agent.name})` : key;
          roleShortcuts.push({ key, label, resolved_type: 'agent', resolved_id: agentId });
        };
        addShortcut('assignee', ticket.assignee_id);
        addShortcut('reporter', ticket.reporter_id);
        addShortcut('reviewer', ticket.reviewer_id);
      }
    }

    return res.json({
      users,
      agents: agents.map(a => ({ id: a.id, name: a.name, avatar_url: a.avatar_url })),
      role_shortcuts: roleShortcuts,
    });
  }
}
