import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, Req, Res, UseGuards, BadRequestException } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Credential } from '../../entities/Credential';
import { AuthGuard } from '../../common/guards/auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { hasPermission, PERMISSIONS } from '../../common/types/permissions';
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
import { ProjectInputError, ProjectsService } from './projects.service';

/**
 * Projects REST surface (docs/tickets.md). Reading needs workspace membership;
 * writing needs MANAGE_RESOURCES — the permission that guarded repository
 * Resources before they became projects, so who could edit a repo is unchanged.
 */
@ApiBearerAuth('user-session')
@ApiTags('projects')
@Controller('api')
@UseGuards(AuthGuard, WorkspaceGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private canManage(req: Request): boolean {
    const user = (req as any).currentUser;
    if (!user) return false;
    return hasPermission(user.role, user.permissions || [], PERMISSIONS.MANAGE_RESOURCES);
  }

  private fail(res: Response, err: any): Response {
    if (err instanceof ProjectInputError) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...(err as any).usage ? { usage: (err as any).usage } : {} });
    }
    throw err;
  }

  private workspaceOf(req: Request): string {
    return String((req as any).currentWorkspaceId || req.headers['x-workspace-id'] || req.query['workspace_id'] || '');
  }

  @Get('workspaces/:wsId/projects')
  async list(@Param('wsId') wsId: string, @Res() res: Response) {
    return res.json(await this.projects.list(wsId));
  }

  @Post('workspaces/:wsId/projects')
  async create(@Param('wsId') wsId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    if (!this.canManage(req)) return res.status(403).json({ error: 'Missing permission: admin.resources' });
    try {
      return res.status(201).json(await this.projects.create(wsId, body));
    } catch (err) {
      return this.fail(res, err);
    }
  }

  // Literal path above `projects/:id` so `:id` never swallows it.
  @Post('projects/test-connection')
  async testConnection(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const workspaceId = String(body?.workspace_id || this.workspaceOf(req) || '');
    const url = typeof body?.repo_url === 'string' ? body.repo_url.trim() : '';
    const defaultBranch = typeof body?.default_branch === 'string' ? body.default_branch : '';
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
    if (!url) return res.status(400).json({ error: 'repo_url is required' });
    try {
      const credential = await resolveGitCredential(this.dataSource.getRepository(Credential), body?.credential_id || null, workspaceId);
      const branches = await listRepoBranches({ url, credential, defaultBranch });
      return res.json({ ok: true, branches, default_branch: defaultBranch });
    } catch (err: any) {
      const detail = String(err?.message || err);
      return res.status(502).json({ ok: false, error: `Failed to list branches: ${detail}`, detail });
    }
  }

  @Get('projects/:id')
  async get(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const project = await this.projects.getInWorkspace(id, this.workspaceOf(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    return res.json(await this.projects.view(project));
  }

  @Patch('projects/:id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    if (!this.canManage(req)) return res.status(403).json({ error: 'Missing permission: admin.resources' });
    try {
      return res.json(await this.projects.update(id, this.workspaceOf(req), body));
    } catch (err) {
      return this.fail(res, err);
    }
  }

  @Delete('projects/:id')
  async remove(@Param('id') id: string, @Query('force') force: string, @Req() req: Request, @Res() res: Response) {
    if (!this.canManage(req)) return res.status(403).json({ error: 'Missing permission: admin.resources' });
    try {
      await this.projects.remove(id, this.workspaceOf(req), force === '1' || force === 'true');
      return res.json({ ok: true, id });
    } catch (err) {
      return this.fail(res, err);
    }
  }

  @Put('projects/:id/host-folders/:hostId')
  async setHostFolder(@Param('id') id: string, @Param('hostId') hostId: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    if (!this.canManage(req)) return res.status(403).json({ error: 'Missing permission: admin.resources' });
    try {
      return res.json(await this.projects.setHostFolder(id, this.workspaceOf(req), hostId, body?.path));
    } catch (err) {
      return this.fail(res, err);
    }
  }

  @Delete('projects/:id/host-folders/:hostId')
  async clearHostFolder(@Param('id') id: string, @Param('hostId') hostId: string, @Req() req: Request, @Res() res: Response) {
    if (!this.canManage(req)) return res.status(403).json({ error: 'Missing permission: admin.resources' });
    try {
      return res.json(await this.projects.clearHostFolder(id, this.workspaceOf(req), hostId));
    } catch (err) {
      return this.fail(res, err);
    }
  }

  @Get('projects/:id/branches')
  async branches(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const workspaceId = this.workspaceOf(req);
    const project = await this.projects.getInWorkspace(id, workspaceId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.repo_url) {
      return res.status(400).json({ error: "project has no repository URL — set it before listing branches" });
    }
    try {
      const credential = await resolveGitCredential(this.dataSource.getRepository(Credential), project.credential_id, workspaceId);
      const branches = await listRepoBranches({ url: project.repo_url, credential, defaultBranch: project.default_branch || '' });
      return res.json({ branches, default_branch: project.default_branch || '' });
    } catch (err: any) {
      const detail = String(err?.message || err);
      return res.status(502).json({ error: 'failed_to_list_branches', message: `Failed to list branches: ${detail}`, detail });
    }
  }

  // ─── server-side git reading (history / diff / file tree) ──────────────
  // Runs against a per-project bare blobless cache clone (git-repo-cache, keyed
  // by project id — the same id the repository Resource had, so existing cache
  // directories keep being reused). SSH-only URLs degrade with HTTP 422 + code
  // 'ssh_unsupported'.

  private async prepRepo(id: string, workspaceId: string, forceFetch = false): Promise<string> {
    const project = await this.projects.getInWorkspace(id, workspaceId);
    if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
    if (!project.repo_url) throw new BadRequestException("project has no repository URL — set it before reading git history");
    const credential = await resolveGitCredential(this.dataSource.getRepository(Credential), project.credential_id, workspaceId);
    return ensureRepoCache({ resourceId: id, url: project.repo_url, credential, forceFetch });
  }

  private gitError(res: Response, err: any): Response {
    if (err instanceof BadRequestException) {
      return res.status(400).json({ error: (err.getResponse() as any)?.message || err.message });
    }
    if (err instanceof SshUnsupportedError) return res.status(422).json({ error: err.message, code: err.code });
    if (err instanceof GitReadError) return res.status(502).json({ error: err.message, detail: err.message, code: err.code });
    if (err?.status === 404) return res.status(404).json({ error: err.message });
    return res.status(502).json({ error: String(err?.message || err) });
  }

  @Get('projects/:id/refs')
  async refs(@Param('id') id: string, @Query('refresh') refresh: string | undefined, @Req() req: Request, @Res() res: Response) {
    try {
      const repoPath = await this.prepRepo(id, this.workspaceOf(req), refresh === 'true' || refresh === '1');
      return res.json(await listRefs(repoPath));
    } catch (err) {
      return this.gitError(res, err);
    }
  }

  @Get('projects/:id/commits')
  async commits(
    @Param('id') id: string,
    @Query('ref') ref: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('before') before: string | undefined,
    @Query('refresh') refresh: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const repoPath = await this.prepRepo(id, this.workspaceOf(req), refresh === 'true' || refresh === '1');
      const parsedLimit = parseInt(limit ?? '', 10);
      const commits = await listCommits({
        repoPath,
        ref: ref || '',
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 30,
        before: before || undefined,
      });
      return res.json({ commits });
    } catch (err) {
      return this.gitError(res, err);
    }
  }

  @Get('projects/:id/commits/:sha')
  async commitDetail(@Param('id') id: string, @Param('sha') sha: string, @Req() req: Request, @Res() res: Response) {
    try {
      const repoPath = await this.prepRepo(id, this.workspaceOf(req));
      return res.json(await getCommitDetail(repoPath, sha));
    } catch (err) {
      return this.gitError(res, err);
    }
  }

  @Get('projects/:id/tree')
  async tree(@Param('id') id: string, @Query('ref') ref: string | undefined, @Query('path') treePath: string | undefined, @Req() req: Request, @Res() res: Response) {
    try {
      const repoPath = await this.prepRepo(id, this.workspaceOf(req));
      const entries = await listTree(repoPath, ref || '', treePath || '');
      return res.json({ ref: ref || '', path: treePath || '', entries });
    } catch (err) {
      return this.gitError(res, err);
    }
  }

  @Get('projects/:id/file')
  async file(@Param('id') id: string, @Query('ref') ref: string | undefined, @Query('path') filePath: string | undefined, @Req() req: Request, @Res() res: Response) {
    if (!filePath) return res.status(400).json({ error: 'path query parameter is required' });
    try {
      const repoPath = await this.prepRepo(id, this.workspaceOf(req));
      return res.json(await getFileContent(repoPath, ref || '', filePath));
    } catch (err) {
      return this.gitError(res, err);
    }
  }
}
