import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { findOrFail } from '../../common/find-or-fail';

@ApiTags('prompt-templates')
@Controller('api/prompt-templates')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_PROMPT_TEMPLATES)
export class PromptTemplatesController {
  constructor(
    @InjectRepository(PromptTemplate) private readonly templateRepo: Repository<PromptTemplate>,
  ) {}

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('id') id: string | undefined,
    @Query('category') category: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspace_id query parameter is required' });
    }
    if (id) {
      const tpl = await this.templateRepo.findOne({ where: { id, workspace_id: workspaceId } });
      return res.json(tpl ? [tpl] : []);
    }
    const where: any = { workspace_id: workspaceId };
    if (category) where.category = category;
    const templates = await this.templateRepo.find({ where, order: { name: 'ASC' } });
    return res.json(templates);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspace_id query parameter is required' });
    }
    const tpl = await findOrFail(this.templateRepo, { where: { id, workspace_id: workspaceId } }, 'Template not found in workspace');
    return res.json(tpl);
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    const { workspace_id, name, description = '', content, category = '' } = body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!content) return res.status(400).json({ error: 'content is required' });

    const tpl = await this.templateRepo.save(
      this.templateRepo.create({ workspace_id, name, description, content, category }),
    );
    return res.status(201).json(tpl);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const { workspace_id } = body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id is required in body' });
    const tpl = await findOrFail(this.templateRepo, { where: { id, workspace_id } }, 'Template not found in workspace');

    if (body.name !== undefined) {
      if (!body.name || !body.name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      tpl.name = body.name;
    }
    if (body.description !== undefined) tpl.description = body.description;
    if (body.content !== undefined) {
      if (!body.content) return res.status(400).json({ error: 'content cannot be empty' });
      tpl.content = body.content;
    }
    if (body.category !== undefined) tpl.category = body.category;

    const saved = await this.templateRepo.save(tpl);
    return res.json(saved);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    await findOrFail(this.templateRepo, { where: { id, workspace_id: workspaceId } }, 'Template not found in workspace');
    await this.templateRepo.delete({ id, workspace_id: workspaceId });
    return res.json({ success: true, id });
  }
}
