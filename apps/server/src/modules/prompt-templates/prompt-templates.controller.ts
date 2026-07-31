import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { findOrFail } from '../../common/find-or-fail';
import { assertCatalogBoardScope, catalogScopeOf, normalizeCatalogScope } from '../../common/catalog-scope';
import { Board } from '../../entities/Board';

@ApiBearerAuth('user-session')
@ApiTags('prompt-templates')
@Controller('api/prompt-templates')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_PROMPT_TEMPLATES)
export class PromptTemplatesController {
  constructor(
    @InjectRepository(PromptTemplate) private readonly templateRepo: Repository<PromptTemplate>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('id') id: string | undefined,
    @Query('category') category: string | undefined,
    @Query('include_all_scopes') includeAllScopes: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspace_id query parameter is required' });
    }
    if (id) {
      const tpl = await this.templateRepo.findOne({ where: { id } });
      if (tpl && tpl.workspace_id !== null && tpl.workspace_id !== workspaceId) return res.json([]);
      return res.json(tpl ? [{ ...tpl, scope: catalogScopeOf(tpl) }] : []);
    }
    const qb = this.templateRepo.createQueryBuilder('t')
      .where('(t.workspace_id IS NULL OR t.workspace_id = :workspaceId)', { workspaceId })
      .andWhere('t.board_id IS NULL')
      .orderBy('t.name', 'ASC');
    if (category) qb.andWhere('t.category = :category', { category });
    const templates = await qb.getMany();
    return res.json(templates.map(t => ({ ...t, scope: catalogScopeOf(t) })));
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
    const tpl = await findOrFail(this.templateRepo, { where: { id } }, 'Template not found');
    if (tpl.workspace_id !== null && tpl.workspace_id !== workspaceId) {
      return res.status(404).json({ error: 'Template not found in workspace' });
    }
    return res.json({ ...tpl, scope: catalogScopeOf(tpl) });
  }

  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const { name, description = '', content, category = '' } = body;
    let scope;
    try {
      scope = normalizeCatalogScope(body);
      await assertCatalogBoardScope(
        async (boardId, workspaceId) => !!await this.dataSource.getRepository(Board).findOne({ where: { id: boardId, workspace_id: workspaceId } }),
        scope,
      );
    } catch (error: any) {
      return res.status(error?.status || 400).json({ error: error?.message || 'Invalid scope' });
    }
    if (scope.workspace_id === null && (req as any).currentUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create Global Prompt Templates' });
    }
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!content) return res.status(400).json({ error: 'content is required' });

    const template = this.templateRepo.create();
    Object.assign(template, { ...scope, name, description, content, category });
    const tpl = await this.templateRepo.save(template);
    return res.status(201).json({ ...tpl, scope: catalogScopeOf(tpl) });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const tpl = await findOrFail(this.templateRepo, { where: { id } }, 'Template not found');
    if (tpl.workspace_id === null && (req as any).currentUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update Global Prompt Templates' });
    }
    if (tpl.workspace_id !== null && body.workspace_id !== tpl.workspace_id) {
      return res.status(404).json({ error: 'Template not found in workspace' });
    }
    if (
      (body.workspace_id !== undefined && (body.workspace_id || null) !== tpl.workspace_id)
      || (body.board_id !== undefined && (body.board_id || null) !== tpl.board_id)
      || (body.scope !== undefined && body.scope !== catalogScopeOf(tpl))
    ) {
      return res.status(400).json({ error: 'Template scope cannot be changed; create a new scoped Template instead' });
    }

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
    return res.json({ ...saved, scope: catalogScopeOf(saved) });
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const tpl = await findOrFail(this.templateRepo, { where: { id } }, 'Template not found');
    if (tpl.workspace_id === null) {
      if ((req as any).currentUser?.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can delete Global Prompt Templates' });
      }
    } else if (!workspaceId || tpl.workspace_id !== workspaceId) {
      return res.status(404).json({ error: 'Template not found in workspace' });
    }
    await this.templateRepo.delete({ id });
    return res.json({ success: true, id });
  }
}
