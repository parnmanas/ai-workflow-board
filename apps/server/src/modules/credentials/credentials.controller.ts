import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Credential } from '../../entities/Credential';
import { CliLoginSession } from '../../entities/CliLoginSession';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS, hasPermission } from '../../common/types/permissions';
import { encrypt, decrypt, decryptStrict } from '../../services/encryption.service';
import { maskSecret } from '../../common/mask';
import { normalizeCredentialFields } from '../../common/credential-fields';
import { PROVIDER_FIELDS, REVEALABLE_OAUTH_FIELDS } from '../../common/credential-providers';
import { catalogLoginCapable } from '../../common/cli-catalog';
import { findOrFail } from '../../common/find-or-fail';
import { catalogScopeOf, normalizeCatalogScope, type CatalogScope } from '../../common/catalog-scope';
import { Resource } from '../../entities/Resource';
import { Project } from '../../entities/Project';
import { AgentSessionCliSetting } from '../../entities/AgentSessionCliSetting';
import { AgentSessionExecution } from '../../entities/AgentSessionExecution';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AuthService } from '../../services/auth.service';
import { ActivityService } from '../../services/activity.service';
import { CliLoginSessionService } from './cli-login-session.service';
import { InstanceRegistryService } from '../agent-manager/instance-registry.service';

// PROVIDER_FIELDS / REVEALABLE_OAUTH_FIELDS 는 common/credential-providers.ts 에서
// 온다 — CLI provider 는 cli-catalog.ts 에서 파생되고, 비-CLI provider(github 등)만
// 그 파일이 손으로 든다. 여기에 provider 를 직접 적지 말 것.

/** 자동 로그인 대상 CLI 마다 장비의 설치/건강 상태를 읽는다 — 레거시 평면 키의 원천이기도 하다. */
function cliInstallState(
  capabilities: Record<string, { installed?: boolean; healthy?: boolean } | undefined> | undefined,
): Record<string, { installed: boolean; healthy: boolean }> {
  const out: Record<string, { installed: boolean; healthy: boolean }> = {};
  for (const d of catalogLoginCapable()) {
    const cap = capabilities?.[d.id];
    out[d.id] = { installed: !!cap?.installed, healthy: !!cap?.healthy };
  }
  return out;
}

function maskCredentialData(decryptedJson: string): Record<string, string> {
  try {
    const data = JSON.parse(decryptedJson);
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      masked[key] = maskSecret(String(value));
    }
    return masked;
  } catch {
    return {};
  }
}

function isMaskedValue(value: string): boolean {
  return value.includes('••••');
}

// Everything that pins a credential by bare id (no DB FK — same loose pointer
// pattern Resource.credential_id documents). Narrowing a global credential to
// one Account would leave any of these that live elsewhere pointing at a
// credential they can no longer read, so update() refuses the move instead.
// A NULL account_id here means the holder is itself instance-wide (a manager
// Agent row, a global Resource) and so is just as much outside the destination.
// P4c-4: Agent 항목 제거 (Agent 테이블 없음).
const CREDENTIAL_DEPENDENTS: Array<{ entity: Function; label: string }> = [
  { entity: Resource, label: 'resource(s)' },
  // Repositories used to be Resources and carried their clone credential;
  // they are Projects now and keep the same pointer.
  { entity: Project, label: 'project(s)' },
  { entity: AgentSessionCliSetting, label: 'CLI session setting(s)' },
  { entity: AgentSessionExecution, label: 'pinned session execution(s)' },
  { entity: OutreachChannel, label: 'outreach channel(s)' },
];

// 티켓 b2e79108 — CLI 자동 로그인 세션 응답 shape. 토큰 원문(auth_json 등)은
// CliLoginSession에 애초에 저장하지 않으므로(Credential.encrypted_data에만
// 있음) 여기엔 원천적으로 실릴 수 없다 — created_credential_id로만 참조.
function serializeCliLoginSession(s: CliLoginSession) {
  return {
    id: s.id,
    account_id: s.account_id,
    is_global: s.is_global,
    cli: s.cli,
    cli_provider: s.cli_provider,
    cli_method: s.cli_method,
    credential_name: s.credential_name,
    status: s.status,
    verification_url: s.verification_url,
    user_code: s.user_code,
    raw_output_fallback: s.raw_output_fallback,
    error_detail: s.error_detail,
    created_credential_id: s.created_credential_id,
    created_at: s.created_at,
    finished_at: s.finished_at,
  };
}

