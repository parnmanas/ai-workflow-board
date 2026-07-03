import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Body, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Deployment } from '../../entities/Deployment';
import { DeploymentService } from './deployment.service';

/** Wire projection of a Deployment row (snake_case, dates as ISO). */
export function deploymentToJson(d: Deployment | null) {
  if (!d) return null;
  return {
    id: d.id,
    workspace_id: d.workspace_id,
    environment: d.environment,
    base_url: d.base_url,
    repo_resource_id: d.repo_resource_id,
    deployed_commit_sha: d.deployed_commit_sha,
    ancestor_shas: d.ancestor_shas ?? [],
    source: d.source,
    reported_by: d.reported_by,
    deployed_at: d.deployed_at ?? null,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

/**
 * REST surface for the deployment-awareness feature (ticket 8ce72b18). Read is
 * the board/QA "live commit" badge (DoD item 5); write mirrors the
 * `report_deployment` MCP tool so a plain webhook / curl can update an
 * environment's live commit without an agent session.
 */
@ApiBearerAuth('user-session')
@ApiTags('deployments')
@Controller('api/deployments')
@UseGuards(AuthGuard)
export class DeploymentController {
  constructor(private readonly deployments: DeploymentService) {}

  /** Current live deployment per environment visible to a workspace (+ globals). */
  @Get()
  async list(@Query('workspace_id') workspaceId: string, @Res() res: Response) {
    const rows = await this.deployments.listForWorkspace(workspaceId || null);
    return res.json(rows.map(deploymentToJson));
  }

  /** Record (upsert) the live commit for an environment. */
  @Post('report')
  async report(@Body() body: any, @Res() res: Response) {
    try {
      const row = await this.deployments.report({
        workspaceId: body.workspace_id ?? null,
        environment: body.environment,
        deployedCommitSha: body.deployed_commit_sha ?? body.commit_sha,
        baseUrl: body.base_url,
        repoResourceId: body.repo_resource_id,
        ancestorShas: Array.isArray(body.ancestor_shas) ? body.ancestor_shas : undefined,
        source: body.source ?? 'webhook',
        reportedBy: body.reported_by,
        deployedAt: body.deployed_at ?? null,
      });
      return res.json(deploymentToJson(row));
    } catch (e: any) {
      return res.status(e?.status || 500).json({ error: e?.message || 'Failed to report deployment' });
    }
  }
}
