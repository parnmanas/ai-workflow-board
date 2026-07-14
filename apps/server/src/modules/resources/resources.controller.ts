import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
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
import {
  ensureRepoCache,
  listCommits,
  getCommitDetail,
  listTree,
  getFileContent,
  listRefs,
  SshUnsupportedError,
  GitReadError,
} from '../mcp/shared/git-repo-cache';

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

  // NOTE: raw binary upload (POST /api/resources/upload) lives in
  // ResourceMediaController, not here. This controller is admin-gated
  // (MANAGE_RESOURCES); comment-attachment upload must be reachable by any
  // workspace member, so it authorizes by workspace membership there instead
  // (ticket ff3e7337 review blocker 2).

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('board_id') boardId: string | undefined,
    @Query('type') type: string | undefined,
    @Query('sort_by') sortBy: string | undefined,
    @Query('sort_order') sortOrder: string | undefined,
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
      const detail = String(err?.message || err);
      return res.status(502).json({ error: 'failed_to_list_branches', message: `Failed to list branches: ${detail}`, detail });
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
      const detail = String(err?.message || err);
      return res.status(502).json({ error: 'failed_to_list_branches', message: `Failed to list branches: ${detail}`, detail });
    }
  }

  // ─── server-side git reading (history / diff / file tree) ──────────────
  // These run against a per-Resource bare blobless cache clone maintained by
  // git-repo-cache. SSH-only URLs degrade with HTTP 422 + code 'ssh_unsupported'
  // so the panel can show a clear "원격 인증 미지원" message instead of a raw
  // git auth error.

  /** Resolve a repository Resource, validate it, and ensure its cache clone is
   *  ready — returns the on-disk repo path. Centralises the workspace/type/url
   *  checks shared by every git-read endpoint. Throws via `_gitError` mapping
   *  in the caller's catch. */
  private async _prepRepo(
    id: string,
    workspaceId: string,
    forceFetch = false,
  ): Promise<{ repoPath: string }> {
    const resource = await findOrFail(
      this.resourceRepo,
      { where: { id, workspace_id: workspaceId } },
      'Resource not found in workspace',
    );
    if (resource.type !== 'repository') {
      throw new BadRequestException(`resource type must be 'repository' (got '${resource.type}')`);
    }
    if (!resource.url) {
      throw new BadRequestException("resource has no URL — set the repository's URL before reading git history");
    }
    const credential = await resolveGitCredential(this.credentialRepo, resource.credential_id, workspaceId);
    const repoPath = await ensureRepoCache({ resourceId: id, url: resource.url, credential, forceFetch });
    return { repoPath };
  }

  /** Map a git-read failure to an HTTP response. SSH-only → 422 (degrade);
   *  everything else → 502 with a credential-masked detail. */
  private _gitError(res: Response, err: any): Response {
    if (err instanceof BadRequestException) {
      return res.status(400).json({ error: (err.getResponse() as any)?.message || err.message });
    }
    if (err instanceof SshUnsupportedError) {
      return res.status(422).json({ error: err.message, code: err.code });
    }
    if (err instanceof GitReadError) {
      // err.message is already credential-masked; inline it into `error` so the
      // client (which only surfaces the `error` field) shows the real cause.
      return res.status(502).json({ error: err.message, detail: err.message, code: err.code });
    }
    // findOrFail throws NotFoundException — let Nest's filter handle it.
    if (err?.status === 404) throw err;
    return res.status(502).json({ error: String(err?.message || err) });
  }

  // Branch + tag list resolved from the cache clone, for the ref picker that
  // drives both History and Files. Separate from `/branches` (ls-remote) because
  // it also returns tags + the resolved HEAD and reuses the already-fetched cache.
  @Get(':id/refs')
  async refs(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Query('refresh') refresh: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    try {
      const { repoPath } = await this._prepRepo(id, workspaceId, refresh === 'true' || refresh === '1');
      const refs = await listRefs(repoPath);
      return res.json(refs);
    } catch (err: any) {
      return this._gitError(res, err);
    }
  }

  // Commit history with cursor pagination (mirrors the comment/chat `before`
  // pattern): `before` is a commit sha and the server returns commits strictly
  // older than it along the same history.
  @Get(':id/commits')
  async commits(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Query('ref') ref: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('before') before: string | undefined,
    @Query('refresh') refresh: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    try {
      const { repoPath } = await this._prepRepo(id, workspaceId, refresh === 'true' || refresh === '1');
      const parsedLimit = parseInt(limit ?? '', 10);
      const commits = await listCommits({
        repoPath,
        ref: ref || '',
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 30,
        before: before || undefined,
      });
      return res.json({ commits });
    } catch (err: any) {
      return this._gitError(res, err);
    }
  }

  // Single-commit detail: metadata + per-file numstat + a byte-bounded patch.
  @Get(':id/commits/:sha')
  async commitDetail(
    @Param('id') id: string,
    @Param('sha') sha: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    try {
      const { repoPath } = await this._prepRepo(id, workspaceId);
      const detail = await getCommitDetail(repoPath, sha);
      return res.json(detail);
    } catch (err: any) {
      return this._gitError(res, err);
    }
  }

  // Directory tree at a ref/path (immediate children, dirs first).
  @Get(':id/tree')
  async tree(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Query('ref') ref: string | undefined,
    @Query('path') treePath: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    try {
      const { repoPath } = await this._prepRepo(id, workspaceId);
      const entries = await listTree(repoPath, ref || '', treePath || '');
      return res.json({ ref: ref || '', path: treePath || '', entries });
    } catch (err: any) {
      return this._gitError(res, err);
    }
  }

  // Single-file preview at a ref. Text returns inline; binary/over-cap files
  // return a flag so the panel shows a notice instead of garbage.
  @Get(':id/file')
  async file(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Query('ref') ref: string | undefined,
    @Query('path') filePath: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    if (!filePath) return res.status(400).json({ error: 'path query parameter is required' });
    try {
      const { repoPath } = await this._prepRepo(id, workspaceId);
      const content = await getFileContent(repoPath, ref || '', filePath);
      return res.json(content);
    } catch (err: any) {
      return this._gitError(res, err);
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
