import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Resource } from '../../entities/Resource';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { findOrFail } from '../../common/find-or-fail';
import { inferResourceMimetype } from '../mcp/shared/resource-helpers';

@ApiBearerAuth('user-session')
@ApiTags('resources')
@Controller('api/resources')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_RESOURCES)
export class ResourcesController {
  constructor(
    @InjectRepository(Resource) private readonly resourceRepo: Repository<Resource>,
  ) {}

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('board_id') boardId: string | undefined,
    @Query('type') type: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspace_id query parameter is required' });
    }
    const where: any = { workspace_id: workspaceId };
    if (boardId !== undefined) where.board_id = boardId || null;
    if (type) where.type = type;
    const resources = await this.resourceRepo.find({ where, order: { name: 'ASC' } });
    const parsed = resources.map((r) => ({
      ...r,
      tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(),
    }));
    return res.json(parsed);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const resource = await findOrFail(this.resourceRepo, { where: { id } }, 'Resource not found');
    const parsed = {
      ...resource,
      tags: (() => { try { return JSON.parse(resource.tags || '[]'); } catch { return []; } })(),
    };
    return res.json(parsed);
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    const {
      workspace_id, board_id = null, credential_id = null, name, description = '', type = 'link',
      url = '', content = '', file_data = '', file_name = '', file_mimetype = '',
      tags = [],
    } = body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const effectiveMimetype = file_mimetype && file_mimetype.length > 0
      ? file_mimetype
      : (file_data ? inferResourceMimetype(file_data, file_name || name) : '');
    const resource = await this.resourceRepo.save(
      this.resourceRepo.create({
        workspace_id,
        board_id: board_id || null,
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
      }),
    );
    return res.status(201).json({
      ...resource,
      tags: (() => { try { return JSON.parse(resource.tags || '[]'); } catch { return []; } })(),
    });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { workspace_id } = body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required in body' });
    const resource = await findOrFail(this.resourceRepo, { where: { id, workspace_id } }, 'Resource not found in workspace');

    if (body.name !== undefined) {
      if (!body.name || !body.name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      resource.name = body.name.trim();
    }
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
    if (body.board_id !== undefined) resource.board_id = body.board_id || null;
    if (body.credential_id !== undefined) resource.credential_id = body.credential_id || null;
    if (body.tags !== undefined) resource.tags = JSON.stringify(Array.isArray(body.tags) ? body.tags : []);

    const saved = await this.resourceRepo.save(resource);
    return res.json({
      ...saved,
      tags: (() => { try { return JSON.parse(saved.tags || '[]'); } catch { return []; } })(),
    });
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    await findOrFail(this.resourceRepo, { where: { id, workspace_id: workspaceId } }, 'Resource not found in workspace');
    await this.resourceRepo.delete({ id, workspace_id: workspaceId });
    return res.json({ success: true, id });
  }
}
