import { Controller, Post, Get, Body, Headers, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { User } from '../../entities/User';
import { Workspace } from '../../entities/Workspace';
import { AuthService } from '../../services/auth.service';
import { ReBACService } from '../../services/rebac.service';
import { PERMISSION_LABELS, ROLE_PERMISSIONS, resolvePermissions } from '../../common/types/permissions';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rebacService: ReBACService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
  ) {}

  private async _buildWorkspacesForUser(userId: string) {
    // Admin gets all workspaces — never blocked by empty ReBACservice relations
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (user?.role === 'admin') {
      const allWorkspaces = await this.workspaceRepo.find();
      return allWorkspaces.map(ws => ({
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        relations: ['owner'],
      }));
    }

    const memberWsIds = await this.rebacService.listObjects(
      { type: 'user', id: userId }, 'member', 'workspace',
    );
    const ownerWsIds = await this.rebacService.listObjects(
      { type: 'user', id: userId }, 'owner', 'workspace',
    );
    const allWsIds = [...new Set([...memberWsIds, ...ownerWsIds])];
    if (allWsIds.length === 0) return [];

    const workspaces = await this.workspaceRepo.find({ where: { id: In(allWsIds) } });
    return workspaces.map(ws => ({
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      relations: [
        ...(memberWsIds.includes(ws.id) ? ['member'] : []),
        ...(ownerWsIds.includes(ws.id) ? ['owner'] : []),
      ],
    }));
  }

  @Post('login')
  async login(@Body() body: any, @Res() res: Response) {
    const { email, password } = body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const result = await this.authService.login(email, password);
    if (!result) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if ('error' in result) {
      return res.status(403).json({ error: result.error });
    }

    const user = result.user as any;
    const permissions = resolvePermissions(user.role, user.permissions ? JSON.parse(user.permissions || '[]') : []);
    const workspaces = await this._buildWorkspacesForUser(user.id);

    return res.json({
      token: result.token,
      user: {
        ...result.user,
        resolved_permissions: permissions,
      },
      workspaces,
    });
  }

  @Post('logout')
  logout(@Headers('authorization') authHeader: string, @Res() res: Response) {
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      this.authService.destroySession(token);
    }
    return res.json({ success: true });
  }

  @Get('me')
  async me(@Headers('authorization') authHeader: string, @Res() res: Response) {
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.slice(7).trim();
    const user = await this.authService.getSessionUser(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const customPerms = (user as any).permissions ? JSON.parse((user as any).permissions || '[]') : [];
    const permissions = resolvePermissions(user.role, customPerms);
    const { password_hash, ...safeUser } = user as any;
    const workspaces = await this._buildWorkspacesForUser(user.id);

    return res.json({
      ...safeUser,
      resolved_permissions: permissions,
      workspaces,
    });
  }

  @Get('setup-status')
  async setupStatus(@Res() res: Response) {
    const needs = await this.authService.needsSetup();
    return res.json({ needs_setup: needs });
  }

  @Post('setup')
  async setup(@Body() body: any, @Res() res: Response) {
    const needs = await this.authService.needsSetup();
    if (!needs) {
      return res.status(400).json({ error: 'Setup already completed. Use login instead.' });
    }

    const { name, email, password } = body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const password_hash = await this.authService.hashPassword(password);

    let user = await this.userRepo.findOne({ where: { email } });
    if (user) {
      user.name = name;
      user.role = 'admin';
      (user as any).password_hash = password_hash;
      user = await this.userRepo.save(user);
    } else {
      const created = this.userRepo.create({ name, email, role: 'admin', password_hash } as any);
      user = (await this.userRepo.save(created as any)) as any;
    }

    if (!user) {
      return res.status(500).json({ error: 'Failed to create user' });
    }

    const token = this.authService.createSession(user.id);
    const { password_hash: _, ...safeUser } = user as any;
    const permissions = resolvePermissions('admin', []);

    return res.status(201).json({
      token,
      user: { ...safeUser, resolved_permissions: permissions },
    });
  }

  @Post('register')
  async register(@Body() body: any, @Res() res: Response) {
    const { name, email, password, requested_workspace_id } = body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await this.userRepo.findOne({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const password_hash = await this.authService.hashPassword(password);
    const created = this.userRepo.create({
      name,
      email,
      role: 'user',
      status: 'pending',
      password_hash,
      requested_workspace_id: requested_workspace_id || null,
    } as any);
    await this.userRepo.save(created as any);

    return res.status(201).json({ success: true, message: 'Registration submitted. Please wait for admin approval.' });
  }

  @Get('public-workspaces')
  async publicWorkspaces(@Res() res: Response) {
    const workspaces = await this.workspaceRepo.find({ where: { is_public: 1 } as any });
    return res.json(workspaces.map(ws => ({ id: ws.id, name: ws.name, slug: ws.slug })));
  }

  @Get('permissions')
  getPermissions() {
    return {
      permissions: PERMISSION_LABELS,
      role_defaults: ROLE_PERMISSIONS,
    };
  }
}
