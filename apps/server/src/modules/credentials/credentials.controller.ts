import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Credential } from '../../entities/Credential';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS, hasPermission } from '../../common/types/permissions';
import { encrypt, decrypt, decryptStrict } from '../../services/encryption.service';
import { maskSecret } from '../../common/mask';
import { findOrFail } from '../../common/find-or-fail';
import { assertCatalogBoardScope, catalogScopeOf, normalizeCatalogScope } from '../../common/catalog-scope';
import { Board } from '../../entities/Board';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AuthService } from '../../services/auth.service';
import { ActivityService } from '../../services/activity.service';

const PROVIDER_FIELDS: Record<string, { label: string; fields: string[] }> = {
  github: { label: 'GitHub', fields: ['token'] },
  gitlab: { label: 'GitLab', fields: ['token'] },
  openai: { label: 'OpenAI', fields: ['api_key'] },
  custom: { label: 'Custom', fields: ['token'] },
  // Per-agent CLI credentials. Two kinds per CLI: subscription (raw OAuth
  // credential file content the CLI's `login` command produced — pasted in
  // by the operator and replayed verbatim into the per-agent cli-home) and
  // api_key (a billing-token string the manager exports as ANTHROPIC_API_KEY
  // / OPENAI_API_KEY / GEMINI_API_KEY when spawning).
  claude_subscription: { label: 'Claude (Subscription)', fields: ['credentials_json'] },
  claude_api_key: { label: 'Claude (API Key)', fields: ['api_key'] },
  // `claude setup-token` output (sk-ant-oat..., 1-year long-lived OAuth token
  // that does NOT rotate). Injected as CLAUDE_CODE_OAUTH_TOKEN — unlike the
  // rotating claude_subscription .credentials.json, a single shared token can
  // be registered once and fetched by every agent-manager without the daily
  // re-login that per-machine refresh rotation causes.
  claude_oauth_token: { label: 'Claude (OAuth Token)', fields: ['oauth_token'] },
  // DeepSeek runs through the Claude Code binary against DeepSeek's
  // Anthropic-compatible endpoint. api_key is the DeepSeek bearer token
  // (exported as ANTHROPIC_AUTH_TOKEN); model/base_url are optional overrides.
  deepseek_api_key: { label: 'DeepSeek (API Key)', fields: ['api_key', 'model', 'base_url'] },
  codex_subscription: { label: 'Codex (Subscription)', fields: ['auth_json', 'config_toml'] },
  codex_api_key: { label: 'Codex (API Key)', fields: ['api_key'] },
  antigravity_subscription: { label: 'Antigravity (Subscription)', fields: ['oauth_creds_json'] },
  antigravity_api_key: { label: 'Antigravity (API Key)', fields: ['api_key'] },
};

const REVEALABLE_OAUTH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  claude_oauth_token: ['oauth_token'],
};

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

// Shared response shape. `scope` lets the client tell workspace credentials
// apart from inherited global ones. Write permissions are enforced per row in
// the current Workspace management page.
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
    workspace_id: c.workspace_id,
    board_id: c.board_id,
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
  ) {}

  /**
   * Writing a GLOBAL (instance-level) credential is gated behind the dedicated
   * MANAGE_GLOBAL_CREDENTIALS permission (admins hold it via ALL_PERMISSIONS).
   * Workspace members who can manage their own workspace credentials can still
   * only READ globals (list/bind), never create/edit/delete them.
   */
  private canManageGlobal(req: Request): boolean {
    const user = (req as any).currentUser;
    if (!user) return false;
    return hasPermission(user.role, user.permissions || [], PERMISSIONS.MANAGE_GLOBAL_CREDENTIALS);
  }

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('provider') provider: string | undefined,
    @Query('scope') scope: string | undefined,
    @Query('board_id') boardId: string | undefined,
    @Query('include_all_scopes') includeAllScopes: string | undefined,
    @Res() res: Response,
  ) {
    // scope=global → globals only (legacy callers). Otherwise a
    // workspace view returns its own credentials PLUS inherited globals.
    let where: any[];
    if (scope === 'global') {
      where = [{ workspace_id: IsNull(), board_id: IsNull() }];
    } else {
      if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
      where = [
        { workspace_id: workspaceId, board_id: IsNull() },
        { workspace_id: IsNull(), board_id: IsNull() },
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
        workspace_id: cred.workspace_id || '',
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
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    const cred = await findOrFail(this.credRepo, { where: { id } }, 'Credential not found');
    // A global credential (workspace_id=NULL) is readable from any workspace.
    // A workspace credential is only readable from its own workspace.
    if (cred.workspace_id !== null && cred.workspace_id !== workspaceId) {
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
      await assertCatalogBoardScope(
        async (boardId, workspaceId) => !!await this.dataSource.getRepository(Board).findOne({ where: { id: boardId, workspace_id: workspaceId } }),
        catalogScope,
      );
    } catch (error: any) {
      return res.status(error?.status || 400).json({ error: error?.message || 'Invalid scope' });
    }
    const isGlobal = catalogScope.workspace_id === null;
    if (isGlobal && !this.canManageGlobal(req)) {
      return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
    }
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!provider) return res.status(400).json({ error: 'provider is required' });
    if (!credData || typeof credData !== 'object') return res.status(400).json({ error: 'credentials object is required' });

    const plaintext = JSON.stringify(credData);
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

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { workspace_id } = body;
    const cred = await findOrFail(this.credRepo, { where: { id } }, 'Credential not found');
    if (cred.workspace_id === null) {
      // Global credential — instance-admin only.
      if (!this.canManageGlobal(req)) {
        return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
      }
    } else {
      // Workspace credential — body workspace_id must match the owning one.
      if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });
      if (cred.workspace_id !== workspace_id) return res.status(404).json({ error: 'Credential not found' });
    }
    if (
      (body.workspace_id !== undefined && (body.workspace_id || null) !== cred.workspace_id)
      || (body.board_id !== undefined && (body.board_id || null) !== cred.board_id)
      || (body.scope !== undefined && body.scope !== catalogScopeOf(cred))
    ) {
      return res.status(400).json({ error: 'Credential scope cannot be changed; create a new scoped credential instead' });
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
      cred.encrypted_data = encrypt(JSON.stringify(merged));
    }

    const saved = await this.credRepo.save(cred);
    return res.json(serializeCred(saved));
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const cred = await findOrFail(this.credRepo, { where: { id } }, 'Credential not found');
    if (cred.workspace_id === null) {
      // Global credential — instance-admin only.
      if (!this.canManageGlobal(req)) {
        return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
      }
    } else {
      if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
      if (cred.workspace_id !== workspaceId) return res.status(404).json({ error: 'Credential not found' });
    }
    await this.credRepo.delete({ id });
    return res.json({ success: true, id });
  }
}
