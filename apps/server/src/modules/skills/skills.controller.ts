import { Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { SkillsService } from './skills.service';

@ApiTags('skills')
@ApiBearerAuth('user-session')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_AGENTS)
@Controller('api/workspaces/:workspaceId/skills')
export class SkillsController {
  constructor(private readonly service: SkillsService) {}

  /**
   * Global + this workspace's skills. `?include_shadowed=1` also returns the
   * global rows a workspace fork is overriding (each flagged `shadowed: true`),
   * which the management UI needs to explain "why isn't the built-in applying".
   */
  @Get()
  async list(@Param('workspaceId') workspaceId: string, @Req() req: Request, @Res() res: Response) {
    const includeShadowed = String((req.query as any)?.include_shadowed || '') === '1';
    return res.json(await this.service.list(workspaceId, { includeShadowed }));
  }

  @Get('proposals')
  async listProposals(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const raw = String((req.query as any)?.status || '');
    const status = raw === 'pending' || raw === 'approved' || raw === 'rejected'
      ? raw
      : undefined;
    return res.json(await this.service.listProposals(workspaceId, status));
  }

  @Get(':skillId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('skillId') skillId: string,
    @Res() res: Response,
  ) {
    return this.respond(res, () => this.service.get(workspaceId, skillId));
  }

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Workspace route → workspace scope, always. Creating a GLOBAL skill goes
    // through the admin registry controller, so a workspace-scoped caller can
    // never mint a definition every other workspace inherits.
    return this.respond(
      res,
      () => this.service.create(workspaceId, body, (req as any).currentUser?.id || '', 'workspace'),
      201,
    );
  }

  /**
   * Fork a global skill into this workspace. The fork shadows the global by
   * slug while the global keeps receiving upstream updates — the supported way
   * to diverge from a built-in without freezing it.
   */
  @Post(':skillId/fork')
  async fork(
    @Param('workspaceId') workspaceId: string,
    @Param('skillId') skillId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.respond(
      res,
      () => this.service.fork(
        workspaceId,
        skillId,
        (req as any).currentUser?.id || '',
        String(body?.skill_version_id || ''),
      ),
      201,
    );
  }

  @Post(':skillId/versions')
  async publish(
    @Param('workspaceId') workspaceId: string,
    @Param('skillId') skillId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.respond(
      res,
      () => this.service.publish(workspaceId, skillId, body, (req as any).currentUser?.id || ''),
      201,
    );
  }

  @Post(':skillId/assignments')
  async assign(
    @Param('workspaceId') workspaceId: string,
    @Param('skillId') skillId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.respond(
      res,
      () => this.service.assign(workspaceId, skillId, body, (req as any).currentUser?.id || ''),
      201,
    );
  }

  @Post('proposals')
  async propose(
    @Param('workspaceId') workspaceId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.respond(
      res,
      () => this.service.propose(workspaceId, body, {
        agentId: '',
        runId: String(body.source_run_id || ''),
      }),
      201,
    );
  }

  @Post('proposals/:proposalId/approve')
  async approve(
    @Param('workspaceId') workspaceId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.respond(res, () => this.service.review(
      workspaceId,
      proposalId,
      'approve',
      (req as any).currentUser?.id || '',
      body?.note,
      String(body?.skill_id || ''),
    ));
  }

  @Post('proposals/:proposalId/reject')
  async reject(
    @Param('workspaceId') workspaceId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.respond(res, () => this.service.review(
      workspaceId,
      proposalId,
      'reject',
      (req as any).currentUser?.id || '',
      body?.note,
    ));
  }

  @Patch(':skillId/quarantine')
  async quarantine(
    @Param('workspaceId') workspaceId: string,
    @Param('skillId') skillId: string,
    @Res() res: Response,
  ) {
    return this.respond(res, () => this.service.quarantine(workspaceId, skillId));
  }

  private async respond(res: Response, operation: () => Promise<unknown>, status = 200) {
    try {
      return res.status(status).json(await operation());
    } catch (error: any) {
      return res.status(error?.status || 400).json({
        error: error?.code || 'skill_request_invalid',
        message: error?.message || 'Skill request failed',
      });
    }
  }
}
