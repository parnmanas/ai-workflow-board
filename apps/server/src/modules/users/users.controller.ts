import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User } from '../../entities/User';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { resolvePermissions } from '../../common/types/permissions';
import { AuthService } from '../../services/auth.service';
import { ReBACService } from '../../services/rebac.service';
import { findOrFail } from '../../common/find-or-fail';

@Controller('api/users')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_USERS)
export class UsersController {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly authService: AuthService,
    private readonly rebacService: ReBACService,
  ) {}

  @Get()
  async list(@Query('workspace_id') workspaceId: string, @Res() res: Response) {
    let users: User[];

    if (workspaceId) {
      // Workspace-scoped: get members via ReBAC tuples
      const [members, owners] = await Promise.all([
        this.rebacService.listSubjects({ type: 'workspace', id: workspaceId }, 'member'),
        this.rebacService.listSubjects({ type: 'workspace', id: workspaceId }, 'owner'),
      ]);
      const userIds = [...new Set(
        [...members, ...owners].filter(s => s.type === 'user').map(s => s.id),
      )];
      users = userIds.length > 0
        ? await this.userRepo.find({ where: { id: In(userIds) }, order: { name: 'ASC' } })
        : [];
    } else {
      // Global: all users (admin view)
      users = await this.userRepo.find({ order: { name: 'ASC' } });
    }

    const enriched = users.map(u => {
      const customPerms = u.permissions ? JSON.parse(u.permissions || '[]') : [];
      return { ...u, resolved_permissions: resolvePermissions(u.role, customPerms) };
    });
    return res.json(enriched);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response) {
    const user = await findOrFail(this.userRepo, { where: { id } }, 'User not found');
    const customPerms = user.permissions ? JSON.parse(user.permissions || '[]') : [];
    return res.json({ ...user, resolved_permissions: resolvePermissions(user.role, customPerms) });
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    const { name, email = '', avatar_url = '', role = 'user', discord_user_id = '', password, permissions = [] } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const userData: any = { name, email, avatar_url, role, discord_user_id };
    if (password && password.length > 0) {
      userData.password_hash = await this.authService.hashPassword(password);
    }
    if (Array.isArray(permissions)) {
      userData.permissions = JSON.stringify(permissions);
    }

    const created = this.userRepo.create(userData);
    const saved: User = (await this.userRepo.save(created as any)) as any;
    const { password_hash: _ph, ...safeUser } = saved as any;
    const customPerms = saved.permissions ? JSON.parse(saved.permissions || '[]') : [];
    return res.status(201).json({ ...safeUser, resolved_permissions: resolvePermissions(saved.role, customPerms) });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const user = await findOrFail(this.userRepo, { where: { id } }, 'User not found');

    const { name, email, avatar_url, role, status, discord_user_id, password, permissions } = body;
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    if (avatar_url !== undefined) user.avatar_url = avatar_url;
    if (role !== undefined) user.role = role;
    if (status !== undefined) (user as any).status = status;
    if (discord_user_id !== undefined) user.discord_user_id = discord_user_id;
    if (password && password.length > 0) {
      (user as any).password_hash = await this.authService.hashPassword(password);
    }
    if (permissions !== undefined) {
      user.permissions = JSON.stringify(Array.isArray(permissions) ? permissions : []);
    }

    const updated = await this.userRepo.save(user);
    const { password_hash, ...safeUser } = updated as any;
    const customPerms = updated.permissions ? JSON.parse(updated.permissions || '[]') : [];
    return res.json({ ...safeUser, resolved_permissions: resolvePermissions(updated.role, customPerms) });
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Res() res: Response) {
    const user = await findOrFail(this.userRepo, { where: { id } }, 'User not found');
    await this.userRepo.delete(user.id);
    return res.json({ success: true });
  }
}
