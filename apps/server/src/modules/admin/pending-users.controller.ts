import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Param, Body, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { Workspace } from '../../entities/Workspace';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { ReBACService } from '../../services/rebac.service';
import { ActivityService } from '../../services/activity.service';
import { findOrFail } from '../../common/find-or-fail';

@ApiBearerAuth('user-session')
@ApiTags('pending-users')
@Controller('api/admin/pending-users')
@UseGuards(AuthGuard, AdminGuard)
export class PendingUsersController {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
    private readonly rebacService: ReBACService,
    private readonly activityService: ActivityService,
  ) {}

  // Lightweight count for the admin sidebar badge. Separate from GET / so
  // the admin nav can poll/listen without materializing the full user list
  // (which joins to workspaces) every time.
  @Get('count')
  async count(@Res() res: Response) {
    const count = await this.userRepo.count({ where: { status: 'pending' } as any });
    return res.json({ count });
  }

  @Get()
  async list(@Res() res: Response) {
    const users = await this.userRepo.find({ where: { status: 'pending' } as any });

    const result = await Promise.all(users.map(async user => {
      const u = user as any;
      let requested_workspace_name: string | null = null;
      if (u.requested_workspace_id) {
        const ws = await this.workspaceRepo.findOne({ where: { id: u.requested_workspace_id } });
        requested_workspace_name = ws?.name || null;
      }
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        requested_workspace_id: u.requested_workspace_id || null,
        requested_workspace_name,
        created_at: u.created_at,
      };
    }));

    return res.json({ users: result });
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string, @Res() res: Response) {
    const user = await findOrFail(this.userRepo, { where: { id } }, 'User not found');

    if ((user as any).status !== 'pending') {
      return res.status(400).json({ error: 'User is not in pending status' });
    }

    (user as any).status = 'active';
    await this.userRepo.save(user);

    return res.json({ success: true });
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const user = await findOrFail(this.userRepo, { where: { id } }, 'User not found');

    (user as any).status = 'rejected';
    await this.userRepo.save(user);

    return res.json({ success: true });
  }

  @Post(':id/assign')
  async assign(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { workspace_id, relation = 'member' } = body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });

    await findOrFail(this.userRepo, { where: { id } }, 'User not found');
    await findOrFail(this.workspaceRepo, { where: { id: workspace_id } }, 'Workspace not found');

    await this.rebacService.grant(
      { type: 'user', id },
      relation,
      { type: 'workspace', id: workspace_id },
    );

    return res.json({ success: true });
  }
}
