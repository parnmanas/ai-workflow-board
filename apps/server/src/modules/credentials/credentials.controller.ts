import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Credential } from '../../entities/Credential';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { encrypt, decrypt } from '../../services/encryption.service';
import { maskSecret } from '../../common/mask';

const PROVIDER_FIELDS: Record<string, { label: string; fields: string[] }> = {
  github: { label: 'GitHub', fields: ['token'] },
  gitlab: { label: 'GitLab', fields: ['token'] },
  openai: { label: 'OpenAI', fields: ['api_key'] },
  custom: { label: 'Custom', fields: ['token'] },
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

@Controller('api/credentials')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_CREDENTIALS)
export class CredentialsController {
  constructor(
    @InjectRepository(Credential) private readonly credRepo: Repository<Credential>,
  ) {}

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('provider') provider: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const where: any = { workspace_id: workspaceId };
    if (provider) where.provider = provider;
    const creds = await this.credRepo.find({ where, order: { name: 'ASC' } });
    const result = creds.map((c) => ({
      id: c.id,
      workspace_id: c.workspace_id,
      name: c.name,
      description: c.description,
      provider: c.provider,
      credential_fields: maskCredentialData(decrypt(c.encrypted_data)),
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
    return res.json(result);
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
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const cred = await this.credRepo.findOne({ where: { id, workspace_id: workspaceId } });
    if (!cred) return res.status(404).json({ error: 'Credential not found' });
    return res.json({
      id: cred.id,
      workspace_id: cred.workspace_id,
      name: cred.name,
      description: cred.description,
      provider: cred.provider,
      credential_fields: maskCredentialData(decrypt(cred.encrypted_data)),
      created_at: cred.created_at,
      updated_at: cred.updated_at,
    });
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    const { workspace_id, name, description = '', provider, credentials: credData } = body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!provider) return res.status(400).json({ error: 'provider is required' });
    if (!credData || typeof credData !== 'object') return res.status(400).json({ error: 'credentials object is required' });

    const encrypted = encrypt(JSON.stringify(credData));
    const cred = await this.credRepo.save(this.credRepo.create({
      workspace_id,
      name: name.trim(),
      description,
      provider,
      encrypted_data: encrypted,
    }));

    return res.status(201).json({
      id: cred.id,
      workspace_id: cred.workspace_id,
      name: cred.name,
      description: cred.description,
      provider: cred.provider,
      credential_fields: maskCredentialData(decrypt(cred.encrypted_data)),
      created_at: cred.created_at,
      updated_at: cred.updated_at,
    });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { workspace_id } = body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });
    const cred = await this.credRepo.findOne({ where: { id, workspace_id } });
    if (!cred) return res.status(404).json({ error: 'Credential not found' });

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
    return res.json({
      id: saved.id,
      workspace_id: saved.workspace_id,
      name: saved.name,
      description: saved.description,
      provider: saved.provider,
      credential_fields: maskCredentialData(decrypt(saved.encrypted_data)),
      created_at: saved.created_at,
      updated_at: saved.updated_at,
    });
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    const cred = await this.credRepo.findOne({ where: { id, workspace_id: workspaceId } });
    if (!cred) return res.status(404).json({ error: 'Credential not found' });
    await this.credRepo.delete({ id, workspace_id: workspaceId });
    return res.json({ success: true, id });
  }
}