// Shared response shape. `scope` lets the client tell workspace credentials
// apart from inherited global ones. Write permissions are enforced per row in
// the current Account management page.
function serializeCred(c: Credential) {
  let credentialFields: Record<string, string> = {};
  let credentialStatus: 'ok' | 'unreadable' = 'ok';
  try {
    credentialFields = maskCredentialData(decryptStrict(c.encrypted_data));
  } catch {
    credentialStatus = 'unreadable';
  }
  return {
    id: c.id,
    account_id: c.account_id,
    scope: catalogScopeOf(c),
    name: c.name,
    description: c.description,
    provider: c.provider,
    credential_fields: credentialFields,
    credential_status: credentialStatus,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

@ApiBearerAuth('user-session')
@ApiTags('credentials')
@Controller('api/credentials')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_CREDENTIALS)
export class CredentialsController {
  constructor(
    @InjectRepository(Credential) private readonly credRepo: Repository<Credential>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly activityService: ActivityService,
    private readonly cliLoginSessions: CliLoginSessionService,
    private readonly instanceRegistry: InstanceRegistryService,
  ) {}

  /**
   * Writing a GLOBAL (instance-level) credential is gated behind the dedicated
   * MANAGE_GLOBAL_CREDENTIALS permission (admins hold it via ALL_PERMISSIONS).
   * Account members who can manage their own workspace credentials can still
   * only READ globals (list/bind), never create/edit/delete them.
   */
  private canManageGlobal(req: Request): boolean {
    const user = (req as any).currentUser;
    if (!user) return false;
    return hasPermission(user.role, user.permissions || [], PERMISSIONS.MANAGE_GLOBAL_CREDENTIALS);
  }

  /** Dependent rows that would be orphaned by narrowing `credentialId` down to
   *  `targetAccountId`, as human-readable "<n> <kind>" fragments. */
  private async findScopeNarrowingBlockers(credentialId: string, targetAccountId: string): Promise<string[]> {
    const blockers: string[] = [];
    for (const { entity, label } of CREDENTIAL_DEPENDENTS) {
      const rows = await this.dataSource
        .getRepository(entity as any)
        .find({ where: { credential_id: credentialId } as any });
      const outside = rows.filter((r: any) => (r.account_id ?? null) !== targetAccountId);
      if (outside.length > 0) blockers.push(`${outside.length} ${label}`);
    }
    return blockers;
  }

  @Get()
  async list(
    @Query('account_id') accountId: string,
    @Query('provider') provider: string | undefined,
    @Query('scope') scope: string | undefined,
    @Query('include_all_scopes') includeAllScopes: string | undefined,
    @Res() res: Response,
  ) {
    // scope=global → globals only (legacy callers). Otherwise a
    // workspace view returns its own credentials PLUS inherited globals.
    let where: any[];
    if (scope === 'global') {
      where = [{ account_id: IsNull() }];
    } else {
      if (!accountId) return res.status(400).json({ error: 'account_id is required' });
      where = [
        { account_id: accountId },
        { account_id: IsNull() },
      ];
    }
    if (provider) where = where.map((w) => ({ ...w, provider }));
    const creds = await this.credRepo.find({ where, order: { name: 'ASC' } });
    return res.json(creds.map(serializeCred));
  }

  @Get('providers')
  async providers(@Res() res: Response) {
    return res.json(PROVIDER_FIELDS);
  }

  // ── CLI 자동 로그인(device-auth) — 티켓 b2e79108 ────────────────────
  // "cli-login/instances" 는 반드시 "cli-login/:sessionId" 보다 먼저 선언
  // 되어야 한다 — 안 그러면 GET /cli-login/instances 가 sessionId="instances"
  // 로 잘못 매칭된다(Nest는 동일 세그먼트 수 경로를 선언 순서로 매칭).

  @Get('cli-login/instances')
  async listCliLoginInstances(
    @Query('account_id') accountId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const all = this.instanceRegistry.list().filter((i) => i.mode === 'manager');
    // The automatic creation default does not scope Global administration.
    const requested = (req as any).accountAccessBound ? (req as any).requestedAccountId : accountId;
    let visible;
    if (requested) {
      visible = all.filter((i) => i.account_id === requested || i.account_id === null);
    } else {
      // 리뷰 지적(round 1)과 같은 클래스의 문제: account_id 없이 부르면
      // "전역" 조회이므로 credential 생성과 동일하게 MANAGE_GLOBAL_CREDENTIALS
      // 가 없으면 막는다 — 아니면 workspace 스코프 credential 권한만 가진
      // 사용자가 다른 workspace들의 manager instance_id를 열람할 수 있었다.
      if (!this.canManageGlobal(req)) {
        return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
      }
      visible = all;
    }
    return res.json(
      visible.map((i) => {
        const clis = cliInstallState(i.runtime_capabilities as any);
        return {
          instance_id: i.instance_id,
          hostname: i.hostname,
          account_id: i.account_id,
          // 자동 로그인을 지원하는 모든 CLI — 카탈로그에 login 이 붙으면 자동으로 늘어난다.
          clis,
          // 레거시 평면 키 — 클라이언트(CliAutoLogin.tsx)가 `clis` 로 옮겨 갈 때까지 유지.
          codex_installed: clis.codex?.installed ?? false,
          codex_healthy: clis.codex?.healthy ?? false,
          claude_installed: clis.claude?.installed ?? false,
          claude_healthy: clis.claude?.healthy ?? false,
          opencode_installed: clis.opencode?.installed ?? false,
          opencode_healthy: clis.opencode?.healthy ?? false,
        };
      }),
    );
  }

  @Post('cli-login/start')
  async startCliLogin(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const isGlobal = body?.scope === 'global';
    if (isGlobal && !this.canManageGlobal(req)) {
      return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
    }
    const accountId = isGlobal ? '' : String(body?.account_id || '').trim();
    if (!isGlobal && !accountId) return res.status(400).json({ error: 'account_id is required' });
    const instanceId = String(body?.instance_id || '').trim();
    if (!instanceId) return res.status(400).json({ error: 'instance_id is required' });
    const actor = (req as any).currentUser;

    try {
      const session = await this.cliLoginSessions.startSession({
        accountId,
        isGlobal,
        cli: String(body?.cli || '').trim().toLowerCase(),
        // opencode 전용 — 어느 provider 로, 어느 로그인 방식으로 붙을지(`-p`/`-m`).
        cliProvider: String(body?.cli_provider || '').trim(),
        cliMethod: String(body?.cli_method || '').trim(),
        credentialName: String(body?.credential_name || '').trim(),
        instanceId,
        triggeredById: actor?.id || '',
      });
      return res.status(201).json(serializeCliLoginSession(session));
    } catch (err: any) {
      return res.status(err?.status || 500).json({ error: err?.message || 'failed to start login session' });
    }
  }

  @Get('cli-login/:sessionId')
  async getCliLoginSession(
    @Param('sessionId') sessionId: string,
    @Query('account_id') accountId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const session = await this.cliLoginSessions.getSession(sessionId, accountId);
    if (!session) return res.status(404).json({ error: 'Login session not found' });
    // 리뷰 지적(round 1): 전역 세션 조회에도 생성과 같은 게이트가 필요하다 —
    // 그렇지 않으면 workspace 스코프 권한만으로 다른 workspace를 위해 만든
    // 전역 세션의 상태(진행 URL/코드 등)를 열람할 수 있었다.
    if (session.is_global && !this.canManageGlobal(req)) {
      return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
    }
    return res.json(serializeCliLoginSession(session));
  }

  @Post('cli-login/:sessionId/cancel')
  async cancelCliLogin(
    @Param('sessionId') sessionId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const accountId = String(body?.account_id || '');
    const existing = await this.cliLoginSessions.getSession(sessionId, accountId);
    if (!existing) return res.status(404).json({ error: 'Login session not found' });
    // 리뷰 지적(round 1): 취소도 조회와 같은 전역 게이트가 필요하다 — 취소는
    // 다른 workspace를 위한 전역 세션에 대한 뮤테이션이므로 생성과 동일한
    // 권한을 요구해야 한다.
    if (existing.is_global && !this.canManageGlobal(req)) {
      return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
    }
    try {
      const session = await this.cliLoginSessions.cancelSession(sessionId, accountId);
      // @Res() 라우트는 Nest의 "POST 기본 201" 관례를 안 따르지만, 명시적으로
      // status를 안 주면 실제로는 Express 기본값이 아니라 Nest 어댑터가
      // 먼저 201로 세팅해둔 값이 그대로 나간다 — 이 라우트는 취소(뮤테이션)
      // 이지 생성이 아니므로 200을 명시한다(reveal()과 동일 관례).
      return res.status(200).json(serializeCliLoginSession(session));
    } catch (err: any) {
      return res.status(err?.status || 500).json({ error: err?.message || 'failed to cancel login session' });
    }
  }

  @Post(':id/reveal')
  @UseGuards(AdminGuard)
  async reveal(
    @Param('id') id: string,
    @Body() body: { password?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache');
    res.setHeader('Pragma', 'no-cache');

    const cred = await findOrFail(this.credRepo, { where: { id } }, 'Credential not found');
    const allowedFields = REVEALABLE_OAUTH_FIELDS[cred.provider];
    if (!allowedFields) {
      return res.status(400).json({ error: 'Credential is not an OAuth token' });
    }
    const actor = (req as any).currentUser;
    const audit = async (action: 'credential_revealed' | 'credential_reveal_denied', fields: string[] = []) => {
      await this.activityService.logActivity({
        entity_type: 'credential',
        entity_id: cred.id,
        action,
        field_changed: fields.join(','),
        old_value: '',
        new_value: '',
        actor_id: actor.id,
        actor_name: actor.name,
        ticket_id: '',
        account_id: cred.account_id || '',
        trigger_source: 'admin_ui',
      });
    };

    if (!body?.password || !(await this.authService.verifyUserPassword(actor.id, body.password))) {
      await audit('credential_reveal_denied');
      return res.status(401).json({ error: 'Re-authentication failed' });
    }

    let decrypted: Record<string, unknown>;
    try {
      decrypted = JSON.parse(decryptStrict(cred.encrypted_data));
    } catch {
      return res.status(503).json({ error: 'Credential could not be decrypted' });
    }
    const credentialFields = Object.fromEntries(
      allowedFields
        .filter((field) => Object.prototype.hasOwnProperty.call(decrypted, field))
        .map((field) => [field, String(decrypted[field] ?? '')]),
    );
    await audit('credential_revealed', Object.keys(credentialFields));
    return res.status(200).json({ credential_fields: credentialFields, credential_status: 'ok' });
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Query('account_id') accountId: string,
    @Res() res: Response,
  ) {
    const cred = await findOrFail(this.credRepo, { where: { id } }, 'Credential not found');
    // A global credential (account_id=NULL) is readable from any workspace.
    // A workspace credential is only readable from its own workspace.
    if (cred.account_id !== null && cred.account_id !== accountId) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    return res.json(serializeCred(cred));
  }

  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { name, description = '', provider, credentials: credData } = body;
    let catalogScope;
    try {
      catalogScope = normalizeCatalogScope(body);
    } catch (error: any) {
      return res.status(error?.status || 400).json({ error: error?.message || 'Invalid scope' });
    }
    const isGlobal = catalogScope.account_id === null;
    if (isGlobal && !this.canManageGlobal(req)) {
      return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
    }
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!provider) return res.status(400).json({ error: 'provider is required' });
    if (!credData || typeof credData !== 'object') return res.status(400).json({ error: 'credentials object is required' });

    // Strip paste damage (a wrapped terminal copy puts a newline inside the
    // token) before it ever reaches storage — see credential-fields.ts.
    const plaintext = JSON.stringify(normalizeCredentialFields(credData));
    const encrypted = encrypt(plaintext);
    if (decryptStrict(encrypted) !== plaintext) {
      return res.status(500).json({ error: 'Credential encryption verification failed; credential was not saved' });
    }
    const credential = this.credRepo.create();
    Object.assign(credential, {
      ...catalogScope,
      name: name.trim(),
      description,
      provider,
      encrypted_data: encrypted,
    });
    const cred = await this.credRepo.save(credential);

    return res.status(201).json(serializeCred(cred));
  }

  /**
   * Unlike the other catalog kinds, a Credential CAN be re-scoped in place
   * (ticket: admin scope switch) — a token pasted into one Account is
   * routinely the same token every Account needs, and re-creating it means
   * re-pasting a secret and re-pointing every binding by hand.
   *
   * `account_id` in the body keeps its old meaning — the Account the
   * caller is acting from. It doubles as the DESTINATION when a global
   * credential is narrowed, which is why a Account credential can never be
   * moved straight into a different Account: the ownership check below still
   * requires it to match. Widen to global first, then narrow, and the
   * dependent check runs on the way back down.
   */
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const cred = await findOrFail(this.credRepo, { where: { id } }, 'Credential not found');
    if (body.scope !== undefined && body.scope !== 'global' && body.scope !== 'account') {
      return res.status(400).json({ error: `Unknown scope '${body.scope}'` });
    }
    const actingAccountId = String(body.account_id || '').trim();
    const currentScope = catalogScopeOf(cred);
    // Read before the row is mutated below — the audit entry needs the old side.
    const previousAccountId = cred.account_id;
    // Omitting `scope` keeps the credential where it is — what every client
    // that predates the scope switch sends.
    const targetScope: CatalogScope = (body.scope as CatalogScope | undefined) ?? currentScope;

    if (currentScope === 'account') {
      // Account credential — body account_id must match the owning one.
      if (!actingAccountId) return res.status(400).json({ error: 'account_id is required' });
      if (cred.account_id !== actingAccountId) return res.status(404).json({ error: 'Credential not found' });
    }
    // Editing a global credential, or promoting one into global, is
    // instance-admin territory either way.
    if ((currentScope === 'global' || targetScope === 'global') && !this.canManageGlobal(req)) {
      return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
    }
    if (targetScope === 'account' && !actingAccountId) {
      return res.status(400).json({ error: 'account_id is required for workspace scope' });
    }
    const scopeChanged = targetScope !== currentScope;
    if (scopeChanged && targetScope === 'account') {
      const blockers = await this.findScopeNarrowingBlockers(cred.id, actingAccountId);
      if (blockers.length > 0) {
        return res.status(409).json({
          error: `Cannot narrow this global credential to one Account — ${blockers.join(', ')} outside it still reference it. Re-point or remove them first.`,
        });
      }
    }

    if (body.name !== undefined) {
      if (!body.name?.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      cred.name = body.name.trim();
    }
    if (body.description !== undefined) cred.description = body.description;
    if (body.provider !== undefined) cred.provider = body.provider;

    if (body.credentials && typeof body.credentials === 'object') {
      const existing = (() => { try { return JSON.parse(decrypt(cred.encrypted_data)); } catch { return {}; } })();
      const merged: Record<string, string> = { ...existing };
      for (const [key, value] of Object.entries(body.credentials) as [string, string][]) {
        if (value && !isMaskedValue(value)) merged[key] = value;
      }
      // Normalize the merged map, not just the incoming keys: an edit is also
      // the operator's chance to heal a value stored damaged by an older build.
      cred.encrypted_data = encrypt(JSON.stringify(normalizeCredentialFields(merged)));
    }

    if (scopeChanged) {
      cred.account_id = targetScope === 'global' ? null : actingAccountId;
    }

    const saved = await this.credRepo.save(cred);
    if (scopeChanged) {
      // A Account secret becoming instance-wide (or the reverse) changes who
      // can read it, so it leaves the same kind of trail a reveal does.
      const actor = (req as any).currentUser;
      await this.activityService.logActivity({
        entity_type: 'credential',
        entity_id: saved.id,
        action: 'credential_scope_changed',
        field_changed: 'account_id',
        old_value: currentScope === 'global' ? 'global' : `workspace:${previousAccountId ?? ''}`,
        new_value: targetScope === 'global' ? 'global' : `workspace:${actingAccountId}`,
        actor_id: actor?.id || '',
        actor_name: actor?.name || '',
        ticket_id: '',
        account_id: saved.account_id || actingAccountId,
        trigger_source: 'admin_ui',
      });
    }
    return res.json(serializeCred(saved));
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('account_id') accountId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const cred = await findOrFail(this.credRepo, { where: { id } }, 'Credential not found');
    if (cred.account_id === null) {
      // Global credential — instance-admin only.
      if (!this.canManageGlobal(req)) {
        return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
      }
    } else {
      if (!accountId) return res.status(400).json({ error: 'account_id is required' });
      if (cred.account_id !== accountId) return res.status(404).json({ error: 'Credential not found' });
    }
    // These are bare IDs, not foreign keys. Deleting a bound credential would
    // otherwise strand the session with credential_not_found on its next open.
    for (const entity of [AgentSessionCliSetting, AgentSessionExecution]) {
      if (await this.dataSource.getRepository<AgentSessionCliSetting | AgentSessionExecution>(entity).count({ where: { credential_id: id } })) {
        return res.status(409).json({ error: 'Cannot delete a credential referenced by CLI settings or saved sessions. Change CLI defaults first; keep credentials used by existing sessions and update them in place.' });
      }
    }
    await this.credRepo.delete({ id });
    return res.json({ success: true, id });
  }
}
