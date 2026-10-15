import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LoginDto, RegisterDto, SetupDto } from './auth.dto';
import { Controller, Post, Get, Delete, Body, Headers, Param, Query, Req, Res, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { User } from '../../entities/User';
import { Account } from '../../entities/Account';
import { AuthService } from '../../services/auth.service';
import { GoogleOAuthService } from '../../services/google-oauth.service';
import { ReBACService } from '../../services/rebac.service';
import { PERMISSION_LABELS, ROLE_PERMISSIONS, resolvePermissions } from '../../common/types/permissions';
import { DeviceAuthService } from './device-auth.service';
import { OAuthFlowStore, appRedirect, isValidCodeChallenge, type OAuthClient } from './oauth-flow';

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  private readonly oauthFlow = new OAuthFlowStore();

  constructor(
    private readonly authService: AuthService,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly deviceAuth: DeviceAuthService,
    private readonly rebacService: ReBACService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
  ) {}

  private async _buildAccountsForUser(userId: string) {
    // Admin gets all accounts — never blocked by empty ReBACservice relations
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (user?.role === 'admin') {
      const allAccounts = await this.accountRepo.find();
      return allAccounts.map(account => ({
        id: account.id,
        name: account.name,
        slug: account.slug,
        relations: ['owner'],
      }));
    }

    const memberWsIds = await this.rebacService.listObjects(
      { type: 'user', id: userId }, 'member', 'account',
    );
    const ownerWsIds = await this.rebacService.listObjects(
      { type: 'user', id: userId }, 'owner', 'account',
    );
    const allWsIds = [...new Set([...memberWsIds, ...ownerWsIds])];
    if (allWsIds.length === 0) return [];

    const accounts = await this.accountRepo.find({ where: { id: In(allWsIds) } });
    return accounts.map(account => ({
      id: account.id,
      name: account.name,
      slug: account.slug,
      relations: [
        ...(memberWsIds.includes(account.id) ? ['member'] : []),
        ...(ownerWsIds.includes(account.id) ? ['owner'] : []),
      ],
    }));
  }

  @Post('login')
  @ApiOperation({ summary: 'Log in with email + password. Returns { token, user, accounts }. Put the token in the "user-session" Authorize slot at the top of this page.' })
  @ApiBody({ type: LoginDto })
  async login(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { email, password } = body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    // M2: 브루트포스 스로틀은 이메일+IP를 함께 추적한다 (auth.service.ts login() 참고).
    const result = await this.authService.login(email, password, req.ip);
    if (!result) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if ('error' in result) {
      return res.status(result.status || 403).json({ error: result.error });
    }

    const user = result.user as any;
    const permissions = resolvePermissions(user.role, user.permissions ? JSON.parse(user.permissions || '[]') : []);
    const accounts = await this._buildAccountsForUser(user.id);

    return res.json({
      token: result.token,
      user: {
        ...result.user,
        resolved_permissions: permissions,
      },
      accounts,
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
    const accounts = await this._buildAccountsForUser(user.id);

    return res.json({
      ...safeUser,
      resolved_permissions: permissions,
      accounts,
    });
  }

  @Get('setup-status')
  async setupStatus(@Res() res: Response) {
    const needs = await this.authService.needsSetup();
    return res.json({ needs_setup: needs });
  }

  @Post('setup')
  @ApiOperation({ summary: 'One-time initial-admin setup. Rejected after the first user exists.' })
  @ApiBody({ type: SetupDto })
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
  @ApiOperation({ summary: 'Register a new user. First user becomes admin automatically.' })
  @ApiBody({ type: RegisterDto })
  async register(@Body() body: any, @Res() res: Response) {
    const { name, email, password, requested_account_id } = body;
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
      requested_account_id: requested_account_id || null,
    } as any);
    await this.userRepo.save(created as any);

    return res.status(201).json({ success: true, message: 'Registration submitted. Please wait for admin approval.' });
  }

  @Get('public-accounts')
  async publicAccounts(@Res() res: Response) {
    const accounts = await this.accountRepo.find({ where: { is_public: 1 } as any });
    return res.json(accounts.map(account => ({ id: account.id, name: account.name, slug: account.slug })));
  }

  /** Public: exposes whether Google OAuth is enabled + the client_id (never the secret). */
  @Get('oauth/config')
  async oauthConfig(@Res() res: Response) {
    const enabled = await this.googleOAuthService.isEnabled();
    const clientId = enabled ? await this.googleOAuthService.getClientId() : null;
    return res.json({ google: { enabled, client_id: clientId || null } });
  }

  /**
   * Redirects the browser to Google's consent screen.
   * `?app=android&code_challenge=<S256>` 는 Android 앱의 Custom Tab 로그인 — 끝나면
   * 웹 화면 대신 `awb://oauth?code=…` 로 돌아가고, 앱이 verifier 로 코드를 바꾼다.
   */
  @Get('oauth/google/start')
  async googleOAuthStart(
    @Query('app') app: string,
    @Query('code_challenge') codeChallenge: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    let client: OAuthClient = { kind: 'web' };
    if (app) {
      if (app !== 'android' || !isValidCodeChallenge(codeChallenge)) {
        return (res as any).status(400).json({ error: 'app login needs app=android and an S256 code_challenge' });
      }
      client = { kind: 'app', challenge: codeChallenge };
    }
    const redirectUri = this._buildRedirectUri(req);
    const authUrl = await this.googleOAuthService.getAuthUrl(redirectUri, this.oauthFlow.issueState(client));
    if (!authUrl) {
      return (res as any).status(503).json({ error: 'Google OAuth is not configured' });
    }
    return (res as any).redirect(authUrl);
  }

  /** Google redirects back here after consent. Exchanges code → token → AWB session. */
  @Get('oauth/google/callback')
  async googleOAuthCallback(
    @Query('code') code: string,
    @Query('error') oauthError: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const expressRes = res as any;
    const client = this.oauthFlow.consumeState(state);
    if (!client) {
      return expressRes.redirect('/?oauth_error=invalid_state');
    }
    const fail = (reason: string) => client.kind === 'app'
      ? expressRes.redirect(appRedirect({ error: reason }))
      : expressRes.redirect(`/?oauth_error=${encodeURIComponent(reason)}`);

    if (oauthError || !code) {
      return fail(oauthError || 'access_denied');
    }

    const redirectUri = this._buildRedirectUri(req);
    const googleUser = await this.googleOAuthService.exchangeCodeForUser(code, redirectUri);
    if (!googleUser) {
      return fail('token_exchange_failed');
    }

    const result = await this.authService.loginOrCreateGoogleUser(
      googleUser.sub,
      googleUser.email,
      googleUser.name,
      googleUser.picture,
    );

    if ('error' in result) {
      return fail(result.error);
    }

    if (client.kind === 'app') {
      return expressRes.redirect(appRedirect({ code: this.oauthFlow.issueAppCode(result.token, client.challenge) }));
    }
    return expressRes.redirect(`/?token=${encodeURIComponent(result.token)}`);
  }

  /** 앱이 `awb://oauth?code=` 로 받은 코드를 PKCE verifier 와 함께 세션 토큰으로 바꾼다. */
  @Post('oauth/app/exchange')
  oauthAppExchange(@Body() body: any, @Res() res: Response) {
    const token = this.oauthFlow.exchangeAppCode(body?.code, body?.code_verifier);
    if (!token) {
      return res.status(400).json({ error: 'invalid_or_expired_code' });
    }
    return res.json({ token });
  }

  /**
   * 앱 단말 등록 — 로그인한 세션으로 부르면 단말 토큰을 한 번 내준다.
   * 앱은 그것을 보관했다가 세션이 끊기면 `devices/session` 으로 새 세션을 받는다.
   */
  @Post('devices')
  async registerDevice(@Headers('authorization') authHeader: string, @Body() body: any, @Res() res: Response) {
    const user = await this._sessionUser(authHeader);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });
    const device = await this.deviceAuth.register(user.id, body || {});
    return res.status(201).json(device);
  }

  @Post('devices/session')
  async deviceSession(@Body() body: any, @Res() res: Response) {
    const minted = await this.deviceAuth.mintSession(body?.device_token, body?.app_version);
    if (!minted) return res.status(401).json({ error: 'device_revoked' });
    return res.json(minted);
  }

  /** 앱 로그아웃 — 이 단말의 자격을 회수한다(토큰을 쥔 쪽만 부를 수 있다). */
  @Post('devices/revoke')
  async revokeDevice(@Body() body: any, @Res() res: Response) {
    await this.deviceAuth.revokeToken(body?.device_token);
    return res.json({ success: true });
  }

  @Get('devices')
  async listDevices(@Headers('authorization') authHeader: string, @Res() res: Response) {
    const user = await this._sessionUser(authHeader);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });
    return res.json(await this.deviceAuth.listForUser(user.id));
  }

  @Delete('devices/:id')
  async deleteDevice(@Headers('authorization') authHeader: string, @Param('id') id: string, @Res() res: Response) {
    const user = await this._sessionUser(authHeader);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });
    const ok = await this.deviceAuth.revokeForUser(user.id, id);
    return ok ? res.json({ success: true }) : res.status(404).json({ error: 'not_found' });
  }

  private async _sessionUser(authHeader: string | undefined) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    return this.authService.getSessionUser(authHeader.slice(7).trim());
  }

  private _buildRedirectUri(req: Request): string {
    const expressReq = req as any;
    const proto = expressReq.get('x-forwarded-proto') || expressReq.protocol || 'http';
    const host = expressReq.get('x-forwarded-host') || expressReq.get('host') || 'localhost';
    return `${proto}://${host}/api/auth/oauth/google/callback`;
  }

  @Get('permissions')
  getPermissions() {
    return {
      permissions: PERMISSION_LABELS,
      role_defaults: ROLE_PERMISSIONS,
    };
  }
}
