import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Resource } from '../../entities/Resource';
import { Credential } from '../../entities/Credential';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { findOrFail } from '../../common/find-or-fail';
import { canUseCatalogItem, catalogScopeOf, normalizeCatalogScope } from '../../common/catalog-scope';
import { inferResourceMimetype, REPOSITORY_RESOURCE_REJECTION } from '../mcp/shared/resource-helpers';

@ApiBearerAuth('user-session')
@ApiTags('resources')
@Controller('api/resources')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_RESOURCES)
export class ResourcesController {
  constructor(
    @InjectRepository(Resource) private readonly resourceRepo: Repository<Resource>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
  ) {}

  private async assertCredentialScope(
    credentialId: string | null | undefined,
    workspaceId: string | null,
  ): Promise<void> {
    if (!credentialId) return;
    const credential = await this.credentialRepo.findOne({ where: { id: credentialId } });
    if (!credential) throw Object.assign(new Error('credential not found'), { status: 400 });
    const available =
      credential.workspace_id === null
      || (workspaceId !== null && credential.workspace_id === workspaceId);
    if (!available) {
      throw Object.assign(new Error('credential is not available in the Resource scope'), { status: 400 });
    }
  }

  // Repositories moved to Projects (docs/tickets.md → Project). A repository
  // Resource would be invisible to ticket dispatch, so refuse it outright
  // rather than store a row nothing reads. The repo browser routes
  // (branches/refs/commits/tree/file) live on ProjectsController now.

