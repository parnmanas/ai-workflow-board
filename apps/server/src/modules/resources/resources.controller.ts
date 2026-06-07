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
import { inferResourceMimetype } from '../mcp/shared/resource-helpers';
import { listRepoBranches, resolveGitCredential } from '../mcp/shared/git-branches';

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

  // Raw binary upload — the body is a Buffer (express raw() parser mounted in
  // main.ts for this exact path), NOT JSON. Metadata rides in query params and
  // the X-File-Name header so no base64 inflation and no 10MB JSON ceiling: a
  // large mp4 streams straight in. The bytes are stored base64 in file_data
  // (consistent with the existing Resource model / dual sqlite+pg support),
  // but the client now references the created Resource by id from a comment
  // instead of re-inlining the bytes into the comment POST (ticket ff3e7337).
  @Post('upload')
  async upload(
    @Query('workspace_id') workspaceId: string,
    @Query('board_id') boardId: string | undefined,
    @Query('type') type: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    const buf: Buffer | null = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length === 0) {
      return res.status(400).json({ error: 'request body is empty — send the file bytes as the raw request body' });
    }
    const rawName = req.headers['x-file-name'];
    let fileName = '';
    if (typeof rawName === 'string' && rawName) {
      try { fileName = decodeURIComponent(rawName); } catch { fileName = rawName; }
    }
    if (!fileName) fileName = 'upload';
    const headerMime = (req.headers['x-file-type'] as string) || req.headers['content-type'] || '';
    const fileData = buf.toString('base64');
    const effectiveMimetype = headerMime && headerMime !== 'application/octet-stream'
      ? headerMime
      : (inferResourceMimetype(fileData, fileName) || headerMime || 'application/octet-stream');
    const resource = await this.resourceRepo.save(
      this.resourceRepo.create({
        workspace_id: workspaceId,
        board_id: boardId || null,
        credential_id: null,
        name: fileName,
        description: '',
        type: type || 'comment_attachment',
        url: '',
        content: '',
        file_data: fileData,
        file_name: fileName,
        file_mimetype: effectiveMimetype,
        tags: '[]',
        default_branch: '',
      }),
    );
    // Return metadata only — never echo file_data back (it would re-inflate the
    // response by ~33% and defeats the point of the streaming /raw endpoint).
    return res.status(201).json({
      id: resource.id,
      workspace_id: resource.workspace_id,
      board_id: resource.board_id,
      name: resource.name,
      type: resource.type,
      file_name: resource.file_name,
      file_mimetype: resource.file_mimetype,
      size: buf.length,
    });
  }

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
    const qb = this.resourceRepo.createQueryBuilder('r')
      .where('r.workspace_id = :ws', { ws: workspaceId });
    if (boardId !== undefined) {
      // boardId === '' means "workspace-scope only" (board_id IS NULL);
      // a concrete uuid filters to that board. The prior `boardId || null`
      // shortcut silently returned every resource when the client omitted
      // the param, which bled board-scoped files into the workspace view.
      if (boardId) qb.andWhere('r.board_id = :bid', { bid: boardId });
      else qb.andWhere('r.board_id IS NULL');
    }
    if (type) {
      qb.andWhere('r.type = :t', { t: type });
    }
    // No default type filter — the UI Resources page wants to surface
    // comment attachments alongside user-created resources so files uploaded
    // through ticket comments are discoverable. MCP `list_resources` keeps
    // its own default that hides comment_attachment from agents to cut noise.
    const resources = await qb.orderBy('r.name', 'ASC').getMany();
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
      tags = [], default_branch = '',
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
        default_branch: typeof default_branch === 'string' ? default_branch : '',
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
    if (body.default_branch !== undefined) resource.default_branch = typeof body.default_branch === 'string' ? body.default_branch : '';

    const saved = await this.resourceRepo.save(resource);
    return res.json({
      ...saved,
      tags: (() => { try { return JSON.parse(saved.tags || '[]'); } catch { return []; } })(),
    });
  }

  @Get(':id/branches')
  async branches(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    const resource = await findOrFail(this.resourceRepo, { where: { id, workspace_id: workspaceId } }, 'Resource not found in workspace');
    if (resource.type !== 'repository') {
      return res.status(400).json({ error: `resource type must be 'repository' (got '${resource.type}')` });
    }
    if (!resource.url) {
      return res.status(400).json({ error: "resource has no URL — set the repository's URL before listing branches" });
    }
    try {
      // Earlier this dropped `resource.credential_id` on the floor — private
      // repos failed even when a Credential was attached. Resolve it here so
      // `git ls-remote` runs with the right userinfo for HTTPS auth.
      const credential = await resolveGitCredential(this.credentialRepo, resource.credential_id, workspaceId);
      const branches = await listRepoBranches({
        url: resource.url,
        credential,
        defaultBranch: resource.default_branch || '',
      });
      return res.json({ branches, default_branch: resource.default_branch || '' });
    } catch (err: any) {
      return res.status(502).json({ error: 'failed to list branches', detail: String(err?.message || err) });
    }
  }

  // Probe a repository URL + optional credential without first persisting a
  // Resource. Powers the "Test connection" button in the Resource manager so
  // operators can verify a URL is reachable (and credentials work) before
  // saving — and so the same path can populate the Default Branch dropdown
  // with real refs from the remote.
  @Post('branches/test')
  async testBranches(@Body() body: any, @Res() res: Response) {
    const workspaceId = body?.workspace_id;
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    const credentialId = body?.credential_id || null;
    const defaultBranch = typeof body?.default_branch === 'string' ? body.default_branch : '';
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    if (!url) return res.status(400).json({ error: 'url is required' });
    try {
      const credential = await resolveGitCredential(this.credentialRepo, credentialId, workspaceId);
      const branches = await listRepoBranches({ url, credential, defaultBranch });
      return res.json({ branches, default_branch: defaultBranch });
    } catch (err: any) {
      return res.status(502).json({ error: 'failed to list branches', detail: String(err?.message || err) });
    }
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
