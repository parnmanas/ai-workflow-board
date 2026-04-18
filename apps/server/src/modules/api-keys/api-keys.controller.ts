import { Controller, Get, Post, Patch, Delete, Body, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { ApiKeyService } from '../../services/api-key.service';

@Controller('api/keys')
@UseGuards(PermissionGuard, WorkspaceGuard)
@RequirePermission(PERMISSIONS.MANAGE_API_KEYS)
export class ApiKeysController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Get()
  async list(@CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    if (!workspaceId) return res.json([]);
    const keys = await this.apiKeyService.listApiKeys(workspaceId);
    return res.json(keys);
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const key = await this.apiKeyService.getApiKey(id);
    if (!key) return res.status(404).json({ error: 'API key not found' });
    if (workspaceId && key.workspace_id !== workspaceId) return res.status(404).json({ error: 'API key not found' });
    return res.json(key);
  }

  @Post()
  async create(@Body() body: any, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const { name, agent_id, scope, expires_in_days } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    let expires_at: Date | null = null;
    if (expires_in_days && expires_in_days > 0) {
      expires_at = new Date();
      expires_at.setDate(expires_at.getDate() + expires_in_days);
    }

    const result = await this.apiKeyService.createApiKey({
      name, agent_id: agent_id || null, scope: scope || 'full', expires_at, workspace_id: workspaceId || '',
    });

    return res.status(201).json({
      ...result.apiKey, raw_key: result.raw_key,
      _notice: 'Save the raw_key now. It will NOT be shown again.',
    });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const { name, scope, is_active, agent_id, expires_in_days } = body;
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (scope !== undefined) updates.scope = scope;
    if (is_active !== undefined) updates.is_active = is_active;
    if (agent_id !== undefined) updates.agent_id = agent_id;
    if (expires_in_days !== undefined) {
      if (expires_in_days === null || expires_in_days === 0) {
        updates.expires_at = null;
      } else {
        const d = new Date();
        d.setDate(d.getDate() + expires_in_days);
        updates.expires_at = d;
      }
    }

    const existing = await this.apiKeyService.getApiKey(id);
    if (!existing) return res.status(404).json({ error: 'API key not found' });
    if (workspaceId && existing.workspace_id !== workspaceId) return res.status(404).json({ error: 'API key not found' });

    const result = await this.apiKeyService.updateApiKey(id, updates);
    if (!result) return res.status(404).json({ error: 'API key not found' });
    return res.json(result);
  }

  @Post(':id/revoke')
  async revoke(@Param('id') id: string, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const existing = await this.apiKeyService.getApiKey(id);
    if (!existing) return res.status(404).json({ error: 'API key not found' });
    if (workspaceId && existing.workspace_id !== workspaceId) return res.status(404).json({ error: 'API key not found' });

    const ok = await this.apiKeyService.revokeApiKey(id);
    if (!ok) return res.status(404).json({ error: 'API key not found' });
    return res.json({ success: true, message: 'Key revoked' });
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const existing = await this.apiKeyService.getApiKey(id);
    if (!existing) return res.status(404).json({ error: 'API key not found' });
    if (workspaceId && existing.workspace_id !== workspaceId) return res.status(404).json({ error: 'API key not found' });

    const ok = await this.apiKeyService.deleteApiKey(id);
    if (!ok) return res.status(404).json({ error: 'API key not found' });
    return res.json({ success: true });
  }
}