  // NOTE: raw binary upload (POST /api/resources/upload) lives in
  // ResourceMediaController, not here. This controller is admin-gated
  // (MANAGE_RESOURCES); comment-attachment upload must be reachable by any
  // workspace member, so it authorizes by workspace membership there instead
  // (ticket ff3e7337 review blocker 2).

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('type') type: string | undefined,
    @Query('sort_by') sortBy: string | undefined,
    @Query('sort_order') sortOrder: string | undefined,
    @Query('include_all_scopes') includeAllScopes: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspace_id query parameter is required' });
    }
    const qb = this.resourceRepo.createQueryBuilder('r')
      .where('(r.workspace_id IS NULL OR r.workspace_id = :ws)', { ws: workspaceId });
    if (type) {
      qb.andWhere('r.type = :t', { t: type });
    }
    // No default type filter — the UI Resources page wants to surface
    // comment attachments alongside user-created resources so files uploaded
    // through ticket comments are discoverable. MCP `list_resources` keeps
    // its own default that hides comment_attachment from agents to cut noise.

    // Sort whitelist — only known entity columns are interpolated into the
    // ORDER BY clause, so a hostile sort_by/sort_order can never inject SQL.
    // Default = created_at DESC (most recently uploaded first); the column
    // names below match Resource entity fields and resolve the same way on
    // SQLite and Postgres.
    const SORT_COLUMNS: Record<string, string> = {
      name: 'r.name',
      created_at: 'r.created_at',
      updated_at: 'r.updated_at',
      type: 'r.type',
    };
    const sortColumn = SORT_COLUMNS[sortBy ?? ''] || 'r.created_at';
    const sortDir: 'ASC' | 'DESC' = (sortOrder ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    qb.orderBy(sortColumn, sortDir);
    // Stable tie-breaker so equal sort keys keep a deterministic order across
    // requests (e.g. two resources created in the same second).
    if (sortColumn !== 'r.name') qb.addOrderBy('r.name', 'ASC');
    const resources = await qb.getMany();
    const parsed = resources.map((r) => ({
      ...r,
      scope: catalogScopeOf(r),
      tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(),
    }));
    return res.json(parsed);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    const resource = await findOrFail(this.resourceRepo, { where: { id } }, 'Resource not found');
    if (!canUseCatalogItem(resource, workspaceId)) {
      return res.status(404).json({ error: 'Resource not found in scope' });
    }
    const parsed = {
      ...resource,
      scope: catalogScopeOf(resource),
      tags: (() => { try { return JSON.parse(resource.tags || '[]'); } catch { return []; } })(),
    };
    return res.json(parsed);
  }

  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const {
      workspace_id, credential_id = null, name, description = '', type = 'link',
      url = '', content = '', file_data = '', file_name = '', file_mimetype = '',
      tags = [],
    } = body;
    if (type === 'repository') return res.status(400).json({ error: REPOSITORY_RESOURCE_REJECTION });
    let catalogScope;
    try {
      catalogScope = normalizeCatalogScope({ scope: body.scope, workspace_id });
    } catch (error: any) {
      return res.status(error?.status || 400).json({ error: error?.message || 'Invalid scope' });
    }
    if (catalogScope.workspace_id === null && (req as any).currentUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create Global Resources' });
    }
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    try {
      await this.assertCredentialScope(credential_id, catalogScope.workspace_id);
    } catch (error: any) {
      return res.status(error?.status || 400).json({ error: error?.message || 'Invalid credential scope' });
    }

    const effectiveMimetype = file_mimetype && file_mimetype.length > 0
      ? file_mimetype
      : (file_data ? inferResourceMimetype(file_data, file_name || name) : '');
    const entity = this.resourceRepo.create();
    Object.assign(entity, {
      ...catalogScope,
      credential_id: credential_id || null,
      name: name.trim(),
      description,
      type,
      url,
      content,
      file_data,
      file_name,
      file_mimetype: effectiveMimetype,
      tags: JSON.stringify(Array.isArray(tags) ? tags : []),
    });
    const resource = await this.resourceRepo.save(entity);
    return res.status(201).json({
      ...resource,
      scope: catalogScopeOf(resource),
      tags: (() => { try { return JSON.parse(resource.tags || '[]'); } catch { return []; } })(),
    });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const resource = await findOrFail(this.resourceRepo, { where: { id } }, 'Resource not found');
    if (resource.workspace_id === null && (req as any).currentUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update Global Resources' });
    }
    if (resource.workspace_id !== null && body.workspace_id !== resource.workspace_id) {
      return res.status(404).json({ error: 'Resource not found in workspace' });
    }
    if (
      (body.workspace_id !== undefined && (body.workspace_id || null) !== resource.workspace_id)
      || (body.scope !== undefined && body.scope !== catalogScopeOf(resource))
    ) {
      return res.status(400).json({ error: 'Resource scope cannot be changed; create a new scoped Resource instead' });
    }

    if (body.name !== undefined) {
      if (!body.name || !body.name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      resource.name = body.name.trim();
    }
    if (body.type === 'repository') return res.status(400).json({ error: REPOSITORY_RESOURCE_REJECTION });
    if (body.description !== undefined) resource.description = body.description;
    if (body.type !== undefined) resource.type = body.type;
    if (body.url !== undefined) resource.url = body.url;
    if (body.content !== undefined) resource.content = body.content;
    if (body.file_data !== undefined) resource.file_data = body.file_data;
    if (body.file_name !== undefined) resource.file_name = body.file_name;
    if (body.file_mimetype !== undefined) resource.file_mimetype = body.file_mimetype;
    if (resource.file_data && !resource.file_mimetype) {
      resource.file_mimetype = inferResourceMimetype(resource.file_data, resource.file_name || resource.name);
    }
    if (body.credential_id !== undefined) resource.credential_id = body.credential_id || null;
    try {
      await this.assertCredentialScope(resource.credential_id, resource.workspace_id);
    } catch (error: any) {
      return res.status(error?.status || 400).json({ error: error?.message || 'Invalid credential scope' });
    }
    if (body.tags !== undefined) resource.tags = JSON.stringify(Array.isArray(body.tags) ? body.tags : []);

    const saved = await this.resourceRepo.save(resource);
    return res.json({
      ...saved,
      scope: catalogScopeOf(saved),
      tags: (() => { try { return JSON.parse(saved.tags || '[]'); } catch { return []; } })(),
    });
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const resource = await findOrFail(this.resourceRepo, { where: { id } }, 'Resource not found');
    if (resource.workspace_id === null) {
      if ((req as any).currentUser?.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can delete Global Resources' });
      }
    } else if (!workspaceId || resource.workspace_id !== workspaceId) {
      return res.status(404).json({ error: 'Resource not found in workspace' });
    }
    await this.resourceRepo.delete({ id });
    return res.json({ success: true, id });
  }
}
