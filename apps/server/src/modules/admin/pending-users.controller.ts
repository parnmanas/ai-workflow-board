import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Param, Body, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { findOrFail } from '../../common/find-or-fail';

@ApiBearerAuth('user-session')
@ApiTags('pending-users')
@Controller('api/admin/pending-users')
@UseGuards(AuthGuard, AdminGuard)
export class PendingUsersController {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  // Lightweight count for the admin sidebar badge. Separate from GET / so
  // the admin nav can poll/listen without materializing the full user list
  // (which joins to accounts) every time.
  @Get('count')
  async count(@Res() res: Response) {
    const count = await this.userRepo.count({ where: { status: 'pending' } as any });
    return res.json({ count });
  }

  @Get()
  async list(@Res() res: Response) {
    const users = await this.userRepo.find({ where: { status: 'pending' } as any });

    const result = users.map(user => ({
      id: user.id, name: user.name, email: user.email, status: user.status, created_at: user.created_at,
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

}
