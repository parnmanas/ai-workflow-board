import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Credential } from '../../entities/Credential';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS, hasPermission } from '../../common/types/permissions';
import { encrypt, decrypt } from '../../services/encryption.service';
import { maskSecret } from '../../common/mask';
import { findOrFail } from '../../common/find-or-fail';

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
// apart from inherited global ones (global = read-only in a workspace view,
// editable only from the Admin global page).
function serializeCred(c: Credential) {
  return {
    id: c.id,
    workspace_id: c.workspace_id,
    scope: (c.workspace_id ? 'workspace' : 'global') as 'workspace' | 'global',
    name: c.name,
    description: c.description,
    provider: c.provider,
    credential_fields: maskCredentialData(decrypt(c.encrypted_data)),
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
    @Res() res: Response,
  ) {
    // scope=global → globals only (Admin global-credentials page). Otherwise a
    // workspace view returns its own credentials PLUS inherited globals.
    let where: any[];
    if (scope === 'global') {
      where = [{ workspace_id: IsNull() }];
    } else {
      if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
      where = [{ workspace_id: workspaceId }, { workspace_id: IsNull() }];
    }
    if (provider) where = where.map((w) => ({ ...w, provider }));
    const creds = await this.credRepo.find({ where, order: { name: 'ASC' } });
    return res.json(creds.map(serializeCred));
  }

  @Get('providers')
  async providers(@Res() res: Response) {
    return res.json(PROVIDER_FIELDS);
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
    const { workspace_id, name, description = '', provider, credentials: credData, scope } = body;
    const isGlobal = scope === 'global' || !workspace_id;
    if (isGlobal && !this.canManageGlobal(req)) {
      return res.status(403).json({ error: 'Permission required: admin.global_credentials' });
    }
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!provider) return res.status(400).json({ error: 'provider is required' });
    if (!credData || typeof credData !== 'object') return res.status(400).json({ error: 'credentials object is required' });

    const encrypted = encrypt(JSON.stringify(credData));
    const cred = await this.credRepo.save(this.credRepo.create({
      workspace_id: isGlobal ? null : workspace_id,
      name: name.trim(),
      description,
      provider,
      encrypted_data: encrypted,
    }));

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
